const PROFILE_VERSION = 2;
const VARIABLE_TYPES = new Set(['boolean', 'single', 'multi', 'number', 'text']);
const MODULE_ROLES = new Set(['system', 'user', 'assistant']);
const CLIP_POLICIES = new Set(['head', 'tail', 'middle', 'drop', 'error']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GENERATION_NUMBER_RULES = Object.freeze({
    temperature: { minimum: 0, maximum: 2 },
    topP: { minimum: 0, maximum: 1 },
    topK: { minimum: 0, maximum: 100_000, integer: true },
    topA: { minimum: 0, maximum: 1 },
    minP: { minimum: 0, maximum: 1 },
    frequencyPenalty: { minimum: -2, maximum: 2 },
    presencePenalty: { minimum: -2, maximum: 2 },
    repetitionPenalty: { minimum: 0, maximum: 10 },
    seed: { minimum: -1, maximum: 2_147_483_647, integer: true },
    contextTokens: { minimum: 2_048, maximum: 2_000_000, integer: true },
    maxTokens: { minimum: 1, maximum: 200_000, integer: true },
});
const SLOT_ORDER = [
    'main',
    'canon',
    'worldBefore',
    'persona',
    'character',
    'scenario',
    'worldAfter',
    'examples',
    'chapter',
    'retrieval',
    'manuscript',
    'ledger',
    'task',
    'postInstruction',
];
const CONDITION_OPERATOR_ALIASES = new Map([
    ['eq', 'equals'],
    ['equals', 'equals'],
    ['neq', 'notEquals'],
    ['notEquals', 'notEquals'],
    ['in', 'in'],
    ['notIn', 'notIn'],
    ['includes', 'includes'],
    ['gt', 'greaterThan'],
    ['greaterThan', 'greaterThan'],
    ['gte', 'greaterThanOrEqual'],
    ['greaterThanOrEqual', 'greaterThanOrEqual'],
    ['lt', 'lessThan'],
    ['lessThan', 'lessThan'],
    ['lte', 'lessThanOrEqual'],
    ['lessThanOrEqual', 'lessThanOrEqual'],
    ['exists', 'exists'],
    ['truthy', 'truthy'],
    ['falsy', 'falsy'],
]);
const CONDITION_SHORTHANDS = [
    'equals',
    'notEquals',
    'in',
    'notIn',
    'includes',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'exists',
    'truthy',
    'falsy',
];

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function issue(code, message, details = {}) {
    return { code, message, ...details };
}

function canonicalize(value, seen = new WeakSet()) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
    if (!isPlainObject(value)) return null;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).filter(key => !FORBIDDEN_KEYS.has(key)).sort()) {
        const item = value[key];
        if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
            result[key] = canonicalize(item, seen);
        }
    }
    seen.delete(value);
    return result;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
}

// Synchronous SHA-256 keeps profile compilation deterministic in both Node and browsers.
function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const words = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
        for (let index = 16; index < 64; index++) {
            const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
            const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index++) {
            const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const first = (h + upperSigma1 + choice + constants[index] + words[index]) >>> 0;
            const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const second = (upperSigma0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + first) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (first + second) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    return hash.map(item => item.toString(16).padStart(8, '0')).join('');
}

export function estimatePromptTokens(text) {
    const source = String(text ?? '');
    if (!source) return 0;
    const hanCharacters = source.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const compactNonHan = source.replace(/[\p{Script=Han}\s]/gu, '').length;
    const baseEstimate = hanCharacters + Math.ceil(compactNonHan / 4);
    return Math.max(1, Math.ceil(baseEstimate * 1.15));
}

function cleanId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function cleanString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function cleanInteger(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function compareIds(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function cleanStringArray(value, path, errors) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        errors.push(issue('invalid_module_reference_list', `${path} must be an array of module ids.`, { path }));
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const item of value) {
        const id = cleanId(item);
        if (!id) {
            errors.push(issue('invalid_module_reference', `${path} contains an invalid module id.`, { path }));
        } else if (!seen.has(id)) {
            result.push(id);
            seen.add(id);
        }
    }
    return result;
}

function normalizeTokenBudget(value, path, errors, fallback = null) {
    if (value === undefined || value === null) return fallback;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0) {
        errors.push(issue('invalid_budget', `${path} must be a non-negative integer.`, { path }));
        return fallback;
    }
    return numeric;
}

function normalizeVariableOptions(value, variableId, errors) {
    if (!Array.isArray(value) || value.length === 0) {
        errors.push(issue(
            'invalid_variable_options',
            `Variable ${variableId} must define at least one option.`,
            { variableId },
        ));
        return [];
    }
    const result = [];
    const keys = new Set();
    for (const option of value) {
        const normalized = isPlainObject(option)
            ? { value: canonicalize(option.value), label: cleanString(option.label, String(option.value ?? '')) }
            : canonicalize(option);
        const optionValue = isPlainObject(normalized) ? normalized.value : normalized;
        if (!['string', 'number', 'boolean'].includes(typeof optionValue) || !Number.isFinite(optionValue) && typeof optionValue === 'number') {
            errors.push(issue('invalid_variable_option', `Variable ${variableId} contains an invalid option.`, { variableId }));
            continue;
        }
        const key = canonicalJson(optionValue);
        if (!keys.has(key)) {
            result.push(normalized);
            keys.add(key);
        }
    }
    return result;
}

