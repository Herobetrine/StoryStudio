import { assembleNovelPrompt } from './prompt-engine.js';

const STORY_LABELS = {
    logline: '一句话卖点',
    premise: '核心命题',
    protagonist: '主角与欲望',
    opposition: '对立力量',
    world: '世界规则',
    powerSystem: '力量体系',
    styleGuide: '文风约束',
    masterOutline: '总纲',
    forbidden: '禁写项',
};

const CARD_LABELS = {
    summary: '本章摘要',
    goal: '本章目标',
    conflict: '核心冲突',
    turn: '价值转折',
    hook: '章尾钩子',
    pov: '视角',
    time: '时间',
    location: '地点',
    required: '必须兑现',
    avoid: '必须避免',
};

const VOLUME_LABELS = {
    goal: '本卷目标',
    outline: '本卷纲要',
    summary: '本卷摘要',
};

export const PLAN_SCHEMA = {
    type: 'object',
    properties: Object.fromEntries(Object.keys(CARD_LABELS).map(key => [key, { type: 'string' }])),
    required: Object.keys(CARD_LABELS),
    additionalProperties: false,
};

export const CONTINUITY_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['character', 'setting', 'timeline', 'foreshadowing', 'item', 'relationship'] },
                    label: { type: 'string' },
                    detail: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'resolved', 'contradiction'] },
                },
                required: ['category', 'label', 'detail', 'status'],
                additionalProperties: false,
            },
        },
    },
    required: ['entries'],
    additionalProperties: false,
};

const ID_SCHEMA = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' };
const NULLABLE_ID_SCHEMA = { anyOf: [ID_SCHEMA, { type: 'null' }] };

function mutationSchema(properties, required) {
    return {
        type: 'object',
        properties: {
            upsert: {
                type: 'array',
                items: { type: 'object', properties, required, additionalProperties: false },
            },
            delete: { type: 'array', items: ID_SCHEMA },
        },
        required: ['upsert', 'delete'],
        additionalProperties: false,
    };
}

export const DISTILLATION_SCHEMA = {
    type: 'object',
    properties: {
        chapterSummary: { type: 'string' },
        storyStateChanges: {
            type: 'object',
            properties: {
                entities: mutationSchema({
                    id: ID_SCHEMA,
                    kind: { type: 'string' },
                    name: { type: 'string' },
                    summary: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    status: { type: 'string' },
                    locationEntityId: NULLABLE_ID_SCHEMA,
                    currentGoal: { type: 'string' },
                    currentAction: { type: 'string' },
                    updatedChapterId: NULLABLE_ID_SCHEMA,
                }, [
                    'id', 'kind', 'name', 'summary', 'aliases', 'status', 'locationEntityId',
                    'currentGoal', 'currentAction', 'updatedChapterId',
                ]),
                relations: mutationSchema({
                    id: ID_SCHEMA,
                    fromEntityId: ID_SCHEMA,
                    toEntityId: ID_SCHEMA,
                    kind: { type: 'string' },
                    summary: { type: 'string' },
                    status: { type: 'string' },
                    addressing: { type: 'string' },
                    publicSummary: { type: 'string' },
                    privateSummary: { type: 'string' },
                    sinceChapterId: NULLABLE_ID_SCHEMA,
                }, [
                    'id', 'fromEntityId', 'toEntityId', 'kind', 'summary', 'status', 'addressing',
                    'publicSummary', 'privateSummary', 'sinceChapterId',
                ]),
                events: mutationSchema({
                    id: ID_SCHEMA,
                    kind: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    chapterId: NULLABLE_ID_SCHEMA,
                    entityIds: { type: 'array', items: ID_SCHEMA },
                    status: { type: 'string' },
                    order: { type: 'integer', minimum: 0 },
                    timelineId: NULLABLE_ID_SCHEMA,
                    locationEntityId: NULLABLE_ID_SCHEMA,
                    progress: { type: 'integer', minimum: 0, maximum: 100 },
                    visibility: { type: 'string' },
                }, [
                    'id', 'kind', 'title', 'summary', 'chapterId', 'entityIds', 'status', 'order',
                    'timelineId', 'locationEntityId', 'progress', 'visibility',
                ]),
                promises: mutationSchema({
                    id: ID_SCHEMA,
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    introducedChapterId: NULLABLE_ID_SCHEMA,
                    dueChapterId: NULLABLE_ID_SCHEMA,
                    resolvedChapterId: NULLABLE_ID_SCHEMA,
                    status: { type: 'string' },
                    kind: { type: 'string' },
                    urgency: { type: 'integer', minimum: 0, maximum: 5 },
                    evidenceChapterIds: { type: 'array', items: ID_SCHEMA },
                }, [
                    'id', 'title', 'summary', 'introducedChapterId', 'dueChapterId', 'resolvedChapterId',
                    'status', 'kind', 'urgency', 'evidenceChapterIds',
                ]),
                memory: mutationSchema({
                    id: ID_SCHEMA,
                    kind: { type: 'string' },
                    summary: { type: 'string' },
                    chapterId: NULLABLE_ID_SCHEMA,
                    importance: { type: 'integer', minimum: 0, maximum: 5 },
                    tags: { type: 'array', items: { type: 'string' } },
                    status: { type: 'string' },
                    supersededById: NULLABLE_ID_SCHEMA,
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    sourceChapterIds: { type: 'array', items: ID_SCHEMA },
                }, [
                    'id', 'kind', 'summary', 'chapterId', 'importance', 'tags', 'status',
                    'supersededById', 'confidence', 'sourceChapterIds',
                ]),
                facts: mutationSchema({
                    id: ID_SCHEMA,
                    summary: { type: 'string' },
                    subjectEntityId: NULLABLE_ID_SCHEMA,
                    sourceChapterId: NULLABLE_ID_SCHEMA,
                    status: { type: 'string' },
                    supersededById: NULLABLE_ID_SCHEMA,
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    tags: { type: 'array', items: { type: 'string' } },
                }, [
                    'id', 'summary', 'subjectEntityId', 'sourceChapterId', 'status',
                    'supersededById', 'confidence', 'tags',
                ]),
                knowledge: mutationSchema({
                    id: ID_SCHEMA,
                    entityId: ID_SCHEMA,
                    factId: ID_SCHEMA,
                    stance: { type: 'string', enum: ['knows', 'suspects', 'believes', 'denies', 'hides'] },
                    learnedChapterId: NULLABLE_ID_SCHEMA,
                    status: { type: 'string' },
                }, ['id', 'entityId', 'factId', 'stance', 'learnedChapterId', 'status']),
                timeline: mutationSchema({
                    id: ID_SCHEMA,
                    label: { type: 'string' },
                    storyTime: { type: 'string' },
                    sequence: { type: 'integer', minimum: 0 },
                    chapterId: NULLABLE_ID_SCHEMA,
                    locationEntityId: NULLABLE_ID_SCHEMA,
                    status: { type: 'string' },
                }, ['id', 'label', 'storyTime', 'sequence', 'chapterId', 'locationEntityId', 'status']),
            },
            required: ['entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline'],
            additionalProperties: false,
        },
    },
    required: ['chapterSummary', 'storyStateChanges'],
    additionalProperties: false,
};

export const PENDING_CHANGESET_CATEGORIES = Object.freeze([
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
]);

