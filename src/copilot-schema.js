import { createHash } from 'node:crypto';

import { ApiError } from './api-error.js';

export const COPILOT_SCHEMA_VERSION = 1;

const ID_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$';
const ID = new RegExp(ID_PATTERN, 'u');
const EVIDENCE_ID = /^evidence_[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_TEXT = 100_000;
const MAX_EVIDENCE_REFERENCES = 64;
const SETTING_FIELDS = Object.freeze({
    'project-story': new Set(['world', 'powerSystem', 'masterOutline', 'forbidden']),
    volume: new Set(['goal', 'outline', 'summary']),
    'chapter-card': new Set([
        'summary', 'goal', 'conflict', 'turn', 'hook', 'pov', 'time', 'location', 'required', 'avoid',
    ]),
});
const LORE_PATCH_FIELDS = Object.freeze([
    'keys', 'secondaryKeys', 'comment', 'content', 'enabled', 'constant',
]);

const schemaId = Object.freeze({ type: 'string', pattern: ID_PATTERN });
const schemaEvidenceIds = Object.freeze({
    type: 'array',
    minItems: 1,
    maxItems: MAX_EVIDENCE_REFERENCES,
    uniqueItems: true,
    items: Object.freeze({ type: 'string', pattern: '^evidence_[0-9a-f]{40}$' }),
});
const nullableString = Object.freeze({ anyOf: [{ type: 'string' }, { type: 'null' }] });
const nullableBoolean = Object.freeze({ anyOf: [{ type: 'boolean' }, { type: 'null' }] });
const nullableStringArray = Object.freeze({
    anyOf: [
        { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string' } },
        { type: 'null' },
    ],
});

export const COPILOT_RESPONSE_SCHEMA = Object.freeze({
    name: 'story_studio_planning_copilot',
    description: 'A side-effect-free planning bundle with mutually exclusive directions and typed candidate edits.',
    strict: true,
    value: {
        type: 'object',
        properties: {
            schemaVersion: { type: 'integer', enum: [COPILOT_SCHEMA_VERSION] },
            plotOptions: {
                type: 'array',
                minItems: 3,
                maxItems: 6,
                items: {
                    type: 'object',
                    properties: {
                        id: schemaId,
                        title: { type: 'string' },
                        commitment: { type: 'string' },
                        summary: { type: 'string' },
                        eventChain: {
                            type: 'array',
                            minItems: 3,
                            maxItems: 12,
                            items: {
                                type: 'object',
                                properties: {
                                    order: { type: 'integer', minimum: 1, maximum: 12 },
                                    event: { type: 'string' },
                                    characterChoice: { type: 'string' },
                                    directResult: { type: 'string' },
                                    cost: { type: 'string' },
                                },
                                required: ['order', 'event', 'characterChoice', 'directResult', 'cost'],
                                additionalProperties: false,
                            },
                        },
                        hook: { type: 'string' },
                        risks: { type: 'array', maxItems: 12, items: { type: 'string' } },
                        evidenceIds: schemaEvidenceIds,
                    },
                    required: [
                        'id', 'title', 'commitment', 'summary', 'eventChain', 'hook', 'risks', 'evidenceIds',
                    ],
                    additionalProperties: false,
                },
            },
            settingEdits: {
                type: 'array',
                maxItems: 50,
                items: {
                    type: 'object',
                    properties: {
                        id: schemaId,
                        appliesToOptionIds: { type: 'array', maxItems: 6, uniqueItems: true, items: schemaId },
                        target: {
                            type: 'object',
                            properties: {
                                kind: { type: 'string', enum: ['project-story', 'volume', 'chapter-card'] },
                                id: schemaId,
                                field: { type: 'string' },
                            },
                            required: ['kind', 'id', 'field'],
                            additionalProperties: false,
                        },
                        proposedValue: { type: 'string' },
                        rationale: { type: 'string' },
                        evidenceIds: schemaEvidenceIds,
                    },
                    required: ['id', 'appliesToOptionIds', 'target', 'proposedValue', 'rationale', 'evidenceIds'],
                    additionalProperties: false,
                },
            },
            lorebookEdits: {
                type: 'array',
                maxItems: 50,
                items: {
                    type: 'object',
                    properties: {
                        id: schemaId,
                        appliesToOptionIds: { type: 'array', maxItems: 6, uniqueItems: true, items: schemaId },
                        operation: { type: 'string', enum: ['create', 'update', 'delete'] },
                        lorebookId: schemaId,
                        entryId: schemaId,
                        patch: {
                            type: 'object',
                            properties: {
                                keys: nullableStringArray,
                                secondaryKeys: nullableStringArray,
                                comment: nullableString,
                                content: nullableString,
                                enabled: nullableBoolean,
                                constant: nullableBoolean,
                            },
                            required: LORE_PATCH_FIELDS,
                            additionalProperties: false,
                        },
                        rationale: { type: 'string' },
                        evidenceIds: schemaEvidenceIds,
                    },
                    required: [
                        'id', 'appliesToOptionIds', 'operation', 'lorebookId', 'entryId', 'patch',
                        'rationale', 'evidenceIds',
                    ],
                    additionalProperties: false,
                },
            },
        },
        required: ['schemaVersion', 'plotOptions', 'settingEdits', 'lorebookEdits'],
        additionalProperties: false,
    },
});

function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function fail(message, code = 'invalid_copilot_output', details = {}) {
    throw new ApiError(502, code, message, details);
}

function assertObject(value, label) {
    if (!isObject(value)) fail(`${label} must be an object.`, 'invalid_copilot_output', { field: label });
    return value;
}

function assertExactFields(value, fields, label) {
    assertObject(value, label);
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    const missing = fields.filter(field => !Object.hasOwn(value, field));
    if (unknown.length > 0 || missing.length > 0) {
        fail(`${label} fields are invalid.`, 'invalid_copilot_output', {
            field: label,
            unknown: unknown.sort(),
            missing: missing.sort(),
        });
    }
}

function safeClone(value) {
    try {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json, 'utf8') > 8 * 1024 * 1024) {
            fail('Copilot output is too large.', 'copilot_output_too_large');
        }
        const clone = JSON.parse(json);
        const stack = [clone];
        while (stack.length > 0) {
            const item = stack.pop();
            if (!item || typeof item !== 'object') continue;
            for (const [key, child] of Object.entries(item)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                    fail('Copilot output contains a forbidden key.', 'invalid_copilot_output', { key });
                }
                if (child && typeof child === 'object') stack.push(child);
            }
        }
        return clone;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        fail('Copilot output must be JSON serializable.');
    }
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function hashCopilotValue(value) {
    return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function cleanId(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) {
        fail(`${label} is invalid.`, 'invalid_copilot_output', { field: label });
    }
    return value;
}