function optionValues(spec) {
    return spec.options.map(option => isPlainObject(option) ? option.value : option);
}

function valueMatches(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}

function validateVariableValue(spec, value) {
    switch (spec.type) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'single':
            return optionValues(spec).some(option => valueMatches(option, value));
        case 'multi':
            return Array.isArray(value)
                && value.every((item, index) => optionValues(spec).some(option => valueMatches(option, item))
                    && value.findIndex(candidate => valueMatches(candidate, item)) === index);
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max;
        case 'text':
            return typeof value === 'string' && value.length <= spec.maxLength;
        default:
            return false;
    }
}

function fallbackVariableValue(spec) {
    switch (spec.type) {
        case 'boolean': return false;
        case 'single': return optionValues(spec)[0] ?? '';
        case 'multi': return [];
        case 'number': return Math.max(spec.min, Math.min(spec.max, 0));
        case 'text': return '';
        default: return null;
    }
}

function normalizeVariables(value, errors) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        errors.push(issue('invalid_variables', 'variables must be an array.', { path: 'variables' }));
        return [];
    }
    const result = [];
    const ids = new Set();
    value.forEach((input, index) => {
        if (!isPlainObject(input)) {
            errors.push(issue('invalid_variable', `variables[${index}] must be an object.`, { path: `variables[${index}]` }));
            return;
        }
        const id = cleanId(input.id);
        if (!id || ids.has(id)) {
            errors.push(issue(id ? 'duplicate_variable' : 'invalid_variable_id', `Variable id is invalid or duplicated at index ${index}.`, { variableId: id || null }));
            return;
        }
        ids.add(id);
        const type = cleanString(input.type);
        if (!VARIABLE_TYPES.has(type)) {
            errors.push(issue('invalid_variable_type', `Variable ${id} has an unsupported type.`, { variableId: id, type }));
            return;
        }
        const spec = {
            id,
            type,
            options: ['single', 'multi'].includes(type) ? normalizeVariableOptions(input.options, id, errors) : [],
            min: type === 'number' && Number.isFinite(Number(input.min)) ? Number(input.min) : Number.NEGATIVE_INFINITY,
            max: type === 'number' && Number.isFinite(Number(input.max)) ? Number(input.max) : Number.POSITIVE_INFINITY,
            maxLength: type === 'text' && Number.isInteger(Number(input.maxLength)) && Number(input.maxLength) >= 0
                ? Number(input.maxLength)
                : Number.POSITIVE_INFINITY,
        };
        if (spec.min > spec.max) {
            errors.push(issue('invalid_variable_range', `Variable ${id} has an invalid numeric range.`, { variableId: id }));
            [spec.min, spec.max] = [spec.max, spec.min];
        }
        const defaultValue = input.default === undefined ? fallbackVariableValue(spec) : canonicalize(input.default);
        if (!validateVariableValue(spec, defaultValue)) {
            errors.push(issue('invalid_variable_default', `Variable ${id} has an invalid default value.`, { variableId: id }));
            spec.default = fallbackVariableValue(spec);
        } else {
            spec.default = defaultValue;
        }
        result.push(spec);
    });
    return result;
}

function applyVariableLayer(current, layer, specsById, errors, path) {
    if (layer === undefined || layer === null) return;
    if (!isPlainObject(layer)) {
        errors.push(issue('invalid_variable_values', `${path} must be an object.`, { path }));
        return;
    }
    for (const id of Object.keys(layer).sort()) {
        if (FORBIDDEN_KEYS.has(id)) continue;
        const spec = specsById.get(id);
        if (!spec) {
            errors.push(issue('unknown_variable', `Unknown variable: ${id}.`, { variableId: id, path: `${path}.${id}` }));
            continue;
        }
        const normalized = canonicalize(layer[id]);
        if (!validateVariableValue(spec, normalized)) {
            errors.push(issue('invalid_variable_value', `Variable ${id} has an invalid value.`, { variableId: id, path: `${path}.${id}` }));
            continue;
        }
        current[id] = normalized;
    }
}

