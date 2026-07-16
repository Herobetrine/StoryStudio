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
import { hashWorkflowValue, WorkflowStore } from '../src/workflow-store.js';

const LOCAL_HOST = '127.0.0.1:8123';

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sseResponse(content) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                model: 'workflow-recovery-model',
                choices: [{ delta: { content }, finish_reason: 'stop' }],
                usage: { total_tokens: 24 },
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

async function waitForGate(gate, signal) {
    if (!gate) return;
    gate.started.resolve();
    if (signal?.aborted) throw signal.reason;
    let abort;
    const aborted = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted.', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
    });
    try {
        await Promise.race([gate.release.promise, aborted]);
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

describe('workflow generation crash and concurrency recovery', () => {
    let app;
    let csrfToken;
    let dataRoot;
    let definition;
    let streamCalls;
    let distillCalls;
    let sequence;
    let nextStreamGate;
    let nextDistillGate;
    let providerFetch;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-workflow-generation-'));
        streamCalls = 0;
        distillCalls = 0;
        sequence = 0;
        nextStreamGate = null;
        nextDistillGate = null;
        providerFetch = async (_url, options) => {
            const body = JSON.parse(options.body);
            if (body.stream === true) {
                streamCalls += 1;
                const gate = nextStreamGate;
                if (gate) {
                    nextStreamGate = null;
                    gate.signal = options.signal;
                    if (gate.ignoreAbort) {
                        gate.started.resolve();
                        await gate.release.promise;
                    } else {
                        await waitForGate(gate, options.signal);
                    }
                }
                return sseResponse(streamCalls === 1
                    ? '林照握紧铜钥匙，在赤门闭合前进入地下书库。'
                    : '审校结论：目标、阻力和章尾钩子都已落地。');
            }
            distillCalls += 1;
            const gate = nextDistillGate;
            if (gate) {
                nextDistillGate = null;
                gate.signal = options.signal;
                if (gate.ignoreAbort) {
                    gate.started.resolve();
                    await gate.release.promise;
                } else {
                    await waitForGate(gate, options.signal);
                }
            }
            return jsonResponse({
                model: 'workflow-recovery-model',
                choices: [{ message: { content: JSON.stringify({
                    chapterSummary: '林照持铜钥匙进入地下书库。',
                    storyStateChanges: {
                        entities: { upsert: [], delete: [] },
                        relations: { upsert: [], delete: [] },
                        events: { upsert: [], delete: [] },
                        promises: { upsert: [], delete: [] },
                        memory: { upsert: [], delete: [] },
                        facts: { upsert: [], delete: [] },
                        knowledge: { upsert: [], delete: [] },
                        timeline: { upsert: [], delete: [] },
                    },
                }) } }],
                usage: { total_tokens: 64 },
            });
        };
        app = createApp({ dataRoot, fetchImplementation: providerFetch });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        await write(request(app).put('/api/provider'), csrfToken).send({
            protocol: 'openai-chat',
            baseUrl: 'http://workflow-recovery.local/v1',
            model: 'workflow-recovery-model',
            contextTokens: 32_768,
            maxTokens: 8_192,
            temperature: 0.7,
            topP: 1,
            topK: 0,
            stop: [],
            jsonSchema: true,
        }).expect(200);
        definition = (await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.definitions.find(item => item.id === 'builtin.chapter-cycle.v1');
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    async function createRun(title = '工作流生成恢复') {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title,
            genre: '玄幻',
            story: { logline: '林照必须在赤门关闭前进入地下书库。' },
        }).expect(201);
        const projectId = created.body.project.id;
        const chapterId = created.body.chapter.id;
        const chapterPath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}`;
        const view = (await write(request(app).post(`${chapterPath}/workflow-runs`), csrfToken).send({
            commandId: `start-generation-recovery-${++sequence}`,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
            input: {},
        }).expect(201)).body;
        return { projectId, chapterId, chapterPath, view };
    }

    async function execute(fixture, view, payload = {}, options = {}) {
        const body = {
            commandId: options.commandId ?? `generation-recovery-${++sequence}`,
            runRevision: options.runRevision ?? view.run.revision,
            type: options.type ?? 'execute',
            payload,
        };
        const response = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(body);
        return { body, response };
    }

    function artifactBinding(view) {
        return {
            artifactId: view.currentArtifact.id,
            artifactHash: view.currentArtifact.bindingHash,
        };
    }

    async function advanceToDraft(fixture) {
        let { view } = fixture;
        for (let index = 0; index < 2; index += 1) {
            const result = await execute(fixture, view);
            assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
            view = result.response.body;
        }
        for (let index = 0; index < 2; index += 1) {
            const result = await execute(fixture, view, artifactBinding(view));
            assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
            view = result.response.body;
        }
        assert.equal(view.run.currentStepId, 'draft');
        fixture.view = view;
        return view;
    }

    async function advanceToAdopt(fixture) {
        let view = await advanceToDistill(fixture);

        let result = await execute(fixture, view);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'approve-state');

        result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'adopt');

        fixture.view = view;
        return view;
    }

    async function advanceToDistill(fixture) {
        let view = await advanceToDraft(fixture);
        const result = await execute(fixture, view);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'distill');
        fixture.view = view;
        return view;
    }

    async function advanceToReview(fixture) {
        let view = await advanceToAdopt(fixture);
        const result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;

        assert.equal(view.run.currentStepId, 'review');
        fixture.view = view;
        return view;
    }

    function generationStore() {
        return new GenerationStore(path.join(dataRoot, 'generation-history'));
    }

    function workflowDistillation(store, fixture, view, generationId) {
        const slot = {
            projectId: fixture.projectId,
            chapterId: fixture.chapterId,
            runId: view.run.id,
            stepId: 'distill',
            runRevision: view.run.revision,
            generationId,
            kind: 'distill',
        };
        return store.getWorkflowDistillation(
            fixture.projectId,
            fixture.chapterId,
            generationId,
            hashWorkflowValue(slot),
        );
    }

    function holdNextStream({ ignoreAbort = false } = {}) {
        const gate = { started: deferred(), release: deferred(), ignoreAbort, signal: null };
        nextStreamGate = gate;
        return gate;
    }

    function holdNextDistillation({ ignoreAbort = false } = {}) {
        const gate = { started: deferred(), release: deferred(), ignoreAbort, signal: null };
        nextDistillGate = gate;
        return gate;
    }

    test('cancels an active draft with an exact receipt and holds the chapter lock until Provider drain', async () => {
        const fixture = await createRun('显式取消正文生成');
        const view = await advanceToDraft(fixture);
        const blockedStart = await write(request(app).post(`${fixture.chapterPath}/workflow-runs`), csrfToken).send({
            commandId: 'second-writer-must-wait',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: view.authority.projectVersion,
            chapterRevision: view.authority.chapterRevision,
            input: {},
        });
        assert.equal(blockedStart.status, 409);
        assert.equal(blockedStart.body.error, 'workflow_active_run_exists');

        const executeBody = {
            commandId: 'cancelled-draft-execute',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {},
        };
        const gate = holdNextStream({ ignoreAbort: true });
        const executing = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(executeBody).then(response => response);
        await gate.started.promise;

        const cancelBody = {
            commandId: 'cancel-active-draft',
            runRevision: view.run.revision,
            type: 'cancel',
            payload: { stepId: 'draft', reason: '用户停止本次正文生成。' },
        };
        const cancelled = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(cancelBody).expect(200);
        assert.equal(cancelled.body.run.status, 'cancelled');
        assert.equal(cancelled.body.run.currentStepId, null);
        assert.equal(cancelled.body.command.type, 'cancel');
        assert.equal(cancelled.body.command.replayed, false);
        assert.equal(gate.signal.aborted, true);
        assert.equal(cancelled.body.run.steps.find(step => step.id === 'draft').status, 'cancelled');
        assert.ok(cancelled.body.run.steps
            .filter(step => step.id !== 'draft' && step.status !== 'completed')
            .every(step => step.status === 'cancelled'));

        const drainingStart = await write(request(app).post(`${fixture.chapterPath}/workflow-runs`), csrfToken).send({
            commandId: 'writer-during-abort-drain',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: view.authority.projectVersion,
            chapterRevision: view.authority.chapterRevision,
            input: {},
        });
        assert.equal(drainingStart.status, 409);
        assert.equal(drainingStart.body.error, 'workflow_cancellation_in_progress');

        gate.release.resolve();
        const stoppedExecute = await executing;
        assert.equal(stoppedExecute.status, 409);
        assert.equal(stoppedExecute.body.error, 'workflow_cancelled');
        const generations = generationStore().listGenerations(fixture.projectId, fixture.chapterId);
        const aborted = generationStore().getGeneration(
            fixture.projectId,
            fixture.chapterId,
            generations.find(item => item.kind === 'draft').id,
        );
        assert.equal(aborted.status, 'failed');
        assert.equal(aborted.finishReason, 'aborted');
        assert.equal(cancelled.body.artifacts.some(item => item.kind === 'chapter-draft'), false);

        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        fs.rmSync(workflowStore.receiptPath(cancelBody.commandId));
        app = createApp({ dataRoot, fetchImplementation: providerFetch });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        const replay = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(cancelBody).expect(200);
        assert.equal(replay.body.run.status, 'cancelled');
        assert.equal(replay.body.run.revision, cancelled.body.run.revision);
        assert.equal(replay.body.command.replayed, true);

        const replacement = await write(request(app).post(`${fixture.chapterPath}/workflow-runs`), csrfToken).send({
            commandId: 'writer-after-cancel-drain',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: replay.body.authority.projectVersion,
            chapterRevision: replay.body.authority.chapterRevision,
            input: {},
        }).expect(201);
        assert.equal(replacement.body.run.status, 'running');
    });

    test('aborts non-streaming workflow distillation and preserves a failed sidecar attempt', async () => {
        const fixture = await createRun('显式取消蒸馏');
        const view = await advanceToDistill(fixture);
        const generationId = view.artifacts.find(item => item.kind === 'chapter-draft').payload.generationId;
        const executeBody = {
            commandId: 'cancelled-distill-execute',
            runRevision: view.run.revision,
            type: 'execute',
            payload: { instruction: '提取已成立的连续性变化。' },
        };
        const gate = holdNextDistillation();
        const executing = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(executeBody).then(response => response);
        await gate.started.promise;
        const running = workflowDistillation(generationStore(), fixture, view, generationId);
        assert.equal(running.status, 'running');

        const cancelBody = {
            commandId: 'cancel-active-distill',
            runRevision: view.run.revision,
            type: 'cancel',
            payload: { stepId: 'distill' },
        };
        const cancelled = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(cancelBody).expect(200);
        assert.equal(cancelled.body.run.status, 'cancelled');
        assert.equal(gate.signal.aborted, true);
        const stopped = await executing;
        assert.equal(stopped.status, 409);
        assert.equal(stopped.body.error, 'workflow_cancelled');
        const failed = workflowDistillation(generationStore(), fixture, view, generationId);
        assert.equal(failed.status, 'failed');
        assert.match(failed.error, /cancelled|aborted/iu);
        assert.equal(cancelled.body.artifacts.some(item => item.kind === 'state-change-set'), false);
    });

    test('reuses one completed draft generation after workflow receipt commit fails', async () => {
        const fixture = await createRun('提交故障恢复');
        const view = await advanceToDraft(fixture);
        const command = {
            commandId: 'draft-before-receipt-crash',
            runRevision: view.run.revision,
            type: 'execute',
            payload: { instruction: '保持主角限知。' },
        };
        const originalCompleteStep = WorkflowService.prototype.completeStep;
        WorkflowService.prototype.completeStep = function failDraftCommit(run, ...args) {
            if (run.currentStepId === 'draft') {
                throw new ApiError(500, 'simulated_workflow_commit_failure', 'Simulated failure before workflow receipt commit.');
            }
            return originalCompleteStep.call(this, run, ...args);
        };
        try {
            const failed = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
                csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'simulated_workflow_commit_failure');
        } finally {
            WorkflowService.prototype.completeStep = originalCompleteStep;
        }

        let generations = generationStore().listGenerations(fixture.projectId, fixture.chapterId);
        assert.equal(streamCalls, 1);
        assert.equal(generations.length, 1);
        let generation = generationStore().getGeneration(fixture.projectId, fixture.chapterId, generations[0].id);
        assert.equal(generation.status, 'completed');
        assert.deepEqual(generation.request.workflowGeneration.slot, {
            projectId: fixture.projectId,
            chapterId: fixture.chapterId,
            runId: view.run.id,
            stepId: 'draft',
            runRevision: view.run.revision,
            kind: 'draft',
        });

        const takeover = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send({ ...command, commandId: 'different-command-same-draft-payload' });
        assert.equal(takeover.status, 409);
        assert.equal(takeover.body.error, 'workflow_generation_conflict');
        assert.equal(streamCalls, 1);

        const recovered = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        generations = generationStore().listGenerations(fixture.projectId, fixture.chapterId);
        assert.equal(streamCalls, 1);
        assert.equal(generations.length, 1);
        assert.equal(recovered.body.run.currentStepId, 'distill');
        assert.equal(recovered.body.artifacts.filter(item => item.kind === 'chapter-draft').length, 1);
        generation = generationStore().getGeneration(fixture.projectId, fixture.chapterId, generations[0].id);
        assert.equal(recovered.body.artifact.payload.generationId, generation.id);
    });

    test('keeps a manual ready distillation isolated from the workflow result', async () => {
        const fixture = await createRun('手工蒸馏不能冒充工作流');
        const view = await advanceToDistill(fixture);
        const draftArtifact = view.artifacts.find(item => item.kind === 'chapter-draft');
        const store = generationStore();
        store.saveDistillation(fixture.projectId, fixture.chapterId, draftArtifact.payload.generationId, {
            status: 'ready',
            changes: {
                chapterSummary: '这是手工生成的摘要。',
                storyStateChanges: {
                    entities: { upsert: [], delete: [] },
                    relations: { upsert: [], delete: [] },
                    events: { upsert: [], delete: [] },
                    promises: { upsert: [], delete: [] },
                    memory: { upsert: [], delete: [] },
                    facts: { upsert: [], delete: [] },
                    knowledge: { upsert: [], delete: [] },
                    timeline: { upsert: [], delete: [] },
                },
            },
            raw: '{"chapterSummary":"这是手工生成的摘要。"}',
        });

        const distilled = await execute(fixture, view, { instruction: '使用另一套工作流提示。' }, {
            commandId: 'workflow-cannot-claim-manual-ready',
        });
        assert.equal(distilled.response.status, 200, JSON.stringify(distilled.response.body));
        assert.equal(distillCalls, 1);
        const preserved = store.getGeneration(
            fixture.projectId, fixture.chapterId, draftArtifact.payload.generationId,
        ).distillation;
        assert.equal(preserved.status, 'ready');
        assert.equal(preserved.workflowGeneration, null);
        assert.equal(preserved.changes.chapterSummary, '这是手工生成的摘要。');
        const workflow = workflowDistillation(store, fixture, view, draftArtifact.payload.generationId);
        assert.equal(workflow.status, 'ready');
        assert.notEqual(workflow.changes.chapterSummary, preserved.changes.chapterSummary);
    });

    test('persists exact distill intent before Provider and shares one concurrent call', async () => {
        const fixture = await createRun('蒸馏并发单飞');
        const view = await advanceToDistill(fixture);
        const generationId = view.artifacts.find(item => item.kind === 'chapter-draft').payload.generationId;
        const command = {
            commandId: 'concurrent-distill-command',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {
                instruction: '只提取正文已成立的变化。',
                contextOverrides: { includeEntityIds: [], excludeEntityIds: [] },
            },
        };
        const gate = holdNextDistillation();
        const first = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command).then(response => response);
        await Promise.race([
            gate.started.promise,
            first.then(response => {
                throw new Error(`Distillation stopped before Provider: ${response.status} ${JSON.stringify(response.body)}`);
            }),
            new Promise((_resolve, reject) => setTimeout(async () => {
                const pending = await request(app)
                    .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
                    .set('Host', LOCAL_HOST);
                reject(new Error(`Distillation Provider did not start: calls=${distillCalls} operation=${JSON.stringify(pending.body.operation)}`));
            }, 10_000)),
        ]);

        const store = generationStore();
        let second;
        try {
            const inProvider = workflowDistillation(store, fixture, view, generationId);
            assert.equal(inProvider.status, 'running');
            assert.deepEqual(inProvider.workflowGeneration.slot, {
                projectId: fixture.projectId,
                chapterId: fixture.chapterId,
                runId: view.run.id,
                stepId: 'distill',
                runRevision: view.run.revision,
                generationId,
                kind: 'distill',
            });
            assert.equal(inProvider.workflowGeneration.commandId, command.commandId);
            assert.equal(
                inProvider.workflowGeneration.commandDigest,
                hashWorkflowValue({ type: command.type, payload: command.payload }),
            );
            assert.equal(inProvider.workflowGeneration.attempt, 1);

            second = write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command).then(response => response);
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.equal(distillCalls, 1);
        } finally {
            gate.release.resolve();
        }
        const responses = await Promise.all([first, second]);
        for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(responses[0].body.artifact.id, responses[1].body.artifact.id);
        assert.equal(responses[0].body.artifacts.filter(item => item.kind === 'state-change-set').length, 1);
        const ready = workflowDistillation(store, fixture, view, generationId);
        assert.equal(ready.status, 'ready');
        assert.equal(ready.workflowGeneration.attempt, 1);
    });

    test('reuses exact ready distillation after restart when workflow commit fails', async () => {
        const fixture = await createRun('蒸馏提交故障恢复');
        const view = await advanceToDistill(fixture);
        const generationId = view.artifacts.find(item => item.kind === 'chapter-draft').payload.generationId;
        const command = {
            commandId: 'distill-before-receipt-crash',
            runRevision: view.run.revision,
            type: 'execute',
            payload: { instruction: '恢复时必须复用这次 ChangeSet。' },
        };
        const originalCompleteStep = WorkflowService.prototype.completeStep;
        WorkflowService.prototype.completeStep = function failDistillCommit(run, ...args) {
            if (run.currentStepId === 'distill') {
                throw new ApiError(500, 'simulated_distill_commit_failure', 'Simulated distill commit failure.');
            }
            return originalCompleteStep.call(this, run, ...args);
        };
        try {
            const failed = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'simulated_distill_commit_failure');
        } finally {
            WorkflowService.prototype.completeStep = originalCompleteStep;
        }

        const store = generationStore();
        const ready = workflowDistillation(store, fixture, view, generationId);
        assert.equal(ready.status, 'ready');
        assert.equal(ready.workflowGeneration.commandId, command.commandId);
        assert.equal(ready.workflowGeneration.attempt, 1);
        assert.equal(distillCalls, 1);

        const changedPayload = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send({
            ...command,
            payload: { instruction: '不同 payload 不能接管 ready ChangeSet。' },
        });
        assert.equal(changedPayload.status, 409);
        assert.equal(changedPayload.body.error, 'workflow_generation_conflict');
        const changedCommand = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send({ ...command, commandId: 'different-command-cannot-claim-ready' });
        assert.equal(changedCommand.status, 409);
        assert.equal(changedCommand.body.error, 'workflow_generation_conflict');
        assert.equal(distillCalls, 1);

        app = createApp({ dataRoot, fetchImplementation: providerFetch });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        const recovered = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command).expect(200);
        assert.equal(distillCalls, 1);
        assert.equal(recovered.body.run.currentStepId, 'approve-state');
        assert.equal(recovered.body.artifact.payload.generationId, generationId);
        assert.equal(recovered.body.artifacts.filter(item => item.kind === 'state-change-set').length, 1);
    });

    test('retries only exact failed or interrupted distill bindings with an audited attempt', async () => {
        for (const priorStatus of ['running', 'failed']) {
            const fixture = await createRun(`蒸馏 ${priorStatus} 恢复`);
            const view = await advanceToDistill(fixture);
            const generationId = view.artifacts.find(item => item.kind === 'chapter-draft').payload.generationId;
            const command = {
                commandId: `distill-retry-${priorStatus}`,
                runRevision: view.run.revision,
                type: 'execute',
                payload: { instruction: `恢复 ${priorStatus} 蒸馏。` },
            };
            const slot = {
                projectId: fixture.projectId,
                chapterId: fixture.chapterId,
                runId: view.run.id,
                stepId: 'distill',
                runRevision: view.run.revision,
                generationId,
                kind: 'distill',
            };
            const store = generationStore();
            store.saveDistillation(fixture.projectId, fixture.chapterId, generationId, {
                status: priorStatus,
                changes: null,
                raw: '',
                error: priorStatus === 'failed' ? 'Original Provider failure.' : '',
                workflowGeneration: {
                    schemaVersion: 1,
                    slot,
                    slotDigest: hashWorkflowValue(slot),
                    commandDigest: hashWorkflowValue({ type: command.type, payload: command.payload }),
                    commandId: command.commandId,
                    attempt: 1,
                },
            });
            const callsBefore = distillCalls;

            const takeover = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send({
                ...command,
                commandId: `distill-takeover-${priorStatus}`,
                payload: { instruction: '不能接管已有失败或中断槽位。' },
            });
            assert.equal(takeover.status, 409);
            assert.equal(takeover.body.error, 'workflow_generation_conflict');
            assert.equal(distillCalls, callsBefore);

            const recovered = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command).expect(200);
            assert.equal(recovered.body.run.currentStepId, 'approve-state');
            assert.equal(distillCalls, callsBefore + 1);
            const final = workflowDistillation(store, fixture, view, generationId);
            assert.equal(final.status, 'ready');
            assert.equal(final.workflowGeneration.commandId, command.commandId);
            assert.equal(final.workflowGeneration.attempt, 2);
        }
    });

    test('shares one in-process Provider call for concurrent review commands', async () => {
        const fixture = await createRun('审校并发复用');
        const view = await advanceToReview(fixture);
        assert.equal(streamCalls, 1);
        const command = {
            commandId: 'concurrent-review-command',
            runRevision: view.run.revision,
            type: 'execute',
            payload: { instruction: '检查因果闭环。' },
        };
        const gate = holdNextStream();
        const first = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command).then(response => response);
        await gate.started.promise;
        const second = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command).then(response => response);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(streamCalls, 2);
        gate.release.resolve();
        const responses = await Promise.all([first, second]);
        for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(responses[0].body.artifact.id, responses[1].body.artifact.id);
        const generations = generationStore().listGenerations(fixture.projectId, fixture.chapterId);
        assert.equal(generations.filter(item => item.kind === 'review').length, 1);
        assert.equal(responses[0].body.artifacts.filter(item => item.kind === 'chapter-review').length, 1);
    });

    test('fails closed on a second command while the same draft command is in progress', async () => {
        const fixture = await createRun('槽位 payload 冲突');
        const view = await advanceToDraft(fixture);
        const gate = holdNextStream();
        const firstCommand = {
            commandId: 'slot-command-one',
            runRevision: view.run.revision,
            type: 'execute',
            payload: { instruction: '版本一。' },
        };
        const first = write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(firstCommand).then(response => response);
        await gate.started.promise;
        const conflict = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send({
            ...firstCommand,
            commandId: 'slot-command-two',
            payload: { instruction: '版本二。' },
        });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.error, 'workflow_command_in_progress');
        assert.equal(streamCalls, 1);
        gate.release.resolve();
        const completed = await first;
        assert.equal(completed.status, 200, JSON.stringify(completed.body));
        assert.equal(generationStore().listGenerations(fixture.projectId, fixture.chapterId).length, 1);
        assert.equal(completed.body.artifacts.filter(item => item.kind === 'chapter-draft').length, 1);
    });

    test('retries orphaned streaming and failed slots without erasing their audit records', async () => {
        for (const orphanStatus of ['streaming', 'failed']) {
            const fixture = await createRun(`遗留 ${orphanStatus}`);
            const view = await advanceToDraft(fixture);
            const command = {
                commandId: `retry-${orphanStatus}`,
                runRevision: view.run.revision,
                type: 'execute',
                payload: { instruction: `恢复 ${orphanStatus}` },
            };
            const slot = {
                projectId: fixture.projectId,
                chapterId: fixture.chapterId,
                runId: view.run.id,
                stepId: 'draft',
                runRevision: view.run.revision,
                kind: 'draft',
            };
            const store = generationStore();
            const orphan = store.createGeneration({
                projectId: fixture.projectId,
                chapterId: fixture.chapterId,
                kind: 'draft',
                request: {
                    projectVersion: view.authority.projectVersion,
                    chapterRevision: view.authority.chapterRevision,
                    workflowGeneration: {
                        schemaVersion: 1,
                        slot,
                        slotDigest: hashWorkflowValue(slot),
                        commandDigest: hashWorkflowValue({ type: command.type, payload: command.payload }),
                        commandId: command.commandId,
                        attempt: 1,
                        retryOf: null,
                    },
                },
            });
            if (orphanStatus === 'failed') {
                store.finishGeneration(fixture.projectId, fixture.chapterId, orphan.id, {
                    status: 'failed',
                    finishReason: 'error',
                    error: 'Original provider failure.',
                });
            }

            const recovered = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command).expect(200);
            const records = store.listGenerations(fixture.projectId, fixture.chapterId)
                .map(item => store.getGeneration(fixture.projectId, fixture.chapterId, item.id));
            assert.equal(records.length, 2);
            const preserved = records.find(item => item.id === orphan.id);
            const retry = records.find(item => item.id !== orphan.id);
            assert.equal(preserved.status, 'failed');
            assert.equal(retry.status, 'completed');
            assert.equal(retry.request.workflowGeneration.retryOf, orphan.id);
            assert.equal(retry.request.workflowGeneration.attempt, 2);
            assert.equal(recovered.body.artifact.payload.generationId, retry.id);
            assert.equal(recovered.body.artifacts.filter(item => item.kind === 'chapter-draft').length, 1);
        }
        assert.equal(streamCalls, 2);
    });

    test('attaches one completed generation to sequential runs without artifact id collisions', async () => {
        const seed = await createRun('同 Generation 跨 Run 附着');
        const completeCard = {
            summary: '林照抵达赤门。',
            goal: '在赤门关闭前进城。',
            conflict: '守将要求检查铜钥匙。',
            turn: '守将也在寻找同样的钥匙。',
            hook: '门内传来第二把钥匙落地的声音。',
            pov: 'lin-zhao',
            time: '黄昏',
            location: 'red-gate',
            required: '交代钥匙与入城目标。',
            avoid: '不提前揭示地下书库真相。',
        };
        const patched = await write(request(app).patch(seed.chapterPath), csrfToken).send({
            projectVersion: seed.view.authority.projectVersion,
            revision: seed.view.authority.chapterRevision,
            changes: { card: completeCard },
        }).expect(200);
        const seedCancelled = await execute(seed, seed.view, {
            stepId: seed.view.run.currentStepId,
            reason: '释放初始化运行的章节写锁。',
        }, {
            commandId: 'cancel-shared-generation-seed',
            type: 'cancel',
        });
        assert.equal(seedCancelled.response.status, 200, JSON.stringify(seedCancelled.response.body));
        assert.equal(seedCancelled.response.body.run.status, 'cancelled');

        async function startSiblingRun(commandId, authority = {
            projectVersion: patched.body.project.version,
            chapterRevision: patched.body.chapter.revision,
        }) {
            return (await write(request(app).post(`${seed.chapterPath}/workflow-runs`), csrfToken).send({
                commandId,
                definitionId: definition.id,
                definitionHash: definition.definitionHash,
                projectVersion: authority.projectVersion,
                chapterRevision: authority.chapterRevision,
                input: {},
            }).expect(201)).body;
        }

        const first = { ...seed, view: await startSiblingRun('shared-generation-run-one') };
        await advanceToDraft(first);

        const store = generationStore();
        const generation = store.createGeneration({
            projectId: seed.projectId,
            chapterId: seed.chapterId,
            kind: 'draft',
            request: {
                projectVersion: first.view.authority.projectVersion,
                chapterRevision: first.view.authority.chapterRevision,
            },
        });
        const completed = store.finishGeneration(seed.projectId, seed.chapterId, generation.id, {
            content: '林照握紧铜钥匙，在赤门闭合前进入地下书库。',
            finishReason: 'stop',
            model: 'workflow-recovery-model',
        });
        const firstAttached = await execute(first, first.view, { generationId: completed.id }, {
            commandId: 'attach-on-first-run',
            type: 'attach-generation',
        });
        assert.equal(firstAttached.response.status, 200, JSON.stringify(firstAttached.response.body));
        const blockedSecond = await write(request(app).post(`${seed.chapterPath}/workflow-runs`), csrfToken).send({
            commandId: 'shared-generation-run-two-before-cancel',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: firstAttached.response.body.authority.projectVersion,
            chapterRevision: firstAttached.response.body.authority.chapterRevision,
            input: {},
        });
        assert.equal(blockedSecond.status, 409);
        assert.equal(blockedSecond.body.error, 'workflow_active_run_exists');

        const firstCancelled = await execute(first, firstAttached.response.body, {
            stepId: firstAttached.response.body.run.currentStepId,
            reason: '首个运行完成 Generation 附着验证后释放章节写锁。',
        }, {
            commandId: 'cancel-shared-generation-run-one',
            type: 'cancel',
        });
        assert.equal(firstCancelled.response.status, 200, JSON.stringify(firstCancelled.response.body));
        assert.equal(firstCancelled.response.body.run.status, 'cancelled');

        const second = {
            ...seed,
            view: await startSiblingRun(
                'shared-generation-run-two',
                firstCancelled.response.body.authority,
            ),
        };
        await advanceToDraft(second);
        assert.equal(first.view.authority.projectVersion, second.view.authority.projectVersion);
        assert.equal(first.view.authority.chapterRevision, second.view.authority.chapterRevision);
        const secondAttached = await execute(second, second.view, { generationId: completed.id }, {
            commandId: 'attach-on-second-run',
            type: 'attach-generation',
        });
        assert.equal(secondAttached.response.status, 200, JSON.stringify(secondAttached.response.body));

        const firstArtifact = firstAttached.response.body.artifact;
        const secondArtifact = secondAttached.response.body.artifact;
        assert.equal(firstArtifact.payload.generationId, completed.id);
        assert.equal(secondArtifact.payload.generationId, completed.id);
        assert.notEqual(firstArtifact.id, secondArtifact.id);
        assert.equal(firstArtifact.runId, first.view.run.id);
        assert.equal(secondArtifact.runId, second.view.run.id);
        assert.equal(firstAttached.response.body.artifacts.filter(item => item.kind === 'chapter-draft').length, 1);
        assert.equal(secondAttached.response.body.artifacts.filter(item => item.kind === 'chapter-draft').length, 1);
        assert.equal(generationStore().listGenerations(seed.projectId, seed.chapterId).length, 1);
        assert.equal(streamCalls, 0);
    });

    test('does not absorb unrelated manuscript edits that accompany the expected review target', async () => {
        const fixture = await createRun('审校恢复不吸收无关正文');
        let view = await advanceToReview(fixture);
        let result = await execute(fixture, view);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'apply-review');
        const chapter = (await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200)).body;
        const patch = view.currentArtifact.payload.patch;
        const unrelatedContent = `${chapter.content}\n这行是与审校无关的并发正文。`;
        const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: view.authority.projectVersion,
            revision: view.authority.chapterRevision,
            changes: {
                review: patch.review,
                notes: patch.notes ?? chapter.notes,
                content: unrelatedContent,
            },
        }).expect(200);

        result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 409);
        assert.equal(result.response.body.error, 'workflow_authority_changed');
        const after = await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200);
        assert.equal(after.body.content, unrelatedContent);
        assert.equal(after.body.review, patch.review);
        assert.equal(after.body.revision, external.body.chapter.revision);
        const blocked = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(blocked.body.run.currentStepId, 'apply-review');
        assert.notEqual(blocked.body.currentArtifact.status, 'applied');
    });

    test('rejects closeout recovery when a matching done update also changes notes or title', async () => {
        for (const scenario of [
            { label: 'notes', changes: { notes: '与收尾无关的并发备注。' } },
            { label: 'title', changes: { title: '外部改写的章节标题' } },
        ]) {
            const fixture = await createRun(`收尾恢复隔离 ${scenario.label}`);
            let view = await advanceToReview(fixture);
            let result = await execute(fixture, view);
            assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
            view = result.response.body;
            assert.equal(view.run.currentStepId, 'apply-review');
            result = await execute(fixture, view, artifactBinding(view));
            assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
            view = result.response.body;
            assert.equal(view.run.currentStepId, 'closeout');

            const command = {
                commandId: `closeout-after-artifact-${scenario.label}`,
                runRevision: view.run.revision,
                type: 'execute',
                payload: {},
            };
            const originalApproveArtifact = WorkflowService.prototype.approveArtifact;
            WorkflowService.prototype.approveArtifact = function failAfterCloseoutArtifact(artifact, ...args) {
                if (artifact.kind === 'closeout') {
                    throw new ApiError(500, 'simulated_closeout_after_artifact',
                        'Simulated failure after closeout artifact creation.');
                }
                return originalApproveArtifact.call(this, artifact, ...args);
            };
            try {
                const failed = await write(
                    request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
                ).send(command);
                assert.equal(failed.status, 500);
                assert.equal(failed.body.error, 'simulated_closeout_after_artifact');
            } finally {
                WorkflowService.prototype.approveArtifact = originalApproveArtifact;
            }

            const afterCrash = await request(app)
                .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            const closeoutArtifact = afterCrash.body.artifacts.find(item => item.kind === 'closeout');
            assert.ok(closeoutArtifact);
            assert.equal(closeoutArtifact.status, 'candidate');
            assert.equal(closeoutArtifact.target.projectVersion, null);
            assert.equal(afterCrash.body.run.currentStepId, 'closeout');

            const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
                projectVersion: afterCrash.body.authority.projectVersion,
                revision: afterCrash.body.authority.chapterRevision,
                changes: { status: 'done', ...scenario.changes },
            }).expect(200);
            assert.equal(external.body.chapter.status, 'done');

            const rejected = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command);
            assert.equal(rejected.status, 409);
            assert.equal(rejected.body.error, 'workflow_authority_changed');
            const chapter = await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200);
            assert.equal(chapter.body.revision, external.body.chapter.revision);
            assert.equal(chapter.body.status, 'done');
            for (const [field, value] of Object.entries(scenario.changes)) {
                assert.equal(chapter.body[field], value);
            }
            const blocked = await request(app)
                .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            assert.equal(blocked.body.run.currentStepId, 'closeout');
            assert.equal(blocked.body.artifacts.find(item => item.kind === 'closeout').status, 'approved');
        }
    });

    test('recovers independently when adoption stops between state and draft artifact transitions', async () => {
        const fixture = await createRun('采纳双 Artifact 故障恢复');
        const view = await advanceToAdopt(fixture);
        const command = {
            commandId: 'adoption-between-artifacts-crash',
            runRevision: view.run.revision,
            type: 'execute',
            payload: artifactBinding(view),
        };
        const originalApplyArtifact = WorkflowService.prototype.applyArtifact;
        WorkflowService.prototype.applyArtifact = function failDraftArtifact(artifact, ...args) {
            if (artifact.kind === 'chapter-draft') {
                throw new ApiError(500, 'simulated_draft_artifact_failure',
                    'Simulated failure between adoption artifact transitions.');
            }
            return originalApplyArtifact.call(this, artifact, ...args);
        };
        try {
            const failed = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'simulated_draft_artifact_failure');
        } finally {
            WorkflowService.prototype.applyArtifact = originalApplyArtifact;
        }

        const afterCrash = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const stateArtifact = afterCrash.body.artifacts.find(item => item.kind === 'state-change-set');
        const draftArtifact = afterCrash.body.artifacts.find(item => item.kind === 'chapter-draft');
        assert.equal(afterCrash.body.run.currentStepId, 'adopt');
        assert.equal(stateArtifact.status, 'applied');
        assert.notEqual(draftArtifact.status, 'applied');
        const authorityAfterCrash = afterCrash.body.authority;

        const recovered = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command).expect(200);
        assert.equal(recovered.body.run.currentStepId, 'review');
        assert.equal(recovered.body.command.replayed, false);
        assert.equal(recovered.body.authority.projectVersion, authorityAfterCrash.projectVersion);
        assert.equal(recovered.body.authority.chapterRevision, authorityAfterCrash.chapterRevision);
        assert.equal(recovered.body.artifacts.find(item => item.kind === 'state-change-set').status, 'applied');
        assert.equal(recovered.body.artifacts.find(item => item.kind === 'chapter-draft').status, 'applied');
        const chapter = await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200);
        assert.equal(chapter.body.generationHistory.length, 1);
    });

    test('does not absorb authority drift after adoption commits between artifact transitions', async () => {
        const fixture = await createRun('采纳中断后的外部漂移');
        const view = await advanceToAdopt(fixture);
        const command = {
            commandId: 'adoption-between-artifacts-then-drift',
            runRevision: view.run.revision,
            type: 'execute',
            payload: artifactBinding(view),
        };
        const originalApplyArtifact = WorkflowService.prototype.applyArtifact;
        WorkflowService.prototype.applyArtifact = function failDraftArtifact(artifact, ...args) {
            if (artifact.kind === 'chapter-draft') {
                throw new ApiError(500, 'simulated_draft_artifact_failure',
                    'Simulated failure between adoption artifact transitions.');
            }
            return originalApplyArtifact.call(this, artifact, ...args);
        };
        try {
            const failed = await write(
                request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, 'simulated_draft_artifact_failure');
        } finally {
            WorkflowService.prototype.applyArtifact = originalApplyArtifact;
        }

        const afterCrash = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const stateArtifact = afterCrash.body.artifacts.find(item => item.kind === 'state-change-set');
        const draftArtifact = afterCrash.body.artifacts.find(item => item.kind === 'chapter-draft');
        assert.equal(afterCrash.body.run.currentStepId, 'adopt');
        assert.equal(stateArtifact.status, 'applied');
        assert.notEqual(draftArtifact.status, 'applied');

        const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: afterCrash.body.authority.projectVersion,
            revision: afterCrash.body.authority.chapterRevision,
            changes: { notes: '采纳已写入后发生的外部备注。' },
        }).expect(200);
        const rejected = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(command);
        assert.equal(rejected.status, 409);
        assert.equal(rejected.body.error, 'workflow_authority_changed');

        const chapter = await request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200);
        assert.equal(chapter.body.revision, external.body.chapter.revision);
        assert.equal(chapter.body.notes, '采纳已写入后发生的外部备注。');
        assert.equal(chapter.body.generationHistory.length, 1);
        const blocked = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(blocked.body.run.currentStepId, 'adopt');
        assert.equal(blocked.body.authority.projectVersion, external.body.project.version);
        assert.equal(blocked.body.authority.chapterRevision, external.body.chapter.revision);
        assert.equal(blocked.body.artifacts.find(item => item.kind === 'state-change-set').status, 'applied');
        assert.notEqual(blocked.body.artifacts.find(item => item.kind === 'chapter-draft').status, 'applied');
    });
});
