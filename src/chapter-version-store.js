import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { createStoragePathGuard } from './api-error.js';

const CHAPTER_VERSION_SCHEMA_VERSION = 1;
const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VERSION_ID = /^r([1-9][0-9]{0,11})-([0-9a-f]{24})$/;
const VERSION_FILE = /^r([0-9]{12})\.json$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_SOURCES = new Set(['manual', 'adopt', 'restore', 'workflow']);
const CHAPTER_STATUSES = new Set(['planned', 'drafting', 'revising', 'done']);
const INPUT_FIELDS = [
    'projectId', 'chapterId', 'projectVersion', 'chapterRevision', 'title', 'status',
    'card', 'content', 'review', 'notes', 'source',
];
const RECORD_FIELDS = [
    'schemaVersion', 'versionId', ...INPUT_FIELDS, 'createdAt', 'contentHash', 'snapshotHash',
];
const RESTORABLE_FIELDS = ['title', 'status', 'card', 'content', 'review', 'notes'];
const MAX_VERSION_NUMBER = 999_999_999_999;
const MAX_TITLE_CHARACTERS = 160;
const MAX_CONTENT_CHARACTERS = 5_000_000;
const MAX_REVIEW_CHARACTERS = 1_000_000;
const MAX_NOTES_CHARACTERS = 1_000_000;
const MAX_CARD_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 12 * 1024 * 1024;

export class ChapterVersionStoreError extends Error {
    constructor(message, status, code, details = {}) {
        super(message);
        this.name = 'ChapterVersionStoreError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function storeError(message, status, code, details = {}) {
    return new ChapterVersionStoreError(message, status, code, details);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw storeError(`${label} must be an object.`, 400, 'invalid_chapter_version');
    }
    return value;
}

function assertKnownFields(value, fields, label) {
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    if (unknown.length > 0) {
        throw storeError(`${label} contains unknown fields.`, 400, 'unknown_fields', { fields: unknown });
    }
}

function assertId(value, label) {
    if (typeof value !== 'string' || !VALID_ID.test(value)) {
        throw storeError(`${label} is invalid.`, 400, 'invalid_id');
    }
    return value;
}

function cleanVersionNumber(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION_NUMBER) {
        throw storeError(`${label} is invalid.`, 400, 'invalid_chapter_version');
    }
    return value;
}

function cleanText(value, label, maximum) {
    if (typeof value !== 'string') {
        throw storeError(`${label} must be a string.`, 400, 'invalid_chapter_version');
    }
    if (value.length > maximum) {
        throw storeError(`${label} is too long.`, 413, 'chapter_version_too_large', {
            field: label,
            maximum,
        });
    }
    return value;
}

function serializedBytes(value, label) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        throw storeError(`${label} must be JSON serializable.`, 400, 'invalid_chapter_version');
    }
}

function cloneJsonObject(value, label) {
    assertPlainObject(value, label);
    const stack = [{ value, depth: 0 }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current.depth > 100) {
            throw storeError(`${label} is nested too deeply.`, 400, 'invalid_chapter_version');
        }
        if (Array.isArray(current.value)) {
            for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
            continue;
        }
        if (current.value && typeof current.value === 'object') {
            const prototype = Object.getPrototypeOf(current.value);
            if (prototype !== Object.prototype && prototype !== null) {
                throw storeError(`${label} contains an unsupported value.`, 400, 'invalid_chapter_version');
            }
            for (const [key, child] of Object.entries(current.value)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                    throw storeError(`${label} contains a forbidden key.`, 400, 'invalid_chapter_version');
                }
                stack.push({ value: child, depth: current.depth + 1 });
            }
            continue;
        }
        if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') continue;
        if (typeof current.value === 'number' && Number.isFinite(current.value)) continue;
        throw storeError(`${label} contains an unsupported value.`, 400, 'invalid_chapter_version');
    }
    if (serializedBytes(value, label) > MAX_CARD_BYTES) {
        throw storeError(`${label} is too large.`, 413, 'chapter_version_too_large', { maximum: MAX_CARD_BYTES });
    }
    return JSON.parse(JSON.stringify(value));
}

function contentHash(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
}

export function chapterSnapshotHash(value) {
    const snapshot = Object.fromEntries(RESTORABLE_FIELDS.map(field => [field, value[field]]));
    return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

function makeVersionId(chapterRevision, hash) {
    return `r${chapterRevision}-${hash.slice(0, 24)}`;
}

function cleanCreatedAt(value) {
    if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
        throw storeError('createdAt is invalid.', 400, 'invalid_chapter_version');
    }
    return value;
}

