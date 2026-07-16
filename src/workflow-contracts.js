import { createHash } from 'node:crypto';

import { ApiError } from './api-error.js';

export const WORKFLOW_V2_PAYLOAD_VERSION = 1;
export const WORKFLOW_V2_ARTIFACT_KINDS = Object.freeze([
    'brainstorm-direction',
    'chapter-plan',
    'chapter-draft',
    'chapter-review',
    'rewrite-diff',
    'chapter-adoption',
]);

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const EVIDENCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_TEXT = 100_000;
const MAX_DIFF_TEXT = 250_000;
const MAX_CONTENT_CHARACTERS = 5_000_000;
const CARD_FIELDS = Object.freeze([
    'summary', 'goal', 'conflict', 'turn', 'hook', 'pov', 'time', 'location', 'required', 'avoid',
]);
const STORY_STATE_CATEGORIES = Object.freeze([
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
]);
const ISSUE_SEVERITIES = new Set(['blocker', 'major', 'minor']);
const ISSUE_CATEGORIES = new Set([
    'causality', 'motivation', 'continuity', 'pov', 'pacing', 'information', 'promise', 'style', 'ending',
]);
const COVERAGE_STATUSES = new Set(['met', 'partial', 'missed']);

function fail(path, message, details = {}) {
    throw new ApiError(400, 'invalid_workflow_artifact_payload', `${path}: ${message}`, {
        path,
        ...details,
    });
}

function plain(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        fail(path, 'must be a plain object.');
    }
    return value;
}

function known(value, fields, path) {
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    if (unknown.length > 0) fail(path, 'contains unknown fields.', { fields: unknown });
}

function text(value, path, maximum = MAX_TEXT, { required = true } = {}) {
    if (typeof value !== 'string' || value.length > maximum || (required && value.trim().length === 0)) {
        fail(path, `must be ${required ? 'a non-empty ' : 'a '}string no longer than ${maximum} characters.`);
    }
    return value;
}

function id(value, path, pattern = ID) {
    if (typeof value !== 'string' || !pattern.test(value)) fail(path, 'is invalid.');
    return value;
}

function hash(value, path) {
    if (typeof value !== 'string' || !HASH.test(value)) fail(path, 'must be a SHA-256 digest.');
    return value;
}

