import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

const GENERATION_SCHEMA_VERSION = 1;
const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const GENERATION_KINDS = new Set([
    'plan', 'draft', 'review', 'continuity', 'distill', 'polish', 'rewrite', 'expand', 'brainstorm',
]);
const GENERATION_MODES = new Set(['generate', 'regenerate', 'continue']);
const GENERATION_STATUSES = new Set(['streaming', 'completed', 'partial', 'failed', 'adopted']);
const DISTILLATION_STATUSES = new Set(['none', 'running', 'ready', 'failed']);
const WORKFLOW_DISTILLATION_SCHEMA_VERSION = 1;
const WORKFLOW_DISTILLATION_STATUSES = new Set(['running', 'ready', 'failed']);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_GENERATIONS_PER_CHAPTER = 200;
const MAX_CONTENT_CHARACTERS = 5_000_000;
const MAX_ERROR_CHARACTERS = 20_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 12 * 1024 * 1024;
const RECORD_FIELDS = [
    'schemaVersion', 'id', 'projectId', 'chapterId', 'kind', 'mode', 'status', 'parentId',
    'content', 'createdAt', 'updatedAt', 'finishReason', 'model', 'usage', 'error', 'request',
    'distillation', 'adoptedAt',
];
const WORKFLOW_DISTILLATION_FIELDS = [
    'schemaVersion', 'projectId', 'chapterId', 'generationId', 'slotDigest', 'status',
    'changes', 'raw', 'error', 'createdAt', 'updatedAt', 'workflowGeneration',
];

export class GenerationStoreError extends Error {
    constructor(message, status, code, details = {}) {
        super(message);
        this.name = 'GenerationStoreError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new GenerationStoreError(`${label} must be an object.`, 400, 'invalid_generation');
    }
    return value;
}

function assertKnownFields(value, allowed, label) {
    const unknown = Object.keys(value).filter(field => !allowed.includes(field));
    if (unknown.length > 0) {
        throw new GenerationStoreError(`${label} contains unknown fields.`, 400, 'unknown_fields', { fields: unknown });
    }
}

function assertId(value, label) {
    if (typeof value !== 'string' || !VALID_ID.test(value)) {
        throw new GenerationStoreError(`${label} is invalid.`, 400, 'invalid_id');
    }
    return value;
}

function cleanText(value, label, maximum, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') {
        throw new GenerationStoreError(`${label} must be a string.`, 400, 'invalid_generation');
    }
    if (value.length > maximum) {
        throw new GenerationStoreError(`${label} is too long.`, 413, 'generation_too_large', {
            field: label,
            maximum,
        });
    }
    return value;
}

function serializedBytes(value, label = 'Generation metadata') {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        throw new GenerationStoreError(`${label} must be JSON serializable.`, 400, 'invalid_generation');
    }
}

function safeClone(value, label, maximum = MAX_METADATA_BYTES) {
    if (value === undefined || value === null) return null;
    if (serializedBytes(value, label) > maximum) {
        throw new GenerationStoreError(`${label} is too large.`, 413, 'generation_too_large', { maximum });
    }
    const json = JSON.stringify(value);
    const cloned = JSON.parse(json);
    const stack = [cloned];
    while (stack.length > 0) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;
        for (const [key, child] of Object.entries(item)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw new GenerationStoreError(`${label} contains a forbidden key.`, 400, 'invalid_generation');
            }
            if (child && typeof child === 'object') stack.push(child);
        }
    }
    return cloned;
}

function cleanOptionalIso(value, label) {
    if (value === undefined || value === null) return null;
    const text = cleanText(value, label, 64);
    if (!Number.isFinite(Date.parse(text))) {
        throw new GenerationStoreError(`${label} is invalid.`, 400, 'invalid_generation');
    }
    return text;
}

