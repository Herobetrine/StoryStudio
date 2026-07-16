import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    buildVolumeTree,
    isChapterPlanStale,
    moveChapterProjection,
    moveChapterToVolumeProjection,
    moveVolumeProjection,
    structureProjection,
    volumeForChapter,
} from '../public/volume-ui.js';

function fixture() {
    return {
        volumes: [
            { id: 'volume-1', number: 1, title: '第一卷', revision: 2 },
            { id: 'volume-2', number: 2, title: '第二卷', revision: 1 },
            { id: 'volume-3', number: 3, title: '第三卷', revision: 1 },
        ],
        chapters: [
            { id: 'chapter-1', number: 1, title: '雨夜', summary: '入城', volumeId: 'volume-1', planBasis: { volumeRevision: 2 } },
            { id: 'chapter-2', number: 2, title: '旧门', summary: '追查', volumeId: 'volume-1', planBasis: { volumeRevision: 1 } },
            { id: 'chapter-3', number: 3, title: '远行', summary: '离城', volumeId: 'volume-2', planBasis: { volumeRevision: 1 } },
        ],
    };
}

describe('volume UI projections', () => {
    test('builds a complete ordered projection including empty volumes', () => {
        assert.deepEqual(structureProjection(fixture()), [
            { id: 'volume-1', chapterIds: ['chapter-1', 'chapter-2'] },
            { id: 'volume-2', chapterIds: ['chapter-3'] },
            { id: 'volume-3', chapterIds: [] },
        ]);
    });

    test('moves volumes without separating their chapters', () => {
        assert.deepEqual(moveVolumeProjection(fixture(), 'volume-2', 'up'), [
            { id: 'volume-2', chapterIds: ['chapter-3'] },
            { id: 'volume-1', chapterIds: ['chapter-1', 'chapter-2'] },
            { id: 'volume-3', chapterIds: [] },
        ]);
        assert.equal(moveVolumeProjection(fixture(), 'volume-1', 'up'), null);
    });

    test('moves chapters only inside their current volume', () => {
        assert.deepEqual(moveChapterProjection(fixture(), 'chapter-2', 'up')[0], {
            id: 'volume-1', chapterIds: ['chapter-2', 'chapter-1'],
        });
        assert.equal(moveChapterProjection(fixture(), 'chapter-1', 'up'), null);
        assert.equal(moveChapterProjection(fixture(), 'chapter-3', 'down'), null);
    });

    test('moves a chapter to the end of an explicit target volume', () => {
        assert.deepEqual(moveChapterToVolumeProjection(fixture(), 'chapter-2', 'volume-3'), [
            { id: 'volume-1', chapterIds: ['chapter-1'] },
            { id: 'volume-2', chapterIds: ['chapter-3'] },
            { id: 'volume-3', chapterIds: ['chapter-2'] },
        ]);
        assert.equal(moveChapterToVolumeProjection(fixture(), 'chapter-2', 'volume-1'), null);
    });

    test('keeps the volume header when chapter search matches', () => {
        const tree = buildVolumeTree(fixture(), '追查');
        assert.equal(tree.length, 1);
        assert.equal(tree[0].volume.id, 'volume-1');
        assert.deepEqual(tree[0].chapters.map(chapter => chapter.id), ['chapter-2']);
        assert.equal(tree[0].totalChapterCount, 2);
    });

    test('detects stale chapter plans against the exact owning volume', () => {
        const project = fixture();
        assert.equal(volumeForChapter(project, project.chapters[0]).id, 'volume-1');
        assert.equal(isChapterPlanStale(project, project.chapters[0]), false);
        assert.equal(isChapterPlanStale(project, project.chapters[1]), true);
        assert.equal(isChapterPlanStale(project, { volumeId: 'missing', planBasis: { volumeRevision: 99 } }), true);
    });

    test('fails closed when a chapter points outside the volume directory', () => {
        const project = fixture();
        project.chapters[0].volumeId = 'missing';
        assert.throws(() => structureProjection(project), /不存在的卷/);
    });
});
