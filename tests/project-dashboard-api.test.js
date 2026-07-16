import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';
let app;
let dataRoot;

async function csrfToken() {
    const response = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
    return response.body.csrfToken;
}

beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-dashboard-'));
    app = createApp({ dataRoot });
});

afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('project dashboard API', () => {
    test('returns a read-only today projection for the authoritative project snapshot', async () => {
        const token = await csrfToken();
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', token)
            .send({ title: '今日样书', targetWords: 200_000, chapterTargetWords: 4_000 })
            .expect(201);

        const projectId = created.body.project.id;
        const dashboard = await request(app)
            .get(`/api/story-studio/projects/${projectId}/dashboard`)
            .set('Host', LOCAL_HOST)
            .expect(200);

        assert.equal(dashboard.body.dashboardVersion, 1);
        assert.equal(dashboard.body.project.id, projectId);
        assert.equal(dashboard.body.project.title, '今日样书');
        assert.equal(dashboard.body.progress.targetWords, 200_000);
        assert.equal(dashboard.body.progress.chapterTargetWords, 4_000);
        assert.equal(dashboard.body.nextAction.kind, 'start-chapter');
        assert.equal(dashboard.body.nextAction.chapterId, created.body.chapter.id);
        assert.equal(dashboard.body.workItems[0].priority, 'primary');

        const reloaded = await request(app)
            .get(`/api/story-studio/projects/${projectId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(reloaded.body.version, created.body.project.version);
    });

    test('preserves the standard not-found error for unknown projects', async () => {
        const response = await request(app)
            .get('/api/story-studio/projects/missing-project/dashboard')
            .set('Host', LOCAL_HOST)
            .expect(404);
        assert.equal(response.body.error, 'not_found');
    });
});