function normalizeDistillation(value = {}) {
    assertPlainObject(value, 'distillation');
    assertKnownFields(value, [
        'status', 'changes', 'raw', 'error', 'createdAt', 'workflowGeneration',
    ], 'distillation');
    const status = value.status ?? 'none';
    if (!DISTILLATION_STATUSES.has(status)) {
        throw new GenerationStoreError('distillation.status is invalid.', 400, 'invalid_generation');
    }
    const changes = value.changes === undefined ? null : safeClone(value.changes, 'distillation.changes');
    if (changes !== null) assertPlainObject(changes, 'distillation.changes');
    return {
        status,
        changes,
        raw: cleanText(value.raw, 'distillation.raw', MAX_CONTENT_CHARACTERS),
        error: cleanText(value.error, 'distillation.error', MAX_ERROR_CHARACTERS),
        createdAt: cleanOptionalIso(value.createdAt, 'distillation.createdAt'),
        workflowGeneration: safeClone(value.workflowGeneration, 'distillation.workflowGeneration'),
    };
}

function assertSha256(value, label) {
    if (typeof value !== 'string' || !SHA256.test(value)) {
        throw new GenerationStoreError(`${label} is invalid.`, 400, 'invalid_generation');
    }
    return value;
}

function normalizeWorkflowDistillation(value, expected = {}) {
    const record = assertPlainObject(value, 'workflow distillation');
    assertKnownFields(record, WORKFLOW_DISTILLATION_FIELDS, 'workflow distillation');
    if (record.schemaVersion !== WORKFLOW_DISTILLATION_SCHEMA_VERSION) {
        throw new GenerationStoreError(
            'Workflow distillation uses an unsupported schema.',
            500,
            'invalid_generation_storage',
        );
    }
    const projectId = assertId(record.projectId, 'workflowDistillation.projectId');
    const chapterId = assertId(record.chapterId, 'workflowDistillation.chapterId');
    const generationId = assertId(record.generationId, 'workflowDistillation.generationId');
    const slotDigest = assertSha256(record.slotDigest, 'workflowDistillation.slotDigest');
    if ((expected.projectId && projectId !== expected.projectId)
        || (expected.chapterId && chapterId !== expected.chapterId)
        || (expected.generationId && generationId !== expected.generationId)
        || (expected.slotDigest && slotDigest !== expected.slotDigest)) {
        throw new GenerationStoreError(
            'Workflow distillation identity does not match its storage path.',
            500,
            'invalid_generation_storage',
        );
    }
    if (!WORKFLOW_DISTILLATION_STATUSES.has(record.status)) {
        throw new GenerationStoreError('Workflow distillation status is invalid.', 500, 'invalid_generation_storage');
    }
    const changes = record.changes === undefined
        ? null
        : safeClone(record.changes, 'workflowDistillation.changes');
    if (changes !== null) assertPlainObject(changes, 'workflowDistillation.changes');
    const workflowGeneration = safeClone(
        record.workflowGeneration,
        'workflowDistillation.workflowGeneration',
    );
    if (!workflowGeneration) {
        throw new GenerationStoreError(
            'Workflow distillation binding is missing.',
            500,
            'invalid_generation_storage',
        );
    }
    const normalized = {
        schemaVersion: WORKFLOW_DISTILLATION_SCHEMA_VERSION,
        projectId,
        chapterId,
        generationId,
        slotDigest,
        status: record.status,
        changes,
        raw: cleanText(record.raw, 'workflowDistillation.raw', MAX_CONTENT_CHARACTERS),
        error: cleanText(record.error, 'workflowDistillation.error', MAX_ERROR_CHARACTERS),
        createdAt: cleanOptionalIso(record.createdAt, 'workflowDistillation.createdAt'),
        updatedAt: cleanOptionalIso(record.updatedAt, 'workflowDistillation.updatedAt'),
        workflowGeneration,
    };
    if (!normalized.createdAt || !normalized.updatedAt
        || serializedBytes(normalized, 'Workflow distillation') > MAX_RECORD_BYTES) {
        throw new GenerationStoreError(
            'Workflow distillation storage record is invalid or too large.',
            500,
            'invalid_generation_storage',
        );
    }
    return normalized;
}

