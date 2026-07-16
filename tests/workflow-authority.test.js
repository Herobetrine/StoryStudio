import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createAuthorityRecoveryFingerprint,
    matchesAppliedAuthority,
    matchesBaseAuthority,
    matchesRecoverableAuthority,
} from '../src/workflow-authority.js';

function fixture() {
    const chapter = {
        schemaVersion: 5,
        id: 'chapter-one',
        projectId: 'project-one',
        number: 1,
        title: '第一章',
        status: 'drafting',
        card: { summary: '', goal: '进城' },
        content: '旧正文',
        candidate: {},
        review: '',
        notes: '作者备注',
        volumeId: 'volume-one',
        planBasis: { volumeRevision: 1 },
        wordCount: 3,
        revision: 7,
        generationHistory: [],
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
    };
    const project = {
        schemaVersion: 5,
        id: 'project-one',
        title: '测试作品',
        genre: '玄幻',
        story: { logline: '入城' },
        storyState: { entities: [] },
        resources: {},
        volumes: [{ id: 'volume-one', revision: 1 }],
        chapters: [{
            id: chapter.id,
            number: 1,
            title: chapter.title,
            status: chapter.status,
            summary: chapter.card.summary,
            volumeId: chapter.volumeId,
            planBasis: chapter.planBasis,
            wordCount: chapter.wordCount,
            updatedAt: chapter.updatedAt,
        }],
        chapterBytes: 100,
        version: 11,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
    };
    return { project, chapter };
}

function advance(project, chapter) {
    const nextProject = structuredClone(project);
    const nextChapter = structuredClone(chapter);
    nextProject.version += 1;
    nextChapter.revision += 1;
    nextProject.updatedAt = '2026-07-15T00:01:00.000Z';
    nextChapter.updatedAt = nextProject.updatedAt;
    nextProject.chapterBytes += 20;
    nextProject.chapters[0].updatedAt = nextProject.updatedAt;
    return { project: nextProject, chapter: nextChapter };
}

describe('workflow authority recovery fingerprints', () => {
    test('accepts exactly one card mutation while rejecting unrelated chapter or project changes', () => {
        const base = fixture();
        const fingerprint = createAuthorityRecoveryFingerprint(base.project, base.chapter, 'chapter-card');
        const next = advance(base.project, base.chapter);
        next.chapter.card = { summary: '已经进城', goal: '进城' };
        next.chapter.planBasis = { volumeRevision: 2 };
        next.project.chapters[0].summary = next.chapter.card.summary;
        next.project.chapters[0].planBasis = next.chapter.planBasis;

        assert.equal(matchesRecoverableAuthority(
            next.project, next.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            fingerprint, 'chapter-card',
        ), true);

        const changedNotes = structuredClone(next);
        changedNotes.chapter.notes = '无关并发备注';
        assert.equal(matchesRecoverableAuthority(
            changedNotes.project, changedNotes.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            fingerprint, 'chapter-card',
        ), false);

        const changedProject = structuredClone(next);
        changedProject.project.genre = '科幻';
        assert.equal(matchesRecoverableAuthority(
            changedProject.project, changedProject.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            fingerprint, 'chapter-card',
        ), false);
    });

    test('keeps review and closeout recovery limited to their declared fields', () => {
        const base = fixture();
        const reviewFingerprint = createAuthorityRecoveryFingerprint(base.project, base.chapter, 'chapter-review');
        const reviewed = advance(base.project, base.chapter);
        reviewed.chapter.review = '结构完整';
        reviewed.chapter.notes = '修订第二段';
        assert.equal(matchesRecoverableAuthority(
            reviewed.project, reviewed.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            reviewFingerprint, 'chapter-review',
        ), true);
        reviewed.chapter.content = '被同时改写的正文';
        assert.equal(matchesRecoverableAuthority(
            reviewed.project, reviewed.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            reviewFingerprint, 'chapter-review',
        ), false);

        const closeoutFingerprint = createAuthorityRecoveryFingerprint(base.project, base.chapter, 'closeout');
        const closed = advance(base.project, base.chapter);
        closed.chapter.status = 'done';
        closed.project.chapters[0].status = 'done';
        assert.equal(matchesRecoverableAuthority(
            closed.project, closed.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            closeoutFingerprint, 'closeout',
        ), true);
        closed.project.storyState = { entities: [{ id: 'unexpected' }] };
        assert.equal(matchesRecoverableAuthority(
            closed.project, closed.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            closeoutFingerprint, 'closeout',
        ), false);
    });

    test('requires an exact single version advance and exact applied target versions', () => {
        const base = fixture();
        const fingerprint = createAuthorityRecoveryFingerprint(base.project, base.chapter, 'chapter-review');
        assert.equal(matchesBaseAuthority(
            base.project, base.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            fingerprint, 'chapter-review',
        ), true);
        const next = advance(base.project, base.chapter);
        next.chapter.review = '审校';
        next.project.version += 1;
        assert.equal(matchesRecoverableAuthority(
            next.project, next.chapter,
            { projectVersion: base.project.version, chapterRevision: base.chapter.revision },
            fingerprint, 'chapter-review',
        ), false);
        assert.equal(matchesAppliedAuthority(next.project, next.chapter, {
            projectVersion: next.project.version,
            chapterRevision: next.chapter.revision,
        }), true);
        assert.equal(matchesAppliedAuthority(next.project, next.chapter, {
            projectVersion: next.project.version - 1,
            chapterRevision: next.chapter.revision,
        }), false);
    });
});