function normalizeInput(value) {
    const input = assertPlainObject(value, 'chapter version');
    assertKnownFields(input, INPUT_FIELDS, 'chapter version');
    const status = cleanText(input.status, 'status', 32);
    if (!CHAPTER_STATUSES.has(status)) {
        throw storeError('status is invalid.', 400, 'invalid_chapter_version');
    }
    const source = cleanText(input.source, 'source', 32);
    if (!VERSION_SOURCES.has(source)) {
        throw storeError('source is invalid.', 400, 'invalid_chapter_version');
    }
    return {
        projectId: assertId(input.projectId, 'projectId'),
        chapterId: assertId(input.chapterId, 'chapterId'),
        projectVersion: cleanVersionNumber(input.projectVersion, 'projectVersion'),
        chapterRevision: cleanVersionNumber(input.chapterRevision, 'chapterRevision'),
        title: cleanText(input.title, 'title', MAX_TITLE_CHARACTERS),
        status,
        card: cloneJsonObject(input.card, 'card'),
        content: cleanText(input.content, 'content', MAX_CONTENT_CHARACTERS),
        review: cleanText(input.review, 'review', MAX_REVIEW_CHARACTERS),
        notes: cleanText(input.notes, 'notes', MAX_NOTES_CHARACTERS),
        source,
    };
}

function normalizeStoredRecord(value, expected = {}) {
    const record = assertPlainObject(value, 'stored chapter version');
    assertKnownFields(record, RECORD_FIELDS, 'stored chapter version');
    if (record.schemaVersion !== CHAPTER_VERSION_SCHEMA_VERSION) {
        throw storeError('Stored chapter version uses an unsupported schema.', 500, 'invalid_version_storage');
    }
    const normalized = normalizeInput(Object.fromEntries(INPUT_FIELDS.map(field => [field, record[field]])));
    const versionId = assertId(record.versionId, 'versionId');
    const hash = cleanText(record.contentHash, 'contentHash', 64);
    if (!SHA256_HEX.test(hash) || hash !== contentHash(normalized.content)) {
        throw storeError('Stored chapter version content hash is invalid.', 500, 'invalid_version_storage');
    }
    const snapshotHash = cleanText(record.snapshotHash, 'snapshotHash', 64);
    if (!SHA256_HEX.test(snapshotHash) || snapshotHash !== chapterSnapshotHash(normalized)) {
        throw storeError('Stored chapter version snapshot hash is invalid.', 500, 'invalid_version_storage');
    }
    if (versionId !== makeVersionId(normalized.chapterRevision, snapshotHash)) {
        throw storeError('Stored chapter version identifier is invalid.', 500, 'invalid_version_storage');
    }
    if ((expected.projectId && normalized.projectId !== expected.projectId)
        || (expected.chapterId && normalized.chapterId !== expected.chapterId)
        || (expected.chapterRevision && normalized.chapterRevision !== expected.chapterRevision)) {
        throw storeError('Stored chapter version identity does not match its path.', 500, 'invalid_version_storage');
    }
    const result = {
        schemaVersion: CHAPTER_VERSION_SCHEMA_VERSION,
        versionId,
        ...normalized,
        createdAt: cleanCreatedAt(record.createdAt),
        contentHash: hash,
        snapshotHash,
    };
    if (serializedBytes(result, 'Stored chapter version') > MAX_RECORD_BYTES) {
        throw storeError('Stored chapter version is too large.', 500, 'invalid_version_storage');
    }
    return result;
}

function asStorageError(error, details = {}) {
    if (error instanceof ChapterVersionStoreError && error.code === 'invalid_version_storage') return error;
    return storeError('Stored chapter version is invalid.', 500, 'invalid_version_storage', details);
}

function lineCount(value) {
    return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
}

export function summarizeContentDiff(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') {
        throw storeError('Diff content must be strings.', 400, 'invalid_chapter_version');
    }
    const left = [...before];
    const right = [...after];
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix
        && left[left.length - suffix - 1] === right[right.length - suffix - 1]) {
        suffix += 1;
    }
    return {
        changed: before !== after,
        beforeCharacters: left.length,
        afterCharacters: right.length,
        deltaCharacters: right.length - left.length,
        beforeLines: lineCount(before),
        afterLines: lineCount(after),
        deltaLines: lineCount(after) - lineCount(before),
        commonPrefixCharacters: prefix,
        commonSuffixCharacters: suffix,
        removedCharacters: left.length - prefix - suffix,
        addedCharacters: right.length - prefix - suffix,
    };
}

