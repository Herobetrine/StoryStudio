import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError } from './api-error.js';
import {
    BUILTIN_WORKFLOW_DEFINITIONS,
    WORKFLOW_ARTIFACT_KINDS,
    hashWorkflowDefinition,
    normalizeWorkflowDefinition,
} from './workflow-schema.js';

export const WORKFLOW_RUN_SCHEMA_VERSION = 1;
export const WORKFLOW_ARTIFACT_SCHEMA_VERSION = 1;
export const WORKFLOW_RECEIPT_SCHEMA_VERSION = 1;

export const WORKFLOW_RUN_STATUSES = Object.freeze([
    'running', 'waiting_approval', 'completed', 'failed', 'cancelled',
]);
export const WORKFLOW_STEP_STATUSES = Object.freeze([
    'pending', 'ready', 'running', 'candidate_ready', 'waiting_approval',
    'completed', 'skipped', 'failed', 'cancelled',
]);
export const WORKFLOW_ARTIFACT_STATUSES = Object.freeze([
    'candidate', 'approved', 'applied', 'rejected', 'superseded',
]);
export const WORKFLOW_ARTIFACT_TARGETS = Object.freeze([
    'workflow-run', 'chapter-card', 'chapter-draft', 'chapter-content', 'state-change-set',
    'story-state', 'chapter-review', 'review-changes', 'chapter-quality', 'closeout',
]);

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const DEFINITION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const COMMAND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const EVIDENCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const COMMAND_TYPE = /^[a-z][a-z0-9-]{0,63}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_IDS = 512;

const RUN_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'projectId', 'definitionId', 'definitionHash', 'chapterId',
    'status', 'revision', 'currentStepId', 'steps', 'input', 'createdAt', 'updatedAt',
    'completedAt', 'lastCommand', 'recordHash',
]);
const RUN_STEP_FIELDS = Object.freeze([
    'id', 'status', 'attempt', 'artifactIds', 'startedAt', 'updatedAt', 'completedAt', 'error',
]);
const LAST_COMMAND_FIELDS = Object.freeze([
    'id', 'digest', 'type', 'expectedRevision', 'committedRevision', 'response', 'committedAt',
]);
const ARTIFACT_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'projectId', 'runId', 'stepId', 'kind', 'source', 'status',
    'revision', 'target', 'base', 'payload', 'evidenceIds', 'createdAt', 'updatedAt', 'approvedAt',
    'appliedAt', 'rejectedAt', 'recordHash',
]);
const ARTIFACT_TARGET_FIELDS = Object.freeze([
    'type', 'chapterId', 'projectVersion', 'chapterRevision', 'digest',
]);
const ARTIFACT_BASE_FIELDS = Object.freeze(['projectVersion', 'chapterRevision']);
const RECEIPT_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'projectId', 'runId', 'type', 'commandDigest', 'expectedRevision',
    'committedRevision', 'response', 'createdAt', 'recordHash',
]);
const ARTIFACT_CREATE_FIELDS = Object.freeze([
    'artifactId', 'projectId', 'runId', 'stepId', 'kind', 'source', 'target', 'base', 'payload', 'evidenceIds',
]);
const COMMIT_FIELDS = Object.freeze([
    'projectId', 'runId', 'commandId', 'expectedRevision', 'type', 'payload', 'mutate',
]);
const TRANSITION_STEP_FIELDS = Object.freeze([
    'projectId', 'runId', 'commandId', 'expectedRevision', 'stepId', 'status',
    'artifactIds', 'error', 'type', 'payload', 'response',
]);

const STEP_TRANSITIONS = Object.freeze({
    pending: new Set(['ready', 'skipped', 'cancelled']),
    ready: new Set(['running', 'candidate_ready', 'waiting_approval', 'completed', 'skipped', 'failed', 'cancelled']),
    running: new Set(['candidate_ready', 'waiting_approval', 'completed', 'failed', 'cancelled']),
    candidate_ready: new Set(['completed', 'failed', 'cancelled']),
    waiting_approval: new Set(['completed', 'failed', 'cancelled']),
    failed: new Set(['ready', 'cancelled']),
    completed: new Set(),
    skipped: new Set(),
    cancelled: new Set(),
});
const RUN_TRANSITIONS = Object.freeze({
    running: new Set(['running', 'waiting_approval', 'completed', 'failed', 'cancelled']),
    waiting_approval: new Set(['running', 'waiting_approval', 'failed', 'cancelled']),
    failed: new Set(['running', 'failed', 'cancelled']),
    completed: new Set(),
    cancelled: new Set(),
});
const ARTIFACT_TRANSITIONS = Object.freeze({
    candidate: new Set(['approved', 'rejected', 'superseded']),
    approved: new Set(['applied', 'rejected', 'superseded']),
    applied: new Set(),
    rejected: new Set(),
    superseded: new Set(),
});
const SUCCESSFUL_STEP_STATUSES = new Set(['completed', 'skipped']);
const ACTIVE_STEP_STATUSES = new Set(['ready', 'running', 'candidate_ready', 'waiting_approval', 'failed']);

function bad(message, code = 'invalid_workflow', details = {}) {
    throw new ApiError(400, code, message, details);
}

function conflict(message, code = 'workflow_conflict', details = {}) {
    throw new ApiError(409, code, message, details);
}

function storageFailure(message, code = 'workflow_storage_corrupt', details = {}) {
    throw new ApiError(500, code, message, details);
}

function assertPlainObject(value, label, { status = 400 } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        if (status === 500) storageFailure(`${label} must be a plain object.`);
        bad(`${label} must be a plain object.`);
    }
    return value;
}

function assertKnownFields(value, fields, label, { status = 400 } = {}) {
    const unknown = Object.keys(value).filter(key => !fields.includes(key));
    if (unknown.length === 0) return;
    if (status === 500) storageFailure(`${label} contains unknown fields.`, 'workflow_storage_corrupt', { fields: unknown });
    bad(`${label} contains unknown fields.`, 'unknown_workflow_fields', { fields: unknown });
}

function cleanId(value, label, pattern = SAFE_ID, { status = 400 } = {}) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        if (status === 500) storageFailure(`${label} is invalid.`);
        bad(`${label} is invalid.`, 'invalid_workflow_id', { field: label });
    }
    return value;
}

function cleanText(value, label, maximum, { status = 400, required = false } = {}) {
    if (typeof value !== 'string' || value.length > maximum || (required && value.length === 0)) {
        if (status === 500) storageFailure(`${label} is invalid.`);
        bad(`${label} must be ${required ? 'a non-empty ' : 'a '}string no longer than ${maximum} characters.`);
    }
    return value;
}

function cleanIso(value, label, { nullable = false, status = 400 } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
        if (status === 500) storageFailure(`${label} is invalid.`);
        bad(`${label} must be an ISO date-time string.`);
    }
    return value;
}