const PENDING_CHANGESET_MUTATION_FIELDS = Object.freeze(['upsert', 'delete']);
const PENDING_CHANGESET_ROOT_FIELDS = Object.freeze(['chapterSummary', 'storyStateChanges']);
const PENDING_CHANGESET_LIMITS = Object.freeze({
    entities: 5_000,
    relations: 10_000,
    events: 20_000,
    promises: 5_000,
    memory: 10_000,
    facts: 20_000,
    knowledge: 20_000,
    timeline: 20_000,
});
const REQUIRED_NONEMPTY_FIELDS = Object.freeze({
    entities: ['kind', 'name'],
    relations: ['kind'],
    events: ['kind', 'title'],
    promises: ['title'],
    memory: ['kind', 'summary'],
    facts: ['summary'],
    knowledge: ['stance'],
    timeline: ['label'],
});

function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaValueError(value, schema, label) {
    if (Array.isArray(schema?.anyOf)) {
        const accepted = schema.anyOf.some(option => !schemaValueError(value, option, label));
        return accepted ? '' : `${label} 类型不正确`;
    }
    if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) {
        return `${label} 必须是 ${schema.enum.join('/')}`;
    }
    if (schema?.type === 'null') return value === null ? '' : `${label} 必须是 null`;
    if (schema?.type === 'string') {
        if (typeof value !== 'string') return `${label} 必须是字符串`;
        if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return `${label} 不是有效 ID`;
        return '';
    }
    if (schema?.type === 'integer') {
        if (!Number.isInteger(value)) return `${label} 必须是整数`;
    } else if (schema?.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} 必须是有限数字`;
    } else if (schema?.type === 'array') {
        if (!Array.isArray(value)) return `${label} 必须是数组`;
        for (const [index, item] of value.entries()) {
            const error = schemaValueError(item, schema.items, `${label}[${index}]`);
            if (error) return error;
        }
        if (value.every(item => ['string', 'number'].includes(typeof item))
            && new Set(value).size !== value.length) {
            return `${label} 不能包含重复值`;
        }
        return '';
    } else if (schema?.type === 'object' && !isPlainRecord(value)) {
        return `${label} 必须是对象`;
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) return `${label} 不能小于 ${schema.minimum}`;
        if (schema.maximum !== undefined && value > schema.maximum) return `${label} 不能大于 ${schema.maximum}`;
    }
    return '';
}

function unknownKeys(value, allowed) {
    const known = new Set(allowed);
    return Object.keys(value).filter(key => !known.has(key));
}

function firstDuplicate(values) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value)) return value;
        seen.add(value);
    }
    return '';
}

function recordSchema(category) {
    return DISTILLATION_SCHEMA.properties.storyStateChanges.properties[category]
        .properties.upsert.items;
}

function finalStoryStateProjection(storyState, changes) {
    return Object.fromEntries(PENDING_CHANGESET_CATEGORIES.map(category => {
        const records = Array.isArray(storyState?.[category]) ? storyState[category] : [];
        const byId = new Map(records.filter(isPlainRecord).map(record => [record.id, { ...record }]));
        for (const id of changes[category].delete) byId.delete(id);
        for (const patch of changes[category].upsert) {
            byId.set(patch.id, { ...(byId.get(patch.id) || {}), ...patch });
        }
        return [category, [...byId.values()]];
    }));
}

function supersessionWarnings(authority, projected, category) {
    const warnings = [];
    const projectedById = new Map(projected.map(record => [record.id, record]));
    for (const record of Array.isArray(authority) ? authority : []) {
        if (!record?.supersededById) continue;
        const next = projectedById.get(record.id);
        if (!next || next.supersededById !== record.supersededById) {
            warnings.push(`${category}.${record.id} 的既有取代审计链发生变化，服务端可能拒绝`);
        }
    }
    const nextById = new Map(projected.map(record => [record.id, record.supersededById || null]));
    for (const record of projected) {
        const seen = new Set();
        let nextId = record.id;
        while (nextId !== null && nextById.has(nextId)) {
            if (seen.has(nextId)) {
                warnings.push(`${category}.${record.id} 形成取代循环，服务端将拒绝`);
                break;
            }
            seen.add(nextId);
            nextId = nextById.get(nextId) || null;
        }
    }
    return warnings;
}

/**
 * Validates a browser-authored V5 ChangeSet without mutating the draft or authority.
 * The store remains authoritative for full normalization and audit enforcement.
 */
export function validatePendingChangeSetValue(value, {
    storyState = {},
    chapterIds = [],
    boundChapterId = '',
} = {}) {
    const errors = [];
    const warnings = [];
    const addError = message => {
        if (errors.length < 50 && !errors.includes(message)) errors.push(message);
    };
    if (!isPlainRecord(value)) {
        return { valid: false, errors: ['ChangeSet 根节点必须是对象'], warnings };
    }
    const rootUnknown = unknownKeys(value, PENDING_CHANGESET_ROOT_FIELDS);
    if (rootUnknown.length > 0) addError(`ChangeSet 包含未知字段：${rootUnknown.join(', ')}`);
    for (const field of PENDING_CHANGESET_ROOT_FIELDS) {
        if (!Object.hasOwn(value, field)) addError(`ChangeSet 缺少 ${field}`);
    }
    if (Object.hasOwn(value, 'chapterSummary') && typeof value.chapterSummary !== 'string') {
        addError('chapterSummary 必须是字符串');
    }
    const sourceChanges = value.storyStateChanges;
    if (!isPlainRecord(sourceChanges)) {
        addError('storyStateChanges 必须是对象');
        return { valid: false, errors, warnings };
    }
    const categoryUnknown = unknownKeys(sourceChanges, PENDING_CHANGESET_CATEGORIES);
    if (categoryUnknown.length > 0) addError(`storyStateChanges 包含未知分类：${categoryUnknown.join(', ')}`);

    const changes = {};
    for (const category of PENDING_CHANGESET_CATEGORIES) {
        const mutation = sourceChanges[category];
        const label = `storyStateChanges.${category}`;
        changes[category] = { upsert: [], delete: [] };
        if (!isPlainRecord(mutation)) {
            addError(`${label} 必须是对象`);
            continue;
        }
        const mutationUnknown = unknownKeys(mutation, PENDING_CHANGESET_MUTATION_FIELDS);
        if (mutationUnknown.length > 0) addError(`${label} 包含未知字段：${mutationUnknown.join(', ')}`);
        for (const field of PENDING_CHANGESET_MUTATION_FIELDS) {
            if (!Object.hasOwn(mutation, field)) addError(`${label} 缺少 ${field}`);
        }
        if (!Array.isArray(mutation.upsert)) addError(`${label}.upsert 必须是数组`);
        if (!Array.isArray(mutation.delete)) addError(`${label}.delete 必须是数组`);
        if (!Array.isArray(mutation.upsert) || !Array.isArray(mutation.delete)) continue;
        const maximum = PENDING_CHANGESET_LIMITS[category];
        if (mutation.upsert.length > maximum || mutation.delete.length > maximum) {
            addError(`${label} 每类最多允许 ${maximum} 项变更`);
        }

        const schema = recordSchema(category);
        const upsertIds = [];
        for (const [index, record] of mutation.upsert.entries()) {
            const recordLabel = `${label}.upsert[${index}]`;
            if (!isPlainRecord(record)) {
                addError(`${recordLabel} 必须是对象`);
                continue;
            }
            const recordUnknown = unknownKeys(record, Object.keys(schema.properties));
            if (recordUnknown.length > 0) addError(`${recordLabel} 包含未知字段：${recordUnknown.join(', ')}`);
            if (!Object.hasOwn(record, 'id')) addError(`${recordLabel} 缺少 id`);
            for (const [field, fieldValue] of Object.entries(record)) {
                if (!schema.properties[field]) continue;
                const error = schemaValueError(fieldValue, schema.properties[field], `${recordLabel}.${field}`);
                if (error) addError(error);
            }
            if (typeof record.id === 'string' && !schemaValueError(record.id, schema.properties.id, `${recordLabel}.id`)) {
                upsertIds.push(record.id);
                changes[category].upsert.push(record);
            }
        }
        const duplicatedUpsert = firstDuplicate(upsertIds);
        if (duplicatedUpsert) addError(`${label}.upsert 包含重复 ID：${duplicatedUpsert}`);

        const deleteSchema = DISTILLATION_SCHEMA.properties.storyStateChanges.properties[category]
            .properties.delete.items;
        const deleteIds = [];
        for (const [index, id] of mutation.delete.entries()) {
            const error = schemaValueError(id, deleteSchema, `${label}.delete[${index}]`);
            if (error) addError(error);
            else deleteIds.push(id);
        }
        const duplicatedDelete = firstDuplicate(deleteIds);
        if (duplicatedDelete) addError(`${label}.delete 包含重复 ID：${duplicatedDelete}`);
        const overlap = deleteIds.find(id => upsertIds.includes(id));
        if (overlap) addError(`${label} 不能同时 upsert 和 delete：${overlap}`);
        changes[category].delete = deleteIds;
    }
    if (errors.length > 0) return { valid: false, errors, warnings };

    const projected = finalStoryStateProjection(storyState, changes);
    for (const category of PENDING_CHANGESET_CATEGORIES) {
        const schema = recordSchema(category);
        const changedIds = new Set(changes[category].upsert.map(record => record.id));
        for (const record of projected[category].filter(item => changedIds.has(item.id))) {
            for (const field of schema.required) {
                if (!Object.hasOwn(record, field) || record[field] === undefined) {
                    addError(`storyState.${category}.${record.id} 合并后缺少 ${field}`);
                }
            }
            for (const [field, fieldValue] of Object.entries(record)) {
                if (!schema.properties[field]) continue;
                const error = schemaValueError(fieldValue, schema.properties[field], `storyState.${category}.${record.id}.${field}`);
                if (error) addError(error);
            }
            for (const field of REQUIRED_NONEMPTY_FIELDS[category]) {
                if (typeof record[field] === 'string' && !record[field].trim()) {
                    addError(`storyState.${category}.${record.id}.${field} 不能为空`);
                }
            }
        }
    }
    if (errors.length > 0) return { valid: false, errors, warnings };

    const ids = Object.fromEntries(PENDING_CHANGESET_CATEGORIES.map(category => [
        category,
        new Set(projected[category].map(record => record.id)),
    ]));
    const knownChapterIds = new Set(chapterIds.filter(id => typeof id === 'string'));
    if (boundChapterId && !knownChapterIds.has(boundChapterId)) addError('ChangeSet 绑定章节已不存在');
    const requireRef = (id, knownIds, label, nullable = true, ownerId = '') => {
        if ((id === null || id === undefined) && nullable) return;
        if (!knownIds.has(id)) addError(`${label} 引用了不存在的 ID：${id ?? 'null'}`);
        else if (ownerId && id === ownerId) addError(`${label} 不能引用自身`);
    };
    const chapterRef = (id, label) => requireRef(id, knownChapterIds, label);
    for (const item of projected.entities) {
        requireRef(item.locationEntityId, ids.entities, `entities.${item.id}.locationEntityId`);
        chapterRef(item.updatedChapterId, `entities.${item.id}.updatedChapterId`);
    }
    for (const item of projected.relations) {
        requireRef(item.fromEntityId, ids.entities, `relations.${item.id}.fromEntityId`, false);
        requireRef(item.toEntityId, ids.entities, `relations.${item.id}.toEntityId`, false);
        chapterRef(item.sinceChapterId, `relations.${item.id}.sinceChapterId`);
    }
    for (const item of projected.events) {
        chapterRef(item.chapterId, `events.${item.id}.chapterId`);
        for (const id of item.entityIds || []) requireRef(id, ids.entities, `events.${item.id}.entityIds`, false);
        requireRef(item.timelineId, ids.timeline, `events.${item.id}.timelineId`);
        requireRef(item.locationEntityId, ids.entities, `events.${item.id}.locationEntityId`);
    }
    for (const item of projected.promises) {
        chapterRef(item.introducedChapterId, `promises.${item.id}.introducedChapterId`);
        chapterRef(item.dueChapterId, `promises.${item.id}.dueChapterId`);
        chapterRef(item.resolvedChapterId, `promises.${item.id}.resolvedChapterId`);
        for (const id of item.evidenceChapterIds || []) chapterRef(id, `promises.${item.id}.evidenceChapterIds`);
    }
    for (const item of projected.memory) {
        chapterRef(item.chapterId, `memory.${item.id}.chapterId`);
        for (const id of item.sourceChapterIds || []) chapterRef(id, `memory.${item.id}.sourceChapterIds`);
        requireRef(item.supersededById, ids.memory, `memory.${item.id}.supersededById`, true, item.id);
    }
    for (const item of projected.facts) {
        requireRef(item.subjectEntityId, ids.entities, `facts.${item.id}.subjectEntityId`);
        chapterRef(item.sourceChapterId, `facts.${item.id}.sourceChapterId`);
        requireRef(item.supersededById, ids.facts, `facts.${item.id}.supersededById`, true, item.id);
    }
    for (const item of projected.knowledge) {
        requireRef(item.entityId, ids.entities, `knowledge.${item.id}.entityId`, false);
        requireRef(item.factId, ids.facts, `knowledge.${item.id}.factId`, false);
        chapterRef(item.learnedChapterId, `knowledge.${item.id}.learnedChapterId`);
    }
    for (const item of projected.timeline) {
        chapterRef(item.chapterId, `timeline.${item.id}.chapterId`);
        requireRef(item.locationEntityId, ids.entities, `timeline.${item.id}.locationEntityId`);
    }
    warnings.push(...supersessionWarnings(storyState.facts, projected.facts, 'facts'));
    warnings.push(...supersessionWarnings(storyState.memory, projected.memory, 'memory'));
    return { valid: errors.length === 0, errors, warnings, projected };
}

export function pendingChangeSetDraftStorageKey(projectId, chapterId) {
    if (!projectId || !chapterId) return '';
    return `story-studio:pending-changeset:${encodeURIComponent(projectId)}:${encodeURIComponent(chapterId)}`;
}

export function pendingChangeSetNavigationPolicy({ dirty = false, valid = false, adopting = false } = {}) {
    if (adopting) return 'block';
    if (!dirty) return 'continue';
    return valid ? 'save' : 'confirm-discard';
}

export const PLAN_GENERATION_SCHEMA = Object.freeze({
    name: 'story_studio_chapter_plan',
    description: 'A complete Story Studio chapter execution card.',
    strict: true,
    value: PLAN_SCHEMA,
});

export const CONTINUITY_GENERATION_SCHEMA = Object.freeze({
    name: 'story_studio_continuity',
    description: 'Continuity facts extracted from a Story Studio chapter.',
    strict: true,
    value: CONTINUITY_SCHEMA,
});

export const DISTILLATION_GENERATION_SCHEMA = Object.freeze({
    name: 'story_studio_distillation',
    description: 'A side-effect-free proposed change set extracted from one chapter candidate.',
    strict: true,
    value: DISTILLATION_SCHEMA,
});

const DEFAULT_GENERATION_PROMPT_CHARACTERS = 64_000;
const MAX_GENERATION_PROMPT_CHARACTERS = 1_000_000;
const MIN_GENERATION_PROMPT_CHARACTERS = 800;
const PROMPT_CONTEXT_SHARE = 0.6;
const STORY_CONTEXT_CHARACTERS = 3_000;
const VOLUME_CONTEXT_CHARACTERS = 4_000;
const CARD_CONTEXT_CHARACTERS = 1_800;
const PREVIOUS_SUMMARY_CHARACTERS = 800;
const PREVIOUS_TAIL_CHARACTERS = 1_200;
const MIN_DRAFT_RESPONSE_TOKENS = 1_024;
const MAX_DRAFT_RESPONSE_TOKENS = 32_000;
export const GENERATION_PROMPT_TOKEN_RESERVE = 256;

function clipStart(value, maximum) {
    const text = String(value ?? '').trim();
    if (text.length <= maximum) return text;
    const marker = '\n[后文因上下文预算省略]';
    if (maximum <= marker.length) return text.slice(0, maximum);
    return `${text.slice(0, maximum - marker.length)}${marker}`;
}

function clipEnd(value, maximum) {
    const text = String(value ?? '').trim();
    if (text.length <= maximum) return text;
    if (maximum <= 0) return '';
    const marker = '[前文因上下文预算省略]\n';
    if (maximum <= marker.length) return text.slice(-maximum);
    return `${marker}${text.slice(-(maximum - marker.length))}`;
}

function clipSection(value, maximum, clipContent) {
    const text = String(value ?? '').trim();
    const headingEnd = text.indexOf('\n');
    if (headingEnd < 0 || maximum <= headingEnd + 1) return clipStart(text, maximum);
    const heading = text.slice(0, headingEnd);
    const contentLimit = maximum - heading.length - 1;
    return `${heading}\n${clipContent(text.slice(headingEnd + 1), contentLimit)}`;
}

function clipMiddle(value, maximum) {
    const text = String(value ?? '').trim();
    if (text.length <= maximum) return text;
    if (maximum <= 0) return '';
    const marker = '\n[中段因上下文预算省略]\n';
    if (maximum <= marker.length) {
        const startLength = Math.ceil(maximum / 2);
        return `${text.slice(0, startLength)}${text.slice(-(maximum - startLength))}`;
    }
    const contentLength = maximum - marker.length;
    const startLength = Math.ceil(contentLength / 2);
    return `${text.slice(0, startLength)}${marker}${text.slice(-(contentLength - startLength))}`;
}

function formatFields(value, labels, totalLimit) {
    const entries = Object.entries(labels)
        .map(([key, label]) => ({ label, content: String(value?.[key] ?? '').trim() }))
        .filter(entry => entry.content);
    const headingLength = entries.reduce((sum, entry) => sum + entry.label.length + 5, 0);
    let remaining = Math.max(0, totalLimit - headingLength);
    return entries.map((entry, index) => {
        const share = Math.floor(remaining / (entries.length - index));
        const content = clipStart(entry.content, share);
        remaining -= content.length;
        return `## ${entry.label}\n${content}`;
    }).join('\n\n');
}