function normalizeModule(input, index, errors) {
    if (!isPlainObject(input)) {
        errors.push(issue('invalid_module', `modules[${index}] must be an object.`, { path: `modules[${index}]` }));
        return null;
    }
    const id = cleanId(input.id);
    if (!id) {
        errors.push(issue('invalid_module_id', `modules[${index}].id is required.`, { path: `modules[${index}].id` }));
        return null;
    }
    const role = input.role === undefined ? 'system' : cleanString(input.role);
    if (!MODULE_ROLES.has(role)) {
        errors.push(issue('invalid_module_role', `Module ${id} has an invalid role.`, { moduleId: id, role }));
    }
    const clipPolicy = input.clipPolicy === undefined ? 'tail' : cleanString(input.clipPolicy);
    if (!CLIP_POLICIES.has(clipPolicy)) {
        errors.push(issue('invalid_clip_policy', `Module ${id} has an invalid clip policy.`, { moduleId: id, clipPolicy }));
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        errors.push(issue('invalid_module_enabled', `Module ${id}.enabled must be boolean.`, { moduleId: id }));
    }
    if (input.includeData !== undefined && typeof input.includeData !== 'boolean') {
        errors.push(issue('invalid_module_include_data', `Module ${id}.includeData must be boolean.`, { moduleId: id }));
    }
    if (input.marker !== undefined && typeof input.marker !== 'boolean') {
        errors.push(issue('invalid_module_marker', `Module ${id}.marker must be boolean.`, { moduleId: id }));
    }
    if (input.template !== undefined && typeof input.template !== 'string') {
        errors.push(issue('invalid_module_template', `Module ${id}.template must be a string.`, { moduleId: id }));
    }
    if (input.priority !== undefined && (!Number.isFinite(Number(input.priority)) || !Number.isInteger(Number(input.priority)))) {
        errors.push(issue('invalid_module_priority', `Module ${id}.priority must be an integer.`, { moduleId: id }));
    }
    const when = input.when === undefined || input.when === null ? null : canonicalize(input.when);
    return {
        id,
        name: cleanString(input.name, id),
        slot: cleanString(input.slot, 'task'),
        role: MODULE_ROLES.has(role) ? role : 'system',
        template: cleanString(input.template),
        includeData: input.includeData === true,
        marker: input.marker === true,
        enabled: input.enabled === undefined ? true : input.enabled === true,
        priority: cleanInteger(input.priority, 0),
        tokenBudget: normalizeTokenBudget(input.tokenBudget, `modules[${index}].tokenBudget`, errors),
        clipPolicy: CLIP_POLICIES.has(clipPolicy) ? clipPolicy : 'tail',
        requires: cleanStringArray(input.requires, `modules[${index}].requires`, errors),
        conflicts: cleanStringArray(input.conflicts, `modules[${index}].conflicts`, errors),
        exclusiveGroup: input.exclusiveGroup === undefined || input.exclusiveGroup === null
            ? null
            : cleanId(input.exclusiveGroup) || null,
        when,
        sourceRef: input.sourceRef === undefined ? null : canonicalize(input.sourceRef),
        _sourceIndex: index,
    };
}

function stringifySlotValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(stringifySlotValue).filter(Boolean).join('\n\n');
    if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    return isPlainObject(value) ? JSON.stringify(canonicalize(value), null, 2) : '';
}

function slotValueFor(module, slotValues) {
    if (!isPlainObject(slotValues)) return '';
    if (module.slot !== 'custom' && Object.hasOwn(slotValues, module.slot)) {
        return stringifySlotValue(slotValues[module.slot]);
    }
    const custom = slotValues.custom;
    if (!isPlainObject(custom)) return module.slot === 'custom' ? stringifySlotValue(custom) : '';
    if (Object.hasOwn(custom, module.id)) return stringifySlotValue(custom[module.id]);
    if (Object.hasOwn(custom, module.slot)) return stringifySlotValue(custom[module.slot]);
    return '';
}

function compileModuleText(module, variables, context, slotValues, warnings) {
    const template = expandTemplate(module.template, variables, context, module.id, warnings);
    if (!module.marker && !module.includeData) return template;
    const data = slotValueFor(module, slotValues);
    if (!data) {
        warnings.push(issue(
            'missing_slot_value',
            `Module ${module.id} requested slot ${module.slot}, but no slot value was provided.`,
            { moduleId: module.id, slot: module.slot },
        ));
    }
    return [template, data].filter(Boolean).join('\n\n');
}

function normalizeModules(value, errors) {
    if (!Array.isArray(value)) {
        errors.push(issue('invalid_modules', 'modules must be an array.', { path: 'modules' }));
        return [];
    }
    const modules = [];
    const ids = new Set();
    value.forEach((input, index) => {
        const module = normalizeModule(input, index, errors);
        if (!module) return;
        if (ids.has(module.id)) {
            errors.push(issue('duplicate_module', `Duplicate module id: ${module.id}.`, { moduleId: module.id }));
            return;
        }
        ids.add(module.id);
        modules.push(module);
    });
    return modules;
}

function fallbackModuleOrder(left, right) {
    const leftSlot = SLOT_ORDER.indexOf(left.slot);
    const rightSlot = SLOT_ORDER.indexOf(right.slot);
    const slotDifference = (leftSlot < 0 ? SLOT_ORDER.length : leftSlot) - (rightSlot < 0 ? SLOT_ORDER.length : rightSlot);
    return slotDifference || right.priority - left.priority || left._sourceIndex - right._sourceIndex || compareIds(left.id, right.id);
}

function orderModules(modules, inputOrder, errors, warnings) {
    const byId = new Map(modules.map(module => [module.id, module]));
    if (!Array.isArray(inputOrder)) {
        warnings.push(issue('missing_module_order', 'Profile has no explicit module order; fallback slot order was used.'));
        return [...modules].sort(fallbackModuleOrder);
    }
    const ordered = [];
    const seen = new Set();
    for (const rawId of inputOrder) {
        const id = cleanId(rawId);
        if (!byId.has(id)) {
            errors.push(issue('unknown_order_module', `Order references an unknown module: ${id || String(rawId)}.`, { moduleId: id || String(rawId) }));
        } else if (seen.has(id)) {
            errors.push(issue('duplicate_order_module', `Order contains module ${id} more than once.`, { moduleId: id }));
        } else {
            ordered.push(byId.get(id));
            seen.add(id);
        }
    }
    const missing = modules.filter(module => !seen.has(module.id)).sort(fallbackModuleOrder);
    for (const module of missing) {
        warnings.push(issue(
            'module_missing_from_order',
            `Module ${module.id} was absent from explicit order and appended by fallback order.`,
            { moduleId: module.id },
        ));
    }
    return [...ordered, ...missing];
}

