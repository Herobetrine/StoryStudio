import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import writeFileAtomic, { sync as writeFileAtomicSync } from 'write-file-atomic';

import {
    CompatImportError,
    createResourceRecord,
    normalizeExportedResource,
    normalizeResourceType,
    parseCompatImport,
    resourceSummary,
    updateResourceRecord,
    validateResourceRecord,
} from './compat-import.js';

export const STORY_STUDIO_SCHEMA_VERSION = 5;

const LEGACY_STORY_STUDIO_SCHEMA_VERSION = 1;
const RESOURCE_STORY_STUDIO_SCHEMA_VERSION = 2;
const STORY_STATE_STORY_STUDIO_SCHEMA_VERSION = 3;
const VOLUME_STORY_STUDIO_SCHEMA_VERSION = 4;
const SUPPORTED_STORY_STUDIO_SCHEMA_VERSIONS = new Set([
    LEGACY_STORY_STUDIO_SCHEMA_VERSION,
    RESOURCE_STORY_STUDIO_SCHEMA_VERSION,
    STORY_STATE_STORY_STUDIO_SCHEMA_VERSION,
    VOLUME_STORY_STUDIO_SCHEMA_VERSION,
    STORY_STUDIO_SCHEMA_VERSION,
]);

const MAX_PROJECT_BYTES = 5 * 1024 * 1024;
const MAX_CHAPTER_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_CHAPTERS = 3_000;
const MAX_PROJECT_VOLUMES = 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = Math.floor(LOCK_STALE_MS / 3);
const LOCK_HARD_STALE_MS = 24 * 60 * 60 * 1_000;
const LOCK_OWNER_PREFIX = 'owner-';
const STAGING_STALE_MS = 24 * 60 * 60 * 1_000;
const STAGING_HARD_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const STAGING_OWNER_FILE = '.staging-owner.json';
const STAGING_DIRECTORY = /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const CHAPTER_STATUSES = new Set(['planned', 'drafting', 'revising', 'done']);
const STORY_FIELDS = [
    'logline',
    'premise',
    'protagonist',
    'opposition',
    'world',
    'powerSystem',
    'styleGuide',
    'masterOutline',
    'forbidden',
];
const CARD_FIELDS = [
    'summary',
    'goal',
    'conflict',
    'turn',
    'hook',
    'pov',
    'time',
    'location',
    'required',
    'avoid',
];
const VOLUME_FIELDS = [
    'id', 'number', 'title', 'goal', 'outline', 'summary', 'revision', 'createdAt', 'updatedAt',
];
const VOLUME_CHANGE_FIELDS = ['title', 'goal', 'outline', 'summary'];
const PLAN_BASIS_FIELDS = ['volumeRevision'];
const CANDIDATE_FIELDS = ['kind', 'content', 'createdAt'];
const CHAPTER_RECORD_FIELDS = [
    'schemaVersion', 'id', 'projectId', 'number', 'title', 'status', 'card', 'content',
    'candidate', 'review', 'notes', 'volumeId', 'planBasis', 'wordCount', 'revision',
    'generationHistory', 'createdAt', 'updatedAt',
];
const LEGACY_CHAPTER_RECORD_FIELDS = CHAPTER_RECORD_FIELDS.filter(field => !['volumeId', 'planBasis'].includes(field));
const CHAPTER_SUMMARY_FIELDS = [
    'id', 'number', 'title', 'status', 'summary', 'volumeId', 'planBasis', 'wordCount', 'updatedAt',
];
const LEGACY_CHAPTER_SUMMARY_FIELDS = ['id', 'number', 'title', 'status', 'summary', 'wordCount', 'updatedAt'];
const CONTINUITY_FIELDS = ['id', 'category', 'label', 'detail', 'status', 'firstSeenChapter', 'lastTouchedChapter'];
const STORY_STATE_FIELDS = [
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
];
const PROTECTED_STORY_STATE_FIELDS = ['facts', 'knowledge', 'timeline'];
const LEGACY_STORY_STATE_FIELDS = ['entities', 'relations', 'events', 'promises', 'memory'];
const STORY_STATE_LIMITS = Object.freeze({
    entities: 5_000,
    relations: 10_000,
    events: 20_000,
    promises: 5_000,
    memory: 10_000,
    facts: 20_000,
    knowledge: 20_000,
    timeline: 20_000,
});
const STORY_STATE_RECORD_FIELDS = Object.freeze({
    entities: [
        'id', 'kind', 'name', 'summary', 'aliases', 'status', 'locationEntityId', 'currentGoal',
        'currentAction', 'updatedChapterId',
    ],
    relations: [
        'id', 'fromEntityId', 'toEntityId', 'kind', 'summary', 'status', 'addressing',
        'publicSummary', 'privateSummary', 'sinceChapterId',
    ],
    events: [
        'id', 'kind', 'title', 'summary', 'chapterId', 'entityIds', 'status', 'order',
        'timelineId', 'locationEntityId', 'progress', 'visibility',
    ],
    promises: [
        'id', 'title', 'summary', 'introducedChapterId', 'dueChapterId', 'resolvedChapterId',
        'status', 'kind', 'urgency', 'evidenceChapterIds',
    ],
    memory: [
        'id', 'kind', 'summary', 'chapterId', 'importance', 'tags', 'status', 'supersededById',
        'confidence', 'sourceChapterIds',
    ],
    facts: [
        'id', 'summary', 'subjectEntityId', 'sourceChapterId', 'status', 'supersededById',
        'confidence', 'tags',
    ],
    knowledge: ['id', 'entityId', 'factId', 'stance', 'learnedChapterId', 'status'],
    timeline: ['id', 'label', 'storyTime', 'sequence', 'chapterId', 'locationEntityId', 'status'],
});
const LEGACY_STORY_STATE_RECORD_FIELDS = Object.freeze({
    entities: ['id', 'kind', 'name', 'summary', 'aliases', 'status'],
    relations: ['id', 'fromEntityId', 'toEntityId', 'kind', 'summary', 'status'],
    events: ['id', 'kind', 'title', 'summary', 'chapterId', 'entityIds', 'status', 'order'],
    promises: [
        'id', 'title', 'summary', 'introducedChapterId', 'dueChapterId', 'resolvedChapterId', 'status',
    ],
    memory: ['id', 'kind', 'summary', 'chapterId', 'importance', 'tags'],
});
const KNOWLEDGE_STANCES = new Set(['knows', 'suspects', 'believes', 'denies', 'hides']);
const STORY_STATE_CHANGE_FIELDS = ['upsert', 'delete'];
const ADOPTION_FIELDS = [
    'generationId', 'kind', 'content', 'chapterSummary', 'storyStateChanges',
    'chapterCard', 'review', 'notes', 'status',
];
const ADOPTION_CONTENT_FIELDS = ['mode', 'text', 'offset'];
const GENERATION_HISTORY_FIELDS = [
    'generationId', 'payloadHash', 'contentHash', 'kind', 'mode', 'contentUnits',
    'previousRevision', 'resultingRevision', 'adoptedAt',
];
const GENERATION_MODES = new Set(['replace', 'append', 'insert', 'none']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_GENERATION_HISTORY = 20_000;
const IMPORT_FIELDS = ['format', 'schemaVersion', 'exportedAt', 'project', 'chapters', 'resources'];
const IMPORT_PROJECT_FIELDS = [
    'schemaVersion', 'id', 'title', 'genre', 'targetWords', 'chapterTargetWords', 'story', 'continuity',
    'storyState', 'volumes', 'chapters', 'chapterBytes', 'resources', 'version', 'createdAt', 'updatedAt',
];
const CLEANED_STAGING_ROOTS = new Set();
const ACTIVE_LOCK_TOKENS = new Set();
const PROCESS_INSTANCE_ID = randomUUID();
const RESOURCE_REFERENCE_FIELDS = [
    'characterIds', 'lorebookIds', 'promptProfileIds', 'activeCharacterIds', 'activeLorebookIds',
    'activePromptProfileId', 'activePersonaId',
];
const RESOURCE_EXPORT_FIELDS = ['characters', 'lorebooks', 'promptProfiles'];
const RESOURCE_DIRECTORY_BY_TYPE = Object.freeze({
    character: 'characters',
    lorebook: 'lorebooks',
    'prompt-profile': 'prompt-profiles',
});
const RESOURCE_REFERENCE_BY_TYPE = Object.freeze({
    character: 'characterIds',
    lorebook: 'lorebookIds',
    'prompt-profile': 'promptProfileIds',
});
const RESOURCE_ACTIVE_REFERENCE_BY_TYPE = Object.freeze({
    character: 'activeCharacterIds',
    lorebook: 'activeLorebookIds',
    'prompt-profile': 'activePromptProfileId',
});
const RESOURCE_EXPORT_BY_TYPE = Object.freeze({
    character: 'characters',
    lorebook: 'lorebooks',
    'prompt-profile': 'promptProfiles',
});
const RESOURCE_TYPES = Object.keys(RESOURCE_DIRECTORY_BY_TYPE);
const MAX_RESOURCE_REFERENCES = 10_000;
const MAX_RESOURCE_JOURNAL_OPERATIONS = RESOURCE_TYPES.length * MAX_RESOURCE_REFERENCES * 2;
const RESOURCE_JOURNAL_FILE = '.pending-resource-write.json';
const CHAPTER_OPERATIONS_JOURNAL_FILE = '.pending-chapter-operations.json';
const SCHEMA_MIGRATION_JOURNAL_FILE = '.pending-schema-migration.json';
const CHAPTER_WRITE_MUTABLE_PROJECT_FIELDS = ['chapters', 'chapterBytes', 'storyState', 'version', 'updatedAt'];
const CHAPTER_OPERATIONS_MUTABLE_PROJECT_FIELDS = [
    'volumes', 'chapters', 'chapterBytes', 'continuity', 'storyState', 'version', 'updatedAt',
];
const RESOURCE_WRITE_MUTABLE_PROJECT_FIELDS = ['resources', 'version', 'updatedAt'];

export class StoryStudioError extends Error {
    /**
     * @param {string} message Error message
     * @param {number} status HTTP-compatible status code
     * @param {string} code Stable error code
     * @param {object} [details] Additional response details
     */
    constructor(message, status, code, details = {}) {
        super(message);
        this.name = 'StoryStudioError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/**
 * Counts Chinese characters and non-Chinese word runs for a practical manuscript count.
 * @param {string} text Manuscript text
 * @returns {number} Content unit count
 */
export function countContentUnits(text) {
    const source = String(text ?? '');
    const chineseCharacters = source.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const otherWords = source
        .replace(/[\p{Script=Han}]/gu, ' ')
        .match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    return chineseCharacters + otherWords;
}

function nowIso() {
    return new Date().toISOString();
}

function isProcessAlive(pid) {
    const processId = Number(pid);
    if (!Number.isSafeInteger(processId) || processId <= 0) return false;
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function isOwnerProcessAlive(record) {
    if (!record || record.releasedAt) return false;
    if (Number(record.pid) === process.pid && record.instanceId && record.instanceId !== PROCESS_INSTANCE_ID) {
        return false;
    }
    return isProcessAlive(record.pid);
}

function isLockOwnerActive(record) {
    if (!isOwnerProcessAlive(record)) return false;
    if (Number(record.pid) === process.pid) return ACTIVE_LOCK_TOKENS.has(record.token);
    return true;
}

function readOwnerRecord(filePath) {
    const value = fs.readFileSync(filePath, 'utf8');
    try {
        const record = JSON.parse(value);
        if (record && typeof record === 'object') return record;
    } catch {
        // Locks written before owner metadata used the token as plain text.
    }
    return { token: value, pid: null };
}

function assertId(value, fieldName) {
    if (typeof value !== 'string' || !VALID_ID.test(value)) {
        throw new StoryStudioError(`Invalid ${fieldName}.`, 400, 'invalid_id');
    }
    return value;
}

function cleanText(value, fieldName, maxLength, fallback = '') {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== 'string') {
        throw new StoryStudioError(`${fieldName} must be a string.`, 400, 'invalid_text');
    }
    if (value.length > maxLength) {
        throw new StoryStudioError(`${fieldName} is too long.`, 400, 'text_too_long', { field: fieldName, maxLength });
    }
    return value;
}

function cleanInteger(value, fieldName, minimum, maximum, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new StoryStudioError(`${fieldName} must be an integer between ${minimum} and ${maximum}.`, 400, 'invalid_number');
    }
    return number;
}

function cleanNumber(value, fieldName, minimum, maximum, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new StoryStudioError(`${fieldName} must be a number between ${minimum} and ${maximum}.`, 400, 'invalid_number');
    }
    return number;
}

function serializedByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertPayloadSize(value, maximum, label) {
    const byteLength = serializedByteLength(value);
    if (byteLength > maximum) {
        throw new StoryStudioError(`${label} exceeds the storage limit.`, 413, 'payload_too_large', { maximum });
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new StoryStudioError(`${label} must be an object.`, 400, `invalid_${label.replaceAll(' ', '_')}`);
    }
    return value;
}

function assertKnownKeys(value, allowedKeys, label) {
    const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
        throw new StoryStudioError(`${label} contains unknown fields.`, 400, 'unknown_fields', { fields: unknownKeys });
    }
}

function projectFieldsForSchema(schemaVersion) {
    return IMPORT_PROJECT_FIELDS.filter(field => !(
        (field === 'resources' && schemaVersion < RESOURCE_STORY_STUDIO_SCHEMA_VERSION)
        || (field === 'storyState' && schemaVersion < STORY_STATE_STORY_STUDIO_SCHEMA_VERSION)
        || (field === 'volumes' && schemaVersion < VOLUME_STORY_STUDIO_SCHEMA_VERSION)
    ));
}

function chapterFieldsForSchema(schemaVersion) {
    return CHAPTER_RECORD_FIELDS.filter(field => !(
        (field === 'generationHistory' && schemaVersion < STORY_STATE_STORY_STUDIO_SCHEMA_VERSION)
        || (['volumeId', 'planBasis'].includes(field) && schemaVersion < VOLUME_STORY_STUDIO_SCHEMA_VERSION)
    ));
}

function schemaShapeError(label, unknownKeys, options = {}) {
    return new StoryStudioError(
        `${label} contains fields that did not exist in its declared schema version.`,
        options.status ?? 400,
        options.code ?? 'unknown_fields',
        { fields: unknownKeys },
    );
}

function assertSchemaKnownKeys(value, allowedKeys, label, options = {}) {
    const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) throw schemaShapeError(label, unknownKeys, options);
}

function assertStoryStateSchemaShape(value, schemaVersion, label = 'storyState', options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const categories = schemaVersion >= STORY_STUDIO_SCHEMA_VERSION
        ? STORY_STATE_FIELDS
        : LEGACY_STORY_STATE_FIELDS;
    const recordFields = schemaVersion >= STORY_STUDIO_SCHEMA_VERSION
        ? STORY_STATE_RECORD_FIELDS
        : LEGACY_STORY_STATE_RECORD_FIELDS;
    assertSchemaKnownKeys(value, categories, label, options);
    for (const category of categories) {
        if (!Array.isArray(value[category])) continue;
        for (const [index, record] of value[category].entries()) {
            if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
            assertSchemaKnownKeys(record, recordFields[category], `${label}.${category}[${index}]`, options);
        }
    }
}

function assertProjectSchemaShape(project, schemaVersion, label = 'project', options = {}) {
    assertSchemaKnownKeys(project, projectFieldsForSchema(schemaVersion), label, options);
    if (Array.isArray(project.chapters)) {
        const summaryFields = schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
            ? CHAPTER_SUMMARY_FIELDS
            : LEGACY_CHAPTER_SUMMARY_FIELDS;
        for (const [index, summary] of project.chapters.entries()) {
            if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
            assertSchemaKnownKeys(summary, summaryFields, `${label}.chapters[${index}]`, options);
        }
    }
    if (schemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
        assertStoryStateSchemaShape(project.storyState, schemaVersion, `${label}.storyState`, options);
    }
}

function assertChapterSchemaShape(chapter, schemaVersion, label = 'chapter', options = {}) {
    assertSchemaKnownKeys(chapter, chapterFieldsForSchema(schemaVersion), label, options);
}

function assertAllowedKeys(value, allowedKeys, label) {
    assertKnownKeys(value, allowedKeys, label);
    if (Object.keys(value).length === 0) {
        throw new StoryStudioError(`${label} cannot be empty.`, 400, 'empty_changes');
    }
}

function normalizeStory(value = {}) {
    assertPlainObject(value, 'story');
    assertKnownKeys(value, STORY_FIELDS, 'story');
    return Object.fromEntries(STORY_FIELDS.map(field => [field, cleanText(value[field], `story.${field}`, 250_000)]));
}

function normalizeCard(value = {}) {
    assertPlainObject(value, 'card');
    assertKnownKeys(value, CARD_FIELDS, 'card');
    return Object.fromEntries(CARD_FIELDS.map(field => [field, cleanText(value[field], `card.${field}`, 100_000)]));
}

function normalizePlanBasis(value = {}) {
    assertPlainObject(value, 'planBasis');
    assertKnownKeys(value, PLAN_BASIS_FIELDS, 'planBasis');
    return {
        volumeRevision: cleanInteger(value.volumeRevision, 'planBasis.volumeRevision', 0, 100_000_000, 0),
    };
}

function normalizeVolume(value, index, label = `volumes[${index}]`) {
    assertPlainObject(value, label);
    assertKnownKeys(value, VOLUME_FIELDS, label);
    const number = cleanInteger(value.number, `${label}.number`, 1, MAX_PROJECT_VOLUMES, index + 1);
    const createdAt = cleanText(value.createdAt, `${label}.createdAt`, 64);
    const updatedAt = cleanText(value.updatedAt, `${label}.updatedAt`, 64);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
        throw new StoryStudioError(`${label} has invalid timestamps.`, 400, 'invalid_volumes');
    }
    return {
        id: assertId(value.id, `${label}.id`),
        number,
        title: cleanText(value.title, `${label}.title`, 160, `第${number}卷`),
        goal: cleanText(value.goal, `${label}.goal`, 100_000),
        outline: cleanText(value.outline, `${label}.outline`, 250_000),
        summary: cleanText(value.summary, `${label}.summary`, 100_000),
        revision: cleanInteger(value.revision, `${label}.revision`, 1, 100_000_000, 1),
        createdAt,
        updatedAt,
    };
}

function normalizeVolumes(value = []) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECT_VOLUMES) {
        throw new StoryStudioError(
            `volumes must contain between 1 and ${MAX_PROJECT_VOLUMES} records.`,
            400,
            'invalid_volumes',
        );
    }
    const volumes = value.map((item, index) => normalizeVolume(item, index));
    const ids = new Set();
    for (const [index, volume] of volumes.entries()) {
        if (ids.has(volume.id)) {
            throw new StoryStudioError('volumes contains duplicate ids.', 400, 'duplicate_volume_id', { id: volume.id });
        }
        ids.add(volume.id);
        if (volume.number !== index + 1) {
            throw new StoryStudioError('Volume numbers must be contiguous.', 400, 'invalid_volume_order');
        }
    }
    return volumes;
}

function createVolume(number, input = {}, timestamp = nowIso()) {
    assertPlainObject(input, 'volume');
    if (Object.keys(input).length > 0) assertAllowedKeys(input, VOLUME_CHANGE_FIELDS, 'volume');
    return normalizeVolume({
        id: randomUUID(),
        number,
        title: cleanText(input.title, 'volume.title', 160, `第${number}卷`),
        goal: cleanText(input.goal, 'volume.goal', 100_000),
        outline: cleanText(input.outline, 'volume.outline', 250_000),
        summary: cleanText(input.summary, 'volume.summary', 100_000),
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
    }, number - 1, 'volume');
}

function assertVolumeChapterLayout(volumesValue, chapterSummaries, schemaVersion = STORY_STUDIO_SCHEMA_VERSION) {
    if (schemaVersion < VOLUME_STORY_STUDIO_SCHEMA_VERSION) return;
    const volumes = normalizeVolumes(volumesValue);
    const volumeNumberById = new Map(volumes.map(volume => [volume.id, volume.number]));
    let previousVolumeNumber = 0;
    for (const [index, summary] of chapterSummaries.entries()) {
        assertPlainObject(summary, `chapters[${index}]`);
        assertKnownKeys(summary, CHAPTER_SUMMARY_FIELDS, `chapters[${index}]`);
        const volumeId = assertId(summary.volumeId, `chapters[${index}].volumeId`);
        const volumeNumber = volumeNumberById.get(volumeId);
        if (!volumeNumber) {
            throw new StoryStudioError('Chapter refers to an unknown volume.', 400, 'invalid_volume_reference', {
                chapterId: summary.id,
                volumeId,
            });
        }
        if (volumeNumber < previousVolumeNumber) {
            throw new StoryStudioError('Chapter volume blocks must not interleave.', 400, 'interleaved_volume_blocks');
        }
        previousVolumeNumber = volumeNumber;
        if (summary.number !== index + 1) {
            throw new StoryStudioError('Chapter numbers must be contiguous.', 400, 'invalid_chapter_order');
        }
        normalizePlanBasis(summary.planBasis);
    }
}

function normalizeCandidate(value = {}) {
    assertPlainObject(value, 'candidate');
    assertKnownKeys(value, CANDIDATE_FIELDS, 'candidate');
    const createdAt = value.createdAt === null || value.createdAt === undefined
        ? null
        : cleanText(value.createdAt, 'candidate.createdAt', 64);
    return {
        kind: cleanText(value.kind, 'candidate.kind', 32),
        content: cleanText(value.content, 'candidate.content', 5_000_000),
        createdAt,
    };
}

function normalizeContinuityEntry(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new StoryStudioError(`continuity[${index}] must be an object.`, 400, 'invalid_continuity');
    }
    assertKnownKeys(value, CONTINUITY_FIELDS, `continuity[${index}]`);
    return {
        id: typeof value.id === 'string' && VALID_ID.test(value.id) ? value.id : randomUUID(),
        category: cleanText(value.category, `continuity[${index}].category`, 40, 'setting'),
        label: cleanText(value.label, `continuity[${index}].label`, 160),
        detail: cleanText(value.detail, `continuity[${index}].detail`, 20_000),
        status: cleanText(value.status, `continuity[${index}].status`, 40, 'active'),
        firstSeenChapter: cleanInteger(value.firstSeenChapter, `continuity[${index}].firstSeenChapter`, 0, 100_000, 0),
        lastTouchedChapter: cleanInteger(value.lastTouchedChapter, `continuity[${index}].lastTouchedChapter`, 0, 100_000, 0),
    };
}

function normalizeContinuity(value = []) {
    if (!Array.isArray(value) || value.length > 10_000) {
        throw new StoryStudioError('continuity must be an array with at most 10000 entries.', 400, 'invalid_continuity');
    }
    const entries = value.map(normalizeContinuityEntry);
    const firstIndexById = new Map();
    for (const [index, entry] of entries.entries()) {
        const firstIndex = firstIndexById.get(entry.id);
        if (firstIndex !== undefined) {
            throw new StoryStudioError('continuity contains duplicate entry ids.', 400, 'duplicate_continuity_id', {
                id: entry.id,
                firstIndex,
                duplicateIndex: index,
            });
        }
        firstIndexById.set(entry.id, index);
    }
    return entries;
}

function remapContinuityChapterNumbers(entries, previousChapters, nextChapters) {
    const chapterIdByPreviousNumber = new Map(previousChapters.map(chapter => [chapter.number, chapter.id]));
    const nextNumberByChapterId = new Map(nextChapters.map(chapter => [chapter.id, chapter.number]));
    const remap = value => {
        const number = Number(value || 0);
        if (number === 0) return 0;
        const chapterId = chapterIdByPreviousNumber.get(number);
        if (!chapterId) return number;
        return nextNumberByChapterId.get(chapterId) ?? 0;
    };
    return entries.map(entry => ({
        ...entry,
        firstSeenChapter: remap(entry.firstSeenChapter),
        lastTouchedChapter: remap(entry.lastTouchedChapter),
    }));
}

function cleanRequiredText(value, fieldName, maxLength) {
    const text = cleanText(value, fieldName, maxLength);
    if (text.trim().length === 0) {
        throw new StoryStudioError(`${fieldName} cannot be empty.`, 400, 'invalid_text', { field: fieldName });
    }
    return text;
}

function cleanNullableId(value, fieldName) {
    return value === undefined || value === null || value === '' ? null : assertId(value, fieldName);
}

function normalizeStringArray(value, fieldName, maximumItems, maximumLength) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > maximumItems) {
        throw new StoryStudioError(`${fieldName} must be an array with at most ${maximumItems} entries.`, 400, 'invalid_story_state');
    }
    const items = value.map((item, index) => cleanRequiredText(item, `${fieldName}[${index}]`, maximumLength));
    if (new Set(items).size !== items.length) {
        throw new StoryStudioError(`${fieldName} contains duplicate values.`, 400, 'duplicate_story_state_value', { field: fieldName });
    }
    return items;
}