function assertJson(value, label, maximum, { status = 400 } = {}) {
    const reject = (message, code = 'invalid_workflow_payload', details = {}) => {
        if (status === 500) storageFailure(message, 'workflow_storage_corrupt', details);
        bad(message, code, details);
    };
    let nodes = 0;
    const visit = (item, depth) => {
        nodes += 1;
        if (nodes > 100_000 || depth > 64) reject(`${label} is too complex.`, 'workflow_payload_too_large');
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (Array.isArray(item)) {
            for (const child of item) visit(child, depth + 1);
            return;
        }
        if (item && typeof item === 'object'
            && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
            for (const [key, child] of Object.entries(item)) {
                if (FORBIDDEN_KEYS.has(key)) reject(`${label} contains a forbidden key.`);
                visit(child, depth + 1);
            }
            return;
        }
        reject(`${label} must contain only JSON values.`);
    };
    visit(value, 0);
    let json;
    try {
        json = JSON.stringify(value);
    } catch {
        reject(`${label} must be JSON serializable.`);
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > maximum) reject(`${label} is too large.`, 'workflow_payload_too_large', { maximum });
    return JSON.parse(json);
}

function stableNormalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableNormalize);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key])]));
}

function stableJson(value) {
    return JSON.stringify(stableNormalize(value));
}

function digest(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function recordPayload(record) {
    const { recordHash: ignored, ...payload } = record;
    return payload;
}

function sealRecord(record) {
    const payload = recordPayload(record);
    return { ...payload, recordHash: digest(payload) };
}

function verifyRecordHash(record, label) {
    if (typeof record.recordHash !== 'string' || !HASH.test(record.recordHash)
        || record.recordHash !== digest(recordPayload(record))) {
        storageFailure(`${label} failed its integrity check.`, 'workflow_storage_tampered');
    }
}

function clone(value) {
    return structuredClone(value);
}

function normalizeEvidenceIds(value, { status = 400 } = {}) {
    if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) {
        if (status === 500) storageFailure('artifact.evidenceIds is invalid.');
        bad(`evidenceIds must contain at most ${MAX_EVIDENCE_IDS} identifiers.`);
    }
    const result = value.map(item => cleanId(item, 'evidenceId', EVIDENCE_ID, { status }));
    if (new Set(result).size !== result.length) {
        if (status === 500) storageFailure('artifact.evidenceIds contains duplicates.');
        bad('evidenceIds contains duplicates.');
    }
    return result;
}

function normalizeArtifactTarget(value, { status = 400 } = {}) {
    const target = assertPlainObject(value, 'artifact.target', { status });
    assertKnownFields(target, ARTIFACT_TARGET_FIELDS, 'artifact.target', { status });
    if (!WORKFLOW_ARTIFACT_TARGETS.includes(target.type)) {
        if (status === 500) storageFailure('artifact.target.type is invalid.');
        bad('artifact.target.type is invalid.', 'invalid_workflow_artifact_target');
    }
    const projectVersion = target.projectVersion ?? null;
    const chapterRevision = target.chapterRevision ?? null;
    const targetDigest = target.digest ?? null;
    if ((projectVersion !== null && (!Number.isInteger(projectVersion) || projectVersion < 1))
        || (chapterRevision !== null && (!Number.isInteger(chapterRevision) || chapterRevision < 1))
        || (targetDigest !== null && (typeof targetDigest !== 'string' || !HASH.test(targetDigest)))
        || ((projectVersion === null) !== (chapterRevision === null))) {
        if (status === 500) storageFailure('artifact.target authority coordinates are invalid.');
        bad('artifact.target versions must be null together or positive integers, and digest must be null or SHA-256.',
            'invalid_workflow_artifact_target');
    }
    return {
        type: target.type,
        chapterId: cleanId(target.chapterId, 'artifact.target.chapterId', SAFE_ID, { status }),
        projectVersion,
        chapterRevision,
        digest: targetDigest,
    };
}

function normalizeArtifactBase(value, { status = 400 } = {}) {
    const base = assertPlainObject(value, 'artifact.base', { status });
    assertKnownFields(base, ARTIFACT_BASE_FIELDS, 'artifact.base', { status });
    if (!Number.isInteger(base.projectVersion) || base.projectVersion < 1
        || !Number.isInteger(base.chapterRevision) || base.chapterRevision < 1) {
        if (status === 500) storageFailure('artifact.base versions are invalid.');
        bad('artifact.base projectVersion and chapterRevision must be positive integers.',
            'invalid_workflow_artifact_base');
    }
    return {
        projectVersion: base.projectVersion,
        chapterRevision: base.chapterRevision,
    };
}

function normalizeLastCommand(value, { status = 500 } = {}) {
    if (value === null) return null;
    const command = assertPlainObject(value, 'run.lastCommand', { status });
    assertKnownFields(command, LAST_COMMAND_FIELDS, 'run.lastCommand', { status });
    const id = cleanId(command.id, 'run.lastCommand.id', COMMAND_ID, { status });
    const type = cleanId(command.type, 'run.lastCommand.type', COMMAND_TYPE, { status });
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1
        || command.committedRevision !== command.expectedRevision + 1) {
        if (status === 500) storageFailure('run.lastCommand revisions are invalid.');
        bad('run.lastCommand revisions are invalid.');
    }
    if (typeof command.digest !== 'string' || !HASH.test(command.digest)) {
        if (status === 500) storageFailure('run.lastCommand.digest is invalid.');
        bad('run.lastCommand.digest is invalid.');
    }
    return {
        id,
        digest: command.digest,
        type,
        expectedRevision: command.expectedRevision,
        committedRevision: command.committedRevision,
        response: assertJson(command.response, 'run.lastCommand.response', MAX_RESPONSE_BYTES, { status }),
        committedAt: cleanIso(command.committedAt, 'run.lastCommand.committedAt', { status }),
    };
}

