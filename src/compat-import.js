import { createHash, randomUUID } from 'node:crypto';

export const RESOURCE_SCHEMA_VERSION = 1;
export const MAX_COMPAT_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_COMPAT_PNG_BYTES = 20 * 1024 * 1024;
export const MAX_RESOURCE_RECORD_BYTES = 10 * 1024 * 1024;
export const MAX_LOREBOOK_ENTRIES = 10_000;

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_PNG_CHUNKS = 10_000;
const MAX_PNG_DIMENSION = 32_768;
const MAX_PNG_PIXELS = 100_000_000;
const MAX_PROFILE_MODULES = 500;
const MAX_PROFILE_VARIABLES = 100;
const MAX_PROFILE_REFERENCES = 100;
const MAX_PROFILE_IDENTIFIER_LENGTH = 128;
const MAX_PROFILE_TEMPLATE_LENGTH = 500_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESOURCE_TYPES = new Set(['character', 'lorebook', 'prompt-profile']);
const RESOURCE_TYPE_ALIASES = new Map([
    ['character', 'character'],
    ['characters', 'character'],
    ['lorebook', 'lorebook'],
    ['lorebooks', 'lorebook'],
    ['prompt-profile', 'prompt-profile'],
    ['prompt-profiles', 'prompt-profile'],
    ['preset', 'prompt-profile'],
    ['presets', 'prompt-profile'],
]);

const CHARACTER_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'openingSample', 'dialogueExamples', 'creatorNotes',
    'instruction', 'postInstruction', 'openingSamples', 'tags', 'creator', 'characterVersion', 'extensions',
    'depthPrompt', 'instructionEnabled', 'embeddedLorebookId', 'avatar', 'source',
];
const LOREBOOK_FIELDS = [
    'name', 'description', 'scanDepth', 'tokenBudget', 'recursiveScanning', 'extensions', 'entries', 'source',
];
const PROMPT_PROFILE_FIELDS = [
    'name', 'instruct', 'context', 'generation', 'chatCompletion', 'systemPrompt', 'reasoning',
    'startReplyWith', 'profileVersion', 'modules', 'order', 'variables', 'taskPolicies', 'compatibility',
    'variableValues', 'generationPolicies', 'tokenBudget', 'characterBudget', 'source',
];
const PROFILE_MODULE_FIELDS = [
    'id', 'name', 'slot', 'role', 'template', 'enabled', 'priority', 'tokenBudget', 'clipPolicy',
    'requires', 'conflicts', 'exclusiveGroup', 'when', 'sourceRef', 'includeData', 'marker',
];
const RESOURCE_RECORD_FIELDS = [
    'schemaVersion', 'type', 'id', 'projectId', 'revision', 'createdAt', 'updatedAt',
];

const V1_CHARACTER_REQUIRED_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const INSTRUCT_STRING_FIELDS = [
    'name', 'input_sequence', 'input_suffix', 'output_sequence', 'output_suffix', 'system_sequence',
    'system_suffix', 'last_system_sequence', 'user_alignment_message', 'stop_sequence',
    'first_output_sequence', 'last_output_sequence', 'first_input_sequence', 'last_input_sequence',
    'activation_regex', 'story_string_prefix', 'story_string_suffix',
];
const INSTRUCT_BOOLEAN_FIELDS = [
    'enabled', 'wrap', 'macro', 'bind_to_context', 'skip_examples', 'system_same_as_user',
    'sequences_as_stop_strings',
];
const CONTEXT_STRING_FIELDS = ['name', 'story_string', 'example_separator', 'chat_start'];
const CONTEXT_BOOLEAN_FIELDS = [
    'use_stop_strings', 'names_as_stop_strings', 'always_force_name2', 'trim_sentences', 'single_line',
];
const SENSITIVE_PRESET_FIELDS = new Set([
    'apiKey', 'api_key', 'apikey', 'authorization', 'headers', 'custom_include_headers', 'proxy_password',
    'reverse_proxy', 'custom_url', 'baseUrl', 'base_url', 'vertexai_region', 'vertexai_express_project_id',
    'azure_base_url', 'azure_deployment_name', 'workers_ai_account_id', 'siliconflow_endpoint',
    'minimax_endpoint', 'zai_endpoint',
]);
const PROFILE_CLIP_POLICIES = new Set(['head', 'tail', 'middle', 'drop', 'error']);
const PROFILE_ROLES = new Set(['system', 'user', 'assistant']);
const PROFILE_MACROS = new Set([
    'user', 'char', 'group', 'groupnotmuted', 'charifnotgroup', 'notchar', 'persona', 'description',
    'personality', 'scenario', 'system', 'original', 'charprompt', 'charinstruction', 'charjailbreak',
    'mesexamples', 'mesexamplesraw', 'charversion', 'char_version', 'chardepthprompt', 'creatornotes',
    'model', 'wibefore', 'wiafter', 'lorebefore', 'loreafter', 'anchorbefore', 'anchorafter',
    'projecttitle', 'chapternumber', 'chaptertitle', 'pov', 'targetwords', 'chapterplan',
    'continuityledger',
]);
const ST_PROMPT_SLOTS = new Map([
    ['main', 'main'],
    ['worldInfoBefore', 'worldBefore'],
    ['personaDescription', 'persona'],
    ['charDescription', 'characterDescription'],
    ['charPersonality', 'characterPersonality'],
    ['scenario', 'scenario'],
    ['worldInfoAfter', 'worldAfter'],
    ['dialogueExamples', 'examples'],
    ['chatHistory', 'task'],
    ['jailbreak', 'postInstruction'],
]);
const ST_MARKER_IDENTIFIERS = new Set([
    'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario',
    'worldInfoAfter', 'dialogueExamples', 'chatHistory',
]);
const UNSUPPORTED_ST_PROMPT_FIELDS = new Set([
    'position', 'injection_depth', 'injection_position', 'injection_order', 'injection_trigger',
    'forbid_overrides', 'extension',
]);

export class CompatImportError extends Error {
    constructor(message, code = 'invalid_resource_import', details = {}, status = 400) {
        super(message);
        this.name = 'CompatImportError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function serializedByteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch (error) {
        throw new CompatImportError('Resource data must be JSON serializable.', 'invalid_resource_data', { cause: error.message });
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CompatImportError(`${label} must be an object.`, 'invalid_resource_data', { field: label });
    }
    return value;
}

function assertKnownKeys(value, fields, label) {
    const unknown = Object.keys(value).filter(key => !fields.includes(key));
    if (unknown.length > 0) {
        throw new CompatImportError(`${label} contains unknown fields.`, 'unknown_fields', { fields: unknown });
    }
}

function safeJsonClone(value, label = 'resource data') {
    let nodes = 0;
    const visit = (current, depth, field) => {
        nodes += 1;
        if (nodes > MAX_JSON_NODES) {
            throw new CompatImportError(`${label} contains too many values.`, 'resource_too_complex');
        }
        if (depth > MAX_JSON_DEPTH) {
            throw new CompatImportError(`${label} is nested too deeply.`, 'resource_too_complex');
        }
        if (current === null || typeof current === 'boolean') return current;
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) {
                throw new CompatImportError(`${field} must be a finite number.`, 'invalid_resource_data');
            }
            return current;
        }
        if (typeof current === 'string') {
            if (current.length > MAX_STRING_LENGTH) {
                throw new CompatImportError(`${field} is too long.`, 'resource_field_too_large', { maximum: MAX_STRING_LENGTH });
            }
            return current;
        }
        if (Array.isArray(current)) {
            if (current.length > MAX_ARRAY_ITEMS) {
                throw new CompatImportError(`${field} contains too many items.`, 'resource_array_too_large', { maximum: MAX_ARRAY_ITEMS });
            }
            return current.map((item, index) => visit(item, depth + 1, `${field}[${index}]`));
        }
        if (!current || typeof current !== 'object') {
            throw new CompatImportError(`${field} contains an unsupported value.`, 'invalid_resource_data');
        }
        const result = {};
        for (const [key, item] of Object.entries(current)) {
            if (DANGEROUS_KEYS.has(key)) {
                throw new CompatImportError(`${field} contains a forbidden key.`, 'unsafe_resource_key', { key });
            }
            result[key] = visit(item, depth + 1, `${field}.${key}`);
        }
        return result;
    };
    const result = visit(value, 0, label);
    if (serializedByteLength(result) > MAX_COMPAT_JSON_BYTES) {
        throw new CompatImportError(`${label} exceeds the JSON import limit.`, 'resource_too_large', { maximum: MAX_COMPAT_JSON_BYTES }, 413);
    }
    return result;
}

function cleanString(value, label, maximum, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') {
        throw new CompatImportError(`${label} must be a string.`, 'invalid_resource_field', { field: label });
    }
    if (value.length > maximum) {
        throw new CompatImportError(`${label} is too long.`, 'resource_field_too_large', { field: label, maximum });
    }
    return value;
}

function cleanName(value, fallback) {
    const name = cleanString(value, 'name', 160, fallback).trim();
    if (!name) return fallback;
    return name;
}

function cleanBoolean(value, label, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') {
        throw new CompatImportError(`${label} must be a boolean.`, 'invalid_resource_field', { field: label });
    }
    return value;
}

function cleanNumber(value, label, minimum, maximum, fallback = null, { integer = false } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))
        || value < minimum || value > maximum) {
        throw new CompatImportError(`${label} is outside its allowed range.`, 'invalid_resource_field', {
            field: label,
            minimum,
            maximum,
        });
    }
    return value;
}

function cleanStringArray(value, label, maximumItems = 1_000, maximumLength = 20_000) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > maximumItems) {
        throw new CompatImportError(`${label} must be an array with at most ${maximumItems} items.`, 'invalid_resource_field');
    }
    return value.map((item, index) => cleanString(item, `${label}[${index}]`, maximumLength));
}