function validateRecord(value, expected = {}) {
    const record = assertPlainObject(value, 'generation');
    assertKnownFields(record, RECORD_FIELDS, 'generation');
    if (record.schemaVersion !== GENERATION_SCHEMA_VERSION) {
        throw new GenerationStoreError('Generation uses an unsupported schema.', 500, 'invalid_generation_storage');
    }
    const id = assertId(record.id, 'generation.id');
    const projectId = assertId(record.projectId, 'generation.projectId');
    const chapterId = assertId(record.chapterId, 'generation.chapterId');
    if ((expected.id && id !== expected.id)
        || (expected.projectId && projectId !== expected.projectId)
        || (expected.chapterId && chapterId !== expected.chapterId)) {
        throw new GenerationStoreError('Generation identity does not match its storage path.', 500, 'invalid_generation_storage');
    }
    if (!GENERATION_KINDS.has(record.kind) || !GENERATION_MODES.has(record.mode)
        || !GENERATION_STATUSES.has(record.status)) {
        throw new GenerationStoreError('Generation state is invalid.', 500, 'invalid_generation_storage');
    }
    const parentId = record.parentId === null ? null : assertId(record.parentId, 'generation.parentId');
    const normalized = {
        schemaVersion: GENERATION_SCHEMA_VERSION,
        id,
        projectId,
        chapterId,
        kind: record.kind,
        mode: record.mode,
        status: record.status,
        parentId,
        content: cleanText(record.content, 'generation.content', MAX_CONTENT_CHARACTERS),
        createdAt: cleanOptionalIso(record.createdAt, 'generation.createdAt'),
        updatedAt: cleanOptionalIso(record.updatedAt, 'generation.updatedAt'),
        finishReason: cleanText(record.finishReason, 'generation.finishReason', 128),
        model: cleanText(record.model, 'generation.model', 512),
        usage: safeClone(record.usage, 'generation.usage'),
        error: cleanText(record.error, 'generation.error', MAX_ERROR_CHARACTERS),
        request: safeClone(record.request, 'generation.request') ?? {},
        distillation: normalizeDistillation(record.distillation ?? {}),
        adoptedAt: cleanOptionalIso(record.adoptedAt, 'generation.adoptedAt'),
    };
    if (!normalized.createdAt || !normalized.updatedAt) {
        throw new GenerationStoreError('Generation timestamps are invalid.', 500, 'invalid_generation_storage');
    }
    if (serializedBytes(normalized, 'Generation') > MAX_RECORD_BYTES) {
        throw new GenerationStoreError('Generation exceeds the storage limit.', 413, 'generation_too_large', {
            maximum: MAX_RECORD_BYTES,
        });
    }
    return normalized;
}

function summary(record) {
    return {
        id: record.id,
        kind: record.kind,
        mode: record.mode,
        status: record.status,
        parentId: record.parentId,
        characters: record.content.length,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        finishReason: record.finishReason,
        model: record.model,
        distillationStatus: record.distillation.status,
        adoptedAt: record.adoptedAt,
    };
}

export class GenerationStore {
    constructor(rootDirectory) {
        this.rootDirectory = path.resolve(rootDirectory);
        fs.mkdirSync(this.rootDirectory, { recursive: true });
    }

    chapterDirectory(projectId, chapterId) {
        return path.join(
            this.rootDirectory,
            assertId(projectId, 'projectId'),
            assertId(chapterId, 'chapterId'),
        );
    }

    generationPath(projectId, chapterId, generationId) {
        return path.join(this.chapterDirectory(projectId, chapterId), `${assertId(generationId, 'generationId')}.json`);
    }

    workflowDistillationDirectory(projectId, chapterId, generationId) {
        return path.join(
            this.chapterDirectory(projectId, chapterId),
            `${assertId(generationId, 'generationId')}.distillations`,
        );
    }