export function normalizeWorkflowRun(value, { requireHash = false } = {}) {
    const statusCode = requireHash ? 500 : 400;
    const run = assertPlainObject(value, 'workflow run', { status: statusCode });
    assertKnownFields(run, RUN_FIELDS, 'workflow run', { status: statusCode });
    if (run.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION) {
        if (requireHash) storageFailure('Stored workflow run schema is unsupported.');
        bad('Workflow run schema is unsupported.');
    }
    if (!WORKFLOW_RUN_STATUSES.includes(run.status)) {
        if (requireHash) storageFailure('Stored workflow run status is invalid.');
        bad('Workflow run status is invalid.');
    }
    if (!Number.isInteger(run.revision) || run.revision < 1) {
        if (requireHash) storageFailure('Stored workflow run revision is invalid.');
        bad('Workflow run revision is invalid.');
    }
    if (!Array.isArray(run.steps) || run.steps.length < 1 || run.steps.length > 64) {
        if (requireHash) storageFailure('Stored workflow run steps are invalid.');
        bad('Workflow run steps are invalid.');
    }
    const steps = run.steps.map((item, index) => {
        const step = assertPlainObject(item, `run.steps[${index}]`, { status: statusCode });
        assertKnownFields(step, RUN_STEP_FIELDS, `run.steps[${index}]`, { status: statusCode });
        if (!WORKFLOW_STEP_STATUSES.includes(step.status)
            || !Number.isInteger(step.attempt) || step.attempt < 0 || step.attempt > 10_000
            || !Array.isArray(step.artifactIds) || step.artifactIds.length > 512) {
            if (requireHash) storageFailure(`Stored run step ${index} is invalid.`);
            bad(`run.steps[${index}] is invalid.`);
        }
        const artifactIds = step.artifactIds.map(id => cleanId(id, `run.steps[${index}].artifactId`, SAFE_ID, {
            status: statusCode,
        }));
        if (new Set(artifactIds).size !== artifactIds.length) {
            if (requireHash) storageFailure(`Stored run step ${index} has duplicate artifact ids.`);
            bad(`run.steps[${index}] has duplicate artifact ids.`);
        }
        return {
            id: cleanId(step.id, `run.steps[${index}].id`, SAFE_ID, { status: statusCode }),
            status: step.status,
            attempt: step.attempt,
            artifactIds,
            startedAt: cleanIso(step.startedAt, `run.steps[${index}].startedAt`, { nullable: true, status: statusCode }),
            updatedAt: cleanIso(step.updatedAt, `run.steps[${index}].updatedAt`, { status: statusCode }),
            completedAt: cleanIso(step.completedAt, `run.steps[${index}].completedAt`, { nullable: true, status: statusCode }),
            error: cleanText(step.error, `run.steps[${index}].error`, 20_000, { status: statusCode }),
        };
    });
    if (new Set(steps.map(step => step.id)).size !== steps.length) {
        if (requireHash) storageFailure('Stored workflow run has duplicate step ids.');
        bad('Workflow run has duplicate step ids.');
    }
    const currentStepId = run.currentStepId === null
        ? null
        : cleanId(run.currentStepId, 'run.currentStepId', SAFE_ID, { status: statusCode });
    const normalized = {
        schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
        id: cleanId(run.id, 'run.id', SAFE_ID, { status: statusCode }),
        projectId: cleanId(run.projectId, 'run.projectId', SAFE_ID, { status: statusCode }),
        definitionId: cleanId(run.definitionId, 'run.definitionId', DEFINITION_ID, { status: statusCode }),
        definitionHash: cleanId(run.definitionHash, 'run.definitionHash', HASH, { status: statusCode }),
        chapterId: cleanId(run.chapterId, 'run.chapterId', SAFE_ID, { status: statusCode }),
        status: run.status,
        revision: run.revision,
        currentStepId,
        steps,
        input: assertJson(run.input, 'run.input', MAX_INPUT_BYTES, { status: statusCode }),
        createdAt: cleanIso(run.createdAt, 'run.createdAt', { status: statusCode }),
        updatedAt: cleanIso(run.updatedAt, 'run.updatedAt', { status: statusCode }),
        completedAt: cleanIso(run.completedAt, 'run.completedAt', { nullable: true, status: statusCode }),
        lastCommand: normalizeLastCommand(run.lastCommand, { status: statusCode }),
    };
    if (normalized.lastCommand && normalized.lastCommand.committedRevision !== normalized.revision) {
        if (requireHash) storageFailure('Stored workflow run lastCommand does not match its revision.');
        bad('Workflow run lastCommand does not match its revision.');
    }
    if (requireHash) verifyRecordHash(run, 'Stored workflow run');
    return sealRecord(normalized);
}

export function normalizeWorkflowArtifact(value, { requireHash = false } = {}) {
    const statusCode = requireHash ? 500 : 400;
    const artifact = assertPlainObject(value, 'workflow artifact', { status: statusCode });
    assertKnownFields(artifact, ARTIFACT_FIELDS, 'workflow artifact', { status: statusCode });
    if (artifact.schemaVersion !== WORKFLOW_ARTIFACT_SCHEMA_VERSION
        || !WORKFLOW_ARTIFACT_STATUSES.includes(artifact.status)
        || !WORKFLOW_ARTIFACT_KINDS.includes(artifact.kind)
        || !['model', 'system', 'user'].includes(artifact.source)
        || !Number.isInteger(artifact.revision) || artifact.revision < 1) {
        if (requireHash) storageFailure('Stored workflow artifact is invalid.');
        bad('Workflow artifact is invalid.');
    }
    if (artifact.source === 'model' && artifact.revision === 1 && artifact.status !== 'candidate') {
        if (requireHash) storageFailure('Stored model artifact bypassed candidate state.');
        bad('Model output can only be created as a candidate.', 'unsafe_model_artifact');
    }
    const normalized = {
        schemaVersion: WORKFLOW_ARTIFACT_SCHEMA_VERSION,
        id: cleanId(artifact.id, 'artifact.id', SAFE_ID, { status: statusCode }),
        projectId: cleanId(artifact.projectId, 'artifact.projectId', SAFE_ID, { status: statusCode }),
        runId: cleanId(artifact.runId, 'artifact.runId', SAFE_ID, { status: statusCode }),
        stepId: cleanId(artifact.stepId, 'artifact.stepId', SAFE_ID, { status: statusCode }),
        kind: artifact.kind,
        source: artifact.source,
        status: artifact.status,
        revision: artifact.revision,
        target: normalizeArtifactTarget(artifact.target, { status: statusCode }),
        base: normalizeArtifactBase(artifact.base, { status: statusCode }),
        payload: assertJson(artifact.payload, 'artifact.payload', MAX_ARTIFACT_BYTES, { status: statusCode }),
        evidenceIds: normalizeEvidenceIds(artifact.evidenceIds, { status: statusCode }),
        createdAt: cleanIso(artifact.createdAt, 'artifact.createdAt', { status: statusCode }),
        updatedAt: cleanIso(artifact.updatedAt, 'artifact.updatedAt', { status: statusCode }),
        approvedAt: cleanIso(artifact.approvedAt, 'artifact.approvedAt', { nullable: true, status: statusCode }),
        appliedAt: cleanIso(artifact.appliedAt, 'artifact.appliedAt', { nullable: true, status: statusCode }),
        rejectedAt: cleanIso(artifact.rejectedAt, 'artifact.rejectedAt', { nullable: true, status: statusCode }),
    };
    if (normalized.status === 'candidate'
        && [normalized.approvedAt, normalized.appliedAt, normalized.rejectedAt].some(Boolean)) {
        if (requireHash) storageFailure('Stored candidate artifact has impossible timestamps.');
        bad('Candidate artifact has impossible timestamps.');
    }
    if (normalized.status === 'approved' && !normalized.approvedAt) {
        if (requireHash) storageFailure('Stored approved artifact has no approval timestamp.');
        bad('Approved artifact requires approvedAt.');
    }
    if (normalized.status === 'applied' && (!normalized.approvedAt || !normalized.appliedAt)) {
        if (requireHash) storageFailure('Stored applied artifact lacks approval evidence.');
        bad('Applied artifact requires prior approval.');
    }
    const targetRecorded = normalized.target.projectVersion !== null
        && normalized.target.chapterRevision !== null
        && normalized.target.digest !== null;
    if (normalized.status === 'applied' && !targetRecorded) {
        if (requireHash) storageFailure('Stored applied artifact lacks authoritative target evidence.');
        bad('Applied artifact requires target versions and digest.', 'invalid_workflow_artifact_target');
    }
    if (normalized.status !== 'applied'
        && (normalized.target.projectVersion !== null
            || normalized.target.chapterRevision !== null
            || normalized.target.digest !== null)) {
        if (requireHash) storageFailure('Stored unapplied artifact claims authoritative target evidence.');
        bad('Only an applied artifact may record authoritative target evidence.', 'invalid_workflow_artifact_target');
    }
    if (normalized.status === 'rejected' && !normalized.rejectedAt) {
        if (requireHash) storageFailure('Stored rejected artifact has no rejection timestamp.');
        bad('Rejected artifact requires rejectedAt.');
    }
    if (requireHash) verifyRecordHash(artifact, 'Stored workflow artifact');
    return sealRecord(normalized);
}