function formatFieldSection(value, labels, fields, heading, totalLimit) {
    const selectedLabels = Object.fromEntries(fields.map(field => [field, labels[field]]));
    const content = formatFields(value, selectedLabels, totalLimit);
    return content ? `# ${heading}\n${content}` : '';
}

function currentVolumeContext(project, chapter) {
    const volumeId = String(chapter?.volumeId ?? '').trim();
    if (!volumeId || !Array.isArray(project?.volumes)) return null;
    const volume = project.volumes.find(item => String(item?.id ?? '') === volumeId);
    if (!volume) return null;
    const title = String(volume.title ?? volume.name ?? '').trim() || '未命名卷';
    const details = formatFields(volume, VOLUME_LABELS, VOLUME_CONTEXT_CHARACTERS);
    return {
        volume,
        text: ['# 当前卷纲', `卷名：${clipStart(title, 160)}`, details].filter(Boolean).join('\n\n'),
    };
}

function renderedTopLevelSection(prompt, heading) {
    const source = String(prompt ?? '');
    const start = source.indexOf(heading);
    if (start < 0) return '';
    const remainder = source.slice(start);
    const boundary = remainder.slice(heading.length).search(/\n\n# /);
    return boundary < 0 ? remainder : remainder.slice(0, heading.length + boundary);
}

function diagnoseCurrentVolume(context, prompt) {
    if (!context) return null;
    const sourceText = escapeHostMacros(context.text);
    const renderedText = renderedTopLevelSection(prompt, '# 当前卷纲');
    return {
        id: 'currentVolume',
        volumeId: String(context.volume.id),
        source: 'project.volumes',
        reason: 'chapter-volume-id',
        characters: renderedText.length,
        originalCharacters: sourceText.length,
        tokens: renderedText ? estimateTokenCount(renderedText) : 0,
        originalTokens: estimateTokenCount(sourceText),
        included: renderedText.length > 0,
        truncated: renderedText !== sourceText,
    };
}

function escapeHostMacros(value) {
    return String(value ?? '')
        .replaceAll('{{', '{\u200B{');
}

function normalizedPromptCharacterLimit(value) {
    const limit = Math.floor(Number(value));
    if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_GENERATION_PROMPT_CHARACTERS;
    return Math.min(MAX_GENERATION_PROMPT_CHARACTERS, Math.max(MIN_GENERATION_PROMPT_CHARACTERS, limit));
}

function allocateSectionLimits(sections, totalLimit) {
    const limits = sections.map(() => 0);
    const schedule = sections.flatMap((section, index) => Array.from({ length: Math.max(1, Math.floor(section.weight || 1)) }, () => index));
    let remaining = Math.max(0, totalLimit);
    while (remaining > 0) {
        let allocated = false;
        for (const index of schedule) {
            if (remaining <= 0) break;
            if (limits[index] >= sections[index].text.length) continue;
            limits[index] += 1;
            remaining -= 1;
            allocated = true;
        }
        if (!allocated) break;
    }
    return limits;
}

function boundedPromptFromSections(inputSections, instructions, maximum = MAX_GENERATION_PROMPT_CHARACTERS) {
    const promptLimit = normalizedPromptCharacterLimit(maximum);
    const suffix = `\n\n${escapeHostMacros(instructions)}`;
    const sections = inputSections
        .map(section => ({
            text: escapeHostMacros(section?.text).trim(),
            weight: section?.weight,
            clip: section?.clip || clipStart,
        }))
        .filter(section => section.text);
    const separatorLength = Math.max(0, sections.length - 1) * 2;
    const sectionBudget = Math.max(0, promptLimit - suffix.length - separatorLength);
    const limits = allocateSectionLimits(sections, sectionBudget);
    const rendered = sections.map((section, index) => section.clip(section.text, limits[index])).filter(Boolean);
    return `${rendered.join('\n\n')}${suffix}`;
}

function schemaInstructions(schema) {
    return `# 输出 JSON Schema\n${JSON.stringify(schema)}`;
}

function draftResponseLength(targetWords) {
    const target = Number.isFinite(Number(targetWords)) ? Number(targetWords) : 3_000;
    return Math.min(MAX_DRAFT_RESPONSE_TOKENS, Math.max(MIN_DRAFT_RESPONSE_TOKENS, Math.ceil(target * 1.5)));
}

export function promptCharacterLimitForContext(contextTokens) {
    const context = Math.floor(Number(contextTokens));
    if (!Number.isFinite(context) || context <= GENERATION_PROMPT_TOKEN_RESERVE) {
        return MIN_GENERATION_PROMPT_CHARACTERS;
    }
    const proportionalLimit = Math.floor((context - GENERATION_PROMPT_TOKEN_RESERVE) * PROMPT_CONTEXT_SHARE);
    return normalizedPromptCharacterLimit(proportionalLimit);
}

export function fitGenerationBudget(contextTokens, promptTokens, desiredResponseTokens, {
    minimumResponseTokens = 256,
    reserveTokens = GENERATION_PROMPT_TOKEN_RESERVE,
} = {}) {
    const context = Math.floor(Number(contextTokens));
    const prompt = Math.ceil(Number(promptTokens));
    const desired = Math.floor(Number(desiredResponseTokens));
    const minimum = Math.max(1, Math.floor(Number(minimumResponseTokens)) || 1);
    const reserve = Math.max(0, Math.floor(Number(reserveTokens)) || 0);
    if (!Number.isFinite(context) || !Number.isFinite(prompt) || !Number.isFinite(desired)
        || context <= 0 || prompt < 0 || desired <= 0) {
        return 0;
    }
    const fitted = Math.min(desired, context - prompt - reserve);
    return fitted >= minimum ? fitted : 0;
}

export function nextPromptCharacterLimit(currentCharacters, contextTokens, promptTokens, minimumResponseTokens, {
    reserveTokens = GENERATION_PROMPT_TOKEN_RESERVE,
} = {}) {
    const current = normalizedPromptCharacterLimit(currentCharacters);
    const context = Math.floor(Number(contextTokens));
    const prompt = Math.ceil(Number(promptTokens));
    const minimum = Math.max(1, Math.floor(Number(minimumResponseTokens)) || 1);
    const reserve = Math.max(0, Math.floor(Number(reserveTokens)) || 0);
    const targetPromptTokens = context - reserve - minimum;
    if (!Number.isFinite(context) || !Number.isFinite(prompt) || prompt <= 0 || targetPromptTokens <= 0
        || prompt <= targetPromptTokens || current <= MIN_GENERATION_PROMPT_CHARACTERS) {
        return current;
    }
    const scaled = Math.floor(current * targetPromptTokens / prompt * 0.9);
    return Math.max(MIN_GENERATION_PROMPT_CHARACTERS, Math.min(current - 1, scaled));
}

export function countContentUnits(text) {
    const source = String(text ?? '');
    const chineseCharacters = source.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const otherWords = source
        .replace(/[\p{Script=Han}]/gu, ' ')
        .match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    return chineseCharacters + otherWords;
}

export function estimateTokenCount(text) {
    const source = String(text ?? '');
    const hanCharacters = source.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const compactNonHan = source
        .replace(/[\p{Script=Han}\s]/gu, '')
        .length;
    const baseEstimate = hanCharacters + Math.ceil(compactNonHan / 4);
    return Math.max(1, Math.ceil(baseEstimate * 1.15));
}

function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function getValueAtPath(value, fieldPath) {
    return String(fieldPath).split('.').reduce((current, key) => current?.[key], value);
}

export function mergeDirtyPaths(remote, local, fieldPaths) {
    const result = structuredClone(remote);
    for (const fieldPath of fieldPaths) {
        const keys = String(fieldPath).split('.');
        let target = result;
        let source = local;
        for (let index = 0; index < keys.length - 1; index++) {
            const key = keys[index];
            target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
            target = target[key];
            source = source?.[key];
        }
        const finalKey = keys.at(-1);
        target[finalKey] = structuredClone(source?.[finalKey]);
    }
    return result;
}

export function findConflictingPaths(base, remote, local, fieldPaths) {
    return [...fieldPaths].filter(fieldPath => {
        const baseValue = getValueAtPath(base, fieldPath);
        const remoteValue = getValueAtPath(remote, fieldPath);
        const localValue = getValueAtPath(local, fieldPath);
        return !valuesEqual(baseValue, remoteValue) && !valuesEqual(remoteValue, localValue);
    });
}

export function isContinuityPath(fieldPath) {
    return String(fieldPath).startsWith('continuityById.');
}

export function continuityView(project) {
    return {
        ...project,
        continuityById: Object.fromEntries((project?.continuity || []).map(entry => [entry.id, entry])),
    };
}

export function mergeProjectDirtyPaths(remoteProject, localProject, fieldPaths) {
    const directPaths = [...fieldPaths].filter(fieldPath => !isContinuityPath(fieldPath));
    const result = directPaths.length > 0
        ? mergeDirtyPaths(remoteProject, localProject, directPaths)
        : structuredClone(remoteProject);
    const entries = structuredClone(remoteProject.continuity || []);

    for (const fieldPath of fieldPaths) {
        if (!isContinuityPath(fieldPath)) continue;
        const [, entryId, field] = String(fieldPath).split('.');
        const localEntry = localProject.continuity?.find(entry => entry.id === entryId);
        const remoteIndex = entries.findIndex(entry => entry.id === entryId);
        if (!field) {
            if (!localEntry && remoteIndex >= 0) entries.splice(remoteIndex, 1);
            if (localEntry && remoteIndex >= 0) entries[remoteIndex] = structuredClone(localEntry);
            if (localEntry && remoteIndex === -1) entries.push(structuredClone(localEntry));
            continue;
        }
        if (!localEntry) continue;
        if (remoteIndex === -1) {
            entries.push(structuredClone(localEntry));
        } else {
            entries[remoteIndex][field] = structuredClone(localEntry[field]);
        }
    }

    result.continuity = entries;
    return result;
}

export function continuityDirtyPaths(before, after) {
    const previous = new Map((before || []).map(entry => [entry.id, entry]));
    const next = new Map((after || []).map(entry => [entry.id, entry]));
    const paths = [];
    for (const entryId of new Set([...previous.keys(), ...next.keys()])) {
        const left = previous.get(entryId);
        const right = next.get(entryId);
        if (!left || !right) {
            paths.push(`continuityById.${entryId}`);
            continue;
        }
        for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
            if (!valuesEqual(left[field], right[field])) {
                paths.push(`continuityById.${entryId}.${field}`);
            }
        }
    }
    return paths;
}