function cleanText(value, label, { required = true, maximum = MAX_TEXT } = {}) {
    if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')
        || (required && value.trim().length === 0)) {
        fail(`${label} is invalid.`, 'invalid_copilot_output', { field: label, maximum });
    }
    return value.replaceAll('\r\n', '\n');
}

function cleanStringList(value, label, maximumItems, { allowEmpty = true, itemMaximum = 2_000 } = {}) {
    if (!Array.isArray(value) || value.length > maximumItems || (!allowEmpty && value.length === 0)) {
        fail(`${label} is invalid.`, 'invalid_copilot_output', { field: label, maximumItems });
    }
    const result = value.map((item, index) => cleanText(item, `${label}[${index}]`, { maximum: itemMaximum }));
    if (new Set(result).size !== result.length) {
        fail(`${label} contains duplicates.`, 'invalid_copilot_output', { field: label });
    }
    return result;
}

function cleanEvidenceIds(value, evidenceIds, label) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_REFERENCES) {
        fail(`${label} must cite evidence.`, 'invalid_copilot_evidence', { field: label });
    }
    const result = value.map((id, index) => {
        if (typeof id !== 'string' || !EVIDENCE_ID.test(id) || !evidenceIds.has(id)) {
            fail(`${label} cites unknown evidence.`, 'invalid_copilot_evidence', { field: `${label}[${index}]`, evidenceId: id });
        }
        return id;
    });
    if (new Set(result).size !== result.length) {
        fail(`${label} contains duplicate evidence.`, 'invalid_copilot_evidence', { field: label });
    }
    return [...result].sort();
}

