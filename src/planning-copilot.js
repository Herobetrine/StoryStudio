import { createHash } from 'node:crypto';

import { compileStoryContext } from '../public/context-compiler.js';

export const PLANNING_COPILOT_SCHEMA_VERSION = 1;

export const CHAPTER_CARD_PATCH_FIELDS = Object.freeze([
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
]);

export const REVIEW_PATCH_FIELDS = Object.freeze(['review', 'notes']);

const DIAGNOSIS_FIELDS = Object.freeze([
    'schemaVersion', 'kind', 'status', 'target', 'context', 'metrics', 'references',
    'evidenceCatalog', 'risks', 'gaps', 'suggestions', 'diagnosisDigest',
]);
const EVIDENCE_FIELDS = Object.freeze([
    'evidenceId', 'source', 'title', 'excerpt', 'tags', 'visibility', 'scope',
]);
const EVIDENCE_SOURCE_FIELDS = Object.freeze([
    'type', 'path', 'chapterId', 'chapterNumber', 'recordId',
]);
const FINDING_FIELDS = Object.freeze(['code', 'severity', 'message', 'evidenceIds']);
const ARTIFACT_FIELDS = Object.freeze([
    'schemaVersion', 'artifactId', 'kind', 'status', 'target', 'patch',
    'evidenceIds', 'diagnosisDigest',
]);
const TARGET_FIELDS = Object.freeze([
    'type', 'projectId', 'chapterId', 'projectVersion', 'chapterRevision',
]);
const DIAGNOSIS_TARGET_FIELDS = Object.freeze([
    'projectId', 'chapterId', 'chapterNumber', 'projectVersion', 'chapterRevision',
    'volumeId', 'volumeRevision',
]);
const DIAGNOSIS_CONTEXT_FIELDS = Object.freeze([
    'povEntityId', 'volumeId', 'previousChapterId', 'continuityStatus',
    'retrievalHitCount',
]);
const DIAGNOSIS_METRIC_FIELDS = Object.freeze([
    'evidenceCount', 'visibleEntities', 'visibleFacts', 'visibleKnowledge',
    'visiblePromises', 'visibleMemories', 'visibleTimelineItems', 'retrievalHits',
    'redactedRetrievalHits', 'filteredContinuityItems', 'authorEvidence', 'povSafeEvidence',
]);
const REFERENCE_FIELDS = Object.freeze(['entities', 'locations', 'promises']);
const ENTITY_REFERENCE_FIELDS = Object.freeze(['id', 'name', 'aliases', 'kind']);
const PROMISE_REFERENCE_FIELDS = Object.freeze(['id', 'title', 'dueChapterId', 'status']);

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_EVIDENCE_ID = /^evidence_[0-9a-f]{40}$/;
const VALID_ARTIFACT_ID = /^artifact_[0-9a-f]{40}$/;
const RETIRED_STATUSES = new Set(['retired', 'superseded', 'deleted', 'archived']);
const PRIVATE_VISIBILITIES = new Set(['private', 'secret', 'behind-the-scenes']);
const PUBLIC_VISIBILITIES = new Set(['public', 'all', 'reader']);
const VISIBLE_KNOWLEDGE_STANCES = new Set(['knows', 'suspects', 'believes', 'denies']);
const LOCATION_KINDS = new Set(['location', 'setting', 'place']);
const TEMPORAL_RETRIEVAL_TYPES = new Set(['chapter', 'chapter-summary', 'fact', 'memory']);
const RETRIEVAL_SOURCE_TYPES = new Set([
    'chapter', 'chapter-summary', 'volume-summary', 'character', 'lorebook', 'fact', 'memory',
]);
const SAFE_STORY_FIELDS = Object.freeze([
    'logline', 'premise', 'protagonist', 'opposition', 'world', 'powerSystem',
    'styleGuide', 'masterOutline', 'forbidden',
]);
const EVIDENCE_VISIBILITIES = new Set(['pov-safe', 'author']);
const EVIDENCE_SCOPES = new Set(['planning', 'manuscript', 'continuity', 'retrieval']);
const FORBIDDEN_PATCH_SYNTAX = Object.freeze([
    /\{\{[\s\S]*?\}\}/u,
    /<%[\s\S]*?%>/u,
    /\$\{[\s\S]*?\}/u,
    /<\/?script\b/iu,
    /\bjavascript\s*:/iu,
    /\b(?:eval|Function)\s*\(/u,
    /^\s*\$(?:\.|\[)/u,
]);
const REQUIRED_CARD_FIELDS = Object.freeze(['goal', 'conflict', 'turn', 'hook', 'pov', 'location']);
const SEVERITY_ORDER = new Map([['high', 0], ['medium', 1], ['low', 2], ['info', 3]]);
const MAX_EVIDENCE = 750;
const MAX_RETRIEVAL_EVIDENCE = 80;
const MAX_EVIDENCE_EXCERPT = 1_200;
const MAX_EVIDENCE_TITLE = 240;
const MAX_SOURCE_PATH = 1_024;
const MAX_CARD_FIELD_LENGTH = 100_000;
const MAX_REVIEW_LENGTH = 1_000_000;
const MAX_EVIDENCE_REFERENCES = 64;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_ENTRIES = 250_000;

export class PlanningCopilotError extends Error {
    constructor(message, code = 'invalid_planning_copilot_input', details = {}) {
        super(message);
        this.name = 'PlanningCopilotError';
        this.code = code;
        this.details = details;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function fail(message, code, details = {}) {
    throw new PlanningCopilotError(message, code, details);
}

function assertPlainObject(value, label) {
    if (!isPlainObject(value)) fail(`${label} must be a plain object.`, 'invalid_object', { field: label });
    return value;
}

function assertKnownKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length > 0) {
        fail(`${label} contains unknown fields.`, 'unknown_fields', { field: label, fields: unknown.sort() });
    }
}

function assertExactKeys(value, allowed, label) {
    assertKnownKeys(value, allowed, label);
    const missing = allowed.filter(key => !Object.hasOwn(value, key));
    if (missing.length > 0) {
        fail(`${label} is missing required fields.`, 'missing_fields', { field: label, fields: missing });
    }
}

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value) {
    return cleanText(value).toLocaleLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
}

function integerOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}

function finiteOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function cleanId(value) {
    return typeof value === 'string' && VALID_ID.test(value) ? value : '';
}

function requiredId(value, label) {
    const id = cleanId(value);
    if (!id) fail(`${label} is invalid.`, 'invalid_reference', { field: label });
    return id;
}

function requiredInteger(value, label, minimum = 0) {
    const number = integerOrNull(value);
    if (number === null || number < minimum) {
        fail(`${label} must be an integer of at least ${minimum}.`, 'invalid_number', { field: label });
    }
    return number;
}

function safeClone(value) {
    try {
        return structuredClone(value);
    } catch {
        fail('Planning input must be structured-clone compatible.', 'invalid_clone');
    }
}

function canonicalValue(value, state, depth) {
    if (depth > MAX_CANONICAL_DEPTH) fail('Canonical value is too deeply nested.', 'canonical_limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('Canonical value contains a non-finite number.', 'invalid_canonical_value');
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
        state.entries += value.length;
        if (state.entries > MAX_CANONICAL_ENTRIES) fail('Canonical value is too large.', 'canonical_limit');
        return value.map(item => canonicalValue(item, state, depth + 1));
    }
    if (!isPlainObject(value)) fail('Canonical value must contain only JSON-compatible objects.', 'invalid_canonical_value');
    if (state.seen.has(value)) fail('Canonical value must not contain cycles.', 'invalid_canonical_value');
    state.seen.add(value);
    const keys = Object.keys(value).sort();
    state.entries += keys.length;
    if (state.entries > MAX_CANONICAL_ENTRIES) fail('Canonical value is too large.', 'canonical_limit');
    const result = {};
    for (const key of keys) {
        const item = value[key];
        if (item === undefined || ['bigint', 'function', 'symbol'].includes(typeof item)) {
            fail('Canonical value contains an unsupported value.', 'invalid_canonical_value', { key });
        }
        result[key] = canonicalValue(item, state, depth + 1);
    }
    state.seen.delete(value);
    return result;
}

