import { createHash } from 'node:crypto';
import MiniSearch from 'minisearch';

/**
 * Local-first retrieval index for Story Studio.
 *
 * The index deliberately keeps the corpus as ordinary JSON-compatible chunks.
 * This makes rebuilds deterministic, lets callers inspect exactly what was
 * retrieved, and avoids coupling the writing workflow to a hosted vector
 * service.  Scoring is BM25-style; Chinese text is tokenized one Han
 * character at a time while latin words and numbers remain word tokens.
 */

export const RETRIEVAL_INDEX_SCHEMA_VERSION = 1;

const DEFAULT_OPTIONS = Object.freeze({
    chunkSize: 1_600,
    chunkOverlap: 160,
    k1: 1.2,
    b: 0.75,
    maxResults: 20,
});

const SOURCE_TYPE_ALIASES = new Map([
    ['chapter', 'chapter'],
    ['chapter-body', 'chapter'],
    ['chapter-content', 'chapter'],
    ['body', 'chapter'],
    ['正文', 'chapter'],
    ['chapter-summary', 'chapter-summary'],
    ['chapter-summary-text', 'chapter-summary'],
    ['summary', 'chapter-summary'],
    ['章摘要', 'chapter-summary'],
    ['volume', 'volume-summary'],
    ['volume-summary', 'volume-summary'],
    ['卷摘要', 'volume-summary'],
    ['character', 'character'],
    ['characters', 'character'],
    ['人物', 'character'],
    ['lorebook', 'lorebook'],
    ['lorebooks', 'lorebook'],
    ['world-info', 'lorebook'],
    ['世界书', 'lorebook'],
    ['fact', 'fact'],
    ['facts', 'fact'],
    ['事实', 'fact'],
    ['memory', 'memory'],
    ['memories', 'memory'],
    ['记忆', 'memory'],
]);

const SOURCE_TYPE_ORDER = new Map([
    ['chapter', 0],
    ['chapter-summary', 1],
    ['volume-summary', 2],
    ['character', 3],
    ['lorebook', 4],
    ['fact', 5],
    ['memory', 6],
]);

