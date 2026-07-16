import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';
const roots = new Set();

function dataRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-retrieval-router-'));
    roots.add(root);
    return root;
}

async function bootstrap(app) {
    const response = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
    return response.body.csrfToken;
}

async function createProject(app, csrfToken, title) {
    const response = await request(app)
        .post('/api/story-studio/projects')
        .set('Host', LOCAL_HOST)
        .set('X-CSRF-Token', csrfToken)
        .send({ title })
        .expect(201);
    return response.body;
}

function write(requestBuilder, csrfToken) {
    return requestBuilder
        .set('Host', LOCAL_HOST)
        .set('X-CSRF-Token', csrfToken);
}

afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.clear();
});

describe('retrieval router safety boundaries', () => {
    test('rejects malformed standalone preview and rebuild envelopes without coercion', async () => {
        const app = createApp({ dataRoot: dataRoot() });
        const csrfToken = await bootstrap(app);
        const { project } = await createProject(app, csrfToken, '检索输入边界');
        const previewPath = `/api/story-studio/projects/${project.id}/retrieval/preview`;
        const rebuildPath = `/api/story-studio/projects/${project.id}/retrieval/rebuild`;

        await write(request(app).post(previewPath), csrfToken)
            .send([])
            .expect(400, {
                error: 'invalid_request',
                message: 'Retrieval preview must be a JSON object.',
            });

        await write(request(app).post(previewPath), csrfToken)
            .send({ query: '铜钥匙', unexpected: true })
            .expect(400, {
                error: 'unknown_fields',
                message: 'Retrieval preview contains unknown fields.',
                fields: ['unexpected'],
            });

        await write(request(app).post(rebuildPath), csrfToken)
            .send([])
            .expect(400, {
                error: 'invalid_request',
                message: 'Retrieval rebuild must be a JSON object.',
            });

        await write(request(app).post(rebuildPath), csrfToken)
            .send({ projectVersion: project.version, unexpected: true })
            .expect(400, {
                error: 'unknown_fields',
                message: 'Retrieval rebuild contains unknown fields.',
                fields: ['unexpected'],
            });

        await write(request(app).post(rebuildPath), csrfToken)
            .send({ projectVersion: project.version, async: 'true' })
            .expect(400, {
                error: 'invalid_retrieval_async',
                message: 'async must be a boolean.',
            });

        const synchronous = await write(request(app).post(rebuildPath), csrfToken)
            .send({ projectVersion: project.version, mode: 'incremental', async: false })
            .expect(200);
        assert.equal(synchronous.body.projectId, project.id);
        assert.equal(synchronous.body.mode, 'incremental');
    });

    test('binds rebuild job lookup to the project in the URL', async () => {
        const app = createApp({ dataRoot: dataRoot() });
        const csrfToken = await bootstrap(app);
        const first = await createProject(app, csrfToken, '任务所属项目');
        const second = await createProject(app, csrfToken, '其他项目');

        const queued = await write(
            request(app).post(`/api/story-studio/projects/${first.project.id}/retrieval/rebuild`),
            csrfToken,
        )
            .send({ projectVersion: first.project.version, mode: 'full', async: true })
            .expect(202);

        await request(app)
            .get(`/api/story-studio/projects/${second.project.id}/retrieval/rebuild/${queued.body.jobId}`)
            .set('Host', LOCAL_HOST)
            .expect(404, { error: 'not_found', message: 'Resource not found.' });

        let owned;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            owned = await request(app)
                .get(`/api/story-studio/projects/${first.project.id}/retrieval/rebuild/${queued.body.jobId}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            if (!['queued', 'running'].includes(owned.body.status)) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(owned.body.projectId, first.project.id);
        assert.equal(owned.body.jobId, queued.body.jobId);
        assert.equal(owned.body.status, 'completed');
    });

    test('provider rerank cannot fabricate or restore excluded ids and preserves manual inclusion priority', async () => {
        let providerIds = [];
        let providerCalls = 0;
        const app = createApp({
            dataRoot: dataRoot(),
            fetchImplementation: async () => {
                providerCalls += 1;
                return new Response(JSON.stringify({
                    model: 'reranker-test',
                    choices: [{ message: { content: JSON.stringify({ ids: providerIds }) } }],
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            },
        });
        const csrfToken = await bootstrap(app);
        await write(request(app).put('/api/provider'), csrfToken)
            .send({
                protocol: 'openai-chat',
                baseUrl: 'http://reranker.test/v1',
                model: 'reranker-test',
                temperature: 0.7,
                topP: 1,
                topK: 0,
                stop: [],
                contextTokens: 32_768,
                maxTokens: 8_192,
                jsonSchema: true,
            })
            .expect(200);

        let { project, chapter } = await createProject(app, csrfToken, '重排安全');
        const saved = await write(
            request(app).patch(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`),
            csrfToken,
        )
            .send({
                projectVersion: project.version,
                revision: chapter.revision,
                changes: {
                    content: '铜钥匙。'.repeat(700),
                    card: { summary: '铜钥匙能开启地下书库。' },
                },
            })
            .expect(200);
        ({ project, chapter } = saved.body);
        const previewPath = `/api/story-studio/projects/${project.id}/retrieval/preview`;
        const deterministic = await write(request(app).post(previewPath), csrfToken)
            .send({ projectVersion: project.version, query: '铜钥匙', limit: 20 })
            .expect(200);
        assert.ok(deterministic.body.hits.length >= 3);

        const manualId = deterministic.body.hits[0].id;
        const excludedId = deterministic.body.hits[1].id;
        const reorderId = deterministic.body.hits.at(-1).id;
        providerIds = ['fabricated-id', excludedId, reorderId, manualId];

        const reranked = await write(request(app).post(previewPath), csrfToken)
            .send({
                projectVersion: project.version,
                query: '铜钥匙',
                limit: 20,
                manualInclude: [manualId],
                manualExclude: [excludedId],
                rerank: true,
            })
            .expect(200);
        const resultIds = reranked.body.hits.map(hit => hit.id);
        assert.equal(providerCalls, 1);
        assert.equal(reranked.body.diagnostics.rerank, 'provider');
        assert.equal(resultIds[0], manualId);
        assert.equal(resultIds.includes(excludedId), false);
        assert.equal(resultIds.includes('fabricated-id'), false);
        assert.equal(resultIds.includes(reorderId), true);
    });
});