function fileStem(fileName = '') {
    const normalized = String(fileName).replaceAll('\\', '/').split('/').at(-1) || '';
    const lastDot = normalized.lastIndexOf('.');
    return cleanName(lastDot > 0 ? normalized.slice(0, lastDot) : normalized, 'Imported resource');
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function parseBase64(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_COMPAT_PNG_BYTES * 4 / 3) + 4) {
        throw new CompatImportError('PNG data must be a bounded Base64 string.', 'invalid_base64');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new CompatImportError('PNG data is not valid Base64.', 'invalid_base64');
    }
    const result = Buffer.from(value, 'base64');
    if (result.length > MAX_COMPAT_PNG_BYTES) {
        throw new CompatImportError('PNG exceeds the import limit.', 'resource_too_large', { maximum: MAX_COMPAT_PNG_BYTES }, 413);
    }
    return result;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function decodeCardText(encoded, label) {
    if (encoded.length > Math.ceil(MAX_COMPAT_JSON_BYTES * 4 / 3) + 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new CompatImportError(`${label} contains invalid or oversized Base64.`, 'invalid_character_metadata');
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > MAX_COMPAT_JSON_BYTES) {
        throw new CompatImportError(`${label} metadata exceeds the JSON limit.`, 'resource_too_large', { maximum: MAX_COMPAT_JSON_BYTES }, 413);
    }
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    } catch {
        throw new CompatImportError(`${label} metadata is not valid UTF-8.`, 'invalid_character_metadata');
    }
    try {
        return safeJsonClone(JSON.parse(text), label);
    } catch (error) {
        if (error instanceof CompatImportError) throw error;
        throw new CompatImportError(`${label} metadata is not valid JSON.`, 'invalid_character_metadata');
    }
}

export function parseCharacterPng(bufferValue) {
    const buffer = Buffer.isBuffer(bufferValue) ? bufferValue : Buffer.from(bufferValue ?? []);
    if (buffer.length > MAX_COMPAT_PNG_BYTES) {
        throw new CompatImportError('PNG exceeds the import limit.', 'resource_too_large', { maximum: MAX_COMPAT_PNG_BYTES }, 413);
    }
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
        throw new CompatImportError('File is not a PNG image.', 'invalid_png');
    }

    let offset = 8;
    let chunkCount = 0;
    let sawIhdr = false;
    let sawIend = false;
    let width = 0;
    let height = 0;
    const metadata = { chara: [], ccv3: [] };

    while (offset < buffer.length) {
        if (++chunkCount > MAX_PNG_CHUNKS) {
            throw new CompatImportError('PNG contains too many chunks.', 'invalid_png');
        }
        if (offset + 12 > buffer.length) {
            throw new CompatImportError('PNG ends inside a chunk header.', 'invalid_png');
        }
        const length = buffer.readUInt32BE(offset);
        const typeStart = offset + 4;
        const dataStart = typeStart + 4;
        const dataEnd = dataStart + length;
        const crcOffset = dataEnd;
        const nextOffset = crcOffset + 4;
        if (dataEnd < dataStart || nextOffset > buffer.length) {
            throw new CompatImportError('PNG chunk length exceeds the file boundary.', 'invalid_png');
        }
        const typeBuffer = buffer.subarray(typeStart, dataStart);
        const type = typeBuffer.toString('ascii');
        if (!/^[A-Za-z]{4}$/.test(type)) {
            throw new CompatImportError('PNG contains an invalid chunk type.', 'invalid_png');
        }
        const expectedCrc = buffer.readUInt32BE(crcOffset);
        const actualCrc = crc32(buffer.subarray(typeStart, dataEnd));
        if (actualCrc !== expectedCrc) {
            throw new CompatImportError(`PNG chunk ${type} has an invalid CRC.`, 'invalid_png_crc', { chunk: type });
        }
        const data = buffer.subarray(dataStart, dataEnd);

        if (chunkCount === 1 && type !== 'IHDR') {
            throw new CompatImportError('PNG does not begin with IHDR.', 'invalid_png');
        }
        if (type === 'IHDR') {
            if (sawIhdr || length !== 13) throw new CompatImportError('PNG has an invalid IHDR chunk.', 'invalid_png');
            sawIhdr = true;
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION
                || width * height > MAX_PNG_PIXELS) {
                throw new CompatImportError('PNG dimensions exceed the safe import limit.', 'invalid_png_dimensions');
            }
        } else if (type === 'tEXt') {
            const separator = data.indexOf(0);
            if (separator > 0 && separator < 80) {
                const keyword = data.subarray(0, separator).toString('latin1').toLowerCase();
                if (keyword === 'chara' || keyword === 'ccv3') {
                    if (data.length - separator - 1 > Math.ceil(MAX_COMPAT_JSON_BYTES * 4 / 3) + 4) {
                        throw new CompatImportError('PNG character metadata is too large.', 'resource_too_large', { maximum: MAX_COMPAT_JSON_BYTES }, 413);
                    }
                    metadata[keyword].push(data.subarray(separator + 1).toString('ascii'));
                }
            }
        } else if (type === 'IEND') {
            if (length !== 0) throw new CompatImportError('PNG has an invalid IEND chunk.', 'invalid_png');
            sawIend = true;
            offset = nextOffset;
            break;
        }
        offset = nextOffset;
    }

    if (!sawIhdr || !sawIend || offset !== buffer.length) {
        throw new CompatImportError('PNG is missing a valid terminal IEND chunk.', 'invalid_png');
    }
    const preferredKind = metadata.ccv3.length > 0 ? 'ccv3' : (metadata.chara.length > 0 ? 'chara' : null);
    if (!preferredKind) {
        throw new CompatImportError('PNG does not contain chara or ccv3 metadata.', 'missing_character_metadata');
    }
    const warnings = [];
    if (metadata[preferredKind].length > 1) warnings.push(`duplicate_${preferredKind}_chunks`);
    if (metadata.ccv3.length > 0 && metadata.chara.length > 0) warnings.push('ccv3_preferred_over_chara');
    return {
        card: decodeCardText(metadata[preferredKind][0], preferredKind),
        metadataKind: preferredKind,
        warnings,
        avatar: {
            source: 'embedded-png',
            byteLength: buffer.length,
            sha256: sha256(buffer),
            width,
            height,
            persisted: false,
        },
    };
}

function normalizeSource(format, spec, specVersion, fileName, raw, extra = {}) {
    return {
        format,
        spec: spec || '',
        specVersion: specVersion || '',
        fileName: cleanString(fileName, 'source.fileName', 255),
        raw: safeJsonClone(raw, 'source.raw'),
        ...extra,
    };
}

function normalizeDepthPrompt(value) {
    if (value === undefined || value === null) return null;
    const input = assertPlainObject(value, 'depth prompt');
    return {
        prompt: cleanString(input.prompt, 'depth prompt.prompt', 250_000),
        depth: cleanNumber(input.depth, 'depth prompt.depth', 0, 1_000, 4, { integer: true }),
        role: cleanString(input.role, 'depth prompt.role', 32, 'system'),
    };
}

function characterDraftFromCard(cardValue, { fileName, format, avatar = null, metadataKind = '', warnings = [] } = {}) {
    const card = assertPlainObject(cardValue, 'character card');
    let data;
    let spec = '';
    let specVersion = '';
    if (card.spec === 'chara_card_v2') {
        if (card.spec_version !== '2.0') {
            throw new CompatImportError('Character Card V2 must use spec_version 2.0.', 'unsupported_character_schema');
        }
        data = assertPlainObject(card.data, 'character card data');
        spec = card.spec;
        specVersion = card.spec_version;
    } else if (card.spec === 'chara_card_v3') {
        const version = Number(card.spec_version);
        if (!Number.isFinite(version) || version < 3 || version >= 4) {
            throw new CompatImportError('Character Card V3 must use a 3.x spec_version.', 'unsupported_character_schema');
        }
        data = assertPlainObject(card.data, 'character card data');
        spec = card.spec;
        specVersion = String(card.spec_version);
    } else if (card.spec !== undefined) {
        throw new CompatImportError('Unsupported character card specification.', 'unsupported_character_schema', { spec: card.spec });
    } else {
        for (const field of V1_CHARACTER_REQUIRED_FIELDS) {
            if (!Object.hasOwn(card, field) || typeof card[field] !== 'string') {
                throw new CompatImportError(`Character Card V1 is missing ${field}.`, 'invalid_character_card', { field });
            }
        }
        data = card;
        spec = 'chara_card_v1';
        specVersion = '1.0';
    }

    const name = cleanName(data.name, 'Imported character');
    const embeddedBook = data.character_book === undefined || data.character_book === null
        ? null
        : lorebookDraftFromValue(data.character_book, {
            fileName: `${name} lorebook.json`,
            format: 'character-book',
        });
    const extensions = data.extensions === undefined ? {} : safeJsonClone(assertPlainObject(data.extensions, 'character extensions'), 'character extensions');
    const depthPrompt = extensions.depth_prompt === undefined ? null : normalizeDepthPrompt(extensions.depth_prompt);
    const draft = {
        name,
        description: cleanString(data.description, 'description', 250_000),
        personality: cleanString(data.personality, 'personality', 250_000),
        scenario: cleanString(data.scenario, 'scenario', 250_000),
        openingSample: cleanString(data.first_mes, 'first_mes', 250_000),
        dialogueExamples: cleanString(data.mes_example, 'mes_example', 500_000),
        creatorNotes: cleanString(data.creator_notes ?? card.creatorcomment, 'creator_notes', 250_000),
        instruction: cleanString(data.system_prompt, 'system_prompt', 250_000),
        postInstruction: cleanString(data.post_history_instructions, 'post_history_instructions', 250_000),
        openingSamples: cleanStringArray(data.alternate_greetings, 'alternate_greetings', 1_000, 250_000),
        tags: cleanStringArray(data.tags ?? card.tags, 'tags', 1_000, 1_000),
        creator: cleanString(data.creator, 'creator', 10_000),
        characterVersion: cleanString(data.character_version, 'character_version', 1_000),
        extensions,
        depthPrompt,
        instructionEnabled: false,
        embeddedLorebookId: null,
        avatar,
        source: normalizeSource(format, spec, specVersion, fileName, card, {
            metadataKind,
            warnings: cleanStringArray(warnings, 'source.warnings', 100, 200),
        }),
    };
    return { type: 'character', draft, embeddedLorebook: embeddedBook };
}

function entryId(value, index) {
    const text = value === undefined || value === null ? '' : String(value);
    return text.length > 0 && text.length <= 128 ? text : `entry-${index + 1}`;
}