export function parseStructuredResponse(value) {
    const text = String(value ?? '').replace(/^\uFEFF/, '').trim();
    if (!text) return null;
    const candidates = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) candidates.push(fenced);
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next bounded JSON candidate.
        }
    }
    return null;
}

export function mergeContinuity(existing, extracted, chapterNumber, createId = () => crypto.randomUUID()) {
    const result = Array.isArray(existing) ? structuredClone(existing) : [];
    const entries = Array.isArray(extracted?.entries) ? extracted.entries : [];
    for (const entry of entries) {
        const label = String(entry?.label ?? '').trim();
        const category = String(entry?.category ?? 'setting').trim() || 'setting';
        if (!label) continue;
        const current = result.find(item => String(item.label).trim().toLocaleLowerCase() === label.toLocaleLowerCase() && item.category === category);
        if (current) {
            current.detail = String(entry.detail ?? current.detail).trim();
            current.status = String(entry.status ?? current.status ?? 'active').trim();
            current.lastTouchedChapter = chapterNumber;
            continue;
        }
        result.push({
            id: createId(),
            category,
            label,
            detail: String(entry.detail ?? '').trim(),
            status: String(entry.status ?? 'active').trim() || 'active',
            firstSeenChapter: chapterNumber,
            lastTouchedChapter: chapterNumber,
        });
    }
    return result;
}

