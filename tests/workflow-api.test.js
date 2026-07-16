import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { WorkflowStore } from '../src/workflow-store.js';

const LOCAL_HOST = '127.0.0.1:8123';

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sseResponse(content) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                model: 'workflow-model',
                choices: [{ delta: { content }, finish_reason: 'stop' }],
                usage: { total_tokens: 42 },
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

describe('declarative workflow HTTP lifecycle', () => {
    let dataRoot;
    let app;
    let csrfToken;
    let chapterId;
    let streamCount;
    let fetchImplementation;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-workflow-api-'));
        streamCount = 0;
        fetchImplementation = async (_url, options) => {
            const body = JSON.parse(options.body);
            if (body.stream === true) {
                streamCount += 1;
                return sseResponse(streamCount === 1
                    ? '林照推开赤门，握紧铜钥匙进入地下书库。'
                    : '审校结论：目标、冲突与转折完整，铜钥匙伏笔仍保持开放。');
            }
            const changes = {
                chapterSummary: '林照持铜钥匙进入地下书库。',
                storyStateChanges: {
                    entities: { upsert: [{ id: 'char-lin', kind: 'character', name: '林照' }], delete: [] },
                    relations: { upsert: [], delete: [] },
                    events: { upsert: [{
                        id: 'event-library', title: '进入地下书库', chapterId,
                        entityIds: ['char-lin'], status: 'occurred', order: 1, visibility: 'public',
                    }], delete: [] },
                    promises: { upsert: [{
                        id: 'promise-key', title: '铜钥匙用途', introducedChapterId: chapterId, status: 'open',
                    }], delete: [] },
                    memory: { upsert: [{
                        id: 'memory-library', summary: '林照持铜钥匙进入地下书库。',
                        chapterId, sourceChapterIds: [chapterId],
                    }], delete: [] },
                    facts: { upsert: [{
                        id: 'fact-key', summary: '铜钥匙可以开启地下书库。',
                        subjectEntityId: 'char-lin', sourceChapterId: chapterId,
                    }], delete: [] },
                    knowledge: { upsert: [{
                        id: 'knowledge-key', entityId: 'char-lin', factId: 'fact-key',
                        stance: 'knows', learnedChapterId: chapterId,
                    }], delete: [] },
                    timeline: { upsert: [{
                        id: 'timeline-library', label: '赤门开启', chapterId, sequence: 1,
                    }], delete: [] },
                },
            };
            return jsonResponse({
                model: 'workflow-model',
                choices: [{ message: { content: JSON.stringify(changes) } }],
                usage: { total_tokens: 180 },
            });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        csrfToken = bootstrap.body.csrfToken;
        await write(request(app).put('/api/provider'), csrfToken).send({
            protocol: 'openai-chat',
            baseUrl: 'http://workflow-model.local/v1',
            model: 'workflow-model',
            contextTokens: 32_768,
            maxTokens: 8_192,
            temperature: 0.7,
            topP: 1,
            topK: 0,
            stop: [],
            jsonSchema: true,
        }).expect(200);
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('runs the complete candidate-only chapter cycle with idempotent authoritative commands', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '流程闭环样本',
            genre: '玄幻',
            story: {
                logline: '林照必须用铜钥匙开启地下书库。',
                premise: '每次开门都需要承担可见代价。',
            },
        }).expect(201);
        const projectId = created.body.project.id;
        chapterId = created.body.chapter.id;
        const basePath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}`;

        const definitions = await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200);
        const definition = definitions.body.definitions.find(item => item.id === 'builtin.chapter-cycle.v1');
        assert.equal(definition.steps.length, 11);

        let view = (await write(request(app).post(`${basePath}/workflow-runs`), csrfToken).send({
            commandId: 'start-workflow-lifecycle',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
            input: {},
        }).expect(201)).body;
        assert.equal(view.run.currentStepId, 'diagnose');

        let commandCounter = 0;
        const execute = async (payload = {}, options = {}) => {
            commandCounter += 1;
            const body = {
                commandId: options.commandId ?? `workflow-command-${commandCounter}`,
                runRevision: options.runRevision ?? view.run.revision,
                type: options.type ?? 'execute',
                payload,
            };
            const response = await write(
                request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`),
                csrfToken,
            ).send(body);
            assert.equal(response.status, options.status ?? 200, JSON.stringify(response.body));
            if ((options.status ?? 200) === 200) view = response.body;
            return { response, body };
        };
        const boundArtifact = () => ({
            artifactId: view.currentArtifact.id,
            artifactHash: view.currentArtifact.bindingHash,
        });

        await execute();
        assert.equal(view.run.currentStepId, 'propose-card');
        assert.equal(view.authority.projectVersion, created.body.project.version);
        await execute();
        assert.equal(view.run.currentStepId, 'approve-card');
        await execute(boundArtifact());
        assert.equal(view.run.currentStepId, 'apply-card');
        assert.equal(view.authority.projectVersion, created.body.project.version);

        const applyCommand = {
            commandId: 'apply-card-idempotent',
            runRevision: view.run.revision,
            type: 'execute',
            payload: boundArtifact(),
        };
        const applied = await write(
            request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(applyCommand).expect(200);
        view = applied.body;
        const versionAfterCard = view.authority.projectVersion;
        assert.equal(view.run.currentStepId, 'draft');
        assert.equal(versionAfterCard, created.body.project.version + 1);
        const replayed = await write(
            request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send(applyCommand).expect(200);
        assert.equal(replayed.body.authority.projectVersion, versionAfterCard);
        assert.equal(replayed.body.command.replayed, true);
        await write(
            request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`), csrfToken,
        ).send({ ...applyCommand, payload: { ...applyCommand.payload, stepId: 'different' } }).expect(409);

        app = createApp({ dataRoot, fetchImplementation });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        view = (await request(app)
            .get(`${basePath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200)).body;
        assert.equal(view.run.currentStepId, 'draft');

        await execute();
        assert.equal(view.run.currentStepId, 'distill');
        assert.equal(view.authority.projectVersion, versionAfterCard);
        await execute();
        assert.equal(view.run.currentStepId, 'approve-state');
        assert.equal(view.authority.projectVersion, versionAfterCard);
        await execute(boundArtifact());
        assert.equal(view.run.currentStepId, 'adopt');
        await execute(boundArtifact());
        assert.equal(view.run.currentStepId, 'review');
        assert.equal(view.authority.projectVersion, versionAfterCard + 1);
        const adoptedVersion = view.authority.projectVersion;

        await execute();
        assert.equal(view.run.currentStepId, 'apply-review');
        assert.equal(view.authority.projectVersion, adoptedVersion);
        await execute(boundArtifact());
        assert.equal(view.run.currentStepId, 'closeout');
        assert.equal(view.authority.projectVersion, adoptedVersion + 1);
        await execute();
        assert.equal(view.run.status, 'completed');
        assert.equal(view.run.currentStepId, null);
        assert.equal(view.authority.chapterStatus, 'done');

        const project = await request(app)
            .get(`/api/story-studio/projects/${projectId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const chapter = await request(app).get(basePath).set('Host', LOCAL_HOST).expect(200);
        assert.match(chapter.body.content, /地下书库/);
        assert.match(chapter.body.review, /审校结论/);
        assert.equal(chapter.body.status, 'done');
        assert.equal(project.body.storyState.facts[0].id, 'fact-key');
        assert.equal(project.body.storyState.knowledge[0].factId, 'fact-key');
        assert.equal(project.body.storyState.timeline[0].chapterId, chapterId);

        const versions = await request(app)
            .get(`${basePath}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.ok(versions.body.filter(item => item.source === 'workflow').length >= 3);
        assert.ok(versions.body.some(item => item.source === 'adopt'));
    });

    test('repairs a missing receipt before revision checks and replays the committed command after restart', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '回执崩溃恢复',
            genre: '玄幻',
        }).expect(201);
        const projectId = created.body.project.id;
        chapterId = created.body.chapter.id;
        const basePath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}`;
        const definitions = await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200);
        const definition = definitions.body.definitions.find(item => item.id === 'builtin.chapter-cycle.v1');
        const view = (await write(request(app).post(`${basePath}/workflow-runs`), csrfToken).send({
            commandId: 'start-receipt-crash-recovery',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
            input: {},
        }).expect(201)).body;
        const command = {
            commandId: 'diagnose-receipt-crash',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {},
        };
        const receiptPath = path.join(dataRoot, 'workflows', 'receipts', `${command.commandId}.json`);
        const originalWriteJson = WorkflowStore.prototype.writeJson;
        let injected = false;
        WorkflowStore.prototype.writeJson = function failReceiptOnce(filePath, value) {
            if (!injected && filePath === this.receiptPath(command.commandId)) {
                injected = true;
                throw new Error('simulated receipt publication failure');
            }
            return originalWriteJson.call(this, filePath, value);
        };
        try {
            const failed = await write(
                request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`),
                csrfToken,
            ).send(command);
            assert.equal(failed.status, 500);
        } finally {
            WorkflowStore.prototype.writeJson = originalWriteJson;
        }
        assert.equal(injected, true);
        assert.equal(fs.existsSync(receiptPath), false);

        app = createApp({ dataRoot, fetchImplementation });
        csrfToken = (await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200)).body.csrfToken;
        const persisted = await request(app)
            .get(`${basePath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(persisted.body.run.revision, view.run.revision + 1);
        assert.equal(persisted.body.run.currentStepId, 'propose-card');

        const replayed = await write(
            request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        assert.equal(replayed.body.run.revision, view.run.revision + 1);
        assert.equal(replayed.body.run.currentStepId, 'propose-card');
        assert.equal(replayed.body.command.replayed, true);
        assert.equal(fs.existsSync(receiptPath), true);
    });

    test('keeps Copilot diagnosis and card proposal side-effect free', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken)
            .send({ title: '只读策划', story: { logline: '主角需要离开围城。' } })
            .expect(201);
        const projectId = created.body.project.id;
        chapterId = created.body.chapter.id;
        const basePath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}`;
        const diagnosis = await write(request(app).post(`${basePath}/copilot/diagnose`), csrfToken).send({
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
        }).expect(200);
        assert.ok(diagnosis.body.diagnosisDigest);

        const definition = (await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.definitions[0];
        let view = (await write(request(app).post(`${basePath}/workflow-runs`), csrfToken).send({
            commandId: 'side-effect-free-run',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: created.body.project.version,
            chapterRevision: created.body.chapter.revision,
            input: {},
        }).expect(201)).body;
        for (let index = 0; index < 2; index += 1) {
            view = (await write(
                request(app).post(`${basePath}/workflow-runs/${view.run.id}/commands`), csrfToken,
            ).send({
                commandId: `readonly-command-${index}`,
                runRevision: view.run.revision,
                type: 'execute',
                payload: {},
            }).expect(200)).body;
        }
        assert.equal(view.run.currentStepId, 'approve-card');
        assert.equal(view.authority.projectVersion, created.body.project.version);
        assert.equal(view.authority.chapterRevision, created.body.chapter.revision);
    });
});