function optionalBoolean(value, label) {
    return value === null || value === undefined ? null : cleanBoolean(value, label);
}

function optionalNumber(value, label, minimum, maximum, { integer = false } = {}) {
    return value === null || value === undefined ? null : cleanNumber(value, label, minimum, maximum, null, { integer });
}

function normalizeLorebookEntry(value, index, sourceKind) {
    const entry = assertPlainObject(value, `entries[${index}]`);
    const extensions = entry.extensions === undefined
        ? {}
        : safeJsonClone(assertPlainObject(entry.extensions, `entries[${index}].extensions`), `entries[${index}].extensions`);
    const isCharacterBook = sourceKind === 'character-book';
    const id = entryId(isCharacterBook ? (entry.id ?? entry.uid) : (entry.uid ?? entry.id), index);
    const keys = cleanStringArray(isCharacterBook ? entry.keys : entry.key, `entries[${index}].keys`, 1_000, 20_000);
    const secondaryKeys = cleanStringArray(
        isCharacterBook ? entry.secondary_keys : entry.keysecondary,
        `entries[${index}].secondaryKeys`,
        1_000,
        20_000,
    );
    const position = extensions.position ?? entry.position ?? 0;
    if (!(typeof position === 'string' || (typeof position === 'number' && Number.isFinite(position)))) {
        throw new CompatImportError(`entries[${index}].position is invalid.`, 'invalid_resource_field');
    }
    return {
        id,
        sourceUid: isCharacterBook ? (entry.id ?? entry.uid ?? index) : (entry.uid ?? entry.id ?? index),
        keys,
        secondaryKeys,
        comment: cleanString(entry.comment, `entries[${index}].comment`, 20_000),
        content: cleanString(entry.content, `entries[${index}].content`, 250_000),
        enabled: isCharacterBook ? cleanBoolean(entry.enabled, `entries[${index}].enabled`, true) : !cleanBoolean(entry.disable, `entries[${index}].disable`, false),
        constant: cleanBoolean(entry.constant, `entries[${index}].constant`, false),
        vectorized: cleanBoolean(extensions.vectorized ?? entry.vectorized, `entries[${index}].vectorized`, false),
        selective: cleanBoolean(entry.selective, `entries[${index}].selective`, secondaryKeys.length > 0),
        selectiveLogic: cleanNumber(extensions.selectiveLogic ?? extensions.selective_logic ?? entry.selectiveLogic, `entries[${index}].selectiveLogic`, 0, 3, 0, { integer: true }),
        insertionOrder: cleanNumber(isCharacterBook ? entry.insertion_order : entry.order, `entries[${index}].insertionOrder`, -1_000_000, 1_000_000, 100),
        position,
        role: extensions.role ?? entry.role ?? 0,
        depth: cleanNumber(extensions.depth ?? entry.depth, `entries[${index}].depth`, 0, 10_000, 4, { integer: true }),
        probability: optionalNumber(extensions.probability ?? entry.probability, `entries[${index}].probability`, 0, 100) ?? 100,
        useProbability: cleanBoolean(extensions.useProbability ?? extensions.use_probability ?? entry.useProbability, `entries[${index}].useProbability`, true),
        excludeRecursion: cleanBoolean(extensions.exclude_recursion ?? entry.excludeRecursion, `entries[${index}].excludeRecursion`, false),
        preventRecursion: cleanBoolean(extensions.prevent_recursion ?? entry.preventRecursion, `entries[${index}].preventRecursion`, false),
        delayUntilRecursion: extensions.delay_until_recursion ?? entry.delayUntilRecursion ?? false,
        group: cleanString(extensions.group ?? entry.group, `entries[${index}].group`, 1_000),
        groupOverride: cleanBoolean(extensions.group_override ?? entry.groupOverride, `entries[${index}].groupOverride`, false),
        groupWeight: cleanNumber(extensions.group_weight ?? entry.groupWeight, `entries[${index}].groupWeight`, 0, 1_000_000, 100),
        scanDepth: optionalNumber(extensions.scan_depth ?? entry.scanDepth, `entries[${index}].scanDepth`, 0, 100_000, { integer: true }),
        caseSensitive: optionalBoolean(extensions.case_sensitive ?? entry.caseSensitive, `entries[${index}].caseSensitive`),
        matchWholeWords: optionalBoolean(extensions.match_whole_words ?? entry.matchWholeWords, `entries[${index}].matchWholeWords`),
        useGroupScoring: optionalBoolean(extensions.use_group_scoring ?? entry.useGroupScoring, `entries[${index}].useGroupScoring`),
        sticky: optionalNumber(extensions.sticky ?? entry.sticky, `entries[${index}].sticky`, 0, 1_000_000, { integer: true }),
        cooldown: optionalNumber(extensions.cooldown ?? entry.cooldown, `entries[${index}].cooldown`, 0, 1_000_000, { integer: true }),
        delay: optionalNumber(extensions.delay ?? entry.delay, `entries[${index}].delay`, 0, 1_000_000, { integer: true }),
        triggers: cleanStringArray(extensions.triggers ?? entry.triggers, `entries[${index}].triggers`, 100, 100),
        ignoreBudget: cleanBoolean(extensions.ignore_budget ?? entry.ignoreBudget, `entries[${index}].ignoreBudget`, false),
        extensions,
    };
}

function lorebookCompatibilityWarnings(entries, { recursiveScanning = false } = {}) {
    const warnings = [];
    const idsFor = predicate => entries.filter(predicate).map(entry => entry.id);
    const probabilityIds = idsFor(entry => entry.useProbability && entry.probability > 0 && entry.probability < 100);
    if (probabilityIds.length > 0) {
        warnings.push(compatibilityWarning(
            'unsupported_lorebook_probability_sampling',
            'Lorebook probability values from 1 to 99 are preserved but are not randomly sampled.',
            { entryIds: probabilityIds },
        ));
    }
    const recursionIds = idsFor(entry => entry.excludeRecursion || entry.preventRecursion || Boolean(entry.delayUntilRecursion));
    if (recursiveScanning || recursionIds.length > 0) {
        warnings.push(compatibilityWarning(
            'unsupported_lorebook_recursion',
            'Recursive scanning controls are preserved but are not executed by the deterministic prompt engine.',
            { recursiveScanning, entryIds: recursionIds },
        ));
    }
    const groupIds = idsFor(entry => entry.group || entry.groupOverride || entry.useGroupScoring !== null);
    if (groupIds.length > 0) {
        warnings.push(compatibilityWarning(
            'unsupported_lorebook_group_arbitration',
            'Lorebook group arbitration and weighted selection are preserved but are not executed.',
            { entryIds: groupIds },
        ));
    }
    const timedIds = idsFor(entry => entry.sticky !== null || entry.cooldown !== null || entry.delay !== null);
    if (timedIds.length > 0) {
        warnings.push(compatibilityWarning(
            'unsupported_lorebook_timed_state',
            'Sticky, cooldown, and delay state are preserved but are not executed across generations.',
            { entryIds: timedIds },
        ));
    }
    const depthIds = idsFor(entry => ['atdepth', 'at_depth', 'depth', 4].includes(
        typeof entry.position === 'string' ? entry.position.toLocaleLowerCase() : entry.position,
    ));
    if (depthIds.length > 0) {
        warnings.push(compatibilityWarning(
            'approximate_lorebook_depth_position',
            'At-depth lore entries are appended to the world-after section with depth metadata rather than injected into chat history.',
            { entryIds: depthIds },
        ));
    }
    return uniqueCompatibilityWarnings(warnings);
}

function lorebookDraftFromValue(value, { fileName, format = 'sillytavern-world-info' } = {}) {
    const book = assertPlainObject(value, 'lorebook');
    const sourceKind = Array.isArray(book.entries) ? 'character-book' : 'sillytavern-world-info';
    let sourceEntries;
    if (sourceKind === 'character-book') {
        sourceEntries = book.entries;
    } else {
        if (!book.entries || typeof book.entries !== 'object' || Array.isArray(book.entries)) {
            throw new CompatImportError('SillyTavern World Info entries must be an object.', 'invalid_lorebook');
        }
        sourceEntries = Object.values(book.entries);
    }
    if (sourceEntries.length > MAX_LOREBOOK_ENTRIES) {
        throw new CompatImportError('Lorebook contains too many entries.', 'resource_array_too_large', { maximum: MAX_LOREBOOK_ENTRIES }, 413);
    }
    const entries = sourceEntries.map((entry, index) => normalizeLorebookEntry(entry, index, sourceKind));
    const seen = new Set();
    for (const entry of entries) {
        if (seen.has(entry.id)) {
            throw new CompatImportError('Lorebook contains duplicate entry identifiers.', 'duplicate_lorebook_entry', { id: entry.id });
        }
        seen.add(entry.id);
    }
    const extensions = book.extensions === undefined
        ? {}
        : safeJsonClone(assertPlainObject(book.extensions, 'lorebook extensions'), 'lorebook extensions');
    const recursiveScanning = cleanBoolean(book.recursive_scanning, 'lorebook.recursiveScanning', false);
    const compatibilityWarnings = lorebookCompatibilityWarnings(entries, { recursiveScanning });
    return {
        type: 'lorebook',
        draft: {
            name: cleanName(book.name, fileStem(fileName)),
            description: cleanString(book.description, 'lorebook.description', 250_000),
            scanDepth: optionalNumber(book.scan_depth, 'lorebook.scanDepth', 0, 100_000, { integer: true }),
            tokenBudget: optionalNumber(book.token_budget, 'lorebook.tokenBudget', 0, 2_000_000, { integer: true }),
            recursiveScanning,
            extensions,
            entries,
            source: normalizeSource(format || sourceKind, sourceKind, '', fileName, book, {
                ...(compatibilityWarnings.length > 0 ? { compatibilityWarnings } : {}),
            }),
        },
    };
}

function redactPreset(value, path = '', removed = []) {
    if (Array.isArray(value)) return value.map((item, index) => redactPreset(item, `${path}[${index}]`, removed));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (DANGEROUS_KEYS.has(key)) {
            throw new CompatImportError('Preset contains a forbidden key.', 'unsafe_resource_key', { key });
        }
        if (SENSITIVE_PRESET_FIELDS.has(key)
            || /(?:api[_-]?key|authorization|proxy[_-]?password|headers?|endpoint|url|account[_-]?id)$/i.test(key)) {
            removed.push(path ? `${path}.${key}` : key);
            continue;
        }
        result[key] = redactPreset(item, path ? `${path}.${key}` : key, removed);
    }
    return result;
}