export function safeFileName(value) {
    return String(value || 'story-studio')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 120) || 'story-studio';
}

export function buildGenerationRequest(kind, project, chapter, previousChapter = null, options = {}) {
    const promptCharacterLimit = normalizedPromptCharacterLimit(options?.promptCharacterLimit);
    const previousSummary = clipStart(previousChapter?.card?.summary || project?.chapters
        ?.find(item => item.number === chapter.number - 1)?.summary || '', PREVIOUS_SUMMARY_CHARACTERS);
    const previousTail = clipEnd(previousChapter?.content, PREVIOUS_TAIL_CHARACTERS);
    const workSection = `# 作品\n标题：${project?.title || '未命名作品'}\n类型：${project?.genre || '未设定'}\n目标总字数：${project?.targetWords || 0}\n单章目标字数：${project?.chapterTargetWords || 0}`;
    const storySections = [
        { text: formatFieldSection(project?.story, STORY_LABELS, ['forbidden'], '作品禁写项', STORY_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(project?.story, STORY_LABELS, ['styleGuide'], '作品文风约束', STORY_CONTEXT_CHARACTERS), weight: 3 },
        { text: formatFieldSection(project?.story, STORY_LABELS, ['world'], '世界规则', STORY_CONTEXT_CHARACTERS), weight: 3 },
        { text: formatFieldSection(project?.story, STORY_LABELS, ['powerSystem'], '力量体系', STORY_CONTEXT_CHARACTERS), weight: 3 },
        { text: formatFieldSection(project?.story, STORY_LABELS, ['masterOutline'], '作品总纲', STORY_CONTEXT_CHARACTERS), weight: 3 },
        { text: formatFieldSection(project?.story, STORY_LABELS, ['logline', 'premise', 'protagonist', 'opposition'], '故事核心', STORY_CONTEXT_CHARACTERS), weight: 3 },
    ];
    if (!storySections.some(section => section.text)) {
        storySections.push({ text: '# 作品设定\n（尚未填写作品设定）', weight: 1 });
    }
    const chapterSections = [
        { text: `# 当前章节\n章节：第${chapter?.number || 0}章 ${chapter?.title || ''}\n状态：${chapter?.status || 'planned'}`, weight: 2 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['goal'], '本章目标', CARD_CONTEXT_CHARACTERS), weight: 5 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['conflict'], '本章冲突', CARD_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['turn'], '本章转折', CARD_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['hook'], '本章钩子', CARD_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['required'], '本章必须兑现', CARD_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['avoid'], '本章必须避免', CARD_CONTEXT_CHARACTERS), weight: 4 },
        { text: formatFieldSection(chapter?.card, CARD_LABELS, ['summary', 'pov', 'time', 'location'], '本章摘要与时空', CARD_CONTEXT_CHARACTERS), weight: 2 },
    ];
    if (!chapterSections.slice(1).some(section => section.text)) {
        chapterSections.push({ text: '# 章纲\n（尚未填写章纲）', weight: 1 });
    }
    const volumeContext = options.omitCurrentVolume ? null : currentVolumeContext(project, chapter);
    const volumeSections = volumeContext
        ? [{ text: volumeContext.text, weight: 4, clip: (value, limit) => clipSection(value, limit, clipMiddle) }]
        : [];
    const previousSummarySection = previousSummary ? `# 上章摘要\n${clipStart(previousSummary, 4_000)}` : '';
    const previousTailSection = previousTail ? `# 上章结尾原文\n${previousTail}` : '';

    if (kind === 'plan') {
        return {
            systemPrompt: '你是严谨的中文长篇网文章节设计编辑。根据已给事实规划一个可执行章节闭环。不得把建议伪装成既有设定，不得扩写正文。只返回符合 JSON Schema 的对象。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                ...storySections,
                { text: workSection, weight: 1 },
                { text: previousSummarySection, weight: 1 },
                { text: previousTailSection, weight: 1, clip: (value, limit) => clipSection(value, limit, clipEnd) },
            ], `请完成当前章纲。目标、冲突、转折和钩子必须构成因果链；required 写本章必须兑现的信息，avoid 写必须避免的跑偏。\n\n${schemaInstructions(PLAN_SCHEMA)}`, promptCharacterLimit),
            responseLength: 1_500,
            minimumResponseLength: 256,
            jsonSchema: PLAN_GENERATION_SCHEMA,
        };
    }

    if (kind === 'draft') {
        const existingContent = String(chapter?.content ?? '').trim();
        const instructions = existingContent
            ? `请从已有正文之后续写第${chapter.number}章。本章完整目标约 ${project?.chapterTargetWords || 3_000} 字，本次只输出可直接追加的续写片段；不要复述、改写或重新开始已有正文。继续兑现章纲并保持因果连续。若单次输出不足全章，在自然停顿处收束，不要为了完结强行跳过事件。不要擅自新增会改变世界底层规则的永久设定。`
            : `请从第${chapter.number}章开头写一段可直接采用的正文候选。本章完整目标约 ${project?.chapterTargetWords || 3_000} 字。承接上章结尾并兑现章纲；若单次输出不足全章，在自然停顿处收束，不要为了完结强行跳过事件。不要擅自新增会改变世界底层规则的永久设定。`;
        return {
            systemPrompt: '你是成熟的中文网文作者。严格服从作品设定和章纲，写出有动作、有选择、有结果的正文段落，并保持章节事件链方向。只输出可直接采用的正文，不解释写法，不输出提纲，不添加 Markdown 标题。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                { text: existingContent ? `# 已有正文结尾\n${existingContent}` : '', weight: 4, clip: (value, limit) => clipSection(value, limit, clipEnd) },
                { text: previousTailSection, weight: 3, clip: (value, limit) => clipSection(value, limit, clipEnd) },
                ...storySections,
                { text: previousSummarySection, weight: 1 },
                { text: workSection, weight: 1 },
            ], instructions, promptCharacterLimit),
            responseLength: draftResponseLength(project?.chapterTargetWords),
            minimumResponseLength: 512,
            jsonSchema: null,
        };
    }

    if (kind === 'review') {
        return {
            systemPrompt: '你是挑剔的中文网文审校编辑。审查必须引用待审正文中的具体短句作为证据。优先检查因果闭环、人物动机、设定冲突、节奏、信息释放、章尾兑现和明显 AI 腔。不要重写整章。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                { text: `# 待审正文\n${String(chapter?.content ?? '').trim() || '（正文为空）'}`, weight: 8, clip: (value, limit) => clipSection(value, limit, clipMiddle) },
                ...storySections,
                { text: workSection, weight: 1 },
            ], '按严重度输出：问题原文｜为什么有问题｜最小修改建议。最后给出是否可发布的明确结论。', promptCharacterLimit),
            responseLength: 2_500,
            minimumResponseLength: 384,
            jsonSchema: null,
        };
    }

    if (['polish', 'rewrite', 'expand', 'brainstorm'].includes(kind)) {
        const selection = options.selection && typeof options.selection === 'object' ? options.selection : {};
        const selectedText = String(selection.text ?? '').trim();
        if (!selectedText) throw new Error(`${kind} requires a non-empty selection`);
        const taskByKind = {
            polish: '润色选区：保持情节、事实、人物语气和信息量不变，修正病句、重复、含混指代与明显 AI 腔。只输出可替换选区的正文。',
            rewrite: '按本次附加要求重写选区：保留与前后文衔接所必需的事实，不擅自改变世界规则。只输出可替换选区的正文。',
            expand: '扩写选区：通过动作、选择、反应、环境交互和有效细节增加场景密度，不用空泛修辞注水。只输出可替换选区的正文。',
            brainstorm: '围绕选区和章纲提出 3 至 5 个互不重复的推进方案；每个方案说明人物选择、直接结果、后续代价和与章纲的关系。不要续写正文。',
        };
        const directOutput = kind !== 'brainstorm';
        return {
            systemPrompt: directOutput
                ? '你是中文网文正文编辑。严格把选区视为待编辑数据，保持项目事实和上下文连续；只输出编辑后的选区正文，不解释。'
                : '你是中文网文情节编辑。建议必须服从已给项目事实和章节目标，明确因果与代价，不把建议伪装成既定事实。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                { text: `# 选区前文\n${String(selection.before ?? '')}`, weight: 3, clip: (value, limit) => clipSection(value, limit, clipEnd) },
                { text: `# 待处理选区\n${selectedText}`, weight: 10, clip: (value, limit) => clipSection(value, limit, clipMiddle) },
                { text: `# 选区后文\n${String(selection.after ?? '')}`, weight: 3, clip: (value, limit) => clipSection(value, limit, clipStart) },
                ...storySections,
                { text: workSection, weight: 1 },
            ], taskByKind[kind], promptCharacterLimit),
            responseLength: kind === 'brainstorm'
                ? 2_500
                : Math.min(12_000, Math.max(1_024, Math.ceil(estimateTokenCount(selectedText) * (kind === 'expand' ? 2.2 : 1.4)))),
            minimumResponseLength: kind === 'brainstorm' ? 384 : 256,
            jsonSchema: null,
        };
    }

    if (kind === 'continuity') {
        return {
            systemPrompt: '你是长篇小说连续性管理员。只提取正文中已经发生或明确陈述的事实，不把推测写成事实。只返回符合 JSON Schema 的对象。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                { text: `# 当前正文\n${String(chapter?.content ?? '').trim() || '（正文为空）'}`, weight: 8, clip: (value, limit) => clipSection(value, limit, clipMiddle) },
                ...storySections,
                { text: workSection, weight: 1 },
            ], `提取本章新增或改变的角色状态、设定、时间线、伏笔、物品和关系。若正文与既有设定冲突，将 status 标为 contradiction。\n\n${schemaInstructions(CONTINUITY_SCHEMA)}`, promptCharacterLimit),
            responseLength: 2_000,
            minimumResponseLength: 256,
            jsonSchema: CONTINUITY_GENERATION_SCHEMA,
        };
    }

    if (kind === 'distill') {
        const sourceContent = String(options.sourceContent ?? chapter?.content ?? '').trim();
        return {
            systemPrompt: '你是长篇小说状态蒸馏器。只提取候选正文中已经发生或明确陈述的事实，并输出待人工确认的 ChangeSet。复用已存在对象的稳定 ID；新 ID 只能使用英文字母、数字、下划线或连字符。不得修改正式数据，不得把推测写成客观事实。',
            prompt: boundedPromptFromSections([
                ...chapterSections,
                ...volumeSections,
                { text: `# 待蒸馏候选正文\n${sourceContent || '（候选正文为空）'}`, weight: 12, clip: (value, limit) => clipSection(value, limit, clipMiddle) },
                { text: project?.storyState ? `# 既有类型化故事状态\n${JSON.stringify(project.storyState)}` : '', weight: 3, clip: (value, limit) => clipSection(value, limit, clipMiddle) },
                ...storySections,
                { text: workSection, weight: 1 },
            ], [
                '为本章生成简洁摘要，并提出八类故事状态的 upsert/delete：实体、关系、事件、待兑现事项、分层记忆、事实、人物知识与时间线。',
                '事实层只记录候选正文已发生或明确陈述的客观信息；每条新增事实必须标记来源章节和置信度。',
                '人物知识边界必须单独写入 knowledge：区分 knows、suspects、believes、denies、hides，禁止因读者或叙述者知道某事就让角色自动知道。',
                '时间线记录故事内时间、稳定 sequence、发生章节与地点；幕后事件也要写入 events，并用 visibility 表示可见范围。',
                '历史事实、记忆和待兑现事项不得因状态变化而删除。被新信息取代时，upsert 旧记录为 superseded/retired，并通过 supersededById 指向新记录；已解决事项应 upsert 为 resolved。',
                '默认所有 delete 都为空；delete 只用于清理明确无效且无历史价值的误生成记录。',
                `所有 chapterId 及 chapterIds 只能使用当前项目中已有章节 ID；本章 ID 是 ${chapter?.id || 'unknown'}。`,
                schemaInstructions(DISTILLATION_SCHEMA),
            ].join('\n\n'), promptCharacterLimit),
            responseLength: 6_000,
            minimumResponseLength: 512,
            jsonSchema: DISTILLATION_GENERATION_SCHEMA,
        };
    }

    throw new Error(`Unsupported generation kind: ${kind}`);
}

