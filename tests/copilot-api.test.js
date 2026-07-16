import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sseResponse(content, model = 'planner-model') {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                model,
                choices: [{ delta: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 },
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function delayedSseResponse(content, model = 'planner-model', delay = 10_000) {
    const encoder = new TextEncoder();
    let timer;
    return new Response(new ReadableStream({
        start(controller) {
            timer = setTimeout(() => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    model,
                    choices: [{ delta: { content }, finish_reason: 'stop' }],
                })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }, delay);
        },
        cancel() {
            clearTimeout(timer);
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function textParser(response, callback) {
    let value = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { value += chunk; });
    response.on('end', () => callback(null, value));
}

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

function direction(id, index, evidenceId) {
    return {
        id,
        title: `方向${index}`,
        commitment: `不可逆分叉${index}`,
        summary: `方向${index}的完整推进。`,
        eventChain: [1, 2, 3].map(order => ({
            order,
            event: `方向${index}事件${order}`,
            characterChoice: `方向${index}选择${order}`,
            directResult: `方向${index}结果${order}`,
            cost: `方向${index}代价${order}`,
        })),
        hook: `方向${index}章尾钩子`,
        risks: [],
        evidenceIds: [evidenceId],
    };
}

describe('independent read-only planning Copilot API', () => {
    let dataRoot;
    let app;
    let csrfToken;
    let providerCalls;
    let providerBodies;
    let modelOutput;
    let slowStream;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-copilot-api-'));
        providerCalls = 0;
        providerBodies = [];
        modelOutput = null;
        slowStream = false;
        const fetchImplementation = async (_url, options) => {
            const body = JSON.parse(options.body);
            providerBodies.push(body);
            if (body.stream === true) {
                providerCalls += 1;
                return slowStream
                    ? delayedSseResponse(JSON.stringify(modelOutput), body.model)
                    : sseResponse(JSON.stringify(modelOutput), body.model);
            }
            return jsonResponse({
                model: body.model,
                choices: [{ message: { content: 'OK' } }],
                usage: { total_tokens: 2 },
            });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        csrfToken = bootstrap.body.csrfToken;
        await write(request(app).put('/api/provider'), csrfToken).send({
            protocol: 'openai-chat',
            baseUrl: 'http://copilot-model.local/v1',
            model: 'writer-model',
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

    test('previews hand-selected evidence and persists an idempotent candidate without touching authority', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '只读策划样本',
            genre: '悬疑',
            story: { world: '旧城门只在白天开启。', premise: '每次开门都要付出代价。' },
        }).expect(201);
        let project = created.body.project;
        let chapter = created.body.chapter;
        const projectId = project.id;
        const volumeId = project.volumes[0].id;

        const chapterUpdate = await write(
            request(app).patch(`/api/story-studio/projects/${projectId}/chapters/${chapter.id}`),
            csrfToken,
        ).send({
            projectVersion: project.version,
            revision: chapter.revision,
            changes: { content: '林照在旧城门前发现月蚀刻痕。' },
        }).expect(200);
        project = chapterUpdate.body.project;
        chapter = chapterUpdate.body.chapter;

        const imported = await write(
            request(app).post(`/api/story-studio/projects/${projectId}/resources/import`),
            csrfToken,
        ).send({
            projectVersion: project.version,
            import: {
                fileName: 'city.json',
                mediaType: 'application/json',
                encoding: 'json',
                data: {
                    name: '旧城世界书',
                    entries: {
                        1: {
                            uid: 'entry-one', key: ['城门'], content: '城门只在白天开启。',
                            disable: false, constant: false, order: 100, position: 0,
                        },
                    },
                },
            },
        }).expect(201);
        project = imported.body.project;
        const lorebook = imported.body.resource;
        const entryId = lorebook.entries[0].id;

        const copilotSettings = await request(app).get('/api/copilot/settings').set('Host', LOCAL_HOST).expect(200);
        const updatedSettings = await write(request(app).put('/api/copilot/settings'), csrfToken).send({
            revision: copilotSettings.body.revision,
            modelMode: 'override',
            model: 'planner-model',
        }).expect(200);
        assert.equal(updatedSettings.body.effective.model, 'planner-model');

        const selection = {
            volumeIds: [volumeId],
            chapterIds: [chapter.id],
            entityIds: [],
            lorebookIds: [lorebook.id],
        };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${projectId}/copilot/context-preview`),
            csrfToken,
        ).send({
            projectVersion: project.version,
            anchorChapterId: chapter.id,
            selection,
            retrieval: { query: '旧城门 月蚀', filters: {}, limit: 20 },
        }).expect(200);
        assert.ok(preview.body.evidenceCatalog.some(item => item.source.type === 'chapter-card'));
        assert.ok(preview.body.evidenceCatalog.some(item => item.source.type === 'lorebook-entry'));
        assert.ok(preview.body.evidenceCatalog.some(item => item.source.type.startsWith('retrieval:')));
        const selectedEvidenceIds = preview.body.evidenceCatalog.map(item => item.evidenceId);
        const citedEvidenceId = selectedEvidenceIds[0];

        modelOutput = {
            schemaVersion: 1,
            plotOptions: [
                direction('option-one', 1, citedEvidenceId),
                direction('option-two', 2, citedEvidenceId),
                direction('option-three', 3, citedEvidenceId),
            ],
            settingEdits: [{
                id: 'setting-one',
                appliesToOptionIds: ['option-one'],
                target: { kind: 'project-story', id: projectId, field: 'world' },
                proposedValue: '旧城门改为只在月蚀时开启。',
                rationale: '让方向一获得不可逆时间窗口。',
                evidenceIds: [citedEvidenceId],
            }],
            lorebookEdits: [{
                id: 'lore-one',
                appliesToOptionIds: ['option-one'],
                operation: 'update',
                lorebookId: lorebook.id,
                entryId,
                patch: {
                    keys: ['城门', '月蚀'],
                    secondaryKeys: null,
                    comment: null,
                    content: '城门只在月蚀时开启。',
                    enabled: null,
                    constant: null,
                },
                rationale: '与候选世界规则保持一致。',
                evidenceIds: [citedEvidenceId],
            }],
        };

        const session = await write(
            request(app).post(`/api/story-studio/projects/${projectId}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'create-copilot-one',
            projectVersion: project.version,
            anchorChapterId: chapter.id,
            selection,
            retrieval: { query: '旧城门 月蚀', filters: {}, limit: 20 },
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds,
            optionCount: 3,
            instruction: '给出三种城门危机走向。',
        }).expect(201);
        assert.equal(session.body.status, 'draft');
        assert.equal(session.body.profile.id, 'builtin.planning-copilot.v1');

        const authorityBefore = await request(app)
            .get(`/api/story-studio/projects/${projectId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const loreBefore = await request(app)
            .get(`/api/story-studio/projects/${projectId}/resources/lorebook/${lorebook.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);

        const generationBody = { commandId: 'generate-copilot-one', sessionRevision: session.body.revision };
        const generated = await write(
            request(app).post(`/api/story-studio/projects/${projectId}/copilot/sessions/${session.body.id}/generate`),
            csrfToken,
        ).send(generationBody).buffer(true).parse(textParser).expect(200);
        const events = generated.body.trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events.map(event => event.type), ['meta', 'delta', 'done']);
        assert.equal(events.at(-1).artifact.status, 'candidate');
        assert.equal(events.at(-1).artifact.plotOptions.length, 3);
        assert.equal(events.at(-1).artifact.changeSet.settingDiffs[0].beforeValue, '旧城门只在白天开启。');
        assert.equal(events.at(-1).artifact.changeSet.lorebookDiffs[0].beforeEntry.content, '城门只在白天开启。');
        assert.equal(providerBodies.find(body => body.stream === true).model, 'planner-model');
        assert.match(
            JSON.stringify(providerBodies.find(body => body.stream === true).messages),
            /untrusted data/,
        );

        const authorityAfter = await request(app)
            .get(`/api/story-studio/projects/${projectId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const loreAfter = await request(app)
            .get(`/api/story-studio/projects/${projectId}/resources/lorebook/${lorebook.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(authorityAfter.body, authorityBefore.body);
        assert.deepEqual(loreAfter.body, loreBefore.body);

        const replay = await write(
            request(app).post(`/api/story-studio/projects/${projectId}/copilot/sessions/${session.body.id}/generate`),
            csrfToken,
        ).send(generationBody).buffer(true).parse(textParser).expect(200);
        const replayEvents = replay.body.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(replayEvents.at(-1).replayed, true);
        assert.equal(providerCalls, 1);

        const listed = await request(app)
            .get(`/api/story-studio/projects/${projectId}/copilot/sessions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(listed.body.sessions[0].status, 'ready');

        await write(
            request(app).post(`/api/story-studio/projects/${projectId}/copilot/sessions/${session.body.id}/apply`),
            csrfToken,
        ).send({}).expect(404);
    });

    test('rejects stale previews and fabricated selected evidence before any Provider call', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '上下文绑定样本',
        }).expect(201);
        const project = created.body.project;
        const selection = { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [] };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/context-preview`),
            csrfToken,
        ).send({ projectVersion: project.version, selection }).expect(200);

        await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'fabricated-evidence',
            projectVersion: project.version,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: ['evidence_ffffffffffffffffffffffffffffffffffffffff'],
            optionCount: 3,
            instruction: '',
        }).expect(400);
        assert.equal(providerCalls, 0);

        await write(request(app).patch(`/api/story-studio/projects/${project.id}`), csrfToken).send({
            version: project.version,
            changes: { genre: '更新后的类型' },
        }).expect(200);
        await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'stale-context',
            projectVersion: project.version,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: [preview.body.evidenceCatalog[0].evidenceId],
            optionCount: 3,
            instruction: '',
        }).expect(409);
        assert.equal(providerCalls, 0);
    });

    test('rejects a new generation attempt after the session authority becomes stale', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '生成基线失效样本',
        }).expect(201);
        const project = created.body.project;
        const selection = { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [] };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/context-preview`),
            csrfToken,
        ).send({ projectVersion: project.version, selection }).expect(200);
        const session = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'create-stale-generation-session',
            projectVersion: project.version,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: [preview.body.evidenceCatalog[0].evidenceId],
            optionCount: 3,
            instruction: '',
        }).expect(201);

        await write(request(app).patch(`/api/story-studio/projects/${project.id}`), csrfToken).send({
            version: project.version,
            changes: { genre: '权威版本已更新' },
        }).expect(200);
        const staleProjection = await request(app)
            .get(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(staleProjection.body.stale, true);

        const rejected = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}/generate`),
            csrfToken,
        ).send({
            commandId: 'generate-after-authority-change',
            sessionRevision: session.body.revision,
        }).expect(409);
        assert.equal(rejected.body.error, 'copilot_context_changed');
        assert.equal(providerCalls, 0);

        const unchanged = await request(app)
            .get(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(unchanged.body.revision, session.body.revision);
        assert.deepEqual(unchanged.body.attempts, []);
        assert.equal(unchanged.body.status, 'draft');
    });

    test('uses a project Prompt Profile V2 without activating it for normal writing', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '独立 Profile 样本',
        }).expect(201);
        let project = created.body.project;
        const imported = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/resources/import`),
            csrfToken,
        ).send({
            projectVersion: project.version,
            import: {
                fileName: 'copilot-profile.json',
                mediaType: 'application/json',
                encoding: 'json',
                data: {
                    name: '项目专用策划 Profile',
                    temperature: 0.4,
                    prompts: [{
                        identifier: 'main',
                        role: 'system',
                        content: '方案必须明确人物选择和不可逆代价。',
                    }],
                },
            },
        }).expect(201);
        project = imported.body.project;
        const profile = imported.body.resource;
        assert.equal(profile.profileVersion, 2);
        assert.equal(project.resources.activePromptProfileId, null);
        const selection = { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [] };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/context-preview`),
            csrfToken,
        ).send({ projectVersion: project.version, selection }).expect(200);
        const session = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'project-profile-session',
            projectVersion: project.version,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: [preview.body.evidenceCatalog[0].evidenceId],
            profileRef: { source: 'project', id: profile.id, revision: profile.revision },
            optionCount: 3,
            instruction: '设计三个方向。',
        }).expect(201);
        assert.equal(session.body.profile.id, profile.id);
        assert.equal(session.body.profile.revision, profile.revision);
        const authority = await request(app)
            .get(`/api/story-studio/projects/${project.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(authority.body.resources.activePromptProfileId, null);
        assert.equal(providerCalls, 0);
    });

    test('cancels an in-flight Provider call while preserving a cancelled audit attempt', async () => {
        const created = await write(request(app).post('/api/story-studio/projects'), csrfToken).send({
            title: '取消样本',
        }).expect(201);
        const project = created.body.project;
        const selection = { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [] };
        const preview = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/context-preview`),
            csrfToken,
        ).send({ projectVersion: project.version, selection }).expect(200);
        const evidenceId = preview.body.evidenceCatalog[0].evidenceId;
        modelOutput = {
            schemaVersion: 1,
            plotOptions: [
                direction('option-one', 1, evidenceId),
                direction('option-two', 2, evidenceId),
                direction('option-three', 3, evidenceId),
            ],
            settingEdits: [],
            lorebookEdits: [],
        };
        const session = await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions`),
            csrfToken,
        ).send({
            commandId: 'create-cancel-session',
            projectVersion: project.version,
            selection,
            contextDigest: preview.body.contextDigest,
            selectedEvidenceIds: [evidenceId],
            optionCount: 3,
            instruction: '生成后等待取消。',
        }).expect(201);
        slowStream = true;
        const generationPromise = Promise.resolve(write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}/generate`),
            csrfToken,
        ).send({ commandId: 'generate-cancel-session', sessionRevision: session.body.revision })
            .buffer(true).parse(textParser));

        let running;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            running = await request(app)
                .get(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}`)
                .set('Host', LOCAL_HOST);
            if (running.body.status === 'generating') break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(running.body.status, 'generating');
        await write(
            request(app).post(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}/cancel`),
            csrfToken,
        ).send({ commandId: 'cancel-session', sessionRevision: running.body.revision }).expect(202);

        const generated = await generationPromise;
        assert.equal(generated.status, 200);
        const events = generated.body.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events[0].type, 'meta');
        assert.equal(events.at(-1).type, 'error');

        const cancelled = await request(app)
            .get(`/api/story-studio/projects/${project.id}/copilot/sessions/${session.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(cancelled.body.status, 'cancelled');
        assert.equal(cancelled.body.attempts[0].status, 'cancelled');
        assert.equal(providerCalls, 1);
    });
});
