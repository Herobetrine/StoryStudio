import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { ApiError } from '../src/api-error.js';
import { createApp } from '../src/app.js';
import { WorkflowService } from '../src/workflow-service.js';
import { hashWorkflowValue, WorkflowStore } from '../src/workflow-store.js';
import { workflowContractDigest } from '../src/workflow-contracts.js';

const LOCAL_HOST = '127.0.0.1:8123';
const WORKFLOW_V2_ID = 'builtin.chapter-cycle.v2';

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

function textParser(response, callback) {
    let value = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { value += chunk; });
    response.on('end', () => callback(null, value));
}

function rewriteStoredRun(dataRoot, projectId, runId, mutate) {
    const filePath = path.join(dataRoot, 'workflows', 'projects', projectId, 'runs', runId, 'run.json');
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const next = mutate(structuredClone(current)) ?? current;
    const { recordHash: ignored, ...payload } = next;
    fs.writeFileSync(filePath, `${JSON.stringify({
        ...payload,
        recordHash: hashWorkflowValue(payload),
    }, null, 2)}\n`, 'utf8');
}

function sseResponse(content) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                model: 'copilot-handoff-model',
                choices: [{ delta: { content }, finish_reason: 'stop' }],
                usage: { total_tokens: 128 },
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function direction(id, index, evidenceId, eventCount = 3) {
    const longDetail = eventCount > 10 ? ` ${'长链细节'.repeat(400)}` : '';
    return {
        id,
        title: `方向 ${index}`,
        commitment: `主角只能兑现核心承诺 ${index}`,
        summary: `方向 ${index} 形成一条完整且不可与兄弟方向并行的推进链。`,
        eventChain: Array.from({ length: eventCount }, (_unused, eventIndex) => ({
            order: eventIndex + 1,
            event: `方向 ${index} 事件 ${eventIndex + 1}${longDetail}`,
            characterChoice: `主角作出选择 ${index}-${eventIndex + 1}${longDetail}`,
            directResult: `产生直接结果 ${index}-${eventIndex + 1}${longDetail}`,
            cost: `留下代价 ${index}-${eventIndex + 1}${longDetail}`,
        })),
        hook: `方向 ${index} 的章尾钩子`,
        risks: [`方向 ${index} 的持续风险`],
        evidenceIds: [evidenceId],
    };
}

function planOutput(sourceEventCount) {
    const chapterCard = {
        summary: '主角选定路线并以明确代价完成一次推进。',
        goal: '在封锁完成前推进所选离城路线。',
        conflict: '追兵和唯一窗口同时收紧。',
        turn: '主动选择打开通路，也封死原退路。',
        hook: '代价暴露出下一阶段的新入口。',
        pov: '主角限知第三人称。',
        time: '封城前夕。',
        location: '城门至外渠。',
        required: '覆盖完整源事件链。',
        avoid: '不得跳过源事件。',
    };
    const eventChain = Array.from({ length: Math.max(4, sourceEventCount) }, (_unused, index) => ({
        id: `beat-${index + 1}`,
        causedBy: index === 0 ? null : `beat-${index}`,
        trigger: `触发 ${index + 1}`,
        choice: `选择 ${index + 1}`,
        action: `行动 ${index + 1}`,
        result: `结果 ${index + 1}`,
        cost: `代价 ${index + 1}`,
        valueShift: `价值转折 ${index + 1}`,
        information: `信息 ${index + 1}`,
    }));
    return {
        eventChain,
        chapterCard,
        coverage: {
            required: [{ item: chapterCard.required, beatIds: eventChain.map(item => item.id) }],
            avoid: [{ item: chapterCard.avoid, guard: '逐项映射，不删除源节点。' }],
            volumeGoal: { summary: '推进离城主线。', beatIds: ['beat-4'] },
            promises: [],
        },
        sourceEventCoverage: Array.from({ length: sourceEventCount }, (_unused, index) => ({
            sourceOrder: index + 1,
            beatIds: [`beat-${index + 1}`],
        })),
    };
}

