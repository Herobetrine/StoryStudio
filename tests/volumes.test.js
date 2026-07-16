import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { StoryStudioError, StoryStudioStore } from '../src/story-studio-store.js';

const LOCAL_HOST = '127.0.0.1:8124';
let rootDirectory;

function hasCode(code, details = {}) {
    return error => {
        assert.ok(error instanceof StoryStudioError);
        assert.equal(error.code, code);
        for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details[key], value);
        return true;
    };
}

async function csrfFor(app) {
    const response = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
    return response.body.csrfToken;
}

function apiRequest(app, csrfToken, method, url, body) {
    return request(app)[method](url)
        .set('Host', LOCAL_HOST)
        .set('X-CSRF-Token', csrfToken)
        .send(body);
}

function structureOf(project) {
    return project.volumes.map(volume => ({
        id: volume.id,
        chapterIds: project.chapters
            .filter(chapter => chapter.volumeId === volume.id)
            .map(chapter => chapter.id),
    }));
}

beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-volumes-'));
});

afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('volume storage contract', () => {
    test('creates a first volume, manages empty volumes, and assigns new chapters explicitly', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'store'));
        const created = store.createProject({ title: '卷层级测试' });
        const firstVolume = created.project.volumes[0];

        assert.equal(created.project.schemaVersion, 5);
        assert.equal(created.project.volumes.length, 1);
        assert.equal(firstVolume.number, 1);
        assert.equal(firstVolume.title, '第1卷');
        assert.equal(firstVolume.revision, 1);
        assert.equal(created.chapter.volumeId, firstVolume.id);
        assert.deepEqual(created.chapter.planBasis, { volumeRevision: firstVolume.revision });
        assert.deepEqual(created.project.chapters[0].planBasis, created.chapter.planBasis);
        assert.throws(
            () => store.deleteVolume(created.project.id, firstVolume.id, created.project.version, firstVolume.revision),
            hasCode('last_volume_required'),
        );

        const added = store.createVolume(created.project.id, created.project.version, {
            title: '暗潮卷',
            goal: '主角找到失踪的引路人',
            outline: '线索逐层收紧。',
        });
        assert.equal(added.project.volumes.length, 2);
        assert.equal(added.volume.number, 2);
        assert.equal(added.volume.revision, 1);

        const updated = store.updateVolume(
            added.project.id,
            added.volume.id,
            added.project.version,
            added.volume.revision,
            { title: '暗潮浮城', summary: '主角确认城内有人接应敌方。' },
        );
        assert.equal(updated.volume.title, '暗潮浮城');
        assert.equal(updated.volume.revision, 2);
        assert.equal(updated.project.version, added.project.version + 1);

        const removed = store.deleteVolume(
            updated.project.id,
            updated.volume.id,
            updated.project.version,
            updated.volume.revision,
        );
        assert.deepEqual(removed.deleted, { id: updated.volume.id, number: 2 });
        assert.equal(removed.project.volumes.length, 1);

        const replacement = store.createVolume(removed.project.id, removed.project.version, { title: '远行卷' });
        const chapterResult = store.createChapter(replacement.project.id, replacement.project.version, {
            title: '渡口',
            volumeId: replacement.volume.id,
        });
        assert.equal(chapterResult.chapter.volumeId, replacement.volume.id);
        assert.deepEqual(chapterResult.chapter.planBasis, { volumeRevision: replacement.volume.revision });
        assert.equal(
            chapterResult.project.chapters.find(chapter => chapter.id === chapterResult.chapter.id).volumeId,
            replacement.volume.id,
        );
        assert.throws(
            () => store.deleteVolume(
                chapterResult.project.id,
                replacement.volume.id,
                chapterResult.project.version,
                replacement.volume.revision,
            ),
            hasCode('volume_not_empty', { volumeId: replacement.volume.id }),
        );
    });

    test('reorders volumes and chapters and marks only cross-volume moves for plan review', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'store'));
        const created = store.createProject({ title: '结构投影测试' });
        const firstVolume = created.project.volumes[0];
        const added = store.createVolume(created.project.id, created.project.version, { title: '第二卷' });
        const secondVolume = added.volume;
        const second = store.createChapter(added.project.id, added.project.version, {
            title: '第二章',
            volumeId: secondVolume.id,
        });
        const third = store.createChapter(second.project.id, second.project.version, {
            title: '第三章',
            volumeId: secondVolume.id,
        });

        const volumeReordered = store.updateStructure(third.project.id, third.project.version, [
            { id: secondVolume.id, chapterIds: [second.chapter.id, third.chapter.id] },
            { id: firstVolume.id, chapterIds: [created.chapter.id] },
        ]);
        assert.deepEqual(volumeReordered.project.volumes.map(volume => volume.id), [secondVolume.id, firstVolume.id]);
        assert.deepEqual(volumeReordered.project.volumes.map(volume => volume.number), [1, 2]);
        assert.deepEqual(volumeReordered.chapters.map(chapter => chapter.id), [second.chapter.id, third.chapter.id, created.chapter.id]);
        assert.deepEqual(volumeReordered.chapters.map(chapter => chapter.number), [1, 2, 3]);
        assert.deepEqual(
            volumeReordered.chapters.map(chapter => chapter.planBasis.volumeRevision),
            [secondVolume.revision, secondVolume.revision, firstVolume.revision],
        );

        const chapterReordered = store.updateStructure(
            volumeReordered.project.id,
            volumeReordered.project.version,
            [
                { id: secondVolume.id, chapterIds: [third.chapter.id, second.chapter.id] },
                { id: firstVolume.id, chapterIds: [created.chapter.id] },
            ],
        );
        assert.deepEqual(chapterReordered.chapters.map(chapter => chapter.id), [third.chapter.id, second.chapter.id, created.chapter.id]);
        assert.deepEqual(chapterReordered.chapters.map(chapter => chapter.number), [1, 2, 3]);
        assert.equal(
            chapterReordered.chapters.find(chapter => chapter.id === second.chapter.id).planBasis.volumeRevision,
            secondVolume.revision,
        );

        const moved = store.updateStructure(chapterReordered.project.id, chapterReordered.project.version, [
            { id: secondVolume.id, chapterIds: [third.chapter.id] },
            { id: firstVolume.id, chapterIds: [second.chapter.id, created.chapter.id] },
        ]);
        const movedChapter = moved.chapters.find(chapter => chapter.id === second.chapter.id);
        assert.equal(movedChapter.volumeId, firstVolume.id);
        assert.deepEqual(movedChapter.planBasis, { volumeRevision: 0 });
        assert.deepEqual(
            moved.project.chapters.find(chapter => chapter.id === second.chapter.id).planBasis,
            { volumeRevision: 0 },
        );
        assert.equal(store.getChapter(moved.project.id, second.chapter.id).planBasis.volumeRevision, 0);
    });

    test('rejects incomplete, duplicate, and unknown structure projections without mutation', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'store'));
        const created = store.createProject({ title: '非法结构测试' });
        const firstVolume = created.project.volumes[0];
        const added = store.createVolume(created.project.id, created.project.version, { title: '第二卷' });
        const second = store.createChapter(added.project.id, added.project.version, {
            title: '第二章',
            volumeId: added.volume.id,
        });
        const project = second.project;
        const beforeProject = JSON.stringify(store.getProject(project.id));

        assert.throws(
            () => store.updateStructure(project.id, project.version, [
                { id: firstVolume.id, chapterIds: [created.chapter.id] },
                { id: added.volume.id, chapterIds: [] },
            ]),
            hasCode('invalid_structure', { missingChapterIds: [second.chapter.id] }),
        );
        assert.throws(
            () => store.updateStructure(project.id, project.version, [
                { id: firstVolume.id, chapterIds: [created.chapter.id, created.chapter.id] },
                { id: added.volume.id, chapterIds: [] },
            ]),
            hasCode('invalid_structure', { duplicateChapterIds: [created.chapter.id] }),
        );
        assert.throws(
            () => store.updateStructure(project.id, project.version, [
                { id: firstVolume.id, chapterIds: [created.chapter.id] },
                { id: added.volume.id, chapterIds: ['unknown-chapter'] },
            ]),
            hasCode('invalid_structure', {
                missingChapterIds: [second.chapter.id],
                unknownChapterIds: ['unknown-chapter'],
            }),
        );
        assert.throws(
            () => store.updateStructure(project.id, project.version, [
                { id: firstVolume.id, chapterIds: [created.chapter.id] },
                { id: 'unknown-volume', chapterIds: [second.chapter.id] },
            ]),
            hasCode('invalid_structure', {
                missingVolumeIds: [added.volume.id],
                unknownVolumeIds: ['unknown-volume'],
            }),
        );
        assert.throws(
            () => store.updateStructure(project.id, project.version, [
                { id: firstVolume.id, chapterIds: [created.chapter.id] },
                { id: firstVolume.id, chapterIds: [second.chapter.id] },
            ]),
            hasCode('invalid_structure', { duplicateVolumeIds: [firstVolume.id] }),
        );
        assert.equal(JSON.stringify(store.getProject(project.id)), beforeProject);
    });

    test('enforces project and volume concurrency and refreshes planBasis when the card is saved', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'store'));
        const created = store.createProject({ title: '卷修订测试' });
        const volume = created.project.volumes[0];

        assert.throws(
            () => store.createVolume(created.project.id, created.project.version - 1, { title: '冲突卷' }),
            hasCode('project_conflict', { currentVersion: created.project.version }),
        );
        assert.throws(
            () => store.updateVolume(
                created.project.id,
                volume.id,
                created.project.version,
                volume.revision - 1,
                { title: '冲突标题' },
            ),
            hasCode('volume_conflict', {
                currentRevision: volume.revision,
                currentProjectVersion: created.project.version,
            }),
        );

        const volumeUpdated = store.updateVolume(
            created.project.id,
            volume.id,
            created.project.version,
            volume.revision,
            { outline: '新的卷级约束。' },
        );
        const staleChapter = store.getChapter(created.project.id, created.chapter.id);
        assert.equal(staleChapter.planBasis.volumeRevision, volume.revision);
        assert.ok(staleChapter.planBasis.volumeRevision < volumeUpdated.volume.revision);
        assert.throws(
            () => store.deleteVolume(
                volumeUpdated.project.id,
                volume.id,
                volumeUpdated.project.version,
                volume.revision,
            ),
            hasCode('volume_conflict', {
                currentRevision: volumeUpdated.volume.revision,
                currentProjectVersion: volumeUpdated.project.version,
            }),
        );

        const cardSaved = store.updateChapter(
            volumeUpdated.project.id,
            created.chapter.id,
            volumeUpdated.project.version,
            staleChapter.revision,
            { card: { goal: '按新版卷纲查清信使身份' } },
        );
        assert.deepEqual(cardSaved.chapter.planBasis, { volumeRevision: volumeUpdated.volume.revision });
        assert.deepEqual(cardSaved.project.chapters[0].planBasis, cardSaved.chapter.planBasis);
        assert.deepEqual(store.getChapter(created.project.id, created.chapter.id).planBasis, cardSaved.chapter.planBasis);
    });
});

