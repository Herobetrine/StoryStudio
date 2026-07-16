import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    copilotDefaultBinding,
    copilotHandoffEligibility,
    copilotSessionAuthorityStale,
} from '../public/copilot-ui.js';

function fixture() {
    const project = {
        id: 'project-one',
        version: 7,
        chapters: [
            { id: 'chapter-one', volumeId: 'volume-one', number: 1, title: '第一章', revision: 3 },
            { id: 'chapter-two', volumeId: 'volume-two', number: 2, title: '第二章', revision: 5 },
        ],
    };
    const chapter = project.chapters[1];
    const base = {
        projectId: project.id,
        projectVersion: project.version,
        anchorChapterId: chapter.id,
        anchorChapterRevision: chapter.revision,
    };
    const session = {
        id: 'copilot-session-one',
        projectId: project.id,
        revision: 2,
        status: 'ready',
        stale: false,
        contextDigest: 'a'.repeat(64),
        base,
    };
    const artifact = {
        id: 'copilot-artifact-one',
        projectId: project.id,
        sessionId: session.id,
        contextDigest: session.contextDigest,
        base: structuredClone(base),
    };
    return { project, chapter, session, artifact };
}

describe('Copilot browser state helpers', () => {
    test('selects the active chapter and volume for a fresh workspace', () => {
        const { project } = fixture();
        assert.deepEqual(copilotDefaultBinding(project, project.chapters[1]), {
            anchorChapterId: 'chapter-two',
            volumeIds: ['volume-two'],
            chapterIds: ['chapter-two'],
        });
        assert.deepEqual(copilotDefaultBinding(project, { id: 'missing' }), {
            anchorChapterId: 'chapter-one',
            volumeIds: ['volume-one'],
            chapterIds: ['chapter-one'],
        });
        assert.deepEqual(copilotDefaultBinding(null, null), {
            anchorChapterId: '',
            volumeIds: [],
            chapterIds: [],
        });
    });

    test('detects immutable project authority drift', () => {
        const { project, session } = fixture();
        assert.equal(copilotSessionAuthorityStale(session, project), false);
        assert.equal(copilotSessionAuthorityStale(session, { ...project, version: 8 }), true);
        assert.equal(copilotSessionAuthorityStale({ ...session, stale: true }, project), true);
        assert.equal(copilotSessionAuthorityStale(session, { ...project, id: 'project-two' }), true);
    });

    test('accepts only an exact ready session, artifact, project, and chapter binding', () => {
        const current = fixture();
        assert.deepEqual(copilotHandoffEligibility(current), {
            eligible: true,
            code: 'eligible',
            reason: '',
        });

        const noAnchor = fixture();
        noAnchor.session.base = {
            ...noAnchor.session.base,
            anchorChapterId: null,
            anchorChapterRevision: null,
        };
        noAnchor.artifact.base = structuredClone(noAnchor.session.base);
        assert.equal(copilotHandoffEligibility(noAnchor).code, 'missing-anchor');

        const crossChapter = fixture();
        crossChapter.chapter = crossChapter.project.chapters[0];
        assert.equal(copilotHandoffEligibility(crossChapter).code, 'chapter-mismatch');

        const revised = fixture();
        revised.chapter = { ...revised.chapter, revision: revised.chapter.revision + 1 };
        assert.equal(copilotHandoffEligibility(revised).code, 'chapter-revision-mismatch');

        const stale = fixture();
        stale.project = { ...stale.project, version: stale.project.version + 1 };
        assert.equal(copilotHandoffEligibility(stale).code, 'session-stale');

        const wrongArtifact = fixture();
        wrongArtifact.artifact = { ...wrongArtifact.artifact, sessionId: 'copilot-session-two' };
        assert.equal(copilotHandoffEligibility(wrongArtifact).code, 'artifact-mismatch');
    });
});