function normalizeInstruct(value) {
    if (value === undefined || value === null) return null;
    const input = assertPlainObject(value, 'instruct preset');
    const result = {};
    for (const field of INSTRUCT_STRING_FIELDS) {
        if (input[field] !== undefined) result[field] = cleanString(input[field], `instruct.${field}`, 250_000);
    }
    for (const field of INSTRUCT_BOOLEAN_FIELDS) {
        if (input[field] !== undefined) result[field] = cleanBoolean(input[field], `instruct.${field}`);
    }
    if (input.names_behavior !== undefined) {
        const behavior = cleanString(input.names_behavior, 'instruct.names_behavior', 32);
        if (!['none', 'force', 'always'].includes(behavior)) {
            throw new CompatImportError('instruct.names_behavior is invalid.', 'invalid_resource_field');
        }
        result.names_behavior = behavior;
    }
    return result;
}

function normalizeContext(value) {
    if (value === undefined || value === null) return null;
    const input = assertPlainObject(value, 'context preset');
    const result = {};
    for (const field of CONTEXT_STRING_FIELDS) {
        if (input[field] !== undefined) result[field] = cleanString(input[field], `context.${field}`, 500_000);
    }
    for (const field of CONTEXT_BOOLEAN_FIELDS) {
        if (input[field] !== undefined) result[field] = cleanBoolean(input[field], `context.${field}`);
    }
    if (input.story_string_position !== undefined) result.story_string_position = cleanNumber(input.story_string_position, 'context.story_string_position', 0, 10, 0, { integer: true });
    if (input.story_string_depth !== undefined) result.story_string_depth = cleanNumber(input.story_string_depth, 'context.story_string_depth', 0, 10_000, 1, { integer: true });
    if (input.story_string_role !== undefined) result.story_string_role = cleanNumber(input.story_string_role, 'context.story_string_role', 0, 10, 0, { integer: true });
    return result;
}

function mappedNumber(input, keys, label, minimum, maximum, { integer = false } = {}) {
    for (const key of keys) {
        if (input[key] !== undefined) return cleanNumber(input[key], label, minimum, maximum, null, { integer });
    }
    return null;
}

function normalizeGeneration(value) {
    if (value === undefined || value === null) return {};
    const input = assertPlainObject(value, 'generation preset');
    const fields = [
        ['temperature', ['temperature', 'temp'], 0, 2, false],
        ['topP', ['topP', 'top_p'], 0, 1, false],
        ['topK', ['topK', 'top_k'], 0, 1_000_000, true],
        ['topA', ['topA', 'top_a'], 0, 1, false],
        ['minP', ['minP', 'min_p'], 0, 1, false],
        ['frequencyPenalty', ['frequencyPenalty', 'frequency_penalty', 'freq_pen'], -2, 2, false],
        ['presencePenalty', ['presencePenalty', 'presence_penalty', 'presence_pen'], -2, 2, false],
        ['repetitionPenalty', ['repetitionPenalty', 'repetition_penalty', 'rep_pen'], 0, 10, false],
        ['contextTokens', ['contextTokens', 'openai_max_context', 'max_length'], 2_048, 2_000_000, true],
        ['maxTokens', ['maxTokens', 'openai_max_tokens', 'genamt'], 1, 200_000, true],
        ['seed', ['seed'], -1, 2_147_483_647, true],
    ];
    const result = {};
    for (const [target, keys, minimum, maximum, integer] of fields) {
        const mapped = mappedNumber(input, keys, `generation.${target}`, minimum, maximum, { integer });
        if (mapped !== null) result[target] = mapped;
    }
    if (input.stop !== undefined) {
        if (!Array.isArray(input.stop) || input.stop.length > 16) {
            throw new CompatImportError('generation.stop must contain at most 16 strings.', 'invalid_resource_field');
        }
        result.stop = input.stop.map((item, index) => {
            const stop = cleanString(item, `generation.stop[${index}]`, 1_000);
            if (!stop) {
                throw new CompatImportError('generation.stop cannot contain empty strings.', 'invalid_resource_field');
            }
            return stop;
        });
    }
    const assistantPrefill = input.assistantPrefill ?? input.assistant_prefill;
    if (assistantPrefill !== undefined) {
        result.assistantPrefill = cleanString(assistantPrefill, 'generation.assistantPrefill', 100_000);
    }
    return result;
}

function normalizeChatCompletion(value) {
    const input = assertPlainObject(value, 'chat completion preset');
    const result = {};
    if (input.prompts !== undefined) {
        if (!Array.isArray(input.prompts) || input.prompts.length > 500) {
            throw new CompatImportError('prompts must contain at most 500 entries.', 'invalid_resource_field');
        }
        result.prompts = safeJsonClone(input.prompts, 'prompts');
    }
    if (input.prompt_order !== undefined) {
        if (!Array.isArray(input.prompt_order) || input.prompt_order.length > 500) {
            throw new CompatImportError('prompt_order must contain at most 500 entries.', 'invalid_resource_field');
        }
        result.promptOrder = safeJsonClone(input.prompt_order, 'prompt_order');
    }
    const modelHints = ['openai_model', 'claude_model', 'openrouter_model', 'custom_model', 'google_model', 'mistralai_model'];
    result.modelHints = Object.fromEntries(modelHints
        .filter(field => input[field] !== undefined)
        .map(field => [field, cleanString(input[field], `chatCompletion.${field}`, 256)]));
    return result;
}

function cleanProfileIdentifier(value, label) {
    const identifier = cleanString(value, label, MAX_PROFILE_IDENTIFIER_LENGTH).trim();
    if (!identifier) {
        throw new CompatImportError(`${label} cannot be empty.`, 'invalid_resource_field', { field: label });
    }
    return identifier;
}

function compatibilityWarning(code, message, details = {}) {
    return { code, message, ...details };
}

function uniqueCompatibilityWarnings(warnings) {
    const seen = new Set();
    return warnings.filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeStOrderEntry(value, index, label) {
    const input = assertPlainObject(value, `${label}[${index}]`);
    return {
        identifier: cleanProfileIdentifier(input.identifier, `${label}[${index}].identifier`),
        enabled: cleanBoolean(input.enabled, `${label}[${index}].enabled`, true),
    };
}

function normalizeStOrderList(value, label) {
    if (!Array.isArray(value) || value.length > MAX_PROFILE_MODULES) {
        throw new CompatImportError(`${label} must contain at most ${MAX_PROFILE_MODULES} entries.`, 'invalid_resource_field');
    }
    const entries = value.map((entry, index) => normalizeStOrderEntry(entry, index, label));
    const identifiers = entries.map(entry => entry.identifier);
    if (new Set(identifiers).size !== identifiers.length) {
        throw new CompatImportError(`${label} contains duplicate prompt identifiers.`, 'duplicate_prompt_identifier');
    }
    return entries;
}

function selectStPromptOrder(value) {
    if (value === undefined || value === null) {
        return { entries: [], mode: 'none', characterId: null, ignoredCharacterIds: [] };
    }
    if (!Array.isArray(value) || value.length > MAX_PROFILE_MODULES) {
        throw new CompatImportError(`prompt_order must contain at most ${MAX_PROFILE_MODULES} entries.`, 'invalid_resource_field');
    }
    if (value.length === 0) return { entries: [], mode: 'none', characterId: null, ignoredCharacterIds: [] };

    const directEntries = value.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
        && Object.hasOwn(entry, 'identifier'));
    if (directEntries) {
        return {
            entries: normalizeStOrderList(value, 'prompt_order'),
            mode: 'flat',
            characterId: null,
            ignoredCharacterIds: [],
        };
    }

    const groups = value.map((groupValue, index) => {
        const group = assertPlainObject(groupValue, `prompt_order[${index}]`);
        if (!Object.hasOwn(group, 'order')) {
            throw new CompatImportError('prompt_order must use either a flat order or character order groups.', 'invalid_resource_field');
        }
        const characterId = group.character_id === undefined || group.character_id === null
            ? ''
            : cleanString(String(group.character_id), `prompt_order[${index}].character_id`, 128).trim();
        return {
            characterId,
            entries: normalizeStOrderList(group.order, `prompt_order[${index}].order`),
        };
    });
    const characterIds = groups.map(group => group.characterId).filter(Boolean);
    if (new Set(characterIds).size !== characterIds.length) {
        throw new CompatImportError('prompt_order contains duplicate character groups.', 'duplicate_prompt_order_group');
    }
    const selected = groups.find(group => group.characterId === '100001') ?? groups[0];
    return {
        entries: selected.entries,
        mode: 'character',
        characterId: selected.characterId || null,
        ignoredCharacterIds: groups
            .filter(group => group !== selected)
            .map(group => group.characterId || '(default)'),
    };
}

function stableStPromptIdentifier(prompt, usedIdentifiers) {
    const fingerprint = JSON.stringify({
        name: prompt.name ?? '',
        role: prompt.role ?? '',
        content: prompt.content ?? '',
        marker: prompt.marker ?? false,
        position: prompt.position ?? null,
        injection_depth: prompt.injection_depth ?? null,
    });
    const base = `st-${sha256(Buffer.from(fingerprint, 'utf8')).slice(0, 24)}`;
    let identifier = base;
    let suffix = 2;
    while (usedIdentifiers.has(identifier)) identifier = `${base}-${suffix++}`;
    return identifier;
}

