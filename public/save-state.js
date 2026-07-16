import {
    combineFieldPaths,
    findConflictingPaths,
    getValueAtPath,
    isContinuityPath,
    mergeDirtyPaths,
    mergeProjectDirtyPaths,
} from './core.js';

function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function recordsMatch(left, right) {
    return Boolean(left && right && left.id !== undefined && left.id === right.id);
}

/**
 * Reports whether a successful response belongs to the current record but
 * carries an older optimistic-concurrency token than the authority already
 * visible in the workspace.
 */
export function authorityResponseTokenIsStale(response, authority, tokenField) {
    if (!recordsMatch(response, authority)) return false;
    const responseToken = response?.[tokenField];
    const authorityToken = authority?.[tokenField];
    return Number.isSafeInteger(responseToken)
        && Number.isSafeInteger(authorityToken)
        && responseToken < authorityToken;
}

function mergeAuthoritySnapshot({
    remote,
    local = null,
    baseline = null,
    dirtyPaths = [],
    savingPaths = [],
    preserveSavingPaths = true,
    advanceBaseline = false,
    relatedPending = false,
}, {
    mergeRecord,
    tokenField,
}) {
    const preservedPaths = combineFieldPaths(
        dirtyPaths,
        preserveSavingPaths ? savingPaths : null,
    );
    const matchingLocal = recordsMatch(local, remote) ? local : null;
    const matchingBaseline = recordsMatch(baseline, remote) ? baseline : null;
    const preserveBaseline = !advanceBaseline
        && matchingBaseline
        && (preservedPaths.size > 0 || relatedPending);
    const nextBaseline = preserveBaseline
        ? mergeRecord(
            remote,
            matchingBaseline,
            combineFieldPaths(preservedPaths, [tokenField]),
        )
        : structuredClone(remote);
    const record = matchingLocal && preservedPaths.size > 0
        ? mergeRecord(remote, matchingLocal, preservedPaths)
        : structuredClone(remote);
    return {
        record,
        baseline: nextBaseline,
        preservedPaths,
    };
}

/**
 * Selects the optimistic concurrency token belonging to the current record.
 * A baseline from another record is never allowed to supply the token.
 */
export function optimisticTokenFor(baseline, current, tokenField) {
    return recordsMatch(baseline, current)
        ? baseline?.[tokenField]
        : current?.[tokenField];
}

/**
 * Creates an immutable transition from queued dirty paths to an in-flight batch.
 * Paths not present in the dirty set are ignored, and input iteration order is kept.
 */
export function beginSaveBatch(dirtyPaths, selectedPaths = dirtyPaths) {
    const pendingPaths = combineFieldPaths(dirtyPaths);
    const selected = combineFieldPaths(selectedPaths);
    const nextDirtyPaths = new Set();
    const savingPaths = new Set();
    for (const fieldPath of pendingPaths) {
        if (selected.has(fieldPath)) {
            savingPaths.add(fieldPath);
        } else {
            nextDirtyPaths.add(fieldPath);
        }
    }
    return {
        dirtyPaths: nextDirtyPaths,
        savingPaths,
    };
}

/**
 * Restores a failed in-flight batch after edits queued during the request.
 * Newly queued paths retain their order and duplicate paths are not moved.
 */
export function rollbackSaveBatch(dirtyPaths, savingPaths) {
    return combineFieldPaths(dirtyPaths, savingPaths);
}

export function mergeProjectAuthoritySnapshot(options = {}) {
    return mergeAuthoritySnapshot(options, {
        mergeRecord: mergeProjectDirtyPaths,
        tokenField: 'version',
    });
}

export function mergeChapterAuthoritySnapshot(options = {}) {
    return mergeAuthoritySnapshot(options, {
        mergeRecord: mergeDirtyPaths,
        tokenField: 'revision',
    });
}

/**
 * Classifies a field-level three-way merge without changing the caller's Set.
 */
export function classifyConflictPaths({
    baseline,
    remote,
    local,
    fieldPaths = [],
} = {}) {
    const alreadyAppliedPaths = [];
    const pendingPaths = new Set();
    for (const fieldPath of combineFieldPaths(fieldPaths)) {
        if (valuesEqual(
            getValueAtPath(remote, fieldPath),
            getValueAtPath(local, fieldPath),
        )) {
            alreadyAppliedPaths.push(fieldPath);
        } else {
            pendingPaths.add(fieldPath);
        }
    }
    const conflictingPaths = findConflictingPaths(
        baseline ?? remote,
        remote,
        local,
        pendingPaths,
    );
    const conflicts = new Set(conflictingPaths);
    return {
        alreadyAppliedPaths,
        pendingPaths,
        conflictingPaths,
        mergeablePaths: [...pendingPaths].filter(fieldPath => !conflicts.has(fieldPath)),
    };
}

export function buildRecordChanges(record, fieldPaths) {
    return mergeDirtyPaths({}, record, combineFieldPaths(fieldPaths));
}

export function buildProjectChanges(project, fieldPaths) {
    const paths = combineFieldPaths(fieldPaths);
    const directPaths = [...paths].filter(fieldPath => !isContinuityPath(fieldPath));
    const changes = directPaths.length > 0
        ? mergeDirtyPaths({}, project, directPaths)
        : {};
    if ([...paths].some(isContinuityPath)) {
        changes.continuity = structuredClone(project?.continuity || []);
    }
    return changes;
}