const RETIRED_STATUSES = new Set(['retired', 'superseded', 'deleted', 'archived']);
const PRIVATE_KNOWLEDGE_STANCES = new Set(['hides']);

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value) {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function nonEmptyText(value) {
    const text = textValue(value);
    return text.trim().length > 0 ? text : '';
}

function cleanId(value, fallback = '') {
    const text = nonEmptyText(value);
    return text || fallback;
}

function canonicalSourceType(value) {
    const normalized = textValue(value).trim().toLocaleLowerCase();
    return SOURCE_TYPE_ALIASES.get(normalized) ?? SOURCE_TYPE_ALIASES.get(textValue(value).trim()) ?? (normalized || 'chapter');
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeIdList(value) {
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return [...new Set(values.map(item => cleanId(item)).filter(Boolean))];
}

function normalizeTextList(value) {
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return values.map(textValue).map(item => item.trim()).filter(Boolean);
}

/**
 * Tokenization intentionally stays stable across Node versions.  Han
 * characters are useful retrieval units in Chinese; latin words are grouped
 * so "chapter-12" still contributes meaningful terms.
 */
export function tokenize(value) {
    const source = textValue(value).toLocaleLowerCase();
    const tokens = [];
    const matcher = /[\p{Script=Han}]|[\p{L}\p{N}]+/gu;
    for (const match of source.matchAll(matcher)) {
        const token = match[0];
        if (token) tokens.push(token);
    }
    return tokens;
}

export function hashText(value) {
    return createHash('sha256').update(textValue(value), 'utf8').digest('hex');
}

function chunkRanges(text, chunkSize, chunkOverlap) {
    const source = textValue(text);
    if (!source.length) return [];
    const size = Math.max(1, Math.floor(Number(chunkSize) || DEFAULT_OPTIONS.chunkSize));
    const overlap = Math.max(0, Math.min(size - 1, Math.floor(Number(chunkOverlap) || 0)));
    const ranges = [];
    let start = 0;
    while (start < source.length) {
        const end = Math.min(source.length, start + size);
        ranges.push({ start, end });
        if (end >= source.length) break;
        const next = end - overlap;
        start = next > start ? next : end;
    }
    return ranges;
}

function sourceKey(sourceType, sourceId) {
    return `${canonicalSourceType(sourceType)}\u0000${cleanId(sourceId)}`;
}

function appendField(parts, label, value) {
    const text = nonEmptyText(value);
    if (text) parts.push(`${label}: ${text}`);
}

function joinTextParts(parts) {
    return parts.filter(Boolean).join('\n');
}

function sourceText(source, sourceType) {
    if (!isObject(source)) return textValue(source);
    if (source.text !== undefined) return textValue(source.text);
    if (source.content !== undefined && sourceType === 'chapter') return textValue(source.content);
    if (source.body !== undefined) return textValue(source.body);

    const parts = [];
    if (sourceType === 'character') {
        appendField(parts, 'name', source.name);
        for (const field of [
            'description', 'personality', 'scenario', 'openingSample', 'openingSamples',
            'dialogueExamples', 'creatorNotes', 'instruction', 'postInstruction', 'tags',
        ]) appendField(parts, field, Array.isArray(source[field]) ? source[field].join('\n') : source[field]);
    } else if (sourceType === 'lorebook') {
        appendField(parts, 'name', source.name);
        appendField(parts, 'description', source.description);
        const entries = Array.isArray(source.entries) ? source.entries : [];
        for (const [index, entry] of entries.entries()) {
            if (!isObject(entry)) continue;
            // SillyTavern-compatible lorebooks use either `enabled: false` or
            // `disable: true`.  Disabled entries must not become retrievable
            // merely because the containing lorebook is active.
            if (entry.enabled === false || entry.disable === true) continue;
            const entryParts = [];
            appendField(entryParts, 'keys', entry.keys ?? entry.key);
            appendField(entryParts, 'secondaryKeys', entry.secondaryKeys ?? entry.keysecondary);
            appendField(entryParts, 'content', entry.content ?? entry.text);
            if (entryParts.length > 0) parts.push(`entry-${entry.id ?? index}: ${entryParts.join(' | ')}`);
        }
    } else {
        for (const field of ['title', 'name', 'summary', 'detail', 'description', 'outline', 'goal', 'content', 'tags']) {
            const value = Array.isArray(source[field]) ? source[field].join(', ') : source[field];
            appendField(parts, field, value);
        }
    }
    return joinTextParts(parts);
}

function normalizeKnowledge(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(isObject).map(item => ({
        id: cleanId(item.id),
        entityId: cleanId(item.entityId ?? item.povEntityId),
        factId: cleanId(item.factId),
        stance: nonEmptyText(item.stance).toLocaleLowerCase(),
        status: nonEmptyText(item.status).toLocaleLowerCase(),
        learnedChapterId: cleanId(item.learnedChapterId) || null,
        learnedChapterNumber: numberOrNull(item.learnedChapterNumber),
    }));
}

function normalizeNumberList(value) {
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return values.map(numberOrNull);
}

function sourceMetadata(source, sourceType, fallbackId, index = 0) {
    const id = cleanId(source?.sourceId ?? source?.id ?? source?.uid, fallbackId || `${sourceType}-${index + 1}`);
    const chapter = source?.chapter;
    const volume = source?.volume;
    const chapterId = cleanId(source?.chapterId ?? source?.sourceChapterId ?? chapter?.id) || null;
    const volumeId = cleanId(source?.volumeId ?? volume?.id) || null;
    const chapterNumber = numberOrNull(source?.chapterNumber ?? source?.number ?? chapter?.number);
    const personIds = normalizeIdList([
        ...normalizeIdList(source?.personIds),
        ...normalizeIdList(source?.entityIds),
        source?.personId,
        source?.entityId,
        source?.subjectEntityId,
    ]);
    if (sourceType === 'character') personIds.push(id);
    const tags = normalizeTextList(source?.tags);
    const status = nonEmptyText(source?.status).toLocaleLowerCase() || null;
    const supersededById = cleanId(source?.supersededById) || null;
    return {
        sourceType,
        sourceId: id,
        chapterId,
        volumeId,
        chapterNumber,
        personIds: [...new Set(personIds)],
        tags,
        status,
        supersededById,
        storyTime: source?.storyTime ?? source?.time ?? null,
        sequence: numberOrNull(source?.sequence),
        factId: cleanId(source?.factId) || (sourceType === 'fact' ? id : null),
        knowledge: normalizeKnowledge(source?.knowledge),
        sourceChapterIds: normalizeIdList(source?.sourceChapterIds),
        sourceChapterNumbers: normalizeNumberList(source?.sourceChapterNumbers),
        linkedFactIds: normalizeIdList(source?.linkedFactIds ?? source?.factIds),
        title: nonEmptyText(source?.title ?? source?.name) || null,
        entryId: cleanId(source?.entryId) || null,
    };
}

function makeChunk(source, sourceType, options, index = 0, textOverride = undefined) {
    const type = canonicalSourceType(sourceType ?? source?.sourceType);
    const metadata = sourceMetadata(source, type, '', index);
    const text = textOverride === undefined ? sourceText(source, type) : textValue(textOverride);
    if (!text.trim()) return [];
    const result = [];
    for (const range of chunkRanges(text, options.chunkSize, options.chunkOverlap)) {
        const content = text.slice(range.start, range.end);
        const hash = hashText(content);
        const id = `${metadata.sourceType}:${metadata.sourceId}:${range.start}-${range.end}:${hash}`;
        result.push({
            id,
            text: content,
            hash,
            start: range.start,
            end: range.end,
            ...metadata,
        });
    }
    return result;
}

function addDraft(drafts, source, sourceType, options, index = drafts.length, textOverride = undefined) {
    const chunks = makeChunk(source, sourceType, options, index, textOverride);
    drafts.push(...chunks);
    return chunks.length;
}

function sourceWith(source, extra = {}) {
    return { ...(isObject(source) ? source : {}), ...extra };
}

function collectProjectSources(input, options) {
    const drafts = [];
    let recognized = false;
    const chaptersById = new Map(
        (Array.isArray(input.chapters) ? input.chapters : [])
            .filter(item => isObject(item) && cleanId(item.id))
            .map(item => [item.id, item]),
    );
    const chapterNumberById = new Map(
        [...chaptersById.entries()].map(([id, chapter]) => [id, numberOrNull(chapter.number)]),
    );
    const knowledgeByFact = new Map();
    const projectKnowledge = Array.isArray(input.storyState?.knowledge)
        ? input.storyState.knowledge
        : Array.isArray(input.knowledge) ? input.knowledge : [];
    for (const edge of projectKnowledge) {
        if (!isObject(edge) || !cleanId(edge.factId)) continue;
        if (!knowledgeByFact.has(edge.factId)) knowledgeByFact.set(edge.factId, []);
        knowledgeByFact.get(edge.factId).push(sourceWith(edge, {
            learnedChapterNumber: edge.learnedChapterNumber
                ?? chapterNumberById.get(cleanId(edge.learnedChapterId))
                ?? null,
        }));
    }
    const stateFacts = [
        ...(Array.isArray(input.facts) ? input.facts : []),
        ...(Array.isArray(input.storyState?.facts) ? input.storyState.facts : []),
    ];
    const factIdsByText = new Map();
    for (const fact of stateFacts) {
        if (!isObject(fact) || !cleanId(fact.id) || !nonEmptyText(fact.summary)) continue;
        const key = nonEmptyText(fact.summary).normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if (!factIdsByText.has(key)) factIdsByText.set(key, new Set());
        factIdsByText.get(key).add(cleanId(fact.id));
    }
    const addList = (list, type, mapper = item => item) => {
        if (!Array.isArray(list)) return;
        recognized = true;
        for (const item of list) {
            if (!isObject(item)) continue;
            const mapped = mapper(item);
            addDraft(drafts, mapped, type, options);
        }
    };

    addList(input.chapters, 'chapter', chapter => sourceWith(chapter, {
        chapterId: chapter.chapterId ?? chapter.id,
        chapterNumber: chapter.chapterNumber ?? chapter.number,
        volumeId: chapter.volumeId ?? chapter.volume?.id,
    }));
    if (Array.isArray(input.chapters)) {
        for (const chapter of input.chapters) {
            if (!isObject(chapter)) continue;
            const summary = chapter.summary ?? chapter.card?.summary;
            if (nonEmptyText(summary)) addDraft(drafts, sourceWith(chapter, {
                text: summary,
                sourceId: chapter.id,
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                volumeId: chapter.volumeId ?? chapter.volume?.id,
            }), 'chapter-summary', options);
        }
    }
    addList(input.volumes, 'volume-summary', volume => sourceWith(volume, {
        sourceId: volume.sourceId ?? volume.id,
        text: [volume.summary, volume.outline, volume.goal]
            .filter(value => typeof value === 'string' && value.trim())
            .join('\n'),
        volumeId: volume.id,
    }));

    const resources = isObject(input.resources) ? input.resources : {};
    addList(input.characters ?? resources.characters, 'character');
    addList(input.lorebooks ?? resources.lorebooks, 'lorebook');
    const enrichStateRecord = (item, type) => {
        const chapterId = cleanId(item.chapterId ?? item.sourceChapterId) || null;
        const chapter = chapterId ? chaptersById.get(chapterId) : null;
        const sourceChapterIds = normalizeIdList(item.sourceChapterIds);
        const sameTextFactIds = type === 'memory' && nonEmptyText(item.summary)
            ? [...(factIdsByText.get(nonEmptyText(item.summary).normalize('NFKC').replace(/\s+/gu, ' ').trim()) ?? [])]
            : [];
        return sourceWith(item, {
            chapterId,
            chapterNumber: item.chapterNumber ?? chapter?.number,
            volumeId: item.volumeId ?? chapter?.volumeId ?? chapter?.volume?.id,
            knowledge: item.knowledge ?? knowledgeByFact.get(item.factId ?? item.id) ?? [],
            sourceChapterIds,
            sourceChapterNumbers: sourceChapterIds
                .map(id => chapterNumberById.get(id) ?? null),
            linkedFactIds: normalizeIdList([
                ...normalizeIdList(item.linkedFactIds ?? item.factIds),
                ...sameTextFactIds,
            ]),
        });
    };
    addList(input.facts, 'fact', item => enrichStateRecord(item, 'fact'));
    addList(input.memory ?? input.memories, 'memory', item => enrichStateRecord(item, 'memory'));

    if (isObject(input.storyState)) {
        addList(input.storyState.facts, 'fact', item => enrichStateRecord(item, 'fact'));
        addList(input.storyState.memory, 'memory', item => enrichStateRecord(item, 'memory'));
    }
    return { drafts, recognized };
}

function collectSources(input, options) {
    if (Array.isArray(input)) {
        const drafts = [];
        for (const [index, item] of input.entries()) {
            if (isObject(item) && (item.sourceType || item.type || item.text !== undefined || item.content !== undefined)) {
                addDraft(drafts, item, item.sourceType ?? item.type ?? 'chapter', options, index);
            } else if (isObject(item)) {
                const collected = collectProjectSources(item, options);
                drafts.push(...collected.drafts);
            }
        }
        return drafts;
    }
    if (!isObject(input)) return [];
    if (Array.isArray(input.sources)) return collectSources(input.sources, options);

    // Export payloads keep the authoritative Story State under `project` and
    // place full chapter/resource records beside it.  Merge those two views
    // without mutating either object so retrieval sees the complete corpus.
    const projectInput = isObject(input.project)
        ? {
            ...input.project,
            chapters: Array.isArray(input.chapters)
                ? input.chapters.map(chapter => ({
                    ...(input.project.chapters ?? []).find(summary => summary?.id === chapter?.id),
                    ...chapter,
                }))
                : input.project.chapters,
            resources: isObject(input.resources) ? input.resources : input.project.resources,
        }
        : input;
    const project = collectProjectSources(projectInput, options);
    if (project.recognized) return project.drafts;
    if (input.sourceType || input.type || input.text !== undefined || input.content !== undefined || input.body !== undefined) {
        return makeChunk(input, input.sourceType ?? input.type ?? 'chapter', options, 0);
    }
    return [];
}

function isChunk(value) {
    return isObject(value) && typeof value.sourceType === 'string'
        && typeof value.sourceId === 'string' && Number.isFinite(Number(value.start))
        && Number.isFinite(Number(value.end)) && typeof value.text === 'string';
}

function normalizeChunk(value, index = 0) {
    const sourceType = canonicalSourceType(value.sourceType);
    const sourceId = cleanId(value.sourceId, `${sourceType}-${index + 1}`);
    const text = textValue(value.text);
    const start = Math.max(0, Math.floor(Number(value.start) || 0));
    const end = Math.max(start, Math.floor(Number(value.end) || start + text.length));
    // Hash is derived from the actual chunk bytes.  Ignoring a supplied hash
    // prevents stale metadata from surviving an incremental update.
    const hash = hashText(text);
    return {
        id: cleanId(value.id, `${sourceType}:${sourceId}:${start}-${end}:${hash}`),
        text,
        hash,
        start,
        end,
        sourceType,
        sourceId,
        chapterId: cleanId(value.chapterId) || null,
        volumeId: cleanId(value.volumeId) || null,
        chapterNumber: numberOrNull(value.chapterNumber),
        personIds: normalizeIdList(value.personIds),
        tags: normalizeTextList(value.tags),
        status: nonEmptyText(value.status).toLocaleLowerCase() || null,
        supersededById: cleanId(value.supersededById) || null,
        storyTime: value.storyTime ?? value.time ?? null,
        sequence: numberOrNull(value.sequence),
        factId: cleanId(value.factId) || (sourceType === 'fact' ? sourceId : null),
        knowledge: normalizeKnowledge(value.knowledge),
        sourceChapterIds: normalizeIdList(value.sourceChapterIds),
        sourceChapterNumbers: normalizeNumberList(value.sourceChapterNumbers),
        linkedFactIds: normalizeIdList(value.linkedFactIds ?? value.factIds),
        title: nonEmptyText(value.title) || null,
        entryId: cleanId(value.entryId) || null,
    };
}

/** Convert a project snapshot, source list, or source object into chunks. */
export function buildRetrievalChunks(input, options = {}) {
    const normalized = { ...DEFAULT_OPTIONS, ...options };
    const raw = isChunk(input)
        ? [normalizeChunk(input)]
        : Array.isArray(input) && input.length > 0 && input.every(isChunk)
        ? input.map(normalizeChunk)
        : collectSources(input, normalized);
    const seen = new Set();
    return raw.filter(chunk => {
        const normalizedChunk = normalizeChunk(chunk);
        if (!normalizedChunk.text.trim() || seen.has(normalizedChunk.id)) return false;
        seen.add(normalizedChunk.id);
        return true;
    }).map(normalizeChunk);
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
}

function lower(value) {
    return nonEmptyText(value).toLocaleLowerCase();
}

function valuesFrom(options, names) {
    for (const name of names) {
        if (options[name] !== undefined && options[name] !== null) return options[name];
    }
    return undefined;
}

function normalizedFilters(options = {}) {
    const nested = isObject(options.filters) ? options.filters : isObject(options.context) ? options.context : {};
    const merged = { ...nested, ...options };
    const include = valuesFrom(merged, ['manualInclude', 'manualIncludes', 'include', 'includeIds']);
    const exclude = valuesFrom(merged, ['manualExclude', 'manualExcludes', 'exclude', 'excludeIds']);
    const volumeIds = normalizeIdList(valuesFrom(merged, ['volumeIds', 'volumeId']));
    const personIds = normalizeIdList(valuesFrom(merged, ['personIds', 'personId', 'entityIds', 'entityId']));
    const chapterIds = normalizeIdList(valuesFrom(merged, ['chapterIds', 'chapterId']));
    const sourceTypes = normalizeTextList(valuesFrom(merged, ['sourceTypes', 'sourceType']))
        .map(canonicalSourceType);
    const factStatuses = new Set(normalizeTextList(valuesFrom(merged, ['factStatuses', 'factStatus', 'statuses', 'status'])).map(lower));
    const knowledge = valuesFrom(merged, ['povKnowledge', 'knowledge']);
    const povEntityId = cleanId(valuesFrom(merged, ['povEntityId', 'povId', 'pov'])) || null;
    const maxChapterNumber = numberOrNull(valuesFrom(merged, ['maxChapterNumber', 'throughChapterNumber', 'beforeChapterNumber', 'currentChapterNumber']));
    const minChapterNumber = numberOrNull(valuesFrom(merged, ['minChapterNumber', 'afterChapterNumber']));
    const time = valuesFrom(merged, ['timeRange', 'time']);
    return {
        ...merged,
        include: asArray(include),
        exclude: asArray(exclude),
        volumeIds,
        personIds,
        chapterIds,
        sourceTypes,
        factStatuses,
        knowledge,
        povEntityId,
        maxChapterNumber,
        minChapterNumber,
        time,
        includeSuperseded: Boolean(merged.includeSuperseded),
        excludeSuperseded: merged.excludeSuperseded !== false && !merged.includeSuperseded,
    };
}

function chunkReferenceMatches(chunk, reference) {
    if (isObject(reference)) {
        if (reference.id) return chunk.id === reference.id;
        if (reference.sourceType && canonicalSourceType(reference.sourceType) !== chunk.sourceType) return false;
        if (reference.sourceId && cleanId(reference.sourceId) !== chunk.sourceId) return false;
        return Boolean(reference.sourceType || reference.sourceId);
    }
    const value = cleanId(reference);
    if (!value) return false;
    return chunk.id === value || chunk.sourceId === value
        || `${chunk.sourceType}:${chunk.sourceId}` === value
        || (chunk.chapterId !== null && chunk.chapterId === value);
}

function inReferenceList(chunk, list) {
    return list.some(reference => chunkReferenceMatches(chunk, reference));
}

function chunkSuperseded(chunk) {
    return RETIRED_STATUSES.has(lower(chunk.status)) || Boolean(chunk.supersededById);
}

function chapterNumberFor(chunk) {
    return numberOrNull(chunk.chapterNumber);
}

function compareValue(value, target, direction = 1) {
    if (typeof value === 'number' && typeof target === 'number') return (value - target) * direction;
    const left = lower(value);
    const right = lower(target);
    return left.localeCompare(right) * direction;
}

function timeMatches(chunk, time) {
    if (!isObject(time)) return true;
    const chapterNumber = chapterNumberFor(chunk);
    const storyTime = chunk.storyTime;
    const from = time.from ?? time.after ?? time.min;
    const to = time.to ?? time.before ?? time.max;
    if (from !== undefined && from !== null) {
        if (chapterNumber !== null && numberOrNull(from) !== null) {
            if (chapterNumber < Number(from)) return false;
        } else if (storyTime !== null && compareValue(storyTime, from) < 0) return false;
    }
    if (to !== undefined && to !== null) {
        if (chapterNumber !== null && numberOrNull(to) !== null) {
            if (chapterNumber > Number(to)) return false;
        } else if (storyTime !== null && compareValue(storyTime, to) > 0) return false;
    }
    if (time.at !== undefined && time.at !== null) {
        if (chapterNumber !== null && numberOrNull(time.at) !== null) {
            if (chapterNumber !== Number(time.at)) return false;
        } else if (lower(storyTime) !== lower(time.at)) return false;
    }
    return true;
}

function knowledgeEdgesFor(chunk, filters) {
    const raw = filters.knowledge;
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw)) {
        if (raw.every(item => typeof item === 'string')) return raw.map(factId => ({ factId, stance: 'knows' }));
        return normalizeKnowledge(raw);
    }
    if (isObject(raw)) {
        if (Array.isArray(raw.edges)) return normalizeKnowledge(raw.edges);
        if (Array.isArray(raw.items)) return normalizeKnowledge(raw.items);
        const groupedStances = ['knows', 'suspects', 'believes', 'denies', 'hides'];
        if (groupedStances.some(stance => Array.isArray(raw[stance]))) {
            const grouped = [];
            for (const stance of groupedStances) {
                for (const item of raw[stance] ?? []) {
                    if (typeof item === 'string') grouped.push({ factId: item, stance, entityId: filters.povEntityId });
                    else if (isObject(item)) grouped.push({ ...item, stance: item.stance ?? stance });
                }
            }
            return normalizeKnowledge(grouped);
        }
        const edges = [];
        for (const [factId, stance] of Object.entries(raw)) {
            if (['entityId', 'povEntityId', 'factIds', 'edges', 'items'].includes(factId)) continue;
            edges.push({ factId, stance: typeof stance === 'string' ? stance : stance?.stance ?? 'knows', entityId: filters.povEntityId });
        }
        if (Array.isArray(raw.factIds)) edges.push(...raw.factIds.map(factId => ({ factId, stance: 'knows', entityId: filters.povEntityId })));
        return normalizeKnowledge(edges);
    }
    return [];
}

