import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';

describe('formal chapter version API', () => {
    let app;
    let csrfToken;
    let dataRoot;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-version-api-'));
        app = createApp({ dataRoot });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        csrfToken = bootstrap.body.csrfToken;
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    async function patchChapter(project, chapter, changes) {
        return await request(app)
            .patch(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: project.version, revision: chapter.revision, changes })
            .expect(200);
    }

    test('captures prior formal drafts and restores an old draft as a new revision', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '版本验收' })
            .expect(201);
        const candidateOnly = await patchChapter(created.body.project, created.body.chapter, {
            candidate: { kind: 'draft', content: '候选稿不属于正式版本。', createdAt: null },
        });
        const candidateVersions = await request(app)
            .get(`/api/story-studio/projects/${created.body.project.id}/chapters/${created.body.chapter.id}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(candidateVersions.body.map(item => item.versionId), ['current']);

        const first = await patchChapter(candidateOnly.body.project, candidateOnly.body.chapter, {
            title: '雨夜入城',
            content: '第一稿。',
            notes: '保留动作。',
        });
        const second = await patchChapter(first.body.project, first.body.chapter, {
            content: '第二稿改写了结尾。',
            notes: '结尾需要更强。',
        });

        const basePath = `/api/story-studio/projects/${created.body.project.id}/chapters/${created.body.chapter.id}`;
        const versions = await request(app)
            .get(`${basePath}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(versions.body.length, 3);
        assert.equal(versions.body[0].versionId, 'current');
        assert.equal(versions.body[0].chapterRevision, 4);
        assert.deepEqual(versions.body.slice(1).map(item => item.chapterRevision), [3, 2]);

        const revisionTwo = versions.body.find(item => item.chapterRevision === 3);
        const snapshot = await request(app)
            .get(`${basePath}/versions/${revisionTwo.versionId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(snapshot.body.content, '第一稿。');
        assert.equal(snapshot.body.notes, '保留动作。');

        const restored = await request(app)
            .post(`${basePath}/versions/${revisionTwo.versionId}/restore`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: second.body.project.version,
                chapterRevision: second.body.chapter.revision,
            })
            .expect(200);
        assert.equal(restored.body.chapter.content, '第一稿。');
        assert.equal(restored.body.chapter.notes, '保留动作。');
        assert.equal(restored.body.chapter.revision, 5);
        assert.equal(restored.body.version.versionId, 'current');

        const afterRestore = await request(app)
            .get(`${basePath}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(afterRestore.body.map(item => item.chapterRevision), [5, 4, 3, 2]);
        assert.equal(afterRestore.body.find(item => item.chapterRevision === 4).source, 'restore');

        const stale = await request(app)
            .post(`${basePath}/versions/${revisionTwo.versionId}/restore`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: second.body.project.version,
                chapterRevision: second.body.chapter.revision,
            })
            .expect(409);
        assert.equal(stale.body.error, 'project_conflict');

        const current = await request(app)
            .get(`${basePath}/versions/current`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(current.body.content, '第一稿。');
        assert.equal(current.body.chapterRevision, 5);

        const currentRestore = await request(app)
            .post(`${basePath}/versions/current/restore`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: restored.body.project.version,
                chapterRevision: restored.body.chapter.revision,
            })
            .expect(409);
        assert.equal(currentRestore.body.error, 'version_is_current');

        const provenance = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '来源校验' })
            .expect(201);
        const invalidAdoption = await request(app)
            .post(`/api/story-studio/projects/${provenance.body.project.id}/chapters/${provenance.body.chapter.id}/adopt`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: provenance.body.project.version,
                revision: provenance.body.chapter.revision,
                payload: {
                    generationId: 'invalid-source-attempt',
                    content: { mode: 'invalid', text: '不会提交' },
                },
            })
            .expect(400);
        assert.equal(invalidAdoption.body.error, 'invalid_adoption_mode');
        const manuallySaved = await patchChapter(provenance.body.project, provenance.body.chapter, {
            content: '合法手工正文。',
        });
        const provenanceVersions = await request(app)
            .get(`/api/story-studio/projects/${provenance.body.project.id}/chapters/${provenance.body.chapter.id}/versions`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(manuallySaved.body.chapter.content, '合法手工正文。');
        assert.equal(provenanceVersions.body[1].source, 'manual');
    });
});