function scanUnsupportedPromptFeatures(value, moduleId, warnings, path = 'prompt') {
    if (typeof value === 'string') {
        if (/<%(?:=|-|_|#)?[\s\S]*?%>/.test(value)) {
            warnings.push(compatibilityWarning(
                'unsupported_ejs',
                'EJS syntax was preserved as inert text and will not be executed.',
                { moduleId, field: path },
            ));
        }
        if (/<script\b|javascript\s*:/i.test(value)) {
            warnings.push(compatibilityWarning(
                'unsupported_script',
                'Script-like content was preserved as inert text and will not be executed.',
                { moduleId, field: path },
            ));
        }
        for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
            const macro = String(match[1]).trim();
            if (!PROFILE_MACROS.has(macro.toLocaleLowerCase())) {
                warnings.push(compatibilityWarning(
                    'unknown_macro',
                    `Unsupported macro was preserved: {{${macro}}}`,
                    { moduleId, macro },
                ));
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => scanUnsupportedPromptFeatures(item, moduleId, warnings, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        if (/(?:^|_)(?:script|scripts|javascript|ejs|tavernhelper)(?:$|_)/i.test(key)
            && item !== undefined && item !== null && item !== '' && item !== false) {
            warnings.push(compatibilityWarning(
                'unsupported_script_field',
                'Executable preset fields are not supported and will never be executed.',
                { moduleId, field: `${path}.${key}` },
            ));
        }
        scanUnsupportedPromptFeatures(item, moduleId, warnings, `${path}.${key}`);
    }
}

function warnUnsupportedStPromptFields(prompt, moduleId, warnings, path) {
    for (const field of UNSUPPORTED_ST_PROMPT_FIELDS) {
        if (!Object.hasOwn(prompt, field)) continue;
        warnings.push(compatibilityWarning(
            'unsupported_prompt_field',
            `SillyTavern prompt field is preserved for reference but is not executed: ${field}.`,
            { moduleId, field: `${path}.${field}`, feature: field },
        ));
    }
}

function stPromptSlot(identifier) {
    return ST_PROMPT_SLOTS.get(identifier) ?? 'custom';
}

function makeImportedPromptModule(promptValue, index, selectedOrder, usedIdentifiers, warnings) {
    const prompt = assertPlainObject(promptValue, `prompts[${index}]`);
    const explicitIdentifier = prompt.identifier === undefined || prompt.identifier === null || prompt.identifier === ''
        ? null
        : cleanProfileIdentifier(prompt.identifier, `prompts[${index}].identifier`);
    const id = explicitIdentifier ?? stableStPromptIdentifier(prompt, usedIdentifiers);
    if (usedIdentifiers.has(id)) {
        throw new CompatImportError('prompts contains duplicate prompt identifiers.', 'duplicate_prompt_identifier', { identifier: id });
    }
    usedIdentifiers.add(id);

    const marker = cleanBoolean(prompt.marker, `prompts[${index}].marker`, false);
    const role = cleanString(prompt.role, `prompts[${index}].role`, 32, 'system').trim() || 'system';
    if (!PROFILE_ROLES.has(role)) {
        throw new CompatImportError(`prompts[${index}].role is invalid.`, 'invalid_resource_field', { role });
    }
    const template = cleanString(prompt.content, `prompts[${index}].content`, MAX_PROFILE_TEMPLATE_LENGTH);
    scanUnsupportedPromptFeatures(prompt, id, warnings, `prompts[${index}]`);
    warnUnsupportedStPromptFields(prompt, id, warnings, `prompts[${index}]`);
    const orderEntry = selectedOrder.get(id);
    return {
        id,
        name: cleanName(prompt.name, id),
        slot: stPromptSlot(explicitIdentifier ?? id),
        role,
        template,
        enabled: selectedOrder.size > 0 ? (orderEntry?.enabled ?? false) : cleanBoolean(prompt.enabled, `prompts[${index}].enabled`, true),
        priority: 0,
        tokenBudget: null,
        clipPolicy: 'tail',
        requires: [],
        conflicts: [],
        exclusiveGroup: null,
        when: null,
        sourceRef: { format: 'sillytavern', identifier: explicitIdentifier ?? id, promptIndex: index },
        includeData: marker,
        marker,
    };
}

function makeMissingOrderModule(entry, index, warnings) {
    const marker = ST_MARKER_IDENTIFIERS.has(entry.identifier);
    warnings.push(compatibilityWarning(
        'missing_prompt_definition',
        'A prompt order entry had no matching prompt definition; an empty module was created.',
        { moduleId: entry.identifier },
    ));
    return {
        id: entry.identifier,
        name: entry.identifier,
        slot: stPromptSlot(entry.identifier),
        role: 'system',
        template: '',
        enabled: entry.enabled,
        priority: 0,
        tokenBudget: null,
        clipPolicy: 'tail',
        requires: [],
        conflicts: [],
        exclusiveGroup: null,
        when: null,
        sourceRef: { format: 'sillytavern', identifier: entry.identifier, promptOrderIndex: index },
        includeData: marker,
        marker,
    };
}

function makeContextStoryModule(context, usedIdentifiers, warnings) {
    const template = context && typeof context.story_string === 'string' ? context.story_string : '';
    if (!template.trim()) return null;
    const base = `st-context-${sha256(Buffer.from(template, 'utf8')).slice(0, 24)}`;
    let id = base;
    let suffix = 2;
    while (usedIdentifiers.has(id)) id = `${base}-${suffix++}`;
    usedIdentifiers.add(id);
    scanUnsupportedPromptFeatures(template, id, warnings, 'context.story_string');
    return {
        id,
        name: cleanName(context.name, 'Context Story String'),
        slot: 'main',
        role: 'system',
        template,
        enabled: true,
        priority: 0,
        tokenBudget: null,
        clipPolicy: 'tail',
        requires: [],
        conflicts: [],
        exclusiveGroup: null,
        when: null,
        sourceRef: { format: 'sillytavern-context', field: 'story_string' },
        includeData: false,
        marker: false,
    };
}

function promptProfileV2FromChatCompletion(chatSource, detected, { context = null, reasoning = null } = {}) {
    if (!Object.hasOwn(chatSource, 'prompts') && !Object.hasOwn(chatSource, 'prompt_order')) return null;
    const prompts = chatSource.prompts ?? [];
    if (!Array.isArray(prompts) || prompts.length > MAX_PROFILE_MODULES) {
        throw new CompatImportError(`prompts must contain at most ${MAX_PROFILE_MODULES} entries.`, 'invalid_resource_field');
    }
    const warnings = [];
    const selection = selectStPromptOrder(chatSource.prompt_order);
    if (selection.ignoredCharacterIds.length > 0) {
        warnings.push(compatibilityWarning(
            'prompt_order_groups_reduced',
            'Only one SillyTavern character prompt_order group can be active in StoryStudio; other groups were preserved in source metadata.',
            {
                selectedCharacterId: selection.characterId,
                ignoredCharacterIds: selection.ignoredCharacterIds,
            },
        ));
    }
    const selectedOrder = new Map(selection.entries.map((entry, index) => [entry.identifier, { ...entry, index }]));
    const usedIdentifiers = new Set();
    const modules = prompts.map((prompt, index) => (
        makeImportedPromptModule(prompt, index, selectedOrder, usedIdentifiers, warnings)
    ));
    const moduleById = new Map(modules.map(module => [module.id, module]));
    for (const [index, entry] of selection.entries.entries()) {
        if (moduleById.has(entry.identifier)) continue;
        const module = makeMissingOrderModule(entry, index, warnings);
        modules.push(module);
        moduleById.set(module.id, module);
    }
    const contextStoryModule = makeContextStoryModule(context, usedIdentifiers, warnings);
    if (contextStoryModule) {
        modules.push(contextStoryModule);
        moduleById.set(contextStoryModule.id, contextStoryModule);
    }
    if (reasoning !== null) {
        warnings.push(compatibilityWarning(
            'unsupported_reasoning',
            'SillyTavern reasoning wrappers are preserved for reference but are not executed.',
            { field: 'reasoning' },
        ));
    }
    if (modules.length > MAX_PROFILE_MODULES) {
        throw new CompatImportError(`Prompt profile must contain at most ${MAX_PROFILE_MODULES} modules.`, 'resource_array_too_large');
    }

    const orderedIds = selection.entries.map(entry => entry.identifier);
    for (const module of modules) {
        if (module !== contextStoryModule && !orderedIds.includes(module.id)) orderedIds.push(module.id);
    }
    if (contextStoryModule) {
        const mainIndex = orderedIds.indexOf('main');
        orderedIds.splice(mainIndex >= 0 ? mainIndex + 1 : 0, 0, contextStoryModule.id);
    }
    const compatibilityWarnings = uniqueCompatibilityWarnings(warnings);
    return {
        profileVersion: 2,
        modules,
        order: orderedIds,
        variables: [],
        taskPolicies: {},
        compatibility: {
            sourceFormat: detected,
            promptOrderMode: selection.mode,
            selectedCharacterId: selection.characterId,
            warnings: compatibilityWarnings,
            unsupportedFeatures: [...new Set(compatibilityWarnings.map(item => item.code))],
        },
    };
}

function normalizeOptionalSection(value, label, fields) {
    if (value === undefined || value === null) return null;
    const input = assertPlainObject(value, label);
    const result = {};
    for (const field of fields) {
        if (input[field] !== undefined) {
            result[field] = typeof input[field] === 'boolean'
                ? input[field]
                : cleanString(input[field], `${label}.${field}`, 500_000);
        }
    }
    return result;
}

function promptProfileDraftFromValue(value, { fileName } = {}) {
    const original = assertPlainObject(value, 'prompt preset');
    const safeOriginal = safeJsonClone(original, 'prompt preset');
    const removedSensitiveFields = [];
    const redacted = redactPreset(safeOriginal, '', removedSensitiveFields);
    if (Object.hasOwn(redacted, 'profileVersion')) {
        assertKnownKeys(redacted, PROMPT_PROFILE_FIELDS, 'native prompt profile');
        const existingSource = assertPlainObject(redacted.source ?? {}, 'prompt profile.source');
        return {
            type: 'prompt-profile',
            draft: normalizeInternalPromptProfile({
                ...redacted,
                source: {
                    format: 'story-studio-prompt-profile-v2',
                    fileName,
                    ...existingSource,
                    ...(removedSensitiveFields.length > 0 ? { removedSensitiveFields } : {}),
                },
            }),
        };
    }
    const isMaster = ['instruct', 'context', 'preset', 'sysprompt', 'reasoning', 'srw']
        .some(field => Object.hasOwn(redacted, field));
    let instruct = null;
    let context = null;
    let generationSource = redacted;
    let chatSource = redacted;
    let systemPrompt = null;
    let reasoning = null;
    let startReplyWith = null;
    let detected = 'prompt-preset';

    if (isMaster) {
        instruct = normalizeInstruct(redacted.instruct);
        context = normalizeContext(redacted.context);
        generationSource = redacted.preset ?? {};
        chatSource = redacted.preset ?? {};
        systemPrompt = normalizeOptionalSection(redacted.sysprompt, 'system prompt', ['name', 'content', 'post_history', 'enabled']);
        reasoning = normalizeOptionalSection(redacted.reasoning, 'reasoning', ['name', 'prefix', 'suffix', 'separator']);
        startReplyWith = normalizeOptionalSection(redacted.srw, 'start reply with', ['value', 'show']);
        detected = 'sillytavern-formatting-bundle';
    } else if (Object.hasOwn(redacted, 'input_sequence') || Object.hasOwn(redacted, 'output_sequence')) {
        if (typeof redacted.input_sequence !== 'string' || typeof redacted.output_sequence !== 'string') {
            throw new CompatImportError('Instruct presets require string input_sequence and output_sequence fields.', 'invalid_prompt_preset');
        }
        instruct = normalizeInstruct({ ...redacted, name: redacted.name ?? fileStem(fileName) });
        generationSource = {};
        chatSource = {};
        detected = 'sillytavern-instruct';
    } else if (Object.hasOwn(redacted, 'story_string')) {
        context = normalizeContext({ ...redacted, name: redacted.name ?? fileStem(fileName) });
        generationSource = {};
        chatSource = {};
        detected = 'sillytavern-context';
    } else if (!['temperature', 'temp', 'top_p', 'top_k', 'rep_pen', 'prompts', 'chat_completion_source', 'openai_max_context']
        .some(field => Object.hasOwn(redacted, field))) {
        throw new CompatImportError('JSON is not a recognized SillyTavern prompt preset.', 'unsupported_resource_format');
    } else {
        detected = Object.hasOwn(redacted, 'prompts') || Object.hasOwn(redacted, 'chat_completion_source')
            ? 'sillytavern-chat-completion-preset'
            : 'sillytavern-text-completion-preset';
    }

    const name = cleanName(redacted.name, fileStem(fileName));
    const chatCompletion = Object.keys(chatSource).length > 0 ? normalizeChatCompletion(chatSource) : {};
    const profileV2 = promptProfileV2FromChatCompletion(chatSource, detected, { context, reasoning });
    const compatibilityWarnings = profileV2?.compatibility?.warnings ?? (reasoning !== null ? [compatibilityWarning(
        'unsupported_reasoning',
        'SillyTavern reasoning wrappers are preserved for reference but are not executed.',
        { field: 'reasoning' },
    )] : []);
    return {
        type: 'prompt-profile',
        draft: {
            name,
            instruct,
            context,
            generation: normalizeGeneration(generationSource),
            chatCompletion,
            systemPrompt,
            reasoning,
            startReplyWith,
            ...(profileV2 ?? {}),
            source: normalizeSource(detected, detected, '', fileName, redacted, {
                removedSensitiveFields,
                ...(compatibilityWarnings.length > 0 ? { compatibilityWarnings } : {}),
            }),
        },
    };
}

function detectJsonResource(value, options) {
    const input = assertPlainObject(value, 'resource JSON');
    if (input.spec !== undefined || V1_CHARACTER_REQUIRED_FIELDS.every(field => Object.hasOwn(input, field))) {
        return characterDraftFromCard(input, { ...options, format: options.format || 'tavern-card-json' });
    }
    if (Object.hasOwn(input, 'entries')) return lorebookDraftFromValue(input, options);
    return promptProfileDraftFromValue(input, options);
}

export function parseCompatImport(inputValue) {
    const input = assertPlainObject(inputValue, 'resource import');
    assertKnownKeys(input, ['fileName', 'mediaType', 'encoding', 'data'], 'resource import');
    const fileName = cleanString(input.fileName, 'fileName', 255, 'import.json');
    const mediaType = cleanString(input.mediaType, 'mediaType', 128, 'application/json').toLowerCase();
    const encoding = cleanString(input.encoding, 'encoding', 32, typeof input.data === 'string' ? 'utf8' : 'json').toLowerCase();
    const png = mediaType === 'image/png' || fileName.toLowerCase().endsWith('.png');

    if (png) {
        if (encoding !== 'base64') {
            throw new CompatImportError('PNG imports require Base64 encoding.', 'invalid_resource_encoding');
        }
        const parsed = parseCharacterPng(parseBase64(input.data));
        return characterDraftFromCard(parsed.card, {
            fileName,
            format: 'tavern-card-png',
            avatar: parsed.avatar,
            metadataKind: parsed.metadataKind,
            warnings: parsed.warnings,
        });
    }

    let value;
    if (encoding === 'json') {
        value = safeJsonClone(input.data, 'resource JSON');
    } else if (encoding === 'utf8') {
        if (typeof input.data !== 'string' || Buffer.byteLength(input.data, 'utf8') > MAX_COMPAT_JSON_BYTES) {
            throw new CompatImportError('JSON text exceeds the import limit.', 'resource_too_large', { maximum: MAX_COMPAT_JSON_BYTES }, 413);
        }
        try {
            value = safeJsonClone(JSON.parse(input.data), 'resource JSON');
        } catch (error) {
            if (error instanceof CompatImportError) throw error;
            throw new CompatImportError('Resource file is not valid JSON.', 'invalid_json');
        }
    } else {
        throw new CompatImportError('Unsupported resource encoding.', 'invalid_resource_encoding');
    }
    return detectJsonResource(value, { fileName, format: '' });
}

export function normalizeResourceType(value) {
    const normalized = RESOURCE_TYPE_ALIASES.get(String(value).toLowerCase());
    if (!normalized || !RESOURCE_TYPES.has(normalized)) {
        throw new CompatImportError('Unknown resource type.', 'invalid_resource_type', { value });
    }
    return normalized;
}

function normalizeInternalCharacter(value) {
    const input = assertPlainObject(value, 'character resource');
    return {
        name: cleanName(input.name, 'Imported character'),
        description: cleanString(input.description, 'character.description', 250_000),
        personality: cleanString(input.personality, 'character.personality', 250_000),
        scenario: cleanString(input.scenario, 'character.scenario', 250_000),
        openingSample: cleanString(input.openingSample, 'character.openingSample', 250_000),
        dialogueExamples: cleanString(input.dialogueExamples, 'character.dialogueExamples', 500_000),
        creatorNotes: cleanString(input.creatorNotes, 'character.creatorNotes', 250_000),
        instruction: cleanString(input.instruction, 'character.instruction', 250_000),
        postInstruction: cleanString(input.postInstruction, 'character.postInstruction', 250_000),
        openingSamples: cleanStringArray(input.openingSamples, 'character.openingSamples', 1_000, 250_000),
        tags: cleanStringArray(input.tags, 'character.tags', 1_000, 1_000),
        creator: cleanString(input.creator, 'character.creator', 10_000),
        characterVersion: cleanString(input.characterVersion, 'character.characterVersion', 1_000),
        extensions: safeJsonClone(assertPlainObject(input.extensions ?? {}, 'character.extensions'), 'character.extensions'),
        depthPrompt: normalizeDepthPrompt(input.depthPrompt),
        instructionEnabled: cleanBoolean(input.instructionEnabled, 'character.instructionEnabled', false),
        embeddedLorebookId: input.embeddedLorebookId === null || input.embeddedLorebookId === undefined
            ? null
            : cleanString(input.embeddedLorebookId, 'character.embeddedLorebookId', 64),
        avatar: input.avatar === null || input.avatar === undefined ? null : safeJsonClone(assertPlainObject(input.avatar, 'character.avatar'), 'character.avatar'),
        source: safeJsonClone(assertPlainObject(input.source ?? {}, 'character.source'), 'character.source'),
    };
}

function normalizeInternalLorebook(value) {
    const input = assertPlainObject(value, 'lorebook resource');
    if (!Array.isArray(input.entries) || input.entries.length > MAX_LOREBOOK_ENTRIES) {
        throw new CompatImportError('lorebook.entries is invalid.', 'invalid_lorebook');
    }
    const entries = input.entries.map((entry, index) => {
        const normalized = normalizeLorebookEntry({
            ...entry,
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondaryKeys,
            disable: entry.enabled === false,
            order: entry.insertionOrder,
            extensions: {
                ...(entry.extensions ?? {}),
                position: entry.position,
                role: entry.role,
                depth: entry.depth,
                probability: entry.probability,
                useProbability: entry.useProbability,
                exclude_recursion: entry.excludeRecursion,
                prevent_recursion: entry.preventRecursion,
                delay_until_recursion: entry.delayUntilRecursion,
                group: entry.group,
                group_override: entry.groupOverride,
                group_weight: entry.groupWeight,
                scan_depth: entry.scanDepth,
                case_sensitive: entry.caseSensitive,
                match_whole_words: entry.matchWholeWords,
                use_group_scoring: entry.useGroupScoring,
                sticky: entry.sticky,
                cooldown: entry.cooldown,
                delay: entry.delay,
                triggers: entry.triggers,
                ignore_budget: entry.ignoreBudget,
                vectorized: entry.vectorized,
                selectiveLogic: entry.selectiveLogic,
            },
        }, index, 'sillytavern-world-info');
        normalized.id = entryId(entry.id, index);
        normalized.sourceUid = entry.sourceUid ?? normalized.sourceUid;
        return normalized;
    });
    const ids = new Set(entries.map(entry => entry.id));
    if (ids.size !== entries.length) throw new CompatImportError('Lorebook contains duplicate entry identifiers.', 'duplicate_lorebook_entry');
    return {
        name: cleanName(input.name, 'Imported lorebook'),
        description: cleanString(input.description, 'lorebook.description', 250_000),
        scanDepth: optionalNumber(input.scanDepth, 'lorebook.scanDepth', 0, 100_000, { integer: true }),
        tokenBudget: optionalNumber(input.tokenBudget, 'lorebook.tokenBudget', 0, 2_000_000, { integer: true }),
        recursiveScanning: cleanBoolean(input.recursiveScanning, 'lorebook.recursiveScanning', false),
        extensions: safeJsonClone(assertPlainObject(input.extensions ?? {}, 'lorebook.extensions'), 'lorebook.extensions'),
        entries,
        source: safeJsonClone(assertPlainObject(input.source ?? {}, 'lorebook.source'), 'lorebook.source'),
    };
}

function cloneBoundedProfileValue(value, label, {
    maximumArrayItems = MAX_PROFILE_REFERENCES,
    maximumObjectKeys = MAX_PROFILE_REFERENCES,
    maximumStringLength = 20_000,
    maximumDepth = 12,
} = {}) {
    let nodes = 0;
    const visit = (current, depth, field) => {
        if (++nodes > 20_000 || depth > maximumDepth) {
            throw new CompatImportError(`${label} is too complex.`, 'resource_too_complex');
        }
        if (current === null || typeof current === 'boolean') return current;
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) {
                throw new CompatImportError(`${field} must be a finite number.`, 'invalid_resource_data');
            }
            return current;
        }
        if (typeof current === 'string') {
            if (current.length > maximumStringLength) {
                throw new CompatImportError(`${field} is too long.`, 'resource_field_too_large', {
                    field,
                    maximum: maximumStringLength,
                });
            }
            return current;
        }
        if (Array.isArray(current)) {
            if (current.length > maximumArrayItems) {
                throw new CompatImportError(`${field} contains too many items.`, 'resource_array_too_large', {
                    field,
                    maximum: maximumArrayItems,
                });
            }
            return current.map((item, index) => visit(item, depth + 1, `${field}[${index}]`));
        }
        if (!current || typeof current !== 'object') {
            throw new CompatImportError(`${field} contains an unsupported value.`, 'invalid_resource_data');
        }
        const entries = Object.entries(current);
        if (entries.length > maximumObjectKeys) {
            throw new CompatImportError(`${field} contains too many fields.`, 'resource_too_complex');
        }
        const result = {};
        for (const [key, item] of entries) {
            if (DANGEROUS_KEYS.has(key)) {
                throw new CompatImportError(`${field} contains a forbidden key.`, 'unsafe_resource_key', { key });
            }
            if (key.length > MAX_PROFILE_IDENTIFIER_LENGTH) {
                throw new CompatImportError(`${field} contains an oversized field name.`, 'resource_field_too_large');
            }
            result[key] = visit(item, depth + 1, `${field}.${key}`);
        }
        return result;
    };
    return visit(value, 0, label);
}

function normalizeProfileReferences(value, label) {
    const identifiers = cleanStringArray(value, label, MAX_PROFILE_REFERENCES, MAX_PROFILE_IDENTIFIER_LENGTH)
        .map((identifier, index) => cleanProfileIdentifier(identifier, `${label}[${index}]`));
    if (new Set(identifiers).size !== identifiers.length) {
        throw new CompatImportError(`${label} contains duplicate identifiers.`, 'duplicate_prompt_identifier');
    }
    return identifiers;
}

function normalizeProfileModule(value, index) {
    const input = assertPlainObject(value, `prompt profile.modules[${index}]`);
    assertKnownKeys(input, PROFILE_MODULE_FIELDS, `prompt profile.modules[${index}]`);
    const id = cleanProfileIdentifier(input.id, `prompt profile.modules[${index}].id`);
    const slot = cleanString(input.slot, `prompt profile.modules[${index}].slot`, 64, 'custom').trim();
    if (!slot) {
        throw new CompatImportError('Prompt module slot cannot be empty.', 'invalid_resource_field');
    }
    const role = cleanString(input.role, `prompt profile.modules[${index}].role`, 32, 'system').trim();
    if (!PROFILE_ROLES.has(role)) {
        throw new CompatImportError('Prompt module role is invalid.', 'invalid_resource_field', { role });
    }
    const clipPolicy = cleanString(input.clipPolicy, `prompt profile.modules[${index}].clipPolicy`, 16, 'tail');
    if (!PROFILE_CLIP_POLICIES.has(clipPolicy)) {
        throw new CompatImportError('Prompt module clipPolicy is invalid.', 'invalid_resource_field', { clipPolicy });
    }
    let when = null;
    if (input.when !== undefined && input.when !== null) {
        when = cloneBoundedProfileValue(
            assertPlainObject(input.when, `prompt profile.modules[${index}].when`),
            `prompt profile.modules[${index}].when`,
            { maximumArrayItems: 50, maximumObjectKeys: 50, maximumStringLength: 2_000, maximumDepth: 8 },
        );
    }
    let sourceRef = null;
    if (input.sourceRef !== undefined && input.sourceRef !== null) {
        sourceRef = cloneBoundedProfileValue(
            assertPlainObject(input.sourceRef, `prompt profile.modules[${index}].sourceRef`),
            `prompt profile.modules[${index}].sourceRef`,
            { maximumArrayItems: 50, maximumObjectKeys: 50, maximumStringLength: 2_000, maximumDepth: 8 },
        );
    }
    return {
        id,
        name: cleanName(input.name, id),
        slot,
        role,
        template: cleanString(input.template, `prompt profile.modules[${index}].template`, MAX_PROFILE_TEMPLATE_LENGTH),
        enabled: cleanBoolean(input.enabled, `prompt profile.modules[${index}].enabled`, true),
        priority: cleanNumber(input.priority, `prompt profile.modules[${index}].priority`, -1_000_000, 1_000_000, 0, { integer: true }),
        tokenBudget: cleanNumber(input.tokenBudget, `prompt profile.modules[${index}].tokenBudget`, 0, 2_000_000, null, { integer: true }),
        clipPolicy,
        requires: normalizeProfileReferences(input.requires, `prompt profile.modules[${index}].requires`),
        conflicts: normalizeProfileReferences(input.conflicts, `prompt profile.modules[${index}].conflicts`),
        exclusiveGroup: input.exclusiveGroup === undefined || input.exclusiveGroup === null
            ? null
            : cleanProfileIdentifier(input.exclusiveGroup, `prompt profile.modules[${index}].exclusiveGroup`),
        when,
        sourceRef,
        includeData: cleanBoolean(input.includeData, `prompt profile.modules[${index}].includeData`, false),
        marker: cleanBoolean(input.marker, `prompt profile.modules[${index}].marker`, false),
    };
}

function normalizeProfileModules(value) {
    if (!Array.isArray(value) || value.length > MAX_PROFILE_MODULES) {
        throw new CompatImportError(`prompt profile.modules must contain at most ${MAX_PROFILE_MODULES} entries.`, 'invalid_resource_field');
    }
    const modules = value.map((module, index) => normalizeProfileModule(module, index));
    const identifiers = modules.map(module => module.id);
    if (new Set(identifiers).size !== identifiers.length) {
        throw new CompatImportError('prompt profile.modules contains duplicate IDs.', 'duplicate_prompt_identifier');
    }
    const known = new Set(identifiers);
    for (const module of modules) {
        for (const reference of [...module.requires, ...module.conflicts]) {
            if (!known.has(reference) || reference === module.id) {
                throw new CompatImportError('Prompt module dependencies must reference another module.', 'invalid_prompt_reference', {
                    moduleId: module.id,
                    reference,
                });
            }
        }
    }
    return modules;
}

function normalizeProfileOrder(value, modules) {
    const order = cleanStringArray(value, 'prompt profile.order', MAX_PROFILE_MODULES, MAX_PROFILE_IDENTIFIER_LENGTH)
        .map((identifier, index) => cleanProfileIdentifier(identifier, `prompt profile.order[${index}]`));
    if (new Set(order).size !== order.length) {
        throw new CompatImportError('prompt profile.order contains duplicate IDs.', 'duplicate_prompt_identifier');
    }
    const moduleIds = new Set(modules.map(module => module.id));
    if (order.some(identifier => !moduleIds.has(identifier))) {
        throw new CompatImportError('prompt profile.order contains an unknown module ID.', 'invalid_prompt_order');
    }
    return order;
}

function normalizeProfileVariables(value) {
    if (!Array.isArray(value) || value.length > MAX_PROFILE_VARIABLES) {
        throw new CompatImportError(`prompt profile.variables must contain at most ${MAX_PROFILE_VARIABLES} entries.`, 'invalid_resource_field');
    }
    const identifiers = new Set();
    return value.map((variableValue, index) => {
        const variable = cloneBoundedProfileValue(
            assertPlainObject(variableValue, `prompt profile.variables[${index}]`),
            `prompt profile.variables[${index}]`,
            { maximumArrayItems: MAX_PROFILE_REFERENCES, maximumObjectKeys: 50, maximumStringLength: 20_000, maximumDepth: 8 },
        );
        if (variable.id !== undefined) {
            variable.id = cleanProfileIdentifier(variable.id, `prompt profile.variables[${index}].id`);
            if (identifiers.has(variable.id)) {
                throw new CompatImportError('prompt profile.variables contains duplicate IDs.', 'duplicate_prompt_identifier');
            }
            identifiers.add(variable.id);
        }
        if (variable.name !== undefined) variable.name = cleanString(variable.name, `prompt profile.variables[${index}].name`, 160);
        if (variable.type !== undefined) variable.type = cleanString(variable.type, `prompt profile.variables[${index}].type`, 32);
        return variable;
    });
}

function normalizeInternalChatCompletion(value, removedSensitiveFields) {
    if (value === undefined) return {};
    const safe = redactPreset(
        safeJsonClone(assertPlainObject(value, 'prompt profile.chatCompletion'), 'prompt profile.chatCompletion'),
        'chatCompletion',
        removedSensitiveFields,
    );
    if (safe.prompts !== undefined && (!Array.isArray(safe.prompts) || safe.prompts.length > MAX_PROFILE_MODULES)) {
        throw new CompatImportError(`chatCompletion.prompts must contain at most ${MAX_PROFILE_MODULES} entries.`, 'invalid_resource_field');
    }
    if (safe.promptOrder !== undefined) selectStPromptOrder(safe.promptOrder);
    if (safe.modelHints !== undefined) {
        const hints = assertPlainObject(safe.modelHints, 'prompt profile.chatCompletion.modelHints');
        if (Object.keys(hints).length > 20) {
            throw new CompatImportError('chatCompletion.modelHints contains too many fields.', 'invalid_resource_field');
        }
        safe.modelHints = Object.fromEntries(Object.entries(hints).map(([key, hint]) => [
            cleanString(key, 'chatCompletion.modelHints key', 64),
            cleanString(hint, `chatCompletion.modelHints.${key}`, 256),
        ]));
    }
    return safe;
}

function normalizeInternalPromptProfile(value) {
    const input = assertPlainObject(value, 'prompt profile resource');
    const removedSensitiveFields = [];
    const safeSource = redactPreset(safeJsonClone(assertPlainObject(input.source ?? {}, 'prompt profile.source'), 'prompt profile.source'), 'source', removedSensitiveFields);
    const chatCompletion = normalizeInternalChatCompletion(input.chatCompletion, removedSensitiveFields);
    const hasV2Fields = [
        'profileVersion', 'modules', 'order', 'variables', 'variableValues', 'generationPolicies',
        'taskPolicies', 'tokenBudget', 'characterBudget', 'compatibility',
    ]
        .some(field => input[field] !== undefined);
    if (removedSensitiveFields.length > 0) {
        const prior = Array.isArray(safeSource.removedSensitiveFields) ? safeSource.removedSensitiveFields : [];
        safeSource.removedSensitiveFields = [...new Set([...prior, ...removedSensitiveFields])];
    }
    const result = {
        name: cleanName(input.name, 'Imported prompt profile'),
        instruct: normalizeInstruct(input.instruct),
        context: normalizeContext(input.context),
        generation: normalizeGeneration(input.generation ?? {}),
        chatCompletion,
        systemPrompt: input.systemPrompt === undefined ? null : normalizeOptionalSection(input.systemPrompt, 'system prompt', ['name', 'content', 'post_history', 'enabled']),
        reasoning: input.reasoning === undefined ? null : normalizeOptionalSection(input.reasoning, 'reasoning', ['name', 'prefix', 'suffix', 'separator']),
        startReplyWith: input.startReplyWith === undefined ? null : normalizeOptionalSection(input.startReplyWith, 'start reply with', ['value', 'show']),
        source: safeSource,
    };
    if (!hasV2Fields) return result;
    if (input.profileVersion !== 2) {
        throw new CompatImportError('Prompt Profile V2 requires profileVersion 2.', 'unsupported_prompt_profile_version');
    }
    const modulesInput = redactPreset(
        safeJsonClone(input.modules, 'prompt profile.modules'),
        'modules',
        removedSensitiveFields,
    );
    const variablesInput = redactPreset(
        safeJsonClone(input.variables ?? [], 'prompt profile.variables'),
        'variables',
        removedSensitiveFields,
    );
    const taskPoliciesInput = redactPreset(
        safeJsonClone(assertPlainObject(input.taskPolicies ?? {}, 'prompt profile.taskPolicies'), 'prompt profile.taskPolicies'),
        'taskPolicies',
        removedSensitiveFields,
    );
    const variableValuesInput = redactPreset(
        safeJsonClone(assertPlainObject(input.variableValues ?? {}, 'prompt profile.variableValues'), 'prompt profile.variableValues'),
        'variableValues',
        removedSensitiveFields,
    );
    const generationPoliciesInput = redactPreset(
        safeJsonClone(assertPlainObject(input.generationPolicies ?? {}, 'prompt profile.generationPolicies'), 'prompt profile.generationPolicies'),
        'generationPolicies',
        removedSensitiveFields,
    );
    const compatibilityInput = redactPreset(
        safeJsonClone(assertPlainObject(input.compatibility ?? {}, 'prompt profile.compatibility'), 'prompt profile.compatibility'),
        'compatibility',
        removedSensitiveFields,
    );
    const tokenBudget = cleanNumber(input.tokenBudget, 'prompt profile.tokenBudget', 0, 2_000_000, null, { integer: true });
    const characterBudget = cleanNumber(input.characterBudget, 'prompt profile.characterBudget', 0, 2_000_000, null, { integer: true });
    const modules = normalizeProfileModules(modulesInput);
    Object.assign(result, {
        profileVersion: 2,
        modules,
        order: normalizeProfileOrder(input.order, modules),
        variables: normalizeProfileVariables(variablesInput),
        variableValues: cloneBoundedProfileValue(variableValuesInput, 'prompt profile.variableValues', {
            maximumArrayItems: MAX_PROFILE_REFERENCES,
            maximumObjectKeys: MAX_PROFILE_VARIABLES,
            maximumStringLength: 20_000,
            maximumDepth: 8,
        }),
        generationPolicies: cloneBoundedProfileValue(generationPoliciesInput, 'prompt profile.generationPolicies', {
            maximumArrayItems: MAX_PROFILE_REFERENCES,
            maximumObjectKeys: MAX_PROFILE_REFERENCES,
            maximumStringLength: 20_000,
            maximumDepth: 8,
        }),
        taskPolicies: cloneBoundedProfileValue(taskPoliciesInput, 'prompt profile.taskPolicies', {
            maximumArrayItems: MAX_PROFILE_REFERENCES,
            maximumObjectKeys: MAX_PROFILE_REFERENCES,
            maximumStringLength: 20_000,
            maximumDepth: 10,
        }),
        compatibility: cloneBoundedProfileValue(compatibilityInput, 'prompt profile.compatibility', {
            maximumArrayItems: MAX_PROFILE_MODULES,
            maximumObjectKeys: MAX_PROFILE_REFERENCES,
            maximumStringLength: 20_000,
            maximumDepth: 10,
        }),
        ...(tokenBudget !== null ? { tokenBudget } : {}),
        ...(characterBudget !== null ? { characterBudget } : {}),
    });
    if (removedSensitiveFields.length > 0) {
        const prior = Array.isArray(safeSource.removedSensitiveFields) ? safeSource.removedSensitiveFields : [];
        safeSource.removedSensitiveFields = [...new Set([...prior, ...removedSensitiveFields])];
    }
    return result;
}

function typeFields(type) {
    if (type === 'character') return CHARACTER_FIELDS;
    if (type === 'lorebook') return LOREBOOK_FIELDS;
    return PROMPT_PROFILE_FIELDS;
}

function normalizeResourceData(type, value) {
    const input = assertPlainObject(value, `${type} resource`);
    assertKnownKeys(input, typeFields(type), `${type} resource`);
    if (type === 'character') return normalizeInternalCharacter(input);
    if (type === 'lorebook') return normalizeInternalLorebook(input);
    return normalizeInternalPromptProfile(input);
}

export function createResourceRecord(typeValue, projectId, draftValue, { id = randomUUID(), timestamp = new Date().toISOString() } = {}) {
    const type = normalizeResourceType(typeValue);
    const draft = normalizeResourceData(type, draftValue);
    const record = {
        schemaVersion: RESOURCE_SCHEMA_VERSION,
        type,
        id,
        projectId,
        ...draft,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    assertResourceRecordSize(record);
    return record;
}

export function normalizeExportedResource(value, expectedType = null) {
    const input = assertPlainObject(value, 'exported resource');
    const type = normalizeResourceType(expectedType ?? input.type);
    assertKnownKeys(input, [...RESOURCE_RECORD_FIELDS, ...typeFields(type)], 'exported resource');
    if (input.schemaVersion !== RESOURCE_SCHEMA_VERSION || input.type !== type) {
        throw new CompatImportError('Exported resource uses an unsupported schema.', 'unsupported_resource_schema');
    }
    const data = Object.fromEntries(typeFields(type).map(field => [field, input[field]]));
    return {
        type,
        sourceId: cleanString(input.id, 'resource.id', 64),
        draft: normalizeResourceData(type, data),
    };
}

export function updateResourceRecord(resourceValue, changesValue, timestamp = new Date().toISOString()) {
    const resource = assertPlainObject(resourceValue, 'resource');
    const type = normalizeResourceType(resource.type);
    const changes = assertPlainObject(changesValue, 'resource changes');
    assertKnownKeys(changes, typeFields(type).filter(field => field !== 'source' && field !== 'avatar'), 'resource changes');
    if (Object.keys(changes).length === 0) {
        throw new CompatImportError('Resource changes cannot be empty.', 'empty_changes');
    }
    const currentData = Object.fromEntries(typeFields(type).map(field => [field, resource[field]]));
    const data = normalizeResourceData(type, { ...currentData, ...changes });
    const result = {
        ...resource,
        ...data,
        revision: Number(resource.revision) + 1,
        updatedAt: timestamp,
    };
    if (type === 'prompt-profile') {
        for (const field of ['tokenBudget', 'characterBudget']) {
            if (Object.hasOwn(changes, field) && changes[field] === null) delete result[field];
        }
    }
    assertResourceRecordSize(result);
    return result;
}

export function validateResourceRecord(resourceValue, projectId, resourceId, expectedType) {
    const resource = assertPlainObject(resourceValue, 'resource');
    const type = normalizeResourceType(expectedType ?? resource.type);
    assertKnownKeys(resource, [...RESOURCE_RECORD_FIELDS, ...typeFields(type)], 'resource');
    if (resource.schemaVersion !== RESOURCE_SCHEMA_VERSION || resource.type !== type
        || resource.id !== resourceId || resource.projectId !== projectId
        || !Number.isSafeInteger(resource.revision) || resource.revision < 1) {
        throw new CompatImportError('Stored resource uses an unsupported schema.', 'invalid_resource_storage', {}, 500);
    }
    const data = Object.fromEntries(typeFields(type).map(field => [field, resource[field]]));
    normalizeResourceData(type, data);
    assertResourceRecordSize(resource);
    return resource;
}

export function assertResourceRecordSize(resource) {
    const bytes = serializedByteLength(resource);
    if (bytes > MAX_RESOURCE_RECORD_BYTES) {
        throw new CompatImportError('Resource exceeds the storage limit.', 'resource_too_large', { maximum: MAX_RESOURCE_RECORD_BYTES }, 413);
    }
    return bytes;
}

export function resourceSummary(resource) {
    return {
        id: resource.id,
        type: resource.type,
        name: resource.name,
        revision: resource.revision,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
        ...(resource.type === 'lorebook' ? { entryCount: resource.entries.length } : {}),
        ...(resource.type === 'character' ? { avatar: resource.avatar, embeddedLorebookId: resource.embeddedLorebookId } : {}),
    };
}