function normalizedPhrase(value) {
    return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function optionReferences(value, optionIds, label) {
    if (!Array.isArray(value) || value.length > 6) {
        fail(`${label} is invalid.`, 'invalid_copilot_option_reference', { field: label });
    }
    const result = value.map((id, index) => {
        cleanId(id, `${label}[${index}]`);
        if (!optionIds.has(id)) {
            fail(`${label} refers to an unknown option.`, 'invalid_copilot_option_reference', { optionId: id });
        }
        return id;
    });
    if (new Set(result).size !== result.length) {
        fail(`${label} contains duplicate options.`, 'invalid_copilot_option_reference', { field: label });
    }
    return [...result].sort();
}

function normalizeOptions(value, optionCount, evidenceIds) {
    if (!Array.isArray(value) || value.length !== optionCount || value.length < 3 || value.length > 6) {
        fail('Copilot must return the requested 3 to 6 directions.', 'invalid_copilot_option_count', {
            expected: optionCount,
            actual: Array.isArray(value) ? value.length : null,
        });
    }
    const ids = new Set();
    const commitments = new Set();
    const eventDigests = new Set();
    const options = value.map((item, index) => {
        const label = `plotOptions[${index}]`;
        assertExactFields(item, [
            'id', 'title', 'commitment', 'summary', 'eventChain', 'hook', 'risks', 'evidenceIds',
        ], label);
        const id = cleanId(item.id, `${label}.id`);
        if (ids.has(id)) fail('Plot option ids must be unique.', 'duplicate_copilot_option', { optionId: id });
        ids.add(id);
        const title = cleanText(item.title, `${label}.title`, { maximum: 240 });
        const commitment = cleanText(item.commitment, `${label}.commitment`, { maximum: 2_000 });
        const summary = cleanText(item.summary, `${label}.summary`, { maximum: 20_000 });
        if (!Array.isArray(item.eventChain) || item.eventChain.length < 3 || item.eventChain.length > 12) {
            fail(`${label}.eventChain must contain 3 to 12 events.`, 'invalid_copilot_event_chain');
        }
        const eventChain = item.eventChain.map((event, eventIndex) => {
            const eventLabel = `${label}.eventChain[${eventIndex}]`;
            assertExactFields(event, ['order', 'event', 'characterChoice', 'directResult', 'cost'], eventLabel);
            if (event.order !== eventIndex + 1) {
                fail(`${eventLabel}.order must be sequential.`, 'invalid_copilot_event_chain', { expected: eventIndex + 1 });
            }
            return {
                order: event.order,
                event: cleanText(event.event, `${eventLabel}.event`, { maximum: 10_000 }),
                characterChoice: cleanText(event.characterChoice, `${eventLabel}.characterChoice`, { maximum: 10_000 }),
                directResult: cleanText(event.directResult, `${eventLabel}.directResult`, { maximum: 10_000 }),
                cost: cleanText(event.cost, `${eventLabel}.cost`, { maximum: 10_000 }),
            };
        });
        const commitmentKey = normalizedPhrase(commitment);
        const eventDigest = hashCopilotValue(eventChain.map(event => [
            normalizedPhrase(event.event),
            normalizedPhrase(event.characterChoice),
            normalizedPhrase(event.directResult),
            normalizedPhrase(event.cost),
        ]));
        if (commitments.has(commitmentKey) || eventDigests.has(eventDigest)) {
            fail('Plot directions must be materially distinct.', 'duplicate_copilot_option', { optionId: id });
        }
        commitments.add(commitmentKey);
        eventDigests.add(eventDigest);
        return {
            id,
            title,
            commitment,
            summary,
            eventChain,
            hook: cleanText(item.hook, `${label}.hook`, { maximum: 10_000 }),
            risks: cleanStringList(item.risks, `${label}.risks`, 12, { itemMaximum: 4_000 }),
            evidenceIds: cleanEvidenceIds(item.evidenceIds, evidenceIds, `${label}.evidenceIds`),
        };
    });
    return { options, ids };
}

function targetMaps(targetSnapshot) {
    const source = assertObject(targetSnapshot, 'targetSnapshot');
    const project = assertObject(source.project, 'targetSnapshot.project');
    const volumes = new Map((Array.isArray(source.volumes) ? source.volumes : []).map(item => [item.id, item]));
    const chapters = new Map((Array.isArray(source.chapters) ? source.chapters : []).map(item => [item.id, item]));
    const lorebooks = new Map((Array.isArray(source.lorebooks) ? source.lorebooks : []).map(item => [item.id, item]));
    return { project, volumes, chapters, lorebooks };
}

function settingBefore(target, maps) {
    const allowed = SETTING_FIELDS[target.kind];
    if (!allowed?.has(target.field)) {
        fail('Setting edit field is not allowed for its target.', 'invalid_copilot_target', { target });
    }
    if (target.kind === 'project-story') {
        if (target.id !== maps.project.id) fail('Setting edit targets another project.', 'invalid_copilot_target', { target });
        return maps.project.story?.[target.field] ?? '';
    }
    const collection = target.kind === 'volume' ? maps.volumes : maps.chapters;
    const record = collection.get(target.id);
    if (!record) fail('Setting edit target was not selected.', 'invalid_copilot_target', { target });
    return target.kind === 'chapter-card'
        ? record.card?.[target.field] ?? ''
        : record[target.field] ?? '';
}

function normalizeSettingEdits(value, optionIds, evidenceIds, maps) {
    if (!Array.isArray(value) || value.length > 50) {
        fail('settingEdits is invalid.', 'invalid_copilot_output');
    }
    const ids = new Set();
    const targets = new Set();
    const edits = [];
    const diffs = [];
    value.forEach((item, index) => {
        const label = `settingEdits[${index}]`;
        assertExactFields(item, ['id', 'appliesToOptionIds', 'target', 'proposedValue', 'rationale', 'evidenceIds'], label);
        const id = cleanId(item.id, `${label}.id`);
        if (ids.has(id)) fail('Setting edit ids must be unique.', 'duplicate_copilot_edit', { editId: id });
        ids.add(id);
        assertExactFields(item.target, ['kind', 'id', 'field'], `${label}.target`);
        const target = {
            kind: item.target.kind,
            id: cleanId(item.target.id, `${label}.target.id`),
            field: cleanText(item.target.field, `${label}.target.field`, { maximum: 64 }),
        };
        if (!Object.hasOwn(SETTING_FIELDS, target.kind)) {
            fail('Setting edit target kind is invalid.', 'invalid_copilot_target', { target });
        }
        const targetKey = `${target.kind}\u0000${target.id}\u0000${target.field}`;
        if (targets.has(targetKey)) fail('A setting target may be edited only once.', 'duplicate_copilot_target', { target });
        targets.add(targetKey);
        const beforeValue = String(settingBefore(target, maps));
        const afterValue = cleanText(item.proposedValue, `${label}.proposedValue`);
        if (beforeValue === afterValue) fail('Setting edit must change its target.', 'copilot_noop_edit', { target });
        const normalized = {
            id,
            appliesToOptionIds: optionReferences(item.appliesToOptionIds, optionIds, `${label}.appliesToOptionIds`),
            target,
            proposedValue: afterValue,
            rationale: cleanText(item.rationale, `${label}.rationale`, { maximum: 20_000 }),
            evidenceIds: cleanEvidenceIds(item.evidenceIds, evidenceIds, `${label}.evidenceIds`),
        };
        edits.push(normalized);
        diffs.push({
            id,
            appliesToOptionIds: normalized.appliesToOptionIds,
            target,
            beforeValue,
            afterValue,
            beforeDigest: hashCopilotValue(beforeValue),
            afterDigest: hashCopilotValue(afterValue),
            rationale: normalized.rationale,
            evidenceIds: normalized.evidenceIds,
        });
    });
    return { edits, diffs };
}

function cleanLorePatch(patch, label) {
    assertExactFields(patch, LORE_PATCH_FIELDS, label);
    const result = {};
    for (const field of LORE_PATCH_FIELDS) {
        const value = patch[field];
        if (value === null) {
            result[field] = null;
            continue;
        }
        if (['keys', 'secondaryKeys'].includes(field)) {
            result[field] = cleanStringList(value, `${label}.${field}`, 100, { itemMaximum: 2_000 });
        } else if (['enabled', 'constant'].includes(field)) {
            if (typeof value !== 'boolean') fail(`${label}.${field} is invalid.`, 'invalid_copilot_lore_patch');
            result[field] = value;
        } else {
            result[field] = cleanText(value, `${label}.${field}`, {
                required: field === 'content',
                maximum: field === 'content' ? 250_000 : 20_000,
            });
        }
    }
    return result;
}

function loreEntryView(entry) {
    return {
        id: entry.id,
        keys: [...(entry.keys ?? [])],
        secondaryKeys: [...(entry.secondaryKeys ?? [])],
        comment: String(entry.comment ?? ''),
        content: String(entry.content ?? ''),
        enabled: entry.enabled !== false,
        constant: entry.constant === true,
    };
}

function normalizeLorebookEdits(value, optionIds, evidenceIds, maps, identitySeed) {
    if (!Array.isArray(value) || value.length > 50) {
        fail('lorebookEdits is invalid.', 'invalid_copilot_output');
    }
    const ids = new Set();
    const targets = new Set();
    const edits = [];
    const diffs = [];
    value.forEach((item, index) => {
        const label = `lorebookEdits[${index}]`;
        assertExactFields(item, [
            'id', 'appliesToOptionIds', 'operation', 'lorebookId', 'entryId', 'patch', 'rationale', 'evidenceIds',
        ], label);
        const id = cleanId(item.id, `${label}.id`);
        if (ids.has(id)) fail('Lorebook edit ids must be unique.', 'duplicate_copilot_edit', { editId: id });
        ids.add(id);
        if (!['create', 'update', 'delete'].includes(item.operation)) {
            fail(`${label}.operation is invalid.`, 'invalid_copilot_lore_patch');
        }
        const lorebookId = cleanId(item.lorebookId, `${label}.lorebookId`);
        const requestedEntryId = cleanId(item.entryId, `${label}.entryId`);
        const book = maps.lorebooks.get(lorebookId);
        if (!book) fail('Lorebook edit target was not selected.', 'invalid_copilot_target', { lorebookId });
        const entries = new Map((book.entries ?? []).map(entry => [entry.id, loreEntryView(entry)]));
        const patch = cleanLorePatch(item.patch, `${label}.patch`);
        let entryId = requestedEntryId;
        let beforeEntry = entries.get(entryId) ?? null;
        let afterEntry = null;
        if (item.operation === 'create') {
            entryId = `copilot_${hashCopilotValue({ identitySeed, id, lorebookId, requestedEntryId, patch }).slice(0, 40)}`;
            if (entries.has(entryId)) fail('Derived Lorebook entry already exists.', 'duplicate_copilot_target', { entryId });
            if (!patch.content?.trim()) fail('Created Lorebook entries require content.', 'invalid_copilot_lore_patch');
            beforeEntry = null;
            afterEntry = {
                id: entryId,
                keys: patch.keys ?? [],
                secondaryKeys: patch.secondaryKeys ?? [],
                comment: patch.comment ?? '',
                content: patch.content,
                enabled: patch.enabled ?? true,
                constant: patch.constant ?? false,
            };
        } else if (!beforeEntry) {
            fail('Lorebook update/delete entry does not exist.', 'invalid_copilot_target', { lorebookId, entryId });
        } else if (item.operation === 'delete') {
            if (Object.values(patch).some(field => field !== null)) {
                fail('Lorebook delete patch fields must all be null.', 'invalid_copilot_lore_patch', { entryId });
            }
            afterEntry = null;
        } else {
            if (Object.values(patch).every(field => field === null)) {
                fail('Lorebook update patch cannot be empty.', 'invalid_copilot_lore_patch', { entryId });
            }
            afterEntry = { ...beforeEntry };
            for (const field of LORE_PATCH_FIELDS) {
                if (patch[field] !== null) afterEntry[field] = patch[field];
            }
            if (hashCopilotValue(beforeEntry) === hashCopilotValue(afterEntry)) {
                fail('Lorebook update must change its entry.', 'copilot_noop_edit', { entryId });
            }
        }
        const targetKey = `${lorebookId}\u0000${entryId}`;
        if (targets.has(targetKey)) fail('A Lorebook entry may be edited only once.', 'duplicate_copilot_target', { lorebookId, entryId });
        targets.add(targetKey);
        const normalized = {
            id,
            appliesToOptionIds: optionReferences(item.appliesToOptionIds, optionIds, `${label}.appliesToOptionIds`),
            operation: item.operation,
            lorebookId,
            entryId,
            patch,
            rationale: cleanText(item.rationale, `${label}.rationale`, { maximum: 20_000 }),
            evidenceIds: cleanEvidenceIds(item.evidenceIds, evidenceIds, `${label}.evidenceIds`),
        };
        edits.push(normalized);
        diffs.push({
            id,
            appliesToOptionIds: normalized.appliesToOptionIds,
            operation: item.operation,
            lorebookId,
            lorebookRevision: book.revision,
            entryId,
            beforeEntry,
            afterEntry,
            beforeDigest: beforeEntry ? hashCopilotValue(beforeEntry) : null,
            afterDigest: afterEntry ? hashCopilotValue(afterEntry) : null,
            rationale: normalized.rationale,
            evidenceIds: normalized.evidenceIds,
        });
    });
    return { edits, diffs };
}

export function validateCopilotModelOutput(value, {
    optionCount,
    evidenceCatalog,
    targetSnapshot,
    identitySeed = '',
} = {}) {
    const input = safeClone(value);
    assertExactFields(input, ['schemaVersion', 'plotOptions', 'settingEdits', 'lorebookEdits'], 'copilot output');
    if (input.schemaVersion !== COPILOT_SCHEMA_VERSION) {
        fail('Copilot output schema version is invalid.', 'invalid_copilot_output');
    }
    if (!Number.isInteger(optionCount) || optionCount < 3 || optionCount > 6) {
        throw new ApiError(500, 'invalid_copilot_state', 'Stored Copilot option count is invalid.');
    }
    const evidenceIds = new Set((Array.isArray(evidenceCatalog) ? evidenceCatalog : []).map(item => item.evidenceId));
    const { options, ids: optionIds } = normalizeOptions(input.plotOptions, optionCount, evidenceIds);
    const maps = targetMaps(targetSnapshot);
    const settings = normalizeSettingEdits(input.settingEdits, optionIds, evidenceIds, maps);
    const lorebooks = normalizeLorebookEdits(
        input.lorebookEdits,
        optionIds,
        evidenceIds,
        maps,
        identitySeed,
    );
    return {
        schemaVersion: COPILOT_SCHEMA_VERSION,
        plotOptions: options,
        settingEdits: settings.edits,
        lorebookEdits: lorebooks.edits,
        changeSet: {
            schemaVersion: COPILOT_SCHEMA_VERSION,
            settingDiffs: settings.diffs,
            lorebookDiffs: lorebooks.diffs,
        },
    };
}

export function createCopilotArtifact({ session, output, raw }) {
    if (!session || typeof session !== 'object' || !SHA256.test(session.contextDigest ?? '')) {
        throw new ApiError(500, 'invalid_copilot_state', 'Copilot session binding is invalid.');
    }
    const normalized = validateCopilotModelOutput(output, {
        optionCount: session.input.optionCount,
        evidenceCatalog: session.evidenceCatalog,
        targetSnapshot: session.targetSnapshot,
        identitySeed: `${session.projectId}:${session.id}:${session.contextDigest}`,
    });
    const core = {
        schemaVersion: COPILOT_SCHEMA_VERSION,
        kind: 'planning-bundle',
        status: 'candidate',
        projectId: session.projectId,
        sessionId: session.id,
        base: session.base,
        contextDigest: session.contextDigest,
        profileHash: session.profile.profileHash,
        providerHash: session.provider.configHash,
        evidenceDigest: hashCopilotValue(session.evidenceCatalog),
        plotOptions: normalized.plotOptions,
        changeSet: normalized.changeSet,
        rawDigest: hashCopilotValue(String(raw ?? '')),
    };
    const artifactDigest = hashCopilotValue(core);
    return {
        ...core,
        id: `copilot-artifact-${artifactDigest.slice(0, 40)}`,
        artifactDigest,
    };
}
