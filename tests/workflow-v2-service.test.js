import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { ApiError } from '../src/api-error.js';
import { createApp } from '../src/app.js';
import { GenerationStore } from '../src/generation-store.js';
import { WorkflowService } from '../src/workflow-service.js';

const LOCAL_HOST = '127.0.0.1:8123';
const MANUSCRIPT = '甲推门。\n\n乙拔刀。\n\n丙后退。';

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

function sseResponse(content) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                model: 'workflow-v2-model',
                choices: [{ delta: { content }, finish_reason: 'stop' }],
                usage: { total_tokens: 64 },
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function waitForAbort(signal) {
    if (signal.aborted) throw signal.reason;
    await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

function brainstormOutput() {
    const ids = ['route-river', 'route-gate', 'route-wall'];
    return JSON.stringify({
        exclusivityAxis: '主角只能选择一种互不兼容的离城方式',
        directions: ids.map((id, index) => ({
            id,
            title: `方向 ${index + 1}`,
            forkChoice: `执行唯一选择 ${index + 1}`,
            protagonistAction: `主角实施行动 ${index + 1}。`,
            directResult: `直接结果 ${index + 1}。`,
            delayedCost: `后续代价 ${index + 1}。`,
            chapterPromise: `本章承诺 ${index + 1}。`,
            eventSeeds: [`触发 ${index + 1}`, `行动 ${index + 1}`, `结果 ${index + 1}`],
            pairwiseExclusion: ids.filter(otherId => otherId !== id).map(otherId => ({
                otherDirectionId: otherId,
                reason: `${id} 与 ${otherId} 在本章内无法同时成立。`,
            })),
        })),
    });
}

function completeCard() {
    return {
        summary: '主角经暗河离城，却失去关键地图。',
        goal: '在封城完成前离开城内。',
        conflict: '守军封锁暗河并派追兵进入。',
        turn: '塌方挡住追兵，也封死主角退路。',
        hook: '城外已有陌生接应者等待。',
        pov: '主角限知视角。',
        time: '封城令生效当夜。',
        location: '旧排水口至城外水渠。',
        required: '兑现暗河路线和封城压力。',
        avoid: '不得提前揭示接应者身份。',
    };
}

function planOutput() {
    const chapterCard = completeCard();
    return JSON.stringify({
        eventChain: [
            {
                id: 'beat-1', causedBy: null, trigger: '封城令提前生效', choice: '立刻离城',
                action: '主角前往暗河入口', result: '发现入口被封', cost: '失去准备时间',
                valueShift: '安全转为暴露风险', information: '封锁者知道旧入口',
            },
            {
                id: 'beat-2', causedBy: 'beat-1', trigger: '入口被封', choice: '舍弃装备钻入裂口',
                action: '主角拆下甲片', result: '通过狭窄裂口', cost: '防护能力下降',
                valueShift: '受阻转为推进', information: '暗河仍有水流',
            },
            {
                id: 'beat-3', causedBy: 'beat-2', trigger: '追兵进入暗河', choice: '破坏支撑柱',
                action: '主角引发塌方', result: '暂时截断追兵', cost: '退路也被封死',
                valueShift: '被追转为孤注一掷', information: '前方存在未知出口',
            },
            {
                id: 'beat-4', causedBy: 'beat-3', trigger: '水位突然上涨', choice: '冲向未知出口',
                action: '主角撞开铁栅', result: '落入城外水渠', cost: '地图被冲走',
                valueShift: '困城转为逃出但失去指引', information: '城外有人等待',
            },
        ],
        chapterCard,
        coverage: {
            required: [{ item: chapterCard.required, beatIds: ['beat-1', 'beat-2', 'beat-4'] }],
            avoid: [{ item: chapterCard.avoid, guard: '只写主角看见人影。' }],
            volumeGoal: { summary: '主角离开长宁城。', beatIds: ['beat-4'] },
            promises: [{ promiseId: 'promise-river', action: 'resolve', beatIds: ['beat-2', 'beat-4'] }],
        },
    });
}

function reviewOutput(rewriteRequired) {
    if (!rewriteRequired) {
        return JSON.stringify({
            verdict: 'pass',
            rewriteRequired: false,
            summary: '正文通过证据审查。',
            issues: [],
            rewriteTarget: null,
            coverage: {
                goal: { status: 'met', evidenceIssueIds: [] },
                required: [{ item: completeCard().required, status: 'met', evidenceIssueIds: [] }],
                avoid: [{ item: completeCard().avoid, status: 'met', evidenceIssueIds: [] }],
                volumeGoal: { status: 'met', evidenceIssueIds: [] },
                promises: [{ promiseId: 'promise-river', status: 'met', evidenceIssueIds: [] }],
            },
        });
    }
    const start = MANUSCRIPT.indexOf('乙拔刀。');
    const end = start + '乙拔刀。'.length;
    return JSON.stringify({
        verdict: 'rewrite',
        rewriteRequired: true,
        summary: '乙的动作缺少动机承接。',
        issues: [{
            id: 'issue-weapon',
            severity: 'major',
            category: 'motivation',
            start,
            end,
            paragraphIndex: 1,
            quote: '乙拔刀。',
            reason: '乙此前没有敌意。',
            suggestion: '先确认来者身份再收刀。',
            evidenceIds: [],
        }],
        rewriteTarget: {
            start,
            end,
            quote: '乙拔刀。',
            issueIds: ['issue-weapon'],
            instruction: '补足身份确认并修正动作。',
        },
        coverage: {
            goal: { status: 'partial', evidenceIssueIds: ['issue-weapon'] },
            required: [{ item: completeCard().required, status: 'partial', evidenceIssueIds: ['issue-weapon'] }],
            avoid: [{ item: completeCard().avoid, status: 'missed', evidenceIssueIds: ['issue-weapon'] }],
            volumeGoal: { status: 'met', evidenceIssueIds: [] },
            promises: [{ promiseId: 'promise-river', status: 'partial', evidenceIssueIds: ['issue-weapon'] }],
        },
    });
}

function adoptionOutput() {
    return JSON.stringify({
        chapterSummary: '主角经暗河离城，却失去关键地图。',
        storyStateChanges: {
            events: {
                upsert: [{
                    id: 'event-river-escape',
                    kind: 'chapter-event',
                    title: '暗河离城',
                    summary: '主角经暗河离开封锁区。',
                    chapterId: null,
                    entityIds: [],
                    status: 'active',
                    order: 1,
                    timelineId: null,
                    locationEntityId: null,
                    progress: 100,
                    visibility: 'public',
                }],
                delete: [],
            },
        },
    });
}

function operationFromRequest(options) {
    const body = JSON.parse(options.body);
    const prompt = body.messages?.map(message => message.content).join('\n') ?? body.prompt ?? '';
    return prompt.match(/TASK_KIND: ([a-z]+)/u)?.[1] ?? '';
}

describe('Workflow V2 service integration', () => {
    let app;
    let csrfToken;
    let dataRoot;
    let definition;
    let sequence;
    let providerCalls;
    let rewriteRequired;
    let providerFetch;
    let nextProviderGate;
    let invalidBrainstormOnce;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-workflow-v2-service-'));
        sequence = 0;
        providerCalls = [];
        rewriteRequired = true;
        nextProviderGate = null;
        invalidBrainstormOnce = false;
        providerFetch = async (_url, options) => {
            const operation = operationFromRequest(options);
            providerCalls.push({ operation, signal: options.signal });
            const gate = nextProviderGate;
            if (gate) {
                nextProviderGate = null;
                gate.signal = options.signal;
                gate.started.resolve();
                await waitForAbort(options.signal);
            }
            const outputs = {
                brainstorm: invalidBrainstormOnce ? '{}' : brainstormOutput(),
                plan: planOutput(),
                draft: MANUSCRIPT,
                review: reviewOutput(rewriteRequired),
                rewrite: JSON.stringify({
                    replacement: '乙认出来人，缓缓收刀。',
                    issueIds: ['issue-weapon'],
                }),
                adoption: adoptionOutput(),
            };
            if (operation === 'brainstorm') invalidBrainstormOnce = false;
            assert.ok(outputs[operation], `Unexpected Workflow V2 operation: ${operation}`);
            return sseResponse(outputs[operation]);
        };
        await rebuildApp();
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    async function rebuildApp() {
        app = createApp({ dataRoot, fetchImplementation: providerFetch });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        await write(request(app).put('/api/provider'), csrfToken).send({
            protocol: 'openai-chat',
            baseUrl: 'http://workflow-v2.local/v1',
            model: 'workflow-v2-model',
            contextTokens: 32_768,
            maxTokens: 8_192,
            temperature: 0.2,
            topP: 1,
            topK: 0,
            stop: [],
            jsonSchema: true,
        }).expect(200);
        definition = (await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.definitions.find(item => item.id === 'builtin.chapter-cycle.v2');
    }

    async function createRun(title = 'Workflow V2 集成') {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title,
            genre: '玄幻',
            story: { logline: '主角必须在封城前经暗河离开。' },
        }).expect(201);
        const projectId = created.body.project.id;
        const chapterId = created.body.chapter.id;
        const chapterPath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}`;
        const view = (await write(request(app).post(`${chapterPath}/workflow-runs`), csrfToken).send({
            commandId: `start-workflow-v2-${++sequence}`,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
            input: {},
        }).expect(201)).body;
        return { projectId, chapterId, chapterPath, initial: created.body, view };
    }

    async function execute(fixture, view, payload = {}, bodyOverrides = {}) {
        return write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            commandId: bodyOverrides.commandId ?? `workflow-v2-command-${++sequence}`,
            runRevision: bodyOverrides.runRevision ?? view.run.revision,
            type: bodyOverrides.type ?? 'execute',
            payload,
        });
    }

    function binding(view, artifact = view.currentArtifact) {
        return { artifactId: artifact.id, artifactHash: artifact.bindingHash };
    }

    async function executeOk(fixture, view, payload = {}) {
        const response = await execute(fixture, view, payload);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body;
    }

    async function finishRun(fixture) {
        let { view } = fixture;
        view = await executeOk(fixture, view);
        assert.equal(view.run.currentStepId, 'select-direction');
        view = await executeOk(fixture, view, binding(view));
        view = await executeOk(fixture, view);
        assert.equal(view.run.currentStepId, 'approve-plan');
        view = await executeOk(fixture, view, binding(view));
        view = await executeOk(fixture, view);
        assert.equal(view.run.currentStepId, 'review');
        view = await executeOk(fixture, view);
        assert.equal(view.run.currentStepId, 'approve-review');
        view = await executeOk(fixture, view, binding(view));
        if (rewriteRequired) {
            assert.equal(view.run.currentStepId, 'rewrite');
            view = await executeOk(fixture, view);
            assert.equal(view.run.currentStepId, 'approve-rewrite');
            view = await executeOk(fixture, view, binding(view));
        } else {
            assert.equal(view.run.currentStepId, 'distill');
            assert.equal(view.run.steps.find(step => step.id === 'rewrite').status, 'skipped');
            assert.equal(view.run.steps.find(step => step.id === 'approve-rewrite').status, 'skipped');
        }
        assert.equal(view.run.currentStepId, 'distill');
        view = await executeOk(fixture, view);
        assert.equal(view.run.currentStepId, 'approve-adoption');
        view = await executeOk(fixture, view, binding(view));
        assert.equal(view.run.currentStepId, 'adopt');
        view = await executeOk(fixture, view, binding(view));
        assert.equal(view.run.status, 'completed');
        fixture.view = view;
        return view;
    }

    test('executes the complete rewrite lineage and atomically adopts every authoritative field', async () => {
        const fixture = await createRun('V2 完整定向修复');
        const view = await finishRun(fixture);
        assert.deepEqual(providerCalls.map(call => call.operation), [
            'brainstorm', 'plan', 'draft', 'review', 'rewrite', 'adoption',
        ]);
        const chapter = (await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200)).body;
        const project = (await request(app)
            .get(`/api/story-studio/projects/${fixture.projectId}`)
            .set('Host', LOCAL_HOST)
            .expect(200)).body;
        assert.equal(chapter.content, '甲推门。\n\n乙认出来人，缓缓收刀。\n\n丙后退。');
        assert.deepEqual(chapter.card, completeCard());
        assert.equal(chapter.status, 'done');
        assert.equal(JSON.parse(chapter.review).rewriteRequired, true);
        assert.equal(JSON.parse(chapter.notes).workflow, 'builtin.chapter-cycle.v2');
        assert.equal(project.storyState.events.some(item => item.id === 'event-river-escape'), true);
        assert.equal(project.version, fixture.initial.project.version + 1);
        assert.equal(chapter.revision, fixture.initial.chapter.revision + 1);
        const selected = view.artifacts.filter(artifact => artifact.status === 'applied');
        assert.deepEqual(new Set(selected.map(artifact => artifact.kind)), new Set([
            'brainstorm-direction', 'chapter-plan', 'chapter-draft', 'chapter-review',
            'rewrite-diff', 'chapter-adoption',
        ]));
        assert.equal(view.artifacts.filter(artifact => artifact.kind === 'brainstorm-direction').length, 3);
    });

    test('skips both rewrite steps only after the exact approved no-rewrite review', async () => {
        rewriteRequired = false;
        const fixture = await createRun('V2 无需定向修复');
        const view = await finishRun(fixture);
        assert.deepEqual(providerCalls.map(call => call.operation), [
            'brainstorm', 'plan', 'draft', 'review', 'adoption',
        ]);
        assert.equal(view.artifacts.some(artifact => artifact.kind === 'rewrite-diff'), false);
        const chapter = (await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200)).body;
        assert.equal(chapter.content, MANUSCRIPT);
        assert.equal(JSON.parse(chapter.review).rewriteRequired, false);
    });

    test('reuses the persisted model intent after a post-Provider workflow commit crash and restart', async () => {
        const fixture = await createRun('V2 重启复用');
        const command = {
            commandId: 'workflow-v2-brainstorm-before-commit-crash',
            runRevision: fixture.view.run.revision,
            type: 'execute',
            payload: {},
        };
        const originalCompleteStep = WorkflowService.prototype.completeStep;
        WorkflowService.prototype.completeStep = function failBrainstormCommit(run, ...args) {
            if (run.definitionId === 'builtin.chapter-cycle.v2' && run.currentStepId === 'brainstorm') {
                throw new ApiError(500, 'simulated_workflow_commit_failure', 'Simulated post-Provider crash.');
            }
            return originalCompleteStep.call(this, run, ...args);
        };
        try {
            const failed = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'simulated_workflow_commit_failure');
        } finally {
            WorkflowService.prototype.completeStep = originalCompleteStep;
        }
        assert.equal(providerCalls.length, 1);
        const store = new GenerationStore(path.join(dataRoot, 'generation-history'));
        const persisted = store.listGenerations(fixture.projectId, fixture.chapterId);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].status, 'completed');
        assert.equal(store.getGeneration(
            fixture.projectId, fixture.chapterId, persisted[0].id,
        ).request.workflowGeneration.attempt, 1);

        await rebuildApp();
        const replay = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
        ).send(command).expect(200);
        assert.equal(replay.body.run.currentStepId, 'select-direction');
        assert.equal(replay.body.artifacts.filter(item => item.kind === 'brainstorm-direction').length, 3);
        assert.equal(providerCalls.length, 1);
    });

    test('forbids attach-generation before inspecting any external candidate', async () => {
        const fixture = await createRun('V2 禁止外接候选');
        const response = await execute(fixture, fixture.view, {
            generationId: 'external-generation',
        }, { type: 'attach-generation' });
        assert.equal(response.status, 409);
        assert.equal(response.body.error, 'workflow_v2_attach_forbidden');
        assert.equal(providerCalls.length, 0);
    });

    test('persists the intent before Provider and aborts the exact V2 attempt on cancel', async () => {
        const fixture = await createRun('V2 显式取消');
        const gate = { started: deferred(), signal: null };
        nextProviderGate = gate;
        const command = {
            commandId: 'workflow-v2-cancelled-brainstorm',
            runRevision: fixture.view.run.revision,
            type: 'execute',
            payload: {},
        };
        const executing = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
        ).send(command).then(response => response);
        await gate.started.promise;
        const store = new GenerationStore(path.join(dataRoot, 'generation-history'));
        const running = store.listGenerations(fixture.projectId, fixture.chapterId);
        assert.equal(running.length, 1);
        const persisted = store.getGeneration(fixture.projectId, fixture.chapterId, running[0].id);
        assert.equal(persisted.status, 'streaming');
        assert.equal(persisted.request.workflowV2.operation, 'brainstorm');
        assert.equal(persisted.request.workflowGeneration.commandId, command.commandId);

        const cancelled = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
        ).send({
            commandId: 'workflow-v2-cancel-brainstorm',
            runRevision: fixture.view.run.revision,
            type: 'cancel',
            payload: { stepId: 'brainstorm' },
        }).expect(200);
        assert.equal(cancelled.body.run.status, 'cancelled');
        assert.equal(gate.signal.aborted, true);
        const stopped = await executing;
        assert.equal(stopped.status, 409);
        assert.equal(stopped.body.error, 'workflow_cancelled');
        const failed = store.getGeneration(fixture.projectId, fixture.chapterId, running[0].id);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.finishReason, 'aborted');
        assert.equal(cancelled.body.artifacts.length, 0);
    });

    test('audits invalid model output as a failed attempt and retries the exact command', async () => {
        const fixture = await createRun('V2 非法输出重试');
        invalidBrainstormOnce = true;
        const command = {
            commandId: 'workflow-v2-invalid-output-retry',
            runRevision: fixture.view.run.revision,
            type: 'execute',
            payload: {},
        };
        const first = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
        ).send(command);
        assert.equal(first.status, 502);
        assert.equal(first.body.error, 'invalid_workflow_model_output');
        const store = new GenerationStore(path.join(dataRoot, 'generation-history'));
        let attempts = store.listGenerations(fixture.projectId, fixture.chapterId)
            .map(item => store.getGeneration(fixture.projectId, fixture.chapterId, item.id));
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].status, 'failed');
        assert.equal(attempts[0].finishReason, 'invalid-output');
        assert.equal(attempts[0].request.workflowGeneration.attempt, 1);

        const recovered = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${fixture.view.run.id}/commands`), csrfToken,
        ).send(command).expect(200);
        assert.equal(recovered.body.run.currentStepId, 'select-direction');
        attempts = store.listGenerations(fixture.projectId, fixture.chapterId)
            .map(item => store.getGeneration(fixture.projectId, fixture.chapterId, item.id))
            .sort((left, right) => left.request.workflowGeneration.attempt - right.request.workflowGeneration.attempt);
        assert.deepEqual(attempts.map(item => item.status), ['failed', 'completed']);
        assert.deepEqual(attempts.map(item => item.request.workflowGeneration.attempt), [1, 2]);
        assert.equal(attempts[1].request.workflowGeneration.retryOf, attempts[0].id);
        assert.equal(providerCalls.filter(call => call.operation === 'brainstorm').length, 2);
    });
});