function versionSummary(record) {
    return {
        versionId: record.versionId,
        projectVersion: record.projectVersion,
        chapterRevision: record.chapterRevision,
        title: record.title,
        status: record.status,
        source: record.source,
        createdAt: record.createdAt,
        contentHash: record.contentHash,
        snapshotHash: record.snapshotHash,
        characters: [...record.content].length,
        lines: lineCount(record.content),
    };
}

function parseVersionId(value) {
    assertId(value, 'versionId');
    const match = VERSION_ID.exec(value);
    if (!match) throw storeError('versionId is invalid.', 400, 'invalid_id');
    return { chapterRevision: Number(match[1]), hashPrefix: match[2] };
}

export function chapterVersionInput(projectVersion, chapter, source) {
    assertPlainObject(chapter, 'chapter');
    return {
        projectId: chapter.projectId,
        chapterId: chapter.id,
        projectVersion,
        chapterRevision: chapter.revision,
        title: chapter.title,
        status: chapter.status,
        card: chapter.card,
        content: chapter.content,
        review: chapter.review,
        notes: chapter.notes,
        source,
    };
}

export function chapterChangesFromVersion(version) {
    const normalized = normalizeStoredRecord(version);
    return Object.fromEntries(RESTORABLE_FIELDS.map(field => [
        field,
        field === 'card' ? cloneJsonObject(normalized.card, 'card') : normalized[field],
    ]));
}