function normalizeStoryStateRecord(category, value, index) {
    const label = `storyState.${category}[${index}]`;
    assertPlainObject(value, label);
    assertKnownKeys(value, STORY_STATE_RECORD_FIELDS[category], label);
    const id = assertId(value.id, `${label}.id`);
    if (category === 'entities') {
        return {
            id,
            kind: cleanRequiredText(value.kind ?? 'character', `${label}.kind`, 64),
            name: cleanRequiredText(value.name, `${label}.name`, 240),
            summary: cleanText(value.summary, `${label}.summary`, 20_000),
            aliases: normalizeStringArray(value.aliases, `${label}.aliases`, 100, 240),
            status: cleanText(value.status, `${label}.status`, 64, 'active'),
            locationEntityId: cleanNullableId(value.locationEntityId, `${label}.locationEntityId`),
            currentGoal: cleanText(value.currentGoal, `${label}.currentGoal`, 20_000),
            currentAction: cleanText(value.currentAction, `${label}.currentAction`, 20_000),
            updatedChapterId: cleanNullableId(value.updatedChapterId, `${label}.updatedChapterId`),
        };
    }
    if (category === 'relations') {
        return {
            id,
            fromEntityId: assertId(value.fromEntityId, `${label}.fromEntityId`),
            toEntityId: assertId(value.toEntityId, `${label}.toEntityId`),
            kind: cleanRequiredText(value.kind ?? 'related', `${label}.kind`, 64),
            summary: cleanText(value.summary, `${label}.summary`, 20_000),
            status: cleanText(value.status, `${label}.status`, 64, 'active'),
            addressing: cleanText(value.addressing, `${label}.addressing`, 240),
            publicSummary: cleanText(value.publicSummary, `${label}.publicSummary`, 20_000),
            privateSummary: cleanText(value.privateSummary, `${label}.privateSummary`, 20_000),
            sinceChapterId: cleanNullableId(value.sinceChapterId, `${label}.sinceChapterId`),
        };
    }
    if (category === 'events') {
        return {
            id,
            kind: cleanRequiredText(value.kind ?? 'story', `${label}.kind`, 64),
            title: cleanRequiredText(value.title, `${label}.title`, 240),
            summary: cleanText(value.summary, `${label}.summary`, 40_000),
            chapterId: cleanNullableId(value.chapterId, `${label}.chapterId`),
            entityIds: normalizeStoryIdArray(value.entityIds, `${label}.entityIds`, 1_000),
            status: cleanText(value.status, `${label}.status`, 64, 'occurred'),
            order: cleanInteger(value.order, `${label}.order`, 0, 10_000_000, 0),
            timelineId: cleanNullableId(value.timelineId, `${label}.timelineId`),
            locationEntityId: cleanNullableId(value.locationEntityId, `${label}.locationEntityId`),
            progress: cleanInteger(value.progress, `${label}.progress`, 0, 100, 0),
            visibility: cleanText(value.visibility, `${label}.visibility`, 64, 'public'),
        };
    }
    if (category === 'promises') {
        return {
            id,
            title: cleanRequiredText(value.title, `${label}.title`, 240),
            summary: cleanText(value.summary, `${label}.summary`, 40_000),
            introducedChapterId: cleanNullableId(value.introducedChapterId, `${label}.introducedChapterId`),
            dueChapterId: cleanNullableId(value.dueChapterId, `${label}.dueChapterId`),
            resolvedChapterId: cleanNullableId(value.resolvedChapterId, `${label}.resolvedChapterId`),
            status: cleanText(value.status, `${label}.status`, 64, 'open'),
            kind: cleanText(value.kind, `${label}.kind`, 64, 'foreshadowing'),
            urgency: cleanInteger(value.urgency, `${label}.urgency`, 0, 5, 0),
            evidenceChapterIds: normalizeStoryIdArray(value.evidenceChapterIds, `${label}.evidenceChapterIds`, 1_000),
        };
    }
    if (category === 'memory') {
        return {
            id,
            kind: cleanRequiredText(value.kind ?? 'chapter', `${label}.kind`, 64),
            summary: cleanRequiredText(value.summary, `${label}.summary`, 40_000),
            chapterId: cleanNullableId(value.chapterId, `${label}.chapterId`),
            importance: cleanInteger(value.importance, `${label}.importance`, 0, 5, 3),
            tags: normalizeStringArray(value.tags, `${label}.tags`, 100, 80),
            status: cleanText(value.status, `${label}.status`, 64, 'active'),
            supersededById: cleanNullableId(value.supersededById, `${label}.supersededById`),
            confidence: cleanNumber(value.confidence, `${label}.confidence`, 0, 1, 1),
            sourceChapterIds: normalizeStoryIdArray(value.sourceChapterIds, `${label}.sourceChapterIds`, 1_000),
        };
    }
    if (category === 'facts') {
        const supersededById = cleanNullableId(value.supersededById, `${label}.supersededById`);
        const status = cleanText(value.status, `${label}.status`, 64, 'active');
        return {
            id,
            summary: cleanRequiredText(value.summary, `${label}.summary`, 40_000),
            subjectEntityId: cleanNullableId(value.subjectEntityId, `${label}.subjectEntityId`),
            sourceChapterId: cleanNullableId(value.sourceChapterId, `${label}.sourceChapterId`),
            status: supersededById === null ? status : 'retired',
            supersededById,
            confidence: cleanNumber(value.confidence, `${label}.confidence`, 0, 1, 1),
            tags: normalizeStringArray(value.tags, `${label}.tags`, 100, 80),
        };
    }
    if (category === 'knowledge') {
        const stance = cleanRequiredText(value.stance ?? 'knows', `${label}.stance`, 32);
        if (!KNOWLEDGE_STANCES.has(stance)) {
            throw new StoryStudioError(`${label}.stance is invalid.`, 400, 'invalid_story_state', {
                field: `${label}.stance`,
            });
        }
        return {
            id,
            entityId: assertId(value.entityId, `${label}.entityId`),
            factId: assertId(value.factId, `${label}.factId`),
            stance,
            learnedChapterId: cleanNullableId(value.learnedChapterId, `${label}.learnedChapterId`),
            status: cleanText(value.status, `${label}.status`, 64, 'active'),
        };
    }
    return {
        id,
        label: cleanRequiredText(value.label, `${label}.label`, 240),
        storyTime: cleanText(value.storyTime, `${label}.storyTime`, 240),
        sequence: cleanInteger(value.sequence, `${label}.sequence`, 0, 100_000_000, 0),
        chapterId: cleanNullableId(value.chapterId, `${label}.chapterId`),
        locationEntityId: cleanNullableId(value.locationEntityId, `${label}.locationEntityId`),
        status: cleanText(value.status, `${label}.status`, 64, 'active'),
    };
}

function normalizeStoryIdArray(value, label, maximum) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > maximum) {
        throw new StoryStudioError(`${label} must be an array with at most ${maximum} ids.`, 400, 'invalid_story_state');
    }
    const ids = value.map((item, index) => assertId(item, `${label}[${index}]`));
    if (new Set(ids).size !== ids.length) {
        throw new StoryStudioError(`${label} contains duplicate ids.`, 400, 'duplicate_story_state_id');
    }
    return ids;
}

function validateStoryStateReferences(storyState, chapterIds = []) {
    const entityIds = new Set(storyState.entities.map(item => item.id));
    const factIds = new Set(storyState.facts.map(item => item.id));
    const timelineIds = new Set(storyState.timeline.map(item => item.id));
    const memoryIds = new Set(storyState.memory.map(item => item.id));
    const knownChapterIds = new Set(chapterIds);
    const assertEntityReference = (id, field) => {
        if (!entityIds.has(id)) {
            throw new StoryStudioError(`${field} refers to an unknown entity.`, 400, 'invalid_story_reference', { field, id });
        }
    };
    const assertChapterReference = (id, field) => {
        if (id !== null && !knownChapterIds.has(id)) {
            throw new StoryStudioError(`${field} refers to an unknown chapter.`, 400, 'invalid_story_reference', { field, id });
        }
    };
    const assertOptionalReference = (id, ids, field, kind, ownerId = null) => {
        if (id === null) return;
        if (!ids.has(id)) {
            throw new StoryStudioError(`${field} refers to an unknown ${kind}.`, 400, 'invalid_story_reference', { field, id });
        }
        if (ownerId !== null && id === ownerId) {
            throw new StoryStudioError(`${field} cannot refer to itself.`, 400, 'invalid_story_reference', { field, id });
        }
    };
    const assertAcyclicSupersession = (records, category) => {
        const nextById = new Map(records.map(record => [record.id, record.supersededById]));
        const resolved = new Set();
        for (const record of records) {
            if (resolved.has(record.id)) continue;
            const pathIds = [];
            const pathSet = new Set();
            let nextId = record.id;
            while (nextId !== null && !resolved.has(nextId)) {
                if (pathSet.has(nextId)) {
                    throw new StoryStudioError(
                        `storyState.${category} contains a supersession cycle.`,
                        400,
                        'invalid_story_reference',
                        { category, id: record.id },
                    );
                }
                pathIds.push(nextId);
                pathSet.add(nextId);
                nextId = nextById.get(nextId) ?? null;
            }
            for (const id of pathIds) resolved.add(id);
        }
    };
    for (const [index, entity] of storyState.entities.entries()) {
        assertOptionalReference(entity.locationEntityId, entityIds, `storyState.entities[${index}].locationEntityId`, 'entity');
        assertChapterReference(entity.updatedChapterId, `storyState.entities[${index}].updatedChapterId`);
    }
    for (const [index, relation] of storyState.relations.entries()) {
        assertEntityReference(relation.fromEntityId, `storyState.relations[${index}].fromEntityId`);
        assertEntityReference(relation.toEntityId, `storyState.relations[${index}].toEntityId`);
        assertChapterReference(relation.sinceChapterId, `storyState.relations[${index}].sinceChapterId`);
    }
    for (const [index, event] of storyState.events.entries()) {
        assertChapterReference(event.chapterId, `storyState.events[${index}].chapterId`);
        event.entityIds.forEach((id, entityIndex) => assertEntityReference(id, `storyState.events[${index}].entityIds[${entityIndex}]`));
        assertOptionalReference(event.timelineId, timelineIds, `storyState.events[${index}].timelineId`, 'timeline entry');
        assertOptionalReference(event.locationEntityId, entityIds, `storyState.events[${index}].locationEntityId`, 'entity');
    }
    for (const [index, promise] of storyState.promises.entries()) {
        assertChapterReference(promise.introducedChapterId, `storyState.promises[${index}].introducedChapterId`);
        assertChapterReference(promise.dueChapterId, `storyState.promises[${index}].dueChapterId`);
        assertChapterReference(promise.resolvedChapterId, `storyState.promises[${index}].resolvedChapterId`);
        promise.evidenceChapterIds.forEach((id, chapterIndex) => (
            assertChapterReference(id, `storyState.promises[${index}].evidenceChapterIds[${chapterIndex}]`)
        ));
    }
    for (const [index, memory] of storyState.memory.entries()) {
        assertChapterReference(memory.chapterId, `storyState.memory[${index}].chapterId`);
        memory.sourceChapterIds.forEach((id, chapterIndex) => (
            assertChapterReference(id, `storyState.memory[${index}].sourceChapterIds[${chapterIndex}]`)
        ));
        assertOptionalReference(memory.supersededById, memoryIds, `storyState.memory[${index}].supersededById`, 'memory', memory.id);
    }
    for (const [index, fact] of storyState.facts.entries()) {
        assertOptionalReference(fact.subjectEntityId, entityIds, `storyState.facts[${index}].subjectEntityId`, 'entity');
        assertChapterReference(fact.sourceChapterId, `storyState.facts[${index}].sourceChapterId`);
        assertOptionalReference(fact.supersededById, factIds, `storyState.facts[${index}].supersededById`, 'fact', fact.id);
    }
    for (const [index, item] of storyState.knowledge.entries()) {
        assertEntityReference(item.entityId, `storyState.knowledge[${index}].entityId`);
        assertOptionalReference(item.factId, factIds, `storyState.knowledge[${index}].factId`, 'fact');
        assertChapterReference(item.learnedChapterId, `storyState.knowledge[${index}].learnedChapterId`);
    }
    for (const [index, item] of storyState.timeline.entries()) {
        assertChapterReference(item.chapterId, `storyState.timeline[${index}].chapterId`);
        assertOptionalReference(item.locationEntityId, entityIds, `storyState.timeline[${index}].locationEntityId`, 'entity');
    }
    assertAcyclicSupersession(storyState.facts, 'facts');
    assertAcyclicSupersession(storyState.memory, 'memory');
}

function emptyStoryState() {
    return {
        entities: [], relations: [], events: [], promises: [], memory: [], facts: [], knowledge: [], timeline: [],
    };
}

function normalizeStoryState(value = {}, chapterIds = []) {
    assertPlainObject(value, 'storyState');
    assertKnownKeys(value, STORY_STATE_FIELDS, 'storyState');
    const storyState = {};
    for (const category of STORY_STATE_FIELDS) {
        const records = value[category] ?? [];
        if (!Array.isArray(records) || records.length > STORY_STATE_LIMITS[category]) {
            throw new StoryStudioError(
                `storyState.${category} must be an array with at most ${STORY_STATE_LIMITS[category]} entries.`,
                400,
                'invalid_story_state',
            );
        }
        storyState[category] = records.map((record, index) => normalizeStoryStateRecord(category, record, index));
        const firstIndexById = new Map();
        for (const [index, record] of storyState[category].entries()) {
            const firstIndex = firstIndexById.get(record.id);
            if (firstIndex !== undefined) {
                throw new StoryStudioError(`storyState.${category} contains duplicate ids.`, 400, 'duplicate_story_state_id', {
                    category,
                    id: record.id,
                    firstIndex,
                    duplicateIndex: index,
                });
            }
            firstIndexById.set(record.id, index);
        }
    }
    validateStoryStateReferences(storyState, chapterIds);
    return storyState;
}

function normalizeGenerationHistoryEntry(value, index) {
    const label = `generationHistory[${index}]`;
    assertPlainObject(value, label);
    assertKnownKeys(value, GENERATION_HISTORY_FIELDS, label);
    const mode = cleanRequiredText(value.mode, `${label}.mode`, 16);
    if (!GENERATION_MODES.has(mode)) {
        throw new StoryStudioError(`${label}.mode is invalid.`, 400, 'invalid_generation_history');
    }
    const payloadHash = cleanRequiredText(value.payloadHash, `${label}.payloadHash`, 64);
    const contentHash = cleanRequiredText(value.contentHash, `${label}.contentHash`, 64);
    if (!SHA256_HEX.test(payloadHash) || !SHA256_HEX.test(contentHash)) {
        throw new StoryStudioError(`${label} contains an invalid digest.`, 400, 'invalid_generation_history');
    }
    const entry = {
        generationId: assertId(value.generationId, `${label}.generationId`),
        payloadHash,
        contentHash,
        kind: cleanText(value.kind, `${label}.kind`, 64, 'draft'),
        mode,
        contentUnits: cleanInteger(value.contentUnits, `${label}.contentUnits`, 0, 100_000_000, 0),
        previousRevision: cleanInteger(value.previousRevision, `${label}.previousRevision`, 1, 100_000_000, 1),
        resultingRevision: cleanInteger(value.resultingRevision, `${label}.resultingRevision`, 2, 100_000_001, 2),
        adoptedAt: cleanRequiredText(value.adoptedAt, `${label}.adoptedAt`, 64),
    };
    if (entry.resultingRevision !== entry.previousRevision + 1 || Number.isNaN(Date.parse(entry.adoptedAt))) {
        throw new StoryStudioError(`${label} contains inconsistent metadata.`, 400, 'invalid_generation_history');
    }
    return entry;
}

function normalizeGenerationHistory(value = []) {
    if (!Array.isArray(value) || value.length > MAX_GENERATION_HISTORY) {
        throw new StoryStudioError(`generationHistory must contain at most ${MAX_GENERATION_HISTORY} entries.`, 400, 'invalid_generation_history');
    }
    const history = value.map(normalizeGenerationHistoryEntry);
    const ids = new Set();
    for (const entry of history) {
        if (ids.has(entry.generationId)) {
            throw new StoryStudioError('generationHistory contains duplicate generation ids.', 400, 'duplicate_generation_id', {
                generationId: entry.generationId,
            });
        }
        ids.add(entry.generationId);
    }
    return history;
}

function normalizeStoryStateChanges(value = {}) {
    assertPlainObject(value, 'storyStateChanges');
    assertKnownKeys(value, STORY_STATE_FIELDS, 'storyStateChanges');
    const changes = {};
    for (const category of STORY_STATE_FIELDS) {
        const categoryChanges = value[category];
        if (categoryChanges === undefined) {
            changes[category] = { upsert: [], delete: [] };
            continue;
        }
        const label = `storyStateChanges.${category}`;
        assertPlainObject(categoryChanges, label);
        assertKnownKeys(categoryChanges, STORY_STATE_CHANGE_FIELDS, label);
        const upsert = categoryChanges.upsert ?? [];
        const deleted = categoryChanges.delete ?? [];
        const maximum = STORY_STATE_LIMITS[category];
        if (!Array.isArray(upsert) || upsert.length > maximum || !Array.isArray(deleted) || deleted.length > maximum) {
            throw new StoryStudioError(`${label} exceeds its mutation limit.`, 400, 'invalid_story_state_changes', { maximum });
        }
        const normalizedUpserts = upsert.map((record, index) => {
            const recordLabel = `${label}.upsert[${index}]`;
            assertPlainObject(record, recordLabel);
            assertKnownKeys(record, STORY_STATE_RECORD_FIELDS[category], recordLabel);
            return { ...record, id: assertId(record.id, `${recordLabel}.id`) };
        });
        const normalizedDeletes = deleted.map((id, index) => assertId(id, `${label}.delete[${index}]`));
        if (new Set(normalizedDeletes).size !== normalizedDeletes.length) {
            throw new StoryStudioError(`${label}.delete contains duplicate ids.`, 400, 'duplicate_story_state_id', { category });
        }
        const upsertIds = new Set(normalizedUpserts.map(record => record.id));
        const overlap = normalizedDeletes.find(id => upsertIds.has(id));
        if (overlap !== undefined) {
            throw new StoryStudioError(`${label} cannot delete and upsert the same id.`, 400, 'ambiguous_story_state_change', {
                category,
                id: overlap,
            });
        }
        changes[category] = { upsert: normalizedUpserts, delete: normalizedDeletes };
    }
    return changes;
}

function hasStoryStateChanges(changes) {
    return STORY_STATE_FIELDS.some(category => changes[category].upsert.length > 0 || changes[category].delete.length > 0);
}

function assertFactSupersessionPreserved(current, next) {
    const nextFactsById = new Map(next.facts.map(fact => [fact.id, fact]));
    for (const fact of current.facts) {
        if (fact.supersededById === null) continue;
        const nextFact = nextFactsById.get(fact.id);
        if (!nextFact || nextFact.supersededById !== fact.supersededById) {
            throw new StoryStudioError(
                'A superseded fact and its replacement link must remain in the audit trail.',
                400,
                'immutable_fact_supersession',
                { factId: fact.id, supersededById: fact.supersededById },
            );
        }
    }
}

function assertProtectedStoryStateEmpty(storyState) {
    const fields = PROTECTED_STORY_STATE_FIELDS.filter(category => storyState[category].length > 0);
    if (fields.length > 0) {
        throw new StoryStudioError(
            'Facts, knowledge, and timeline records can only be created through adoption or import.',
            400,
            'protected_story_state',
            { fields },
        );
    }
}

function assertProtectedStoryStateInputEmpty(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const fields = PROTECTED_STORY_STATE_FIELDS.filter(category => (
        Array.isArray(value[category]) && value[category].length > 0
    ));
    if (fields.length > 0) {
        throw new StoryStudioError(
            'Facts, knowledge, and timeline records can only be created through adoption or import.',
            400,
            'protected_story_state',
            { fields },
        );
    }
}

function assertProtectedStoryStateUnchanged(current, next) {
    const fields = PROTECTED_STORY_STATE_FIELDS.filter(category => (
        stableJson(current[category]) !== stableJson(next[category])
    ));
    if (fields.length > 0) {
        throw new StoryStudioError(
            'Facts, knowledge, and timeline records can only be changed through adoption.',
            400,
            'protected_story_state',
            { fields },
        );
    }
}

function applyStoryStateChanges(currentValue, changes, chapterIds) {
    const current = normalizeStoryState(currentValue, chapterIds);
    const next = {};
    for (const category of STORY_STATE_FIELDS) {
        const recordsById = new Map(current[category].map(record => [record.id, record]));
        for (const id of changes[category].delete) recordsById.delete(id);
        for (const patch of changes[category].upsert) {
            recordsById.set(patch.id, { ...(recordsById.get(patch.id) ?? {}), ...patch });
        }
        next[category] = [...recordsById.values()];
    }
    const normalizedNext = normalizeStoryState(next, chapterIds);
    assertFactSupersessionPreserved(current, normalizedNext);
    return normalizedNext;
}

export function validateStoryStateChangeSet(currentValue, value, chapterIds = []) {
    const changes = normalizeStoryStateChanges(value);
    const next = applyStoryStateChanges(currentValue, changes, chapterIds);
    return {
        changes: structuredClone(changes),
        next: structuredClone(next),
    };
}

function detachChapterStoryStateReferences(currentValue, chapterId, chapterIds) {
    const current = normalizeStoryState(currentValue, [...chapterIds, chapterId]);
    const detach = value => value === chapterId ? null : value;
    return normalizeStoryState({
        ...current,
        entities: current.entities.map(entity => ({ ...entity, updatedChapterId: detach(entity.updatedChapterId) })),
        relations: current.relations.map(relation => ({ ...relation, sinceChapterId: detach(relation.sinceChapterId) })),
        events: current.events.map(event => ({ ...event, chapterId: detach(event.chapterId) })),
        promises: current.promises.map(promise => ({
            ...promise,
            introducedChapterId: detach(promise.introducedChapterId),
            dueChapterId: detach(promise.dueChapterId),
            resolvedChapterId: detach(promise.resolvedChapterId),
            evidenceChapterIds: promise.evidenceChapterIds.filter(id => id !== chapterId),
        })),
        memory: current.memory.map(memory => ({
            ...memory,
            chapterId: detach(memory.chapterId),
            sourceChapterIds: memory.sourceChapterIds.filter(id => id !== chapterId),
        })),
        facts: current.facts.map(fact => ({ ...fact, sourceChapterId: detach(fact.sourceChapterId) })),
        knowledge: current.knowledge.map(item => ({ ...item, learnedChapterId: detach(item.learnedChapterId) })),
        timeline: current.timeline.map(item => ({ ...item, chapterId: detach(item.chapterId) })),
    }, chapterIds);
}