function characterForPromptEngine(character) {
    if (!character || typeof character !== 'object') return character;
    return {
        ...character,
        first_mes: character.openingSample ?? character.first_mes ?? '',
        mes_example: character.dialogueExamples ?? character.mes_example ?? '',
        creator_notes: character.creatorNotes ?? character.creator_notes ?? '',
        system_prompt: character.instructionEnabled === false
            ? ''
            : character.instruction ?? character.system_prompt ?? '',
        post_history_instructions: character.postInstruction ?? character.post_history_instructions ?? '',
        alternate_greetings: character.openingSamples ?? character.alternate_greetings ?? [],
        character_version: character.characterVersion ?? character.character_version ?? '',
    };
}

function activePromptProfile(resources) {
    if (resources?.promptProfile && typeof resources.promptProfile === 'object') return resources.promptProfile;
    const profiles = Array.isArray(resources?.promptProfiles) ? resources.promptProfiles : [];
    return profiles.find(profile => profile?.active === true) ?? profiles[0] ?? null;
}

function profileBaseSections(profile) {
    const prompts = Array.isArray(profile?.chatCompletion?.prompts)
        ? profile.chatCompletion.prompts.map(item => ({
            ...item,
            id: item?.id ?? item?.identifier ?? item?.name,
            template: item?.template ?? item?.content ?? item?.text ?? '',
        }))
        : [];
    const sections = Object.fromEntries(prompts
        .filter(item => item.id)
        .map(item => [item.id, item]));
    const storyString = profile?.context?.story_string;
    if (storyString && !sections.main) sections.main = { template: storyString, includeData: true };
    return sections;
}