function chapterNumberFromMap(filters, chapterId) {
    if (!chapterId) return null;
    const source = filters.chapterNumberById;
    if (source instanceof Map) return numberOrNull(source.get(chapterId));
    if (isObject(source)) return numberOrNull(source[chapterId]);
    return null;
}

function knowledgeLearnedInRange(edge, filters) {
    if (filters.maxChapterNumber === null) return true;
    const explicit = numberOrNull(edge.learnedChapterNumber);
    if (explicit !== null) return explicit <= filters.maxChapterNumber;
    if (!edge.learnedChapterId) return true;
    const mapped = chapterNumberFromMap(filters, edge.learnedChapterId);
    // When a knowledge edge claims a chapter but that chapter cannot be
    // resolved, fail closed rather than treating it as timeless knowledge.
    return mapped !== null && mapped <= filters.maxChapterNumber;
}

function factAllowedByKnowledge(factId, edges, filters) {
    if (edges === null) return !filters.povEntityId;
    const candidates = edges.filter(edge => edge.factId === factId
        && (!filters.povEntityId || !edge.entityId || edge.entityId === filters.povEntityId)
        && !RETIRED_STATUSES.has(lower(edge.status))
        && knowledgeLearnedInRange(edge, filters));
    if (candidates.length === 0) return false;
    // A single protected edge is decisive.  A parallel `knows` edge must not
    // downgrade an explicit `hides` edge and leak the protected fact.
    if (candidates.some(edge => PRIVATE_KNOWLEDGE_STANCES.has(lower(edge.stance)))) return false;
    const allowedStances = normalizeTextList(filters.knowledgeStances ?? filters.allowedStances).map(lower);
    return allowedStances.length === 0 || candidates.some(edge => allowedStances.includes(lower(edge.stance)));
}