describe('volume HTTP contract', () => {
    test('creates, edits, restructures, and deletes volumes through explicit response contracts', async () => {
        const app = createApp({ dataRoot: path.join(rootDirectory, 'app') });
        const csrfToken = await csrfFor(app);
        const created = await apiRequest(app, csrfToken, 'post', '/api/story-studio/projects', { title: 'HTTP卷测试' })
            .expect(201);
        const projectId = created.body.project.id;
        const firstVolume = created.body.project.volumes[0];

        const added = await apiRequest(
            app,
            csrfToken,
            'post',
            `/api/story-studio/projects/${projectId}/volumes`,
            {
                projectVersion: created.body.project.version,
                volume: { title: '第二卷', goal: '离开封锁区' },
            },
        ).expect(201);
        assert.deepEqual(Object.keys(added.body).sort(), ['project', 'volume']);
        assert.equal(added.body.volume.number, 2);

        const edited = await apiRequest(
            app,
            csrfToken,
            'patch',
            `/api/story-studio/projects/${projectId}/volumes/${added.body.volume.id}`,
            {
                projectVersion: added.body.project.version,
                revision: added.body.volume.revision,
                changes: { title: '城外卷', outline: '穿过封锁线，找到旧车站。' },
            },
        ).expect(200);
        assert.equal(edited.body.volume.title, '城外卷');
        assert.equal(edited.body.volume.revision, 2);

        const chapter = await apiRequest(
            app,
            csrfToken,
            'post',
            `/api/story-studio/projects/${projectId}/chapters`,
            {
                projectVersion: edited.body.project.version,
                chapter: { title: '旧车站', volumeId: edited.body.volume.id },
            },
        ).expect(201);
        assert.equal(chapter.body.chapter.volumeId, edited.body.volume.id);
        assert.deepEqual(chapter.body.chapter.planBasis, { volumeRevision: edited.body.volume.revision });

        const invalidLegacyReorder = await apiRequest(
            app,
            csrfToken,
            'post',
            `/api/story-studio/projects/${projectId}/chapters/reorder`,
            {
                projectVersion: chapter.body.project.version,
                chapterIds: [chapter.body.chapter.id, created.body.chapter.id],
            },
        ).expect(400);
        assert.equal(invalidLegacyReorder.body.error, 'invalid_chapter_order');
        assert.equal(invalidLegacyReorder.body.requiresStructure, true);

        const restructured = await apiRequest(
            app,
            csrfToken,
            'post',
            `/api/story-studio/projects/${projectId}/structure`,
            {
                projectVersion: chapter.body.project.version,
                volumes: [
                    { id: edited.body.volume.id, chapterIds: [chapter.body.chapter.id, created.body.chapter.id] },
                    { id: firstVolume.id, chapterIds: [] },
                ],
            },
        ).expect(200);
        assert.deepEqual(restructured.body.project.volumes.map(volume => volume.id), [edited.body.volume.id, firstVolume.id]);
        assert.deepEqual(restructured.body.chapters.map(item => item.id), [chapter.body.chapter.id, created.body.chapter.id]);
        assert.equal(
            restructured.body.chapters.find(item => item.id === created.body.chapter.id).planBasis.volumeRevision,
            0,
        );

        const movedChapter = restructured.body.chapters.find(item => item.id === created.body.chapter.id);
        const cardSaved = await apiRequest(
            app,
            csrfToken,
            'patch',
            `/api/story-studio/projects/${projectId}/chapters/${movedChapter.id}`,
            {
                projectVersion: restructured.body.project.version,
                revision: movedChapter.revision,
                changes: { card: { goal: '按城外卷纲重写行动目标' } },
            },
        ).expect(200);
        assert.deepEqual(cardSaved.body.chapter.planBasis, { volumeRevision: edited.body.volume.revision });
        assert.deepEqual(
            cardSaved.body.project.chapters.find(item => item.id === movedChapter.id).planBasis,
            cardSaved.body.chapter.planBasis,
        );

        const emptyFirstVolume = cardSaved.body.project.volumes.find(volume => volume.id === firstVolume.id);
        const deleted = await apiRequest(
            app,
            csrfToken,
            'delete',
            `/api/story-studio/projects/${projectId}/volumes/${firstVolume.id}`,
            {
                projectVersion: cardSaved.body.project.version,
                revision: emptyFirstVolume.revision,
            },
        ).expect(200);
        assert.deepEqual(deleted.body.deleted, { id: firstVolume.id, number: 2 });
        assert.equal(deleted.body.project.volumes.length, 1);
        assert.equal(deleted.body.project.volumes[0].number, 1);
    });

    test('rejects unknown envelopes and exposes stable project, revision, and structure conflicts', async () => {
        const app = createApp({ dataRoot: path.join(rootDirectory, 'app') });
        const csrfToken = await csrfFor(app);
        const created = await apiRequest(app, csrfToken, 'post', '/api/story-studio/projects', { title: 'HTTP冲突测试' })
            .expect(201);
        const projectId = created.body.project.id;
        const firstVolume = created.body.project.volumes[0];
        const base = `/api/story-studio/projects/${projectId}`;

        const envelopeCases = [
            ['post', `${base}/volumes`, { projectVersion: created.body.project.version, volume: {}, unexpected: true }],
            ['patch', `${base}/volumes/${firstVolume.id}`, {
                projectVersion: created.body.project.version,
                revision: firstVolume.revision,
                changes: {},
                unexpected: true,
            }],
            ['delete', `${base}/volumes/${firstVolume.id}`, {
                projectVersion: created.body.project.version,
                revision: firstVolume.revision,
                unexpected: true,
            }],
            ['post', `${base}/structure`, {
                projectVersion: created.body.project.version,
                volumes: structureOf(created.body.project),
                unexpected: true,
            }],
        ];
        for (const [method, url, body] of envelopeCases) {
            const response = await apiRequest(app, csrfToken, method, url, body).expect(400);
            assert.equal(response.body.error, 'unknown_fields');
            assert.deepEqual(response.body.fields, ['unexpected']);
        }

        const added = await apiRequest(app, csrfToken, 'post', `${base}/volumes`, {
            projectVersion: created.body.project.version,
            volume: { title: '第二卷' },
        }).expect(201);

        const staleProject = await apiRequest(app, csrfToken, 'patch', `${base}/volumes/${added.body.volume.id}`, {
            projectVersion: created.body.project.version,
            revision: added.body.volume.revision,
            changes: { title: '不会写入' },
        }).expect(409);
        assert.equal(staleProject.body.error, 'project_conflict');
        assert.equal(staleProject.body.currentVersion, added.body.project.version);

        const staleRevision = await apiRequest(app, csrfToken, 'patch', `${base}/volumes/${added.body.volume.id}`, {
            projectVersion: added.body.project.version,
            revision: added.body.volume.revision - 1,
            changes: { title: '不会写入' },
        }).expect(409);
        assert.equal(staleRevision.body.error, 'volume_conflict');
        assert.equal(staleRevision.body.currentRevision, added.body.volume.revision);

        const staleDelete = await apiRequest(app, csrfToken, 'delete', `${base}/volumes/${added.body.volume.id}`, {
            projectVersion: added.body.project.version,
            revision: added.body.volume.revision - 1,
        }).expect(409);
        assert.equal(staleDelete.body.error, 'volume_conflict');

        const invalidStructure = await apiRequest(app, csrfToken, 'post', `${base}/structure`, {
            projectVersion: added.body.project.version,
            volumes: [
                { id: firstVolume.id, chapterIds: [] },
                { id: added.body.volume.id, chapterIds: [] },
            ],
        }).expect(400);
        assert.equal(invalidStructure.body.error, 'invalid_structure');
        assert.deepEqual(invalidStructure.body.missingChapterIds, [created.body.chapter.id]);

        const staleStructure = await apiRequest(app, csrfToken, 'post', `${base}/structure`, {
            projectVersion: created.body.project.version,
            volumes: structureOf(added.body.project),
        }).expect(409);
        assert.equal(staleStructure.body.error, 'project_conflict');
    });
});