function transportForProvider(provider) {
    return ['openai-completions', 'llamacpp-completion'].includes(provider?.protocol) ? 'text' : 'chat';
}

const PROFILE_GENERATION_FIELDS = [
    'stop',
    'temperature',
    'topP',
    'topK',
    'topA',
    'minP',
    'frequencyPenalty',
    'presencePenalty',
    'repetitionPenalty',
    'seed',
    'assistantPrefill',
];

function profileGenerationRequest(profile, assembled) {
    const generation = assembled?.generation && typeof assembled.generation === 'object'
        ? assembled.generation
        : (profile?.generation ?? {});
    const result = Object.fromEntries(PROFILE_GENERATION_FIELDS
        .filter(field => generation[field] !== undefined)
        .map(field => [field, generation[field]]));
    const configuredPrefill = profile?.startReplyWith?.show === false
        ? ''
        : profile?.startReplyWith?.value;
    if (result.assistantPrefill === undefined && configuredPrefill) {
        result.assistantPrefill = configuredPrefill;
    }
    return result;
}

function adjacentChapterContext(nextChapter) {
    if (!nextChapter) return '';
    return [
        '# 下一章约束（仅用于控制本章收束，不得提前写完）',
        `章节：第${nextChapter.number ?? 0}章 ${nextChapter.title ?? ''}`,
        nextChapter.card ? JSON.stringify(nextChapter.card) : '',
    ].filter(Boolean).join('\n');
}