export function canonicalize(value) {
    return canonicalValue(value, { seen: new Set(), entries: 0 }, 0);
}

export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

export function hashCanonical(value) {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalizedExcerpt(value, maximum = MAX_EVIDENCE_EXCERPT, fromEnd = false) {
    const source = typeof value === 'string' ? value.replaceAll('\r\n', '\n').trim() : '';
    if (!source) return '';
    if (source.length <= maximum) return source;
    return fromEnd ? `…${source.slice(-(maximum - 1))}` : `${source.slice(0, maximum - 1)}…`;
}

function sourceSegment(value) {
    return encodeURIComponent(String(value ?? '').slice(0, 256));
}

function sortedUniqueStrings(value, maximum = 1_000) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, maximum);
}

function makeEvidence(source, title, excerpt, tags = [], classification = {}) {
    const normalizedSource = {
        type: cleanText(source?.type).slice(0, 80),
        path: cleanText(source?.path).slice(0, MAX_SOURCE_PATH),
        chapterId: cleanId(source?.chapterId) || null,
        chapterNumber: integerOrNull(source?.chapterNumber),
        recordId: cleanId(source?.recordId) || null,
    };
    if (!normalizedSource.type || !normalizedSource.path) return null;
    const record = {
        source: normalizedSource,
        title: normalizedExcerpt(title, MAX_EVIDENCE_TITLE),
        excerpt: normalizedExcerpt(excerpt),
        tags: sortedUniqueStrings(tags, 20),
        visibility: EVIDENCE_VISIBILITIES.has(classification.visibility)
            ? classification.visibility
            : 'pov-safe',
        scope: EVIDENCE_SCOPES.has(classification.scope) ? classification.scope : 'planning',
    };
    if (!record.title && !record.excerpt) return null;
    return {
        evidenceId: `evidence_${hashCanonical(record).slice(0, 40)}`,
        ...record,
    };
}

function validateEvidence(record, label = 'evidence') {
    assertPlainObject(record, label);
    assertExactKeys(record, EVIDENCE_FIELDS, label);
    if (!VALID_EVIDENCE_ID.test(record.evidenceId)) fail(`${label}.evidenceId is invalid.`, 'invalid_evidence');
    assertPlainObject(record.source, `${label}.source`);
    assertExactKeys(record.source, EVIDENCE_SOURCE_FIELDS, `${label}.source`);
    const normalized = makeEvidence(record.source, record.title, record.excerpt, record.tags, {
        visibility: record.visibility,
        scope: record.scope,
    });
    if (!normalized || normalized.evidenceId !== record.evidenceId || canonicalJson(normalized) !== canonicalJson(record)) {
        fail(`${label} is not a canonical evidence record.`, 'invalid_evidence', { evidenceId: record.evidenceId });
    }
    return normalized;
}

function chapterNumberMap(project, chapters, chapter) {
    const result = new Map();
    for (const item of [...(Array.isArray(project?.chapters) ? project.chapters : []), ...chapters, chapter]) {
        const id = cleanId(item?.id);
        const number = integerOrNull(item?.number);
        if (id && number !== null) result.set(id, number);
    }
    return result;
}

function mergedChapters(project, chapters, chapter) {
    const byId = new Map();
    for (const item of [...(Array.isArray(project?.chapters) ? project.chapters : []), ...chapters, chapter]) {
        const id = cleanId(item?.id);
        if (!id || !isPlainObject(item)) continue;
        byId.set(id, { ...(byId.get(id) ?? {}), ...safeClone(item) });
    }
    return [...byId.values()].sort((left, right) => (
        Number(left.number ?? Number.MAX_SAFE_INTEGER) - Number(right.number ?? Number.MAX_SAFE_INTEGER)
        || String(left.id).localeCompare(String(right.id))
    ));
}

function previousChapterFor(chapters, chapter, explicitPrevious) {
    if (isPlainObject(explicitPrevious) && cleanId(explicitPrevious.id)) return explicitPrevious;
    const currentNumber = Number(chapter.number);
    return chapters
        .filter(item => Number(item.number) < currentNumber)
        .sort((left, right) => Number(right.number) - Number(left.number) || String(left.id).localeCompare(String(right.id)))
        .at(0) ?? null;
}

function currentVolumeFor(project, chapter, volumes) {
    const volumeId = cleanId(chapter.volumeId)
        || cleanId(project?.chapters?.find(item => item?.id === chapter.id)?.volumeId);
    if (volumeId) return volumes.find(item => item?.id === volumeId) ?? null;
    return volumes.length === 1 ? volumes[0] : null;
}

function chapterIsFuture(chapterId, numbers, currentNumber) {
    if (!chapterId) return false;
    const number = numbers.get(chapterId);
    return !Number.isInteger(number) || number > currentNumber;
}