function resolvePath(root, path) {
    const keys = String(path).split('.').filter(Boolean);
    let value = root;
    for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key) || value === null || value === undefined) return undefined;
        value = value[key];
    }
    return value;
}

function normalizeConditionOperator(condition) {
    const explicit = cleanString(condition.operator || condition.op);
    if (explicit) return { operator: CONDITION_OPERATOR_ALIASES.get(explicit), value: condition.value };
    const shorthand = CONDITION_SHORTHANDS.filter(key => Object.hasOwn(condition, key));
    return shorthand.length === 1
        ? { operator: shorthand[0], value: condition[shorthand[0]] }
        : { operator: null, value: undefined };
}

function compareCondition(operator, actual, expected) {
    switch (operator) {
        case 'equals': return valueMatches(actual, expected);
        case 'notEquals': return !valueMatches(actual, expected);
        case 'in': return Array.isArray(expected) && expected.some(item => valueMatches(item, actual));
        case 'notIn': return Array.isArray(expected) && !expected.some(item => valueMatches(item, actual));
        case 'includes':
            if (Array.isArray(actual)) return actual.some(item => valueMatches(item, expected));
            return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
        case 'greaterThan': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
        case 'greaterThanOrEqual': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
        case 'lessThan': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
        case 'lessThanOrEqual': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
        case 'exists': return expected === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
        case 'truthy': return Boolean(actual);
        case 'falsy': return !actual;
        default: return false;
    }
}

function evaluateCondition(condition, environment, moduleId, errors, path = 'when') {
    if (!isPlainObject(condition)) {
        errors.push(issue('invalid_condition', `Module ${moduleId} has a non-structured condition.`, { moduleId, path }));
        return { valid: false, result: false };
    }
    const conditionKeys = Object.keys(condition).filter(key => !FORBIDDEN_KEYS.has(key));
    if (Object.hasOwn(condition, 'all') || Object.hasOwn(condition, 'any')) {
        const key = Object.hasOwn(condition, 'all') ? 'all' : 'any';
        if (conditionKeys.length !== 1 || !Array.isArray(condition[key]) || condition[key].length === 0) {
            errors.push(issue('invalid_condition', `Module ${moduleId} has an invalid ${key} condition.`, { moduleId, path }));
            return { valid: false, result: false };
        }
        const children = condition[key].map((child, index) => evaluateCondition(child, environment, moduleId, errors, `${path}.${key}[${index}]`));
        if (children.some(child => !child.valid)) return { valid: false, result: false };
        return { valid: true, result: key === 'all' ? children.every(child => child.result) : children.some(child => child.result) };
    }
    if (Object.hasOwn(condition, 'not')) {
        if (conditionKeys.length !== 1) {
            errors.push(issue('invalid_condition', `Module ${moduleId} has an ambiguous not condition.`, { moduleId, path }));
            return { valid: false, result: false };
        }
        const child = evaluateCondition(condition.not, environment, moduleId, errors, `${path}.not`);
        return child.valid ? { valid: true, result: !child.result } : child;
    }
    const variableId = cleanId(condition.variable);
    const contextPath = cleanId(condition.context);
    if ((!variableId && !contextPath) || variableId && contextPath) {
        errors.push(issue('invalid_condition', `Module ${moduleId} condition must reference one variable or context path.`, { moduleId, path }));
        return { valid: false, result: false };
    }
    if (variableId && !Object.hasOwn(environment.variables, variableId)) {
        errors.push(issue('unknown_condition_variable', `Module ${moduleId} references unknown variable ${variableId}.`, { moduleId, variableId, path }));
        return { valid: false, result: false };
    }
    const { operator, value } = normalizeConditionOperator(condition);
    const allowedLeafKeys = new Set(['variable', 'context', 'operator', 'op', 'value', ...CONDITION_SHORTHANDS]);
    if (conditionKeys.some(key => !allowedLeafKeys.has(key))) {
        errors.push(issue('invalid_condition', `Module ${moduleId} condition contains unsupported fields.`, { moduleId, path }));
        return { valid: false, result: false };
    }
    if (!operator) {
        errors.push(issue('invalid_condition', `Module ${moduleId} condition has an unsupported operator.`, { moduleId, path }));
        return { valid: false, result: false };
    }
    const actual = variableId ? environment.variables[variableId] : resolvePath(environment.context, contextPath);
    return { valid: true, result: compareCondition(operator, actual, canonicalize(value)) };
}

function stringifyTemplateValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(stringifyTemplateValue).join(', ');
    if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    return JSON.stringify(canonicalize(value));
}

function expandTemplate(template, variables, context, moduleId, warnings) {
    const warned = new Set();
    if (/<%[=-]?[\s\S]*?%>/.test(template)) {
        warnings.push(issue(
            'unsupported_template_syntax',
            `Module ${moduleId} contains EJS syntax; it was preserved as literal text.`,
            { moduleId },
        ));
    }
    return template.replace(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g, (whole, path) => {
        let value;
        let found = false;
        if (Object.hasOwn(variables, path)) {
            value = variables[path];
            found = true;
        } else if (path.startsWith('variables.')) {
            const variableId = path.slice('variables.'.length);
            found = Object.hasOwn(variables, variableId);
            value = variables[variableId];
        } else {
            const contextPath = path.startsWith('context.') ? path.slice('context.'.length) : path;
            value = resolvePath(context, contextPath);
            found = value !== undefined;
        }
        if (found) return stringifyTemplateValue(value);
        if (!warned.has(path)) {
            warnings.push(issue(
                'unknown_template_value',
                `Module ${moduleId} references unknown template value ${path}; it was preserved.`,
                { moduleId, path },
            ));
            warned.add(path);
        }
        return whole;
    });
}