export function normalizeWorkflowReceipt(value, { requireHash = false } = {}) {
    const statusCode = requireHash ? 500 : 400;
    const receipt = assertPlainObject(value, 'workflow receipt', { status: statusCode });
    assertKnownFields(receipt, RECEIPT_FIELDS, 'workflow receipt', { status: statusCode });
    if (receipt.schemaVersion !== WORKFLOW_RECEIPT_SCHEMA_VERSION
        || !Number.isInteger(receipt.expectedRevision) || receipt.expectedRevision < 1
        || receipt.committedRevision !== receipt.expectedRevision + 1) {
        if (requireHash) storageFailure('Stored workflow receipt is invalid.');
        bad('Workflow receipt is invalid.');
    }
    const normalized = {
        schemaVersion: WORKFLOW_RECEIPT_SCHEMA_VERSION,
        id: cleanId(receipt.id, 'receipt.id', COMMAND_ID, { status: statusCode }),
        projectId: cleanId(receipt.projectId, 'receipt.projectId', SAFE_ID, { status: statusCode }),
        runId: cleanId(receipt.runId, 'receipt.runId', SAFE_ID, { status: statusCode }),
        type: cleanId(receipt.type, 'receipt.type', COMMAND_TYPE, { status: statusCode }),
        commandDigest: cleanId(receipt.commandDigest, 'receipt.commandDigest', HASH, { status: statusCode }),
        expectedRevision: receipt.expectedRevision,
        committedRevision: receipt.committedRevision,
        response: assertJson(receipt.response, 'receipt.response', MAX_RESPONSE_BYTES, { status: statusCode }),
        createdAt: cleanIso(receipt.createdAt, 'receipt.createdAt', { status: statusCode }),
    };
    if (requireHash) verifyRecordHash(receipt, 'Stored workflow receipt');
    return sealRecord(normalized);
}

function validateRunAgainstDefinition(run, definition) {
    if (run.definitionId !== definition.id || run.definitionHash !== definition.definitionHash
        || run.steps.length !== definition.steps.length) {
        storageFailure('Workflow run does not match its pinned definition.', 'workflow_definition_mismatch');
    }
    const states = new Map(run.steps.map(step => [step.id, step]));
    for (let index = 0; index < definition.steps.length; index += 1) {
        const declared = definition.steps[index];
        const state = run.steps[index];
        if (state.id !== declared.id) {
            storageFailure('Workflow run step order does not match its definition.', 'workflow_definition_mismatch');
        }
        if (!['pending', 'cancelled'].includes(state.status)) {
            for (const dependency of declared.dependsOn) {
                if (!SUCCESSFUL_STEP_STATUSES.has(states.get(dependency)?.status)) {
                    storageFailure('Workflow run advanced before its dependencies completed.', 'invalid_workflow_state', {
                        stepId: state.id,
                        dependency,
                    });
                }
            }
        }
    }
    const active = run.steps.filter(step => ACTIVE_STEP_STATUSES.has(step.status));
    if (['completed', 'cancelled'].includes(run.status)) {
        if (run.currentStepId !== null || active.length > 0) {
            storageFailure('Terminal workflow run retains an active step.', 'invalid_workflow_state');
        }
    } else if (active.length !== 1 || run.currentStepId !== active[0].id) {
        storageFailure('Workflow run must have exactly one current active step.', 'invalid_workflow_state');
    }
    if (run.status === 'waiting_approval' && active[0]?.status !== 'waiting_approval') {
        storageFailure('Workflow run approval state is inconsistent.', 'invalid_workflow_state');
    }
    if (run.status === 'failed' && active[0]?.status !== 'failed') {
        storageFailure('Workflow run failure state is inconsistent.', 'invalid_workflow_state');
    }
    if (run.status === 'running' && !['ready', 'running', 'candidate_ready'].includes(active[0]?.status)) {
        storageFailure('Workflow run active state is inconsistent.', 'invalid_workflow_state');
    }
    if (run.status === 'completed'
        && run.steps.some(step => !SUCCESSFUL_STEP_STATUSES.has(step.status))) {
        storageFailure('Completed workflow run contains unfinished steps.', 'invalid_workflow_state');
    }
}

function validateRunTransition(before, after, definition) {
    for (const field of ['id', 'projectId', 'definitionId', 'definitionHash', 'chapterId', 'createdAt']) {
        if (stableJson(before[field]) !== stableJson(after[field])) {
            storageFailure(`Workflow mutation changed immutable field ${field}.`, 'unsafe_workflow_mutation');
        }
    }
    if (stableJson(before.input) !== stableJson(after.input) || before.steps.length !== after.steps.length) {
        storageFailure('Workflow mutation changed immutable run input or step topology.', 'unsafe_workflow_mutation');
    }
    if (!RUN_TRANSITIONS[before.status]?.has(after.status)) {
        conflict(`Workflow run cannot transition from ${before.status} to ${after.status}.`, 'invalid_workflow_transition');
    }
    for (let index = 0; index < before.steps.length; index += 1) {
        const previous = before.steps[index];
        const next = after.steps[index];
        if (previous.id !== next.id || next.attempt < previous.attempt || next.attempt > previous.attempt + 1) {
            storageFailure('Workflow mutation changed immutable step identity or invalid attempt count.', 'unsafe_workflow_mutation');
        }
        if (previous.status !== next.status && !STEP_TRANSITIONS[previous.status]?.has(next.status)) {
            conflict(`Workflow step ${previous.id} cannot transition from ${previous.status} to ${next.status}.`,
                'invalid_workflow_transition');
        }
        if (next.artifactIds.length < previous.artifactIds.length
            || previous.artifactIds.some((id, artifactIndex) => next.artifactIds[artifactIndex] !== id)) {
            storageFailure('Workflow mutation removed or reordered artifact evidence.', 'unsafe_workflow_mutation');
        }
    }
    validateRunAgainstDefinition(after, definition);
}