function memoryProvenanceInRange(chunk, filters) {
    if (filters.maxChapterNumber === null || chunk.sourceType !== 'memory') return true;
    for (const [index, chapterId] of chunk.sourceChapterIds.entries()) {
        const stored = numberOrNull(chunk.sourceChapterNumbers[index]);
        const number = stored ?? chapterNumberFromMap(filters, chapterId);
        // All provenance references must be known and at/before the current
        // chapter; checking only `memory.chapterId` can expose future facts.
        if (number === null || number > filters.maxChapterNumber) return false;
    }
    return true;
}

function passesDeterministicFilters(chunk, filters) {
    if (filters.sourceTypes.length > 0 && !filters.sourceTypes.includes(chunk.sourceType)) return false;
    if (filters.volumeIds.length > 0 && !filters.volumeIds.includes(chunk.volumeId)) return false;
    if (filters.chapterIds.length > 0 && !filters.chapterIds.includes(chunk.chapterId)) return false;
    if (filters.personIds.length > 0) {
        const ids = new Set(chunk.personIds);
        if (chunk.sourceType === 'character') ids.add(chunk.sourceId);
        if (![...ids].some(id => filters.personIds.includes(id))) return false;
    }
    if (filters.maxChapterNumber !== null) {
        const number = chapterNumberFor(chunk);
        if (number !== null && number > filters.maxChapterNumber) return false;
        if (number === null && chunk.chapterId !== null) return false;
    }
    if (filters.minChapterNumber !== null) {
        const number = chapterNumberFor(chunk);
        if (number !== null && number < filters.minChapterNumber) return false;
        if (number === null && chunk.chapterId !== null) return false;
    }
    if (!timeMatches(chunk, filters.time)) return false;
    if (!memoryProvenanceInRange(chunk, filters)) return false;
    if (filters.factStatuses.size > 0 && ['fact', 'memory'].includes(chunk.sourceType)
        && !filters.factStatuses.has(lower(chunk.status))) return false;
    if (filters.excludeSuperseded && chunkSuperseded(chunk)) return false;

    const edges = knowledgeEdgesFor(chunk, filters);
    if (edges !== null && chunk.sourceType === 'fact') {
        const factId = chunk.factId || chunk.sourceId;
        if (!factAllowedByKnowledge(factId, edges, filters)) return false;
    }
    if (filters.povEntityId && chunk.sourceType === 'fact' && edges === null) return false;
    if (chunk.sourceType === 'memory' && chunk.linkedFactIds.length > 0
        && !chunk.linkedFactIds.every(factId => factAllowedByKnowledge(factId, edges, filters))) return false;
    return true;
}

function safeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function bm25Score(queryTokens, chunk, index, options) {
    if (queryTokens.length === 0) return 0;
    const counts = new Map();
    for (const token of index.tokenizeChunk(chunk)) counts.set(token, (counts.get(token) ?? 0) + 1);
    const length = Math.max(1, index.documentLengths.get(chunk.id) ?? 1);
    const average = Math.max(1, index.averageDocumentLength);
    let score = 0;
    const seen = new Set();
    for (const token of queryTokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        const tf = counts.get(token) ?? 0;
        if (!tf) continue;
        const df = index.documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + ((index.chunks.size - df + 0.5) / (df + 0.5)));
        const denominator = tf + safeNumber(options.k1, DEFAULT_OPTIONS.k1)
            * (1 - safeNumber(options.b, DEFAULT_OPTIONS.b) + safeNumber(options.b, DEFAULT_OPTIONS.b) * (length / average));
        score += idf * ((tf * (safeNumber(options.k1, DEFAULT_OPTIONS.k1) + 1)) / denominator);
    }
    return score;
}

function resultSort(left, right) {
    if (left.manual !== right.manual) return left.manual ? -1 : 1;
    if (left.score !== right.score) return right.score - left.score;
    const typeDifference = (SOURCE_TYPE_ORDER.get(left.chunk.sourceType) ?? 99)
        - (SOURCE_TYPE_ORDER.get(right.chunk.sourceType) ?? 99);
    if (typeDifference) return typeDifference;
    if (left.chunk.sourceId !== right.chunk.sourceId) return left.chunk.sourceId.localeCompare(right.chunk.sourceId);
    if (left.chunk.start !== right.chunk.start) return left.chunk.start - right.chunk.start;
    return left.chunk.id.localeCompare(right.chunk.id);
}