export class ChapterVersionStore {
    constructor(rootDirectory, options = {}) {
        if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
            throw storeError('Version store root is invalid.', 400, 'invalid_version_root');
        }
        this.pathGuard = createStoragePathGuard(rootDirectory, {
            label: 'Chapter version storage',
            createError: (message, details) => (
                storeError(message, 500, 'unsafe_version_path', details)
            ),
        });
        this.rootDirectory = this.pathGuard.rootDirectory;
        this.clock = options.clock ?? (() => new Date());
    }

    storagePath(...segments) {
        return this.pathGuard.resolvePath(...segments);
    }

    chapterDirectory(projectId, chapterId) {
        return this.storagePath(
            assertId(projectId, 'projectId'),
            assertId(chapterId, 'chapterId'),
        );
    }

    versionPath(projectId, chapterId, chapterRevision) {
        const revision = cleanVersionNumber(chapterRevision, 'chapterRevision');
        return this.storagePath(
            assertId(projectId, 'projectId'),
            assertId(chapterId, 'chapterId'),
            `r${String(revision).padStart(12, '0')}.json`,
        );
    }

    readRevision(projectId, chapterId, chapterRevision) {
        const normalizedProjectId = assertId(projectId, 'projectId');
        const normalizedChapterId = assertId(chapterId, 'chapterId');
        const revision = cleanVersionNumber(chapterRevision, 'chapterRevision');
        const filePath = this.versionPath(normalizedProjectId, normalizedChapterId, revision);
        if (!fs.existsSync(filePath)) {
            throw storeError('Chapter version not found.', 404, 'chapter_version_not_found');
        }
        this.pathGuard.assertPath(filePath);
        let value;
        try {
            value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            throw storeError('Stored chapter version is invalid.', 500, 'invalid_version_storage', {
                chapterRevision: revision,
            });
        }
        try {
            return normalizeStoredRecord(value, {
                projectId: normalizedProjectId,
                chapterId: normalizedChapterId,
                chapterRevision: revision,
            });
        } catch (error) {
            throw asStorageError(error, { chapterRevision: revision });
        }
    }

    getVersion(projectId, chapterId, versionId) {
        const { chapterRevision } = parseVersionId(versionId);
        const record = this.readRevision(projectId, chapterId, chapterRevision);
        if (record.versionId !== versionId) {
            throw storeError('Chapter version not found.', 404, 'chapter_version_not_found');
        }
        return record;
    }

    inspectVersions(projectId, chapterId) {
        const normalizedProjectId = assertId(projectId, 'projectId');
        const normalizedChapterId = assertId(chapterId, 'chapterId');
        const directory = this.chapterDirectory(normalizedProjectId, normalizedChapterId);
        if (!fs.existsSync(directory)) return { versions: [], corrupt: [] };
        this.pathGuard.assertPath(directory);
        const versions = [];
        const corrupt = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const match = entry.isFile() ? VERSION_FILE.exec(entry.name) : null;
            if (!match) continue;
            const chapterRevision = Number(match[1]);
            try {
                versions.push(versionSummary(this.readRevision(
                    normalizedProjectId,
                    normalizedChapterId,
                    chapterRevision,
                )));
            } catch (error) {
                corrupt.push({
                    chapterRevision,
                    fileName: entry.name,
                    code: 'invalid_version_storage',
                });
            }
        }
        versions.sort((left, right) => right.chapterRevision - left.chapterRevision
            || right.createdAt.localeCompare(left.createdAt));
        corrupt.sort((left, right) => right.chapterRevision - left.chapterRevision);
        return { versions, corrupt };
    }

    listVersions(projectId, chapterId) {
        return this.inspectVersions(projectId, chapterId).versions;
    }

    appendVersion(value) {
        const input = normalizeInput(value);
        const hash = contentHash(input.content);
        const snapshotHash = chapterSnapshotHash(input);
        const versionId = makeVersionId(input.chapterRevision, snapshotHash);
        const clockValue = this.clock();
        const createdAt = clockValue instanceof Date ? clockValue.toISOString() : cleanCreatedAt(clockValue);
        const record = normalizeStoredRecord({
            schemaVersion: CHAPTER_VERSION_SCHEMA_VERSION,
            versionId,
            ...input,
            createdAt,
            contentHash: hash,
            snapshotHash,
        });
        if (serializedBytes(record, 'Chapter version') > MAX_RECORD_BYTES) {
            throw storeError('Chapter version is too large.', 413, 'chapter_version_too_large', {
                maximum: MAX_RECORD_BYTES,
            });
        }

        const directory = this.chapterDirectory(input.projectId, input.chapterId);
        this.pathGuard.ensureDirectory(directory);
        const finalPath = this.versionPath(input.projectId, input.chapterId, input.chapterRevision);
        if (fs.existsSync(finalPath)) return this.resolveExisting(record);

        const stagingPath = this.storagePath(
            input.projectId,
            input.chapterId,
            `.version-${randomUUID()}.tmp`,
        );
        const serialized = JSON.stringify(record, null, 2);
        try {
            this.pathGuard.assertPath(stagingPath);
            writeFileAtomicSync(stagingPath, serialized, { encoding: 'utf8', mode: 0o600 });
            try {
                this.pathGuard.assertPath(stagingPath);
                this.pathGuard.assertPath(finalPath);
                fs.linkSync(stagingPath, finalPath);
            } catch (error) {
                if (error.code === 'EEXIST') return this.resolveExisting(record);
                throw error;
            }
        } catch (error) {
            if (error instanceof ChapterVersionStoreError) throw error;
            throw storeError('Could not append chapter version.', 500, 'version_write_failed');
        } finally {
            try {
                this.pathGuard.assertPath(stagingPath);
                fs.rmSync(stagingPath, { force: true });
            } catch (error) {
                if (error instanceof ChapterVersionStoreError && error.code === 'unsafe_version_path') {
                    throw error;
                }
                // The published version is already independent of its staging link.
            }
        }
        return record;
    }

    resolveExisting(proposed) {
        const existing = this.readRevision(proposed.projectId, proposed.chapterId, proposed.chapterRevision);
        const sameFormalDraft = existing.contentHash === proposed.contentHash
            && RESTORABLE_FIELDS.every(field => isDeepStrictEqual(existing[field], proposed[field]));
        if (sameFormalDraft) return existing;
        throw storeError('Chapter revision already has different content.', 409, 'chapter_version_conflict', {
            chapterRevision: proposed.chapterRevision,
            existingVersionId: existing.versionId,
            existingContentHash: existing.contentHash,
            proposedContentHash: proposed.contentHash,
            metadataConflict: existing.contentHash === proposed.contentHash,
        });
    }

    diffVersions(projectId, chapterId, fromVersionId, toVersionId) {
        const before = this.getVersion(projectId, chapterId, fromVersionId);
        const after = this.getVersion(projectId, chapterId, toVersionId);
        return {
            fromVersionId: before.versionId,
            toVersionId: after.versionId,
            changedFields: RESTORABLE_FIELDS.filter(field => !isDeepStrictEqual(before[field], after[field])),
            content: summarizeContentDiff(before.content, after.content),
        };
    }

    getRestoreChanges(projectId, chapterId, versionId) {
        return chapterChangesFromVersion(this.getVersion(projectId, chapterId, versionId));
    }
}

export {
    CHAPTER_VERSION_SCHEMA_VERSION,
    MAX_CONTENT_CHARACTERS,
    VERSION_SOURCES,
};