/**
 * Applies active character cards, lorebooks, prompt profiles, typed story state,
 * and adjacent chapter constraints to the task-specific generation request.
 */
export function buildContextualGenerationRequest(kind, project, chapter, previousChapter = null, options = {}) {
    const promptCharacterLimit = normalizedPromptCharacterLimit(options.promptCharacterLimit);
    const volumeContext = currentVolumeContext(project, chapter);
    const base = buildGenerationRequest(kind, project, chapter, previousChapter, {
        promptCharacterLimit,
        sourceContent: options.sourceContent,
        selection: options.selection,
        omitCurrentVolume: true,
    });
    const sourceResources = options.resources && typeof options.resources === 'object' ? options.resources : {};
    const profile = activePromptProfile(sourceResources);
    const characters = (Array.isArray(sourceResources.characters) ? sourceResources.characters : [])
        .map(characterForPromptEngine);
    const continuityPreflight = options.continuityPreflight && typeof options.continuityPreflight === 'object'
        ? options.continuityPreflight
        : null;
    const taskSections = [
        { id: 'base', text: base.prompt, weight: 10, clip: 'middle' },
        { id: 'nextChapter', text: adjacentChapterContext(options.nextChapter), weight: 3, clip: 'middle' },
        {
            id: 'currentVolume',
            text: volumeContext ? escapeHostMacros(volumeContext.text) : '',
            weight: 7,
            clip: 'middle',
        },
        {
            id: 'storyState',
            text: (options.storyState ?? project?.storyState)
                ? `# 类型化故事状态\n${JSON.stringify(options.storyState ?? project.storyState)}`
                : '',
            weight: 5,
            clip: 'middle',
        },
        {
            id: 'continuityPreflight',
            text: continuityPreflight
                ? `# 连续性预检\n${escapeHostMacros(JSON.stringify(continuityPreflight, null, 2))}`
                : '',
            weight: 11,
            clip: 'middle',
        },
        {
            id: 'retrieval',
            text: options.retrievalContext
                ? escapeHostMacros(String(options.retrievalContext))
                : '',
            weight: 8,
            clip: 'middle',
        },
        {
            id: 'additionalInstruction',
            text: options.additionalInstruction ? `# 本次附加要求\n${String(options.additionalInstruction)}` : '',
            weight: 12,
            clip: 'middle',
        },
        {
            id: 'continuation',
            text: options.continuationContent ? `# 待继续的候选正文\n${String(options.continuationContent)}` : '',
            weight: 12,
            clip: 'middle',
        },
    ].filter(section => section.text);
    const task = taskSections.map(section => section.text).join('\n\n');
    const promptResources = {
        ...sourceResources,
        characters,
        lorebooks: Array.isArray(sourceResources.lorebooks) ? sourceResources.lorebooks : [],
        continuityLedger: project?.continuity ?? [],
        task,
        taskSections,
        taskKind: kind,
        retrievalContext: options.retrievalContext ?? '',
        postInstruction: profile?.systemPrompt?.post_history ?? sourceResources.postInstruction ?? '',
    };
    const profileV2 = profile?.profileVersion === 2;
    const configuredSystem = profile?.systemPrompt?.enabled === false ? '' : profile?.systemPrompt?.content ?? '';
    const provider = {
        ...(options.provider || {}),
        transport: options.provider?.transport ?? transportForProvider(options.provider),
        instruct: profile?.instruct ?? options.provider?.instruct,
    };
    const assembled = assembleNovelPrompt({
        baseSystemPrompt: profileV2 ? base.systemPrompt : (configuredSystem || base.systemPrompt),
        baseSections: profileV2 ? {} : profileBaseSections(profile),
        project,
        chapter,
        previousChapter,
        resources: promptResources,
        provider,
        promptLimit: promptCharacterLimit,
    });
    const currentVolumeDiagnostic = diagnoseCurrentVolume(volumeContext, assembled.prompt);
    const diagnostics = {
        ...assembled.diagnostics,
        transport: assembled.transport,
        activeCharacterIds: characters.map(character => character.id).filter(Boolean),
        activeLorebookIds: promptResources.lorebooks.map(book => book?.id).filter(Boolean),
        activePromptProfileId: profile?.id ?? null,
        activePersonaId: promptResources.persona?.id ?? null,
        taskSections: taskSections.map(section => ({ id: section.id })),
        ...(continuityPreflight ? { continuityPreflight } : {}),
    };
    if (currentVolumeDiagnostic) {
        diagnostics.currentVolume = currentVolumeDiagnostic;
        diagnostics.blocks = {
            ...diagnostics.blocks,
            currentVolume: currentVolumeDiagnostic,
        };
    }
    const textTransport = assembled.transport === 'text' && assembled.serializedPrompt;
    return {
        ...base,
        systemPrompt: textTransport ? '' : assembled.systemPrompt,
        prompt: textTransport ? assembled.serializedPrompt : assembled.prompt,
        ...(!textTransport && Array.isArray(assembled.messages) ? { messages: assembled.messages } : {}),
        ...profileGenerationRequest(profile, assembled),
        ...(assembled.generation ? { profileGeneration: assembled.generation } : {}),
        ...(assembled.profileHash ? { profileHash: assembled.profileHash } : {}),
        diagnostics,
    };
}