function publicHit(chunk, score, reasons) {
    return {
        id: chunk.id,
        text: chunk.text,
        score,
        reason: reasons[0] ?? 'bm25',
        reasons,
        source: {
            key: `${chunk.sourceType}:${chunk.sourceId}`,
            sourceType: chunk.sourceType,
            sourceId: chunk.sourceId,
            chapterId: chunk.chapterId,
            volumeId: chunk.volumeId,
            title: chunk.title,
            entryId: chunk.entryId,
        },
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        sourceKey: `${chunk.sourceType}:${chunk.sourceId}`,
        chapterId: chunk.chapterId,
        volumeId: chunk.volumeId,
        start: chunk.start,
        end: chunk.end,
        hash: chunk.hash,
        metadata: {
            chapterNumber: chunk.chapterNumber,
            personIds: [...chunk.personIds],
            status: chunk.status,
            supersededById: chunk.supersededById,
            factId: chunk.factId,
            sourceChapterIds: [...chunk.sourceChapterIds],
            sourceChapterNumbers: [...chunk.sourceChapterNumbers],
            linkedFactIds: [...chunk.linkedFactIds],
            storyTime: chunk.storyTime,
            sequence: chunk.sequence,
            tags: [...chunk.tags],
        },
    };
}

export class RetrievalIndex {
    constructor(options = {}) {
        const snapshot = isObject(options) && Array.isArray(options.chunks) && options.schemaVersion !== undefined
            ? options
            : null;
        const initialSources = isObject(options) && options.initialSources !== undefined
            ? options.initialSources
            : null;
        this.options = { ...DEFAULT_OPTIONS, ...(snapshot?.options ?? options) };
        this.chunks = new Map();
        this.sourceChunks = new Map();
        this.documentFrequency = new Map();
        this.documentLengths = new Map();
        this.averageDocumentLength = 0;
        this._tokenCache = new Map();
        this.searchEngine = new MiniSearch({
            fields: ['text'],
            storeFields: [],
            tokenize,
        });
        if (snapshot) this.rebuild(snapshot.chunks);
        else if (initialSources !== null) this.rebuild(initialSources);
    }