function integer(value, path, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        fail(path, `must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
}

function boolean(value, path) {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean.');
    return value;
}

function array(value, path, minimum, maximum) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
        fail(path, `must contain from ${minimum} to ${maximum} items.`);
    }
    return value;
}

function enumValue(value, allowed, path) {
    if (!allowed.has(value)) fail(path, 'has an unsupported value.');
    return value;
}

function unique(values, path) {
    if (new Set(values).size !== values.length) fail(path, 'contains duplicate values.');
    return values;
}

function normalizeIds(value, path, { minimum = 0, maximum = 64, pattern = ID } = {}) {
    return unique(array(value, path, minimum, maximum).map((item, index) => (
        id(item, `${path}[${index}]`, pattern)
    )), path);
}

function jsonClone(value, path) {
    let nodes = 0;
    const visit = (item, itemPath, depth) => {
        nodes += 1;
        if (nodes > 100_000 || depth > 64) fail(itemPath, 'is too complex.');
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
        if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
        if (Array.isArray(item)) return item.map((child, index) => visit(child, `${itemPath}[${index}]`, depth + 1));
        const object = plain(item, itemPath);
        return Object.fromEntries(Object.entries(object).map(([key, child]) => {
            if (FORBIDDEN_KEYS.has(key)) fail(`${itemPath}.${key}`, 'uses a forbidden key.');
            return [key, visit(child, `${itemPath}.${key}`, depth + 1)];
        }));
    };
    return visit(value, path, 0);
}

function stableNormalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableNormalize);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key])]));
}

export function workflowContractDigest(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(stableNormalize(value));
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function payloadVersion(value, path) {
    if (value !== WORKFLOW_V2_PAYLOAD_VERSION) fail(path, 'is unsupported.');
    return value;
}

function normalizeChapterCard(value, path) {
    const card = plain(value, path);
    known(card, CARD_FIELDS, path);
    return Object.fromEntries(CARD_FIELDS.map(field => [field, text(card[field], `${path}.${field}`, 20_000)]));
}

function normalizeSourceEventChain(value, path) {
    const events = array(value, path, 3, 12).map((item, index) => {
        const itemPath = `${path}[${index}]`;
        const event = plain(item, itemPath);
        known(event, ['order', 'event', 'characterChoice', 'directResult', 'cost'], itemPath);
        const normalized = {
            order: integer(event.order, `${itemPath}.order`, 1, 12),
            event: text(event.event, `${itemPath}.event`, 10_000),
            characterChoice: text(event.characterChoice, `${itemPath}.characterChoice`, 10_000),
            directResult: text(event.directResult, `${itemPath}.directResult`, 10_000),
            cost: text(event.cost, `${itemPath}.cost`, 10_000),
        };
        if (normalized.order !== index + 1) {
            fail(`${itemPath}.order`, 'must match the complete source event order.');
        }
        return normalized;
    });
    return events;
}

function normalizeDirection(value, path) {
    const direction = plain(value, path);
    const fields = [
        'id', 'title', 'forkChoice', 'protagonistAction', 'directResult', 'delayedCost', 'chapterPromise',
        'eventSeeds', 'sourceEventChain',
    ];
    known(direction, fields, path);
    const normalized = {
        id: id(direction.id, `${path}.id`),
        title: text(direction.title, `${path}.title`, 160),
        forkChoice: text(direction.forkChoice, `${path}.forkChoice`, 2_000),
        protagonistAction: text(direction.protagonistAction, `${path}.protagonistAction`, 4_000),
        directResult: text(direction.directResult, `${path}.directResult`, 4_000),
        delayedCost: text(direction.delayedCost, `${path}.delayedCost`, 4_000),
        chapterPromise: text(direction.chapterPromise, `${path}.chapterPromise`, 4_000),
        eventSeeds: unique(array(direction.eventSeeds, `${path}.eventSeeds`, 3, 8).map((item, index) => (
            text(item, `${path}.eventSeeds[${index}]`, 2_000)
        )), `${path}.eventSeeds`),
    };
    if (Object.hasOwn(direction, 'sourceEventChain')) {
        normalized.sourceEventChain = normalizeSourceEventChain(
            direction.sourceEventChain,
            `${path}.sourceEventChain`,
        );
    }
    return normalized;
}

export function normalizeWorkflowV2Direction(value) {
    return normalizeDirection(value, 'direction');
}

function normalizeExclusion(value, path) {
    const exclusion = plain(value, path);
    known(exclusion, ['otherDirectionId', 'reason'], path);
    return {
        otherDirectionId: id(exclusion.otherDirectionId, `${path}.otherDirectionId`),
        reason: text(exclusion.reason, `${path}.reason`, 2_000),
    };
}

function normalizeBrainstormDirection(value, path) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'generationId', 'setDigest', 'directionIndex', 'directionCount',
        'exclusivityAxis', 'direction', 'siblingDigests', 'pairwiseExclusion', 'diagnosisDigest',
        'sourceSnapshotDigest',
    ];
    known(payload, fields, path);
    const directionCount = integer(payload.directionCount, `${path}.directionCount`, 3, 6);
    return {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        generationId: id(payload.generationId, `${path}.generationId`),
        setDigest: hash(payload.setDigest, `${path}.setDigest`),
        directionIndex: integer(payload.directionIndex, `${path}.directionIndex`, 0, directionCount - 1),
        directionCount,
        exclusivityAxis: text(payload.exclusivityAxis, `${path}.exclusivityAxis`, 2_000),
        direction: normalizeDirection(payload.direction, `${path}.direction`),
        siblingDigests: unique(array(payload.siblingDigests, `${path}.siblingDigests`, directionCount - 1,
            directionCount - 1).map((item, index) => hash(item, `${path}.siblingDigests[${index}]`)),
        `${path}.siblingDigests`),
        pairwiseExclusion: array(payload.pairwiseExclusion, `${path}.pairwiseExclusion`, directionCount - 1,
            directionCount - 1).map((item, index) => normalizeExclusion(item, `${path}.pairwiseExclusion[${index}]`)),
        diagnosisDigest: hash(payload.diagnosisDigest, `${path}.diagnosisDigest`),
        sourceSnapshotDigest: hash(payload.sourceSnapshotDigest, `${path}.sourceSnapshotDigest`),
    };
}

export function normalizeBrainstormDirectionSet(value) {
    const payloads = array(value, 'brainstormDirections', 3, 6)
        .map((item, index) => normalizeBrainstormDirection(item, `brainstormDirections[${index}]`))
        .sort((left, right) => left.directionIndex - right.directionIndex);
    const first = payloads[0];
    if (payloads.length !== first.directionCount
        || payloads.some((item, index) => item.directionIndex !== index
            || item.directionCount !== first.directionCount
            || item.generationId !== first.generationId
            || item.setDigest !== first.setDigest
            || item.exclusivityAxis !== first.exclusivityAxis
            || item.diagnosisDigest !== first.diagnosisDigest
            || item.sourceSnapshotDigest !== first.sourceSnapshotDigest)) {
        fail('brainstormDirections', 'do not form one complete ordered generation set.');
    }
    unique(payloads.map(item => item.direction.id.toLocaleLowerCase('en-US')), 'brainstormDirections.direction.id');
    unique(payloads.map(item => item.direction.forkChoice.trim().toLocaleLowerCase('en-US')),
        'brainstormDirections.direction.forkChoice');
    const directionDigests = new Map(payloads.map(item => [item.direction.id, workflowContractDigest(item.direction)]));
    for (const payload of payloads) {
        const otherIds = payloads.filter(item => item !== payload).map(item => item.direction.id);
        const exclusionIds = payload.pairwiseExclusion.map(item => item.otherDirectionId);
        if (new Set(exclusionIds).size !== exclusionIds.length
            || otherIds.some(otherId => !exclusionIds.includes(otherId))
            || exclusionIds.some(otherId => !otherIds.includes(otherId))) {
            fail(`brainstormDirections[${payload.directionIndex}].pairwiseExclusion`,
                'must explain exclusion against every sibling exactly once.');
        }
        const expectedSiblingDigests = otherIds.map(otherId => directionDigests.get(otherId)).sort();
        if (JSON.stringify([...payload.siblingDigests].sort()) !== JSON.stringify(expectedSiblingDigests)) {
            fail(`brainstormDirections[${payload.directionIndex}].siblingDigests`,
                'does not match the other directions.');
        }
    }
    const expectedSetDigest = workflowContractDigest({
        generationId: first.generationId,
        exclusivityAxis: first.exclusivityAxis,
        directions: payloads.map(item => item.direction),
        diagnosisDigest: first.diagnosisDigest,
        sourceSnapshotDigest: first.sourceSnapshotDigest,
    });
    if (first.setDigest !== expectedSetDigest) fail('brainstormDirections.setDigest', 'does not match the set.');
    return payloads;
}

function normalizeBeat(value, path) {
    const beat = plain(value, path);
    const fields = ['id', 'causedBy', 'trigger', 'choice', 'action', 'result', 'cost', 'valueShift', 'information'];
    known(beat, fields, path);
    return {
        id: id(beat.id, `${path}.id`),
        causedBy: beat.causedBy === null ? null : id(beat.causedBy, `${path}.causedBy`),
        trigger: text(beat.trigger, `${path}.trigger`, 4_000),
        choice: text(beat.choice, `${path}.choice`, 4_000),
        action: text(beat.action, `${path}.action`, 4_000),
        result: text(beat.result, `${path}.result`, 4_000),
        cost: text(beat.cost, `${path}.cost`, 4_000),
        valueShift: text(beat.valueShift, `${path}.valueShift`, 4_000),
        information: text(beat.information, `${path}.information`, 4_000),
    };
}

function normalizeBeatIds(value, path, knownBeatIds, { minimum = 1 } = {}) {
    const beatIds = normalizeIds(value, path, { minimum, maximum: 12 });
    const unknown = beatIds.filter(beatId => !knownBeatIds.has(beatId));
    if (unknown.length > 0) fail(path, 'references unknown event-chain beats.', { beatIds: unknown });
    return beatIds;
}

function normalizePlanCoverage(value, path, knownBeatIds) {
    const coverage = plain(value, path);
    known(coverage, ['required', 'avoid', 'volumeGoal', 'promises'], path);
    const required = array(coverage.required, `${path}.required`, 1, 64).map((item, index) => {
        const itemPath = `${path}.required[${index}]`;
        const entry = plain(item, itemPath);
        known(entry, ['item', 'beatIds'], itemPath);
        return {
            item: text(entry.item, `${itemPath}.item`, 4_000),
            beatIds: normalizeBeatIds(entry.beatIds, `${itemPath}.beatIds`, knownBeatIds),
        };
    });
    const avoid = array(coverage.avoid, `${path}.avoid`, 1, 64).map((item, index) => {
        const itemPath = `${path}.avoid[${index}]`;
        const entry = plain(item, itemPath);
        known(entry, ['item', 'guard'], itemPath);
        return {
            item: text(entry.item, `${itemPath}.item`, 4_000),
            guard: text(entry.guard, `${itemPath}.guard`, 4_000),
        };
    });
    const volumeGoalValue = plain(coverage.volumeGoal, `${path}.volumeGoal`);
    known(volumeGoalValue, ['summary', 'beatIds'], `${path}.volumeGoal`);
    const volumeGoal = {
        summary: text(volumeGoalValue.summary, `${path}.volumeGoal.summary`, 4_000),
        beatIds: normalizeBeatIds(volumeGoalValue.beatIds, `${path}.volumeGoal.beatIds`, knownBeatIds),
    };
    const promises = array(coverage.promises, `${path}.promises`, 0, 64).map((item, index) => {
        const itemPath = `${path}.promises[${index}]`;
        const entry = plain(item, itemPath);
        known(entry, ['promiseId', 'action', 'beatIds'], itemPath);
        return {
            promiseId: id(entry.promiseId, `${itemPath}.promiseId`),
            action: enumValue(entry.action, new Set(['touch', 'advance', 'resolve', 'defer']), `${itemPath}.action`),
            beatIds: normalizeBeatIds(entry.beatIds, `${itemPath}.beatIds`, knownBeatIds),
        };
    });
    unique(promises.map(item => item.promiseId), `${path}.promises.promiseId`);
    return { required, avoid, volumeGoal, promises };
}

function normalizeSourceEventCoverage(value, path, knownBeatIds) {
    const claimedBeatIds = new Set();
    return array(value, path, 3, 12).map((item, index) => {
        const itemPath = `${path}[${index}]`;
        const source = plain(item, itemPath);
        known(source, ['sourceOrder', 'beatIds'], itemPath);
        const sourceOrder = integer(source.sourceOrder, `${itemPath}.sourceOrder`, 1, 12);
        if (sourceOrder !== index + 1) {
            fail(`${itemPath}.sourceOrder`, 'must cover source events in complete order.');
        }
        const beatIds = normalizeBeatIds(source.beatIds, `${itemPath}.beatIds`, knownBeatIds);
        const reused = beatIds.filter(beatId => claimedBeatIds.has(beatId));
        if (reused.length > 0) {
            fail(`${itemPath}.beatIds`, 'must not reuse beats assigned to another source event.', {
                beatIds: reused,
            });
        }
        for (const beatId of beatIds) claimedBeatIds.add(beatId);
        return {
            sourceOrder,
            beatIds,
        };
    });
}

function normalizeChapterPlan(value, path) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'generationId', 'directionArtifactId', 'directionDigest', 'eventChain',
        'chapterCard', 'coverage', 'sourceEventCoverage', 'planDigest',
    ];
    known(payload, fields, path);
    const eventChain = array(payload.eventChain, `${path}.eventChain`, 4, 12)
        .map((item, index) => normalizeBeat(item, `${path}.eventChain[${index}]`));
    unique(eventChain.map(beat => beat.id), `${path}.eventChain.id`);
    for (const [index, beat] of eventChain.entries()) {
        const expected = index === 0 ? null : eventChain[index - 1].id;
        if (beat.causedBy !== expected) {
            fail(`${path}.eventChain[${index}].causedBy`, 'must reference the immediately preceding beat.');
        }
    }
    const knownBeatIds = new Set(eventChain.map(beat => beat.id));
    const withoutDigest = {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        generationId: id(payload.generationId, `${path}.generationId`),
        directionArtifactId: id(payload.directionArtifactId, `${path}.directionArtifactId`),
        directionDigest: hash(payload.directionDigest, `${path}.directionDigest`),
        eventChain,
        chapterCard: normalizeChapterCard(payload.chapterCard, `${path}.chapterCard`),
        coverage: normalizePlanCoverage(payload.coverage, `${path}.coverage`, knownBeatIds),
    };
    if (Object.hasOwn(payload, 'sourceEventCoverage')) {
        withoutDigest.sourceEventCoverage = normalizeSourceEventCoverage(
            payload.sourceEventCoverage,
            `${path}.sourceEventCoverage`,
            knownBeatIds,
        );
    }
    const planDigest = hash(payload.planDigest, `${path}.planDigest`);
    if (planDigest !== workflowContractDigest(withoutDigest)) fail(`${path}.planDigest`, 'does not match the plan.');
    return { ...withoutDigest, planDigest };
}

function normalizeChapterDraft(value, path, context) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'generationId', 'planArtifactId', 'planDigest', 'contentDigest', 'contentUnits',
        'generationStatus', 'promptDigest', 'sourceSnapshotDigest', 'retrievalEvidenceIds',
    ];
    known(payload, fields, path);
    const normalized = {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        generationId: id(payload.generationId, `${path}.generationId`),
        planArtifactId: id(payload.planArtifactId, `${path}.planArtifactId`),
        planDigest: hash(payload.planDigest, `${path}.planDigest`),
        contentDigest: hash(payload.contentDigest, `${path}.contentDigest`),
        contentUnits: integer(payload.contentUnits, `${path}.contentUnits`, 1, 100_000_000),
        generationStatus: payload.generationStatus,
        promptDigest: hash(payload.promptDigest, `${path}.promptDigest`),
        sourceSnapshotDigest: hash(payload.sourceSnapshotDigest, `${path}.sourceSnapshotDigest`),
        retrievalEvidenceIds: normalizeIds(payload.retrievalEvidenceIds, `${path}.retrievalEvidenceIds`, {
            minimum: 0, maximum: 256, pattern: EVIDENCE_ID,
        }),
    };
    if (normalized.generationStatus !== 'completed') fail(`${path}.generationStatus`, 'must be completed.');
    if (context.sourceText !== undefined) {
        text(context.sourceText, 'context.sourceText', MAX_CONTENT_CHARACTERS);
        if (workflowContractDigest(context.sourceText) !== normalized.contentDigest) {
            fail(`${path}.contentDigest`, 'does not match context.sourceText.');
        }
    }
    return normalized;
}

function paragraphIndexAt(source, offset) {
    return source.slice(0, offset).split(/\r?\n[\t ]*\r?\n/u).length - 1;
}

function normalizeIssue(value, path, sourceText) {
    const issue = plain(value, path);
    const fields = [
        'id', 'severity', 'category', 'start', 'end', 'paragraphIndex', 'quote', 'reason', 'suggestion',
        'evidenceIds',
    ];
    known(issue, fields, path);
    const start = integer(issue.start, `${path}.start`, 0, MAX_CONTENT_CHARACTERS);
    const end = integer(issue.end, `${path}.end`, start + 1, MAX_CONTENT_CHARACTERS);
    const normalized = {
        id: id(issue.id, `${path}.id`),
        severity: enumValue(issue.severity, ISSUE_SEVERITIES, `${path}.severity`),
        category: enumValue(issue.category, ISSUE_CATEGORIES, `${path}.category`),
        start,
        end,
        paragraphIndex: integer(issue.paragraphIndex, `${path}.paragraphIndex`, 0, 1_000_000),
        quote: text(issue.quote, `${path}.quote`, MAX_DIFF_TEXT),
        reason: text(issue.reason, `${path}.reason`, 10_000),
        suggestion: text(issue.suggestion, `${path}.suggestion`, 10_000),
        evidenceIds: normalizeIds(issue.evidenceIds, `${path}.evidenceIds`, {
            minimum: 0, maximum: 32, pattern: EVIDENCE_ID,
        }),
    };
    if (sourceText !== undefined && (sourceText.slice(start, end) !== normalized.quote
        || paragraphIndexAt(sourceText, start) !== normalized.paragraphIndex)) {
        fail(path, 'does not match its source quote and paragraph location.');
    }
    return normalized;
}

function normalizeIssueReferences(value, path, issueIds, { minimum = 0 } = {}) {
    const references = normalizeIds(value, path, { minimum, maximum: 64 });
    const unknown = references.filter(issueId => !issueIds.has(issueId));
    if (unknown.length > 0) fail(path, 'references unknown review issues.', { issueIds: unknown });
    return references;
}

function normalizeReviewCoverageEntry(value, path, issueIds, labelField = null) {
    const entry = plain(value, path);
    const fields = labelField ? [labelField, 'status', 'evidenceIssueIds'] : ['status', 'evidenceIssueIds'];
    known(entry, fields, path);
    return {
        ...(labelField ? { [labelField]: text(entry[labelField], `${path}.${labelField}`, 4_000) } : {}),
        status: enumValue(entry.status, COVERAGE_STATUSES, `${path}.status`),
        evidenceIssueIds: normalizeIssueReferences(entry.evidenceIssueIds, `${path}.evidenceIssueIds`, issueIds),
    };
}

function normalizeReviewCoverage(value, path, issueIds) {
    const coverage = plain(value, path);
    known(coverage, ['goal', 'required', 'avoid', 'volumeGoal', 'promises'], path);
    return {
        goal: normalizeReviewCoverageEntry(coverage.goal, `${path}.goal`, issueIds),
        required: array(coverage.required, `${path}.required`, 0, 64).map((item, index) => (
            normalizeReviewCoverageEntry(item, `${path}.required[${index}]`, issueIds, 'item')
        )),
        avoid: array(coverage.avoid, `${path}.avoid`, 0, 64).map((item, index) => (
            normalizeReviewCoverageEntry(item, `${path}.avoid[${index}]`, issueIds, 'item')
        )),
        volumeGoal: normalizeReviewCoverageEntry(coverage.volumeGoal, `${path}.volumeGoal`, issueIds),
        promises: array(coverage.promises, `${path}.promises`, 0, 64).map((item, index) => (
            normalizeReviewCoverageEntry(item, `${path}.promises[${index}]`, issueIds, 'promiseId')
        )),
    };
}

function normalizeRewriteTarget(value, path, sourceText, issueById) {
    if (value === null) return null;
    const target = plain(value, path);
    known(target, ['start', 'end', 'quote', 'issueIds', 'instruction'], path);
    const start = integer(target.start, `${path}.start`, 0, MAX_CONTENT_CHARACTERS);
    const end = integer(target.end, `${path}.end`, start + 1, MAX_CONTENT_CHARACTERS);
    if (end - start > MAX_DIFF_TEXT) fail(path, `cannot exceed ${MAX_DIFF_TEXT} characters.`);
    const issueIds = normalizeIds(target.issueIds, `${path}.issueIds`, { minimum: 1, maximum: 64 });
    const unknown = issueIds.filter(issueId => !issueById.has(issueId));
    if (unknown.length > 0) fail(`${path}.issueIds`, 'references unknown review issues.', { issueIds: unknown });
    for (const issueId of issueIds) {
        const issue = issueById.get(issueId);
        if (issue.start < start || issue.end > end) fail(path, 'does not cover every referenced issue.');
    }
    const normalized = {
        start,
        end,
        quote: text(target.quote, `${path}.quote`, MAX_DIFF_TEXT),
        issueIds,
        instruction: text(target.instruction, `${path}.instruction`, 20_000),
    };
    if (sourceText !== undefined && sourceText.slice(start, end) !== normalized.quote) {
        fail(`${path}.quote`, 'does not match context.sourceText.');
    }
    return normalized;
}

function normalizeChapterReview(value, path, context) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'generationId', 'manuscriptArtifactId', 'manuscriptGenerationId',
        'manuscriptDigest', 'verdict', 'rewriteRequired', 'summary', 'issues', 'rewriteTarget', 'coverage',
        'reviewDigest',
    ];
    known(payload, fields, path);
    const sourceText = context.sourceText;
    if (sourceText !== undefined) text(sourceText, 'context.sourceText', MAX_CONTENT_CHARACTERS);
    const issues = array(payload.issues, `${path}.issues`, 0, 128)
        .map((item, index) => normalizeIssue(item, `${path}.issues[${index}]`, sourceText));
    unique(issues.map(issue => issue.id), `${path}.issues.id`);
    const issueById = new Map(issues.map(issue => [issue.id, issue]));
    const withoutDigest = {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        generationId: id(payload.generationId, `${path}.generationId`),
        manuscriptArtifactId: id(payload.manuscriptArtifactId, `${path}.manuscriptArtifactId`),
        manuscriptGenerationId: id(payload.manuscriptGenerationId, `${path}.manuscriptGenerationId`),
        manuscriptDigest: hash(payload.manuscriptDigest, `${path}.manuscriptDigest`),
        verdict: enumValue(payload.verdict, new Set(['pass', 'rewrite']), `${path}.verdict`),
        rewriteRequired: boolean(payload.rewriteRequired, `${path}.rewriteRequired`),
        summary: text(payload.summary, `${path}.summary`, 20_000),
        issues,
        rewriteTarget: normalizeRewriteTarget(payload.rewriteTarget, `${path}.rewriteTarget`, sourceText, issueById),
        coverage: normalizeReviewCoverage(payload.coverage, `${path}.coverage`, new Set(issueById.keys())),
    };
    if ((withoutDigest.verdict === 'rewrite') !== withoutDigest.rewriteRequired
        || withoutDigest.rewriteRequired !== Boolean(withoutDigest.rewriteTarget)) {
        fail(path, 'verdict, rewriteRequired, and rewriteTarget are inconsistent.');
    }
    if (withoutDigest.rewriteRequired && !withoutDigest.rewriteTarget.issueIds.some(issueId => (
        ['blocker', 'major'].includes(issueById.get(issueId).severity)
    ))) {
        fail(`${path}.rewriteTarget.issueIds`, 'must include a blocker or major issue.');
    }
    if (sourceText !== undefined && workflowContractDigest(sourceText) !== withoutDigest.manuscriptDigest) {
        fail(`${path}.manuscriptDigest`, 'does not match context.sourceText.');
    }
    const reviewDigest = hash(payload.reviewDigest, `${path}.reviewDigest`);
    if (reviewDigest !== workflowContractDigest(withoutDigest)) fail(`${path}.reviewDigest`, 'does not match the review.');
    return { ...withoutDigest, reviewDigest };
}

function normalizeTransform(value, path) {
    const transform = plain(value, path);
    known(transform, ['type', 'start', 'end', 'beforeDigest', 'afterDigest', 'issueIds'], path);
    if (transform.type !== 'replace-range-v1') fail(`${path}.type`, 'is unsupported.');
    const start = integer(transform.start, `${path}.start`, 0, MAX_CONTENT_CHARACTERS);
    return {
        type: transform.type,
        start,
        end: integer(transform.end, `${path}.end`, start + 1, MAX_CONTENT_CHARACTERS),
        beforeDigest: hash(transform.beforeDigest, `${path}.beforeDigest`),
        afterDigest: hash(transform.afterDigest, `${path}.afterDigest`),
        issueIds: normalizeIds(transform.issueIds, `${path}.issueIds`, { minimum: 1, maximum: 64 }),
    };
}

function normalizeDiff(value, path) {
    const diff = plain(value, path);
    known(diff, ['format', 'start', 'end', 'before', 'after', 'issueIds'], path);
    if (diff.format !== 'replace-range-v1') fail(`${path}.format`, 'is unsupported.');
    const start = integer(diff.start, `${path}.start`, 0, MAX_CONTENT_CHARACTERS);
    return {
        format: diff.format,
        start,
        end: integer(diff.end, `${path}.end`, start + 1, MAX_CONTENT_CHARACTERS),
        before: text(diff.before, `${path}.before`, MAX_DIFF_TEXT),
        after: text(diff.after, `${path}.after`, MAX_DIFF_TEXT, { required: false }),
        issueIds: normalizeIds(diff.issueIds, `${path}.issueIds`, { minimum: 1, maximum: 64 }),
    };
}

function normalizeRewriteDiff(value, path, context) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'generationId', 'baseManuscriptArtifactId', 'baseGenerationId', 'baseDigest',
        'reviewArtifactId', 'reviewDigest', 'rewriteRequired', 'resultDigest', 'transform', 'diff', 'contentUnits',
    ];
    known(payload, fields, path);
    const normalized = {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        generationId: id(payload.generationId, `${path}.generationId`),
        baseManuscriptArtifactId: id(payload.baseManuscriptArtifactId, `${path}.baseManuscriptArtifactId`),
        baseGenerationId: id(payload.baseGenerationId, `${path}.baseGenerationId`),
        baseDigest: hash(payload.baseDigest, `${path}.baseDigest`),
        reviewArtifactId: id(payload.reviewArtifactId, `${path}.reviewArtifactId`),
        reviewDigest: hash(payload.reviewDigest, `${path}.reviewDigest`),
        rewriteRequired: boolean(payload.rewriteRequired, `${path}.rewriteRequired`),
        resultDigest: hash(payload.resultDigest, `${path}.resultDigest`),
        transform: normalizeTransform(payload.transform, `${path}.transform`),
        diff: normalizeDiff(payload.diff, `${path}.diff`),
        contentUnits: integer(payload.contentUnits, `${path}.contentUnits`, 1, 100_000_000),
    };
    if (!normalized.rewriteRequired) fail(`${path}.rewriteRequired`, 'must be true for a rewrite artifact.');
    if (normalized.transform.start !== normalized.diff.start
        || normalized.transform.end !== normalized.diff.end
        || JSON.stringify(normalized.transform.issueIds) !== JSON.stringify(normalized.diff.issueIds)
        || normalized.transform.beforeDigest !== workflowContractDigest(normalized.diff.before)
        || normalized.transform.afterDigest !== workflowContractDigest(normalized.diff.after)) {
        fail(path, 'transform and diff do not describe the same replacement.');
    }
    if (context.baseText !== undefined) {
        text(context.baseText, 'context.baseText', MAX_CONTENT_CHARACTERS);
        if (workflowContractDigest(context.baseText) !== normalized.baseDigest
            || context.baseText.slice(normalized.diff.start, normalized.diff.end) !== normalized.diff.before) {
            fail(path, 'does not match context.baseText.');
        }
        const expectedResult = `${context.baseText.slice(0, normalized.diff.start)}${normalized.diff.after}`
            + context.baseText.slice(normalized.diff.end);
        if (context.resultText !== undefined && context.resultText !== expectedResult) {
            fail(path, 'context.resultText is not the declared replacement result.');
        }
        if (workflowContractDigest(context.resultText ?? expectedResult) !== normalized.resultDigest) {
            fail(`${path}.resultDigest`, 'does not match the replacement result.');
        }
    }
    return normalized;
}

function normalizeStoryStateChanges(value, path) {
    const changes = plain(value, path);
    known(changes, STORY_STATE_CATEGORIES, path);
    return Object.fromEntries(STORY_STATE_CATEGORIES.map(category => {
        const categoryPath = `${path}.${category}`;
        const operation = plain(changes[category], categoryPath);
        known(operation, ['upsert', 'delete'], categoryPath);
        const upsert = array(operation.upsert, `${categoryPath}.upsert`, 0, 10_000)
            .map((item, index) => jsonClone(plain(item, `${categoryPath}.upsert[${index}]`),
                `${categoryPath}.upsert[${index}]`));
        const deletes = normalizeIds(operation.delete, `${categoryPath}.delete`, { minimum: 0, maximum: 10_000 });
        return [category, { upsert, delete: deletes }];
    }));
}

function normalizeAuthorityFingerprint(value, path) {
    const fingerprint = plain(value, path);
    known(fingerprint, ['projectDigest', 'chapterDigest'], path);
    return {
        projectDigest: hash(fingerprint.projectDigest, `${path}.projectDigest`),
        chapterDigest: hash(fingerprint.chapterDigest, `${path}.chapterDigest`),
    };
}

function normalizeChapterAdoption(value, path) {
    const payload = plain(value, path);
    const fields = [
        'payloadVersion', 'manuscriptArtifactId', 'manuscriptGenerationId', 'manuscriptDigest',
        'directionArtifactId', 'planArtifactId', 'planDigest', 'reviewArtifactId', 'reviewDigest',
        'rewriteArtifactId', 'chapterCard', 'chapterSummary', 'storyStateChanges', 'targetStoryStateDigest',
        'changesDigest', 'adoptionDigest', 'authorityFingerprint',
    ];
    known(payload, fields, path);
    const chapterCard = normalizeChapterCard(payload.chapterCard, `${path}.chapterCard`);
    const chapterSummary = text(payload.chapterSummary, `${path}.chapterSummary`, 20_000);
    if (chapterCard.summary !== chapterSummary) fail(`${path}.chapterSummary`, 'must equal chapterCard.summary.');
    const storyStateChanges = normalizeStoryStateChanges(payload.storyStateChanges, `${path}.storyStateChanges`);
    const changesDigest = hash(payload.changesDigest, `${path}.changesDigest`);
    if (changesDigest !== workflowContractDigest({ chapterSummary, storyStateChanges })) {
        fail(`${path}.changesDigest`, 'does not match the proposed changes.');
    }
    const withoutAdoptionDigest = {
        payloadVersion: payloadVersion(payload.payloadVersion, `${path}.payloadVersion`),
        manuscriptArtifactId: id(payload.manuscriptArtifactId, `${path}.manuscriptArtifactId`),
        manuscriptGenerationId: id(payload.manuscriptGenerationId, `${path}.manuscriptGenerationId`),
        manuscriptDigest: hash(payload.manuscriptDigest, `${path}.manuscriptDigest`),
        directionArtifactId: id(payload.directionArtifactId, `${path}.directionArtifactId`),
        planArtifactId: id(payload.planArtifactId, `${path}.planArtifactId`),
        planDigest: hash(payload.planDigest, `${path}.planDigest`),
        reviewArtifactId: id(payload.reviewArtifactId, `${path}.reviewArtifactId`),
        reviewDigest: hash(payload.reviewDigest, `${path}.reviewDigest`),
        rewriteArtifactId: payload.rewriteArtifactId === null
            ? null
            : id(payload.rewriteArtifactId, `${path}.rewriteArtifactId`),
        chapterCard,
        chapterSummary,
        storyStateChanges,
        targetStoryStateDigest: hash(payload.targetStoryStateDigest, `${path}.targetStoryStateDigest`),
        changesDigest,
        authorityFingerprint: normalizeAuthorityFingerprint(payload.authorityFingerprint,
            `${path}.authorityFingerprint`),
    };
    const adoptionDigest = hash(payload.adoptionDigest, `${path}.adoptionDigest`);
    if (adoptionDigest !== workflowContractDigest(withoutAdoptionDigest)) {
        fail(`${path}.adoptionDigest`, 'does not match the adoption bundle.');
    }
    return { ...withoutAdoptionDigest, adoptionDigest };
}

export function normalizeWorkflowV2ArtifactPayload(kind, value, context = {}) {
    if (!WORKFLOW_V2_ARTIFACT_KINDS.includes(kind)) {
        fail('kind', 'is not a Workflow V2 artifact kind.', { kind });
    }
    plain(context, 'context');
    switch (kind) {
        case 'brainstorm-direction': return normalizeBrainstormDirection(value, 'payload');
        case 'chapter-plan': return normalizeChapterPlan(value, 'payload');
        case 'chapter-draft': return normalizeChapterDraft(value, 'payload', context);
        case 'chapter-review': return normalizeChapterReview(value, 'payload', context);
        case 'rewrite-diff': return normalizeRewriteDiff(value, 'payload', context);
        case 'chapter-adoption': return normalizeChapterAdoption(value, 'payload');
        default: fail('kind', 'is unsupported.', { kind });
    }
}