function preferredModule(left, right, orderIndex) {
    if (left.priority !== right.priority) return left.priority > right.priority ? left : right;
    return orderIndex.get(left.id) <= orderIndex.get(right.id) ? left : right;
}

function resolveModuleRules(ordered, states, errors) {
    const byId = new Map(ordered.map(module => [module.id, module]));
    const orderIndex = new Map(ordered.map((module, index) => [module.id, index]));
    const conflictPairs = new Set();
    for (const module of ordered) {
        for (const conflictId of module.conflicts) {
            const conflict = byId.get(conflictId);
            if (!conflict) {
                errors.push(issue(
                    'unknown_module_conflict',
                    `Module ${module.id} conflicts with unknown module ${conflictId}.`,
                    { moduleId: module.id, conflictId },
                ));
                continue;
            }
            if (conflictId === module.id) {
                errors.push(issue(
                    'self_module_conflict',
                    `Module ${module.id} cannot conflict with itself.`,
                    { moduleId: module.id },
                ));
                continue;
            }
            if (!states.get(module.id).included || !states.get(conflictId)?.included) continue;
            const pair = [module.id, conflictId].sort().join('\u0000');
            if (conflictPairs.has(pair)) continue;
            conflictPairs.add(pair);
            const winner = preferredModule(module, conflict, orderIndex);
            const loser = winner === module ? conflict : module;
            states.set(loser.id, { included: false, reason: 'conflict' });
            errors.push(issue(
                'module_conflict',
                `Modules ${module.id} and ${conflictId} conflict; ${winner.id} won deterministically.`,
                { moduleIds: [module.id, conflictId], winnerId: winner.id, loserId: loser.id },
            ));
        }
    }

    const groups = new Map();
    for (const module of ordered) {
        if (module.exclusiveGroup && states.get(module.id).included) {
            const members = groups.get(module.exclusiveGroup) || [];
            members.push(module);
            groups.set(module.exclusiveGroup, members);
        }
    }
    for (const [exclusiveGroup, members] of groups) {
        if (members.length < 2) continue;
        const winner = members.reduce((current, module) => preferredModule(current, module, orderIndex));
        for (const loser of members.filter(module => module !== winner)) {
            states.set(loser.id, { included: false, reason: 'exclusive_group' });
            errors.push(issue(
                'exclusive_group_conflict',
                `Exclusive group ${exclusiveGroup} enabled more than one module; ${winner.id} won deterministically.`,
                { exclusiveGroup, winnerId: winner.id, loserId: loser.id },
            ));
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const module of ordered) {
            if (!states.get(module.id).included) continue;
            for (const dependencyId of module.requires) {
                const dependency = byId.get(dependencyId);
                if (!dependency) {
                    states.set(module.id, { included: false, reason: 'missing_dependency' });
                    errors.push(issue(
                        'missing_module_dependency',
                        `Module ${module.id} requires missing module ${dependencyId}.`,
                        { moduleId: module.id, dependencyId },
                    ));
                    changed = true;
                    break;
                }
                if (!states.get(dependencyId).included) {
                    states.set(module.id, { included: false, reason: 'inactive_dependency' });
                    errors.push(issue(
                        'inactive_module_dependency',
                        `Module ${module.id} requires inactive module ${dependencyId}.`,
                        { moduleId: module.id, dependencyId },
                    ));
                    changed = true;
                    break;
                }
            }
        }
    }
}

function fitsBudgets(text, characterBudget, tokenBudget) {
    return text.length <= characterBudget && estimatePromptTokens(text) <= tokenBudget;
}

function middleSlice(text, retained) {
    if (retained >= text.length) return text;
    const marker = '\n...\n';
    const head = Math.ceil(retained / 2);
    return `${text.slice(0, head)}${marker}${text.slice(text.length - (retained - head))}`;
}

function clipText(text, characterBudget, tokenBudget, policy) {
    if (fitsBudgets(text, characterBudget, tokenBudget)) return text;
    if (characterBudget <= 0 || tokenBudget <= 0) return '';
    let low = 0;
    let high = text.length;
    let best = '';
    while (low <= high) {
        const retained = Math.floor((low + high) / 2);
        let candidate;
        if (policy === 'tail') candidate = text.slice(text.length - retained);
        else if (policy === 'middle') candidate = middleSlice(text, retained);
        else candidate = text.slice(0, retained);
        if (fitsBudgets(candidate, characterBudget, tokenBudget)) {
            best = candidate;
            low = retained + 1;
        } else {
            high = retained - 1;
        }
    }
    return best;
}