    tokenizeChunk(chunk) {
        const existing = this._tokenCache.get(chunk.id);
        if (existing) return existing;
        const tokens = tokenize(chunk.text);
        this._tokenCache.set(chunk.id, tokens);
        return tokens;
    }

    _reindex() {
        this.documentFrequency.clear();
        this.documentLengths.clear();
        this._tokenCache.clear();
        this.searchEngine = new MiniSearch({
            fields: ['text'],
            storeFields: [],
            tokenize,
        });
        let total = 0;
        for (const chunk of this.chunks.values()) {
            const tokens = this.tokenizeChunk(chunk);
            this.documentLengths.set(chunk.id, tokens.length);
            total += tokens.length;
            for (const token of new Set(tokens)) this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        }
        if (this.chunks.size > 0) this.searchEngine.addAll([...this.chunks.values()].map(chunk => ({ id: chunk.id, text: chunk.text })));
        this.averageDocumentLength = this.chunks.size > 0 ? total / this.chunks.size : 0;
    }

    async _reindexAsync(batchSize = 500) {
        this.documentFrequency.clear();
        this.documentLengths.clear();
        this._tokenCache.clear();
        this.searchEngine = new MiniSearch({
            fields: ['text'],
            storeFields: [],
            tokenize,
        });
        const chunks = [...this.chunks.values()];
        const size = Math.max(1, Math.floor(Number(batchSize) || 500));
        let total = 0;
        for (let offset = 0; offset < chunks.length; offset += size) {
            for (const chunk of chunks.slice(offset, offset + size)) {
                const tokens = this.tokenizeChunk(chunk);
                this.documentLengths.set(chunk.id, tokens.length);
                total += tokens.length;
                for (const token of new Set(tokens)) {
                    this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
                }
            }
            if (offset + size < chunks.length) await new Promise(resolve => setImmediate(resolve));
        }
        if (chunks.length > 0) {
            await this.searchEngine.addAllAsync(
                chunks.map(chunk => ({ id: chunk.id, text: chunk.text })),
                { chunkSize: size },
            );
        }
        this.averageDocumentLength = chunks.length > 0 ? total / chunks.length : 0;
    }

    _removeChunk(id) {
        const chunk = this.chunks.get(id);
        if (!chunk) return false;
        this.chunks.delete(id);
        this._tokenCache.delete(id);
        const key = sourceKey(chunk.sourceType, chunk.sourceId);
        const ids = this.sourceChunks.get(key);
        if (ids) {
            ids.delete(id);
            if (ids.size === 0) this.sourceChunks.delete(key);
        }
        return true;
    }

    /** Upsert one source, source array, project snapshot, or normalized chunk array. */
    upsert(input, options = {}) {
        const chunks = buildRetrievalChunks(input, { ...this.options, ...options });
        const replaceSource = options.replaceSource !== false;
        const keys = new Set(chunks.map(chunk => sourceKey(chunk.sourceType, chunk.sourceId)));
        if (replaceSource) {
            for (const key of keys) {
                for (const id of [...(this.sourceChunks.get(key) ?? [])]) this._removeChunk(id);
            }
        }
        for (const chunk of chunks) {
            const normalized = normalizeChunk(chunk);
            this.chunks.set(normalized.id, normalized);
            const key = sourceKey(normalized.sourceType, normalized.sourceId);
            if (!this.sourceChunks.has(key)) this.sourceChunks.set(key, new Set());
            this.sourceChunks.get(key).add(normalized.id);
        }
        if (options.deferReindex !== true) this._reindex();
        return this.stats();
    }

    upsertSource(input, options = {}) {
        return this.upsert(input, options);
    }

    update(input, options = {}) {
        return this.upsert(input, options);
    }

    add(input, options = {}) {
        return this.upsert(input, options);
    }

    /** Remove chunk IDs, source IDs, source references, or chapter IDs. */
    remove(input, options = {}) {
        const references = Array.isArray(input) ? input : [input];
        const ids = [];
        for (const reference of references) {
            for (const chunk of this.chunks.values()) {
                if (chunkReferenceMatches(chunk, reference)) ids.push(chunk.id);
            }
        }
        for (const id of new Set(ids)) this._removeChunk(id);
        if (options.deferReindex !== true) this._reindex();
        return ids.length;
    }

    removeSource(input) {
        return this.remove(input);
    }

    removeChunk(input) {
        return this.remove(input);
    }

    delete(input) {
        return this.remove(input);
    }

    rebuild(input, options = {}) {
        this.chunks.clear();
        this.sourceChunks.clear();
        this.documentFrequency.clear();
        this.documentLengths.clear();
        this._tokenCache.clear();
        return this.upsert(input, { ...options, replaceSource: false });
    }

    batchRebuild(input, options = {}) {
        return this.rebuild(input, options);
    }

    rebuildAll(input, options = {}) {
        return this.rebuild(input, options);
    }

    clear() {
        return this.rebuild([]);
    }

    finalize() {
        this._reindex();
        return this.stats();
    }

    async finalizeAsync(batchSize = 500) {
        await this._reindexAsync(batchSize);
        return this.stats();
    }