function normalizedPhrase(value) {
    return cleanText(value).replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function protectedPhrases(project, compiled, chapters, numbers, currentNumber) {
    const state = isPlainObject(project?.storyState) ? project.storyState : {};
    const selectedIds = Object.fromEntries([
        'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
    ].map(category => [category, new Set((compiled.storyState?.[category] ?? []).map(item => item?.id).filter(Boolean))]));
    const phrases = new Set();
    const add = value => {
        const phrase = normalizedPhrase(value);
        if (phrase) phrases.add(phrase);
    };
    for (const relation of state.relations ?? []) add(relation?.privateSummary);
    const protectedFields = {
        entities: ['summary', 'currentGoal', 'currentAction'],
        relations: ['summary', 'publicSummary', 'addressing'],
        events: ['title', 'summary'],
        promises: ['title', 'summary'],
        memory: ['summary'],
        facts: ['summary'],
        timeline: ['label', 'storyTime'],
    };
    for (const [category, fields] of Object.entries(protectedFields)) {
        for (const record of Array.isArray(state[category]) ? state[category] : []) {
            if (selectedIds[category].has(record?.id)) continue;
            for (const field of fields) add(record?.[field]);
        }
    }
    for (const item of chapters) {
        if (!chapterIsFuture(item?.id, numbers, currentNumber)) continue;
        add(item?.title);
        add(item?.summary);
        add(item?.card?.summary);
        add(item?.content);
    }
    return phrases;
}

function containsProtectedPhrase(value, phrases) {
    const candidate = normalizedPhrase(value);
    if (!candidate) return false;
    for (const phrase of phrases) {
        if (phrase.length < 4 ? candidate === phrase : candidate.includes(phrase)) return true;
    }
    return false;
}

function retrievalHits(value) {
    if (Array.isArray(value)) return value;
    if (!isPlainObject(value)) return [];
    for (const candidate of [value.hits, value.retrieval?.hits, value.preview?.hits, value.diagnostics?.retrieval?.hits]) {
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
}

function hitValue(hit, field) {
    if (hit?.[field] !== undefined) return hit[field];
    if (hit?.metadata?.[field] !== undefined) return hit.metadata[field];
    return hit?.source?.[field];
}

function normalizedSourceType(value) {
    return cleanText(value).toLocaleLowerCase();
}

function visibilityIsSafe(value, povEntityId) {
    if (value === undefined || value === null || value === '') return true;
    const visibility = normalizeStatus(value);
    if (PUBLIC_VISIBILITIES.has(visibility)) return true;
    if (PRIVATE_VISIBILITIES.has(visibility)) return false;
    return Boolean(povEntityId && [
        `pov:${povEntityId}`, `entity:${povEntityId}`, `character:${povEntityId}`,
        `reader-and-${povEntityId}`, `reader+${povEntityId}`, `reader:${povEntityId}`,
    ].includes(String(value)));
}

function safeRetrievalHits(value, context) {
    const raw = retrievalHits(value);
    const safe = [];
    const seen = new Set();
    for (const hit of raw) {
        if (!isPlainObject(hit)) continue;
        const sourceType = normalizedSourceType(hitValue(hit, 'sourceType'));
        const sourceId = cleanId(hitValue(hit, 'sourceId'));
        const hitId = cleanText(hit.id).slice(0, 256);
        const text = typeof hit.text === 'string' ? hit.text : '';
        if (!RETRIEVAL_SOURCE_TYPES.has(sourceType) || !sourceId || !hitId || !text.trim()) continue;
        if (seen.has(hitId)) continue;
        const status = normalizeStatus(hitValue(hit, 'status'));
        if (RETIRED_STATUSES.has(status) || cleanId(hitValue(hit, 'supersededById'))) continue;
        if (!visibilityIsSafe(hitValue(hit, 'visibility'), context.povEntityId)) continue;
        const chapterId = cleanId(hitValue(hit, 'chapterId')) || null;
        const mappedChapterNumber = chapterId ? context.chapterNumbers.get(chapterId) : null;
        const chapterNumber = integerOrNull(hitValue(hit, 'chapterNumber')) ?? mappedChapterNumber;
        if (chapterNumber !== null && chapterNumber > context.currentNumber) continue;
        if (chapterId && chapterIsFuture(chapterId, context.chapterNumbers, context.currentNumber)) continue;
        const sourceChapterIds = sortedUniqueStrings(hitValue(hit, 'sourceChapterIds'));
        if (sourceChapterIds.some(id => chapterIsFuture(id, context.chapterNumbers, context.currentNumber))) continue;
        const sourceChapterNumbers = Array.isArray(hitValue(hit, 'sourceChapterNumbers'))
            ? hitValue(hit, 'sourceChapterNumbers').map(integerOrNull)
            : [];
        if (sourceChapterNumbers.some(number => number === null || number > context.currentNumber)) continue;
        if (TEMPORAL_RETRIEVAL_TYPES.has(sourceType) && chapterNumber === null
            && sourceType !== 'fact' && sourceType !== 'memory') continue;
        const factId = cleanId(hitValue(hit, 'factId')) || (sourceType === 'fact' ? sourceId : '');
        if (sourceType === 'fact' && !context.visibleFactIds.has(factId)) continue;
        if (sourceType === 'memory' && !context.visibleMemoryIds.has(sourceId)) continue;
        const linkedFactIds = sortedUniqueStrings(hitValue(hit, 'linkedFactIds'));
        if (linkedFactIds.some(id => !context.visibleFactIds.has(id))) continue;
        if (sourceType === 'volume-summary' && context.volumeId) {
            const volumeId = cleanId(hitValue(hit, 'volumeId'));
            if (volumeId && volumeId !== context.volumeId) continue;
        }
        if (containsProtectedPhrase(text, context.protectedPhrases)) continue;
        seen.add(hitId);
        safe.push({
            id: hitId,
            text,
            sourceType,
            sourceId,
            chapterId,
            chapterNumber,
            score: finiteOrNull(hit.score),
            title: cleanText(hitValue(hit, 'title')),
            reasons: sortedUniqueStrings(Array.isArray(hit.reasons) ? hit.reasons : [hit.reason], 20),
        });
    }
    return {
        rawCount: raw.length,
        hits: safe.sort((left, right) => (
            (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY)
            || left.sourceType.localeCompare(right.sourceType)
            || left.sourceId.localeCompare(right.sourceId)
            || left.id.localeCompare(right.id)
        )).slice(0, MAX_RETRIEVAL_EVIDENCE),
    };
}

function recordText(category, record) {
    if (category === 'entities') {
        return [record.summary, record.currentGoal, record.currentAction].filter(Boolean).join('\n');
    }
    if (category === 'relations') {
        return [record.publicSummary || record.summary, record.addressing].filter(Boolean).join('\n');
    }
    if (category === 'events') return [record.title, record.summary].filter(Boolean).join('\n');
    if (category === 'promises') return [record.title, record.summary].filter(Boolean).join('\n');
    if (category === 'memory' || category === 'facts') return record.summary ?? '';
    if (category === 'timeline') return [record.label, record.storyTime].filter(Boolean).join(' · ');
    return '';
}

function recordTitle(category, record) {
    return record.name || record.title || record.label || record.summary || `${category}:${record.id}`;
}

function evidenceMap(catalog) {
    return new Map(catalog.map(item => [item.evidenceId, item]));
}

function evidenceIdsFor(catalog, predicate, maximum = 8) {
    return catalog.filter(predicate).slice(0, maximum).map(item => item.evidenceId);
}

function finding(code, severity, message, evidenceIds = []) {
    return {
        code,
        severity,
        message,
        evidenceIds: sortedUniqueStrings(evidenceIds, MAX_EVIDENCE_REFERENCES),
    };
}

function sortFindings(items) {
    return items.sort((left, right) => (
        (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99)
        || left.code.localeCompare(right.code)
        || left.message.localeCompare(right.message)
    ));
}

function publicEntityReferences(compiled) {
    return [...(compiled.storyState?.entities ?? [])]
        .map(entity => ({
            id: cleanId(entity.id),
            name: cleanText(entity.name),
            aliases: sortedUniqueStrings(entity.aliases, 100),
            kind: normalizeStatus(entity.kind),
        }))
        .filter(entity => entity.id)
        .sort((left, right) => left.id.localeCompare(right.id));
}

function publicPromiseReferences(compiled) {
    return [...(compiled.storyState?.promises ?? [])]
        .map(item => ({
            id: cleanId(item.id),
            title: cleanText(item.title),
            dueChapterId: cleanId(item.dueChapterId) || null,
            status: normalizeStatus(item.status),
        }))
        .filter(item => item.id)
        .sort((left, right) => left.id.localeCompare(right.id));
}

function addCatalogEvidence(catalog, seen, record) {
    if (!record || seen.has(record.evidenceId) || catalog.length >= MAX_EVIDENCE) return;
    seen.add(record.evidenceId);
    catalog.push(record);
}

function buildEvidenceCatalog(input) {
    const catalog = [];
    const seen = new Set();
    const add = (source, title, excerpt, tags, classification) => addCatalogEvidence(
        catalog,
        seen,
        makeEvidence(source, title, excerpt, tags, classification),
    );
    const { project, chapter, previousChapter, currentVolume, compiled, safeRetrieval, chapterNumbers } = input;

    if (cleanText(project.title)) {
        add(
            { type: 'project', path: 'project/title', recordId: project.id },
            '项目标题', project.title, ['project'], { visibility: 'author', scope: 'planning' },
        );
    }
    if (cleanText(project.genre)) {
        add(
            { type: 'project', path: 'project/genre', recordId: project.id },
            '项目类型', project.genre, ['project'], { visibility: 'author', scope: 'planning' },
        );
    }
    for (const field of SAFE_STORY_FIELDS) {
        const value = project.story?.[field];
        if (!cleanText(value)) continue;
        add(
            { type: 'project-story', path: `project/story/${field}`, recordId: project.id },
            `项目设定 · ${field}`,
            value,
            ['project', 'story'],
            { visibility: 'author', scope: 'planning' },
        );
    }

    if (currentVolume) {
        for (const field of ['title', 'goal', 'summary', 'outline']) {
            if (!cleanText(currentVolume[field])) continue;
            add(
                { type: 'volume', path: `volumes/${sourceSegment(currentVolume.id)}/${field}`, recordId: currentVolume.id },
                `当前卷 · ${field}`,
                currentVolume[field],
                ['volume', field],
                { visibility: 'author', scope: 'planning' },
            );
        }
    }

    if (previousChapter) {
        const previousNumber = integerOrNull(previousChapter.number);
        add(
            {
                type: 'chapter', path: `chapters/${sourceSegment(previousChapter.id)}/title`,
                chapterId: previousChapter.id, chapterNumber: previousNumber, recordId: previousChapter.id,
            },
            `前章标题 · 第${previousNumber ?? '?'}章`,
            previousChapter.title,
            ['chapter', 'previous'],
            { visibility: 'pov-safe', scope: 'manuscript' },
        );
        const previousSummary = previousChapter.card?.summary || previousChapter.summary;
        if (cleanText(previousSummary)) {
            add(
                {
                    type: 'chapter', path: `chapters/${sourceSegment(previousChapter.id)}/card/summary`,
                    chapterId: previousChapter.id, chapterNumber: previousNumber, recordId: previousChapter.id,
                },
                `前章摘要 · 第${previousNumber ?? '?'}章`,
                previousSummary,
                ['chapter', 'previous', 'summary'],
                { visibility: 'pov-safe', scope: 'manuscript' },
            );
        }
        if (cleanText(previousChapter.content)) {
            add(
                {
                    type: 'chapter', path: `chapters/${sourceSegment(previousChapter.id)}/content-tail`,
                    chapterId: previousChapter.id, chapterNumber: previousNumber, recordId: previousChapter.id,
                },
                `前章结尾 · 第${previousNumber ?? '?'}章`,
                normalizedExcerpt(previousChapter.content, MAX_EVIDENCE_EXCERPT, true),
                ['chapter', 'previous', 'content'],
                { visibility: 'pov-safe', scope: 'manuscript' },
            );
        }
    }

    const chapterNumber = integerOrNull(chapter.number);
    if (cleanText(chapter.title)) {
        add(
            {
                type: 'chapter', path: `chapters/${sourceSegment(chapter.id)}/title`,
                chapterId: chapter.id, chapterNumber, recordId: chapter.id,
            },
            `当前章标题 · 第${chapterNumber ?? '?'}章`,
            chapter.title,
            ['chapter', 'current'],
            { visibility: 'author', scope: 'planning' },
        );
    }
    for (const field of CHAPTER_CARD_PATCH_FIELDS) {
        const value = chapter.card?.[field];
        if (!cleanText(value)) continue;
        add(
            {
                type: 'chapter-card', path: `chapters/${sourceSegment(chapter.id)}/card/${field}`,
                chapterId: chapter.id, chapterNumber, recordId: chapter.id,
            },
            `章节卡 · ${field}`,
            value,
            ['chapter', 'card', field],
            { visibility: 'author', scope: 'planning' },
        );
    }
    if (cleanText(chapter.content)) {
        add(
            {
                type: 'chapter', path: `chapters/${sourceSegment(chapter.id)}/content`,
                chapterId: chapter.id, chapterNumber, recordId: chapter.id,
            },
            `当前章正文 · 第${chapterNumber ?? '?'}章`,
            chapter.content,
            ['chapter', 'current', 'content'],
            { visibility: 'pov-safe', scope: 'manuscript' },
        );
    }

    for (const category of ['entities', 'relations', 'events', 'promises', 'memory', 'facts', 'timeline']) {
        const records = [...(compiled.storyState?.[category] ?? [])]
            .sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')));
        for (const record of records) {
            const excerpt = recordText(category, record);
            if (!cleanText(excerpt)) continue;
            const sourceChapterId = cleanId(
                record.chapterId || record.sourceChapterId || record.introducedChapterId || record.updatedChapterId,
            ) || null;
            add(
                {
                    type: `story-state-${category}`,
                    path: `storyState/${category}/${sourceSegment(record.id)}`,
                    chapterId: sourceChapterId,
                    chapterNumber: sourceChapterId ? chapterNumbers.get(sourceChapterId) ?? null : null,
                    recordId: record.id,
                },
                `${category} · ${recordTitle(category, record)}`,
                excerpt,
                ['story-state', category],
                { visibility: 'pov-safe', scope: 'continuity' },
            );
        }
    }

    for (const hit of safeRetrieval.hits) {
        add(
            {
                type: 'retrieval',
                path: `retrieval/${sourceSegment(hit.sourceType)}/${sourceSegment(hit.sourceId)}/${sourceSegment(hit.id)}`,
                chapterId: hit.chapterId,
                chapterNumber: hit.chapterNumber,
                recordId: hit.sourceId,
            },
            hit.title || `检索命中 · ${hit.sourceType}:${hit.sourceId}`,
            hit.text,
            ['retrieval', hit.sourceType, ...hit.reasons],
            { visibility: 'pov-safe', scope: 'retrieval' },
        );
    }

    return catalog.sort((left, right) => (
        left.source.path.localeCompare(right.source.path)
        || left.evidenceId.localeCompare(right.evidenceId)
    ));
}

function diagnosisFindings(input) {
    const { chapter, currentVolume, compiled, catalog, safeRetrieval } = input;
    const risks = [];
    const gaps = [];
    const suggestions = [];
    const evidenceForPath = suffix => evidenceIdsFor(catalog, item => item.source.path.endsWith(suffix));
    const evidenceForRecord = id => evidenceIdsFor(catalog, item => item.source.recordId === id);

    for (const field of REQUIRED_CARD_FIELDS) {
        if (cleanText(chapter.card?.[field])) continue;
        gaps.push(finding(
            `missing-card-${field}`,
            ['goal', 'conflict', 'pov'].includes(field) ? 'high' : 'medium',
            `章节卡缺少 ${field}。`,
        ));
        suggestions.push(finding(
            `define-card-${field}`,
            'info',
            `在进入正文生成前补齐章节卡 ${field}。`,
            currentVolume ? evidenceForRecord(currentVolume.id) : [],
        ));
    }
    if (!cleanText(chapter.card?.summary)) {
        gaps.push(finding('missing-card-summary', 'low', '章节卡缺少可检索的章节摘要。'));
    }
    if (!cleanText(chapter.content)) {
        gaps.push(finding('chapter-content-empty', 'info', '当前章尚无正式正文。'));
    }
    if (!currentVolume) {
        gaps.push(finding('missing-volume', 'high', '当前章节没有可解析的卷归属。'));
    } else {
        if (!cleanText(currentVolume.goal)) gaps.push(finding('missing-volume-goal', 'medium', '当前卷缺少卷目标。'));
        const basisRevision = integerOrNull(chapter.planBasis?.volumeRevision);
        const volumeRevision = integerOrNull(currentVolume.revision);
        if (basisRevision !== null && volumeRevision !== null && basisRevision !== volumeRevision) {
            risks.push(finding(
                'stale-volume-plan-basis',
                'high',
                '章节规划基于旧版卷纲，候选章节卡应先重新对齐当前卷。',
                evidenceForRecord(currentVolume.id),
            ));
        }
    }

    if (compiled.preflight?.pov?.unresolved) {
        risks.push(finding(
            'unresolved-pov',
            'high',
            'POV 未唯一解析；POV 事实已被隐藏，必须先修正人物引用。',
            evidenceForPath('/card/pov'),
        ));
    }
    if (compiled.preflight?.movement?.requiresTransition) {
        risks.push(finding(
            'location-transition-required',
            'medium',
            '当前时间锚点与章节地点不同，正文需要显式交代转场。',
            evidenceForPath('/card/location'),
        ));
        suggestions.push(finding(
            'plan-location-transition',
            'info',
            '把转场动作加入 required，避免人物瞬移。',
            evidenceForPath('/card/location'),
        ));
    }
    const hiddenKnowledgeCount = Number(compiled.preflight?.counts?.hiddenKnowledge ?? 0);
    if (hiddenKnowledgeCount > 0) {
        risks.push(finding(
            'protected-pov-knowledge',
            'high',
            '当前 POV 存在受保护知识；诊断未输出其内容，候选不得将其写成公开事实。',
        ));
    }
    for (const item of compiled.preflight?.promises?.touch ?? []) {
        const promiseId = cleanId(item?.promiseId);
        if (!promiseId) continue;
        suggestions.push(finding(
            `touch-promise-${promiseId}`,
            'info',
            '本章应触碰一个已到期、高紧急或已被当前上下文提及的伏笔。',
            evidenceForRecord(promiseId),
        ));
    }
    if ((compiled.preflight?.promises?.doNotResolve ?? []).length > 0) {
        risks.push(finding(
            'protected-open-promises',
            'medium',
            '存在尚未到兑现时点的伏笔，本章只能推进，不能提前闭合。',
            evidenceIdsFor(catalog, item => item.source.type === 'story-state-promises'),
        ));
    }

    if (safeRetrieval.hits.length === 0) {
        gaps.push(finding('no-safe-retrieval-evidence', 'low', '当前查询没有通过连续性边界的检索证据。'));
    }
    if (safeRetrieval.rawCount > safeRetrieval.hits.length) {
        risks.push(finding(
            'retrieval-redactions-applied',
            'medium',
            '部分检索命中因未来章节、私密信息、POV 知识或废弃状态被确定性移除。',
        ));
    }
    if (currentVolume && cleanText(currentVolume.goal)) {
        suggestions.push(finding(
            'align-volume-goal',
            'info',
            '让本章目标或转折对当前卷目标产生可验证的推进。',
            evidenceForRecord(currentVolume.id),
        ));
    }

    return {
        risks: sortFindings(risks),
        gaps: sortFindings(gaps),
        suggestions: sortFindings(suggestions),
    };
}

function validateFinding(item, catalogIds, label) {
    assertPlainObject(item, label);
    assertExactKeys(item, FINDING_FIELDS, label);
    if (!cleanText(item.code) || !SEVERITY_ORDER.has(item.severity) || !cleanText(item.message)) {
        fail(`${label} is invalid.`, 'invalid_diagnosis');
    }
    if (!Array.isArray(item.evidenceIds)) fail(`${label}.evidenceIds must be an array.`, 'invalid_diagnosis');
    for (const id of item.evidenceIds) {
        if (!catalogIds.has(id)) fail(`${label} cites unknown evidence.`, 'unknown_evidence', { evidenceId: id });
    }
}

function validateReferences(references) {
    assertPlainObject(references, 'diagnosis.references');
    assertExactKeys(references, REFERENCE_FIELDS, 'diagnosis.references');
    for (const category of ['entities', 'locations']) {
        if (!Array.isArray(references[category])) fail(`diagnosis.references.${category} must be an array.`, 'invalid_diagnosis');
        for (const [index, item] of references[category].entries()) {
            assertPlainObject(item, `diagnosis.references.${category}[${index}]`);
            assertExactKeys(item, ENTITY_REFERENCE_FIELDS, `diagnosis.references.${category}[${index}]`);
            requiredId(item.id, `diagnosis.references.${category}[${index}].id`);
            if (typeof item.name !== 'string' || typeof item.kind !== 'string' || !Array.isArray(item.aliases)
                || item.aliases.some(alias => typeof alias !== 'string')) {
                fail(`diagnosis.references.${category}[${index}] is invalid.`, 'invalid_diagnosis');
            }
        }
    }
    if (!Array.isArray(references.promises)) fail('diagnosis.references.promises must be an array.', 'invalid_diagnosis');
    for (const [index, item] of references.promises.entries()) {
        assertPlainObject(item, `diagnosis.references.promises[${index}]`);
        assertExactKeys(item, PROMISE_REFERENCE_FIELDS, `diagnosis.references.promises[${index}]`);
        requiredId(item.id, `diagnosis.references.promises[${index}].id`);
    }
}

export function validatePlanningDiagnosis(value) {
    const diagnosis = safeClone(value);
    assertPlainObject(diagnosis, 'diagnosis');
    assertExactKeys(diagnosis, DIAGNOSIS_FIELDS, 'diagnosis');
    if (diagnosis.schemaVersion !== PLANNING_COPILOT_SCHEMA_VERSION
        || diagnosis.kind !== 'planning-diagnosis'
        || !['ready', 'warning', 'blocked'].includes(diagnosis.status)) {
        fail('Diagnosis header is invalid.', 'invalid_diagnosis');
    }
    assertPlainObject(diagnosis.target, 'diagnosis.target');
    assertExactKeys(diagnosis.target, DIAGNOSIS_TARGET_FIELDS, 'diagnosis.target');
    requiredId(diagnosis.target.projectId, 'diagnosis.target.projectId');
    requiredId(diagnosis.target.chapterId, 'diagnosis.target.chapterId');
    requiredInteger(diagnosis.target.chapterNumber, 'diagnosis.target.chapterNumber', 1);
    requiredInteger(diagnosis.target.projectVersion, 'diagnosis.target.projectVersion', 0);
    requiredInteger(diagnosis.target.chapterRevision, 'diagnosis.target.chapterRevision', 0);
    if (diagnosis.target.volumeId !== null) requiredId(diagnosis.target.volumeId, 'diagnosis.target.volumeId');
    if (diagnosis.target.volumeRevision !== null) requiredInteger(diagnosis.target.volumeRevision, 'diagnosis.target.volumeRevision', 0);
    assertPlainObject(diagnosis.context, 'diagnosis.context');
    assertExactKeys(diagnosis.context, DIAGNOSIS_CONTEXT_FIELDS, 'diagnosis.context');
    assertPlainObject(diagnosis.metrics, 'diagnosis.metrics');
    assertExactKeys(diagnosis.metrics, DIAGNOSIS_METRIC_FIELDS, 'diagnosis.metrics');
    for (const field of DIAGNOSIS_METRIC_FIELDS) requiredInteger(diagnosis.metrics[field], `diagnosis.metrics.${field}`, 0);
    validateReferences(diagnosis.references);
    if (!Array.isArray(diagnosis.evidenceCatalog)) fail('diagnosis.evidenceCatalog must be an array.', 'invalid_diagnosis');
    const catalogIds = new Set();
    for (const [index, record] of diagnosis.evidenceCatalog.entries()) {
        const evidence = validateEvidence(record, `diagnosis.evidenceCatalog[${index}]`);
        if (catalogIds.has(evidence.evidenceId)) fail('Diagnosis contains duplicate evidence.', 'invalid_diagnosis');
        catalogIds.add(evidence.evidenceId);
    }
    for (const category of ['risks', 'gaps', 'suggestions']) {
        if (!Array.isArray(diagnosis[category])) fail(`diagnosis.${category} must be an array.`, 'invalid_diagnosis');
        diagnosis[category].forEach((item, index) => validateFinding(item, catalogIds, `diagnosis.${category}[${index}]`));
    }
    if (!/^[0-9a-f]{64}$/.test(diagnosis.diagnosisDigest)) fail('Diagnosis digest is invalid.', 'invalid_diagnosis');
    const core = { ...diagnosis };
    delete core.diagnosisDigest;
    if (hashCanonical(core) !== diagnosis.diagnosisDigest) fail('Diagnosis digest does not match its content.', 'diagnosis_digest_mismatch');
    return canonicalize(diagnosis);
}

/**
 * Build a deterministic, read-only planning diagnosis for one chapter.
 * The function never calls a model and never returns an apply operation.
 */
export function diagnosePlanning(input = {}) {
    const snapshot = safeClone(input);
    assertPlainObject(snapshot, 'input');
    const project = assertPlainObject(snapshot.project, 'input.project');
    const chapter = assertPlainObject(snapshot.chapter, 'input.chapter');
    const projectId = requiredId(project.id, 'input.project.id');
    const chapterId = requiredId(chapter.id, 'input.chapter.id');
    if (chapter.projectId && chapter.projectId !== projectId) {
        fail('Chapter belongs to another project.', 'invalid_reference', { chapterId, projectId });
    }
    const chapterNumber = requiredInteger(chapter.number, 'input.chapter.number', 1);
    const projectVersion = requiredInteger(project.version ?? 0, 'input.project.version', 0);
    const chapterRevision = requiredInteger(chapter.revision ?? 0, 'input.chapter.revision', 0);
    const chapters = mergedChapters(project, Array.isArray(snapshot.chapters) ? snapshot.chapters : [], chapter);
    const numbers = chapterNumberMap(project, chapters, chapter);
    const previousChapter = previousChapterFor(chapters, chapter, snapshot.previousChapter);
    const volumes = (Array.isArray(snapshot.volumes) ? snapshot.volumes : Array.isArray(project.volumes) ? project.volumes : [])
        .filter(isPlainObject)
        .map(safeClone)
        .sort((left, right) => Number(left.number ?? Number.MAX_SAFE_INTEGER) - Number(right.number ?? Number.MAX_SAFE_INTEGER)
            || String(left.id ?? '').localeCompare(String(right.id ?? '')));
    const currentVolume = currentVolumeFor(project, chapter, volumes);
    const state = isPlainObject(project.storyState) ? project.storyState : {};
    const limits = Object.fromEntries([
        'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
    ].map(category => [category, Math.max(100, Array.isArray(state[category]) ? state[category].length : 0)]));
    const compiled = compileStoryContext({
        project,
        chapter,
        previousChapter,
        nextChapter: null,
        limits,
    });
    const phrases = protectedPhrases(project, compiled, chapters, numbers, chapterNumber);
    const povEntityId = cleanId(compiled.preflight?.pov?.entityId) || null;
    const volumeId = cleanId(currentVolume?.id) || null;
    const visibleFactIds = new Set((compiled.storyState?.facts ?? []).map(item => item.id).filter(Boolean));
    const visibleMemoryIds = new Set((compiled.storyState?.memory ?? []).map(item => item.id).filter(Boolean));
    const safeRetrieval = safeRetrievalHits(snapshot.retrievalDiagnostics, {
        chapterNumbers: numbers,
        currentNumber: chapterNumber,
        povEntityId,
        volumeId,
        visibleFactIds,
        visibleMemoryIds,
        protectedPhrases: phrases,
    });
    const catalog = buildEvidenceCatalog({
        project,
        chapter,
        previousChapter,
        currentVolume,
        compiled,
        safeRetrieval,
        chapterNumbers: numbers,
    });
    const entityReferences = publicEntityReferences(compiled);
    const references = {
        entities: entityReferences,
        locations: entityReferences.filter(item => LOCATION_KINDS.has(item.kind)),
        promises: publicPromiseReferences(compiled),
    };
    const findings = diagnosisFindings({ chapter, currentVolume, compiled, catalog, safeRetrieval });
    const status = compiled.preflight?.status === 'blocked'
        || [...findings.risks, ...findings.gaps].some(item => item.severity === 'high')
        ? 'blocked'
        : findings.risks.length > 0 || findings.gaps.some(item => item.severity !== 'info') ? 'warning' : 'ready';
    const core = {
        schemaVersion: PLANNING_COPILOT_SCHEMA_VERSION,
        kind: 'planning-diagnosis',
        status,
        target: {
            projectId,
            chapterId,
            chapterNumber,
            projectVersion,
            chapterRevision,
            volumeId,
            volumeRevision: currentVolume ? integerOrNull(currentVolume.revision) : null,
        },
        context: {
            povEntityId,
            volumeId,
            previousChapterId: cleanId(previousChapter?.id) || null,
            continuityStatus: ['ready', 'warning', 'blocked'].includes(compiled.preflight?.status)
                ? compiled.preflight.status
                : 'blocked',
            retrievalHitCount: safeRetrieval.hits.length,
        },
        metrics: {
            evidenceCount: catalog.length,
            visibleEntities: compiled.storyState?.entities?.length ?? 0,
            visibleFacts: compiled.storyState?.facts?.length ?? 0,
            visibleKnowledge: compiled.storyState?.knowledge?.length ?? 0,
            visiblePromises: compiled.storyState?.promises?.length ?? 0,
            visibleMemories: compiled.storyState?.memory?.length ?? 0,
            visibleTimelineItems: compiled.storyState?.timeline?.length ?? 0,
            retrievalHits: safeRetrieval.hits.length,
            redactedRetrievalHits: Math.max(0, safeRetrieval.rawCount - safeRetrieval.hits.length),
            filteredContinuityItems: compiled.diagnostics?.filteredItems?.length ?? 0,
            authorEvidence: catalog.filter(item => item.visibility === 'author').length,
            povSafeEvidence: catalog.filter(item => item.visibility === 'pov-safe').length,
        },
        references,
        evidenceCatalog: catalog,
        ...findings,
    };
    const result = {
        ...core,
        diagnosisDigest: hashCanonical(core),
    };
    return validatePlanningDiagnosis(result);
}

function suggestionEvidenceIsAllowed(record, diagnosis) {
    if (!record || !diagnosis) return false;
    if (record.visibility === 'pov-safe') return true;
    if (record.visibility !== 'author' || record.scope !== 'planning') return false;
    const path = record.source.path;
    if (['project/title', 'project/genre'].includes(path)) return true;
    if (['logline', 'premise', 'forbidden'].some(field => path === `project/story/${field}`)) return true;
    const volumeId = diagnosis.target.volumeId;
    if (volumeId && ['title', 'goal', 'outline', 'summary']
        .some(field => path === `volumes/${sourceSegment(volumeId)}/${field}`)) return true;
    const chapterPrefix = `chapters/${sourceSegment(diagnosis.target.chapterId)}/`;
    return path === `${chapterPrefix}title` || path.startsWith(`${chapterPrefix}card/`);
}

function safeSuggestionExcerpt(record, maximum = 220) {
    if (!record || !suggestionEvidenceIsAllowed(record.record, record.diagnosis)) return '';
    const source = cleanText(record.record.excerpt).replace(/\s+/gu, ' ');
    if (!source || FORBIDDEN_PATCH_SYNTAX.some(pattern => pattern.test(source))) return '';
    return normalizedExcerpt(source, maximum);
}

function joinedSuggestion(items, maximum = 600) {
    const selected = [...new Set(items.map(cleanText).filter(Boolean))];
    return normalizedExcerpt(selected.join('；'), maximum);
}

function safeReferenceLabel(value, fallback) {
    const source = cleanText(value).replace(/\s+/gu, ' ');
    if (!source || FORBIDDEN_PATCH_SYNTAX.some(pattern => pattern.test(source))) return fallback;
    return normalizedExcerpt(source, 120);
}

function suggestionSource(catalog, diagnosis, predicate, usedEvidenceIds, maximum = 220) {
    const record = catalog.find(item => predicate(item) && suggestionEvidenceIsAllowed(item, diagnosis));
    const text = safeSuggestionExcerpt({ record, diagnosis }, maximum);
    if (!text) return { text: '', record: null };
    usedEvidenceIds.add(record.evidenceId);
    return { text, record };
}

function referenceMentioned(reference, haystack) {
    const source = haystack.toLocaleLowerCase();
    return [reference.id, reference.name, ...reference.aliases]
        .map(cleanText)
        .filter(Boolean)
        .some(value => source.includes(value.toLocaleLowerCase()));
}

function suggestedReference(references, evidenceText) {
    const matches = references.filter(reference => referenceMentioned(reference, evidenceText));
    if (matches.length === 1) return matches[0].id;
    return references.length === 1 ? references[0].id : '';
}

function assertSuggestionSnapshot(project, chapter, diagnosis) {
    const projectId = requiredId(project.id, 'suggestion.project.id');
    const chapterId = requiredId(chapter.id, 'suggestion.chapter.id');
    if (projectId !== diagnosis.target.projectId || chapterId !== diagnosis.target.chapterId) {
        fail('Suggestion snapshot does not match the diagnosis target.', 'stale_or_mismatched_target');
    }
    if (integerOrNull(project.version) !== diagnosis.target.projectVersion
        || integerOrNull(chapter.revision) !== diagnosis.target.chapterRevision) {
        fail('Suggestion snapshot versions do not match the diagnosis.', 'stale_or_mismatched_target');
    }
}

function buildSuggestedChapterCardPatch(input) {
    const project = assertPlainObject(input.project, 'suggestion.project');
    const chapter = assertPlainObject(input.chapter, 'suggestion.chapter');
    const diagnosis = validatePlanningDiagnosis(input.diagnosis);
    assertSuggestionSnapshot(project, chapter, diagnosis);
    const card = isPlainObject(chapter.card) ? chapter.card : {};
    const missing = new Set(CHAPTER_CARD_PATCH_FIELDS.filter(field => !cleanText(card[field])));
    if (missing.size === 0) return { patch: {}, evidenceIds: [], diagnosis };

    const catalog = diagnosis.evidenceCatalog;
    const usedEvidenceIds = new Set();
    const exact = (path, maximum) => suggestionSource(
        catalog,
        diagnosis,
        item => item.source.path === path,
        usedEvidenceIds,
        maximum,
    );
    const story = field => exact(`project/story/${field}`, 180);
    const volume = field => diagnosis.target.volumeId
        ? exact(`volumes/${sourceSegment(diagnosis.target.volumeId)}/${field}`, 180)
        : { text: '', record: null };
    const previous = diagnosis.context.previousChapterId
        ? exact(`chapters/${sourceSegment(diagnosis.context.previousChapterId)}/card/summary`, 180)
        : { text: '', record: null };
    const logline = story('logline').text;
    const premise = story('premise').text;
    const forbidden = story('forbidden').text;
    const volumeGoal = volume('goal').text;
    const volumeOutline = volume('outline').text;
    const previousSummary = previous.text;
    const publicPromise = diagnosis.references.promises[0] ?? null;
    const publicPromiseLabel = publicPromise
        ? safeReferenceLabel(publicPromise.title, publicPromise.id)
        : '';
    if (publicPromise) {
        const promiseEvidence = catalog.find(item => (
            item.source.type === 'story-state-promises'
            && item.source.recordId === publicPromise.id
            && suggestionEvidenceIsAllowed(item, diagnosis)
        ));
        if (promiseEvidence) usedEvidenceIds.add(promiseEvidence.evidenceId);
    }
    const findingCodes = new Set([
        ...diagnosis.risks,
        ...diagnosis.gaps,
        ...diagnosis.suggestions,
    ].map(item => item.code));
    const allowedEvidenceText = catalog
        .filter(item => suggestionEvidenceIsAllowed(item, diagnosis))
        .map(item => safeSuggestionExcerpt({ record: item, diagnosis }, 300))
        .filter(Boolean)
        .join('\n');
    const characterReferences = diagnosis.references.entities
        .filter(item => !LOCATION_KINDS.has(item.kind));

    const patch = {};
    if (missing.has('summary')) {
        if (previousSummary && volumeGoal) {
            patch.summary = `承接“${previousSummary}”，本章推进“${volumeGoal}”。`;
        } else if (volumeGoal) {
            patch.summary = `本章围绕“${volumeGoal}”完成一次可验证推进。`;
        } else if (logline) {
            patch.summary = `本章让当前行动对“${logline}”产生新的结果。`;
        } else {
            patch.summary = '本章完成一个明确行动，并让结果改变下一步选择。';
        }
    }
    if (missing.has('goal')) {
        patch.goal = volumeGoal
            ? `推进当前卷目标：${volumeGoal}`
            : logline ? `让本章行动实质推进：${logline}`
                : '让主角完成一个可验证的阶段目标。';
    }
    if (missing.has('conflict')) {
        patch.conflict = publicPromise
            ? `“${publicPromiseLabel}”逼近处理时点，主角必须在有限行动空间内承担代价。`
            : premise ? `既有规则与本章目标正面冲突：${premise}`
                : '目标受到明确阻力，主角不能同时保住所有选项。';
    }
    if (missing.has('turn')) {
        patch.turn = volumeOutline
            ? `让行动结果偏离预期，并把局面推向“${volumeOutline}”。`
            : previousSummary ? `让“${previousSummary}”的结果产生一项新的代价或线索。`
                : '让主角的选择产生一项不可忽略的新代价或新线索。';
    }
    if (missing.has('hook')) {
        patch.hook = publicPromise
            ? `章尾让“${publicPromiseLabel}”出现新变化，但不提前完成最终兑现。`
            : logline ? `章尾用一个可验证的新变化把读者拉回“${logline}”。`
                : '章尾留下一个由本章行动直接造成、下一章必须回应的新变化。';
    }
    if (missing.has('pov')) {
        const pov = suggestedReference(characterReferences, allowedEvidenceText);
        if (pov) patch.pov = pov;
    }
    if (missing.has('location')) {
        const location = suggestedReference(diagnosis.references.locations, allowedEvidenceText);
        if (location) patch.location = location;
    }
    if (missing.has('time')) {
        const timelineEvidence = catalog.find(item => (
            item.source.type === 'story-state-timeline'
            && item.visibility === 'pov-safe'
            && (item.source.chapterId === diagnosis.target.chapterId || item.source.chapterNumber === diagnosis.target.chapterNumber)
        )) ?? catalog.find(item => item.source.type === 'story-state-timeline' && item.visibility === 'pov-safe');
        const timelineText = safeSuggestionExcerpt({ record: timelineEvidence, diagnosis }, 120);
        if (timelineText) {
            usedEvidenceIds.add(timelineEvidence.evidenceId);
            patch.time = timelineText.includes(' · ') ? timelineText.split(' · ').at(-1) : timelineText;
        } else {
            patch.time = previousSummary ? '承接上一章之后' : '承接当前进度';
        }
    }
    if (missing.has('required')) {
        const required = [];
        if (publicPromise) required.push(`触碰公开伏笔“${publicPromiseLabel}”`);
        if (findingCodes.has('location-transition-required')) required.push('显式交代场景转移');
        if (volumeGoal) required.push(`让本章结果推进卷目标“${volumeGoal}”`);
        if (required.length === 0) required.push('让目标、冲突和转折在正文中都有可验证落点');
        patch.required = joinedSuggestion(required);
    }
    if (missing.has('avoid')) {
        const avoid = [];
        if (forbidden) avoid.push(forbidden);
        if (findingCodes.has('protected-pov-knowledge')) avoid.push('不要把 POV 尚不可公开的知识写成已知事实');
        if (findingCodes.has('protected-open-promises')) avoid.push('不要提前兑现未到期伏笔');
        if (findingCodes.has('retrieval-redactions-applied')) avoid.push('不要恢复被连续性边界过滤的检索材料');
        avoid.push('不要引入诊断证据之外的未来或私密事实');
        patch.avoid = joinedSuggestion(avoid);
    }

    const normalized = Object.keys(patch).length > 0
        ? validateChapterCardPatch(patch, diagnosis)
        : {};
    return { patch: normalized, evidenceIds: [...usedEvidenceIds].sort(), diagnosis };
}

/** Suggest only missing chapter-card fields; existing non-empty fields are omitted. */
export function suggestChapterCardPatch(input = {}) {
    const value = safeClone(input);
    assertPlainObject(value, 'suggestion input');
    assertKnownKeys(value, ['project', 'chapter', 'diagnosis'], 'suggestion input');
    return buildSuggestedChapterCardPatch(value).patch;
}

/** Build an inert candidate from the deterministic missing-field suggestions. */
export function createSuggestedChapterCardCandidate(input = {}) {
    const value = safeClone(input);
    assertPlainObject(value, 'suggested candidate input');
    assertKnownKeys(value, ['project', 'chapter', 'diagnosis', 'evidenceIds'], 'suggested candidate input');
    const built = buildSuggestedChapterCardPatch(value);
    if (Object.keys(built.patch).length === 0) {
        fail('Chapter card has no missing fields to suggest.', 'no_missing_card_fields');
    }
    let evidenceIds = value.evidenceIds;
    if (evidenceIds === undefined) {
        evidenceIds = built.evidenceIds;
        if (evidenceIds.length === 0) {
            const fallback = built.diagnosis.evidenceCatalog.find(item => (
                suggestionEvidenceIsAllowed(item, built.diagnosis)
            ));
            evidenceIds = fallback ? [fallback.evidenceId] : [];
        }
    } else if (Array.isArray(evidenceIds)) {
        const catalog = evidenceMap(built.diagnosis.evidenceCatalog);
        for (const evidenceId of evidenceIds) {
            const record = catalog.get(evidenceId);
            if (!record || !suggestionEvidenceIsAllowed(record, built.diagnosis)) {
                fail(
                    'Suggested chapter-card candidate cites future or non-planning author evidence.',
                    'unsafe_suggestion_evidence',
                    { evidenceId },
                );
            }
        }
    }
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
        fail('Suggested chapter-card candidate has no safe supporting evidence.', 'missing_evidence');
    }
    return createChapterCardCandidate({
        diagnosis: built.diagnosis,
        patch: built.patch,
        evidenceIds,
    });
}

function validateTextPatch(patch, allowedFields, limits, label) {
    assertPlainObject(patch, label);
    assertKnownKeys(patch, allowedFields, label);
    if (Object.keys(patch).length === 0) fail(`${label} cannot be empty.`, 'empty_patch');
    const normalized = {};
    for (const field of allowedFields) {
        if (!Object.hasOwn(patch, field)) continue;
        const value = patch[field];
        if (typeof value !== 'string') {
            fail(`${label}.${field} must be a string.`, 'invalid_patch_type', { field });
        }
        if (value.includes('\u0000')) fail(`${label}.${field} contains a null character.`, 'invalid_patch_value', { field });
        if (FORBIDDEN_PATCH_SYNTAX.some(pattern => pattern.test(value))) {
            fail(
                `${label}.${field} contains a template, script, or path expression.`,
                'forbidden_patch_syntax',
                { field },
            );
        }
        if (value.length > limits[field]) {
            fail(`${label}.${field} is too long.`, 'patch_too_large', { field, maximum: limits[field] });
        }
        normalized[field] = value.replaceAll('\r\n', '\n');
    }
    return normalized;
}

function resolveReference(value, references) {
    const source = cleanText(value);
    if (!source) return null;
    const exact = references.find(item => item.id === source);
    if (exact) return exact;
    const query = source.toLocaleLowerCase();
    const matches = references.filter(item => [item.name, ...item.aliases]
        .some(name => cleanText(name).toLocaleLowerCase() === query));
    return matches.length === 1 ? matches[0] : null;
}

export function validateChapterCardPatch(patch, diagnosisValue = null) {
    const limits = Object.fromEntries(CHAPTER_CARD_PATCH_FIELDS.map(field => [field, MAX_CARD_FIELD_LENGTH]));
    const normalized = validateTextPatch(safeClone(patch), CHAPTER_CARD_PATCH_FIELDS, limits, 'chapter-card patch');
    if (diagnosisValue) {
        const diagnosis = validatePlanningDiagnosis(diagnosisValue);
        const povReferences = diagnosis.references.entities.filter(item => !LOCATION_KINDS.has(item.kind));
        if (Object.hasOwn(normalized, 'pov') && cleanText(normalized.pov)
            && !resolveReference(normalized.pov, povReferences)) {
            fail('chapter-card patch.pov does not resolve to one visible entity.', 'invalid_reference', { field: 'pov' });
        }
        if (Object.hasOwn(normalized, 'location') && cleanText(normalized.location)
            && !resolveReference(normalized.location, diagnosis.references.locations)) {
            fail('chapter-card patch.location does not resolve to one visible location.', 'invalid_reference', { field: 'location' });
        }
    }
    return normalized;
}

export function validateReviewPatch(patch) {
    const normalized = validateTextPatch(safeClone(patch), REVIEW_PATCH_FIELDS, {
        review: MAX_REVIEW_LENGTH,
        notes: MAX_REVIEW_LENGTH,
    }, 'review patch');
    if (!Object.hasOwn(normalized, 'review') || !normalized.review.trim()) {
        fail('review patch.review is required.', 'missing_review');
    }
    return normalized;
}

function normalizedArtifactTarget(targetValue, diagnosis, type) {
    const fallback = {
        type,
        projectId: diagnosis.target.projectId,
        chapterId: diagnosis.target.chapterId,
        projectVersion: diagnosis.target.projectVersion,
        chapterRevision: diagnosis.target.chapterRevision,
    };
    const target = targetValue === undefined ? fallback : safeClone(targetValue);
    assertPlainObject(target, 'artifact.target');
    assertExactKeys(target, TARGET_FIELDS, 'artifact.target');
    if (target.type !== type) fail('Artifact target type is invalid.', 'invalid_target');
    requiredId(target.projectId, 'artifact.target.projectId');
    requiredId(target.chapterId, 'artifact.target.chapterId');
    requiredInteger(target.projectVersion, 'artifact.target.projectVersion', 0);
    requiredInteger(target.chapterRevision, 'artifact.target.chapterRevision', 0);
    if (target.projectId !== diagnosis.target.projectId || target.chapterId !== diagnosis.target.chapterId
        || target.projectVersion !== diagnosis.target.projectVersion
        || target.chapterRevision !== diagnosis.target.chapterRevision) {
        fail('Artifact target does not match the diagnosis snapshot.', 'stale_or_mismatched_target');
    }
    return target;
}

function normalizedEvidenceIds(value, diagnosis) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_REFERENCES) {
        fail(`evidenceIds must contain between 1 and ${MAX_EVIDENCE_REFERENCES} ids.`, 'invalid_evidence_references');
    }
    const catalog = evidenceMap(diagnosis.evidenceCatalog);
    const ids = sortedUniqueStrings(value, MAX_EVIDENCE_REFERENCES);
    if (ids.length !== value.length) fail('evidenceIds must be unique non-empty strings.', 'invalid_evidence_references');
    for (const id of ids) {
        if (!VALID_EVIDENCE_ID.test(id) || !catalog.has(id)) {
            fail('Candidate cites evidence outside the diagnosis catalog.', 'unknown_evidence', { evidenceId: id });
        }
    }
    return ids;
}

