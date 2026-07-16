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

function sseResponse(records) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const record of records) controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function textParser(response, callback) {
    let value = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { value += chunk; });
    response.on('end', () => callback(null, value));
}

describe('generation, distillation, and atomic adoption API', () => {
    let dataRoot;
    let app;
    let csrfToken;
    let chapterId;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-generation-api-'));
        const fetchImplementation = async (_url, options) => {
            const body = JSON.parse(options.body);
            if (body.stream === true) {
                return sseResponse([
                    { model: 'novel-model', choices: [{ delta: { content: '林照推开城门，' }, finish_reason: null }] },
                    { model: 'novel-model', choices: [{ delta: { content: '铜钥匙仍在他手里。' }, finish_reason: 'stop' }], usage: { total_tokens: 42 } },
                ]);
            }
            const changes = {
                chapterSummary: '林照入城并保留铜钥匙。',
                storyStateChanges: {
                    entities: {
                        upsert: [{ id: 'char-lin', kind: 'character', name: '林照', summary: '已经进入城内。', aliases: [], status: 'active' }],
                        delete: [],
                    },
                    relations: { upsert: [], delete: [] },
                    events: {
                        upsert: [{
                            id: 'event-enter-city', kind: 'story', title: '进入城门', summary: '林照进入城内。',
                            chapterId, entityIds: ['char-lin'], status: 'occurred', order: 1,
                        }],
                        delete: [],
                    },
                    promises: {
                        upsert: [{
                            id: 'promise-key', title: '铜钥匙用途', summary: '钥匙用途尚未揭示。',
                            introducedChapterId: chapterId, dueChapterId: null, resolvedChapterId: null, status: 'open',
                        }],
                        delete: [],
                    },
                    memory: {
                        upsert: [{
                            id: 'memory-chapter-one', kind: 'chapter', summary: '林照携钥匙入城。',
                            chapterId, importance: 4, tags: ['入城'],
                        }],
                        delete: [],
                    },
                },
            };
            return jsonResponse({
                model: 'novel-model',
                choices: [{ message: { content: JSON.stringify(changes) } }],
                usage: { total_tokens: 180 },
            });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        csrfToken = bootstrap.body.csrfToken;
        await request(app)
            .put('/api/provider')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                protocol: 'openai-chat', baseUrl: 'http://model.local/v1', model: 'novel-model',
                contextTokens: 32_768, maxTokens: 8_192, temperature: 0.7, topP: 1, topK: 0, stop: [], jsonSchema: true,
            })
            .expect(200);
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('runs the full preview -> stream -> distill -> adopt flow', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '闭环样本', genre: '玄幻', story: { premise: '主角必须入城。' } })
            .expect(201);
        const projectId = created.body.project.id;
        chapterId = created.body.chapter.id;

        const preview = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft', mode: 'generate', projectVersion: created.body.project.version,
                chapterRevision: created.body.chapter.revision, instruction: '正文必须出现铜钥匙。',
            })
            .expect(200);
        assert.match(preview.body.prompt, /铜钥匙/);
        assert.equal(preview.body.diagnostics.contextTokens, 32_768);
        assert.ok(preview.body.diagnostics.promptDigest);

        const streamed = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/stream`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft', mode: 'generate', projectVersion: created.body.project.version,
                chapterRevision: created.body.chapter.revision, instruction: '正文必须出现铜钥匙。',
            })
            .buffer(true)
            .parse(textParser)
            .expect(200);
        const events = streamed.body.trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events.map(event => event.type), ['meta', 'delta', 'delta', 'done']);
        const generationId = events[0].generationId;
        assert.equal(events.at(-1).generation.content, '林照推开城门，铜钥匙仍在他手里。');

        const history = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(history.body.length, 1);
        assert.equal(history.body[0].id, generationId);

        const distilled = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/${generationId}/distill`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: created.body.project.version, chapterRevision: created.body.chapter.revision })
            .expect(200);
        assert.equal(distilled.body.generation.distillation.status, 'ready');
        assert.equal(distilled.body.changes.storyStateChanges.events.upsert[0].id, 'event-enter-city');

        const adopted = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/${generationId}/adopt`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: created.body.project.version,
                chapterRevision: created.body.chapter.revision,
                includeContent: true,
                contentMode: 'replace',
            })
            .expect(200);
        assert.equal(adopted.body.chapter.content, '林照推开城门，铜钥匙仍在他手里。');
        assert.equal(adopted.body.chapter.card.summary, '林照入城并保留铜钥匙。');
        assert.equal(adopted.body.project.storyState.entities[0].id, 'char-lin');
        assert.equal(adopted.body.project.storyState.events[0].chapterId, chapterId);
        assert.equal(adopted.body.project.storyState.promises[0].status, 'open');
        assert.equal(adopted.body.generation.status, 'adopted');
        assert.equal(adopted.body.chapter.generationHistory[0].generationId, generationId);

        const versions = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(versions.body.length, 2);
        assert.equal(versions.body[0].versionId, 'current');
        assert.equal(versions.body[0].chapterRevision, adopted.body.chapter.revision);
        assert.equal(versions.body[1].source, 'adopt');
        const beforeAdoption = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/versions/${versions.body[1].versionId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(beforeAdoption.body.content, '');

        const generationPath = path.join(
            dataRoot,
            'generation-history',
            projectId,
            chapterId,
            `${generationId}.json`,
        );
        const unmarked = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
        unmarked.status = 'completed';
        unmarked.adoptedAt = null;
        fs.writeFileSync(generationPath, JSON.stringify(unmarked, null, 2), 'utf8');
        const retriedAdoption = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/${generationId}/adopt`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: adopted.body.project.version,
                chapterRevision: adopted.body.chapter.revision,
                includeContent: true,
                contentMode: 'replace',
            })
            .expect(200);
        assert.equal(retriedAdoption.body.idempotent, true);
        assert.equal(retriedAdoption.body.project.version, adopted.body.project.version);
        assert.equal(retriedAdoption.body.chapter.revision, adopted.body.chapter.revision);
        assert.equal(retriedAdoption.body.generation.status, 'adopted');

        const nextPreview = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft',
                mode: 'generate',
                projectVersion: adopted.body.project.version,
                chapterRevision: adopted.body.chapter.revision,
            })
            .expect(200);
        assert.match(nextPreview.body.prompt, /event-enter-city/);
        assert.match(nextPreview.body.prompt, /promise-key/);
        assert.ok(nextPreview.body.diagnostics.storyContext.items.some(item => item.id === 'char-lin'));
    });

    test('refuses to replace newer formal text with a candidate generated from an older revision', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '过期候选' })
            .expect(201);
        const projectId = created.body.project.id;
        chapterId = created.body.chapter.id;
        const streamed = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/stream`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft', mode: 'generate', projectVersion: created.body.project.version,
                chapterRevision: created.body.chapter.revision,
            })
            .buffer(true)
            .parse(textParser)
            .expect(200);
        const generationId = streamed.body.trim().split('\n').map(line => JSON.parse(line))[0].generationId;
        const edited = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: created.body.project.version,
                revision: created.body.chapter.revision,
                changes: { content: '作者在生成后写下的新正文。' },
            })
            .expect(200);
        const rejected = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generations/${generationId}/adopt`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: edited.body.project.version,
                chapterRevision: edited.body.chapter.revision,
                includeContent: true,
                contentMode: 'replace',
            })
            .expect(409);
        assert.equal(rejected.body.error, 'candidate_stale');
        const formal = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(formal.body.content, '作者在生成后写下的新正文。');
        assert.deepEqual(formal.body.generationHistory, []);
    });
});
