import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createStoragePathGuard } from '../src/api-error.js';
import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';
let dataRoot;
let app;

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function csrfFor(target = app) {
    const response = await request(target).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
    assert.equal(typeof response.body.csrfToken, 'string');
    return response.body.csrfToken;
}

async function putProvider(target, csrfToken, body) {
    return await request(target)
        .put('/api/provider')
        .set('Host', LOCAL_HOST)
        .set('X-CSRF-Token', csrfToken)
        .send(body);
}

beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-api-'));
    app = createApp({ dataRoot });
});

afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('local HTTP security and Story Studio API', () => {
    test('accepts a normal Windows directory addressed by an NTFS 8.3 alias', {
        skip: process.platform !== 'win32',
    }, context => {
        const longRoot = fs.mkdtempSync(path.join(
            os.tmpdir(),
            'story-studio-long-directory-for-short-name-',
        ));
        try {
            assert.equal(longRoot.includes('"'), false);
            const result = spawnSync(
                process.env.ComSpec || 'cmd.exe',
                ['/d', '/s', '/c', `for %I in ("${longRoot}") do @echo %~sI`],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                    windowsVerbatimArguments: true,
                },
            );
            assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
            const shortRoot = result.stdout.trim();
            assert.ok(shortRoot);
            if (shortRoot.toLowerCase() === longRoot.toLowerCase()) {
                context.skip('NTFS 8.3 aliases are unavailable on this volume.');
                return;
            }

            assert.equal(fs.lstatSync(shortRoot).isSymbolicLink(), false);
            assert.equal(
                fs.realpathSync.native(shortRoot).toLowerCase(),
                fs.realpathSync.native(longRoot).toLowerCase(),
            );
            const storageRoot = path.join(shortRoot, 'data');
            const guard = createStoragePathGuard(storageRoot, {
                label: 'Test',
                createError: (message, details) => Object.assign(new Error(message), { details }),
            });

            assert.equal(guard.rootDirectory, path.resolve(storageRoot));
            assert.equal(fs.statSync(path.join(longRoot, 'data')).isDirectory(), true);
        } finally {
            fs.rmSync(longRoot, { recursive: true, force: true });
        }
    });

    test('rejects a Windows reparse point even when lstat reports its target identity', {
        skip: process.platform !== 'win32',
    }, () => {
        const container = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-followed-reparse-'));
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-followed-reparse-target-'));
        const linkedParent = path.join(container, 'linked-parent');
        fs.symlinkSync(target, linkedParent, 'junction');
        const originalLstatSync = fs.lstatSync;
        try {
            fs.lstatSync = (candidatePath, options) => (
                path.resolve(candidatePath).toLowerCase() === path.resolve(linkedParent).toLowerCase()
                    ? fs.statSync(candidatePath, options)
                    : originalLstatSync(candidatePath, options)
            );
            assert.throws(
                () => createStoragePathGuard(path.join(linkedParent, 'data'), {
                    label: 'Test',
                    createError: (message, details) => Object.assign(new Error(message), { details }),
                }),
                error => (
                    error?.message === 'Test root cannot traverse reparse points.'
                    && error?.details?.path === linkedParent
                ),
            );
        } finally {
            fs.lstatSync = originalLstatSync;
            try {
                fs.unlinkSync(linkedParent);
            } catch {
                // Preserve the original assertion if setup did not reach link creation.
            }
            fs.rmSync(container, { recursive: true, force: true });
            fs.rmSync(target, { recursive: true, force: true });
        }
    });

    test('rejects a missing data root below an existing linked ancestor', () => {
        const container = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-linked-data-parent-'));
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-linked-data-parent-target-'));
        const linkedParent = path.join(container, 'linked-parent');
        const dataRoot = path.join(linkedParent, 'data');
        fs.writeFileSync(path.join(external, 'marker.txt'), 'unchanged', 'utf8');
        fs.symlinkSync(
            external,
            linkedParent,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        try {
            assert.throws(
                () => createApp({ dataRoot }),
                error => error?.status === 500 && error?.code === 'unsafe_provider_path',
            );
            assert.deepEqual(fs.readdirSync(external), ['marker.txt']);
        } finally {
            try {
                fs.unlinkSync(linkedParent);
            } catch {
                // Preserve the original assertion if setup did not reach link creation.
            }
            fs.rmSync(container, { recursive: true, force: true });
            fs.rmSync(external, { recursive: true, force: true });
        }
    });

    test('rejects a linked top-level data root before child stores touch its target', () => {
        const container = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-linked-data-root-'));
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-linked-data-target-'));
        const linkedDataRoot = path.join(container, 'data');
        fs.writeFileSync(path.join(external, 'marker.txt'), 'unchanged', 'utf8');
        fs.symlinkSync(
            external,
            linkedDataRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        try {
            assert.throws(
                () => createApp({ dataRoot: linkedDataRoot }),
                error => error?.status === 500 && error?.code === 'unsafe_provider_path',
            );
            assert.deepEqual(fs.readdirSync(external), ['marker.txt']);
        } finally {
            try {
                fs.unlinkSync(linkedDataRoot);
            } catch {
                // Preserve the original assertion if setup did not reach link creation.
            }
            fs.rmSync(container, { recursive: true, force: true });
            fs.rmSync(external, { recursive: true, force: true });
        }
    });

    test('bootstrap returns a process CSRF token and hardened headers', async () => {
        const response = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        assert.equal(response.body.name, 'Story Studio');
        assert.match(response.body.version, /^\d+\.\d+\.\d+/);
        assert.match(response.body.csrfToken, /^[a-zA-Z0-9_-]{40,}$/);
        assert.match(response.headers['content-security-policy'], /default-src 'self'/);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['x-powered-by'], undefined);
    });

    test('rejects non-local Host and Origin independently', async () => {
        await request(app).get('/api/bootstrap').set('Host', 'attacker.example').expect(403, {
            error: 'invalid_host',
            message: 'Story Studio only accepts local Host headers.',
        });
        await request(app)
            .get('/api/bootstrap')
            .set('Host', LOCAL_HOST)
            .set('Origin', 'https://attacker.example')
            .expect(403, { error: 'invalid_origin', message: 'Story Studio only accepts local browser origins.' });
        await request(app)
            .get('/api/bootstrap')
            .set('Host', 'localhost:8123')
            .set('Origin', 'http://localhost:8123')
            .expect(200);
    });

    test('requires JSON and a valid CSRF token for every API write', async () => {
        const csrfToken = await csrfFor();
        await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('Content-Type', 'application/json')
            .send('{}')
            .expect(403, { error: 'csrf_failed', message: 'The CSRF token is missing or invalid.' });
        await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .set('Content-Type', 'text/plain')
            .send('{}')
            .expect(415, { error: 'unsupported_media_type', message: 'API writes require application/json.' });
    });

    test('creates, edits, reloads, and conflicts on a UTF-8 chapter', async () => {
        const csrfToken = await csrfFor();
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '中文联调', genre: '都市异能' })
            .expect(201);
        const { project, chapter } = created.body;
        assert.equal(project.title, '中文联调');

        const saved = await request(app)
            .patch(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                revision: chapter.revision,
                changes: { title: '雨夜入城', content: '雨落长街。守门人抬起了头。' },
            })
            .expect(200);
        assert.equal(saved.body.chapter.wordCount, 11);
        assert.equal(saved.body.project.version, 2);

        const reloaded = await request(app)
            .get(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(reloaded.body.content, '雨落长街。守门人抬起了头。');

        const conflict = await request(app)
            .patch(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: 2, revision: 1, changes: { content: '旧稿' } })
            .expect(409);
        assert.equal(conflict.body.error, 'chapter_conflict');
        assert.equal(conflict.body.currentRevision, 2);
        assert.equal(conflict.body.currentProjectVersion, 2);
    });

    test('returns one coherent read-only project and chapter authority snapshot', async () => {
        const csrfToken = await csrfFor();
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '权威快照' })
            .expect(201);
        const saved = await request(app)
            .patch(`/api/story-studio/projects/${created.body.project.id}/chapters/${created.body.chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: created.body.project.version,
                revision: created.body.chapter.revision,
                changes: { title: '同步章名', content: '同步后的正文。' },
            })
            .expect(200);

        const snapshot = await request(app)
            .get(`/api/story-studio/projects/${created.body.project.id}/chapters/${created.body.chapter.id}/authority`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(snapshot.body.project.version, saved.body.project.version);
        assert.equal(snapshot.body.chapter.revision, saved.body.chapter.revision);
        assert.equal(snapshot.body.chapter.title, '同步章名');
        assert.deepEqual(
            snapshot.body.project.chapters.find(item => item.id === snapshot.body.chapter.id),
            saved.body.project.chapters.find(item => item.id === saved.body.chapter.id),
        );
    });

    test('roundtrips a project through the export and import routes', async () => {
        const csrfToken = await csrfFor();
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '往返作品', story: { premise: '旧城即将封闭。' } })
            .expect(201);
        const exported = await request(app)
            .get(`/api/story-studio/projects/${created.body.project.id}/export`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(exported.body.format, 'sillytavern-story-studio');
        const imported = await request(app)
            .post('/api/story-studio/projects/import')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send(exported.body)
            .expect(201);
        assert.notEqual(imported.body.project.id, created.body.project.id);
        assert.equal(imported.body.project.story.premise, '旧城即将封闭。');
        const projects = await request(app).get('/api/story-studio/projects').set('Host', LOCAL_HOST).expect(200);
        assert.equal(projects.body.length, 2);
    });

    test('keeps the 100 MiB import parser ahead of the 12 MiB general parser', async () => {
        const csrfToken = await csrfFor();
        const padding = 'x'.repeat(13 * 1024 * 1024);
        const importResponse = await request(app)
            .post('/api/story-studio/projects/import')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ format: 'sillytavern-story-studio', schemaVersion: 1, project: {}, chapters: [], padding });
        assert.equal(importResponse.status, 400);
        assert.equal(importResponse.body.error, 'unknown_fields');

        const generalResponse = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: padding });
        assert.equal(generalResponse.status, 413);
        assert.equal(generalResponse.body.error, 'payload_too_large');
    });

    test('returns stable JSON for malformed bodies and missing API routes', async () => {
        const csrfToken = await csrfFor();
        await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .set('Content-Type', 'application/json')
            .send('{broken')
            .expect(400, { error: 'invalid_json', message: 'The request body is not valid JSON.' });
        await request(app)
            .get('/api/does-not-exist')
            .set('Host', LOCAL_HOST)
            .expect(404, { error: 'not_found', message: 'API endpoint not found.' });
    });

    test('serves Lucide SVGs from the installed package', async () => {
        const response = await request(app).get('/icons/pen-line.svg').set('Host', LOCAL_HOST).expect(200);
        assert.match(response.headers['content-type'], /image\/svg\+xml/);
        assert.match(Buffer.from(response.body).toString('utf8'), /<svg/);
    });
});

describe('provider settings and OpenAI-compatible generation', () => {
    test('stores secrets separately, masks GET, preserves omission, and clears with null', async () => {
        const csrfToken = await csrfFor();
        const saved = await putProvider(app, csrfToken, {
            baseUrl: 'https://models.example/v1/',
            model: 'writer-model',
            apiKey: 'sk-secret-7890',
            temperature: 0.5,
            contextTokens: 65_536,
            maxTokens: 12_000,
            jsonSchema: true,
        });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.hasApiKey, true);
        assert.equal(saved.body.maskedApiKey, '****7890');
        assert.equal('apiKey' in saved.body, false);

        const configText = fs.readFileSync(path.join(dataRoot, 'provider.json'), 'utf8');
        const secretsText = fs.readFileSync(path.join(dataRoot, 'secrets.json'), 'utf8');
        assert.equal(configText.includes('sk-secret-7890'), false);
        assert.equal(secretsText.includes('sk-secret-7890'), true);

        const preserved = await putProvider(app, csrfToken, { model: 'writer-model-v2' });
        assert.equal(preserved.body.hasApiKey, true);
        const sameOrigin = await putProvider(app, csrfToken, { baseUrl: 'https://models.example/v2' });
        assert.equal(sameOrigin.body.hasApiKey, true);
        const changedOrigin = await putProvider(app, csrfToken, { baseUrl: 'https://other-models.example/v1' });
        assert.equal(changedOrigin.body.hasApiKey, false);
        const replaced = await putProvider(app, csrfToken, { apiKey: 'replacement-key' });
        assert.equal(replaced.body.hasApiKey, true);
        const cleared = await putProvider(app, csrfToken, { apiKey: null });
        assert.equal(cleared.body.hasApiKey, false);
        assert.equal(cleared.body.maskedApiKey, '');
    });

    test('validates separate context/output limits and reports a capped budget', async () => {
        const csrfToken = await csrfFor();
        const invalidContext = await putProvider(app, csrfToken, { contextTokens: 1_024 });
        assert.equal(invalidContext.status, 400);
        assert.equal(invalidContext.body.error, 'invalid_provider_settings');
        const invalidOutput = await putProvider(app, csrfToken, { maxTokens: 128 });
        assert.equal(invalidOutput.status, 400);
        assert.equal(invalidOutput.body.error, 'invalid_provider_settings');

        await putProvider(app, csrfToken, { model: 'budget-model', maxTokens: 8_192 });
        const response = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: 'test', responseLength: 20_000, minimumResponseLength: 9_000 })
            .expect(400);
        assert.equal(response.body.error, 'generation_budget_too_small');
        assert.equal(response.body.minimumResponseLength, 9_000);
        assert.equal(response.body.maximumOutputTokens, 8_192);
    });

    test('scopes a saved API key to its provider origin during connection tests', async () => {
        const calls = [];
        const fetchImplementation = async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/messages')) {
                return jsonResponse({ model: 'preview-model', content: [{ type: 'text', text: 'OK' }] });
            }
            return jsonResponse({ model: 'preview-model', choices: [{ message: { content: 'OK' } }] });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, {
            baseUrl: 'http://preview.local/v1',
            model: 'saved-model',
            apiKey: 'saved-key',
        }).then(response => assert.equal(response.status, 200));

        const sameOrigin = await request(app)
            .post('/api/provider/test')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ baseUrl: 'http://preview.local/v2', model: 'preview-model' })
            .expect(200);
        assert.deepEqual(sameOrigin.body, { ok: true, message: 'Provider connection succeeded.', model: 'preview-model' });
        assert.equal(calls[0].url, 'http://preview.local/v2/chat/completions');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer saved-key');

        await request(app)
            .post('/api/provider/test')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ baseUrl: 'http://other-preview.local/v1', model: 'preview-model' })
            .expect(200);
        assert.equal(calls[1].url, 'http://other-preview.local/v1/chat/completions');
        assert.equal(calls[1].options.headers.Authorization, undefined);

        await request(app)
            .post('/api/provider/test')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                protocol: 'anthropic-messages',
                baseUrl: 'http://preview.local/v2',
                model: 'preview-model',
            })
            .expect(200);
        assert.equal(calls[2].url, 'http://preview.local/v2/messages');
        assert.equal(calls[2].options.headers['x-api-key'], undefined);

        const persisted = await request(app).get('/api/provider').set('Host', LOCAL_HOST).expect(200);
        assert.equal(persisted.body.model, 'saved-model');
        assert.equal(persisted.body.hasApiKey, true);
    });

    test('uses a high safety boundary instead of limiting model context to 8000 characters', async () => {
        let calls = 0;
        const fetchImplementation = async () => {
            calls += 1;
            return jsonResponse({ model: 'boundary-model', choices: [{ message: { content: 'OK' } }] });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, { model: 'boundary-model' }).then(response => assert.equal(response.status, 200));

        await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: 'x'.repeat(1_000_000), responseLength: 256 })
            .expect(200);
        assert.equal(calls, 1);

        const rejected = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: 'x'.repeat(1_000_001), responseLength: 256 })
            .expect(413);
        assert.equal(rejected.body.error, 'payload_too_large');
        assert.equal(rejected.body.field, 'prompt');
        assert.equal(rejected.body.maximum, 1_000_000);
        assert.equal(calls, 1);
    });

    test('maps system/user messages, token limits, schema, and usage', async () => {
        let outbound;
        const fetchImplementation = async (url, options) => {
            outbound = { url, options, body: JSON.parse(options.body) };
            return jsonResponse({
                model: 'writer-model-2026',
                choices: [{ message: { content: '{"goal":"入城"}' } }],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, {
            baseUrl: 'https://models.example/v1',
            model: 'writer-model',
            apiKey: 'server-only-key',
            contextTokens: 32_768,
            maxTokens: 8_192,
            jsonSchema: true,
        }).then(response => assert.equal(response.status, 200));

        const generated = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                systemPrompt: '你是网文规划助手。',
                prompt: '规划下一章。',
                responseLength: 20_000,
                minimumResponseLength: 512,
                jsonSchema: {
                    name: 'chapter_plan',
                    description: 'Chapter execution card',
                    strict: true,
                    value: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
                },
            })
            .expect(200);

        assert.equal(generated.body.content, '{"goal":"入城"}');
        assert.equal(generated.body.model, 'writer-model-2026');
        assert.equal(generated.body.usage.total_tokens, 20);
        assert.equal(outbound.url, 'https://models.example/v1/chat/completions');
        assert.deepEqual(outbound.body.messages, [
            { role: 'system', content: '你是网文规划助手。' },
            { role: 'user', content: '规划下一章。' },
        ]);
        assert.equal(outbound.body.max_tokens, 8_192);
        assert.deepEqual(outbound.body.response_format, {
            type: 'json_schema',
            json_schema: {
                name: 'chapter_plan',
                description: 'Chapter execution card',
                strict: true,
                schema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
            },
        });
        assert.equal(outbound.options.headers.Authorization, 'Bearer server-only-key');
    });

    test('falls back only for explicit schema and max_tokens incompatibilities', async () => {
        const bodies = [];
        const fetchImplementation = async (_url, options) => {
            const body = JSON.parse(options.body);
            bodies.push(body);
            if (bodies.length === 1) return jsonResponse({ error: { message: 'response_format json_schema is unsupported' } }, 400);
            if (bodies.length === 2) return jsonResponse({ error: { message: 'unknown max_tokens; use max_completion_tokens' } }, 400);
            return jsonResponse({ model: 'compat-model', choices: [{ message: { content: '{}' } }] });
        };
        app = createApp({ dataRoot, fetchImplementation });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, { baseUrl: 'http://compat.local/v1', model: 'compat-model' });
        const response = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: 'Return JSON.', responseSchema: { type: 'object' }, responseLength: 512 })
            .expect(200);
        assert.equal(response.body.content, '{}');
        assert.equal(bodies.length, 3);
        assert.ok(bodies[0].response_format);
        assert.equal('response_format' in bodies[1], false);
        assert.equal(bodies[1].max_tokens, 512);
        assert.equal(bodies[2].max_completion_tokens, 512);
        assert.equal('max_tokens' in bodies[2], false);
    });

    test('does not retry authentication failures and returns stable provider errors', async () => {
        let calls = 0;
        const fetchImplementation = async () => {
            calls += 1;
            return jsonResponse({ error: { message: 'Invalid API key' } }, 401);
        };
        app = createApp({ dataRoot, fetchImplementation });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, { baseUrl: 'https://models.example/v1', model: 'writer-model' });
        const response = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: '写一段正文。' })
            .expect(502);
        assert.equal(response.body.error, 'provider_http_error');
        assert.equal(response.body.message, 'Invalid API key');
        assert.equal(response.body.upstreamStatus, 401);
        assert.equal(calls, 1);
    });

    test('redacts a server-only API key reflected by an upstream error', async () => {
        const apiKey = 'SERVER_ONLY_REFLECTED_KEY_FIXTURE';
        app = createApp({
            dataRoot,
            fetchImplementation: async () => jsonResponse({
                error: {
                    message: `Authorization failed for Bearer ${apiKey}; key=${apiKey}`,
                },
            }, 401),
        });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, {
            baseUrl: 'https://models.example/v1',
            model: 'writer-model',
            apiKey,
        });

        const response = await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: '写一段正文。' })
            .expect(502);

        assert.equal(response.body.error, 'provider_http_error');
        assert.equal(response.body.message.includes(apiKey), false);
        assert.equal(
            response.body.message,
            'Authorization failed for Bearer [REDACTED]; key=[REDACTED]',
        );
    });

    test('reports unreachable providers without leaking internal errors', async () => {
        app = createApp({ dataRoot, fetchImplementation: async () => { throw new Error('socket detail'); } });
        const csrfToken = await csrfFor();
        await putProvider(app, csrfToken, { baseUrl: 'http://offline.local/v1', model: 'offline-model' });
        await request(app)
            .post('/api/generate')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ prompt: 'test' })
            .expect(502, { error: 'provider_unreachable', message: 'Could not reach the model provider.' });
    });
});
