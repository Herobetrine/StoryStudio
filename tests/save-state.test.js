import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    authorityResponseTokenIsStale,
    beginSaveBatch,
    buildProjectChanges,
    buildRecordChanges,
    classifyConflictPaths,
    mergeChapterAuthoritySnapshot,
    mergeProjectAuthoritySnapshot,
    optimisticTokenFor,
    rollbackSaveBatch,
} from '../public/save-state.js';
import { continuityView } from '../public/core.js';

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
    return value;
}

describe('save state projections', () => {
    test('identifies only an older response token for the same authority record', () => {
        assert.equal(
            authorityResponseTokenIsStale(
                { id: 'chapter-1', revision: 2 },
                { id: 'chapter-1', revision: 3 },
                'revision',
            ),
            true,
        );
        assert.equal(
            authorityResponseTokenIsStale(
                { id: 'chapter-1', revision: 3 },
                { id: 'chapter-1', revision: 3 },
                'revision',
            ),
            false,
        );
        assert.equal(
            authorityResponseTokenIsStale(
                { id: 'chapter-1', revision: 4 },
                { id: 'chapter-1', revision: 3 },
                'revision',
            ),
            false,
        );
        assert.equal(
            authorityResponseTokenIsStale(
                { id: 'chapter-2', revision: 1 },
                { id: 'chapter-1', revision: 3 },
                'revision',
            ),
            false,
        );
        assert.equal(
            authorityResponseTokenIsStale(
                { id: 'chapter-1', revision: '2' },
                { id: 'chapter-1', revision: 3 },
                'revision',
            ),
            false,
        );
    });

    test('selects optimistic tokens only from a baseline with the same identity', () => {
        assert.equal(
            optimisticTokenFor(
                { id: 'project-1', version: 0 },
                { id: 'project-1', version: 9 },
                'version',
            ),
            0,
        );
        assert.equal(
            optimisticTokenFor(
                { id: 'project-2', version: 3 },
                { id: 'project-1', version: 9 },
                'version',
            ),
            9,
        );
        assert.equal(
            optimisticTokenFor(null, { id: 'chapter-1', revision: 4 }, 'revision'),
            4,
        );
    });

    test('moves a stable subset into a save batch without mutating either input set', () => {
        const dirtyPaths = new Set(['title', 'content', 'card.goal']);
        const selectedPaths = new Set(['content', 'missing']);
        const batch = beginSaveBatch(dirtyPaths, selectedPaths);

        assert.deepEqual([...batch.savingPaths], ['content']);
        assert.deepEqual([...batch.dirtyPaths], ['title', 'card.goal']);
        assert.deepEqual([...dirtyPaths], ['title', 'content', 'card.goal']);
        assert.deepEqual([...selectedPaths], ['content', 'missing']);

        const completeBatch = beginSaveBatch(dirtyPaths);
        assert.deepEqual([...completeBatch.savingPaths], ['title', 'content', 'card.goal']);
        assert.deepEqual([...completeBatch.dirtyPaths], []);
    });

    test('rolls a failed batch behind newly queued edits while preserving same-field edits', () => {
        const dirtyDuringRequest = new Set(['content', 'notes']);
        const savingPaths = new Set(['content', 'title']);
        const restored = rollbackSaveBatch(dirtyDuringRequest, savingPaths);

        assert.deepEqual([...restored], ['content', 'notes', 'title']);
        assert.deepEqual([...dirtyDuringRequest], ['content', 'notes']);
        assert.deepEqual([...savingPaths], ['content', 'title']);
    });

    test('preserves queued and in-flight project fields plus their pre-refresh baseline', () => {
        const baseline = deepFreeze({
            id: 'project-1',
            version: 1,
            title: '旧标题',
            story: { premise: '旧命题', outline: '旧总纲' },
            continuity: [],
        });
        const local = deepFreeze({
            id: 'project-1',
            version: 1,
            title: '保存中的标题',
            story: { premise: '排队中的命题', outline: '旧总纲' },
            continuity: [],
        });
        const remote = deepFreeze({
            id: 'project-1',
            version: 2,
            title: '远端标题',
            story: { premise: 'Workflow 命题', outline: '远端总纲' },
            continuity: [],
        });
        const dirtyPaths = new Set(['story.premise']);
        const savingPaths = new Set(['title']);
        const result = mergeProjectAuthoritySnapshot({
            remote,
            local,
            baseline,
            dirtyPaths,
            savingPaths,
        });

        assert.deepEqual([...result.preservedPaths], ['story.premise', 'title']);
        assert.deepEqual([...dirtyPaths], ['story.premise']);
        assert.deepEqual([...savingPaths], ['title']);
        assert.deepEqual(result.record, {
            id: 'project-1',
            version: 2,
            title: '保存中的标题',
            story: { premise: '排队中的命题', outline: '远端总纲' },
            continuity: [],
        });
        assert.deepEqual(result.baseline, {
            id: 'project-1',
            version: 1,
            title: '旧标题',
            story: { premise: '旧命题', outline: '远端总纲' },
            continuity: [],
        });
    });

    test('advances a successful project baseline while retaining edits queued during the request', () => {
        const result = mergeProjectAuthoritySnapshot({
            remote: {
                id: 'project-1',
                version: 2,
                title: '服务端规范化标题',
                genre: '服务端类型',
                continuity: [],
            },
            local: {
                id: 'project-1',
                version: 1,
                title: '请求期间的新标题',
                genre: '保存中的类型',
                continuity: [],
            },
            baseline: {
                id: 'project-1',
                version: 1,
                title: '旧标题',
                genre: '旧类型',
                continuity: [],
            },
            dirtyPaths: new Set(['title']),
            savingPaths: new Set(['title', 'genre']),
            preserveSavingPaths: false,
            advanceBaseline: true,
        });

        assert.deepEqual([...result.preservedPaths], ['title']);
        assert.equal(result.record.title, '请求期间的新标题');
        assert.equal(result.record.genre, '服务端类型');
        assert.equal(result.baseline.version, 2);
        assert.equal(result.baseline.title, '服务端规范化标题');
        assert.equal(result.baseline.genre, '服务端类型');
    });

    test('retains only the project token for a related in-flight volume edit', () => {
        const result = mergeProjectAuthoritySnapshot({
            remote: {
                id: 'project-1',
                version: 8,
                title: '远端标题',
                volumes: [{ id: 'volume-1', revision: 3, title: '远端卷名' }],
                continuity: [],
            },
            local: {
                id: 'project-1',
                version: 7,
                title: '旧标题',
                volumes: [{ id: 'volume-1', revision: 2, title: '本地卷名' }],
                continuity: [],
            },
            baseline: {
                id: 'project-1',
                version: 7,
                title: '旧标题',
                volumes: [{ id: 'volume-1', revision: 2, title: '旧卷名' }],
                continuity: [],
            },
            relatedPending: true,
        });

        assert.deepEqual([...result.preservedPaths], []);
        assert.equal(result.record.version, 8);
        assert.equal(result.record.title, '远端标题');
        assert.equal(result.baseline.version, 7);
        assert.equal(result.baseline.title, '远端标题');
        assert.equal(result.baseline.volumes[0].revision, 3);
    });

    test('does not apply a local value or baseline token from another record', () => {
        const result = mergeChapterAuthoritySnapshot({
            remote: { id: 'chapter-2', revision: 9, title: '远端章节', content: '远端正文' },
            local: { id: 'chapter-1', revision: 4, title: '本地章节', content: '本地正文' },
            baseline: { id: 'chapter-1', revision: 3, title: '旧章节', content: '旧正文' },
            dirtyPaths: new Set(['content']),
            savingPaths: new Set(['title']),
        });

        assert.deepEqual(result.record, {
            id: 'chapter-2',
            revision: 9,
            title: '远端章节',
            content: '远端正文',
        });
        assert.deepEqual(result.baseline, result.record);
        assert.deepEqual([...result.preservedPaths], ['content', 'title']);
    });

    test('preserves a chapter baseline during refresh and advances it after an exact save response', () => {
        const shared = {
            remote: { id: 'chapter-1', revision: 2, title: '远端章名', content: 'Workflow 正文' },
            local: { id: 'chapter-1', revision: 1, title: '保存中章名', content: '本地正文' },
            baseline: { id: 'chapter-1', revision: 1, title: '旧章名', content: '旧正文' },
            dirtyPaths: new Set(['content']),
            savingPaths: new Set(['title']),
        };
        const refreshed = mergeChapterAuthoritySnapshot(shared);

        assert.deepEqual(refreshed.record, {
            id: 'chapter-1',
            revision: 2,
            title: '保存中章名',
            content: '本地正文',
        });
        assert.deepEqual(refreshed.baseline, {
            id: 'chapter-1',
            revision: 1,
            title: '旧章名',
            content: '旧正文',
        });

        const acknowledged = mergeChapterAuthoritySnapshot({
            ...shared,
            preserveSavingPaths: false,
            advanceBaseline: true,
        });
        assert.deepEqual([...acknowledged.preservedPaths], ['content']);
        assert.equal(acknowledged.record.title, '远端章名');
        assert.equal(acknowledged.record.content, '本地正文');
        assert.deepEqual(acknowledged.baseline, shared.remote);
    });

    test('classifies already applied, mergeable and conflicting paths in stable order', () => {
        const fieldPaths = new Set(['title', 'genre', 'pov']);
        const result = classifyConflictPaths({
            baseline: { title: '旧标题', genre: '玄幻', pov: '甲' },
            remote: { title: '远端标题', genre: '科幻', pov: '甲' },
            local: { title: '本地标题', genre: '科幻', pov: '乙' },
            fieldPaths,
        });

        assert.deepEqual(result.alreadyAppliedPaths, ['genre']);
        assert.deepEqual([...result.pendingPaths], ['title', 'pov']);
        assert.deepEqual(result.conflictingPaths, ['title']);
        assert.deepEqual(result.mergeablePaths, ['pov']);
        assert.deepEqual([...fieldPaths], ['title', 'genre', 'pov']);
    });

    test('keeps edits to a different continuity entry mergeable', () => {
        const baseline = {
            continuity: [
                { id: 'a', detail: 'A0' },
                { id: 'b', detail: 'B0' },
            ],
        };
        const remote = {
            continuity: [
                { id: 'a', detail: 'A1' },
                { id: 'b', detail: 'B0' },
            ],
        };
        const local = {
            continuity: [
                { id: 'a', detail: 'A0' },
                { id: 'b', detail: 'B1' },
            ],
        };
        const result = classifyConflictPaths({
            baseline: continuityView(baseline),
            remote: continuityView(remote),
            local: continuityView(local),
            fieldPaths: ['continuityById.b.detail'],
        });

        assert.deepEqual(result.conflictingPaths, []);
        assert.deepEqual(result.mergeablePaths, ['continuityById.b.detail']);
    });

    test('builds detached record and project PATCH payloads including full continuity', () => {
        const chapter = {
            title: '第一章',
            card: { goal: '抵达城门', hook: '看见追兵' },
            content: '正文',
        };
        assert.deepEqual(
            buildRecordChanges(chapter, new Set(['title', 'card.goal'])),
            { title: '第一章', card: { goal: '抵达城门' } },
        );

        const project = {
            title: '作品',
            story: { premise: '命题', outline: '总纲' },
            continuity: [
                { id: 'a', label: '承诺', detail: 'A0' },
                { id: 'b', label: '事实', detail: 'B1' },
            ],
        };
        const paths = new Set(['story.premise', 'continuityById.b.detail']);
        const changes = buildProjectChanges(project, paths);

        assert.deepEqual(changes, {
            story: { premise: '命题' },
            continuity: [
                { id: 'a', label: '承诺', detail: 'A0' },
                { id: 'b', label: '事实', detail: 'B1' },
            ],
        });
        assert.equal('continuityById' in changes, false);
        changes.continuity[1].detail = '修改返回值';
        assert.equal(project.continuity[1].detail, 'B1');
        assert.deepEqual([...paths], ['story.premise', 'continuityById.b.detail']);
    });
});
