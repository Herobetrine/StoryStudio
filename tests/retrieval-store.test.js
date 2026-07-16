import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { RetrievalStore } from '../src/retrieval-store.js';
import { StoryStudioStore } from '../src/story-studio-store.js';

const LOCAL_HOST = '127.0.0.1:8123';
let dataRoot;

beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-retrieval-'));
});

afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('project retrieval store', () => {
    test('does not persist an index through a linked project directory', () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalRoot = path.join(dataRoot, 'retrieval');
        const retrievalStore = new RetrievalStore(retrievalRoot, { storyStore });
        const { project, chapter } = storyStore.createProject({ title: '检索越界检查' });
        const externalRoot = path.join(dataRoot, 'external-retrieval-root');
        const linkedRoot = path.join(dataRoot, 'linked-retrieval-root');
        const externalProject = path.join(dataRoot, 'external-retrieval-project');
        fs.mkdirSync(externalRoot);
        fs.symlinkSync(externalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(
            () => new RetrievalStore(linkedRoot, { storyStore }),
            error => error?.code === 'unsafe_retrieval_path',
        );
        assert.deepEqual(fs.readdirSync(externalRoot), []);

        fs.mkdirSync(externalProject, { recursive: true });
        fs.symlinkSync(
            externalProject,
            path.join(retrievalRoot, project.id),
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        assert.throws(
            () => retrievalStore.preview(project.id, chapter.id, {
                projectVersion: project.version,
                chapterRevision: chapter.revision,
                query: '越界',
            }),
            error => error?.code === 'unsafe_retrieval_path',
        );
        assert.deepEqual(fs.readdirSync(externalProject), []);
    });

    test('persists a traceable index and refreshes only changed sources', () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), { storyStore });
        let { project, chapter } = storyStore.createProject({ title: '检索工程' });
        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { title: '赤门', content: '林照在赤门找到铜钥匙。', card: { summary: '找到铜钥匙。', pov: '林照' } },
        ));

        const first = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '铜钥匙',
        });
        assert.ok(first.hits.some(hit => hit.sourceType === 'chapter' && hit.chapterId === chapter.id));
        assert.equal(first.diagnostics.rebuilt, true);
        const indexPath = retrievalStore.indexPath(project.id);
        assert.equal(fs.existsSync(indexPath), true);
        const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        assert.equal(persisted.projectVersion, project.version);
        assert.match(persisted.sourceDigest, /^[0-9a-f]{64}$/);
        assert.ok(persisted.index.chunks.every(chunk => (
            typeof chunk.sourceType === 'string'
            && typeof chunk.sourceId === 'string'
            && Object.hasOwn(chunk, 'chapterId')
            && Number.isInteger(chunk.start)
            && Number.isInteger(chunk.end)
            && /^[0-9a-f]{64}$/.test(chunk.hash)
        )));

        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '林照把铜钥匙交给守门人，换回一枚银令。' },
        ));
        const second = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '银令',
        });
        assert.ok(second.hits.some(hit => hit.text.includes('银令')));
        assert.equal(second.hits.some(hit => hit.text.includes('在赤门找到铜钥匙')), false);
        assert.equal(second.diagnostics.rebuilt, true);
        assert.ok(second.index.lastDiff.added + second.index.lastDiff.deleted > 0);

        const third = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '银令',
        });
        assert.equal(third.diagnostics.rebuilt, false);
        assert.equal(third.index.sourceDigest, second.index.sourceDigest);

        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { title: '赤门（改名）' },
        ));
        const metadataOnly = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '银令',
        });
        assert.ok(metadataOnly.index.lastDiff.updated > 0);
        assert.equal(
            retrievalStore.readRecord(project.id).index.listChunks()
                .some(chunk => chunk.sourceType === 'chapter' && chunk.title === '赤门（改名）'),
            true,
        );

        const corrupted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        corrupted.index.chunks[0].text = '伪造的磁盘索引内容';
        fs.writeFileSync(indexPath, JSON.stringify(corrupted, null, 2));
        const repaired = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '银令',
        });
        assert.equal(repaired.diagnostics.rebuilt, true);
        assert.equal(repaired.hits.some(hit => hit.text.includes('伪造的磁盘索引内容')), false);
        const repairedFile = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        assert.equal(repairedFile.index.chunks.some(chunk => chunk.text.includes('伪造的磁盘索引内容')), false);
        assert.match(repairedFile.indexDigest, /^[0-9a-f]{64}$/);
    });

    test('filters future chapters and falls back when optional reranking fails', async () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), {
            storyStore,
            reranker: async () => { throw new Error('provider unavailable'); },
        });
        let { project, chapter } = storyStore.createProject({ title: '时间过滤' });
        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '第一章只知道铜钥匙。', card: { summary: '铜钥匙仍是真品。' } },
        ));
        const created = storyStore.createChapter(project.id, project.version, { title: '未来章' });
        project = created.project;
        const future = storyStore.updateChapter(
            project.id,
            created.chapter.id,
            project.version,
            created.chapter.revision,
            { content: '未来章揭示铜钥匙其实是赝品。' },
        );
        project = future.project;
        const current = storyStore.getChapter(project.id, chapter.id);
        const preview = await retrievalStore.preview(project.id, current.id, {
            projectVersion: project.version,
            chapterRevision: current.revision,
            query: '铜钥匙',
            rerank: true,
        });
        assert.equal(preview.hits.some(hit => hit.chapterId === future.chapter.id), false);
        assert.equal(preview.hits.some(hit => hit.chapterId === current.id), true);
        assert.equal(preview.diagnostics.rerank, 'deterministic-fallback');
    });

    test('refreshes chapter-order and fact-status metadata even when source text is unchanged', () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), { storyStore });
        let { project, chapter: future } = storyStore.createProject({ title: '元数据刷新' });
        ({ project, chapter: future } = storyStore.updateChapter(
            project.id,
            future.id,
            project.version,
            future.revision,
            { title: '未来揭晓', content: '未来章节揭示黑曜钥匙已经断裂。' },
        ));
        let created = storyStore.createChapter(project.id, project.version, { title: '当前章节' });
        project = created.project;
        let current = created.chapter;
        ({ project, chapter: current } = storyStore.updateChapter(
            project.id,
            current.id,
            project.version,
            current.revision,
            { content: '当前章节只知道黑曜钥匙仍在。' },
        ));

        const beforeMove = retrievalStore.preview(project.id, current.id, {
            projectVersion: project.version,
            chapterRevision: current.revision,
            query: '断裂',
        });
        assert.equal(beforeMove.hits.some(hit => hit.chapterId === future.id), true);

        const reordered = storyStore.reorderChapters(project.id, project.version, [current.id, future.id]);
        project = reordered.project;
        current = storyStore.getChapter(project.id, current.id);
        future = storyStore.getChapter(project.id, future.id);
        const afterMove = retrievalStore.preview(project.id, current.id, {
            projectVersion: project.version,
            chapterRevision: current.revision,
            query: '断裂',
        });
        assert.equal(current.number, 1);
        assert.equal(future.number, 2);
        assert.equal(afterMove.hits.some(hit => hit.chapterId === future.id), false);
        assert.ok(afterMove.index.lastDiff.updated >= 2);
        assert.equal(
            retrievalStore.readRecord(project.id).index.listChunks()
                .filter(chunk => chunk.chapterId === future.id)
                .every(chunk => chunk.chapterNumber === 2),
            true,
        );

        ({ project, chapter: current } = storyStore.adoptGeneration(
            project.id,
            current.id,
            project.version,
            current.revision,
            {
                generationId: 'seed-metadata-fact',
                storyStateChanges: {
                    facts: { upsert: [{
                        id: 'metadata-fact', summary: '黑曜钥匙属于旧王。',
                        sourceChapterId: current.id, status: 'active',
                    }] },
                },
            },
        ));
        const active = retrievalStore.preview(project.id, null, {
            projectVersion: project.version,
            query: '旧王',
        });
        assert.equal(active.hits.some(hit => hit.sourceId === 'metadata-fact'), true);

        ({ project, chapter: current } = storyStore.adoptGeneration(
            project.id,
            current.id,
            project.version,
            current.revision,
            {
                generationId: 'retire-metadata-fact',
                storyStateChanges: { facts: { upsert: [{ id: 'metadata-fact', status: 'retired' }] } },
            },
        ));
        const retired = retrievalStore.preview(project.id, null, {
            projectVersion: project.version,
            query: '旧王',
        });
        assert.equal(retired.hits.some(hit => hit.sourceId === 'metadata-fact'), false);
        assert.ok(retired.index.lastDiff.updated > 0);
        assert.equal(
            retrievalStore.readRecord(project.id).index.listChunks()
                .find(chunk => chunk.sourceId === 'metadata-fact')?.status,
            'retired',
        );
    });

    test('derives POV knowledge from authority and manual include cannot bypass hidden facts', () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), { storyStore });
        let { project, chapter } = storyStore.createProject({ title: 'POV 过滤' });
        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { card: { pov: 'hero' } },
        ));
        ({ project, chapter } = storyStore.adoptGeneration(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            {
                generationId: 'seed-pov-facts',
                storyStateChanges: {
                    entities: { upsert: [{ id: 'hero', kind: 'character', name: '林照' }] },
                    facts: { upsert: [
                        { id: 'known-fact', summary: '公开暗号是铜钥匙。', sourceChapterId: chapter.id, status: 'active' },
                        { id: 'hidden-fact', summary: '隐藏暗号是银月。', sourceChapterId: chapter.id, status: 'active' },
                    ] },
                    knowledge: { upsert: [
                        { id: 'known-edge', entityId: 'hero', factId: 'known-fact', stance: 'knows', learnedChapterId: chapter.id, status: 'active' },
                        { id: 'hidden-edge', entityId: 'hero', factId: 'hidden-fact', stance: 'hides', learnedChapterId: chapter.id, status: 'active' },
                    ] },
                },
            },
        ));
        const visible = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '暗号',
            manualInclude: ['hidden-fact'],
            povKnowledge: [{ entityId: 'hero', factId: 'hidden-fact', stance: 'knows' }],
        });
        assert.equal(visible.hits.some(hit => hit.sourceId === 'known-fact'), true);
        assert.equal(visible.hits.some(hit => hit.sourceId === 'hidden-fact'), false);

        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { card: { pov: '无法解析的人物' } },
        ));
        const unresolved = retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '公开暗号',
        });
        assert.equal(unresolved.hits.some(hit => hit.sourceType === 'fact'), false);
    });

    test('ignores a reranker that returns only fabricated ids and keeps manual includes first', async () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), {
            storyStore,
            reranker: async () => [{ id: 'fabricated-hit-id' }],
        });
        let { project, chapter } = storyStore.createProject({ title: '安全重排' });
        ({ project, chapter } = storyStore.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '铜钥匙在赤门。', card: { summary: '铜钥匙仍在赤门。' } },
        ));
        const preview = await retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '铜钥匙',
            manualInclude: [{ sourceType: 'chapter-summary', sourceId: chapter.id }],
            rerank: true,
        });
        assert.equal(preview.hits[0].sourceType, 'chapter-summary');
        assert.equal(preview.diagnostics.rerank, 'provider-ignored');
    });

    test('rejects oversized manual include and exclude lists before searching', () => {
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story'));
        const retrievalStore = new RetrievalStore(path.join(dataRoot, 'retrieval'), { storyStore });
        const { project, chapter } = storyStore.createProject({ title: '覆盖数量限制' });
        assert.throws(() => retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '任意',
            manualInclude: Array.from({ length: 201 }, (_, index) => `include-${index}`),
        }), error => error?.code === 'retrieval_reference_limit');
        assert.throws(() => retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '任意',
            filters: { exclude: Array.from({ length: 201 }, (_, index) => `exclude-${index}`) },
        }), error => error?.code === 'retrieval_reference_limit');
        assert.throws(() => retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '任意',
            manualInclude: ['x'.repeat(513)],
        }), error => error?.code === 'invalid_retrieval_reference');
        assert.throws(() => retrievalStore.preview(project.id, chapter.id, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            query: '任意',
            manualExclude: [{ sourceType: 'fact', sourceId: 'known', script: 'ignored-before-fix' }],
        }), error => error?.code === 'invalid_retrieval_reference');
    });
});