function runSummary(run) {
    return {
        id: run.id,
        projectId: run.projectId,
        definitionId: run.definitionId,
        definitionHash: run.definitionHash,
        chapterId: run.chapterId,
        status: run.status,
        revision: run.revision,
        currentStepId: run.currentStepId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
    };
}

export class WorkflowStore {
    constructor(rootDirectory) {
        if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
            throw new TypeError('WorkflowStore requires a root directory.');
        }
        this.rootDirectory = path.resolve(rootDirectory);
        fs.mkdirSync(this.rootDirectory, { recursive: true });
        const rootStat = fs.lstatSync(this.rootDirectory);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
            storageFailure('Workflow storage root must be a real directory.', 'unsafe_workflow_path');
        }
        this.definitionsDirectory = this.safePath('definitions');
        this.projectsDirectory = this.safePath('projects');
        this.receiptsDirectory = this.safePath('receipts');
        for (const directory of [
            this.definitionsDirectory, this.projectsDirectory, this.receiptsDirectory,
        ]) this.ensureDirectory(directory);
        this.ensureBuiltinDefinitions();
    }

    safePath(...segments) {
        const result = path.resolve(this.rootDirectory, ...segments);
        if (result !== this.rootDirectory && !result.startsWith(`${this.rootDirectory}${path.sep}`)) {
            storageFailure('Workflow storage path escaped its root.', 'unsafe_workflow_path');
        }
        this.assertNoLinks(result);
        return result;
    }

    assertNoLinks(target) {
        const relative = path.relative(this.rootDirectory, target);
        let current = this.rootDirectory;
        if (!relative) return;
        for (const segment of relative.split(path.sep)) {
            current = path.join(current, segment);
            if (!fs.existsSync(current)) continue;
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) {
                storageFailure('Workflow storage cannot traverse symbolic links or junctions.', 'unsafe_workflow_path');
            }
        }
    }

    ensureDirectory(directory) {
        this.assertNoLinks(directory);
        fs.mkdirSync(directory, { recursive: true });
        this.assertNoLinks(directory);
        if (!fs.lstatSync(directory).isDirectory()) {
            storageFailure('Workflow storage path is not a directory.', 'unsafe_workflow_path');
        }
    }

    writeJson(filePath, value) {
        this.ensureDirectory(path.dirname(filePath));
        if (fs.existsSync(filePath)) {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                storageFailure('Workflow record path is unsafe.', 'unsafe_workflow_path');
            }
        }
        const json = JSON.stringify(value, null, 2);
        if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
            bad('Workflow record exceeds the storage limit.', 'workflow_payload_too_large');
        }
        writeFileAtomicSync(filePath, json, { encoding: 'utf8', mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (error) {
            if (process.platform !== 'win32') throw error;
        }
    }

    readJson(filePath, label) {
        this.assertNoLinks(filePath);
        if (!fs.existsSync(filePath)) return null;
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES) {
            storageFailure(`${label} path or size is invalid.`, 'unsafe_workflow_path');
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            storageFailure(`${label} is invalid JSON.`);
        }
    }

    definitionPath(definitionId) {
        const id = cleanId(definitionId, 'definitionId', DEFINITION_ID);
        return this.safePath('definitions', `${id}.json`);
    }

    runPath(projectId, runId) {
        const project = cleanId(projectId, 'projectId');
        const run = cleanId(runId, 'runId');
        return this.safePath('projects', project, 'runs', run, 'run.json');
    }

    artifactPath(projectId, runId, artifactId) {
        const project = cleanId(projectId, 'projectId');
        const run = cleanId(runId, 'runId');
        const id = cleanId(artifactId, 'artifactId');
        return this.safePath('projects', project, 'runs', run, 'artifacts', `${id}.json`);
    }

    receiptPath(commandId) {
        const id = cleanId(commandId, 'commandId', COMMAND_ID);
        return this.safePath('receipts', `${id}.json`);
    }

    ensureBuiltinDefinitions() {
        for (const source of BUILTIN_WORKFLOW_DEFINITIONS) {
            const filePath = this.definitionPath(source.id);
            if (!fs.existsSync(filePath)) {
                this.writeJson(filePath, source);
                continue;
            }
            const current = this.getDefinition(source.id);
            if (current.definitionHash !== source.definitionHash) {
                storageFailure('Built-in workflow definition was modified.', 'workflow_definition_tampered', {
                    definitionId: source.id,
                });
            }
        }
    }

    listDefinitions() {
        this.assertNoLinks(this.definitionsDirectory);
        return fs.readdirSync(this.definitionsDirectory, { withFileTypes: true })
            .filter(entry => entry.isFile() && DEFINITION_ID.test(entry.name.slice(0, -5)) && entry.name.endsWith('.json'))
            .map(entry => this.getDefinition(entry.name.slice(0, -5)))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    getDefinition(definitionId) {
        const filePath = this.definitionPath(definitionId);
        const value = this.readJson(filePath, 'Workflow definition');
        if (!value) throw new ApiError(404, 'workflow_definition_not_found', 'Workflow definition not found.');
        assertPlainObject(value, 'Stored workflow definition', { status: 500 });
        if (typeof value.definitionHash !== 'string' || !HASH.test(value.definitionHash)
            || hashWorkflowDefinition(value) !== value.definitionHash) {
            storageFailure('Stored workflow definition failed its integrity check.',
                'workflow_definition_tampered');
        }
        const definition = normalizeWorkflowDefinition(value, { requireHash: true });
        if (definition.id !== definitionId) {
            storageFailure('Workflow definition identity does not match its path.', 'workflow_storage_tampered');
        }
        return definition;
    }

    saveDefinition(value) {
        const definition = normalizeWorkflowDefinition(value);
        if (definition.id.startsWith('builtin.')) {
            conflict('The builtin workflow namespace is reserved.', 'reserved_workflow_definition');
        }
        const filePath = this.definitionPath(definition.id);
        if (fs.existsSync(filePath)) {
            const current = this.getDefinition(definition.id);
            if (current.definitionHash === definition.definitionHash) return current;
            conflict('Workflow definitions are immutable; create a new id or revision.', 'workflow_definition_exists');
        }
        this.writeJson(filePath, definition);
        return definition;
    }

    createRun(value) {
        const input = assertPlainObject(value, 'workflow run input');
        assertKnownFields(input, [
            'runId', 'projectId', 'definitionId', 'definitionHash', 'chapterId', 'input',
        ], 'workflow run input');
        const projectId = cleanId(input.projectId, 'projectId');
        const chapterId = cleanId(input.chapterId, 'chapterId');
        const definition = this.getDefinition(input.definitionId);
        if (input.definitionHash !== undefined
            && (typeof input.definitionHash !== 'string' || !HASH.test(input.definitionHash)
                || input.definitionHash !== definition.definitionHash)) {
            conflict('Workflow definition changed before the run was created.', 'workflow_definition_conflict', {
                expectedDefinitionHash: input.definitionHash,
                actualDefinitionHash: definition.definitionHash,
            });
        }
        const runId = input.runId === undefined ? randomUUID() : cleanId(input.runId, 'runId');
        const filePath = this.runPath(projectId, runId);
        if (fs.existsSync(filePath)) conflict('Workflow run already exists.', 'workflow_run_exists');
        const timestamp = new Date().toISOString();
        const firstStep = definition.steps.find(step => step.dependsOn.length === 0);
        const run = normalizeWorkflowRun({
            schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
            id: runId,
            projectId,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            chapterId,
            status: 'running',
            revision: 1,
            currentStepId: firstStep.id,
            steps: definition.steps.map(step => ({
                id: step.id,
                status: step.id === firstStep.id ? 'ready' : 'pending',
                attempt: 0,
                artifactIds: [],
                startedAt: null,
                updatedAt: timestamp,
                completedAt: null,
                error: '',
            })),
            input: assertJson(input.input ?? {}, 'workflow run input', MAX_INPUT_BYTES),
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: null,
            lastCommand: null,
        });
        validateRunAgainstDefinition(run, definition);
        this.writeJson(filePath, run);
        return run;
    }

    getRun(projectId, runId) {
        const filePath = this.runPath(projectId, runId);
        const value = this.readJson(filePath, 'Workflow run');
        if (!value) throw new ApiError(404, 'workflow_run_not_found', 'Workflow run not found.');
        assertPlainObject(value, 'Stored workflow run', { status: 500 });
        verifyRecordHash(value, 'Stored workflow run');
        const run = normalizeWorkflowRun(value, { requireHash: true });
        if (run.projectId !== projectId || run.id !== runId) {
            storageFailure('Workflow run identity does not match its path.', 'workflow_storage_tampered');
        }
        validateRunAgainstDefinition(run, this.getDefinition(run.definitionId));
        return run;
    }

    listRuns(projectId) {
        const project = cleanId(projectId, 'projectId');
        const directory = this.safePath('projects', project, 'runs');
        if (!fs.existsSync(directory)) return [];
        this.assertNoLinks(directory);
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_ID.test(entry.name))
            .map(entry => this.getRun(project, entry.name))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map(runSummary);
    }

    createCandidateArtifact(value) {
        const input = assertPlainObject(value, 'workflow artifact input');
        assertKnownFields(input, ARTIFACT_CREATE_FIELDS, 'workflow artifact input');
        const projectId = cleanId(input.projectId, 'projectId');
        const runId = cleanId(input.runId, 'runId');
        const stepId = cleanId(input.stepId, 'stepId');
        const run = this.getRun(projectId, runId);
        const definition = this.getDefinition(run.definitionId);
        const declaredStep = definition.steps.find(step => step.id === stepId);
        if (!declaredStep) bad('Artifact step does not exist in the workflow.', 'invalid_workflow_step');
        if (!WORKFLOW_ARTIFACT_KINDS.includes(input.kind)
            || (declaredStep.artifactKind !== null && declaredStep.artifactKind !== input.kind)) {
            bad('Artifact kind does not match the workflow step.', 'invalid_workflow_artifact_kind');
        }
        if (!['model', 'system', 'user'].includes(input.source)) {
            bad('Artifact source is invalid.', 'invalid_workflow_artifact');
        }
        if (declaredStep.actor !== input.source) {
            bad('Artifact source does not match the declared workflow actor.',
                declaredStep.actor === 'model' ? 'unsafe_model_artifact' : 'invalid_workflow_artifact');
        }
        const runStep = run.steps.find(step => step.id === stepId);
        if (run.currentStepId !== stepId
            || !['ready', 'running', 'candidate_ready', 'waiting_approval'].includes(runStep?.status)) {
            conflict('Candidates can only be created for the current active workflow step.',
                'invalid_workflow_transition');
        }
        const target = normalizeArtifactTarget(input.target);
        const base = normalizeArtifactBase(input.base);
        if (target.chapterId !== run.chapterId) {
            bad('Artifact target chapter does not match the workflow run.', 'invalid_workflow_artifact_target');
        }
        const artifactId = input.artifactId === undefined ? randomUUID() : cleanId(input.artifactId, 'artifactId');
        const filePath = this.artifactPath(projectId, runId, artifactId);
        if (fs.existsSync(filePath)) conflict('Workflow artifact already exists.', 'workflow_artifact_exists');
        const timestamp = new Date().toISOString();
        const artifact = normalizeWorkflowArtifact({
            schemaVersion: WORKFLOW_ARTIFACT_SCHEMA_VERSION,
            id: artifactId,
            projectId,
            runId,
            stepId,
            kind: input.kind,
            source: input.source,
            status: 'candidate',
            revision: 1,
            target,
            base,
            payload: assertJson(input.payload ?? {}, 'artifact.payload', MAX_ARTIFACT_BYTES),
            evidenceIds: normalizeEvidenceIds(input.evidenceIds ?? []),
            createdAt: timestamp,
            updatedAt: timestamp,
            approvedAt: null,
            appliedAt: null,
            rejectedAt: null,
        });
        this.writeJson(filePath, artifact);
        return artifact;
    }

    createArtifact(value) {
        return this.createCandidateArtifact(value);
    }

    getArtifact(projectId, runId, artifactId) {
        const project = cleanId(projectId, 'projectId');
        const runIdChecked = cleanId(runId, 'runId');
        const id = cleanId(artifactId, 'artifactId');
        const filePath = this.artifactPath(project, runIdChecked, id);
        const value = this.readJson(filePath, 'Workflow artifact');
        if (!value) throw new ApiError(404, 'workflow_artifact_not_found', 'Workflow artifact not found.');
        assertPlainObject(value, 'Stored workflow artifact', { status: 500 });
        verifyRecordHash(value, 'Stored workflow artifact');
        const artifact = normalizeWorkflowArtifact(value, { requireHash: true });
        if (artifact.projectId !== project || artifact.runId !== runIdChecked || artifact.id !== id) {
            storageFailure('Workflow artifact identity does not match its path.', 'workflow_storage_tampered');
        }
        const ownerRun = this.getRun(project, runIdChecked);
        if (!ownerRun.steps.some(step => step.id === artifact.stepId)
            || artifact.target.chapterId !== ownerRun.chapterId) {
            storageFailure('Workflow artifact refers to an unknown run step.', 'workflow_storage_corrupt');
        }
        return artifact;
    }

    listArtifacts(projectId, runId) {
        const project = cleanId(projectId, 'projectId');
        const runIdChecked = cleanId(runId, 'runId');
        this.getRun(project, runIdChecked);
        const directory = this.safePath('projects', project, 'runs', runIdChecked, 'artifacts');
        if (!fs.existsSync(directory)) return [];
        this.assertNoLinks(directory);
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && SAFE_ID.test(entry.name.slice(0, -5)) && entry.name.endsWith('.json'))
            .map(entry => this.getArtifact(project, runIdChecked, entry.name.slice(0, -5)))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    transitionArtifact(projectId, runId, artifactId, changes = {}) {
        const input = assertPlainObject(changes, 'workflow artifact update');
        assertKnownFields(input, ['expectedRevision', 'status', 'target'], 'workflow artifact update');
        const { expectedRevision, status } = input;
        const current = this.getArtifact(projectId, runId, artifactId);
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
            bad('expectedRevision must be a positive integer.', 'invalid_workflow_revision');
        }
        if (current.revision !== expectedRevision) {
            conflict('Workflow artifact revision changed.', 'workflow_revision_conflict', {
                expectedRevision,
                actualRevision: current.revision,
            });
        }
        if (!WORKFLOW_ARTIFACT_STATUSES.includes(status)
            || !ARTIFACT_TRANSITIONS[current.status]?.has(status)) {
            conflict(`Workflow artifact cannot transition from ${current.status} to ${status}.`,
                'invalid_workflow_transition');
        }
        let target = current.target;
        if (status === 'applied') {
            if (input.target === undefined) {
                bad('Applying an artifact requires authoritative target evidence.',
                    'invalid_workflow_artifact_target');
            }
            target = normalizeArtifactTarget(input.target);
            if (target.type !== current.target.type || target.chapterId !== current.target.chapterId
                || target.projectVersion === null || target.chapterRevision === null || target.digest === null
                || target.projectVersion < current.base.projectVersion
                || target.chapterRevision < current.base.chapterRevision) {
                bad('Applied artifact target evidence is incomplete or does not match its immutable target.',
                    'invalid_workflow_artifact_target');
            }
        } else if (input.target !== undefined) {
            bad('Authoritative target evidence can only be recorded while applying an artifact.',
                'invalid_workflow_artifact_target');
        }
        const timestamp = new Date().toISOString();
        const next = normalizeWorkflowArtifact({
            ...current,
            status,
            revision: current.revision + 1,
            target,
            updatedAt: timestamp,
            approvedAt: status === 'approved' ? timestamp : current.approvedAt,
            appliedAt: status === 'applied' ? timestamp : current.appliedAt,
            rejectedAt: status === 'rejected' ? timestamp : current.rejectedAt,
        });
        this.writeJson(this.artifactPath(projectId, runId, artifactId), next);
        return next;
    }

    updateArtifact(projectId, runId, artifactId, changes) {
        return this.transitionArtifact(projectId, runId, artifactId, changes);
    }

    getReceipt(commandId) {
        const filePath = this.receiptPath(commandId);
        const value = this.readJson(filePath, 'Workflow receipt');
        if (!value) throw new ApiError(404, 'workflow_receipt_not_found', 'Workflow receipt not found.');
        assertPlainObject(value, 'Stored workflow receipt', { status: 500 });
        verifyRecordHash(value, 'Stored workflow receipt');
        const receipt = normalizeWorkflowReceipt(value, { requireHash: true });
        if (receipt.id !== commandId) {
            storageFailure('Workflow receipt identity does not match its path.', 'workflow_storage_tampered');
        }
        return receipt;
    }

    ensureLastCommandReceipt(run) {
        if (!run.lastCommand) return null;
        const command = run.lastCommand;
        const expected = normalizeWorkflowReceipt({
            schemaVersion: WORKFLOW_RECEIPT_SCHEMA_VERSION,
            id: command.id,
            projectId: run.projectId,
            runId: run.id,
            type: command.type,
            commandDigest: command.digest,
            expectedRevision: command.expectedRevision,
            committedRevision: command.committedRevision,
            response: command.response,
            createdAt: command.committedAt,
        });
        const filePath = this.receiptPath(command.id);
        if (!fs.existsSync(filePath)) {
            this.writeJson(filePath, expected);
            return expected;
        }
        const current = this.getReceipt(command.id);
        if (current.recordHash !== expected.recordHash) {
            storageFailure('Workflow receipt does not match the run lastCommand.',
                'workflow_storage_corrupt', { commandId: command.id });
        }
        return current;
    }

    commitCommand(value) {
        const input = assertPlainObject(value, 'workflow command');
        assertKnownFields(input, COMMIT_FIELDS, 'workflow command');
        const projectId = cleanId(input.projectId, 'projectId');
        const runId = cleanId(input.runId, 'runId');
        const commandId = cleanId(input.commandId, 'commandId', COMMAND_ID);
        const type = cleanId(input.type, 'command type', COMMAND_TYPE);
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
            bad('expectedRevision must be a positive integer.', 'invalid_workflow_revision');
        }
        if (typeof input.mutate !== 'function') {
            throw new TypeError('WorkflowStore.commitCommand requires a trusted mutation function.');
        }
        const payload = assertJson(input.payload ?? {}, 'workflow command payload', MAX_RESPONSE_BYTES);
        const commandDigest = digest({
            projectId,
            runId,
            commandId,
            expectedRevision: input.expectedRevision,
            type,
            payload,
        });
        const receiptPath = this.receiptPath(commandId);
        const current = this.getRun(projectId, runId);
        const lastCommandReceipt = this.ensureLastCommandReceipt(current);
        if (fs.existsSync(receiptPath)) {
            const receipt = this.getReceipt(commandId);
            if (receipt.projectId !== projectId || receipt.runId !== runId
                || receipt.expectedRevision !== input.expectedRevision || receipt.type !== type
                || receipt.commandDigest !== commandDigest) {
                conflict('commandId was already used for a different workflow command.', 'workflow_command_conflict');
            }
            return { run: this.getRun(projectId, runId), receipt, replayed: true };
        }

        if (current.lastCommand?.id === commandId) {
            if (current.lastCommand.digest !== commandDigest
                || current.lastCommand.expectedRevision !== input.expectedRevision
                || current.lastCommand.type !== type) {
                conflict('commandId was already used for a different workflow command.', 'workflow_command_conflict');
            }
            return { run: current, receipt: lastCommandReceipt, replayed: true };
        }
        if (current.revision !== input.expectedRevision) {
            conflict('Workflow run revision changed.', 'workflow_revision_conflict', {
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision,
            });
        }
        const draft = clone(current);
        let response = input.mutate(draft);
        if (response === undefined) response = null;
        response = assertJson(response, 'workflow command response', MAX_RESPONSE_BYTES);
        const timestamp = new Date().toISOString();
        draft.revision = current.revision + 1;
        draft.updatedAt = timestamp;
        draft.lastCommand = {
            id: commandId,
            digest: commandDigest,
            type,
            expectedRevision: current.revision,
            committedRevision: current.revision + 1,
            response,
            committedAt: timestamp,
        };
        const next = normalizeWorkflowRun(draft);
        const definition = this.getDefinition(current.definitionId);
        validateRunTransition(current, next, definition);
        this.writeJson(this.runPath(projectId, runId), next);

        const receipt = normalizeWorkflowReceipt({
            schemaVersion: WORKFLOW_RECEIPT_SCHEMA_VERSION,
            id: commandId,
            projectId,
            runId,
            type,
            commandDigest,
            expectedRevision: current.revision,
            committedRevision: next.revision,
            response,
            createdAt: timestamp,
        });
        this.writeJson(receiptPath, receipt);
        return { run: next, receipt, replayed: false };
    }

    transitionStep(value) {
        const input = assertPlainObject(value, 'workflow step transition');
        assertKnownFields(input, TRANSITION_STEP_FIELDS, 'workflow step transition');
        const artifactIds = input.artifactIds ?? [];
        if (!Array.isArray(artifactIds) || artifactIds.length > 64) {
            bad('artifactIds must contain at most 64 identifiers.');
        }
        const checkedArtifactIds = artifactIds.map(id => cleanId(id, 'artifactId'));
        if (new Set(checkedArtifactIds).size !== checkedArtifactIds.length) {
            bad('artifactIds contains duplicates.', 'invalid_workflow_artifact');
        }
        const currentRun = this.getRun(input.projectId, input.runId);
        const definition = this.getDefinition(currentRun.definitionId);
        const declarationById = new Map(definition.steps.map(step => [step.id, step]));
        const currentDeclaration = declarationById.get(input.stepId);
        if (!currentDeclaration) bad('Workflow step does not exist.', 'invalid_workflow_step');
        const ancestorIds = new Set();
        const collectAncestors = stepId => {
            for (const dependency of declarationById.get(stepId)?.dependsOn ?? []) {
                if (ancestorIds.has(dependency)) continue;
                ancestorIds.add(dependency);
                collectAncestors(dependency);
            }
        };
        collectAncestors(input.stepId);
        const stateById = new Map(currentRun.steps.map(step => [step.id, step]));
        for (const artifactId of checkedArtifactIds) {
            const artifact = this.getArtifact(input.projectId, input.runId, artifactId);
            if (artifact.projectId !== input.projectId || artifact.runId !== input.runId
                || artifact.kind !== currentDeclaration.artifactKind
                || (artifact.stepId !== input.stepId && !ancestorIds.has(artifact.stepId))) {
                bad('Workflow artifact does not match this step or one of its ancestors.',
                    'invalid_workflow_artifact');
            }
            if (artifact.stepId !== input.stepId
                && !stateById.get(artifact.stepId)?.artifactIds.includes(artifactId)) {
                bad('Workflow ancestor did not publish this artifact candidate.',
                    'invalid_workflow_artifact');
            }
            if (['apply', 'adopt'].includes(currentDeclaration.kind)) {
                const relevantApprovals = definition.steps.filter(step => step.kind === 'approve'
                    && step.artifactKind === artifact.kind && ancestorIds.has(step.id));
                if (relevantApprovals.length > 0
                    && !relevantApprovals.some(step => stateById.get(step.id)?.artifactIds.includes(artifactId))) {
                    bad('Workflow apply step must reference the exact approved candidate.',
                        'invalid_workflow_artifact');
                }
            }
        }
        const desiredStatus = input.status;
        if (!WORKFLOW_STEP_STATUSES.includes(desiredStatus) || desiredStatus === 'pending') {
            bad('Workflow step target status is invalid.', 'invalid_workflow_transition');
        }
        return this.commitCommand({
            projectId: input.projectId,
            runId: input.runId,
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            type: input.type ?? 'transition-step',
            payload: input.payload ?? {
                stepId: input.stepId,
                status: desiredStatus,
                artifactIds: checkedArtifactIds,
                error: input.error ?? '',
            },
            mutate: draft => {
                if (draft.currentStepId !== input.stepId) {
                    conflict('Only the current workflow step can transition.', 'invalid_workflow_transition');
                }
                const step = draft.steps.find(item => item.id === input.stepId);
                if (!step || (step.status !== desiredStatus && !STEP_TRANSITIONS[step.status]?.has(desiredStatus))) {
                    conflict(`Workflow step cannot transition from ${step?.status ?? 'missing'} to ${desiredStatus}.`,
                        'invalid_workflow_transition');
                }
                const timestamp = new Date().toISOString();
                const beganAttempt = step.status === 'ready'
                    && !['ready', 'skipped', 'cancelled'].includes(desiredStatus);
                step.status = desiredStatus;
                if (beganAttempt) step.attempt += 1;
                if (beganAttempt && !step.startedAt) step.startedAt = timestamp;
                step.updatedAt = timestamp;
                step.error = desiredStatus === 'failed'
                    ? cleanText(input.error ?? 'Workflow step failed.', 'workflow step error', 20_000)
                    : '';
                for (const artifactId of checkedArtifactIds) {
                    if (!step.artifactIds.includes(artifactId)) step.artifactIds.push(artifactId);
                }
                step.completedAt = ['completed', 'skipped', 'cancelled'].includes(desiredStatus) ? timestamp : null;

                if (desiredStatus === 'waiting_approval') {
                    draft.status = 'waiting_approval';
                } else if (desiredStatus === 'failed') {
                    draft.status = 'failed';
                } else if (SUCCESSFUL_STEP_STATUSES.has(desiredStatus)) {
                    const definition = this.getDefinition(draft.definitionId);
                    const stateById = new Map(draft.steps.map(item => [item.id, item]));
                    const nextDeclaration = definition.steps.find(declared => {
                        const state = stateById.get(declared.id);
                        return state.status === 'pending'
                            && declared.dependsOn.every(dependency => SUCCESSFUL_STEP_STATUSES.has(
                                stateById.get(dependency)?.status,
                            ));
                    });
                    if (nextDeclaration) {
                        const nextStep = stateById.get(nextDeclaration.id);
                        nextStep.status = 'ready';
                        nextStep.updatedAt = timestamp;
                        draft.currentStepId = nextStep.id;
                        draft.status = 'running';
                        draft.completedAt = null;
                    } else {
                        draft.currentStepId = null;
                        draft.status = 'completed';
                        draft.completedAt = timestamp;
                    }
                } else if (desiredStatus === 'cancelled') {
                    for (const pending of draft.steps.filter(item => item.status === 'pending')) {
                        pending.status = 'cancelled';
                        pending.updatedAt = timestamp;
                        pending.completedAt = timestamp;
                    }
                    draft.currentStepId = null;
                    draft.status = 'cancelled';
                    draft.completedAt = timestamp;
                } else {
                    draft.status = 'running';
                }
                return input.response ?? { stepId: input.stepId, status: desiredStatus };
            },
        });
    }
}

export {
    digest as hashWorkflowValue,
    validateRunAgainstDefinition,
    validateRunTransition,
};