    workflowDistillationPath(projectId, chapterId, generationId, slotDigest) {
        return path.join(
            this.workflowDistillationDirectory(projectId, chapterId, generationId),
            `${assertSha256(slotDigest, 'slotDigest')}.json`,
        );
    }

    listGenerations(projectId, chapterId) {
        const directory = this.chapterDirectory(projectId, chapterId);
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^[a-zA-Z0-9_-]{1,64}\.json$/.test(entry.name))
            .map(entry => this.getGeneration(projectId, chapterId, entry.name.slice(0, -5)))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map(summary);
    }

    getGeneration(projectId, chapterId, generationId) {
        const filePath = this.generationPath(projectId, chapterId, generationId);
        if (!fs.existsSync(filePath)) {
            throw new GenerationStoreError('Generation not found.', 404, 'generation_not_found');
        }
        let value;
        try {
            value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            throw new GenerationStoreError('Stored generation is invalid JSON.', 500, 'invalid_generation_storage');
        }
        return validateRecord(value, { projectId, chapterId, id: generationId });
    }

    createGeneration({ projectId, chapterId, kind, mode = 'generate', parentId = null, request = {} }) {
        assertId(projectId, 'projectId');
        assertId(chapterId, 'chapterId');
        if (!GENERATION_KINDS.has(kind)) {
            throw new GenerationStoreError('Generation kind is invalid.', 400, 'invalid_generation');
        }
        if (!GENERATION_MODES.has(mode)) {
            throw new GenerationStoreError('Generation mode is invalid.', 400, 'invalid_generation');
        }
        if (parentId !== null) {
            const parent = this.getGeneration(projectId, chapterId, parentId);
            if (mode === 'generate') {
                throw new GenerationStoreError('A parent requires continue or regenerate mode.', 400, 'invalid_generation_parent');
            }
            if (parent.kind !== kind) {
                throw new GenerationStoreError('Generation parent kind does not match.', 400, 'invalid_generation_parent');
            }
        } else if (mode === 'continue') {
            throw new GenerationStoreError('Continue mode requires a parent.', 400, 'invalid_generation_parent');
        }
        if (this.listGenerations(projectId, chapterId).length >= MAX_GENERATIONS_PER_CHAPTER) {
            throw new GenerationStoreError('Chapter generation history is full.', 413, 'generation_history_full', {
                maximum: MAX_GENERATIONS_PER_CHAPTER,
            });
        }
        const timestamp = new Date().toISOString();
        const record = validateRecord({
            schemaVersion: GENERATION_SCHEMA_VERSION,
            id: randomUUID(),
            projectId,
            chapterId,
            kind,
            mode,
            status: 'streaming',
            parentId,
            content: '',
            createdAt: timestamp,
            updatedAt: timestamp,
            finishReason: '',
            model: '',
            usage: null,
            error: '',
            request: safeClone(request, 'generation.request') ?? {},
            distillation: {
                status: 'none', changes: null, raw: '', error: '', createdAt: null, workflowGeneration: null,
            },
            adoptedAt: null,
        });
        const directory = this.chapterDirectory(projectId, chapterId);
        fs.mkdirSync(directory, { recursive: true });
        this.write(record);
        return record;
    }

    finishGeneration(projectId, chapterId, generationId, changes = {}) {
        assertPlainObject(changes, 'generation completion');
        assertKnownFields(changes, ['status', 'content', 'finishReason', 'model', 'usage', 'error'], 'generation completion');
        const current = this.getGeneration(projectId, chapterId, generationId);
        const status = changes.status ?? 'completed';
        if (!['completed', 'partial', 'failed'].includes(status)) {
            throw new GenerationStoreError('Completion status is invalid.', 400, 'invalid_generation');
        }
        const next = validateRecord({
            ...current,
            status,
            content: changes.content ?? current.content,
            finishReason: changes.finishReason ?? current.finishReason,
            model: changes.model ?? current.model,
            usage: changes.usage === undefined ? current.usage : changes.usage,
            error: changes.error ?? current.error,
            updatedAt: new Date().toISOString(),
        });
        this.write(next);
        return next;
    }

    saveDistillation(projectId, chapterId, generationId, value) {
        const current = this.getGeneration(projectId, chapterId, generationId);
        if (!['completed', 'partial'].includes(current.status)) {
            throw new GenerationStoreError('Only a completed or partial generation can be distilled.', 409, 'generation_not_ready');
        }
        const distillation = normalizeDistillation({
            ...value,
            createdAt: value?.createdAt ?? new Date().toISOString(),
        });
        if (!['running', 'ready', 'failed'].includes(distillation.status)) {
            throw new GenerationStoreError('Distillation must be running, ready, or failed.', 400, 'invalid_generation');
        }
        const next = validateRecord({ ...current, distillation, updatedAt: new Date().toISOString() });
        this.write(next);
        return next;
    }

    getWorkflowDistillation(projectId, chapterId, generationId, slotDigest, { optional = false } = {}) {
        this.getGeneration(projectId, chapterId, generationId);
        const filePath = this.workflowDistillationPath(projectId, chapterId, generationId, slotDigest);
        if (!fs.existsSync(filePath)) {
            if (optional) return null;
            throw new GenerationStoreError(
                'Workflow distillation not found.',
                404,
                'workflow_distillation_not_found',
            );
        }
        let value;
        try {
            value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            throw new GenerationStoreError(
                'Stored workflow distillation is invalid JSON.',
                500,
                'invalid_generation_storage',
            );
        }
        return normalizeWorkflowDistillation(value, { projectId, chapterId, generationId, slotDigest });
    }

    saveWorkflowDistillation(projectId, chapterId, generationId, slotDigest, value) {
        const source = this.getGeneration(projectId, chapterId, generationId);
        if (!['completed', 'partial', 'adopted'].includes(source.status)) {
            throw new GenerationStoreError(
                'Only a completed, partial, or adopted generation can own workflow distillation.',
                409,
                'generation_not_ready',
            );
        }
        const current = this.getWorkflowDistillation(
            projectId,
            chapterId,
            generationId,
            slotDigest,
            { optional: true },
        );
        const timestamp = new Date().toISOString();
        const record = normalizeWorkflowDistillation({
            schemaVersion: WORKFLOW_DISTILLATION_SCHEMA_VERSION,
            projectId,
            chapterId,
            generationId,
            slotDigest,
            ...value,
            createdAt: value?.createdAt ?? current?.createdAt ?? timestamp,
            updatedAt: timestamp,
        });
        const filePath = this.workflowDistillationPath(projectId, chapterId, generationId, slotDigest);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileAtomicSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8' });
        return record;
    }

    markAdopted(projectId, chapterId, generationId, adoptedAt = new Date().toISOString()) {
        const current = this.getGeneration(projectId, chapterId, generationId);
        if (!['completed', 'partial', 'adopted'].includes(current.status)) {
            throw new GenerationStoreError('Generation is not ready for adoption.', 409, 'generation_not_ready');
        }
        const next = validateRecord({
            ...current,
            status: 'adopted',
            adoptedAt,
            updatedAt: adoptedAt,
        });
        this.write(next);
        return next;
    }

    write(record) {
        const normalized = validateRecord(record);
        const filePath = this.generationPath(normalized.projectId, normalized.chapterId, normalized.id);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileAtomicSync(filePath, JSON.stringify(normalized, null, 2), { encoding: 'utf8' });
    }
}

export {
    GENERATION_SCHEMA_VERSION,
    MAX_CONTENT_CHARACTERS,
    MAX_GENERATIONS_PER_CHAPTER,
    WORKFLOW_DISTILLATION_SCHEMA_VERSION,
};