function normalizeAdoptionPayload(value) {
    assertPlainObject(value, 'adoption');
    assertKnownKeys(value, ADOPTION_FIELDS, 'adoption');
    const generationId = assertId(value.generationId, 'adoption.generationId');
    let content = null;
    if (value.content !== undefined && value.content !== null) {
        assertPlainObject(value.content, 'adoption.content');
        assertKnownKeys(value.content, ADOPTION_CONTENT_FIELDS, 'adoption.content');
        const mode = cleanRequiredText(value.content.mode, 'adoption.content.mode', 16);
        if (!['replace', 'append', 'insert'].includes(mode)) {
            throw new StoryStudioError('adoption.content.mode is invalid.', 400, 'invalid_adoption_mode');
        }
        if (!Object.hasOwn(value.content, 'text')) {
            throw new StoryStudioError('adoption.content.text is required.', 400, 'invalid_adoption_content');
        }
        content = {
            mode,
            text: cleanText(value.content.text, 'adoption.content.text', 5_000_000),
            offset: mode === 'insert'
                ? cleanInteger(value.content.offset, 'adoption.content.offset', 0, 5_000_000, null)
                : null,
        };
        if (mode === 'insert' && content.offset === null) {
            throw new StoryStudioError('adoption.content.offset is required for insert mode.', 400, 'invalid_adoption_offset');
        }
    }
    const storyStateChanges = normalizeStoryStateChanges(value.storyStateChanges ?? {});
    const hasChapterSummary = Object.hasOwn(value, 'chapterSummary');
    const hasChapterCard = Object.hasOwn(value, 'chapterCard');
    let chapterCard;
    if (hasChapterCard) {
        assertPlainObject(value.chapterCard, 'adoption.chapterCard');
        assertKnownKeys(value.chapterCard, CARD_FIELDS, 'adoption.chapterCard');
        const missingFields = CARD_FIELDS.filter(field => !Object.hasOwn(value.chapterCard, field));
        if (missingFields.length > 0) {
            throw new StoryStudioError('adoption.chapterCard must be a complete chapter card.', 400,
                'invalid_adoption_card', { fields: missingFields });
        }
        chapterCard = normalizeCard(value.chapterCard);
    }
    const chapterSummary = hasChapterSummary
        ? cleanText(value.chapterSummary, 'adoption.chapterSummary', 100_000)
        : null;
    if (hasChapterCard && hasChapterSummary && chapterCard.summary !== chapterSummary) {
        throw new StoryStudioError('adoption.chapterSummary must match adoption.chapterCard.summary.', 400,
            'invalid_adoption_card');
    }
    const hasReview = Object.hasOwn(value, 'review');
    const review = hasReview ? cleanText(value.review, 'adoption.review', 1_000_000) : null;
    const hasNotes = Object.hasOwn(value, 'notes');
    const notes = hasNotes ? cleanText(value.notes, 'adoption.notes', 1_000_000) : null;
    const hasStatus = Object.hasOwn(value, 'status');
    if (hasStatus && !CHAPTER_STATUSES.has(value.status)) {
        throw new StoryStudioError('adoption.status is invalid.', 400, 'invalid_status');
    }
    if (!content && !hasChapterSummary && !hasChapterCard && !hasReview && !hasNotes && !hasStatus
        && !hasStoryStateChanges(storyStateChanges)) {
        throw new StoryStudioError('Adoption contains no changes.', 400, 'empty_changes');
    }
    return {
        generationId,
        kind: cleanText(value.kind, 'adoption.kind', 64, 'draft'),
        content,
        chapterSummary,
        hasChapterSummary,
        storyStateChanges,
        ...(hasChapterCard ? { chapterCard } : {}),
        ...(hasReview ? { review } : {}),
        ...(hasNotes ? { notes } : {}),
        ...(hasStatus ? { status: value.status } : {}),
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function sha256Bytes(value) {
    return createHash('sha256').update(value).digest('hex');
}

function projectInvariantDigest(project, mutableFields) {
    const invariant = structuredClone(project);
    for (const field of mutableFields) delete invariant[field];
    return sha256(invariant);
}

function emptyProjectResources() {
    return {
        characterIds: [],
        lorebookIds: [],
        promptProfileIds: [],
        activeCharacterIds: [],
        activeLorebookIds: [],
        activePromptProfileId: null,
        activePersonaId: null,
    };
}

function normalizeIdArray(value, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_RESOURCE_REFERENCES) {
        throw new StoryStudioError(`${label} must be an array with at most ${MAX_RESOURCE_REFERENCES} ids.`, 400, 'invalid_resources');
    }
    const ids = value.map((item, index) => assertId(item, `${label}[${index}]`));
    if (new Set(ids).size !== ids.length) {
        throw new StoryStudioError(`${label} contains duplicate ids.`, 400, 'duplicate_resource_id');
    }
    return ids;
}

function normalizeProjectResources(value = {}) {
    assertPlainObject(value, 'resources');
    assertKnownKeys(value, RESOURCE_REFERENCE_FIELDS, 'resources');
    const resources = {
        characterIds: normalizeIdArray(value.characterIds, 'resources.characterIds'),
        lorebookIds: normalizeIdArray(value.lorebookIds, 'resources.lorebookIds'),
        promptProfileIds: normalizeIdArray(value.promptProfileIds, 'resources.promptProfileIds'),
        activeCharacterIds: normalizeIdArray(value.activeCharacterIds, 'resources.activeCharacterIds'),
        activeLorebookIds: normalizeIdArray(value.activeLorebookIds, 'resources.activeLorebookIds'),
        activePromptProfileId: value.activePromptProfileId === null || value.activePromptProfileId === undefined
            ? null
            : assertId(value.activePromptProfileId, 'resources.activePromptProfileId'),
        activePersonaId: value.activePersonaId === null || value.activePersonaId === undefined
            ? null
            : assertId(value.activePersonaId, 'resources.activePersonaId'),
    };
    if (resources.activeCharacterIds.some(id => !resources.characterIds.includes(id))
        || resources.activeLorebookIds.some(id => !resources.lorebookIds.includes(id))
        || (resources.activePromptProfileId !== null && !resources.promptProfileIds.includes(resources.activePromptProfileId))
        || (resources.activePersonaId !== null && !resources.characterIds.includes(resources.activePersonaId))) {
        throw new StoryStudioError('Active resources must refer to resources in the project.', 400, 'invalid_active_resource');
    }
    return resources;
}

function primaryResourceReferences(value = {}) {
    const resources = normalizeProjectResources(value);
    return Object.fromEntries(RESOURCE_TYPES.map(type => {
        const field = RESOURCE_REFERENCE_BY_TYPE[type];
        return [field, [...resources[field]]];
    }));
}

function normalizePrimaryResourceReferences(value) {
    assertPlainObject(value, 'base resource references');
    const fields = RESOURCE_TYPES.map(type => RESOURCE_REFERENCE_BY_TYPE[type]);
    assertKnownKeys(value, fields, 'base resource references');
    if (fields.some(field => !Object.hasOwn(value, field))) {
        throw new StoryStudioError('Resource journal is missing base resource references.', 500, 'invalid_storage');
    }
    return Object.fromEntries(fields.map(field => [
        field,
        normalizeIdArray(value[field], `base resource references.${field}`),
    ]));
}

function resourceOperationKey(type, resourceId) {
    return `${type}\u0000${resourceId}`;
}

function normalizeResourceExports(value = {}) {
    assertPlainObject(value, 'import resources');
    assertKnownKeys(value, RESOURCE_EXPORT_FIELDS, 'import resources');
    const result = {};
    for (const field of RESOURCE_EXPORT_FIELDS) {
        const items = value[field] ?? [];
        if (!Array.isArray(items) || items.length > MAX_RESOURCE_REFERENCES) {
            throw new StoryStudioError(`import resources.${field} is invalid.`, 400, 'invalid_import');
        }
        result[field] = items;
    }
    return result;
}

function resourceIsActive(project, type, resourceId) {
    const activeField = RESOURCE_ACTIVE_REFERENCE_BY_TYPE[type];
    return type === 'prompt-profile'
        ? project.resources[activeField] === resourceId
        : project.resources[activeField].includes(resourceId);
}

function withActiveResourceState(project, summary) {
    const result = { ...summary, active: resourceIsActive(project, summary.type, summary.id) };
    if (summary.type === 'character') result.persona = project.resources.activePersonaId === summary.id;
    return result;
}

function createChapter(projectId, number, input = {}, volume = {}) {
    assertPlainObject(input, 'chapter');
    const timestamp = nowIso();
    const content = cleanText(input.content, 'content', 5_000_000);
    const volumeId = assertId(volume.volumeId, 'volumeId');
    const planBasis = normalizePlanBasis(volume.planBasis ?? { volumeRevision: volume.volumeRevision });
    return {
        schemaVersion: STORY_STUDIO_SCHEMA_VERSION,
        id: randomUUID(),
        projectId,
        number,
        title: cleanText(input.title, 'title', 160, `第${number}章`),
        status: CHAPTER_STATUSES.has(input.status) ? input.status : 'planned',
        card: normalizeCard(input.card),
        content,
        candidate: normalizeCandidate(input.candidate),
        review: cleanText(input.review, 'review', 1_000_000),
        notes: cleanText(input.notes, 'notes', 1_000_000),
        volumeId,
        planBasis,
        wordCount: countContentUnits(content),
        revision: 1,
        generationHistory: normalizeGenerationHistory(input.generationHistory),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function chapterSummary(chapter) {
    const summary = {
        id: chapter.id,
        number: chapter.number,
        title: chapter.title,
        status: chapter.status,
        summary: chapter.card.summary,
        wordCount: chapter.wordCount,
        updatedAt: chapter.updatedAt,
    };
    if (chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
        summary.volumeId = chapter.volumeId;
        summary.planBasis = normalizePlanBasis(chapter.planBasis);
    }
    return summary;
}

function projectSummary(project) {
    return {
        id: project.id,
        title: project.title,
        genre: project.genre,
        version: project.version,
        chapterCount: project.chapters.length,
        totalWords: project.chapters.reduce((sum, chapter) => sum + Number(chapter.wordCount || 0), 0),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
    };
}

function readJson(filePath, missingMessage) {
    if (!fs.existsSync(filePath)) {
        throw new StoryStudioError(missingMessage, 404, 'not_found');
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new StoryStudioError(`Could not read ${path.basename(filePath)}.`, 500, 'invalid_storage', { cause: error.message });
    }
}

async function readJsonAsync(filePath, missingMessage) {
    try {
        return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new StoryStudioError(missingMessage, 404, 'not_found');
        }
        throw new StoryStudioError(`Could not read ${path.basename(filePath)}.`, 500, 'invalid_storage', { cause: error.message });
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function lstatIfPresent(filePath) {
    try {
        return fs.lstatSync(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function isPathContained(rootDirectory, candidatePath) {
    const relative = path.relative(rootDirectory, candidatePath);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(leftPath, rightPath) {
    return isPathContained(leftPath, rightPath) || isPathContained(rightPath, leftPath);
}

async function writeJsonAsync(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8' });
}

export class StoryStudioStore {
    /**
     * @param {string} rootDirectory Per-user Story Studio directory
     * @param {{ migrationBackupsDirectory?: string }} [options] Store paths outside the project tree
     */
    constructor(rootDirectory, options = {}) {
        this.rootDirectory = path.resolve(rootDirectory);
        this.projectsDirectory = path.join(this.rootDirectory, 'projects');
        this.migrationBackupsDirectory = path.resolve(
            options.migrationBackupsDirectory ?? path.join(this.rootDirectory, 'migration-backups'),
        );
        if (pathsOverlap(this.projectsDirectory, this.migrationBackupsDirectory)) {
            throw new StoryStudioError('Migration backups must be outside the projects tree.', 500, 'invalid_storage');
        }
        this.maxProjectChapters = MAX_IMPORT_CHAPTERS;
        this.maxProjectBytes = MAX_IMPORT_BYTES;
        this.lockStaleMs = LOCK_STALE_MS;
        this.lockHeartbeatMs = LOCK_HEARTBEAT_MS;
        this.stagingStaleMs = STAGING_STALE_MS;
        this.stagingHardStaleMs = STAGING_HARD_STALE_MS;
        fs.mkdirSync(this.projectsDirectory, { recursive: true });
        if (!CLEANED_STAGING_ROOTS.has(this.projectsDirectory)) {
            CLEANED_STAGING_ROOTS.add(this.projectsDirectory);
            this.cleanupStaleStagingDirectories();
        }
    }

    cleanupStaleStagingDirectories(referenceTime = Date.now()) {
        for (const entry of fs.readdirSync(this.projectsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() || !STAGING_DIRECTORY.test(entry.name)) continue;
            const stagingPath = path.join(this.projectsDirectory, entry.name);
            try {
                const stat = fs.lstatSync(stagingPath);
                const age = referenceTime - stat.mtimeMs;
                if (!stat.isDirectory() || stat.isSymbolicLink() || age <= this.stagingStaleMs) {
                    continue;
                }
                const ownerPath = path.join(stagingPath, STAGING_OWNER_FILE);
                if (fs.existsSync(ownerPath) && isOwnerProcessAlive(readOwnerRecord(ownerPath))
                    && age <= this.stagingHardStaleMs) {
                    continue;
                }
                fs.rmSync(stagingPath, { recursive: true, force: true });
            } catch (error) {
                console.warn(`Could not clean stale Story Studio staging directory ${entry.name}:`, error.message);
            }
        }
    }

    projectDirectory(projectId) {
        return path.join(this.projectsDirectory, assertId(projectId, 'project id'));
    }

    projectPath(projectId) {
        return path.join(this.projectDirectory(projectId), 'project.json');
    }

    chapterPath(projectId, chapterId) {
        return path.join(this.projectDirectory(projectId), 'chapters', `${assertId(chapterId, 'chapter id')}.json`);
    }

    resourcesDirectory(projectId) {
        return path.join(this.projectDirectory(projectId), 'resources');
    }

    resourceDirectory(projectId, typeValue) {
        const type = normalizeResourceType(typeValue);
        return path.join(this.resourcesDirectory(projectId), RESOURCE_DIRECTORY_BY_TYPE[type]);
    }

    resourcePath(projectId, typeValue, resourceId) {
        return path.join(this.resourceDirectory(projectId, typeValue), `${assertId(resourceId, 'resource id')}.json`);
    }

    resourceJournalPath(projectId) {
        return path.join(this.projectDirectory(projectId), RESOURCE_JOURNAL_FILE);
    }

    chapterOperationsJournalPath(projectId) {
        return path.join(this.projectDirectory(projectId), CHAPTER_OPERATIONS_JOURNAL_FILE);
    }

    schemaMigrationJournalPath(projectId) {
        return path.join(this.projectDirectory(projectId), SCHEMA_MIGRATION_JOURNAL_FILE);
    }

    migrationBackupDirectory(projectId, transactionId) {
        return path.join(
            this.migrationBackupsDirectory,
            assertId(projectId, 'project id'),
            assertId(transactionId, 'transaction id'),
        );
    }

    migrationBackupManifestPath(projectId, transactionId) {
        return path.join(this.migrationBackupDirectory(projectId, transactionId), 'manifest.json');
    }

    migrationBackupSnapshotDirectory(projectId, transactionId) {
        return path.join(this.migrationBackupDirectory(projectId, transactionId), 'snapshot');
    }

    assertMigrationBackupDirectory(directory, label, containmentRoot = null) {
        const stat = lstatIfPresent(directory);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
            throw new StoryStudioError(`${label} must be a real directory.`, 500, 'invalid_storage', {
                path: directory,
            });
        }
        const realDirectory = fs.realpathSync.native(directory);
        if (containmentRoot !== null && !isPathContained(containmentRoot, realDirectory)) {
            throw new StoryStudioError(`${label} escapes the migration backup root.`, 500, 'invalid_storage', {
                path: directory,
            });
        }
        return realDirectory;
    }

    ensureMigrationBackupRootUnlocked() {
        if (lstatIfPresent(this.migrationBackupsDirectory) === null) {
            fs.mkdirSync(this.migrationBackupsDirectory, { recursive: true });
        }
        const backupRoot = this.assertMigrationBackupDirectory(
            this.migrationBackupsDirectory,
            'Migration backup root',
        );
        const projectsRoot = fs.realpathSync.native(this.projectsDirectory);
        if (pathsOverlap(projectsRoot, backupRoot)) {
            throw new StoryStudioError('Migration backups overlap the projects tree.', 500, 'invalid_storage');
        }
        return backupRoot;
    }

    ensureMigrationBackupProjectDirectoryUnlocked(projectId, backupRoot) {
        const projectBackupDirectory = path.join(
            this.migrationBackupsDirectory,
            assertId(projectId, 'project id'),
        );
        if (lstatIfPresent(projectBackupDirectory) === null) fs.mkdirSync(projectBackupDirectory);
        const realProjectBackupDirectory = this.assertMigrationBackupDirectory(
            projectBackupDirectory,
            'Migration backup project directory',
            backupRoot,
        );
        if (path.dirname(realProjectBackupDirectory) !== backupRoot) {
            throw new StoryStudioError('Migration backup project directory is not a direct child of the backup root.', 500, 'invalid_storage');
        }
        return { projectBackupDirectory, realProjectBackupDirectory };
    }

    validateMigrationBackupDirectoriesUnlocked(projectId, transactionId) {
        const backupRoot = this.assertMigrationBackupDirectory(
            this.migrationBackupsDirectory,
            'Migration backup root',
        );
        const projectBackupDirectory = path.join(
            this.migrationBackupsDirectory,
            assertId(projectId, 'project id'),
        );
        const realProjectBackupDirectory = this.assertMigrationBackupDirectory(
            projectBackupDirectory,
            'Migration backup project directory',
            backupRoot,
        );
        if (path.dirname(realProjectBackupDirectory) !== backupRoot) {
            throw new StoryStudioError('Migration backup project directory is not a direct child of the backup root.', 500, 'invalid_storage');
        }
        const backupDirectory = this.migrationBackupDirectory(projectId, transactionId);
        const realBackupDirectory = this.assertMigrationBackupDirectory(
            backupDirectory,
            'Migration backup directory',
            realProjectBackupDirectory,
        );
        if (path.dirname(realBackupDirectory) !== realProjectBackupDirectory) {
            throw new StoryStudioError('Migration backup directory is not a direct child of its project directory.', 500, 'invalid_storage');
        }
        const snapshotDirectory = this.migrationBackupSnapshotDirectory(projectId, transactionId);
        const realSnapshotDirectory = this.assertMigrationBackupDirectory(
            snapshotDirectory,
            'Migration backup snapshot directory',
            realBackupDirectory,
        );
        if (path.dirname(realSnapshotDirectory) !== realBackupDirectory) {
            throw new StoryStudioError('Migration backup snapshot is not a direct child of its transaction directory.', 500, 'invalid_storage');
        }
        return { backupRoot, backupDirectory, snapshotDirectory };
    }

    migrationBackupFiles(directory) {
        const files = [];
        const visit = (currentDirectory, prefix = '') => {
            const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
                .sort((left, right) => left.name.localeCompare(right.name));
            for (const entry of entries) {
                const sourcePath = path.join(currentDirectory, entry.name);
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                const stat = fs.lstatSync(sourcePath);
                if (stat.isSymbolicLink()) {
                    throw new StoryStudioError('Migration backup cannot include symbolic links.', 500, 'invalid_storage', {
                        path: relativePath,
                    });
                }
                if (stat.isDirectory()) {
                    visit(sourcePath, relativePath);
                    continue;
                }
                if (!stat.isFile()) {
                    throw new StoryStudioError('Migration backup contains an unsupported filesystem entry.', 500, 'invalid_storage', {
                        path: relativePath,
                    });
                }
                files.push({ relativePath, sourcePath });
            }
        };
        visit(directory);
        return files;
    }

    validateMigrationBackupUnlocked(projectId, transactionId, fromSchemaVersion, expectedManifestDigest = null) {
        try {
            const { backupDirectory, snapshotDirectory } = this.validateMigrationBackupDirectoriesUnlocked(
                projectId,
                transactionId,
            );
            const manifestPath = this.migrationBackupManifestPath(projectId, transactionId);
            const manifest = readJson(manifestPath, 'Migration backup manifest not found.');
            assertPlainObject(manifest, 'migration backup manifest');
            assertKnownKeys(manifest, [
                'format', 'projectId', 'transactionId', 'fromSchemaVersion', 'createdAt', 'files',
            ], 'migration backup manifest');
            if (manifest.format !== 'story-studio-migration-backup-v1'
                || manifest.projectId !== projectId || manifest.transactionId !== transactionId
                || manifest.fromSchemaVersion !== fromSchemaVersion
                || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
                || !Array.isArray(manifest.files) || manifest.files.length === 0) {
                throw new Error('invalid backup manifest envelope');
            }
            const manifestDigest = sha256(manifest);
            if (expectedManifestDigest !== null && manifestDigest !== expectedManifestDigest) {
                throw new Error('backup manifest digest mismatch');
            }
            const expectedPaths = [];
            for (const [index, item] of manifest.files.entries()) {
                assertPlainObject(item, `migration backup files[${index}]`);
                assertKnownKeys(item, ['path', 'bytes', 'sha256'], `migration backup files[${index}]`);
                if (typeof item.path !== 'string' || item.path.length === 0
                    || item.path.includes('\\') || path.posix.isAbsolute(item.path)
                    || path.posix.normalize(item.path) !== item.path || item.path.startsWith('../')
                    || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !SHA256_HEX.test(item.sha256)) {
                    throw new Error('invalid backup file record');
                }
                if (expectedPaths.includes(item.path)) throw new Error('duplicate backup path');
                expectedPaths.push(item.path);
                const bytes = fs.readFileSync(path.join(snapshotDirectory, ...item.path.split('/')));
                if (bytes.length !== item.bytes || sha256Bytes(bytes) !== item.sha256) {
                    throw new Error('backup file digest mismatch');
                }
            }
            const actualPaths = this.migrationBackupFiles(snapshotDirectory)
                .map(item => item.relativePath)
                .sort((left, right) => left.localeCompare(right));
            const sortedExpectedPaths = [...expectedPaths].sort((left, right) => left.localeCompare(right));
            if (stableJson(actualPaths) !== stableJson(sortedExpectedPaths)) {
                throw new Error('backup file set mismatch');
            }
            return { manifest, manifestDigest };
        } catch (error) {
            if (error instanceof StoryStudioError && error.code === 'invalid_storage') throw error;
            throw new StoryStudioError('Schema migration backup is invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    createMigrationBackupUnlocked(projectId, transactionId, fromSchemaVersion, createdAt, lock) {
        const projectDirectory = this.projectDirectory(projectId);
        let backupRoot = null;
        let realProjectBackupDirectory = null;
        let stagingDirectory = null;
        try {
            backupRoot = this.ensureMigrationBackupRootUnlocked();
            const projectBackup = this.ensureMigrationBackupProjectDirectoryUnlocked(projectId, backupRoot);
            realProjectBackupDirectory = projectBackup.realProjectBackupDirectory;
            const finalDirectory = this.migrationBackupDirectory(projectId, transactionId);
            if (lstatIfPresent(finalDirectory) !== null) {
                throw new StoryStudioError('Migration backup already exists.', 500, 'invalid_storage', { transactionId });
            }
            stagingDirectory = `${finalDirectory}.staging-${randomUUID()}`;
            if (lstatIfPresent(stagingDirectory) !== null) throw new Error('backup staging directory already exists');
            fs.mkdirSync(stagingDirectory);
            const realStagingDirectory = this.assertMigrationBackupDirectory(
                stagingDirectory,
                'Migration backup staging directory',
                realProjectBackupDirectory,
            );
            if (path.dirname(realStagingDirectory) !== realProjectBackupDirectory) {
                throw new Error('backup staging directory is not a direct child of its project directory');
            }
            const snapshotDirectory = path.join(stagingDirectory, 'snapshot');
            fs.mkdirSync(snapshotDirectory);
            const realSnapshotDirectory = this.assertMigrationBackupDirectory(
                snapshotDirectory,
                'Migration backup snapshot directory',
                realStagingDirectory,
            );
            if (path.dirname(realSnapshotDirectory) !== realStagingDirectory) {
                throw new Error('backup snapshot directory is not a direct child of staging');
            }
            const files = this.migrationBackupFiles(projectDirectory);
            if (files.length === 0) throw new Error('project directory is empty');
            const manifestFiles = [];
            for (const item of files) {
                this.assertProjectLockOwnership(lock);
                const bytes = fs.readFileSync(item.sourcePath);
                const destinationPath = path.join(snapshotDirectory, ...item.relativePath.split('/'));
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                fs.writeFileSync(destinationPath, bytes, { flag: 'wx' });
                const copied = fs.readFileSync(destinationPath);
                const digest = sha256Bytes(bytes);
                if (copied.length !== bytes.length || sha256Bytes(copied) !== digest) {
                    throw new Error(`backup verification failed for ${item.relativePath}`);
                }
                manifestFiles.push({ path: item.relativePath, bytes: bytes.length, sha256: digest });
            }
            const manifest = {
                format: 'story-studio-migration-backup-v1',
                projectId,
                transactionId,
                fromSchemaVersion,
                createdAt,
                files: manifestFiles,
            };
            writeJson(path.join(stagingDirectory, 'manifest.json'), manifest);
            this.assertProjectLockOwnership(lock);
            this.assertMigrationBackupDirectory(
                path.dirname(finalDirectory),
                'Migration backup project directory',
                backupRoot,
            );
            fs.renameSync(stagingDirectory, finalDirectory);
            stagingDirectory = null;
            return this.validateMigrationBackupUnlocked(projectId, transactionId, fromSchemaVersion);
        } catch (error) {
            if (stagingDirectory !== null && lstatIfPresent(stagingDirectory) !== null) {
                try {
                    const realStagingDirectory = this.assertMigrationBackupDirectory(
                        stagingDirectory,
                        'Migration backup staging directory',
                        realProjectBackupDirectory ?? backupRoot,
                    );
                    if (backupRoot !== null && isPathContained(backupRoot, realStagingDirectory)) {
                        fs.rmSync(stagingDirectory, { recursive: true, force: true });
                    }
                } catch {
                    // Preserve suspicious staging evidence instead of following an unexpected filesystem link.
                }
            }
            if (error instanceof StoryStudioError) throw error;
            throw new StoryStudioError('Could not create a verified schema migration backup.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    assertProjectChapterCount(chapterCount) {
        if (chapterCount > this.maxProjectChapters) {
            throw new StoryStudioError('Project has too many chapters.', 413, 'chapter_limit_exceeded', {
                maximum: this.maxProjectChapters,
                actual: chapterCount,
            });
        }
    }

    assertProjectChapterBytes(chapterBytes) {
        if (!Number.isSafeInteger(chapterBytes) || chapterBytes < 0) {
            throw new StoryStudioError('Project chapter byte metadata is invalid.', 500, 'invalid_storage');
        }
        if (chapterBytes > this.maxProjectBytes) {
            throw new StoryStudioError('Project chapters exceed the storage limit.', 413, 'project_chapter_bytes_exceeded', {
                maximum: this.maxProjectBytes,
                actual: chapterBytes,
            });
        }
    }

    estimatedExportBytes(project, resourceBytes = 0, resourceCount = 0) {
        const emptyExport = {
            format: 'sillytavern-story-studio',
            schemaVersion: STORY_STUDIO_SCHEMA_VERSION,
            exportedAt: '2000-01-01T00:00:00.000Z',
            project,
            chapters: [],
            resources: { characters: [], lorebooks: [], promptProfiles: [] },
        };
        // Replacing empty arrays adds serialized values plus array separators.
        return serializedByteLength(emptyExport)
            + project.chapterBytes
            + Math.max(0, project.chapters.length - 1)
            + resourceBytes
            + Math.max(0, resourceCount - 1);
    }

    assertProjectResourceLimits(project, resourceBytes = 0, resourceCount = 0) {
        this.assertProjectChapterCount(project.chapters.length);
        this.assertProjectChapterBytes(project.chapterBytes);
        const exportBytes = this.estimatedExportBytes(project, resourceBytes, resourceCount);
        if (exportBytes > this.maxProjectBytes) {
            throw new StoryStudioError('Project export exceeds the storage limit.', 413, 'project_export_bytes_exceeded', {
                maximum: this.maxProjectBytes,
                actual: exportBytes,
            });
        }
    }

    calculateProjectResourceBytesUnlocked(projectId, resources) {
        const normalized = normalizeProjectResources(resources);
        const records = new Map();
        let bytes = 0;
        let count = 0;
        for (const type of RESOURCE_TYPES) {
            const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
            for (const resourceId of normalized[referenceField]) {
                const resource = this.readResourceUnlocked(projectId, type, resourceId);
                records.set(resourceOperationKey(type, resourceId), resource);
                bytes += serializedByteLength(resource);
                count += 1;
                if (bytes > this.maxProjectBytes) {
                    throw new StoryStudioError('Project resources exceed the storage limit.', 413, 'project_resource_bytes_exceeded', {
                        maximum: this.maxProjectBytes,
                        actual: bytes,
                    });
                }
            }
        }
        const lorebookIds = new Set(normalized.lorebookIds);
        for (const characterId of normalized.characterIds) {
            const character = records.get(resourceOperationKey('character', characterId));
            if (character.embeddedLorebookId !== null && !lorebookIds.has(character.embeddedLorebookId)) {
                throw new StoryStudioError('Character references a lorebook outside the project.', 500, 'invalid_storage', {
                    characterId,
                    lorebookId: character.embeddedLorebookId,
                });
            }
        }
        return { bytes, count };
    }

    validateMigrationSourceResourcesUnlocked(projectId, project) {
        if (project.schemaVersion < RESOURCE_STORY_STUDIO_SCHEMA_VERSION) return { bytes: 0, count: 0 };
        try {
            return this.calculateProjectResourceBytesUnlocked(projectId, project.resources);
        } catch (error) {
            throw new StoryStudioError('Migration source resources are incomplete or invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    assertStoredProjectLimitsUnlocked(projectId, project) {
        const resourceSize = this.calculateProjectResourceBytesUnlocked(projectId, project.resources);
        this.assertProjectResourceLimits(project, resourceSize.bytes, resourceSize.count);
        return resourceSize;
    }

    calculateProjectChapterBytesUnlocked(projectId, chapterSummaries) {
        let chapterBytes = 0;
        for (const summary of chapterSummaries) {
            const chapter = this.readChapterUnlocked(projectId, summary.id);
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            chapterBytes += serializedByteLength(chapter);
            this.assertProjectChapterBytes(chapterBytes);
        }
        return chapterBytes;
    }

    listProjects() {
        const projects = [];
        for (const entry of fs.readdirSync(this.projectsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() || !VALID_ID.test(entry.name)) {
                continue;
            }
            try {
                const project = readJson(this.projectPath(entry.name), 'Project not found.');
                this.validateStoredProject(project, entry.name);
                this.assertProjectChapterCount(project.chapters.length);
                projects.push(projectSummary(project));
            } catch (error) {
                console.warn(`Skipping unreadable Story Studio project ${entry.name}:`, error.message);
            }
        }
        return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    createProject(input = {}) {
        assertPlainObject(input, 'project');
        if (Object.keys(input).length > 0) {
            assertAllowedKeys(input, ['title', 'genre', 'targetWords', 'chapterTargetWords', 'story', 'continuity', 'storyState'], 'project');
        }
        const timestamp = nowIso();
        const id = randomUUID();
        const volume = createVolume(1, {}, timestamp);
        const chapter = createChapter(id, 1, {}, { volumeId: volume.id, volumeRevision: volume.revision });
        assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
        assertProtectedStoryStateInputEmpty(input.storyState);
        const storyState = normalizeStoryState(input.storyState ?? {}, [chapter.id]);
        assertProtectedStoryStateEmpty(storyState);
        const project = {
            schemaVersion: STORY_STUDIO_SCHEMA_VERSION,
            id,
            title: cleanText(input.title, 'title', 160, '未命名作品'),
            genre: cleanText(input.genre, 'genre', 80),
            targetWords: cleanInteger(input.targetWords, 'targetWords', 1_000, 100_000_000, 2_000_000),
            chapterTargetWords: cleanInteger(input.chapterTargetWords, 'chapterTargetWords', 100, 100_000, 3_000),
            story: normalizeStory(input.story),
            continuity: normalizeContinuity(input.continuity),
            storyState,
            volumes: [volume],
            chapters: [chapterSummary(chapter)],
            chapterBytes: serializedByteLength(chapter),
            resources: emptyProjectResources(),
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.assertProjectResourceLimits(project);
        assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
        this.writeNewProjectSync(project, [chapter]);
        return { project, chapter };
    }

    getProject(projectId) {
        return this.withProjectLock(projectId, () => this.readProjectUnlocked(projectId));
    }

    updateProject(projectId, expectedVersion, changes = {}) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedVersion);
            assertPlainObject(changes, 'project changes');
            assertAllowedKeys(changes, ['title', 'genre', 'targetWords', 'chapterTargetWords', 'story', 'continuity', 'storyState'], 'project changes');
            if ('title' in changes) project.title = cleanText(changes.title, 'title', 160);
            if ('genre' in changes) project.genre = cleanText(changes.genre, 'genre', 80);
            if ('targetWords' in changes) project.targetWords = cleanInteger(changes.targetWords, 'targetWords', 1_000, 100_000_000, project.targetWords);
            if ('chapterTargetWords' in changes) project.chapterTargetWords = cleanInteger(changes.chapterTargetWords, 'chapterTargetWords', 100, 100_000, project.chapterTargetWords);
            if ('story' in changes) {
                assertPlainObject(changes.story, 'story changes');
                assertAllowedKeys(changes.story, STORY_FIELDS, 'story changes');
                project.story = normalizeStory({ ...project.story, ...changes.story });
            }
            if ('continuity' in changes) project.continuity = normalizeContinuity(changes.continuity);
            if ('storyState' in changes) {
                const nextStoryState = normalizeStoryState(changes.storyState, project.chapters.map(chapter => chapter.id));
                assertProtectedStoryStateUnchanged(project.storyState, nextStoryState);
                assertFactSupersessionPreserved(project.storyState, nextStoryState);
                project.storyState = nextStoryState;
            }
            project.version += 1;
            project.updatedAt = nowIso();
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), project);
            return project;
        });
    }

    createVolume(projectId, expectedVersion, input = {}) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedVersion);
            if (project.volumes.length >= MAX_PROJECT_VOLUMES) {
                throw new StoryStudioError('Project has reached the volume limit.', 413, 'volume_limit_exceeded', {
                    maximum: MAX_PROJECT_VOLUMES,
                });
            }
            const volume = createVolume(project.volumes.length + 1, input);
            project.volumes.push(volume);
            project.version += 1;
            project.updatedAt = volume.updatedAt;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), project);
            return { project, volume };
        });
    }

    updateVolume(projectId, volumeIdValue, expectedProjectVersion, expectedRevision, changes = {}) {
        const volumeId = assertId(volumeIdValue, 'volume id');
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            const index = project.volumes.findIndex(item => item.id === volumeId);
            if (index === -1) throw new StoryStudioError('Volume not found.', 404, 'volume_not_found');
            const current = project.volumes[index];
            if (Number(expectedRevision) !== current.revision) {
                throw new StoryStudioError('Volume changed in another window.', 409, 'volume_conflict', {
                    currentRevision: current.revision,
                    currentProjectVersion: project.version,
                });
            }
            assertPlainObject(changes, 'volume changes');
            assertAllowedKeys(changes, VOLUME_CHANGE_FIELDS, 'volume changes');
            const normalizedChanges = Object.fromEntries(Object.entries(changes).map(([field, value]) => [
                field,
                cleanText(value, `volume.${field}`, field === 'title' ? 160 : field === 'outline' ? 250_000 : 100_000),
            ]));
            if (Object.entries(normalizedChanges).every(([field, value]) => current[field] === value)) {
                return { project, volume: current };
            }
            const timestamp = nowIso();
            const volume = normalizeVolume({
                ...current,
                ...normalizedChanges,
                revision: current.revision + 1,
                updatedAt: timestamp,
            }, index, 'volume');
            project.volumes[index] = volume;
            project.version += 1;
            project.updatedAt = timestamp;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), project);
            return { project, volume };
        });
    }

    deleteVolume(projectId, volumeIdValue, expectedProjectVersion, expectedRevision) {
        const volumeId = assertId(volumeIdValue, 'volume id');
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            const index = project.volumes.findIndex(item => item.id === volumeId);
            if (index === -1) throw new StoryStudioError('Volume not found.', 404, 'volume_not_found');
            const volume = project.volumes[index];
            if (Number(expectedRevision) !== volume.revision) {
                throw new StoryStudioError('Volume changed in another window.', 409, 'volume_conflict', {
                    currentRevision: volume.revision,
                    currentProjectVersion: project.version,
                });
            }
            if (project.volumes.length === 1) {
                throw new StoryStudioError('作品必须保留至少一卷。', 409, 'last_volume_required');
            }
            if (project.chapters.some(chapter => chapter.volumeId === volumeId)) {
                throw new StoryStudioError('Only empty volumes can be deleted.', 409, 'volume_not_empty', { volumeId });
            }
            const timestamp = nowIso();
            project.volumes = project.volumes
                .filter(item => item.id !== volumeId)
                .map((item, nextIndex) => item.number === nextIndex + 1 ? item : {
                    ...item,
                    number: nextIndex + 1,
                    updatedAt: timestamp,
                });
            project.version += 1;
            project.updatedAt = timestamp;
            assertVolumeChapterLayout(project.volumes, project.chapters);
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), project);
            return { project, deleted: { id: volume.id, number: volume.number } };
        });
    }

    createChapter(projectId, expectedVersion, input = {}) {
        assertPlainObject(input, 'chapter');
        if (Object.keys(input).length > 0) {
            assertAllowedKeys(input, ['title', 'status', 'card', 'content', 'candidate', 'review', 'notes', 'volumeId'], 'chapter');
        }
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedVersion);
            const baseProject = structuredClone(project);
            if (project.chapters.length >= this.maxProjectChapters) {
                throw new StoryStudioError('Project has reached the chapter limit.', 413, 'chapter_limit_exceeded', {
                    maximum: this.maxProjectChapters,
                    actual: project.chapters.length,
                });
            }
            const selectedVolume = input.volumeId === undefined || input.volumeId === null || input.volumeId === ''
                ? project.volumes.at(-1)
                : project.volumes.find(volume => volume.id === assertId(input.volumeId, 'volumeId'));
            if (!selectedVolume) {
                throw new StoryStudioError('Volume not found.', 404, 'volume_not_found');
            }
            const volumeNumberById = new Map(project.volumes.map(volume => [volume.id, volume.number]));
            const insertionIndex = project.chapters.findIndex(summary => (
                volumeNumberById.get(summary.volumeId) > selectedVolume.number
            ));
            const targetIndex = insertionIndex === -1 ? project.chapters.length : insertionIndex;
            const number = targetIndex + 1;
            const chapterInput = { ...input };
            delete chapterInput.volumeId;
            const chapter = createChapter(project.id, number, chapterInput, {
                volumeId: selectedVolume.id,
                volumeRevision: selectedVolume.revision,
            });
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            const timestamp = chapter.createdAt;
            const chapters = project.chapters.map(summary => this.readChapterUnlocked(projectId, summary.id));
            chapters.splice(targetIndex, 0, chapter);
            for (const [index, item] of chapters.entries()) {
                const nextNumber = index + 1;
                if (item.id !== chapter.id && item.number !== nextNumber) {
                    item.number = nextNumber;
                    item.revision += 1;
                    item.updatedAt = timestamp;
                }
                assertPayloadSize(item, MAX_CHAPTER_BYTES, 'Chapter');
            }
            project.continuity = remapContinuityChapterNumbers(project.continuity, baseProject.chapters, chapters);
            project.chapters = chapters.map(chapterSummary);
            project.chapterBytes = chapters.reduce((sum, item) => sum + serializedByteLength(item), 0);
            project.version += 1;
            project.updatedAt = timestamp;
            assertVolumeChapterLayout(project.volumes, project.chapters);
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndChapterOperations(
                project,
                chapters.map(item => ({ operation: 'write', chapterId: item.id, chapter: item })),
                lock,
                baseProject,
            );
            return { project, chapter };
        });
    }

    getChapter(projectId, chapterId) {
        return this.withProjectLock(projectId, () => this.readChapterUnlocked(projectId, chapterId));
    }

    getProjectAndChapter(projectId, chapterId) {
        return this.withProjectLock(projectId, () => ({
            project: this.readProjectUnlocked(projectId),
            chapter: this.readChapterUnlocked(projectId, chapterId),
        }));
    }

    deleteChapter(
        projectId,
        chapterIdValue,
        expectedProjectVersion,
        expectedChapterRevision,
        preferredActiveChapterIdValue = null,
    ) {
        const chapterId = assertId(chapterIdValue, 'chapter id');
        const preferredActiveChapterId = preferredActiveChapterIdValue === null
            || preferredActiveChapterIdValue === undefined || preferredActiveChapterIdValue === ''
            ? null
            : assertId(preferredActiveChapterIdValue, 'active chapter id');
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            const chapterIndex = project.chapters.findIndex(item => item.id === chapterId);
            if (chapterIndex === -1) {
                throw new StoryStudioError('Chapter not found.', 404, 'not_found');
            }
            const deletedChapter = this.readChapterUnlocked(projectId, chapterId);
            if (Number(expectedChapterRevision) !== deletedChapter.revision) {
                throw new StoryStudioError('Chapter changed in another window.', 409, 'chapter_conflict', {
                    currentRevision: deletedChapter.revision,
                    currentProjectVersion: project.version,
                });
            }
            if (project.chapters.length === 1) {
                throw new StoryStudioError('作品必须保留至少一章。', 409, 'last_chapter_required', {
                    currentProjectVersion: project.version,
                    chapterId,
                });
            }
            const baseProject = structuredClone(project);

            const timestamp = nowIso();
            const previousSummaries = project.chapters.map(summary => ({ ...summary }));
            const remainingSummaries = project.chapters.filter(item => item.id !== chapterId);
            const chapters = remainingSummaries.map((summary, index) => {
                const chapter = this.readChapterUnlocked(projectId, summary.id);
                const nextNumber = index + 1;
                if (chapter.number !== nextNumber) {
                    chapter.number = nextNumber;
                    chapter.revision += 1;
                    chapter.updatedAt = timestamp;
                }
                return chapter;
            });
            const remainingChapterIds = chapters.map(chapter => chapter.id);
            project.storyState = detachChapterStoryStateReferences(project.storyState, chapterId, remainingChapterIds);
            project.continuity = remapContinuityChapterNumbers(project.continuity, previousSummaries, chapters);
            project.chapters = chapters.map(chapterSummary);
            project.chapterBytes = chapters.reduce((sum, chapter) => sum + serializedByteLength(chapter), 0);
            project.version += 1;
            project.updatedAt = timestamp;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');

            const operations = [
                ...chapters.map(chapter => ({ operation: 'write', chapterId: chapter.id, chapter })),
                { operation: 'delete', chapterId, chapter: null },
            ];
            this.commitProjectAndChapterOperations(project, operations, lock, baseProject);
            const activeChapter = chapters.find(chapter => chapter.id === preferredActiveChapterId)
                || chapters[Math.min(chapterIndex, chapters.length - 1)];
            return {
                project,
                deleted: { id: chapterId, number: deletedChapter.number },
                activeChapterId: activeChapter.id,
                activeChapter,
            };
        });
    }

    reorderChapters(projectId, expectedProjectVersion, chapterIdsValue) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            if (!Array.isArray(chapterIdsValue) || chapterIdsValue.length > this.maxProjectChapters) {
                throw new StoryStudioError('chapterIds must be an array containing every project chapter.', 400, 'invalid_chapter_order');
            }
            const chapterIds = chapterIdsValue.map((chapterId, index) => assertId(chapterId, `chapterIds[${index}]`));
            if (new Set(chapterIds).size !== chapterIds.length) {
                throw new StoryStudioError('chapterIds contains duplicate ids.', 400, 'duplicate_chapter_id');
            }
            const currentIds = project.chapters.map(chapter => chapter.id);
            const currentIdSet = new Set(currentIds);
            const requestedIdSet = new Set(chapterIds);
            const missingIds = currentIds.filter(chapterId => !requestedIdSet.has(chapterId));
            const unknownIds = chapterIds.filter(chapterId => !currentIdSet.has(chapterId));
            if (chapterIds.length !== currentIds.length || missingIds.length > 0 || unknownIds.length > 0) {
                throw new StoryStudioError('chapterIds must contain every project chapter exactly once.', 400, 'invalid_chapter_order', {
                    expectedCount: currentIds.length,
                    actualCount: chapterIds.length,
                    missingIds,
                    unknownIds,
                });
            }
            const summaryById = new Map(project.chapters.map(summary => [summary.id, summary]));
            const requestedSummaries = chapterIds.map((chapterId, index) => ({
                ...summaryById.get(chapterId),
                number: index + 1,
            }));
            try {
                assertVolumeChapterLayout(project.volumes, requestedSummaries, project.schemaVersion);
            } catch (error) {
                if (error instanceof StoryStudioError && error.code === 'interleaved_volume_blocks') {
                    throw new StoryStudioError(
                        'Chapter reorder cannot move chapters across volumes; use the structure endpoint.',
                        400,
                        'invalid_chapter_order',
                        { requiresStructure: true },
                    );
                }
                throw error;
            }
            if (chapterIds.every((chapterId, index) => chapterId === currentIds[index])) {
                return {
                    project,
                    chapters: chapterIds.map(chapterId => this.readChapterUnlocked(projectId, chapterId)),
                };
            }

            const baseProject = structuredClone(project);
            const timestamp = nowIso();
            const previousSummaries = project.chapters.map(summary => ({ ...summary }));
            const chapters = chapterIds.map((chapterId, index) => {
                const chapter = this.readChapterUnlocked(projectId, chapterId);
                const nextNumber = index + 1;
                if (chapter.number !== nextNumber) {
                    chapter.number = nextNumber;
                    chapter.revision += 1;
                    chapter.updatedAt = timestamp;
                }
                return chapter;
            });
            project.continuity = remapContinuityChapterNumbers(project.continuity, previousSummaries, chapters);
            project.chapters = chapters.map(chapterSummary);
            project.chapterBytes = chapters.reduce((sum, chapter) => sum + serializedByteLength(chapter), 0);
            project.version += 1;
            project.updatedAt = timestamp;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndChapterOperations(
                project,
                chapters.map(chapter => ({ operation: 'write', chapterId: chapter.id, chapter })),
                lock,
                baseProject,
            );
            return { project, chapters };
        });
    }

    updateStructure(projectId, expectedProjectVersion, volumesValue) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            if (!Array.isArray(volumesValue) || volumesValue.length !== project.volumes.length) {
                throw new StoryStudioError('Structure must contain every project volume.', 400, 'invalid_structure');
            }
            const requestedVolumeIds = [];
            const requestedChapterIds = [];
            const targetVolumeIdByChapterId = new Map();
            for (const [index, item] of volumesValue.entries()) {
                assertPlainObject(item, `volumes[${index}]`);
                assertKnownKeys(item, ['id', 'chapterIds'], `volumes[${index}]`);
                const volumeId = assertId(item.id, `volumes[${index}].id`);
                if (!Array.isArray(item.chapterIds) || item.chapterIds.length > this.maxProjectChapters) {
                    throw new StoryStudioError('Structure chapterIds must be arrays.', 400, 'invalid_structure');
                }
                requestedVolumeIds.push(volumeId);
                for (const [chapterIndex, chapterIdValue] of item.chapterIds.entries()) {
                    const chapterId = assertId(chapterIdValue, `volumes[${index}].chapterIds[${chapterIndex}]`);
                    requestedChapterIds.push(chapterId);
                    targetVolumeIdByChapterId.set(chapterId, volumeId);
                }
            }
            const currentVolumeIds = project.volumes.map(volume => volume.id);
            const currentChapterIds = project.chapters.map(chapter => chapter.id);
            const duplicateVolumeIds = requestedVolumeIds.filter((id, index) => requestedVolumeIds.indexOf(id) !== index);
            const duplicateChapterIds = requestedChapterIds.filter((id, index) => requestedChapterIds.indexOf(id) !== index);
            const missingVolumeIds = currentVolumeIds.filter(id => !requestedVolumeIds.includes(id));
            const unknownVolumeIds = requestedVolumeIds.filter(id => !currentVolumeIds.includes(id));
            const missingChapterIds = currentChapterIds.filter(id => !requestedChapterIds.includes(id));
            const unknownChapterIds = requestedChapterIds.filter(id => !currentChapterIds.includes(id));
            if (duplicateVolumeIds.length || duplicateChapterIds.length || missingVolumeIds.length || unknownVolumeIds.length
                || missingChapterIds.length || unknownChapterIds.length
                || requestedChapterIds.length !== currentChapterIds.length) {
                throw new StoryStudioError('Structure must contain every volume and chapter exactly once.', 400, 'invalid_structure', {
                    duplicateVolumeIds: [...new Set(duplicateVolumeIds)],
                    duplicateChapterIds: [...new Set(duplicateChapterIds)],
                    missingVolumeIds,
                    unknownVolumeIds,
                    missingChapterIds,
                    unknownChapterIds,
                });
            }

            const baseProject = structuredClone(project);
            const timestamp = nowIso();
            const volumeById = new Map(project.volumes.map(volume => [volume.id, volume]));
            project.volumes = requestedVolumeIds.map((volumeId, index) => {
                const volume = volumeById.get(volumeId);
                return volume.number === index + 1 ? volume : {
                    ...volume,
                    number: index + 1,
                    updatedAt: timestamp,
                };
            });
            const chapterById = new Map(project.chapters.map(summary => [
                summary.id,
                this.readChapterUnlocked(projectId, summary.id),
            ]));
            const chapters = requestedChapterIds.map((chapterId, index) => {
                const chapter = chapterById.get(chapterId);
                const nextNumber = index + 1;
                const nextVolumeId = targetVolumeIdByChapterId.get(chapterId);
                const volumeChanged = chapter.volumeId !== nextVolumeId;
                if (chapter.number !== nextNumber || volumeChanged) {
                    chapter.number = nextNumber;
                    chapter.volumeId = nextVolumeId;
                    if (volumeChanged) chapter.planBasis = { volumeRevision: 0 };
                    chapter.revision += 1;
                    chapter.updatedAt = timestamp;
                }
                return chapter;
            });
            const unchanged = stableJson(project.volumes) === stableJson(baseProject.volumes)
                && chapters.every((chapter, index) => (
                    chapter.id === baseProject.chapters[index].id
                    && stableJson(chapterSummary(chapter)) === stableJson(baseProject.chapters[index])
                ));
            if (unchanged) return { project: baseProject, chapters };

            project.continuity = remapContinuityChapterNumbers(project.continuity, baseProject.chapters, chapters);
            project.chapters = chapters.map(chapterSummary);
            project.chapterBytes = chapters.reduce((sum, chapter) => sum + serializedByteLength(chapter), 0);
            project.version += 1;
            project.updatedAt = timestamp;
            assertVolumeChapterLayout(project.volumes, project.chapters);
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndChapterOperations(
                project,
                chapters.map(chapter => ({ operation: 'write', chapterId: chapter.id, chapter })),
                lock,
                baseProject,
                'structure',
            );
            return { project, chapters };
        });
    }

    updateChapter(projectId, chapterId, expectedProjectVersion, expectedRevision, changes = {}, options = {}) {
        const beforeCommit = typeof options?.beforeCommit === 'function' ? options.beforeCommit : null;
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            const chapter = this.readChapterUnlocked(projectId, chapterId);
            const previousProjectVersion = project.version;
            const baseProject = structuredClone(project);
            const previousChapter = structuredClone(chapter);
            const previousChapterBytes = serializedByteLength(chapter);
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            this.assertProjectVersion(project, expectedProjectVersion);
            if (Number(expectedRevision) !== chapter.revision) {
                throw new StoryStudioError('Chapter changed in another window.', 409, 'chapter_conflict', {
                    currentRevision: chapter.revision,
                    currentProjectVersion: project.version,
                });
            }
            assertPlainObject(changes, 'chapter changes');
            assertAllowedKeys(changes, ['title', 'status', 'card', 'content', 'candidate', 'review', 'notes'], 'chapter changes');
            if ('title' in changes) chapter.title = cleanText(changes.title, 'title', 160);
            if ('status' in changes) {
                if (!CHAPTER_STATUSES.has(changes.status)) {
                    throw new StoryStudioError('Invalid chapter status.', 400, 'invalid_status');
                }
                chapter.status = changes.status;
            }
            if ('card' in changes) {
                assertPlainObject(changes.card, 'card changes');
                assertAllowedKeys(changes.card, CARD_FIELDS, 'card changes');
                chapter.card = normalizeCard({ ...chapter.card, ...changes.card });
                const volume = project.volumes.find(item => item.id === chapter.volumeId);
                if (!volume) throw new StoryStudioError('Chapter volume is missing.', 500, 'invalid_storage');
                chapter.planBasis = { volumeRevision: volume.revision };
            }
            if ('content' in changes) chapter.content = cleanText(changes.content, 'content', 5_000_000);
            if ('candidate' in changes) {
                assertPlainObject(changes.candidate, 'candidate');
                if (Object.keys(changes.candidate).length > 0) {
                    assertAllowedKeys(changes.candidate, ['kind', 'content', 'createdAt'], 'candidate');
                }
                chapter.candidate = normalizeCandidate(changes.candidate);
            }
            if ('review' in changes) chapter.review = cleanText(changes.review, 'review', 1_000_000);
            if ('notes' in changes) chapter.notes = cleanText(changes.notes, 'notes', 1_000_000);
            chapter.wordCount = countContentUnits(chapter.content);
            chapter.revision += 1;
            chapter.updatedAt = nowIso();
            const chapterIndex = project.chapters.findIndex(item => item.id === chapter.id);
            if (chapterIndex === -1) {
                throw new StoryStudioError('Chapter index is missing.', 500, 'invalid_storage');
            }
            project.chapters[chapterIndex] = chapterSummary(chapter);
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            project.chapterBytes = project.chapterBytes - previousChapterBytes + serializedByteLength(chapter);
            project.version += 1;
            project.updatedAt = chapter.updatedAt;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            beforeCommit?.({ projectVersion: previousProjectVersion, chapter: previousChapter });
            this.commitProjectAndChapter(project, chapter, lock, baseProject, previousChapter);
            return { project, chapter };
        });
    }

    adoptGeneration(projectId, chapterId, expectedProjectVersion, expectedRevision, payload, options = {}) {
        const adoption = normalizeAdoptionPayload(payload);
        const payloadHash = sha256(adoption);
        const beforeCommit = typeof options?.beforeCommit === 'function' ? options.beforeCommit : null;
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            const chapter = this.readChapterUnlocked(projectId, chapterId);
            const previousProjectVersion = project.version;
            const baseProject = structuredClone(project);
            const previousChapter = structuredClone(chapter);
            const previousChapterBytes = serializedByteLength(chapter);
            const generationHistory = normalizeGenerationHistory(chapter.generationHistory);
            const priorAdoption = generationHistory.find(item => item.generationId === adoption.generationId);
            if (priorAdoption) {
                if (priorAdoption.payloadHash !== payloadHash) {
                    throw new StoryStudioError('Generation id was already adopted with a different payload.', 409, 'generation_conflict', {
                        generationId: adoption.generationId,
                    });
                }
                return { project, chapter, adoption: priorAdoption, idempotent: true };
            }

            this.assertProjectVersion(project, expectedProjectVersion);
            if (Number(expectedRevision) !== chapter.revision) {
                throw new StoryStudioError('Chapter changed in another window.', 409, 'chapter_conflict', {
                    currentRevision: chapter.revision,
                    currentProjectVersion: project.version,
                });
            }

            let nextContent = chapter.content;
            if (adoption.content?.mode === 'replace') {
                nextContent = adoption.content.text;
            } else if (adoption.content?.mode === 'append') {
                nextContent += adoption.content.text;
            } else if (adoption.content?.mode === 'insert') {
                if (adoption.content.offset > nextContent.length) {
                    throw new StoryStudioError('adoption.content.offset is outside the chapter.', 400, 'invalid_adoption_offset', {
                        maximum: nextContent.length,
                    });
                }
                nextContent = `${nextContent.slice(0, adoption.content.offset)}${adoption.content.text}${nextContent.slice(adoption.content.offset)}`;
            }
            chapter.content = cleanText(nextContent, 'content', 5_000_000);
            if (Object.hasOwn(adoption, 'chapterCard')) {
                chapter.card = structuredClone(adoption.chapterCard);
                const volume = project.volumes.find(item => item.id === chapter.volumeId);
                if (!volume) throw new StoryStudioError('Chapter volume is missing.', 500, 'invalid_storage');
                chapter.planBasis = { volumeRevision: volume.revision };
            } else if (adoption.hasChapterSummary) {
                chapter.card.summary = adoption.chapterSummary;
                const volume = project.volumes.find(item => item.id === chapter.volumeId);
                if (!volume) throw new StoryStudioError('Chapter volume is missing.', 500, 'invalid_storage');
                chapter.planBasis = { volumeRevision: volume.revision };
            }
            if (Object.hasOwn(adoption, 'review')) chapter.review = adoption.review;
            if (Object.hasOwn(adoption, 'notes')) chapter.notes = adoption.notes;
            if (Object.hasOwn(adoption, 'status')) chapter.status = adoption.status;

            const chapterIds = project.chapters.map(item => item.id);
            project.storyState = applyStoryStateChanges(project.storyState, adoption.storyStateChanges, chapterIds);
            const timestamp = nowIso();
            const historyEntry = {
                generationId: adoption.generationId,
                payloadHash,
                contentHash: sha256(chapter.content),
                kind: adoption.kind,
                mode: adoption.content?.mode ?? 'none',
                contentUnits: countContentUnits(adoption.content?.text ?? ''),
                previousRevision: chapter.revision,
                resultingRevision: chapter.revision + 1,
                adoptedAt: timestamp,
            };
            chapter.generationHistory = normalizeGenerationHistory([
                ...generationHistory,
                historyEntry,
            ]);
            chapter.wordCount = countContentUnits(chapter.content);
            chapter.revision += 1;
            chapter.updatedAt = timestamp;

            const chapterIndex = project.chapters.findIndex(item => item.id === chapter.id);
            if (chapterIndex === -1) {
                throw new StoryStudioError('Chapter index is missing.', 500, 'invalid_storage');
            }
            project.chapters[chapterIndex] = chapterSummary(chapter);
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            project.chapterBytes = project.chapterBytes - previousChapterBytes + serializedByteLength(chapter);
            project.version += 1;
            project.updatedAt = timestamp;
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            beforeCommit?.({ projectVersion: previousProjectVersion, chapter: previousChapter });
            this.commitProjectAndChapter(project, chapter, lock, baseProject, previousChapter);
            return { project, chapter, adoption: historyEntry, idempotent: false };
        });
    }

    listResources(projectId, typeValue = null) {
        return this.withProjectLock(projectId, () => {
            const project = this.readProjectUnlocked(projectId);
            const types = typeValue === null || typeValue === undefined ? RESOURCE_TYPES : [normalizeResourceType(typeValue)];
            const result = [];
            for (const type of types) {
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
                for (const resourceId of project.resources[referenceField]) {
                    result.push(withActiveResourceState(project, resourceSummary(this.readResourceUnlocked(projectId, type, resourceId))));
                }
            }
            return result.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        });
    }

    getResource(projectId, typeValue, resourceId) {
        return this.withProjectLock(projectId, () => {
            const project = this.readProjectUnlocked(projectId);
            const type = normalizeResourceType(typeValue);
            const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
            if (!project.resources[referenceField].includes(resourceId)) {
                throw new StoryStudioError('Resource not found.', 404, 'not_found');
            }
            const resource = this.readResourceUnlocked(projectId, type, resourceId);
            return withActiveResourceState(project, resource);
        });
    }

    importResource(projectId, expectedVersion, importValue) {
        const parsed = parseCompatImport(importValue);
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedVersion);
            const timestamp = nowIso();
            const operations = [];
            let embeddedLorebook = null;
            if (parsed.embeddedLorebook) {
                embeddedLorebook = createResourceRecord('lorebook', projectId, parsed.embeddedLorebook.draft, { timestamp });
                project.resources.lorebookIds.push(embeddedLorebook.id);
                operations.push({ operation: 'write', type: 'lorebook', resourceId: embeddedLorebook.id, resource: embeddedLorebook });
            }
            const primaryDraft = structuredClone(parsed.draft);
            if (parsed.type === 'character' && embeddedLorebook) primaryDraft.embeddedLorebookId = embeddedLorebook.id;
            const primary = createResourceRecord(parsed.type, projectId, primaryDraft, { timestamp });
            project.resources[RESOURCE_REFERENCE_BY_TYPE[primary.type]].push(primary.id);
            operations.push({ operation: 'write', type: primary.type, resourceId: primary.id, resource: primary });
            project.resources = normalizeProjectResources(project.resources);
            project.version += 1;
            project.updatedAt = timestamp;
            const pendingBytes = operations.reduce((sum, item) => sum + serializedByteLength(item.resource), 0);
            const existingSize = this.calculateProjectResourceBytesUnlocked(projectId, {
                ...project.resources,
                characterIds: project.resources.characterIds.filter(id => id !== primary.id),
                lorebookIds: project.resources.lorebookIds.filter(id => id !== embeddedLorebook?.id && id !== primary.id),
                promptProfileIds: project.resources.promptProfileIds.filter(id => id !== primary.id),
            });
            this.assertProjectResourceLimits(project, existingSize.bytes + pendingBytes, existingSize.count + operations.length);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndResources(project, operations, lock);
            return {
                project,
                resource: primary,
                resources: operations.map(item => item.resource),
            };
        });
    }

    updateResource(projectId, typeValue, resourceId, expectedProjectVersion, expectedRevision, changes) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            const type = normalizeResourceType(typeValue);
            const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
            if (!project.resources[referenceField].includes(resourceId)) {
                throw new StoryStudioError('Resource not found.', 404, 'not_found');
            }
            const current = this.readResourceUnlocked(projectId, type, resourceId);
            if (Number(expectedRevision) !== current.revision) {
                throw new StoryStudioError('Resource changed in another window.', 409, 'resource_conflict', {
                    currentRevision: current.revision,
                    currentProjectVersion: project.version,
                });
            }
            const timestamp = nowIso();
            const resource = updateResourceRecord(current, changes, timestamp);
            if (type === 'character' && resource.embeddedLorebookId !== null
                && !project.resources.lorebookIds.includes(resource.embeddedLorebookId)) {
                throw new StoryStudioError('Character refers to a lorebook outside the project.', 400, 'invalid_resource_reference');
            }
            project.version += 1;
            project.updatedAt = timestamp;
            const currentSize = this.calculateProjectResourceBytesUnlocked(projectId, project.resources);
            const nextBytes = currentSize.bytes - serializedByteLength(current) + serializedByteLength(resource);
            this.assertProjectResourceLimits(project, nextBytes, currentSize.count);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndResources(project, [
                { operation: 'write', type, resourceId, resource },
            ], lock);
            return { project, resource };
        });
    }

    deleteResource(projectId, typeValue, resourceId, expectedProjectVersion, expectedRevision) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedProjectVersion);
            const type = normalizeResourceType(typeValue);
            const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
            if (!project.resources[referenceField].includes(resourceId)) {
                throw new StoryStudioError('Resource not found.', 404, 'not_found');
            }
            const current = this.readResourceUnlocked(projectId, type, resourceId);
            if (Number(expectedRevision) !== current.revision) {
                throw new StoryStudioError('Resource changed in another window.', 409, 'resource_conflict', {
                    currentRevision: current.revision,
                    currentProjectVersion: project.version,
                });
            }
            const timestamp = nowIso();
            const operations = [{ operation: 'delete', type, resourceId, resource: null }];
            project.resources[referenceField] = project.resources[referenceField].filter(id => id !== resourceId);
            const activeField = RESOURCE_ACTIVE_REFERENCE_BY_TYPE[type];
            if (type === 'prompt-profile') {
                if (project.resources[activeField] === resourceId) project.resources[activeField] = null;
            } else {
                project.resources[activeField] = project.resources[activeField].filter(id => id !== resourceId);
            }
            if (type === 'character' && project.resources.activePersonaId === resourceId) {
                project.resources.activePersonaId = null;
            }
            if (type === 'lorebook') {
                for (const characterId of project.resources.characterIds) {
                    const character = this.readResourceUnlocked(projectId, 'character', characterId);
                    if (character.embeddedLorebookId !== resourceId) continue;
                    const updated = updateResourceRecord(character, { embeddedLorebookId: null }, timestamp);
                    operations.push({ operation: 'write', type: 'character', resourceId: characterId, resource: updated });
                }
            }
            project.resources = normalizeProjectResources(project.resources);
            project.version += 1;
            project.updatedAt = timestamp;
            const currentSize = this.calculateProjectResourceBytesUnlocked(projectId, {
                ...project.resources,
                [referenceField]: [...project.resources[referenceField], resourceId],
            });
            const updatedCharacterDelta = operations
                .filter(item => item.type === 'character')
                .reduce((sum, item) => {
                    const before = this.readResourceUnlocked(projectId, item.type, item.resourceId);
                    return sum + serializedByteLength(item.resource) - serializedByteLength(before);
                }, 0);
            this.assertProjectResourceLimits(project, currentSize.bytes - serializedByteLength(current) + updatedCharacterDelta, currentSize.count - 1);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.commitProjectAndResources(project, operations, lock);
            return { project, deleted: { id: resourceId, type } };
        });
    }

    updateResourceActivation(projectId, expectedVersion, changesValue) {
        return this.withProjectLock(projectId, lock => {
            const project = this.readProjectUnlocked(projectId);
            this.assertProjectVersion(project, expectedVersion);
            assertPlainObject(changesValue, 'resource activation changes');
            assertAllowedKeys(
                changesValue,
                ['activeCharacterIds', 'activeLorebookIds', 'activePromptProfileId', 'activePersonaId'],
                'resource activation changes',
            );
            project.resources = normalizeProjectResources({ ...project.resources, ...changesValue });
            project.version += 1;
            project.updatedAt = nowIso();
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), project);
            return project;
        });
    }

    async exportProject(projectId) {
        return await this.withProjectLockAsync(projectId, async () => {
            const project = this.readProjectUnlocked(projectId);
            const chapters = [];
            const resources = { characters: [], lorebooks: [], promptProfiles: [] };
            let chapterBytes = 0;
            let resourceBytes = 0;
            let resourceCount = 0;
            for (const summary of project.chapters.slice().sort((a, b) => a.number - b.number)) {
                const chapter = await readJsonAsync(this.chapterPath(projectId, summary.id), 'Chapter not found.');
                this.validateStoredChapter(chapter, projectId, summary.id);
                assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
                chapterBytes += serializedByteLength(chapter);
                this.assertProjectChapterBytes(chapterBytes);
                chapters.push(chapter);
            }
            for (const type of RESOURCE_TYPES) {
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
                const exportField = RESOURCE_EXPORT_BY_TYPE[type];
                for (const resourceId of project.resources[referenceField]) {
                    const resource = this.readResourceUnlocked(projectId, type, resourceId);
                    resourceBytes += serializedByteLength(resource);
                    resourceCount += 1;
                    resources[exportField].push(resource);
                }
            }
            project.chapterBytes = chapterBytes;
            this.assertProjectResourceLimits(project, resourceBytes, resourceCount);
            const payload = {
                format: 'sillytavern-story-studio',
                schemaVersion: STORY_STUDIO_SCHEMA_VERSION,
                exportedAt: nowIso(),
                project,
                chapters,
                resources,
            };
            assertPayloadSize(payload, this.maxProjectBytes, 'Export');
            return payload;
        });
    }

    async importProject(payload) {
        assertPlainObject(payload, 'import');
        assertKnownKeys(payload, IMPORT_FIELDS, 'import');
        if (!payload || payload.format !== 'sillytavern-story-studio' || !payload.project || !Array.isArray(payload.chapters)) {
            throw new StoryStudioError('Unsupported Story Studio export.', 400, 'invalid_import');
        }
        assertPlainObject(payload.project, 'import project');
        assertKnownKeys(payload.project, IMPORT_PROJECT_FIELDS, 'import project');
        const sourceSchemaVersion = Number(payload.schemaVersion);
        if (!SUPPORTED_STORY_STUDIO_SCHEMA_VERSIONS.has(sourceSchemaVersion)
            || Number(payload.project.schemaVersion) !== sourceSchemaVersion) {
            throw new StoryStudioError('Unsupported Story Studio schema version.', 400, 'unsupported_schema');
        }
        if (payload.chapters.some(chapter => Number(chapter?.schemaVersion) !== sourceSchemaVersion)) {
            throw new StoryStudioError('Import contains an unsupported chapter schema.', 400, 'unsupported_schema');
        }
        if (sourceSchemaVersion === LEGACY_STORY_STUDIO_SCHEMA_VERSION && (payload.resources !== undefined || payload.project.resources !== undefined)) {
            throw new StoryStudioError('Legacy exports cannot contain V2 resources.', 400, 'invalid_import');
        }
        assertProjectSchemaShape(payload.project, sourceSchemaVersion, 'import project');
        for (const [index, chapter] of payload.chapters.entries()) {
            assertPlainObject(chapter, `chapters[${index}]`);
            assertChapterSchemaShape(chapter, sourceSchemaVersion, `chapters[${index}]`);
        }
        if (payload.chapters.length > this.maxProjectChapters) {
            throw new StoryStudioError('Import has too many chapters.', 400, 'invalid_import');
        }
        assertPayloadSize(payload, MAX_IMPORT_BYTES, 'Import');
        const id = randomUUID();
        const timestamp = nowIso();
        const sourceChapters = payload.chapters.length > 0 ? payload.chapters : [{}];
        let volumes;
        const sourceVolumeIdToNew = new Map();
        if (sourceSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
            const sourceVolumes = normalizeVolumes(payload.project.volumes);
            if (!Array.isArray(payload.project.chapters) || payload.project.chapters.length !== payload.chapters.length) {
                throw new StoryStudioError('V4 import project index does not match its chapters.', 400, 'invalid_import');
            }
            assertVolumeChapterLayout(sourceVolumes, payload.project.chapters, sourceSchemaVersion);
            const sourceIds = payload.chapters.map((chapter, index) => assertId(chapter.id, `chapters[${index}].id`));
            if (stableJson(payload.project.chapters.map(item => item.id)) !== stableJson(sourceIds)) {
                throw new StoryStudioError('V4 import chapter order does not match its project index.', 400, 'invalid_import');
            }
            volumes = sourceVolumes.map((source, index) => {
                const newId = randomUUID();
                sourceVolumeIdToNew.set(source.id, newId);
                return normalizeVolume({
                    ...source,
                    id: newId,
                    number: index + 1,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                }, index, `volumes[${index}]`);
            });
        } else {
            volumes = [createVolume(1, {}, timestamp)];
        }
        const chapters = [];
        const sourceChapterIdToNew = new Map();
        let chapterBytes = 0;
        for (let index = 0; index < sourceChapters.length; index++) {
            const source = sourceChapters[index] ?? {};
            assertPlainObject(source, `chapters[${index}]`);
            assertChapterSchemaShape(source, sourceSchemaVersion, `chapters[${index}]`);
            if (sourceSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
                try {
                    this.validateChapterOperationRecord(payload.project.id, source.id, source);
                } catch (error) {
                    throw new StoryStudioError('V4 import contains an invalid chapter record.', 400, 'invalid_import', {
                        chapterId: source.id,
                        cause: error.code || error.message,
                    });
                }
                if (stableJson(chapterSummary(source)) !== stableJson(payload.project.chapters[index])) {
                    throw new StoryStudioError('V4 import chapter records do not match the project index.', 400, 'invalid_import', {
                        chapterId: source.id,
                    });
                }
            }
            const targetVolumeId = sourceSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
                ? sourceVolumeIdToNew.get(assertId(source.volumeId, `chapters[${index}].volumeId`))
                : volumes[0].id;
            if (!targetVolumeId) {
                throw new StoryStudioError('Import chapter refers to an unknown volume.', 400, 'invalid_volume_reference');
            }
            const targetVolume = volumes.find(volume => volume.id === targetVolumeId);
            const chapter = createChapter(id, index + 1, source, {
                volumeId: targetVolumeId,
                planBasis: sourceSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
                    ? normalizePlanBasis(source.planBasis)
                    : { volumeRevision: targetVolume.revision },
            });
            if (sourceSchemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
                const sourceChapterId = assertId(source.id, `chapters[${index}].id`);
                if (sourceChapterIdToNew.has(sourceChapterId)) {
                    throw new StoryStudioError('Import contains duplicate chapter ids.', 400, 'duplicate_chapter_id', { id: sourceChapterId });
                }
                sourceChapterIdToNew.set(sourceChapterId, chapter.id);
                chapter.revision = cleanInteger(source.revision, `chapters[${index}].revision`, 1, 100_000_000, 1);
            } else {
                chapter.generationHistory = [];
            }
            chapter.title = cleanText(source.title, `chapters[${index}].title`, 160, `第${index + 1}章`);
            chapter.status = CHAPTER_STATUSES.has(source.status) ? source.status : 'planned';
            chapter.card = normalizeCard(source.card);
            chapter.candidate = normalizeCandidate(source.candidate);
            chapter.review = cleanText(source.review, `chapters[${index}].review`, 1_000_000);
            chapter.notes = cleanText(source.notes, `chapters[${index}].notes`, 1_000_000);
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
            chapterBytes += serializedByteLength(chapter);
            this.assertProjectChapterBytes(chapterBytes);
            chapters.push(chapter);
        }

        let storyState = emptyStoryState();
        if (sourceSchemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
            const sourceChapterIds = [...sourceChapterIdToNew.keys()];
            const sourceStoryState = normalizeStoryState(payload.project.storyState ?? {}, sourceChapterIds);
            const remapChapterId = chapterId => chapterId === null ? null : sourceChapterIdToNew.get(chapterId);
            storyState = normalizeStoryState({
                ...sourceStoryState,
                entities: sourceStoryState.entities.map(entity => ({
                    ...entity,
                    updatedChapterId: remapChapterId(entity.updatedChapterId),
                })),
                relations: sourceStoryState.relations.map(relation => ({
                    ...relation,
                    sinceChapterId: remapChapterId(relation.sinceChapterId),
                })),
                events: sourceStoryState.events.map(event => ({ ...event, chapterId: remapChapterId(event.chapterId) })),
                promises: sourceStoryState.promises.map(promise => ({
                    ...promise,
                    introducedChapterId: remapChapterId(promise.introducedChapterId),
                    dueChapterId: remapChapterId(promise.dueChapterId),
                    resolvedChapterId: remapChapterId(promise.resolvedChapterId),
                    evidenceChapterIds: promise.evidenceChapterIds.map(remapChapterId),
                })),
                memory: sourceStoryState.memory.map(item => ({
                    ...item,
                    chapterId: remapChapterId(item.chapterId),
                    sourceChapterIds: item.sourceChapterIds.map(remapChapterId),
                })),
                facts: sourceStoryState.facts.map(fact => ({
                    ...fact,
                    sourceChapterId: remapChapterId(fact.sourceChapterId),
                })),
                knowledge: sourceStoryState.knowledge.map(item => ({
                    ...item,
                    learnedChapterId: remapChapterId(item.learnedChapterId),
                })),
                timeline: sourceStoryState.timeline.map(item => ({
                    ...item,
                    chapterId: remapChapterId(item.chapterId),
                })),
            }, chapters.map(chapter => chapter.id));
        }

        const importedResourcePayload = sourceSchemaVersion >= RESOURCE_STORY_STUDIO_SCHEMA_VERSION
            ? normalizeResourceExports(payload.resources ?? {})
            : { characters: [], lorebooks: [], promptProfiles: [] };
        const sourceReferences = sourceSchemaVersion >= RESOURCE_STORY_STUDIO_SCHEMA_VERSION
            ? normalizeProjectResources(payload.project.resources ?? {})
            : emptyProjectResources();
        const descriptors = [];
        const sourceToNewId = Object.fromEntries(RESOURCE_TYPES.map(type => [type, new Map()]));
        for (const type of RESOURCE_TYPES) {
            const exportField = RESOURCE_EXPORT_BY_TYPE[type];
            for (const source of importedResourcePayload[exportField]) {
                let normalized;
                try {
                    normalized = normalizeExportedResource(source, type);
                } catch (error) {
                    if (error instanceof CompatImportError) throw error;
                    throw new StoryStudioError('Import contains an invalid resource.', 400, 'invalid_import');
                }
                const sourceId = assertId(normalized.sourceId, 'imported resource id');
                if (sourceToNewId[type].has(sourceId)) {
                    throw new StoryStudioError('Import contains duplicate resource ids.', 400, 'duplicate_resource_id', { id: sourceId });
                }
                const newId = randomUUID();
                sourceToNewId[type].set(sourceId, newId);
                descriptors.push({ ...normalized, sourceId, newId });
            }
            const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
            const sourceIds = new Set(sourceToNewId[type].keys());
            if (sourceReferences[referenceField].some(resourceId => !sourceIds.has(resourceId))
                || [...sourceIds].some(resourceId => !sourceReferences[referenceField].includes(resourceId))) {
                throw new StoryStudioError('Project resource references do not match exported resources.', 400, 'invalid_resource_references', { type });
            }
        }

        const projectResources = {
            characterIds: sourceReferences.characterIds.map(resourceId => sourceToNewId.character.get(resourceId)),
            lorebookIds: sourceReferences.lorebookIds.map(resourceId => sourceToNewId.lorebook.get(resourceId)),
            promptProfileIds: sourceReferences.promptProfileIds.map(resourceId => sourceToNewId['prompt-profile'].get(resourceId)),
            activeCharacterIds: sourceReferences.activeCharacterIds.map(resourceId => sourceToNewId.character.get(resourceId)),
            activeLorebookIds: sourceReferences.activeLorebookIds.map(resourceId => sourceToNewId.lorebook.get(resourceId)),
            activePromptProfileId: sourceReferences.activePromptProfileId === null
                ? null
                : sourceToNewId['prompt-profile'].get(sourceReferences.activePromptProfileId),
            activePersonaId: sourceReferences.activePersonaId === null
                ? null
                : sourceToNewId.character.get(sourceReferences.activePersonaId),
        };
        const resourceRecords = [];
        let resourceBytes = 0;
        for (const descriptor of descriptors) {
            const draft = structuredClone(descriptor.draft);
            if (descriptor.type === 'character' && draft.embeddedLorebookId) {
                draft.embeddedLorebookId = sourceToNewId.lorebook.get(draft.embeddedLorebookId) ?? null;
            }
            const record = createResourceRecord(descriptor.type, id, draft, { id: descriptor.newId, timestamp });
            resourceBytes += serializedByteLength(record);
            if (resourceBytes > this.maxProjectBytes) {
                throw new StoryStudioError('Import resources exceed the storage limit.', 413, 'project_resource_bytes_exceeded', {
                    maximum: this.maxProjectBytes,
                    actual: resourceBytes,
                });
            }
            resourceRecords.push(record);
        }
        const project = {
            schemaVersion: STORY_STUDIO_SCHEMA_VERSION,
            id,
            title: cleanText(payload.project.title, 'title', 160, '导入作品'),
            genre: cleanText(payload.project.genre, 'genre', 80),
            targetWords: cleanInteger(payload.project.targetWords, 'targetWords', 1_000, 100_000_000, 2_000_000),
            chapterTargetWords: cleanInteger(payload.project.chapterTargetWords, 'chapterTargetWords', 100, 100_000, 3_000),
            story: normalizeStory(payload.project.story),
            continuity: normalizeContinuity(payload.project.continuity),
            storyState,
            volumes,
            chapters: chapters.map(chapterSummary),
            chapterBytes,
            resources: normalizeProjectResources(projectResources),
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.assertProjectResourceLimits(project, resourceBytes, resourceRecords.length);
        assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
        const stagingDirectory = path.join(this.projectsDirectory, `.staging-${id}`);
        const destinationDirectory = this.projectDirectory(id);
        const stagingOwnerPath = path.join(stagingDirectory, STAGING_OWNER_FILE);
        try {
            await fs.promises.mkdir(path.join(stagingDirectory, 'chapters'), { recursive: true });
            for (const directoryName of Object.values(RESOURCE_DIRECTORY_BY_TYPE)) {
                await fs.promises.mkdir(path.join(stagingDirectory, 'resources', directoryName), { recursive: true });
            }
            await writeJsonAsync(stagingOwnerPath, {
                token: randomUUID(),
                pid: process.pid,
                instanceId: PROCESS_INSTANCE_ID,
                createdAt: timestamp,
            });
            for (const chapter of chapters) {
                await writeJsonAsync(path.join(stagingDirectory, 'chapters', `${chapter.id}.json`), chapter);
            }
            for (const resource of resourceRecords) {
                await writeJsonAsync(
                    path.join(stagingDirectory, 'resources', RESOURCE_DIRECTORY_BY_TYPE[resource.type], `${resource.id}.json`),
                    resource,
                );
            }
            await writeJsonAsync(path.join(stagingDirectory, 'project.json'), project);
            await fs.promises.rm(stagingOwnerPath, { force: true });
            await fs.promises.rename(stagingDirectory, destinationDirectory);
        } catch (error) {
            await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
            throw error;
        }
        return { project, chapter: chapters[0] };
    }

    normalizeCurrentProjectUnlocked(projectId, project, missingChapterBytes = undefined) {
        this.validateStoredProject(project, projectId);
        if (project.schemaVersion !== STORY_STUDIO_SCHEMA_VERSION) {
            throw new StoryStudioError('Project storage must be migrated before use.', 500, 'migration_required');
        }
        project.resources = normalizeProjectResources(project.resources);
        project.storyState = normalizeStoryState(project.storyState, project.chapters.map(item => item.id));
        project.volumes = normalizeVolumes(project.volumes);
        assertVolumeChapterLayout(project.volumes, project.chapters, project.schemaVersion);
        this.assertProjectChapterCount(project.chapters.length);
        if (project.chapterBytes === undefined) {
            project.chapterBytes = missingChapterBytes === undefined
                ? this.calculateProjectChapterBytesUnlocked(projectId, project.chapters)
                : missingChapterBytes;
        }
        this.assertProjectChapterBytes(project.chapterBytes);
        return project;
    }

    readProjectUnlocked(projectId) {
        const project = this.normalizeCurrentProjectUnlocked(
            projectId,
            readJson(this.projectPath(projectId), 'Project not found.'),
        );
        this.assertStoredProjectLimitsUnlocked(projectId, project);
        return project;
    }

    readPendingProjectUnlocked(projectId, baseProjectChapterBytes) {
        const project = readJson(this.projectPath(projectId), 'Project not found.');
        this.validateStoredProject(project, projectId);
        if (project.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
            project.resources = normalizeProjectResources(project.resources);
            const normalizedStoryState = normalizeStoryState(project.storyState, project.chapters.map(item => item.id));
            if (project.schemaVersion === STORY_STUDIO_SCHEMA_VERSION) project.storyState = normalizedStoryState;
            project.volumes = normalizeVolumes(project.volumes);
            assertVolumeChapterLayout(project.volumes, project.chapters, project.schemaVersion);
            if (project.chapterBytes === undefined) project.chapterBytes = baseProjectChapterBytes;
            this.assertProjectChapterBytes(project.chapterBytes);
        } else if (project.schemaVersion === STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
            project.resources = normalizeProjectResources(project.resources);
            normalizeStoryState(project.storyState, project.chapters.map(item => item.id));
            if (project.chapterBytes === undefined) project.chapterBytes = baseProjectChapterBytes;
            this.assertProjectChapterBytes(project.chapterBytes);
        } else {
            throw new StoryStudioError('Pending transaction uses an unsupported legacy schema.', 500, 'invalid_storage');
        }
        assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
        return project;
    }

    readChapterUnlocked(projectId, chapterId) {
        const chapter = readJson(this.chapterPath(projectId, chapterId), 'Chapter not found.');
        this.validateStoredChapter(chapter, projectId, chapterId);
        if (chapter.schemaVersion !== STORY_STUDIO_SCHEMA_VERSION) {
            throw new StoryStudioError('Chapter storage must be migrated before use.', 500, 'migration_required');
        }
        chapter.generationHistory = normalizeGenerationHistory(chapter.generationHistory);
        return chapter;
    }

    readResourceUnlocked(projectId, typeValue, resourceId) {
        const type = normalizeResourceType(typeValue);
        const resource = readJson(this.resourcePath(projectId, type, resourceId), 'Resource not found.');
        try {
            return validateResourceRecord(resource, projectId, resourceId, type);
        } catch (error) {
            if (error instanceof CompatImportError && error.status === 404) {
                throw new StoryStudioError('Resource not found.', 404, 'not_found');
            }
            throw error;
        }
    }

    validateStoredProject(project, projectId) {
        if (!SUPPORTED_STORY_STUDIO_SCHEMA_VERSIONS.has(project?.schemaVersion)
            || project.id !== projectId || !Array.isArray(project.chapters)) {
            throw new StoryStudioError('Project storage uses an unsupported schema.', 500, 'unsupported_schema');
        }
        assertProjectSchemaShape(project, project.schemaVersion, 'stored project', {
            status: 500,
            code: 'invalid_storage',
        });
        if (project.schemaVersion >= RESOURCE_STORY_STUDIO_SCHEMA_VERSION) normalizeProjectResources(project.resources);
        if (project.schemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
            const normalizedStoryState = normalizeStoryState(project.storyState, project.chapters.map(item => item.id));
            if (project.schemaVersion === STORY_STUDIO_SCHEMA_VERSION
                && stableJson(normalizedStoryState) !== stableJson(project.storyState)) {
                throw new StoryStudioError('Stored story state is not canonical.', 500, 'invalid_storage');
            }
        }
        if (project.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
            const volumes = normalizeVolumes(project.volumes);
            if (stableJson(volumes) !== stableJson(project.volumes)) {
                throw new StoryStudioError('Stored volumes are not canonical.', 500, 'invalid_storage');
            }
            assertVolumeChapterLayout(project.volumes, project.chapters, project.schemaVersion);
        }
    }

    validateStoredChapter(chapter, projectId, chapterId) {
        if (!SUPPORTED_STORY_STUDIO_SCHEMA_VERSIONS.has(chapter?.schemaVersion)
            || chapter.id !== chapterId || chapter.projectId !== projectId) {
            throw new StoryStudioError('Chapter storage uses an unsupported schema.', 500, 'unsupported_schema');
        }
        assertChapterSchemaShape(chapter, chapter.schemaVersion, 'stored chapter', {
            status: 500,
            code: 'invalid_storage',
        });
        if (chapter.schemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) normalizeGenerationHistory(chapter.generationHistory);
        if (chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
            assertId(chapter.volumeId, 'chapter.volumeId');
            normalizePlanBasis(chapter.planBasis);
        }
    }

    migrateProjectUnlocked(projectId, lock) {
        const projectPath = this.projectPath(projectId);
        const baseProject = readJson(projectPath, 'Project not found.');
        this.validateStoredProject(baseProject, projectId);
        if (baseProject.schemaVersion === STORY_STUDIO_SCHEMA_VERSION) return false;
        const sourceSchemaVersion = baseProject.schemaVersion;
        const sourceHasVolumes = sourceSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION;
        const timestamp = nowIso();
        const volumes = sourceHasVolumes
            ? normalizeVolumes(baseProject.volumes)
            : [createVolume(1, {}, timestamp)];
        if (sourceHasVolumes) assertVolumeChapterLayout(volumes, baseProject.chapters, sourceSchemaVersion);
        const chapters = [];
        const baseChapters = [];
        let baseChapterBytes = 0;
        let chapterBytes = 0;
        for (const [index, summary] of baseProject.chapters.entries()) {
            assertPlainObject(summary, `chapters[${index}]`);
            assertKnownKeys(
                summary,
                sourceHasVolumes ? CHAPTER_SUMMARY_FIELDS : LEGACY_CHAPTER_SUMMARY_FIELDS,
                `chapters[${index}]`,
            );
            const chapterPath = this.chapterPath(projectId, summary.id);
            const baseChapter = readJson(chapterPath, 'Chapter not found.');
            this.validateStoredChapter(baseChapter, projectId, summary.id);
            if (baseChapter.schemaVersion !== sourceSchemaVersion || summary.number !== index + 1
                || stableJson(chapterSummary(baseChapter)) !== stableJson(summary)) {
                throw new StoryStudioError('Legacy project index does not match its chapter files.', 500, 'invalid_storage', {
                    chapterId: summary.id,
                });
            }
            baseChapterBytes += serializedByteLength(baseChapter);
            this.assertProjectChapterBytes(baseChapterBytes);
            baseChapters.push({
                chapterId: baseChapter.id,
                schemaVersion: baseChapter.schemaVersion,
                digest: sha256(baseChapter),
                bytes: serializedByteLength(baseChapter),
                revision: baseChapter.revision,
                createdAt: baseChapter.createdAt,
                updatedAt: baseChapter.updatedAt,
            });
            const chapter = structuredClone(baseChapter);
            chapter.schemaVersion = STORY_STUDIO_SCHEMA_VERSION;
            if (!sourceHasVolumes) {
                chapter.volumeId = volumes[0].id;
                chapter.planBasis = { volumeRevision: volumes[0].revision };
                chapter.revision = cleanInteger(baseChapter.revision, 'chapter.revision', 1, 100_000_000, 1) + 1;
                chapter.generationHistory = sourceSchemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION
                    ? normalizeGenerationHistory(baseChapter.generationHistory)
                    : [];
                chapter.updatedAt = timestamp;
            }
            this.validateChapterOperationRecord(projectId, chapter.id, chapter);
            chapterBytes += serializedByteLength(chapter);
            this.assertProjectChapterBytes(chapterBytes);
            chapters.push(chapter);
        }
        if ((sourceHasVolumes || baseProject.chapterBytes !== undefined) && baseProject.chapterBytes !== baseChapterBytes) {
            throw new StoryStudioError('Project chapter byte metadata is inconsistent before migration.', 500, 'invalid_storage', {
                declared: baseProject.chapterBytes,
                actual: baseChapterBytes,
            });
        }
        const sourceResourceSize = this.validateMigrationSourceResourcesUnlocked(projectId, baseProject);
        const project = structuredClone(baseProject);
        project.schemaVersion = STORY_STUDIO_SCHEMA_VERSION;
        project.volumes = structuredClone(volumes);
        project.chapters = chapters.map(chapterSummary);
        project.chapterBytes = chapterBytes;
        project.resources = sourceSchemaVersion >= RESOURCE_STORY_STUDIO_SCHEMA_VERSION
            ? normalizeProjectResources(baseProject.resources)
            : emptyProjectResources();
        project.storyState = sourceSchemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION
            ? normalizeStoryState(baseProject.storyState, chapters.map(chapter => chapter.id))
            : emptyStoryState();
        if (!sourceHasVolumes) {
            project.version = Number.isSafeInteger(baseProject.version) ? baseProject.version + 1 : 1;
            project.updatedAt = timestamp;
        }
        this.assertProjectResourceLimits(project, sourceResourceSize.bytes, sourceResourceSize.count);
        const transactionId = randomUUID();
        const journal = {
            transactionId,
            fromSchemaVersion: sourceSchemaVersion,
            toSchemaVersion: STORY_STUDIO_SCHEMA_VERSION,
            baseProjectDigest: sha256(baseProject),
            baseProjectBytes: serializedByteLength(baseProject),
            baseProject,
            baseChapters,
            project,
            chapters,
        };
        const backup = this.createMigrationBackupUnlocked(
            projectId,
            transactionId,
            sourceSchemaVersion,
            timestamp,
            lock,
        );
        journal.backupManifestDigest = backup.manifestDigest;
        this.validateSchemaMigrationJournal(projectId, journal);
        this.assertProjectLockOwnership(lock);
        writeJson(this.schemaMigrationJournalPath(projectId), journal);
        let completed = false;
        try {
            this.applySchemaMigrationUnlocked(projectId, journal, lock);
            completed = true;
        } finally {
            if (completed) fs.rmSync(this.schemaMigrationJournalPath(projectId), { force: true });
        }
        return true;
    }

    validateSchemaMigrationJournal(projectId, journal) {
        try {
            assertPlainObject(journal, 'schema migration journal');
            assertKnownKeys(journal, [
                'transactionId', 'fromSchemaVersion', 'toSchemaVersion', 'baseProjectDigest', 'baseProjectBytes',
                'backupManifestDigest', 'baseProject', 'baseChapters', 'project', 'chapters',
            ], 'schema migration journal');
            assertId(journal.transactionId, 'transaction id');
            if (!SUPPORTED_STORY_STUDIO_SCHEMA_VERSIONS.has(journal.fromSchemaVersion)
                || journal.fromSchemaVersion >= STORY_STUDIO_SCHEMA_VERSION
                || journal.toSchemaVersion !== STORY_STUDIO_SCHEMA_VERSION
                || !SHA256_HEX.test(journal.baseProjectDigest)
                || !SHA256_HEX.test(journal.backupManifestDigest)
                || !Number.isSafeInteger(journal.baseProjectBytes) || journal.baseProjectBytes <= 0
                || !Array.isArray(journal.baseChapters) || !Array.isArray(journal.chapters)) {
                throw new Error('invalid migration envelope');
            }
            this.validateMigrationBackupUnlocked(
                projectId,
                journal.transactionId,
                journal.fromSchemaVersion,
                journal.backupManifestDigest,
            );
            this.validateStoredProject(journal.baseProject, projectId);
            if (journal.baseProject.schemaVersion !== journal.fromSchemaVersion
                || sha256(journal.baseProject) !== journal.baseProjectDigest
                || serializedByteLength(journal.baseProject) !== journal.baseProjectBytes
                || journal.baseProject.chapters.length !== journal.baseChapters.length
                || journal.chapters.length !== journal.baseChapters.length) {
                throw new Error('invalid migration base project');
            }
            this.validateStoredProject(journal.project, projectId);
            const sourceHasVolumes = journal.fromSchemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION;
            if (journal.project.schemaVersion !== STORY_STUDIO_SCHEMA_VERSION
                || journal.project.createdAt !== journal.baseProject.createdAt) {
                throw new Error('invalid migration target project');
            }
            if (sourceHasVolumes) {
                if (journal.project.version !== journal.baseProject.version
                    || journal.project.updatedAt !== journal.baseProject.updatedAt
                    || stableJson(journal.project.volumes) !== stableJson(journal.baseProject.volumes)) {
                    throw new Error('V4 migration changed preserved project fields');
                }
            } else if (journal.project.version !== journal.baseProject.version + 1
                || journal.project.volumes.length !== 1
                || journal.project.volumes[0].revision !== 1
                || journal.project.volumes[0].createdAt !== journal.project.updatedAt
                || journal.project.volumes[0].updatedAt !== journal.project.updatedAt) {
                throw new Error('legacy migration target is invalid');
            }
            const legacyVolume = sourceHasVolumes ? null : journal.project.volumes[0];
            let targetBytes = 0;
            for (const [index, baseline] of journal.baseChapters.entries()) {
                assertPlainObject(baseline, `baseChapters[${index}]`);
                assertKnownKeys(baseline, [
                    'chapterId', 'schemaVersion', 'digest', 'bytes', 'revision', 'createdAt', 'updatedAt',
                ], `baseChapters[${index}]`);
                const target = journal.chapters[index];
                const sourceSummary = journal.baseProject.chapters[index];
                if (baseline.chapterId !== sourceSummary.id || target?.id !== baseline.chapterId
                    || baseline.schemaVersion !== journal.fromSchemaVersion || !SHA256_HEX.test(baseline.digest)
                    || !Number.isSafeInteger(baseline.bytes) || baseline.bytes <= 0
                    || !Number.isSafeInteger(baseline.revision) || baseline.revision < 1
                    || typeof baseline.createdAt !== 'string' || !Number.isFinite(Date.parse(baseline.createdAt))
                    || typeof baseline.updatedAt !== 'string' || !Number.isFinite(Date.parse(baseline.updatedAt))) {
                    throw new Error('invalid migration chapter baseline');
                }
                this.validateChapterOperationRecord(projectId, target.id, target);
                const reconstructed = structuredClone(target);
                reconstructed.schemaVersion = baseline.schemaVersion;
                if (!sourceHasVolumes) {
                    reconstructed.revision = baseline.revision;
                    reconstructed.updatedAt = baseline.updatedAt;
                    delete reconstructed.volumeId;
                    delete reconstructed.planBasis;
                    if (baseline.schemaVersion < STORY_STATE_STORY_STUDIO_SCHEMA_VERSION) {
                        delete reconstructed.generationHistory;
                    }
                }
                const targetMetadataIsValid = sourceHasVolumes
                    ? target.revision === baseline.revision
                        && target.updatedAt === baseline.updatedAt
                        && target.volumeId === sourceSummary.volumeId
                        && stableJson(target.planBasis) === stableJson(sourceSummary.planBasis)
                    : target.revision === baseline.revision + 1
                        && target.updatedAt === journal.project.updatedAt
                        && target.volumeId === legacyVolume.id
                        && target.planBasis.volumeRevision === legacyVolume.revision;
                if (sha256(reconstructed) !== baseline.digest || serializedByteLength(reconstructed) !== baseline.bytes
                    || !targetMetadataIsValid || target.createdAt !== baseline.createdAt || target.number !== index + 1
                    || stableJson(chapterSummary(target)) !== stableJson(journal.project.chapters[index])) {
                    throw new Error('invalid migration chapter transition');
                }
                targetBytes += serializedByteLength(target);
                this.assertProjectChapterBytes(targetBytes);
            }
            if (journal.project.chapterBytes !== targetBytes) throw new Error('invalid migration byte projection');
            const expectedProject = structuredClone(journal.baseProject);
            expectedProject.schemaVersion = STORY_STUDIO_SCHEMA_VERSION;
            expectedProject.volumes = structuredClone(journal.project.volumes);
            expectedProject.chapters = structuredClone(journal.project.chapters);
            expectedProject.chapterBytes = journal.project.chapterBytes;
            expectedProject.resources = journal.fromSchemaVersion >= RESOURCE_STORY_STUDIO_SCHEMA_VERSION
                ? normalizeProjectResources(journal.baseProject.resources)
                : emptyProjectResources();
            expectedProject.storyState = journal.fromSchemaVersion >= STORY_STATE_STORY_STUDIO_SCHEMA_VERSION
                ? normalizeStoryState(journal.baseProject.storyState, journal.project.chapters.map(chapter => chapter.id))
                : emptyStoryState();
            if (!sourceHasVolumes) {
                expectedProject.version = journal.project.version;
                expectedProject.updatedAt = journal.project.updatedAt;
            }
            if (stableJson(expectedProject) !== stableJson(journal.project)) throw new Error('migration changes unrelated project fields');
            assertPayloadSize(journal.project, MAX_PROJECT_BYTES, 'Project');
            return journal;
        } catch (error) {
            if (error instanceof StoryStudioError && error.code === 'invalid_storage') throw error;
            throw new StoryStudioError('Schema migration journal is invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    applySchemaMigrationUnlocked(projectId, journal, lock) {
        for (const directoryName of Object.values(RESOURCE_DIRECTORY_BY_TYPE)) {
            this.assertProjectLockOwnership(lock);
            fs.mkdirSync(path.join(this.resourcesDirectory(projectId), directoryName), { recursive: true });
        }
        for (const chapter of journal.chapters) {
            this.assertProjectLockOwnership(lock);
            writeJson(this.chapterPath(projectId, chapter.id), chapter);
        }
        this.assertProjectLockOwnership(lock);
        writeJson(this.projectPath(projectId), journal.project);
    }

    recoverSchemaMigrationUnlocked(projectId, lock) {
        const journalPath = this.schemaMigrationJournalPath(projectId);
        if (!fs.existsSync(journalPath)) return;
        const journal = this.validateSchemaMigrationJournal(
            projectId,
            readJson(journalPath, 'Schema migration journal not found.'),
        );
        const currentProject = readJson(this.projectPath(projectId), 'Project not found.');
        this.validateStoredProject(currentProject, projectId);
        const baseMatchesProject = stableJson(currentProject) === stableJson(journal.baseProject);
        const targetMatchesProject = stableJson(currentProject) === stableJson(journal.project);
        let allBase = true;
        let allTarget = true;
        let divergent = false;
        for (const [index, baseline] of journal.baseChapters.entries()) {
            let digest = null;
            let bytes = null;
            try {
                const current = readJson(this.chapterPath(projectId, baseline.chapterId), 'Chapter not found.');
                digest = sha256(current);
                bytes = serializedByteLength(current);
            } catch {
                // Missing or unreadable chapters match neither migration state.
            }
            const base = digest === baseline.digest && bytes === baseline.bytes;
            const target = digest === sha256(journal.chapters[index])
                && bytes === serializedByteLength(journal.chapters[index]);
            allBase &&= base;
            allTarget &&= target;
            divergent ||= !base && !target;
        }
        const block = () => {
            throw new StoryStudioError(
                'Schema migration conflicts with project or chapter files; automatic recovery is blocked.',
                500,
                'stale_journal',
                { transactionId: journal.transactionId, recoveryBlocked: true },
            );
        };
        if (targetMatchesProject) {
            if (!allTarget) block();
            this.assertProjectLockOwnership(lock);
            fs.rmSync(journalPath, { force: true });
            return;
        }
        if (baseMatchesProject) {
            if (divergent) block();
            this.applySchemaMigrationUnlocked(projectId, journal, lock);
            fs.rmSync(journalPath, { force: true });
            return;
        }
        if (!allBase) block();
        const currentProjectIsCoherent = currentProject.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
            ? this.chapterFilesMatchProjectIndexUnlocked(projectId, currentProject)
            : this.legacyChapterFilesMatchProjectIndexUnlocked(projectId, currentProject);
        if (!currentProjectIsCoherent) block();
        this.assertProjectLockOwnership(lock);
        const conflictPath = path.join(
            this.projectDirectory(projectId),
            `.pending-schema-migration.conflict-${journal.transactionId}-${Date.now()}.json`,
        );
        fs.renameSync(journalPath, conflictPath);
        console.warn(`Quarantined conflicting Story Studio schema migration for project ${projectId}: ${path.basename(conflictPath)}`);
    }

    writeNewProjectSync(project, chapters) {
        const stagingDirectory = path.join(this.projectsDirectory, `.staging-${project.id}`);
        try {
            for (const directoryName of Object.values(RESOURCE_DIRECTORY_BY_TYPE)) {
                fs.mkdirSync(path.join(stagingDirectory, 'resources', directoryName), { recursive: true });
            }
            for (const chapter of chapters) {
                writeJson(path.join(stagingDirectory, 'chapters', `${chapter.id}.json`), chapter);
            }
            writeJson(path.join(stagingDirectory, 'project.json'), project);
            fs.renameSync(stagingDirectory, this.projectDirectory(project.id));
        } catch (error) {
            fs.rmSync(stagingDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    commitProjectAndChapter(project, chapter, lock, baseProject, baseChapter) {
        const baseProjectVersion = baseProject.version;
        const metadata = {
            baseProjectDigest: sha256(baseProject),
            baseProjectInvariantDigest: projectInvariantDigest(baseProject, CHAPTER_WRITE_MUTABLE_PROJECT_FIELDS),
            baseChapterIds: baseProject.chapters.map(item => item.id),
            baseProjectChapterBytes: baseProject.chapterBytes,
            baseChapterDigest: baseChapter ? sha256(baseChapter) : null,
            baseChapterBytes: baseChapter ? serializedByteLength(baseChapter) : 0,
            baseChapterRevision: baseChapter ? baseChapter.revision : null,
            baseChapterNumber: baseChapter ? baseChapter.number : null,
            baseChapterCreatedAt: baseChapter ? baseChapter.createdAt : null,
            ...(baseProject.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION ? {
                baseChapterVolumeId: baseChapter?.volumeId ?? null,
                baseChapterPlanBasis: baseChapter ? normalizePlanBasis(baseChapter.planBasis) : null,
            } : {}),
        };
        this.validateProjectAndChapterWrite(project.id, project, chapter, baseProjectVersion, metadata);
        if (!this.chapterProjectTransitionMatches(baseProject, project, chapter, baseChapter)) {
            throw new StoryStudioError('Chapter transaction changes unrelated project fields.', 500, 'invalid_storage');
        }
        const journalPath = path.join(this.projectDirectory(project.id), '.pending-write.json');
        this.assertProjectLockOwnership(lock);
        writeJson(journalPath, {
            transactionId: randomUUID(),
            baseProjectVersion,
            ...metadata,
            project,
            chapter,
        });
        let completed = false;
        try {
            this.assertProjectLockOwnership(lock);
            writeJson(this.chapterPath(project.id, chapter.id), chapter);
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(project.id), project);
            completed = true;
        } finally {
            if (completed) fs.rmSync(journalPath, { force: true });
        }
    }

    validateChapterOperationRecord(projectId, chapterId, chapter) {
        try {
            this.validateStoredChapter(chapter, projectId, chapterId);
            if (![STORY_STATE_STORY_STUDIO_SCHEMA_VERSION, VOLUME_STORY_STUDIO_SCHEMA_VERSION, STORY_STUDIO_SCHEMA_VERSION]
                .includes(chapter.schemaVersion)) {
                throw new Error('unsupported chapter schema');
            }
            assertPlainObject(chapter, 'stored chapter');
            assertKnownKeys(
                chapter,
                chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION ? CHAPTER_RECORD_FIELDS : LEGACY_CHAPTER_RECORD_FIELDS,
                'stored chapter',
            );
            if (!Number.isSafeInteger(chapter.number) || chapter.number < 1 || chapter.number > this.maxProjectChapters) {
                throw new Error('invalid chapter number');
            }
            if (!Number.isSafeInteger(chapter.revision) || chapter.revision < 1) throw new Error('invalid chapter revision');
            if (typeof chapter.title !== 'string' || cleanText(chapter.title, 'title', 160) !== chapter.title) {
                throw new Error('invalid chapter title');
            }
            if (!CHAPTER_STATUSES.has(chapter.status)) throw new Error('invalid chapter status');
            const card = normalizeCard(chapter.card);
            const candidate = normalizeCandidate(chapter.candidate);
            if (typeof chapter.content !== 'string' || typeof chapter.review !== 'string' || typeof chapter.notes !== 'string') {
                throw new Error('missing chapter text field');
            }
            const content = cleanText(chapter.content, 'content', 5_000_000);
            if (cleanText(chapter.review, 'review', 1_000_000) !== chapter.review
                || cleanText(chapter.notes, 'notes', 1_000_000) !== chapter.notes) {
                throw new Error('invalid chapter text field');
            }
            const generationHistory = normalizeGenerationHistory(chapter.generationHistory);
            const planBasis = chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
                ? normalizePlanBasis(chapter.planBasis)
                : null;
            if (chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) assertId(chapter.volumeId, 'chapter.volumeId');
            if (stableJson(card) !== stableJson(chapter.card)
                || stableJson(candidate) !== stableJson(chapter.candidate)
                || stableJson(generationHistory) !== stableJson(chapter.generationHistory)
                || (planBasis && stableJson(planBasis) !== stableJson(chapter.planBasis))
                || chapter.wordCount !== countContentUnits(content)) {
                throw new Error('chapter derived fields are inconsistent');
            }
            for (const field of ['createdAt', 'updatedAt']) {
                if (typeof chapter[field] !== 'string' || chapter[field].length > 64
                    || !Number.isFinite(Date.parse(chapter[field]))) {
                    throw new Error(`invalid ${field}`);
                }
            }
            assertPayloadSize(chapter, MAX_CHAPTER_BYTES, 'Chapter');
        } catch (error) {
            throw new StoryStudioError('Chapter operations journal contains an invalid chapter.', 500, 'invalid_storage', {
                chapterId,
                cause: error.code || error.message,
            });
        }
    }

    validateProjectAndChapterWrite(projectId, project, chapter, baseProjectVersion, metadata) {
        this.validateStoredProject(project, projectId);
        this.validateChapterOperationRecord(projectId, chapter?.id, chapter);
        assertPlainObject(project, 'stored project');
        assertKnownKeys(project, IMPORT_PROJECT_FIELDS, 'stored project');
        const summaryFields = project.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
            ? CHAPTER_SUMMARY_FIELDS
            : LEGACY_CHAPTER_SUMMARY_FIELDS;
        for (const summary of project.chapters) {
            assertPlainObject(summary, 'chapter summary');
            assertKnownKeys(summary, summaryFields, 'chapter summary');
        }
        if (![STORY_STATE_STORY_STUDIO_SCHEMA_VERSION, VOLUME_STORY_STUDIO_SCHEMA_VERSION, STORY_STUDIO_SCHEMA_VERSION]
            .includes(project.schemaVersion)
            || chapter.schemaVersion !== project.schemaVersion || project.chapters.length === 0
            || project.version !== baseProjectVersion + 1 || !Number.isSafeInteger(baseProjectVersion)
            || !/^[0-9a-f]{64}$/.test(metadata?.baseProjectDigest)
            || !/^[0-9a-f]{64}$/.test(metadata?.baseProjectInvariantDigest)
            || projectInvariantDigest(project, CHAPTER_WRITE_MUTABLE_PROJECT_FIELDS)
                !== metadata.baseProjectInvariantDigest
            || !Array.isArray(metadata?.baseChapterIds)
            || !Number.isSafeInteger(metadata?.baseProjectChapterBytes) || metadata.baseProjectChapterBytes < 0
            || !Number.isSafeInteger(metadata?.baseChapterBytes) || metadata.baseChapterBytes < 0
            || !(metadata.baseChapterDigest === null || /^[0-9a-f]{64}$/.test(metadata.baseChapterDigest))
            || typeof project.updatedAt !== 'string' || project.updatedAt !== chapter.updatedAt
            || stableJson(project.resources) !== stableJson(normalizeProjectResources(project.resources))
            || (project.schemaVersion === STORY_STUDIO_SCHEMA_VERSION
                && stableJson(project.storyState) !== stableJson(normalizeStoryState(
                    project.storyState,
                    project.chapters.map(item => item.id),
                )))) {
            throw new StoryStudioError('Pending chapter write has an invalid schema.', 500, 'invalid_storage');
        }
        if (project.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
            assertVolumeChapterLayout(project.volumes, project.chapters, project.schemaVersion);
            const targetVolume = project.volumes.find(volume => volume.id === chapter.volumeId);
            const validBasePlanBasis = normalizePlanBasis(metadata.baseChapterPlanBasis);
            const targetPlanBasis = normalizePlanBasis(chapter.planBasis);
            if (!targetVolume || metadata.baseChapterDigest === null
                || assertId(metadata.baseChapterVolumeId, 'base chapter volume id') !== chapter.volumeId
                || stableJson(validBasePlanBasis) !== stableJson(metadata.baseChapterPlanBasis)
                || ![
                    stableJson(validBasePlanBasis),
                    stableJson({ volumeRevision: targetVolume.revision }),
                ].includes(stableJson(targetPlanBasis))) {
                throw new StoryStudioError('Pending chapter write has an invalid volume transition.', 500, 'invalid_storage');
            }
        }
        const baseChapterIds = metadata.baseChapterIds.map((id, index) => assertId(id, `baseChapterIds[${index}]`));
        const targetChapterIds = project.chapters.map(item => assertId(item.id, 'chapter summary id'));
        if (new Set(baseChapterIds).size !== baseChapterIds.length
            || new Set(targetChapterIds).size !== targetChapterIds.length) {
            throw new StoryStudioError('Pending chapter write has inconsistent chapter sets.', 500, 'invalid_storage');
        }
        const baseContainsChapter = baseChapterIds.includes(chapter.id);
        const existingChapterMetadataIsValid = metadata.baseChapterDigest !== null
            && Number.isSafeInteger(metadata.baseChapterRevision) && metadata.baseChapterRevision >= 1
            && Number.isSafeInteger(metadata.baseChapterNumber) && metadata.baseChapterNumber >= 1
            && typeof metadata.baseChapterCreatedAt === 'string'
            && Number.isFinite(Date.parse(metadata.baseChapterCreatedAt));
        const newChapterMetadataIsValid = metadata.baseChapterDigest === null
            && metadata.baseChapterBytes === 0
            && metadata.baseChapterRevision === null
            && metadata.baseChapterNumber === null
            && metadata.baseChapterCreatedAt === null;
        const expectedTargetIds = baseContainsChapter
            ? baseChapterIds
            : [...baseChapterIds, chapter.id];
        if (stableJson(targetChapterIds) !== stableJson(expectedTargetIds)
            || (baseContainsChapter ? !existingChapterMetadataIsValid : !newChapterMetadataIsValid)
            || (baseContainsChapter && metadata.baseChapterNumber !== baseChapterIds.indexOf(chapter.id) + 1)
            || (!baseContainsChapter && metadata.baseChapterDigest !== null)) {
            throw new StoryStudioError('Pending chapter write does not match its base chapter.', 500, 'invalid_storage');
        }
        const validRevisionTransition = baseContainsChapter
            ? chapter.revision === metadata.baseChapterRevision + 1
                && chapter.number === metadata.baseChapterNumber
                && chapter.createdAt === metadata.baseChapterCreatedAt
            : chapter.revision === 1
                && chapter.number === baseChapterIds.length + 1
                && chapter.createdAt === chapter.updatedAt;
        if (!validRevisionTransition
            || project.chapters.some((item, index) => item.number !== index + 1)) {
            throw new StoryStudioError('Pending chapter write has an invalid chapter transition.', 500, 'invalid_storage');
        }
        const summary = project.chapters.find(item => item.id === chapter.id);
        if (!summary || stableJson(summary) !== stableJson(chapterSummary(chapter))) {
            throw new StoryStudioError('Pending chapter write is inconsistent with the project index.', 500, 'invalid_storage');
        }
        const expectedChapterBytes = metadata.baseProjectChapterBytes
            - metadata.baseChapterBytes
            + serializedByteLength(chapter);
        if (project.chapterBytes !== expectedChapterBytes) {
            throw new StoryStudioError('Pending chapter write byte metadata is inconsistent.', 500, 'invalid_storage', {
                declared: project.chapterBytes,
                expected: expectedChapterBytes,
            });
        }
        this.assertProjectChapterCount(project.chapters.length);
        this.assertProjectChapterBytes(project.chapterBytes);
        assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
        this.assertStoredProjectLimitsUnlocked(projectId, project);
    }

    chapterProjectTransitionMatches(baseProject, targetProject, targetChapter, baseChapter) {
        const expected = structuredClone(baseProject);
        if (baseChapter) {
            const chapterIndex = expected.chapters.findIndex(item => item.id === baseChapter.id);
            if (chapterIndex === -1 || targetChapter.id !== baseChapter.id) return false;
            const baseSummary = expected.chapters[chapterIndex];
            if (targetProject.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
                const volume = targetProject.volumes.find(item => item.id === baseSummary.volumeId);
                const allowedPlanBasis = [
                    stableJson(baseSummary.planBasis),
                    stableJson({ volumeRevision: volume?.revision }),
                ];
                if (!volume || targetChapter.volumeId !== baseSummary.volumeId
                    || !allowedPlanBasis.includes(stableJson(targetChapter.planBasis))) return false;
            }
            expected.chapters[chapterIndex] = chapterSummary(targetChapter);
        } else {
            expected.chapters.push(chapterSummary(targetChapter));
        }
        expected.storyState = structuredClone(targetProject.storyState);
        expected.chapterBytes = targetProject.chapterBytes;
        expected.version = targetProject.version;
        expected.updatedAt = targetProject.updatedAt;
        return stableJson(expected) === stableJson(targetProject);
    }

    inspectPendingChapterStateUnlocked(projectId, chapter, metadata) {
        const chapterPath = this.chapterPath(projectId, chapter.id);
        if (!fs.existsSync(chapterPath)) {
            return {
                matchesBase: metadata.baseChapterDigest === null,
                matchesTarget: false,
                exists: false,
                chapter: null,
                bytes: 0,
            };
        }
        try {
            const currentChapter = readJson(chapterPath, 'Chapter not found.');
            this.validateChapterOperationRecord(projectId, chapter.id, currentChapter);
            const digest = sha256(currentChapter);
            const bytes = serializedByteLength(currentChapter);
            const matchesBase = metadata.baseChapterDigest !== null
                && digest === metadata.baseChapterDigest
                && bytes === metadata.baseChapterBytes
                && currentChapter.revision === metadata.baseChapterRevision
                && currentChapter.number === metadata.baseChapterNumber
                && currentChapter.createdAt === metadata.baseChapterCreatedAt;
            return {
                matchesBase,
                matchesTarget: digest === sha256(chapter) && bytes === serializedByteLength(chapter),
                exists: true,
                chapter: currentChapter,
                bytes,
            };
        } catch {
            return { matchesBase: false, matchesTarget: false, exists: true, chapter: null, bytes: null };
        }
    }

    calculatePendingBaseChapterBytesUnlocked(projectId, baseProject, chapterId) {
        try {
            let unchangedBytes = 0;
            for (const summary of baseProject.chapters) {
                if (summary.id === chapterId) continue;
                const storedChapter = readJson(this.chapterPath(projectId, summary.id), 'Chapter not found.');
                this.validateChapterOperationRecord(projectId, summary.id, storedChapter);
                if (stableJson(chapterSummary(storedChapter)) !== stableJson(summary)) return null;
                unchangedBytes += serializedByteLength(storedChapter);
                this.assertProjectChapterBytes(unchangedBytes);
            }
            const touchedBytes = baseProject.chapterBytes - unchangedBytes;
            return Number.isSafeInteger(touchedBytes) && touchedBytes >= 0 ? touchedBytes : null;
        } catch {
            return null;
        }
    }

    captureChapterOperationBaselinesUnlocked(projectId, baseProject, operations) {
        if (!Array.isArray(operations) || operations.length < baseProject.chapters.length
            || operations.length > baseProject.chapters.length + 1) {
            throw new StoryStudioError('Chapter operations do not cover the complete base index.', 500, 'invalid_storage');
        }
        const operationIds = new Set();
        for (const item of operations) {
            assertPlainObject(item, 'chapter operation');
            const chapterId = assertId(item.chapterId, 'chapter id');
            if (operationIds.has(chapterId)) {
                throw new StoryStudioError('Chapter operations contain duplicate ids.', 500, 'invalid_storage');
            }
            operationIds.add(chapterId);
        }
        const baseChapterIds = baseProject.chapters.map(summary => summary.id);
        if (baseChapterIds.some(chapterId => !operationIds.has(chapterId))) {
            throw new StoryStudioError('Chapter operations omit a base chapter.', 500, 'invalid_storage');
        }
        let chapterBytes = 0;
        const baseChapters = baseProject.chapters.map((summary, index) => {
            const chapter = readJson(this.chapterPath(projectId, summary.id), 'Chapter not found.');
            this.validateChapterOperationRecord(projectId, summary.id, chapter);
            if (summary.number !== index + 1
                || stableJson(chapterSummary(chapter)) !== stableJson(summary)) {
                throw new StoryStudioError('Base chapter files do not match the project index.', 500, 'invalid_storage', {
                    chapterId: summary.id,
                });
            }
            const bytes = serializedByteLength(chapter);
            chapterBytes += bytes;
            this.assertProjectChapterBytes(chapterBytes);
            return {
                chapterId: chapter.id,
                exists: true,
                digest: sha256(chapter),
                bytes,
                revision: chapter.revision,
                number: chapter.number,
                volumeId: chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION ? chapter.volumeId : null,
                planBasis: chapter.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION
                    ? normalizePlanBasis(chapter.planBasis)
                    : null,
                createdAt: chapter.createdAt,
                updatedAt: chapter.updatedAt,
            };
        });
        if (chapterBytes !== baseProject.chapterBytes) {
            throw new StoryStudioError('Base project chapter byte metadata is inconsistent.', 500, 'invalid_storage');
        }
        for (const chapterId of operationIds) {
            if (baseChapterIds.includes(chapterId)) continue;
            baseChapters.push({
                chapterId,
                exists: false,
                digest: null,
                bytes: 0,
                revision: null,
                number: null,
                volumeId: null,
                planBasis: null,
                createdAt: null,
                updatedAt: null,
            });
        }
        return baseChapters;
    }

    validateChapterOperations(projectId, project, operations, baseProjectDigest, baseChapterIdsValue, metadata = {}) {
        this.validateStoredProject(project, projectId);
        assertPlainObject(project, 'stored project');
        assertKnownKeys(project, IMPORT_PROJECT_FIELDS, 'stored project');
        const isVolumeSchema = project.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION;
        const summaryFields = isVolumeSchema ? CHAPTER_SUMMARY_FIELDS : LEGACY_CHAPTER_SUMMARY_FIELDS;
        for (const summary of project.chapters) {
            assertPlainObject(summary, 'chapter summary');
            assertKnownKeys(summary, summaryFields, 'chapter summary');
        }
        if (![STORY_STATE_STORY_STUDIO_SCHEMA_VERSION, VOLUME_STORY_STUDIO_SCHEMA_VERSION, STORY_STUDIO_SCHEMA_VERSION]
            .includes(project.schemaVersion)
            || !Array.isArray(operations)
            || !/^[0-9a-f]{64}$/.test(baseProjectDigest) || !Array.isArray(baseChapterIdsValue)
            || !Array.isArray(metadata.baseChapters) || metadata.baseChapters.length !== operations.length
            || !Number.isSafeInteger(metadata.baseProjectVersion)
            || project.version !== metadata.baseProjectVersion + 1
            || !/^[0-9a-f]{64}$/.test(metadata.baseProjectInvariantDigest)
            || projectInvariantDigest(project, CHAPTER_OPERATIONS_MUTABLE_PROJECT_FIELDS)
                !== metadata.baseProjectInvariantDigest
            || !Number.isSafeInteger(metadata.baseProjectChapterBytes) || metadata.baseProjectChapterBytes < 0
            || typeof project.updatedAt !== 'string' || !Number.isFinite(Date.parse(project.updatedAt))
            || stableJson(project.resources) !== stableJson(normalizeProjectResources(project.resources))
            || (project.schemaVersion === STORY_STUDIO_SCHEMA_VERSION
                && stableJson(project.storyState) !== stableJson(normalizeStoryState(
                    project.storyState,
                    project.chapters.map(item => item.id),
                )))) {
            throw new StoryStudioError('Chapter operations journal has an invalid schema.', 500, 'invalid_storage');
        }
        assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
        const targetIds = project.chapters.map(summary => assertId(summary.id, 'chapter summary id'));
        const baseChapterIds = baseChapterIdsValue.map((chapterId, index) => assertId(chapterId, `baseChapterIds[${index}]`));
        const baseIdSet = new Set(baseChapterIds);
        const targetIdSet = new Set(targetIds);
        const introducedIds = targetIds.filter(chapterId => !baseIdSet.has(chapterId));
        const deletedIds = baseChapterIds.filter(chapterId => !targetIdSet.has(chapterId));
        if (targetIds.length === 0 || targetIds.length > this.maxProjectChapters
            || new Set(targetIds).size !== targetIds.length
            || baseChapterIds.length === 0 || new Set(baseChapterIds).size !== baseChapterIds.length
            || introducedIds.length > 1 || deletedIds.length > 1
            || (introducedIds.length > 0 && deletedIds.length > 0)
            || operations.length !== baseChapterIds.length + introducedIds.length
            || targetIds.length !== baseChapterIds.length + introducedIds.length - deletedIds.length) {
            throw new StoryStudioError('Chapter operations journal contains an invalid chapter set.', 500, 'invalid_storage');
        }

        const baseChaptersById = new Map();
        let baseChapterBytes = 0;
        for (const [index, baseline] of metadata.baseChapters.entries()) {
            assertPlainObject(baseline, 'base chapter');
            assertKnownKeys(baseline, isVolumeSchema
                ? [
                    'chapterId', 'exists', 'digest', 'bytes', 'revision', 'number', 'volumeId', 'planBasis',
                    'createdAt', 'updatedAt',
                ]
                : ['chapterId', 'exists', 'digest', 'bytes', 'revision', 'number', 'createdAt', 'updatedAt'], 'base chapter');
            const chapterId = assertId(baseline.chapterId, 'base chapter id');
            const expectedExistingId = baseChapterIds[index];
            const existing = index < baseChapterIds.length;
            const validExisting = existing && baseline.exists === true
                && chapterId === expectedExistingId
                && SHA256_HEX.test(baseline.digest)
                && Number.isSafeInteger(baseline.bytes) && baseline.bytes > 0
                && Number.isSafeInteger(baseline.revision) && baseline.revision >= 1
                && baseline.number === index + 1
                && (!isVolumeSchema || (
                    project.volumes.some(volume => volume.id === baseline.volumeId)
                    && stableJson(normalizePlanBasis(baseline.planBasis)) === stableJson(baseline.planBasis)
                ))
                && typeof baseline.createdAt === 'string' && Number.isFinite(Date.parse(baseline.createdAt))
                && typeof baseline.updatedAt === 'string' && Number.isFinite(Date.parse(baseline.updatedAt));
            const validMissing = !existing && introducedIds.length === 1 && chapterId === introducedIds[0]
                && baseline.exists === false && baseline.digest === null && baseline.bytes === 0
                && baseline.revision === null && baseline.number === null
                && (!isVolumeSchema || baseline.volumeId === null && baseline.planBasis === null)
                && baseline.createdAt === null && baseline.updatedAt === null;
            if (baseChaptersById.has(chapterId) || (!validExisting && !validMissing)) {
                throw new StoryStudioError('Chapter operations journal has invalid chapter baselines.', 500, 'invalid_storage');
            }
            if (validExisting) {
                baseChapterBytes += baseline.bytes;
                this.assertProjectChapterBytes(baseChapterBytes);
            }
            baseChaptersById.set(chapterId, baseline);
        }
        if (baseChaptersById.size !== operations.length
            || baseChapterBytes !== metadata.baseProjectChapterBytes) {
            throw new StoryStudioError('Chapter operation baselines do not match the base project.', 500, 'invalid_storage');
        }

        const operationsById = new Map();
        let chapterBytes = 0;
        for (const item of operations) {
            assertPlainObject(item, 'chapter operation');
            assertKnownKeys(item, ['operation', 'chapterId', 'chapter'], 'chapter operation');
            const chapterId = assertId(item.chapterId, 'chapter id');
            const baseline = baseChaptersById.get(chapterId);
            if (!baseline || operationsById.has(chapterId)) {
                throw new StoryStudioError('Chapter operations journal contains duplicate or unknown operations.', 500, 'invalid_storage');
            }
            if (item.operation === 'write') {
                this.validateChapterOperationRecord(projectId, chapterId, item.chapter);
                if (item.chapter.schemaVersion !== project.schemaVersion) {
                    throw new StoryStudioError('Chapter operation schema does not match its project.', 500, 'invalid_storage', {
                        chapterId,
                        projectSchemaVersion: project.schemaVersion,
                        chapterSchemaVersion: item.chapter.schemaVersion,
                    });
                }
                if (baseline.exists === false) {
                    if (!isVolumeSchema) {
                        throw new StoryStudioError('Legacy chapter operation cannot create chapters.', 500, 'invalid_storage');
                    }
                    const targetVolume = project.volumes.find(volume => volume.id === item.chapter.volumeId);
                    if (!targetVolume || !targetIds.includes(chapterId) || item.chapter.revision !== 1
                        || item.chapter.createdAt !== project.updatedAt || item.chapter.updatedAt !== project.updatedAt
                        || item.chapter.planBasis.volumeRevision !== targetVolume.revision) {
                        throw new StoryStudioError('Created chapter operation has an invalid initial state.', 500, 'invalid_storage', {
                            chapterId,
                        });
                    }
                    chapterBytes += serializedByteLength(item.chapter);
                    this.assertProjectChapterBytes(chapterBytes);
                    operationsById.set(chapterId, item);
                    continue;
                }
                const numberChanged = item.chapter.number !== baseline.number;
                const volumeChanged = item.chapter.volumeId !== baseline.volumeId;
                const planBasisChanged = stableJson(item.chapter.planBasis) !== stableJson(baseline.planBasis);
                if (isVolumeSchema && (volumeChanged
                    ? stableJson(item.chapter.planBasis) !== stableJson({ volumeRevision: 0 })
                    : planBasisChanged)) {
                    throw new StoryStudioError('Chapter operation has an invalid plan basis transition.', 500, 'invalid_storage', {
                        chapterId,
                    });
                }
                const reconstructedBase = structuredClone(item.chapter);
                reconstructedBase.number = baseline.number;
                if (isVolumeSchema) {
                    reconstructedBase.volumeId = baseline.volumeId;
                    reconstructedBase.planBasis = structuredClone(baseline.planBasis);
                }
                reconstructedBase.revision = baseline.revision;
                reconstructedBase.updatedAt = baseline.updatedAt;
                const structureChanged = numberChanged || (isVolumeSchema && (volumeChanged || planBasisChanged));
                const transitionIsValid = structureChanged
                    ? item.chapter.revision === baseline.revision + 1
                        && item.chapter.createdAt === baseline.createdAt
                        && item.chapter.updatedAt === project.updatedAt
                        && sha256(reconstructedBase) === baseline.digest
                    : item.chapter.revision === baseline.revision
                        && sha256(item.chapter) === baseline.digest;
                if (!transitionIsValid) {
                    throw new StoryStudioError('Chapter operation has an invalid revision transition.', 500, 'invalid_storage', {
                        chapterId,
                    });
                }
                chapterBytes += serializedByteLength(item.chapter);
                this.assertProjectChapterBytes(chapterBytes);
            } else if (baseline.exists === false || item.operation !== 'delete' || item.chapter !== null) {
                throw new StoryStudioError('Chapter operations journal contains an invalid operation.', 500, 'invalid_storage');
            }
            operationsById.set(chapterId, item);
        }
        for (const [index, summary] of project.chapters.entries()) {
            const operation = operationsById.get(summary.id);
            if (summary.number !== index + 1 || operation?.operation !== 'write'
                || stableJson(chapterSummary(operation.chapter)) !== stableJson(summary)) {
                throw new StoryStudioError('Chapter operations journal is inconsistent with the project index.', 500, 'invalid_storage');
            }
        }
        const expectedDeletedIds = baseChapterIds.filter(chapterId => !targetIds.includes(chapterId)).sort();
        const actualDeletedIds = [...operationsById]
            .filter(([, operation]) => operation.operation === 'delete')
            .map(([chapterId]) => chapterId)
            .sort();
        if (stableJson(expectedDeletedIds) !== stableJson(actualDeletedIds)
            || [...operationsById].some(([chapterId, operation]) => (
                operation.operation === 'delete' ? targetIds.includes(chapterId) : !targetIds.includes(chapterId)
            ))) {
            throw new StoryStudioError('Chapter operations journal does not match its base and target chapter sets.', 500, 'invalid_storage');
        }
        if (project.chapterBytes !== chapterBytes) {
            throw new StoryStudioError('Chapter operations journal byte metadata is inconsistent.', 500, 'invalid_storage', {
                declared: project.chapterBytes,
                actual: chapterBytes,
            });
        }
        this.assertStoredProjectLimitsUnlocked(projectId, project);
        return { baseChapterIds, baseChaptersById, operationsById };
    }

    inspectChapterOperationsReplayStateUnlocked(projectId, operationsById, baseChaptersById) {
        let allBase = true;
        let allTarget = true;
        let divergent = false;
        for (const [chapterId, operation] of operationsById) {
            const baseline = baseChaptersById.get(chapterId);
            const chapterPath = this.chapterPath(projectId, chapterId);
            const exists = fs.existsSync(chapterPath);
            let digest = null;
            let bytes = 0;
            let readable = !exists;
            if (exists) {
                try {
                    const chapter = readJson(chapterPath, 'Chapter not found.');
                    this.validateChapterOperationRecord(projectId, chapterId, chapter);
                    digest = sha256(chapter);
                    bytes = serializedByteLength(chapter);
                    readable = true;
                } catch {
                    readable = false;
                }
            }
            const baseMatches = readable && (baseline.exists
                ? exists && digest === baseline.digest && bytes === baseline.bytes
                : !exists);
            const targetMatches = readable && (operation.operation === 'write'
                ? exists && digest === sha256(operation.chapter)
                    && bytes === serializedByteLength(operation.chapter)
                : !exists);
            allBase &&= baseMatches;
            allTarget &&= targetMatches;
            divergent ||= !baseMatches && !targetMatches;
        }
        return { allBase, allTarget, divergent };
    }

    chapterOperationsProjectTransitionMatches(baseProject, targetProject, operationsById) {
        try {
            const targetChapters = targetProject.chapters.map(summary => {
                const operation = operationsById.get(summary.id);
                if (operation?.operation !== 'write') throw new Error('missing target chapter');
                return operation.chapter;
            });
            const deletedIds = baseProject.chapters
                .map(summary => summary.id)
                .filter(chapterId => !targetProject.chapters.some(summary => summary.id === chapterId));
            if (deletedIds.length > 1) return false;
            const expected = structuredClone(baseProject);
            expected.continuity = remapContinuityChapterNumbers(
                baseProject.continuity,
                baseProject.chapters,
                targetChapters,
            );
            expected.storyState = deletedIds.length === 1
                ? detachChapterStoryStateReferences(
                    baseProject.storyState,
                    deletedIds[0],
                    targetChapters.map(chapter => chapter.id),
                )
                : structuredClone(baseProject.storyState);
            if (targetProject.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION) {
                const baseVolumesById = new Map(baseProject.volumes.map(volume => [volume.id, volume]));
                if (baseVolumesById.size !== baseProject.volumes.length
                    || targetProject.volumes.length !== baseProject.volumes.length) return false;
                expected.volumes = targetProject.volumes.map((volume, index) => {
                    const baseVolume = baseVolumesById.get(volume.id);
                    if (!baseVolume) throw new Error('unknown target volume');
                    return baseVolume.number === index + 1 ? structuredClone(baseVolume) : {
                        ...structuredClone(baseVolume),
                        number: index + 1,
                        updatedAt: targetProject.updatedAt,
                    };
                });
            }
            expected.chapters = structuredClone(targetProject.chapters);
            expected.chapterBytes = targetProject.chapterBytes;
            expected.version = targetProject.version;
            expected.updatedAt = targetProject.updatedAt;
            return stableJson(expected) === stableJson(targetProject);
        } catch {
            return false;
        }
    }

    applyChapterOperations(projectId, operations, lock) {
        for (const item of operations) {
            this.assertProjectLockOwnership(lock);
            if (item.operation === 'write') {
                writeJson(this.chapterPath(projectId, item.chapterId), item.chapter);
            } else {
                fs.rmSync(this.chapterPath(projectId, item.chapterId), { force: true });
            }
        }
    }

    chapterFilesMatchProjectIndexUnlocked(projectId, project) {
        try {
            let chapterBytes = 0;
            for (const summary of project.chapters) {
                const chapter = readJson(this.chapterPath(projectId, summary.id), 'Chapter not found.');
                this.validateChapterOperationRecord(projectId, summary.id, chapter);
                if (chapter.schemaVersion !== project.schemaVersion
                    || stableJson(chapterSummary(chapter)) !== stableJson(summary)) return false;
                chapterBytes += serializedByteLength(chapter);
                this.assertProjectChapterBytes(chapterBytes);
            }
            return project.chapters.length > 0 && chapterBytes === project.chapterBytes;
        } catch {
            return false;
        }
    }

    legacyChapterFilesMatchProjectIndexUnlocked(projectId, project) {
        try {
            if (![LEGACY_STORY_STUDIO_SCHEMA_VERSION, RESOURCE_STORY_STUDIO_SCHEMA_VERSION,
                STORY_STATE_STORY_STUDIO_SCHEMA_VERSION].includes(project.schemaVersion)) return false;
            let chapterBytes = 0;
            for (const [index, summary] of project.chapters.entries()) {
                assertPlainObject(summary, `chapters[${index}]`);
                assertKnownKeys(summary, LEGACY_CHAPTER_SUMMARY_FIELDS, `chapters[${index}]`);
                const chapter = readJson(this.chapterPath(projectId, summary.id), 'Chapter not found.');
                this.validateStoredChapter(chapter, projectId, summary.id);
                assertPlainObject(chapter, `chapter ${summary.id}`);
                assertKnownKeys(chapter, LEGACY_CHAPTER_RECORD_FIELDS, `chapter ${summary.id}`);
                if (chapter.schemaVersion !== project.schemaVersion || summary.number !== index + 1
                    || (chapter.schemaVersion < STORY_STATE_STORY_STUDIO_SCHEMA_VERSION
                        && Object.hasOwn(chapter, 'generationHistory'))
                    || stableJson(normalizeCard(chapter.card)) !== stableJson(chapter.card)
                    || stableJson(normalizeCandidate(chapter.candidate)) !== stableJson(chapter.candidate)
                    || chapter.wordCount !== countContentUnits(chapter.content)
                    || stableJson(chapterSummary(chapter)) !== stableJson(summary)) return false;
                chapterBytes += serializedByteLength(chapter);
                this.assertProjectChapterBytes(chapterBytes);
            }
            return project.chapters.length > 0
                && (project.chapterBytes === undefined || project.chapterBytes === chapterBytes);
        } catch {
            return false;
        }
    }

    commitProjectAndChapterOperations(project, operations, lock, baseProject) {
        const baseProjectVersion = baseProject.version;
        const baseProjectDigest = sha256(baseProject);
        const baseProjectInvariantDigest = projectInvariantDigest(
            baseProject,
            CHAPTER_OPERATIONS_MUTABLE_PROJECT_FIELDS,
        );
        const baseChapterIds = baseProject.chapters.map(chapter => chapter.id);
        const baseProjectChapterBytes = baseProject.chapterBytes;
        const baseChapters = this.captureChapterOperationBaselinesUnlocked(project.id, baseProject, operations);
        const validation = this.validateChapterOperations(
            project.id,
            project,
            operations,
            baseProjectDigest,
            baseChapterIds,
            { baseProjectVersion, baseProjectInvariantDigest, baseProjectChapterBytes, baseChapters },
        );
        if (!this.chapterOperationsProjectTransitionMatches(baseProject, project, validation.operationsById)) {
            throw new StoryStudioError('Chapter operations change unrelated project fields.', 500, 'invalid_storage');
        }
        const journalPath = this.chapterOperationsJournalPath(project.id);
        this.assertProjectLockOwnership(lock);
        writeJson(journalPath, {
            transactionId: randomUUID(),
            baseProjectVersion,
            baseProjectDigest,
            baseProjectInvariantDigest,
            baseChapterIds,
            baseProjectChapterBytes,
            baseChapters,
            project,
            operations,
        });
        let completed = false;
        try {
            this.applyChapterOperations(project.id, operations, lock);
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(project.id), project);
            completed = true;
        } finally {
            if (completed) fs.rmSync(journalPath, { force: true });
        }
    }

    captureResourceBaselinesUnlocked(projectId, operations, baseResourceReferencesValue) {
        if (!Array.isArray(operations) || operations.length === 0
            || operations.length > MAX_RESOURCE_JOURNAL_OPERATIONS) {
            throw new StoryStudioError('Resource journal contains an invalid operation set.', 500, 'invalid_storage');
        }
        const baseResourceReferences = normalizePrimaryResourceReferences(baseResourceReferencesValue);
        const seen = new Set();
        const baselines = [];
        for (const item of operations) {
            assertPlainObject(item, 'resource operation');
            assertKnownKeys(item, ['operation', 'type', 'resourceId', 'resource'], 'resource operation');
            const type = normalizeResourceType(item.type);
            const resourceId = assertId(item.resourceId, 'resource id');
            const key = resourceOperationKey(type, resourceId);
            if (item.type !== type || seen.has(key)) {
                throw new StoryStudioError('Resource journal contains duplicate or non-canonical operations.', 500, 'invalid_storage');
            }
            seen.add(key);
            const resourcePath = this.resourcePath(projectId, type, resourceId);
            const exists = fs.existsSync(resourcePath);
            const expectedExists = baseResourceReferences[RESOURCE_REFERENCE_BY_TYPE[type]].includes(resourceId);
            if (exists !== expectedExists) {
                throw new StoryStudioError('Resource files do not match the transaction base index.', 500, 'invalid_storage', {
                    type,
                    resourceId,
                });
            }
            let digest = null;
            let bytes = 0;
            let revision = null;
            let createdAt = null;
            if (exists) {
                const resource = this.readResourceUnlocked(projectId, type, resourceId);
                digest = sha256(resource);
                bytes = serializedByteLength(resource);
                revision = resource.revision;
                createdAt = resource.createdAt;
            }
            baselines.push({ type, resourceId, exists, digest, bytes, revision, createdAt });
        }
        return baselines;
    }

    validateResourceOperations(projectId, project, operations, baseProjectVersionValue, metadata) {
        try {
            this.validateStoredProject(project, projectId);
            const baseProjectVersion = baseProjectVersionValue;
            const normalizedResources = normalizeProjectResources(project.resources);
            if (![STORY_STATE_STORY_STUDIO_SCHEMA_VERSION, VOLUME_STORY_STUDIO_SCHEMA_VERSION, STORY_STUDIO_SCHEMA_VERSION]
                .includes(project.schemaVersion)
                || !Number.isSafeInteger(baseProjectVersion)
                || project.version !== baseProjectVersion + 1
                || stableJson(project.resources) !== stableJson(normalizedResources)
                || typeof project.updatedAt !== 'string' || !Number.isFinite(Date.parse(project.updatedAt))
                || !SHA256_HEX.test(metadata?.baseProjectDigest)
                || !SHA256_HEX.test(metadata?.baseProjectInvariantDigest)
                || projectInvariantDigest(project, RESOURCE_WRITE_MUTABLE_PROJECT_FIELDS)
                    !== metadata.baseProjectInvariantDigest
                || !Array.isArray(operations) || operations.length === 0
                || operations.length > MAX_RESOURCE_JOURNAL_OPERATIONS
                || !Array.isArray(metadata?.baseResources)) {
                throw new StoryStudioError('Pending resource write journal has an invalid schema.', 500, 'invalid_storage');
            }
            const baseResourceReferences = normalizePrimaryResourceReferences(metadata.baseResourceReferences);
            const operationsByKey = new Map();
            for (const item of operations) {
                assertPlainObject(item, 'resource operation');
                assertKnownKeys(item, ['operation', 'type', 'resourceId', 'resource'], 'resource operation');
                const type = normalizeResourceType(item.type);
                const resourceId = assertId(item.resourceId, 'resource id');
                const key = resourceOperationKey(type, resourceId);
                if (item.type !== type || operationsByKey.has(key)) {
                    throw new StoryStudioError('Pending resource write journal contains duplicate or non-canonical operations.', 500, 'invalid_storage');
                }
                if (item.operation === 'write') {
                    validateResourceRecord(item.resource, projectId, resourceId, type);
                } else if (item.operation === 'delete') {
                    if (item.resource !== null) {
                        throw new StoryStudioError('Deleted resources must use a null journal payload.', 500, 'invalid_storage');
                    }
                } else {
                    throw new StoryStudioError('Pending resource write journal has an invalid operation.', 500, 'invalid_storage');
                }
                operationsByKey.set(key, { ...item, type, resourceId });
            }

            const baseResourcesByKey = new Map();
            for (const baseline of metadata.baseResources) {
                assertPlainObject(baseline, 'base resource');
                assertKnownKeys(
                    baseline,
                    ['type', 'resourceId', 'exists', 'digest', 'bytes', 'revision', 'createdAt'],
                    'base resource',
                );
                const type = normalizeResourceType(baseline.type);
                const resourceId = assertId(baseline.resourceId, 'base resource id');
                const key = resourceOperationKey(type, resourceId);
                const validExisting = baseline.exists === true && SHA256_HEX.test(baseline.digest)
                    && Number.isSafeInteger(baseline.bytes) && baseline.bytes > 0
                    && Number.isSafeInteger(baseline.revision) && baseline.revision >= 1
                    && typeof baseline.createdAt === 'string' && Number.isFinite(Date.parse(baseline.createdAt));
                const validMissing = baseline.exists === false && baseline.digest === null && baseline.bytes === 0
                    && baseline.revision === null && baseline.createdAt === null;
                if (baseline.type !== type || baseResourcesByKey.has(key) || (!validExisting && !validMissing)) {
                    throw new StoryStudioError('Pending resource write journal has invalid resource baselines.', 500, 'invalid_storage');
                }
                baseResourcesByKey.set(key, { ...baseline, type, resourceId });
            }
            if (baseResourcesByKey.size !== operationsByKey.size
                || [...operationsByKey.keys()].some(key => !baseResourcesByKey.has(key))) {
                throw new StoryStudioError('Resource journal operations do not match their baselines.', 500, 'invalid_storage');
            }

            for (const [key, operation] of operationsByKey) {
                const baseline = baseResourcesByKey.get(key);
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[operation.type];
                const existedInBase = baseResourceReferences[referenceField].includes(operation.resourceId);
                const existsInTarget = normalizedResources[referenceField].includes(operation.resourceId);
                if (baseline.exists !== existedInBase
                    || (operation.operation === 'write' && !existsInTarget)
                    || (operation.operation === 'delete' && (!existedInBase || existsInTarget))) {
                    throw new StoryStudioError('Resource journal operations are inconsistent with the project indexes.', 500, 'invalid_storage', {
                        type: operation.type,
                        resourceId: operation.resourceId,
                    });
                }
                if (operation.operation === 'write') {
                    const resource = operation.resource;
                    const validTransition = baseline.exists
                        ? resource.revision === baseline.revision + 1
                            && resource.createdAt === baseline.createdAt
                            && resource.updatedAt === project.updatedAt
                        : resource.revision === 1
                            && resource.createdAt === project.updatedAt
                            && resource.updatedAt === project.updatedAt;
                    if (!validTransition) {
                        throw new StoryStudioError('Resource journal has an invalid resource transition.', 500, 'invalid_storage', {
                            type: operation.type,
                            resourceId: operation.resourceId,
                        });
                    }
                }
            }
            for (const type of RESOURCE_TYPES) {
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
                const baseIds = baseResourceReferences[referenceField];
                const targetIds = normalizedResources[referenceField];
                for (const resourceId of targetIds.filter(id => !baseIds.includes(id))) {
                    const operation = operationsByKey.get(resourceOperationKey(type, resourceId));
                    if (operation?.operation !== 'write') {
                        throw new StoryStudioError('Resource journal is missing an indexed resource write.', 500, 'invalid_storage');
                    }
                }
                for (const resourceId of baseIds.filter(id => !targetIds.includes(id))) {
                    const operation = operationsByKey.get(resourceOperationKey(type, resourceId));
                    if (operation?.operation !== 'delete') {
                        throw new StoryStudioError('Resource journal is missing an indexed resource deletion.', 500, 'invalid_storage');
                    }
                }
            }
            this.assertProjectChapterCount(project.chapters.length);
            this.assertProjectChapterBytes(project.chapterBytes);
            assertPayloadSize(project, MAX_PROJECT_BYTES, 'Project');
            return { baseProjectVersion, baseResourceReferences, operationsByKey, baseResourcesByKey };
        } catch (error) {
            if (error instanceof StoryStudioError && error.code === 'invalid_storage') throw error;
            throw new StoryStudioError('Pending resource write journal is invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    validateTargetResourceProjectionUnlocked(projectId, project, operationsByKey) {
        const resources = normalizeProjectResources(project.resources);
        const records = new Map();
        let resourceBytes = 0;
        let resourceCount = 0;
        try {
            for (const type of RESOURCE_TYPES) {
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
                for (const resourceId of resources[referenceField]) {
                    const operation = operationsByKey.get(resourceOperationKey(type, resourceId));
                    const resource = operation?.operation === 'write'
                        ? validateResourceRecord(operation.resource, projectId, resourceId, type)
                        : this.readResourceUnlocked(projectId, type, resourceId);
                    records.set(resourceOperationKey(type, resourceId), resource);
                    resourceBytes += serializedByteLength(resource);
                    resourceCount += 1;
                    if (resourceBytes > this.maxProjectBytes) {
                        throw new Error('resource byte limit exceeded');
                    }
                }
            }
            const lorebookIds = new Set(resources.lorebookIds);
            for (const characterId of resources.characterIds) {
                const character = records.get(resourceOperationKey('character', characterId));
                if (character.embeddedLorebookId !== null && !lorebookIds.has(character.embeddedLorebookId)) {
                    throw new Error('character references a missing lorebook');
                }
            }
            this.assertProjectResourceLimits(project, resourceBytes, resourceCount);
        } catch (error) {
            throw new StoryStudioError('Pending resource write journal has an invalid target resource set.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
    }

    inspectResourceReplayStateUnlocked(projectId, operationsByKey, baseResourcesByKey) {
        let allBase = true;
        let allTarget = true;
        let divergent = false;
        for (const [key, operation] of operationsByKey) {
            const baseline = baseResourcesByKey.get(key);
            const resourcePath = this.resourcePath(projectId, operation.type, operation.resourceId);
            const exists = fs.existsSync(resourcePath);
            let digest = null;
            let bytes = 0;
            let readable = !exists;
            let revision = null;
            let createdAt = null;
            if (exists) {
                try {
                    const resource = this.readResourceUnlocked(projectId, operation.type, operation.resourceId);
                    digest = sha256(resource);
                    bytes = serializedByteLength(resource);
                    revision = resource.revision;
                    createdAt = resource.createdAt;
                    readable = true;
                } catch {
                    readable = false;
                }
            }
            const baseMatches = readable && (baseline.exists
                ? exists && digest === baseline.digest && bytes === baseline.bytes
                    && revision === baseline.revision && createdAt === baseline.createdAt
                : !exists);
            const targetMatches = readable && (operation.operation === 'write'
                ? exists && digest === sha256(operation.resource)
                : !exists);
            allBase &&= baseMatches;
            allTarget &&= targetMatches;
            divergent ||= !baseMatches && !targetMatches;
        }
        return { allBase, allTarget, divergent };
    }

    resourceFilesMatchProjectIndexUnlocked(projectId, project) {
        try {
            const resources = normalizeProjectResources(project.resources);
            const lorebookIds = new Set(resources.lorebookIds);
            for (const type of RESOURCE_TYPES) {
                const referenceField = RESOURCE_REFERENCE_BY_TYPE[type];
                for (const resourceId of resources[referenceField]) {
                    const resource = this.readResourceUnlocked(projectId, type, resourceId);
                    if (type === 'character' && resource.embeddedLorebookId !== null
                        && !lorebookIds.has(resource.embeddedLorebookId)) return false;
                }
            }
            this.assertStoredProjectLimitsUnlocked(projectId, project);
            return true;
        } catch {
            return false;
        }
    }

    resourceProjectTransitionMatches(baseProject, targetProject) {
        const expected = structuredClone(baseProject);
        expected.resources = structuredClone(targetProject.resources);
        expected.version = targetProject.version;
        expected.updatedAt = targetProject.updatedAt;
        return stableJson(expected) === stableJson(targetProject);
    }

    applyResourceOperations(projectId, operations, lock) {
        for (const item of operations) {
            const type = normalizeResourceType(item.type);
            const resourceId = assertId(item.resourceId, 'resource id');
            this.assertProjectLockOwnership(lock);
            if (item.operation === 'write') {
                validateResourceRecord(item.resource, projectId, resourceId, type);
                writeJson(this.resourcePath(projectId, type, resourceId), item.resource);
            } else if (item.operation === 'delete') {
                fs.rmSync(this.resourcePath(projectId, type, resourceId), { force: true });
            } else {
                throw new StoryStudioError('Resource journal contains an invalid operation.', 500, 'invalid_storage');
            }
        }
    }

    commitProjectAndResources(project, operations, lock) {
        const journalPath = this.resourceJournalPath(project.id);
        this.assertProjectLockOwnership(lock);
        const baseProject = this.readProjectUnlocked(project.id);
        const baseProjectDigest = sha256(baseProject);
        const baseProjectInvariantDigest = projectInvariantDigest(baseProject, RESOURCE_WRITE_MUTABLE_PROJECT_FIELDS);
        const baseResourceReferences = primaryResourceReferences(baseProject.resources);
        const baseResources = this.captureResourceBaselinesUnlocked(
            project.id,
            operations,
            baseResourceReferences,
        );
        const validation = this.validateResourceOperations(
            project.id,
            project,
            operations,
            baseProject.version,
            { baseProjectDigest, baseProjectInvariantDigest, baseResourceReferences, baseResources },
        );
        if (!this.resourceProjectTransitionMatches(baseProject, project)) {
            throw new StoryStudioError('Resource transaction changes unrelated project fields.', 500, 'invalid_storage');
        }
        this.validateTargetResourceProjectionUnlocked(project.id, project, validation.operationsByKey);
        writeJson(journalPath, {
            transactionId: randomUUID(),
            baseProjectVersion: baseProject.version,
            baseProjectDigest,
            baseProjectInvariantDigest,
            baseResourceReferences,
            baseResources,
            project,
            operations,
        });
        let completed = false;
        try {
            this.applyResourceOperations(project.id, operations, lock);
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(project.id), project);
            completed = true;
        } finally {
            if (completed) fs.rmSync(journalPath, { force: true });
        }
    }

    recoverProjectUnlocked(projectId, lock) {
        const journalPath = path.join(this.projectDirectory(projectId), '.pending-write.json');
        if (!fs.existsSync(journalPath)) return;
        let journal;
        let baseProjectVersion;
        let metadata;
        try {
            journal = readJson(journalPath, 'Pending write journal not found.');
            assertPlainObject(journal, 'pending write journal');
            const volumeJournal = journal.project?.schemaVersion >= VOLUME_STORY_STUDIO_SCHEMA_VERSION;
            assertKnownKeys(journal, [
                'transactionId', 'baseProjectVersion', 'baseProjectDigest', 'baseProjectInvariantDigest', 'baseChapterIds',
                'baseProjectChapterBytes', 'baseChapterDigest', 'baseChapterBytes', 'baseChapterRevision',
                'baseChapterNumber', 'baseChapterCreatedAt', 'project', 'chapter',
                ...(volumeJournal ? ['baseChapterVolumeId', 'baseChapterPlanBasis'] : []),
            ], 'pending write journal');
            assertId(journal.transactionId, 'transaction id');
            baseProjectVersion = journal.baseProjectVersion;
            metadata = {
                baseProjectDigest: journal.baseProjectDigest,
                baseProjectInvariantDigest: journal.baseProjectInvariantDigest,
                baseChapterIds: journal.baseChapterIds,
                baseProjectChapterBytes: journal.baseProjectChapterBytes,
                baseChapterDigest: journal.baseChapterDigest,
                baseChapterBytes: journal.baseChapterBytes,
                baseChapterRevision: journal.baseChapterRevision,
                baseChapterNumber: journal.baseChapterNumber,
                baseChapterCreatedAt: journal.baseChapterCreatedAt,
                ...(volumeJournal ? {
                    baseChapterVolumeId: journal.baseChapterVolumeId,
                    baseChapterPlanBasis: journal.baseChapterPlanBasis,
                } : {}),
            };
            this.validateProjectAndChapterWrite(
                projectId,
                journal.project,
                journal.chapter,
                baseProjectVersion,
                metadata,
            );
        } catch (error) {
            if (error instanceof StoryStudioError && error.code === 'invalid_storage') throw error;
            throw new StoryStudioError('Pending chapter write journal is invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
        const currentProject = this.readPendingProjectUnlocked(projectId, journal.baseProjectChapterBytes);
        const targetProjectVersion = journal.project.version;
        const targetMatchesCurrent = stableJson(currentProject) === stableJson(journal.project);
        const baseMatchesCurrent = currentProject.version === baseProjectVersion
            && sha256(currentProject) === journal.baseProjectDigest
            && stableJson(currentProject.chapters.map(chapter => chapter.id)) === stableJson(journal.baseChapterIds);
        const chapterState = this.inspectPendingChapterStateUnlocked(projectId, journal.chapter, metadata);
        const blockRecovery = () => {
            throw new StoryStudioError(
                'Pending chapter write conflicts with the project and chapter files; automatic recovery is blocked.',
                500,
                'stale_journal',
                {
                    currentVersion: currentProject.version,
                    baseProjectVersion,
                    journalVersion: targetProjectVersion,
                    transactionId: journal.transactionId,
                    recoveryBlocked: true,
                },
            );
        };

        if (targetMatchesCurrent) {
            if (!chapterState.matchesTarget || !this.chapterFilesMatchProjectIndexUnlocked(projectId, currentProject)) {
                blockRecovery();
            }
            this.assertProjectLockOwnership(lock);
            fs.rmSync(journalPath, { force: true });
            return;
        }

        if (baseMatchesCurrent) {
            const actualBaseChapterBytes = this.calculatePendingBaseChapterBytesUnlocked(
                projectId,
                currentProject,
                journal.chapter.id,
            );
            if (metadata.baseProjectChapterBytes !== currentProject.chapterBytes
                || actualBaseChapterBytes === null
                || metadata.baseChapterBytes !== actualBaseChapterBytes) {
                throw new StoryStudioError('Pending chapter write has invalid base byte metadata.', 500, 'invalid_storage');
            }
            if (!this.chapterProjectTransitionMatches(
                currentProject,
                journal.project,
                journal.chapter,
                metadata.baseChapterDigest === null ? null : { id: journal.chapter.id },
            )) {
                throw new StoryStudioError('Pending chapter write changes unrelated project fields.', 500, 'invalid_storage');
            }
            if (!chapterState.matchesBase && !chapterState.matchesTarget) blockRecovery();
            this.assertProjectLockOwnership(lock);
            writeJson(this.chapterPath(projectId, journal.chapter.id), journal.chapter);
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), journal.project);
            fs.rmSync(journalPath, { force: true });
            return;
        }

        if (!chapterState.matchesBase || !this.chapterFilesMatchProjectIndexUnlocked(projectId, currentProject)) {
            blockRecovery();
        }
        this.assertProjectLockOwnership(lock);
        const conflictPath = path.join(
            this.projectDirectory(projectId),
            `.pending-write.conflict-${journal.transactionId}-${Date.now()}.json`,
        );
        fs.renameSync(journalPath, conflictPath);
        console.warn(`Quarantined conflicting Story Studio journal for project ${projectId}: ${path.basename(conflictPath)}`);
    }

    recoverChapterOperationsUnlocked(projectId, lock) {
        const journalPath = this.chapterOperationsJournalPath(projectId);
        if (!fs.existsSync(journalPath)) return;
        let journal;
        let validation;
        try {
            journal = readJson(journalPath, 'Pending chapter operations journal not found.');
            assertPlainObject(journal, 'pending chapter operations journal');
            assertKnownKeys(journal, [
                'transactionId', 'baseProjectVersion', 'baseProjectDigest', 'baseProjectInvariantDigest', 'baseChapterIds',
                'baseProjectChapterBytes', 'baseChapters', 'project', 'operations',
            ], 'pending chapter operations journal');
            assertId(journal.transactionId, 'transaction id');
            validation = this.validateChapterOperations(
                projectId,
                journal.project,
                journal.operations,
                journal.baseProjectDigest,
                journal.baseChapterIds,
                {
                    baseProjectVersion: journal.baseProjectVersion,
                    baseProjectInvariantDigest: journal.baseProjectInvariantDigest,
                    baseProjectChapterBytes: journal.baseProjectChapterBytes,
                    baseChapters: journal.baseChapters,
                },
            );
        } catch (error) {
            if (error instanceof StoryStudioError && error.code === 'invalid_storage') throw error;
            throw new StoryStudioError('Pending chapter operations journal is invalid.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
        const baseProjectVersion = journal.baseProjectVersion;
        if (!Number.isSafeInteger(baseProjectVersion) || journal.project.version !== baseProjectVersion + 1) {
            throw new StoryStudioError('Pending chapter operations journal has an invalid version.', 500, 'invalid_storage');
        }
        const currentProject = this.readPendingProjectUnlocked(projectId, journal.baseProjectChapterBytes);
        const targetProjectVersion = journal.project.version;
        const targetMatchesCurrent = stableJson(currentProject) === stableJson(journal.project);
        const baseMatchesCurrent = currentProject.version === baseProjectVersion
            && sha256(currentProject) === journal.baseProjectDigest
            && stableJson(currentProject.chapters.map(chapter => chapter.id)) === stableJson(journal.baseChapterIds);
        const replayState = this.inspectChapterOperationsReplayStateUnlocked(
            projectId,
            validation.operationsById,
            validation.baseChaptersById,
        );
        const blockRecovery = () => {
            throw new StoryStudioError(
                'Pending chapter operations conflict with the project and chapter files; automatic recovery is blocked.',
                500,
                'stale_journal',
                {
                    currentVersion: currentProject.version,
                    baseProjectVersion,
                    journalVersion: targetProjectVersion,
                    transactionId: journal.transactionId,
                    recoveryBlocked: true,
                },
            );
        };

        if (targetMatchesCurrent) {
            if (!replayState.allTarget || !this.chapterFilesMatchProjectIndexUnlocked(projectId, currentProject)) {
                blockRecovery();
            }
            this.assertProjectLockOwnership(lock);
            fs.rmSync(journalPath, { force: true });
            return;
        }

        if (baseMatchesCurrent) {
            if (journal.baseProjectChapterBytes !== currentProject.chapterBytes) {
                throw new StoryStudioError('Chapter operations journal has invalid base byte metadata.', 500, 'invalid_storage');
            }
            if (!this.chapterOperationsProjectTransitionMatches(
                currentProject,
                journal.project,
                validation.operationsById,
            )) {
                throw new StoryStudioError('Chapter operations change unrelated project fields.', 500, 'invalid_storage');
            }
            if (replayState.divergent) blockRecovery();
            this.applyChapterOperations(projectId, journal.operations, lock);
            this.assertProjectLockOwnership(lock);
            writeJson(this.projectPath(projectId), journal.project);
            fs.rmSync(journalPath, { force: true });
            return;
        }

        if (!replayState.allBase || !this.chapterFilesMatchProjectIndexUnlocked(projectId, currentProject)) {
            blockRecovery();
        }
        this.assertProjectLockOwnership(lock);
        const conflictPath = path.join(
            this.projectDirectory(projectId),
            `.pending-chapter-operations.conflict-${journal.transactionId}-${Date.now()}.json`,
        );
        fs.renameSync(journalPath, conflictPath);
        console.warn(`Quarantined conflicting Story Studio chapter operations journal for project ${projectId}: ${path.basename(conflictPath)}`);
    }

    recoverResourceWriteUnlocked(projectId, lock) {
        const journalPath = this.resourceJournalPath(projectId);
        if (!fs.existsSync(journalPath)) return;
        const journal = readJson(journalPath, 'Pending resource write journal not found.');
        try {
            assertPlainObject(journal, 'pending resource write journal');
            assertKnownKeys(journal, [
                'transactionId', 'baseProjectVersion', 'baseProjectDigest', 'baseProjectInvariantDigest', 'baseResourceReferences',
                'baseResources', 'project', 'operations',
            ], 'pending resource write journal');
            assertId(journal.transactionId, 'transaction id');
        } catch (error) {
            throw new StoryStudioError('Pending resource write journal has an invalid envelope.', 500, 'invalid_storage', {
                cause: error.code || error.message,
            });
        }
        const baseProjectVersion = journal.baseProjectVersion;
        const validation = this.validateResourceOperations(
            projectId,
            journal.project,
            journal.operations,
            baseProjectVersion,
            {
                baseProjectDigest: journal.baseProjectDigest,
                baseProjectInvariantDigest: journal.baseProjectInvariantDigest,
                baseResourceReferences: journal.baseResourceReferences,
                baseResources: journal.baseResources,
            },
        );
        const currentProject = this.readPendingProjectUnlocked(projectId, journal.project.chapterBytes);
        const targetProjectVersion = journal.project.version;
        const targetMatchesCurrent = stableJson(currentProject) === stableJson(journal.project);
        const baseMatchesCurrent = currentProject.version === baseProjectVersion
            && sha256(currentProject) === journal.baseProjectDigest
            && stableJson(primaryResourceReferences(currentProject.resources))
                === stableJson(validation.baseResourceReferences);
        const replayState = this.inspectResourceReplayStateUnlocked(
            projectId,
            validation.operationsByKey,
            validation.baseResourcesByKey,
        );
        const blockRecovery = () => {
            throw new StoryStudioError(
                'Pending resource write conflicts with the project and resource files; automatic recovery is blocked.',
                500,
                'stale_journal',
                {
                    currentVersion: currentProject.version,
                    baseProjectVersion,
                    journalVersion: targetProjectVersion,
                    transactionId: journal.transactionId,
                    recoveryBlocked: true,
                },
            );
        };

        if (baseMatchesCurrent && !this.resourceProjectTransitionMatches(currentProject, journal.project)) {
            throw new StoryStudioError('Resource journal target changes unrelated project fields.', 500, 'invalid_storage');
        }
        if (!targetMatchesCurrent && !baseMatchesCurrent) {
            if (!replayState.allBase || !this.resourceFilesMatchProjectIndexUnlocked(projectId, currentProject)) {
                blockRecovery();
            }
            this.assertProjectLockOwnership(lock);
            const conflictPath = path.join(
                this.projectDirectory(projectId),
                `.pending-resource-write.conflict-${journal.transactionId}-${Date.now()}.json`,
            );
            fs.renameSync(journalPath, conflictPath);
            console.warn(`Quarantined conflicting Story Studio resource journal for project ${projectId}: ${path.basename(conflictPath)}`);
            return;
        }
        if (targetMatchesCurrent && !replayState.allTarget) blockRecovery();
        if (replayState.divergent) blockRecovery();
        this.validateTargetResourceProjectionUnlocked(projectId, journal.project, validation.operationsByKey);
        this.applyResourceOperations(projectId, journal.operations, lock);
        this.assertProjectLockOwnership(lock);
        writeJson(this.projectPath(projectId), journal.project);
        fs.rmSync(journalPath, { force: true });
    }

    lockPath(projectId) {
        return path.join(this.projectsDirectory, `${assertId(projectId, 'project id')}.lock`);
    }

    projectLockSnapshot(lockPath) {
        let directoryStat;
        let entries;
        try {
            directoryStat = fs.statSync(lockPath);
            entries = fs.readdirSync(lockPath, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }

        let newestMtimeMs = directoryStat.mtimeMs;
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile()) {
                return { files: [], newestMtimeMs: Date.now() };
            }
            const filePath = path.join(lockPath, entry.name);
            try {
                newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(filePath).mtimeMs);
                files.push({ name: entry.name, path: filePath });
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return { files, newestMtimeMs };
    }

    removeStaleProjectLock(lockPath) {
        const snapshot = this.projectLockSnapshot(lockPath);
        if (!snapshot) return false;
        const age = Date.now() - snapshot.newestMtimeMs;
        const ownerRecords = [];

        for (const file of snapshot.files) {
            if (!file.name.startsWith(LOCK_OWNER_PREFIX)) continue;
            try {
                ownerRecords.push(readOwnerRecord(file.path));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                return false;
            }
        }
        const explicitlyReleased = ownerRecords.some(record => record.releasedAt);
        if (age <= this.lockStaleMs && !explicitlyReleased) return false;
        if (age <= LOCK_HARD_STALE_MS && ownerRecords.some(isLockOwnerActive)) return false;

        const quarantined = [];
        try {
            for (const file of snapshot.files) {
                const quarantinePath = path.join(lockPath, `.stale-${randomUUID()}`);
                fs.renameSync(file.path, quarantinePath);
                quarantined.push({ originalPath: file.path, quarantinePath });
                if (!explicitlyReleased && Date.now() - fs.statSync(quarantinePath).mtimeMs <= this.lockStaleMs) {
                    for (const item of quarantined.reverse()) {
                        fs.renameSync(item.quarantinePath, item.originalPath);
                    }
                    return false;
                }
            }
            for (const item of quarantined) {
                fs.unlinkSync(item.quarantinePath);
            }
            fs.rmdirSync(lockPath);
            return true;
        } catch (error) {
            for (const item of quarantined.reverse()) {
                try {
                    if (fs.existsSync(item.quarantinePath) && !fs.existsSync(item.originalPath)) {
                        fs.renameSync(item.quarantinePath, item.originalPath);
                    }
                } catch {
                    // A later stale-lock attempt can recover an abandoned quarantine file.
                }
            }
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
            throw error;
        }
    }

    acquireProjectLock(projectId) {
        if (!fs.existsSync(this.projectDirectory(projectId))) {
            throw new StoryStudioError('Project not found.', 404, 'not_found');
        }
        const lockPath = this.lockPath(projectId);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                fs.mkdirSync(lockPath);
                const ownerToken = randomUUID();
                const ownerPath = path.join(lockPath, `${LOCK_OWNER_PREFIX}${ownerToken}`);
                try {
                    fs.writeFileSync(ownerPath, JSON.stringify({
                        token: ownerToken,
                        pid: process.pid,
                        instanceId: PROCESS_INSTANCE_ID,
                    }), { encoding: 'utf8', flag: 'wx' });
                } catch (error) {
                    try {
                        fs.unlinkSync(ownerPath);
                    } catch (cleanupError) {
                        if (cleanupError.code !== 'ENOENT') throw cleanupError;
                    }
                    fs.rmdirSync(lockPath);
                    throw error;
                }
                ACTIVE_LOCK_TOKENS.add(ownerToken);
                return { path: lockPath, ownerPath, ownerToken, ownerPid: process.pid };
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                if (attempt === 0 && this.removeStaleProjectLock(lockPath)) {
                    continue;
                }
                throw new StoryStudioError('Project is busy in another process.', 409, 'project_busy', { retryAfterMs: 100 });
            }
        }
        throw new StoryStudioError('Could not lock project.', 409, 'project_busy', { retryAfterMs: 100 });
    }

    refreshProjectLock(lock) {
        try {
            const owner = readOwnerRecord(lock.ownerPath);
            if (owner.token !== lock.ownerToken || !ACTIVE_LOCK_TOKENS.has(lock.ownerToken)) return false;
            const timestamp = new Date();
            fs.utimesSync(lock.ownerPath, timestamp, timestamp);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            console.warn('Could not refresh Story Studio project lock:', error.message);
            return false;
        }
    }

    startProjectLockHeartbeat(lock) {
        const timer = setInterval(() => {
            if (!this.refreshProjectLock(lock)) clearInterval(timer);
        }, this.lockHeartbeatMs);
        timer.unref?.();
        return timer;
    }

    assertProjectLockOwnership(lock) {
        if (!this.refreshProjectLock(lock)) {
            throw new StoryStudioError('Project lock ownership was lost.', 409, 'project_busy', { retryAfterMs: 100 });
        }
    }

    releaseProjectLock(lock) {
        try {
            const owner = readOwnerRecord(lock.ownerPath);
            if (owner.token !== lock.ownerToken) return false;
            try {
                fs.unlinkSync(lock.ownerPath);
            } catch (error) {
                if (error.code === 'ENOENT') return false;
                try {
                    fs.writeFileSync(lock.ownerPath, JSON.stringify({
                        ...owner,
                        pid: null,
                        releasedAt: nowIso(),
                    }), 'utf8');
                } catch (markerError) {
                    console.warn('Could not mark Story Studio project lock as released:', markerError.message);
                }
                console.warn('Could not remove Story Studio project lock owner:', error.message);
                return false;
            }
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        } finally {
            ACTIVE_LOCK_TOKENS.delete(lock.ownerToken);
        }

        try {
            fs.rmdirSync(lock.path);
        } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
        return true;
    }

    withProjectLock(projectId, callback) {
        const lock = this.acquireProjectLock(projectId);
        const heartbeat = this.startProjectLockHeartbeat(lock);
        try {
            this.recoverProjectUnlocked(projectId, lock);
            this.recoverChapterOperationsUnlocked(projectId, lock);
            this.recoverResourceWriteUnlocked(projectId, lock);
            this.recoverSchemaMigrationUnlocked(projectId, lock);
            this.migrateProjectUnlocked(projectId, lock);
            const result = callback(lock);
            this.assertProjectLockOwnership(lock);
            return result;
        } finally {
            clearInterval(heartbeat);
            this.releaseProjectLock(lock);
        }
    }

    async withProjectLockAsync(projectId, callback) {
        const lock = this.acquireProjectLock(projectId);
        const heartbeat = this.startProjectLockHeartbeat(lock);
        try {
            this.recoverProjectUnlocked(projectId, lock);
            this.recoverChapterOperationsUnlocked(projectId, lock);
            this.recoverResourceWriteUnlocked(projectId, lock);
            this.recoverSchemaMigrationUnlocked(projectId, lock);
            this.migrateProjectUnlocked(projectId, lock);
            const result = await callback(lock);
            this.assertProjectLockOwnership(lock);
            return result;
        } finally {
            clearInterval(heartbeat);
            this.releaseProjectLock(lock);
        }
    }

    assertProjectVersion(project, expectedVersion) {
        if (Number(expectedVersion) !== project.version) {
            throw new StoryStudioError('Project changed in another window.', 409, 'project_conflict', {
                currentVersion: project.version,
            });
        }
    }
}
