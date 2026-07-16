import { hashWorkflowValue } from './workflow-store.js';

const RECOVERY_SHAPES = Object.freeze({
    'chapter-card': Object.freeze({
        chapter: Object.freeze(['card', 'planBasis']),
        summary: Object.freeze(['summary', 'planBasis', 'updatedAt']),
    }),
    'chapter-review': Object.freeze({
        chapter: Object.freeze(['review', 'notes']),
        summary: Object.freeze(['updatedAt']),
    }),
    closeout: Object.freeze({
        chapter: Object.freeze(['status']),
        summary: Object.freeze(['status', 'updatedAt']),
    }),
});

function shapeFor(operation) {
    const shape = RECOVERY_SHAPES[operation];
    if (!shape) throw new TypeError(`Unsupported workflow authority operation: ${operation}`);
    return shape;
}

function withoutFields(value, fields) {
    const result = structuredClone(value);
    for (const field of fields) delete result[field];
    return result;
}

function projectInvariant(project, chapterId, shape) {
    const result = withoutFields(project, ['version', 'updatedAt', 'chapterBytes']);
    result.chapters = result.chapters.map(summary => (
        summary.id === chapterId ? withoutFields(summary, shape.summary) : summary
    ));
    return result;
}

function chapterInvariant(chapter, shape) {
    return withoutFields(chapter, ['revision', 'updatedAt', ...shape.chapter]);
}

export function createAuthorityRecoveryFingerprint(project, chapter, operation) {
    const shape = shapeFor(operation);
    return {
        projectDigest: hashWorkflowValue(projectInvariant(project, chapter.id, shape)),
        chapterDigest: hashWorkflowValue(chapterInvariant(chapter, shape)),
    };
}

export function matchesRecoverableAuthority(project, chapter, base, fingerprint, operation) {
    if (project.version !== base.projectVersion + 1 || chapter.revision !== base.chapterRevision + 1) {
        return false;
    }
    if (!fingerprint || typeof fingerprint.projectDigest !== 'string'
        || typeof fingerprint.chapterDigest !== 'string') return false;
    const current = createAuthorityRecoveryFingerprint(project, chapter, operation);
    return current.projectDigest === fingerprint.projectDigest
        && current.chapterDigest === fingerprint.chapterDigest;
}

export function matchesBaseAuthority(project, chapter, base, fingerprint, operation) {
    if (project.version !== base.projectVersion || chapter.revision !== base.chapterRevision) return false;
    if (!fingerprint || typeof fingerprint.projectDigest !== 'string'
        || typeof fingerprint.chapterDigest !== 'string') return false;
    const current = createAuthorityRecoveryFingerprint(project, chapter, operation);
    return current.projectDigest === fingerprint.projectDigest
        && current.chapterDigest === fingerprint.chapterDigest;
}

export function matchesAppliedAuthority(project, chapter, target) {
    return Boolean(target)
        && project.version === target.projectVersion
        && chapter.revision === target.chapterRevision;
}