describe('Copilot direction handoff to Workflow V2', () => {
    let app;
    let csrfToken;
    let dataRoot;
    let providerCalls;
    let providerBodies;
    let definition;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-copilot-handoff-'));
        providerCalls = 0;
        providerBodies = [];
        app = createApp({
            dataRoot,
            fetchImplementation: async (_url, options) => {
                const body = JSON.parse(options.body);
                providerBodies.push(body);
                if (body.stream === true) {
                    providerCalls += 1;
                    return sseResponse(JSON.stringify(body.__testOutput ?? currentModelOutput));
                }
                return new Response(JSON.stringify({
                    model: body.model,
                    choices: [{ message: { content: 'OK' } }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        await write(request(app).put('/api/provider'), csrfToken).send({
            protocol: 'openai-chat',
            baseUrl: 'http://copilot-handoff.local/v1',
            model: 'copilot-handoff-model',
            contextTokens: 262_144,
            maxTokens: 8_192,
            temperature: 0.7,
            topP: 1,
            topK: 0,
            stop: [],
            jsonSchema: true,
        }).expect(200);
        const definitions = await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200);
        definition = definitions.body.definitions.find(item => item.id === WORKFLOW_V2_ID);
        assert.ok(definition);
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    let currentModelOutput;

    async function createProject({ secondChapter = false } = {}) {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: 'Copilot 交接样本',
            genre: '悬疑',
            story: { premise: '封城前必须选定唯一离城路线。' },
        }).expect(201);
        let project = created.body.project;
        const firstChapter = created.body.chapter;
        let second = null;
        if (secondChapter) {
            const added = await write(
                request(app).post(`/api/story-studio/projects/${project.id}/chapters`),
                csrfToken,
            ).send({
                projectVersion: project.version,
                chapter: { title: '第二章' },
            }).expect(201);
            project = added.body.project;
            second = added.body.chapter;
        }
        return { project, firstChapter, secondChapter: second };
    }

    async function readyCopilotFixture({
        secondChapter = false,
        longFirstDirection = false,
        optionCount = 3,
        longAllDirections = false,
    } = {}) {
        const fixture = await createProject({ secondChapter });
        const { project, firstChapter } = fixture;
        const selection = {
            volumeIds: [],
            chapterIds: [firstChapter.id],
            entityIds: [],
            lorebookIds: [],
        };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/context-preview`),
            csrfToken,
        ).send({
            projectVersion: project.version,
            anchorChapterId: firstChapter.id,
            selection,
        }).expect(200);
        const evidenceId = preview.body.evidenceCatalog[0].evidenceId;
        currentModelOutput = {
            schemaVersion: 1,
            plotOptions: [
                'option-one', 'option-two', 'option-three',
                'option-four', 'option-five', 'option-six',
            ].slice(0, optionCount).map((id, index) => direction(
                id,
                index + 1,
                evidenceId,
                longAllDirections || (longFirstDirection && index === 0) ? 12 : 3,
            )),
            settingEdits: [],
            lorebookEdits: [],
        };
        const session = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: `create-${project.id}`,
            projectVersion: project.version,
            anchorChapterId: firstChapter.id,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: [evidenceId],
            optionCount,
            instruction: '给出三个互斥方向。',
        }).expect(201);
        const generated = await write(
            request(app).post(
                `/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}/generate`,
            ),
            csrfToken,
        ).send({
            commandId: `generate-${project.id}`,
            sessionRevision: session.body.revision,
        }).buffer(true).parse(textParser).expect(200);
        const events = generated.body.trim().split('\n').map(line => JSON.parse(line));
        const done = events.at(-1);
        assert.equal(done.type, 'done');
        assert.equal(done.session.status, 'ready');
        return {
            ...fixture,
            session: done.session,
            artifact: done.artifact,
        };
    }

    function handoffBody(fixture, optionId = 'option-two', commandId = 'handoff-one') {
        return {
            commandId,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: fixture.project.version,
            chapterRevision: fixture.firstChapter.revision,
            input: {
                copilotHandoff: {
                    sessionId: fixture.session.id,
                    artifactId: fixture.artifact.id,
                    optionId,
                },
            },
        };
    }

    test('imports the complete direction set, approves the clicked option, reaches plan, and replays idempotently', async () => {
        const fixture = await readyCopilotFixture({ longFirstDirection: true });
        const projectPath = `/api/story-studio/projects/${fixture.project.id}`;
        const chapterPath = `${projectPath}/chapters/${fixture.firstChapter.id}`;
        const beforeProject = await request(app).get(projectPath).set('Host', LOCAL_HOST).expect(200);
        const beforeChapter = await request(app).get(chapterPath).set('Host', LOCAL_HOST).expect(200);
        const body = handoffBody(fixture, 'option-one');

        const started = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);

        assert.equal(started.body.run.currentStepId, 'plan');
        assert.equal(started.body.run.status, 'running');
        assert.equal(started.body.run.revision, 3);
        assert.equal(started.body.run.steps.find(step => step.id === 'brainstorm').status, 'completed');
        assert.equal(started.body.run.steps.find(step => step.id === 'select-direction').status, 'completed');
        assert.equal(started.body.run.steps.find(step => step.id === 'plan').status, 'ready');
        assert.equal(started.body.run.input.user.copilotHandoff.sessionId, fixture.session.id);
        assert.equal(started.body.run.input.user.copilotHandoff.artifactId, fixture.artifact.id);
        assert.equal(started.body.run.input.user.copilotHandoff.optionId, 'option-one');
        assert.equal(started.body.run.input.user.copilotHandoff.version, 2);
        assert.equal(
            Object.hasOwn(started.body.run.input.user.copilotHandoff.directions[0], 'payload'),
            false,
        );
        assert.ok(
            Buffer.byteLength(JSON.stringify(started.body.run.input), 'utf8') < 512 * 1024,
            'The durable handoff snapshot must remain below the Workflow run-input limit.',
        );

        const directions = started.body.artifacts.filter(item => item.kind === 'brainstorm-direction');
        assert.equal(directions.length, 3);
        const approved = directions.filter(item => item.status === 'approved');
        assert.equal(approved.length, 1);
        assert.equal(approved[0].payload.direction.title, '方向 1');
        assert.deepEqual(directions.filter(item => item.id !== approved[0].id).map(item => item.status), [
            'candidate', 'candidate',
        ]);
        const selectedStep = started.body.run.steps.find(step => step.id === 'select-direction');
        assert.deepEqual(selectedStep.artifactIds, [approved[0].id]);
        const longDirection = directions.find(item => item.payload.direction.title === '方向 1');
        assert.equal(longDirection.payload.direction.eventSeeds.length, 8);
        assert.deepEqual(
            longDirection.payload.direction.sourceEventChain,
            fixture.artifact.plotOptions[0].eventChain,
        );
        for (const order of [8, 9, 10, 11, 12]) {
            assert.match(longDirection.payload.direction.eventSeeds[7], new RegExp(`${order}\\.`));
        }

        const afterProject = await request(app).get(projectPath).set('Host', LOCAL_HOST).expect(200);
        const afterChapter = await request(app).get(chapterPath).set('Host', LOCAL_HOST).expect(200);
        assert.deepEqual(afterProject.body, beforeProject.body);
        assert.deepEqual(afterChapter.body, beforeChapter.body);
        assert.equal(providerCalls, 1);

        const replay = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(replay.body.run.id, started.body.run.id);
        assert.equal(replay.body.run.revision, 3);
        assert.equal(replay.body.run.currentStepId, 'plan');
        assert.equal(replay.body.artifacts.filter(item => item.kind === 'brainstorm-direction').length, 3);
        assert.equal(providerCalls, 1);

        currentModelOutput = planOutput(12);
        const planned = await write(
            request(app).post(`${chapterPath}/workflow-runs/${started.body.run.id}/commands`),
            csrfToken,
        ).send({
            commandId: 'plan-complete-source-chain',
            runRevision: started.body.run.revision,
            type: 'execute',
            payload: { stepId: 'plan' },
        }).expect(200);
        const planArtifact = planned.body.artifacts.find(item => item.kind === 'chapter-plan');
        assert.equal(planArtifact.payload.sourceEventCoverage.length, 12);
        assert.equal(planArtifact.payload.sourceEventCoverage[11].sourceOrder, 12);
        assert.equal(planArtifact.payload.directionArtifactId, approved[0].id);
        assert.equal(
            planArtifact.payload.directionDigest,
            workflowContractDigest(approved[0].payload.direction),
        );
        assert.equal(
            new Set(planArtifact.payload.sourceEventCoverage.flatMap(item => item.beatIds)).size,
            planArtifact.payload.sourceEventCoverage.length,
        );
        const planRequest = JSON.stringify(providerBodies.at(-1));
        for (let order = 1; order <= 12; order += 1) {
            assert.match(planRequest, new RegExp(`方向 1 事件 ${order}(?:[^0-9]|$)`));
            assert.match(planRequest, new RegExp(`主角作出选择 1-${order}(?:[^0-9]|$)`));
            assert.match(planRequest, new RegExp(`产生直接结果 1-${order}(?:[^0-9]|$)`));
            assert.match(planRequest, new RegExp(`留下代价 1-${order}(?:[^0-9]|$)`));
        }
        assert.equal(providerCalls, 2);
    });

    test('starts a fresh run after cancellation while an exact command replay stays on the cancelled run', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const originalBody = handoffBody(fixture, 'option-two', 'handoff-before-cancel');
        const started = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(originalBody).expect(201);
        assert.equal(started.body.run.status, 'running');
        assert.equal(started.body.run.currentStepId, 'plan');

        const cancelled = await write(
            request(app).post(`${chapterPath}/workflow-runs/${started.body.run.id}/commands`),
            csrfToken,
        ).send({
            commandId: 'cancel-first-handoff-run',
            runRevision: started.body.run.revision,
            type: 'cancel',
            payload: {
                stepId: started.body.run.currentStepId,
                reason: '验证取消后可重新交接同一方向。',
            },
        }).expect(200);
        assert.equal(cancelled.body.run.status, 'cancelled');

        const exactReplay = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(originalBody).expect(201);
        assert.equal(exactReplay.body.run.id, started.body.run.id);
        assert.equal(exactReplay.body.run.status, 'cancelled');

        const freshBody = handoffBody(fixture, 'option-two', 'handoff-after-cancel');
        const restarted = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(freshBody).expect(201);
        assert.notEqual(restarted.body.run.id, started.body.run.id);
        assert.equal(restarted.body.run.status, 'running');
        assert.equal(restarted.body.run.currentStepId, 'plan');

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const runs = workflowStore.listRuns(fixture.project.id);
        assert.equal(runs.length, 2);
        assert.equal(runs.some(run => run.id === started.body.run.id && run.status === 'cancelled'), true);
        assert.equal(runs.some(run => run.id === restarted.body.run.id && run.status === 'running'), true);
        assert.equal(providerCalls, 1);
    });

    test('keeps a six-direction long handoff snapshot small while storing every source chain in artifacts', async () => {
        const fixture = await readyCopilotFixture({ optionCount: 6, longAllDirections: true });
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const started = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(handoffBody(fixture, 'option-six', 'six-long-directions')).expect(201);

        const snapshot = started.body.run.input.user.copilotHandoff;
        assert.equal(snapshot.directionCount, 6);
        assert.ok(Buffer.byteLength(JSON.stringify(started.body.run.input), 'utf8') < 512 * 1024);
        assert.equal(snapshot.directions.every(item => !Object.hasOwn(item, 'payload')), true);
        const directions = started.body.artifacts.filter(item => item.kind === 'brainstorm-direction');
        assert.equal(directions.length, 6);
        for (let index = 0; index < directions.length; index += 1) {
            const source = fixture.artifact.plotOptions[index].eventChain;
            const stored = directions.find(item => item.payload.direction.title === `方向 ${index + 1}`);
            assert.deepEqual(stored.payload.direction.sourceEventChain, source);
        }
        assert.equal(providerCalls, 1);
    });

    test('rejects malformed, unknown, mismatched, not-ready, stale, and cross-chapter handoffs', async () => {
        const draftProject = await createProject();
        const draftSelection = { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [] };
        const draftPreview = await write(
            request(app).post(`/api/story-studio/projects/${draftProject.project.id}/copilot/context-preview`),
            csrfToken,
        ).send({
            projectVersion: draftProject.project.version,
            anchorChapterId: draftProject.firstChapter.id,
            selection: draftSelection,
        }).expect(200);
        const draftSession = await write(
            request(app).post(`/api/story-studio/projects/${draftProject.project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'draft-session',
            projectVersion: draftProject.project.version,
            anchorChapterId: draftProject.firstChapter.id,
            selection: draftSelection,
            contextDigest: draftPreview.body.contextDigest,
            selectedEvidenceIds: [draftPreview.body.evidenceCatalog[0].evidenceId],
            optionCount: 3,
            instruction: '',
        }).expect(201);
        const draftPath = `/api/story-studio/projects/${draftProject.project.id}/chapters/${draftProject.firstChapter.id}/workflow-runs`;
        const notReady = await write(request(app).post(draftPath), csrfToken).send({
            commandId: 'not-ready',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: draftProject.project.version,
            chapterRevision: draftProject.firstChapter.revision,
            input: {
                copilotHandoff: {
                    sessionId: draftSession.body.id,
                    artifactId: 'copilot-artifact-placeholder',
                    optionId: 'option-one',
                },
            },
        });
        assert.equal(notReady.status, 409);
        assert.equal(notReady.body.error, 'copilot_handoff_session_not_ready');

        const fixture = await readyCopilotFixture({ secondChapter: true });
        const firstPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}/workflow-runs`;
        const malformed = await write(request(app).post(firstPath), csrfToken).send({
            ...handoffBody(fixture, 'option-two', 'malformed'),
            input: { copilotHandoff: { sessionId: fixture.session.id, artifactId: fixture.artifact.id } },
        });
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.error, 'invalid_copilot_handoff');

        const unknown = await write(request(app).post(firstPath), csrfToken)
            .send(handoffBody(fixture, 'option-missing', 'unknown-option'));
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.error, 'invalid_copilot_option_reference');

        const mismatchBody = handoffBody(fixture, 'option-two', 'artifact-mismatch');
        mismatchBody.input.copilotHandoff.artifactId = 'copilot-artifact-mismatch';
        const mismatch = await write(request(app).post(firstPath), csrfToken).send(mismatchBody);
        assert.equal(mismatch.status, 409);
        assert.equal(mismatch.body.error, 'copilot_handoff_artifact_mismatch');

        const secondPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.secondChapter.id}/workflow-runs`;
        const crossChapterBody = {
            ...handoffBody(fixture, 'option-two', 'cross-chapter'),
            chapterRevision: fixture.secondChapter.revision,
        };
        const crossChapter = await write(request(app).post(secondPath), csrfToken).send(crossChapterBody);
        assert.equal(crossChapter.status, 409);
        assert.equal(crossChapter.body.error, 'copilot_context_changed');

        const changed = await write(
            request(app).patch(`/api/story-studio/projects/${fixture.project.id}`),
            csrfToken,
        ).send({
            version: fixture.project.version,
            changes: { genre: '更新后的类型' },
        }).expect(200);
        const currentChapter = await request(app)
            .get(`/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const staleBody = {
            ...handoffBody(fixture, 'option-two', 'stale-session'),
            projectVersion: changed.body.version,
            chapterRevision: currentChapter.body.revision,
        };
        const stale = await write(request(app).post(firstPath), csrfToken).send(staleBody);
        assert.equal(stale.status, 409);
        assert.equal(stale.body.error, 'copilot_context_changed');
    });

    test('blocks a different active run and preserves project or chapter 404s', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        await write(request(app).post(`${chapterPath}/workflow-runs`), csrfToken).send({
            commandId: 'ordinary-active-run',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: fixture.project.version,
            chapterRevision: fixture.firstChapter.revision,
            input: {},
        }).expect(201);
        const blocked = await write(request(app).post(`${chapterPath}/workflow-runs`), csrfToken)
            .send(handoffBody(fixture, 'option-two', 'blocked-handoff'));
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.error, 'workflow_active_run_exists');

        await write(
            request(app).post('/api/story-studio/projects/missing-project/chapters/missing-chapter/workflow-runs'),
            csrfToken,
        ).send(handoffBody(fixture, 'option-two', 'missing-project')).expect(404);
        await write(
            request(app).post(
                `/api/story-studio/projects/${fixture.project.id}/chapters/missing-chapter/workflow-runs`,
            ),
            csrfToken,
        ).send(handoffBody(fixture, 'option-two', 'missing-chapter')).expect(404);
    });

    test('resumes the same run after a failure between selection approval and step transition', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-three', 'recover-handoff');
        const originalTransitionStep = WorkflowStore.prototype.transitionStep;
        let failOnce = true;
        WorkflowStore.prototype.transitionStep = function transitionStepWithInjectedFailure(value) {
            if (failOnce && value.stepId === 'select-direction') {
                failOnce = false;
                throw new ApiError(500, 'injected_handoff_failure', 'Injected handoff interruption.');
            }
            return originalTransitionStep.call(this, value);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
            assert.equal(interrupted.body.error, 'injected_handoff_failure');
        } finally {
            WorkflowStore.prototype.transitionStep = originalTransitionStep;
        }

        const replay = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(replay.body.run.currentStepId, 'plan');
        assert.equal(replay.body.run.revision, 3);
        const directions = replay.body.artifacts.filter(item => item.kind === 'brainstorm-direction');
        assert.equal(directions.length, 3);
        assert.equal(directions.filter(item => item.status === 'approved').length, 1);
        assert.equal(
            directions.find(item => item.status === 'approved').payload.direction.title,
            '方向 3',
        );
    });

    test('rebuilds only missing directions after a crash leaves one full source-chain artifact', async () => {
        const fixture = await readyCopilotFixture({ longFirstDirection: true });
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-one', 'partial-artifact-recovery');
        const originalEnsureArtifact = WorkflowService.prototype.ensureArtifact;
        let failAfterFirst = true;
        WorkflowService.prototype.ensureArtifact = function ensureArtifactWithInjectedFailure(value) {
            const artifact = originalEnsureArtifact.call(this, value);
            if (failAfterFirst && value.kind === 'brainstorm-direction') {
                failAfterFirst = false;
                throw new ApiError(500, 'injected_partial_handoff_failure',
                    'Injected failure after the first handoff artifact.');
            }
            return artifact;
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
            assert.equal(interrupted.body.error, 'injected_partial_handoff_failure');
        } finally {
            WorkflowService.prototype.ensureArtifact = originalEnsureArtifact;
        }

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const orphan = workflowStore.listRuns(fixture.project.id)[0];
        const partial = workflowStore.listArtifacts(fixture.project.id, orphan.id);
        assert.equal(partial.length, 1);
        assert.equal(partial[0].payload.direction.sourceEventChain.length, 12);
        const firstArtifactId = partial[0].id;

        const replay = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        const directions = replay.body.artifacts.filter(item => item.kind === 'brainstorm-direction');
        assert.equal(replay.body.run.currentStepId, 'plan');
        assert.equal(replay.body.run.revision, 3);
        assert.equal(directions.length, 3);
        assert.equal(directions.some(item => item.id === firstArtifactId), true);
        assert.equal(directions.filter(item => item.status === 'approved').length, 1);
        assert.equal(providerCalls, 1);
    });

    test('recovers a complete V2 artifact set after the Copilot source has been removed', async () => {
        const fixture = await readyCopilotFixture({ longFirstDirection: true });
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-one', 'complete-artifact-source-independent');
        const originalTransitionStep = WorkflowStore.prototype.transitionStep;
        let failOnce = true;
        WorkflowStore.prototype.transitionStep = function failAfterCompleteArtifactSet(value) {
            if (failOnce && value.stepId === 'brainstorm') {
                failOnce = false;
                throw new ApiError(500, 'injected_complete_set_failure',
                    'Injected failure after the complete handoff artifact set.');
            }
            return originalTransitionStep.call(this, value);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
            assert.equal(interrupted.body.error, 'injected_complete_set_failure');
        } finally {
            WorkflowStore.prototype.transitionStep = originalTransitionStep;
        }

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const orphan = workflowStore.listRuns(fixture.project.id)[0];
        assert.equal(orphan.currentStepId, 'brainstorm');
        assert.equal(workflowStore.listArtifacts(fixture.project.id, orphan.id).length, 3);
        fs.rmSync(path.join(dataRoot, 'copilot'), { recursive: true, force: true });

        app = createApp({
            dataRoot,
            fetchImplementation: async () => {
                providerCalls += 1;
                throw new Error('Complete-artifact recovery must not consult Copilot or Provider source.');
            },
        });
        csrfToken = (await request(app)
            .get('/api/bootstrap')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.csrfToken;
        const recovered = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(recovered.body.run.id, orphan.id);
        assert.equal(recovered.body.run.currentStepId, 'plan');
        assert.equal(recovered.body.artifacts.filter(item => item.kind === 'brainstorm-direction').length, 3);
        assert.equal(recovered.body.artifacts.filter(item => item.status === 'approved').length, 1);
        assert.equal(providerCalls, 1);
    });

    test('reads a self-contained V1 handoff snapshot and preserves option-to-direction coordinates', async () => {
        const fixture = await readyCopilotFixture({ longFirstDirection: true });
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-two', 'legacy-v1-handoff');
        const originalTransitionStep = WorkflowStore.prototype.transitionStep;
        let failOnce = true;
        WorkflowStore.prototype.transitionStep = function failAfterV1FixtureArtifacts(value) {
            if (failOnce && value.stepId === 'brainstorm') {
                failOnce = false;
                throw new ApiError(500, 'injected_v1_fixture_failure',
                    'Injected failure after materializing the future V1 payloads.');
            }
            return originalTransitionStep.call(this, value);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
        } finally {
            WorkflowStore.prototype.transitionStep = originalTransitionStep;
        }

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const orphanSummary = workflowStore.listRuns(fixture.project.id)[0];
        const orphan = workflowStore.getRun(fixture.project.id, orphanSummary.id);
        const snapshot = orphan.input.user.copilotHandoff;
        const coordinates = new Map(snapshot.directions.map(item => [item.directionId, item]));
        const artifacts = workflowStore.listArtifacts(fixture.project.id, orphan.id);
        const legacyDirections = artifacts.map(artifact => {
            const coordinate = coordinates.get(artifact.payload.direction.id);
            return {
                optionId: coordinate.optionId,
                payload: artifact.payload,
                evidenceIds: artifact.evidenceIds,
            };
        }).reverse();
        const legacyOptionalEntry = legacyDirections.find(entry => entry.optionId !== snapshot.optionId);
        delete legacyOptionalEntry.optionId;
        rewriteStoredRun(dataRoot, fixture.project.id, orphan.id, run => {
            run.input.user.copilotHandoff = {
                version: 1,
                sessionId: snapshot.sessionId,
                artifactId: snapshot.artifactId,
                optionId: snapshot.optionId,
                selectedDirectionId: snapshot.selectedDirectionId,
                projectId: snapshot.projectId,
                chapterId: snapshot.chapterId,
                generationId: snapshot.generationId,
                setDigest: snapshot.setDigest,
                directions: legacyDirections,
            };
            return run;
        });
        fs.rmSync(path.join(dataRoot, 'copilot'), { recursive: true, force: true });

        app = createApp({
            dataRoot,
            fetchImplementation: async () => {
                providerCalls += 1;
                throw new Error('V1 snapshot recovery must remain self-contained.');
            },
        });
        csrfToken = (await request(app)
            .get('/api/bootstrap')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.csrfToken;
        const recovered = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(recovered.body.run.input.user.copilotHandoff.version, 1);
        assert.equal(recovered.body.run.currentStepId, 'plan');
        assert.equal(
            recovered.body.artifacts.find(item => item.status === 'approved').payload.direction.title,
            '方向 2',
        );
        assert.equal(providerCalls, 1);
    });

    test('fails closed on reordered V2 coordinates and pinned artifact or evidence digest drift', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-three', 'v2-coordinate-validation');
        const originalTransitionStep = WorkflowStore.prototype.transitionStep;
        let failOnce = true;
        WorkflowStore.prototype.transitionStep = function failAfterPinnedArtifacts(value) {
            if (failOnce && value.stepId === 'brainstorm') {
                failOnce = false;
                throw new ApiError(500, 'injected_coordinate_fixture_failure',
                    'Injected failure after pinned artifacts.');
            }
            return originalTransitionStep.call(this, value);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
        } finally {
            WorkflowStore.prototype.transitionStep = originalTransitionStep;
        }

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const orphan = workflowStore.listRuns(fixture.project.id)[0];
        const runPath = path.join(
            dataRoot, 'workflows', 'projects', fixture.project.id, 'runs', orphan.id, 'run.json',
        );
        const baseline = JSON.parse(fs.readFileSync(runPath, 'utf8'));
        const cases = [
            {
                label: 'reordered directions',
                mutate(snapshot) {
                    [snapshot.directions[0], snapshot.directions[1]] = [
                        snapshot.directions[1], snapshot.directions[0],
                    ];
                },
            },
            {
                label: 'artifact digest drift',
                mutate(snapshot) {
                    snapshot.artifactDigest = '0'.repeat(64);
                },
            },
            {
                label: 'evidence catalog digest drift',
                mutate(snapshot) {
                    snapshot.evidenceDigest = 'f'.repeat(64);
                },
            },
            {
                label: 'direction evidence-id digest drift',
                mutate(snapshot) {
                    snapshot.directions[0].evidenceIdsDigest = '0'.repeat(64);
                },
            },
        ];
        for (const entry of cases) {
            fs.writeFileSync(runPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
            rewriteStoredRun(dataRoot, fixture.project.id, orphan.id, run => {
                entry.mutate(run.input.user.copilotHandoff);
                return run;
            });
            const replay = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(replay.status, 500, entry.label);
            assert.equal(replay.body.error, 'invalid_workflow_state', entry.label);
        }

        fs.writeFileSync(runPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
        const recovered = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(recovered.body.run.currentStepId, 'plan');
        assert.equal(
            recovered.body.artifacts.find(item => item.status === 'approved').payload.direction.title,
            '方向 3',
        );
    });

    test('keeps GET read-only and recovers a persisted handoff through an authenticated start replay', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-three', 'restart-recover-handoff');
        const originalResume = WorkflowService.prototype.resumeCopilotHandoff;
        let failOnce = true;
        WorkflowService.prototype.resumeCopilotHandoff = function interruptBeforeMaterialization(run) {
            if (failOnce) {
                failOnce = false;
                throw new ApiError(500, 'injected_handoff_failure', 'Injected pre-materialization interruption.');
            }
            return originalResume.call(this, run);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
            assert.equal(interrupted.body.error, 'injected_handoff_failure');
        } finally {
            WorkflowService.prototype.resumeCopilotHandoff = originalResume;
        }

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const orphan = workflowStore.listRuns(fixture.project.id)[0];
        assert.equal(orphan.currentStepId, 'brainstorm');
        assert.equal(orphan.revision, 1);
        assert.equal(workflowStore.listArtifacts(fixture.project.id, orphan.id).length, 0);

        app = createApp({
            dataRoot,
            fetchImplementation: async () => {
                providerCalls += 1;
                throw new Error('Recovery must not call the Provider.');
            },
        });
        csrfToken = (await request(app)
            .get('/api/bootstrap')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.csrfToken;

        const listed = await request(app)
            .get(`${chapterPath}/workflow-runs`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(listed.body.runs.length, 1);
        assert.equal(listed.body.runs[0].id, orphan.id);
        assert.equal(listed.body.runs[0].currentStepId, 'brainstorm');
        assert.equal(listed.body.runs[0].revision, 1);

        const stillOrphaned = await request(app)
            .get(`${chapterPath}/workflow-runs/${orphan.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(stillOrphaned.body.run.currentStepId, 'brainstorm');
        assert.equal(stillOrphaned.body.run.revision, 1);
        assert.equal(stillOrphaned.body.artifacts.length, 0);

        const recovered = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body).expect(201);
        assert.equal(recovered.body.run.currentStepId, 'plan');
        assert.equal(recovered.body.artifacts.filter(item => item.kind === 'brainstorm-direction').length, 3);
        assert.equal(
            recovered.body.artifacts.find(item => item.status === 'approved').payload.direction.title,
            '方向 3',
        );
        assert.equal(providerCalls, 1);

        const staleExecute = await write(
            request(app).post(`${chapterPath}/workflow-runs/${orphan.id}/commands`),
            csrfToken,
        ).send({
            commandId: 'stale-execute-after-recovery',
            runRevision: 1,
            type: 'execute',
            payload: { stepId: 'brainstorm' },
        });
        assert.equal(staleExecute.status, 409);
        assert.equal(staleExecute.body.error, 'workflow_revision_conflict');
        assert.equal(staleExecute.body.actualRevision, 3);
        assert.equal(providerCalls, 1);
    });

    test('fails closed when authority changes after the run record is created but before handoff materialization', async () => {
        const fixture = await readyCopilotFixture();
        const chapterPath = `/api/story-studio/projects/${fixture.project.id}/chapters/${fixture.firstChapter.id}`;
        const body = handoffBody(fixture, 'option-one', 'authority-change-during-handoff');
        const originalResume = WorkflowService.prototype.resumeCopilotHandoff;
        let failOnce = true;
        WorkflowService.prototype.resumeCopilotHandoff = function interruptBeforeMaterialization(run) {
            if (failOnce) {
                failOnce = false;
                throw new ApiError(500, 'injected_handoff_failure', 'Injected pre-materialization interruption.');
            }
            return originalResume.call(this, run);
        };
        try {
            const interrupted = await write(
                request(app).post(`${chapterPath}/workflow-runs`),
                csrfToken,
            ).send(body);
            assert.equal(interrupted.status, 500);
            assert.equal(interrupted.body.error, 'injected_handoff_failure');
        } finally {
            WorkflowService.prototype.resumeCopilotHandoff = originalResume;
        }

        const changedProject = await write(
            request(app).patch(`/api/story-studio/projects/${fixture.project.id}`),
            csrfToken,
        ).send({
            version: fixture.project.version,
            changes: { genre: '权威状态已改变' },
        }).expect(200);

        const replay = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body);
        assert.equal(replay.status, 409);
        assert.equal(replay.body.error, 'copilot_context_changed');
        assert.match(replay.body.runId, /^run-/);
        assert.equal(replay.body.runStatus, 'cancelled');

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const runs = workflowStore.listRuns(fixture.project.id);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, 'cancelled');
        assert.equal(runs[0].currentStepId, null);
        const cancelledRun = workflowStore.getRun(fixture.project.id, runs[0].id);
        assert.equal(cancelledRun.lastCommand.type, 'copilot-handoff-context-changed');
        assert.equal(workflowStore.listArtifacts(fixture.project.id, runs[0].id).length, 0);

        const replayAgain = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send(body);
        assert.equal(replayAgain.status, 409);
        assert.equal(replayAgain.body.error, 'copilot_context_changed');
        assert.equal(replayAgain.body.runId, runs[0].id);

        const replacement = await write(
            request(app).post(`${chapterPath}/workflow-runs`),
            csrfToken,
        ).send({
            commandId: 'replacement-after-changed-handoff',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: changedProject.body.version,
            chapterRevision: fixture.firstChapter.revision,
            input: {},
        }).expect(201);
        assert.equal(replacement.body.run.status, 'running');
    });
});