function applyBudget(module, text, characterBudget, tokenBudget, warnings, errors, scope) {
    if (fitsBudgets(text, characterBudget, tokenBudget)) return { content: text, clipped: false, dropped: false };
    if (module.clipPolicy === 'drop') {
        warnings.push(issue(
            'module_dropped',
            `Module ${module.id} was dropped because it exceeded the ${scope} budget.`,
            { moduleId: module.id, scope },
        ));
        return { content: '', clipped: false, dropped: true };
    }
    if (module.clipPolicy === 'error') {
        errors.push(issue(
            'module_budget_exceeded',
            `Module ${module.id} exceeded the ${scope} budget and uses the error policy.`,
            { moduleId: module.id, scope },
        ));
        return { content: '', clipped: false, dropped: true };
    }
    const content = clipText(text, characterBudget, tokenBudget, module.clipPolicy);
    warnings.push(issue(
        'module_clipped',
        `Module ${module.id} was clipped to fit the ${scope} budget.`,
        {
            moduleId: module.id,
            scope,
            originalCharacters: text.length,
            characters: content.length,
            originalTokens: estimatePromptTokens(text),
            tokens: estimatePromptTokens(content),
        },
    ));
    return { content, clipped: true, dropped: content.length === 0 };
}

function normalizeGenerationLayer(value, path, errors) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
        errors.push(issue('invalid_generation_policy', `${path} must be an object.`, { path }));
        return {};
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        if (FORBIDDEN_KEYS.has(key) || value[key] === undefined) continue;
        const fieldPath = `${path}.${key}`;
        const numberRule = GENERATION_NUMBER_RULES[key];
        let validationFailed = false;
        if (numberRule) {
            const candidate = value[key];
            if (typeof candidate !== 'number' || !Number.isFinite(candidate)
                || (numberRule.integer && !Number.isInteger(candidate))
                || candidate < numberRule.minimum || candidate > numberRule.maximum) {
                errors.push(issue(
                    'invalid_generation_value',
                    `${fieldPath} must be ${numberRule.integer ? 'an integer' : 'a number'} between ${numberRule.minimum} and ${numberRule.maximum}.`,
                    {
                        path: fieldPath,
                        field: key,
                        minimum: numberRule.minimum,
                        maximum: numberRule.maximum,
                        integer: numberRule.integer === true,
                    },
                ));
                validationFailed = true;
            }
        } else if (key === 'stop') {
            const candidate = value[key];
            if (!Array.isArray(candidate) || candidate.length > 16
                || candidate.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1_000)) {
                errors.push(issue(
                    'invalid_generation_value',
                    `${fieldPath} must contain at most 16 non-empty strings of at most 1000 characters.`,
                    { path: fieldPath, field: key, maximumItems: 16, maximumLength: 1_000 },
                ));
                validationFailed = true;
            }
        } else if (key === 'assistantPrefill') {
            const candidate = value[key];
            if (typeof candidate !== 'string' || candidate.length > 100_000) {
                errors.push(issue(
                    'invalid_generation_value',
                    `${fieldPath} must be a string no longer than 100000 characters.`,
                    { path: fieldPath, field: key, maximumLength: 100_000 },
                ));
                validationFailed = true;
            }
        }
        const normalized = canonicalize(value[key]);
        if (normalized === null && value[key] !== null && !validationFailed) {
            errors.push(issue('invalid_generation_value', `${fieldPath} is not JSON-safe.`, { path: fieldPath, field: key }));
        } else {
            result[key] = normalized;
        }
    }
    return result;
}