    get(id) {
        const chunk = this.chunks.get(id);
        return chunk ? {
            ...chunk,
            personIds: [...chunk.personIds],
            tags: [...chunk.tags],
            knowledge: chunk.knowledge.map(edge => ({ ...edge })),
            sourceChapterIds: [...chunk.sourceChapterIds],
            sourceChapterNumbers: [...chunk.sourceChapterNumbers],
            linkedFactIds: [...chunk.linkedFactIds],
        } : null;
    }

    listChunks() {
        return [...this.chunks.values()].map(chunk => this.get(chunk.id));
    }

    getChunks() {
        return this.listChunks();
    }

    stats() {
        return {
            schemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
            documents: this.chunks.size,
            chunks: this.chunks.size,
            terms: this.documentFrequency.size,
            averageDocumentLength: this.averageDocumentLength,
        };
    }

    /**
     * Return an array of hits.  The array also exposes `.hits`, `.total`, and
     * `.diagnostics` for callers that prefer an envelope without forcing a
     * particular transport shape.
     */
    search(query = '', options = {}) {
        const filters = normalizedFilters({ ...this.options, ...options });
        const queryText = textValue(query);
        const queryTokens = tokenize(queryText);
        let engineCandidates = null;
        if (queryText.trim()) {
            try {
                engineCandidates = new Set(this.searchEngine.search(queryText).map(result => String(result.id)));
            } catch {
                engineCandidates = null;
            }
        }
        const candidates = [];
        for (const chunk of this.chunks.values()) {
            if (inReferenceList(chunk, filters.exclude)) continue;
            if (!passesDeterministicFilters(chunk, filters)) continue;
            const manual = inReferenceList(chunk, filters.include);
            if (!manual && engineCandidates && !engineCandidates.has(chunk.id)) continue;
            const score = bm25Score(queryTokens, chunk, this, filters);
            if (!manual && score <= 0) continue;
            const reasons = [];
            if (manual) reasons.push('manual-include');
            if (score > 0) reasons.push('bm25');
            candidates.push({ chunk, score, manual, reasons });
        }
        candidates.sort(resultSort);
        const limitValue = filters.maxResults ?? filters.limit ?? this.options.maxResults;
        const limit = Math.max(0, Math.floor(Number(limitValue) || 0));
        const selected = limit > 0 ? candidates.slice(0, limit) : [];
        const hits = selected.map(item => publicHit(item.chunk, item.score, item.reasons));
        Object.defineProperties(hits, {
            hits: { value: hits, enumerable: false },
            total: { value: candidates.length, enumerable: false },
            query: { value: queryText, enumerable: false },
            diagnostics: {
                value: {
                    queryTokens,
                    candidateCount: candidates.length,
                    returnedCount: hits.length,
                    manualIncluded: hits.filter(hit => hit.reasons.includes('manual-include')).map(hit => hit.id),
                    excluded: filters.exclude,
                },
                enumerable: false,
            },
        });
        return hits;
    }

    query(queryText = '', options = {}) {
        return this.search(queryText, options);
    }

    searchDetailed(queryText = '', options = {}) {
        const hits = this.search(queryText, options);
        return {
            query: hits.query,
            hits: [...hits],
            total: hits.total,
            diagnostics: hits.diagnostics,
        };
    }

    preview(queryText = '', options = {}) {
        return this.searchDetailed(queryText, options);
    }

    toJSON() {
        return {
            schemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
            options: { ...this.options },
            chunks: this.listChunks(),
        };
    }

    serialize() {
        return this.toJSON();
    }

    static fromJSON(value, options = {}) {
        if (!isObject(value)) throw new TypeError('Retrieval index snapshot must be an object.');
        if (value.schemaVersion !== undefined && value.schemaVersion !== RETRIEVAL_INDEX_SCHEMA_VERSION) {
            throw new TypeError('Unsupported retrieval index schema.');
        }
        const index = new RetrievalIndex({ ...(value.options ?? {}), ...options });
        index.rebuild(Array.isArray(value.chunks) ? value.chunks : []);
        return index;
    }

    static deserialize(value, options = {}) {
        return RetrievalIndex.fromJSON(value, options);
    }
}

export function createRetrievalIndex(optionsOrSources = {}, options = {}) {
    // Accept both createRetrievalIndex(options) and the convenient
    // createRetrievalIndex(sources, options) form used by small integrations.
    const looksLikeSources = Array.isArray(optionsOrSources)
        || (isObject(optionsOrSources) && (
            Array.isArray(optionsOrSources.sources)
            || Array.isArray(optionsOrSources.chapters)
            || Array.isArray(optionsOrSources.volumes)
            || Array.isArray(optionsOrSources.characters)
            || Array.isArray(optionsOrSources.lorebooks)
            || Array.isArray(optionsOrSources.facts)
            || isObject(optionsOrSources.storyState)
            || optionsOrSources.sourceType
            || optionsOrSources.text !== undefined
            || optionsOrSources.content !== undefined
        ));
    if (!looksLikeSources) return new RetrievalIndex(optionsOrSources);
    const index = new RetrievalIndex(options);
    index.rebuild(optionsOrSources);
    return index;
}

export function rebuildRetrievalIndex(input, options = {}) {
    return new RetrievalIndex(options).rebuild(input, options);
}

export { canonicalSourceType as normalizeSourceType, normalizeChunk };

export function searchRetrieval(index, query, options = {}) {
    if (!index || typeof index.search !== 'function') throw new TypeError('A RetrievalIndex is required.');
    return index.search(query, options);
}