describe('retrieval HTTP contract', () => {
    test('previews without a provider, rejects stale snapshots, and rebuilds asynchronously', async () => {
        const app = createApp({ dataRoot });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        const csrfToken = bootstrap.body.csrfToken;
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: 'HTTP 检索' })
            .expect(201);
        let { project, chapter } = created.body;
        const saved = await request(app)
            .patch(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                revision: chapter.revision,
                changes: { content: '长宁城的列车在雨夜停靠。', card: { summary: '雨夜列车抵达。' } },
            })
            .expect(200);
        ({ project, chapter } = saved.body);

        const previewPath = `/api/story-studio/projects/${project.id}/chapters/${chapter.id}/retrieval/preview`;
        const preview = await request(app)
            .post(previewPath)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                chapterRevision: chapter.revision,
                query: '列车',
                limit: 10,
            })
            .expect(200);
        assert.equal(preview.body.query, '列车');
        assert.ok(preview.body.hits.some(hit => hit.chapterId === chapter.id));
        assert.equal(preview.body.diagnostics.projectVersion, project.version);

        await request(app)
            .post(previewPath)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: project.version, chapterRevision: chapter.revision, query: '列车', unknown: true })
            .expect(400, {
                error: 'unknown_fields',
                message: 'Retrieval preview contains unknown fields.',
                fields: ['unknown'],
            });
        await request(app)
            .post(previewPath)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: project.version - 1, chapterRevision: chapter.revision, query: '列车' })
            .expect(409);

        const queued = await request(app)
            .post(`/api/story-studio/projects/${project.id}/retrieval/rebuild`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: project.version, mode: 'full', batchSize: 25, async: true })
            .expect(202);
        assert.equal(queued.body.status, 'queued');
        await new Promise(resolve => setTimeout(resolve, 30));
        const job = await request(app)
            .get(`/api/story-studio/projects/${project.id}/retrieval/rebuild/${queued.body.jobId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(job.body.status, 'completed');
        assert.equal(job.body.result.projectVersion, project.version);
    });
});