function stableRecord(value) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function uniqueIssues(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = canonicalJson(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function publicModule(module, content, originalText, clipped) {
    return {
        id: module.id,
        name: module.name,
        slot: module.slot,
        role: module.role,
        template: module.template,
        includeData: module.includeData,
        marker: module.marker,
        enabled: module.enabled,
        priority: module.priority,
        tokenBudget: module.tokenBudget,
        clipPolicy: module.clipPolicy,
        requires: [...module.requires],
        conflicts: [...module.conflicts],
        exclusiveGroup: module.exclusiveGroup,
        when: canonicalize(module.when),
        sourceRef: canonicalize(module.sourceRef),
        content,
        originalCharacters: originalText.length,
        characters: content.length,
        originalTokens: estimatePromptTokens(originalText),
        tokens: estimatePromptTokens(content),
        clipped,
    };
}

function semanticProfile(profile, modules, variables) {
    return {
        profileVersion: PROFILE_VERSION,
        id: cleanId(profile.id),
        name: cleanString(profile.name),
        modules: modules.map(module => {
            const result = { ...module };
            delete result._sourceIndex;
            return result;
        }),
        order: canonicalize(profile.order ?? null),
        variables: variables.map(spec => ({
            id: spec.id,
            type: spec.type,
            options: spec.options,
            min: Number.isFinite(spec.min) ? spec.min : null,
            max: Number.isFinite(spec.max) ? spec.max : null,
            maxLength: Number.isFinite(spec.maxLength) ? spec.maxLength : null,
            default: spec.default,
        })),
        variableValues: canonicalize(profile.variableValues ?? {}),
        generation: canonicalize(profile.generation ?? {}),
        generationPolicies: canonicalize(profile.generationPolicies ?? {}),
        taskPolicies: canonicalize(profile.taskPolicies ?? {}),
        tokenBudget: profile.tokenBudget ?? null,
        characterBudget: profile.characterBudget ?? null,
    };
}

/**
 * Compiles a native Prompt Profile V2 into deterministic chat messages.
 * Compatibility import belongs to the caller; this function never parses ST presets or executes code.
 *
 * @param {object} profile Native profileVersion 2 data.
 * @param {object} [options]
 * @param {string} [options.task] Key in profile.taskPolicies.
 * @param {object} [options.taskPolicy] Explicit task policy, used instead of options.task.
 * @param {object} [options.variables] Per-compilation variable overrides.
 * @param {object} [options.context] Read-only values available to templates and conditions.
 * @param {object} [options.slotValues] Literal data keyed by module slot.
 * @param {object} [options.generation] Per-compilation generation overrides.
 * @param {number} [options.tokenBudget] Combined message token budget.
 * @param {number} [options.characterBudget] Combined message character budget.
 * @returns {{profileVersion: 2, task: string|null, variables: object, modules: object[], messages: object[], generation: object, warnings: object[], errors: object[], profileHash: string, diagnostics: object}}
 */
export function compilePromptProfile(profile, options = {}) {
    const errors = [];
    const warnings = [];
    const source = isPlainObject(profile) ? profile : {};
    const compileOptions = isPlainObject(options) ? options : {};
    if (!isPlainObject(profile)) errors.push(issue('invalid_profile', 'Profile must be an object.'));
    if (source.profileVersion !== PROFILE_VERSION) {
        errors.push(issue(
            'unsupported_profile_version',
            `Prompt profileVersion must be ${PROFILE_VERSION}.`,
            { expected: PROFILE_VERSION, actual: source.profileVersion ?? null },
        ));
    }

    const variableSpecs = normalizeVariables(source.variables, errors);
    const specsById = new Map(variableSpecs.map(spec => [spec.id, spec]));
    const variables = Object.fromEntries(variableSpecs.map(spec => [spec.id, canonicalize(spec.default)]));
    const taskPolicies = isPlainObject(source.taskPolicies) ? source.taskPolicies : {};
    let task = cleanId(compileOptions.task) || null;
    let taskPolicy = null;
    if (isPlainObject(compileOptions.taskPolicy)) {
        taskPolicy = compileOptions.taskPolicy;
        task = task || 'custom';
    } else if (task) {
        if (isPlainObject(taskPolicies[task])) taskPolicy = taskPolicies[task];
        else warnings.push(issue('unknown_task_policy', `Task policy ${task} was not found.`, { task }));
    }
    taskPolicy ??= {};
    applyVariableLayer(variables, source.variableValues, specsById, errors, 'variableValues');
    applyVariableLayer(variables, taskPolicy.variables, specsById, errors, `taskPolicies.${task ?? 'custom'}.variables`);
    applyVariableLayer(variables, compileOptions.variables, specsById, errors, 'options.variables');
    const resolvedVariables = stableRecord(variables);

    const generationPolicies = isPlainObject(source.generationPolicies) ? source.generationPolicies : {};
    for (const policyName of Object.keys(generationPolicies).sort()) {
        normalizeGenerationLayer(generationPolicies[policyName], `generationPolicies.${policyName}`, errors);
    }
    for (const taskName of Object.keys(taskPolicies).sort()) {
        const candidate = taskPolicies[taskName];
        if (!isPlainObject(candidate)) continue;
        normalizeGenerationLayer(candidate.generation, `taskPolicies.${taskName}.generation`, errors);
        if (isPlainObject(candidate.generationPolicy)) {
            normalizeGenerationLayer(candidate.generationPolicy, `taskPolicies.${taskName}.generationPolicy`, errors);
        }
    }
    const generationLayers = [normalizeGenerationLayer(source.generation, 'generation', errors)];
    if (typeof taskPolicy.generationPolicy === 'string') {
        const policyName = taskPolicy.generationPolicy.trim();
        if (isPlainObject(generationPolicies[policyName])) {
            generationLayers.push(normalizeGenerationLayer(generationPolicies[policyName], `generationPolicies.${policyName}`, errors));
        } else {
            errors.push(issue('unknown_generation_policy', `Generation policy ${policyName} was not found.`, { policyName, task }));
        }
    } else if (isPlainObject(taskPolicy.generationPolicy)) {
        generationLayers.push(normalizeGenerationLayer(taskPolicy.generationPolicy, `taskPolicies.${task ?? 'custom'}.generationPolicy`, errors));
    } else if (taskPolicy.generationPolicy !== undefined) {
        errors.push(issue('invalid_generation_policy', 'generationPolicy must be a name or object.', { task }));
    }
    generationLayers.push(normalizeGenerationLayer(taskPolicy.generation, `taskPolicies.${task ?? 'custom'}.generation`, errors));
    generationLayers.push(normalizeGenerationLayer(compileOptions.generation, 'options.generation', errors));
    const generation = stableRecord(Object.assign({}, ...generationLayers));

    const normalizedModules = normalizeModules(source.modules, errors);
    const chosenOrder = Array.isArray(taskPolicy.order) ? taskPolicy.order : source.order;
    const ordered = orderModules(normalizedModules, chosenOrder, errors, warnings);
    const states = new Map();
    const context = isPlainObject(compileOptions.context) ? compileOptions.context : {};
    const slotValues = isPlainObject(compileOptions.slotValues) ? compileOptions.slotValues : {};
    for (const module of ordered) {
        if (!module.enabled) {
            states.set(module.id, { included: false, reason: 'disabled' });
            continue;
        }
        if (module.when !== null) {
            const condition = evaluateCondition(module.when, { variables: resolvedVariables, context }, module.id, errors);
            if (!condition.valid) states.set(module.id, { included: false, reason: 'invalid_condition' });
            else if (!condition.result) states.set(module.id, { included: false, reason: 'condition_false' });
            else states.set(module.id, { included: true, reason: null });
        } else {
            states.set(module.id, { included: true, reason: null });
        }
    }
    resolveModuleRules(ordered, states, errors);

    const profileTokenBudget = normalizeTokenBudget(source.tokenBudget, 'tokenBudget', errors, Number.POSITIVE_INFINITY);
    const policyTokenBudget = normalizeTokenBudget(taskPolicy.tokenBudget, `taskPolicies.${task ?? 'custom'}.tokenBudget`, errors, profileTokenBudget);
    const totalTokenBudget = normalizeTokenBudget(compileOptions.tokenBudget, 'options.tokenBudget', errors, policyTokenBudget);
    const profileCharacterBudget = normalizeTokenBudget(source.characterBudget, 'characterBudget', errors, Number.POSITIVE_INFINITY);
    const policyCharacterBudget = normalizeTokenBudget(taskPolicy.characterBudget, `taskPolicies.${task ?? 'custom'}.characterBudget`, errors, profileCharacterBudget);
    const totalCharacterBudget = normalizeTokenBudget(compileOptions.characterBudget, 'options.characterBudget', errors, policyCharacterBudget);

    const prepared = new Map();
    const moduleMetrics = new Map(ordered.map(module => [module.id, {
        originalCharacters: module.template.length,
        compiledCharacters: 0,
        truncated: false,
    }]));
    for (const module of ordered) {
        if (!states.get(module.id).included) continue;
        const originalText = compileModuleText(module, resolvedVariables, context, slotValues, warnings);
        moduleMetrics.get(module.id).originalCharacters = originalText.length;
        if (!originalText) {
            states.set(module.id, { included: false, reason: 'empty' });
            warnings.push(issue('empty_module', `Module ${module.id} compiled to empty text.`, { moduleId: module.id }));
            continue;
        }
        const perModule = applyBudget(
            module,
            originalText,
            Number.POSITIVE_INFINITY,
            module.tokenBudget ?? Number.POSITIVE_INFINITY,
            warnings,
            errors,
            'module',
        );
        if (perModule.dropped) {
            states.set(module.id, { included: false, reason: 'budget_drop' });
            continue;
        }
        moduleMetrics.get(module.id).truncated = perModule.clipped;
        prepared.set(module.id, {
            originalText,
            content: perModule.content,
            clipped: perModule.clipped,
        });
    }

    let remainingCharacters = totalCharacterBudget;
    let remainingTokens = totalTokenBudget;
    const priorityOrder = ordered
        .filter(module => states.get(module.id).included && prepared.has(module.id))
        .sort((left, right) => right.priority - left.priority
            || ordered.indexOf(left) - ordered.indexOf(right)
            || compareIds(left.id, right.id));
    for (const module of priorityOrder) {
        const item = prepared.get(module.id);
        const fitted = applyBudget(module, item.content, remainingCharacters, remainingTokens, warnings, errors, 'profile');
        if (fitted.dropped) {
            states.set(module.id, { included: false, reason: 'budget_drop' });
            prepared.delete(module.id);
            continue;
        }
        item.content = fitted.content;
        item.clipped ||= fitted.clipped;
        moduleMetrics.get(module.id).truncated ||= fitted.clipped;
        remainingCharacters -= fitted.content.length;
        remainingTokens -= estimatePromptTokens(fitted.content);
    }

    const modules = [];
    for (const module of ordered) {
        if (!states.get(module.id).included || !prepared.has(module.id)) continue;
        const item = prepared.get(module.id);
        modules.push(publicModule(module, item.content, item.originalText, item.clipped));
        moduleMetrics.get(module.id).compiledCharacters = item.content.length;
    }
    const messages = modules.map(module => ({ role: module.role, content: module.content }));
    const diagnostics = {
        taskPolicy: task,
        budgets: {
            characterBudget: Number.isFinite(totalCharacterBudget) ? totalCharacterBudget : null,
            tokenBudget: Number.isFinite(totalTokenBudget) ? totalTokenBudget : null,
            usedCharacters: modules.reduce((sum, module) => sum + module.characters, 0),
            usedTokens: modules.reduce((sum, module) => sum + module.tokens, 0),
        },
        modules: ordered.map(module => ({
            id: module.id,
            included: states.get(module.id)?.included === true && prepared.has(module.id),
            originalCharacters: moduleMetrics.get(module.id).originalCharacters,
            compiledCharacters: moduleMetrics.get(module.id).compiledCharacters,
            truncated: moduleMetrics.get(module.id).truncated,
            reason: states.get(module.id)?.reason ?? null,
        })),
    };
    const profileHash = sha256(canonicalJson(semanticProfile(source, normalizedModules, variableSpecs)));

    return {
        profileVersion: PROFILE_VERSION,
        task,
        variables: resolvedVariables,
        modules,
        messages,
        generation,
        warnings: uniqueIssues(warnings),
        errors: uniqueIssues(errors),
        profileHash,
        diagnostics,
    };
}

export { PROFILE_VERSION as PROMPT_PROFILE_VERSION };