function artifactCore(kind, target, patch, evidenceIds, diagnosisDigest) {
    return {
        schemaVersion: PLANNING_COPILOT_SCHEMA_VERSION,
        kind,
        status: 'candidate',
        target,
        patch,
        evidenceIds,
        diagnosisDigest,
    };
}

function candidateArtifact(kind, type, input, patchValidator) {
    const value = safeClone(input);
    assertPlainObject(value, 'candidate input');
    assertKnownKeys(value, ['diagnosis', 'target', 'patch', 'evidenceIds'], 'candidate input');
    const diagnosis = validatePlanningDiagnosis(value.diagnosis);
    const target = normalizedArtifactTarget(value.target, diagnosis, type);
    const patch = patchValidator(value.patch, diagnosis);
    const evidenceIds = normalizedEvidenceIds(value.evidenceIds, diagnosis);
    const core = artifactCore(kind, target, patch, evidenceIds, diagnosis.diagnosisDigest);
    const artifact = {
        schemaVersion: core.schemaVersion,
        artifactId: `artifact_${hashCanonical(core).slice(0, 40)}`,
        kind: core.kind,
        status: core.status,
        target: core.target,
        patch: core.patch,
        evidenceIds: core.evidenceIds,
        diagnosisDigest: core.diagnosisDigest,
    };
    return validateCandidateArtifact(artifact, diagnosis);
}

export function createChapterCardCandidate(input) {
    return candidateArtifact(
        'chapter-card',
        'chapter-card',
        input,
        (patch, diagnosis) => validateChapterCardPatch(patch, diagnosis),
    );
}

export function createReviewCandidate(input) {
    return candidateArtifact('chapter-review', 'chapter-quality', input, patch => validateReviewPatch(patch));
}

export function validateCandidateArtifact(value, diagnosisValue) {
    const artifact = safeClone(value);
    const diagnosis = validatePlanningDiagnosis(diagnosisValue);
    assertPlainObject(artifact, 'artifact');
    assertExactKeys(artifact, ARTIFACT_FIELDS, 'artifact');
    if (artifact.schemaVersion !== PLANNING_COPILOT_SCHEMA_VERSION
        || artifact.status !== 'candidate'
        || !['chapter-card', 'chapter-review'].includes(artifact.kind)
        || !VALID_ARTIFACT_ID.test(artifact.artifactId)) {
        fail('Artifact header is invalid.', 'invalid_artifact');
    }
    const type = artifact.kind === 'chapter-card' ? 'chapter-card' : 'chapter-quality';
    const target = normalizedArtifactTarget(artifact.target, diagnosis, type);
    const patch = artifact.kind === 'chapter-card'
        ? validateChapterCardPatch(artifact.patch, diagnosis)
        : validateReviewPatch(artifact.patch);
    const ids = normalizedEvidenceIds(artifact.evidenceIds, diagnosis);
    if (artifact.diagnosisDigest !== diagnosis.diagnosisDigest) {
        fail('Artifact diagnosis digest is stale or forged.', 'diagnosis_digest_mismatch');
    }
    const core = artifactCore(artifact.kind, target, patch, ids, artifact.diagnosisDigest);
    const expectedId = `artifact_${hashCanonical(core).slice(0, 40)}`;
    if (artifact.artifactId !== expectedId) fail('Artifact id does not match its content.', 'artifact_digest_mismatch');
    const normalized = {
        schemaVersion: artifact.schemaVersion,
        artifactId: expectedId,
        kind: artifact.kind,
        status: artifact.status,
        target,
        patch,
        evidenceIds: ids,
        diagnosisDigest: artifact.diagnosisDigest,
    };
    if (canonicalJson(normalized) !== canonicalJson(artifact)) {
        fail('Artifact is not canonical.', 'invalid_artifact');
    }
    return normalized;
}
