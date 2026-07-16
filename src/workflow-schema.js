import { createHash } from 'node:crypto';

import { ApiError } from './api-error.js';

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;
export const MAX_WORKFLOW_STEPS = 64;
export const MAX_CONDITION_DEPTH = 8;
export const MAX_CONDITION_NODES = 64;

export const WORKFLOW_STEP_KINDS = Object.freeze([
    'diagnose',
    'propose',
    'approve',
    'apply',
    'brainstorm',
    'plan',
    'draft',
    'distill',
    'adopt',
    'review',
    'rewrite',
    'human_gate',
    'closeout',
]);

export const WORKFLOW_STEP_ACTORS = Object.freeze(['system', 'model', 'user']);
export const WORKFLOW_ARTIFACT_KINDS = Object.freeze([
    'diagnosis',
    'chapter-card',
    'brainstorm-direction',
    'chapter-plan',
    'chapter-draft',
    'state-change-set',
    'chapter-review',
    'rewrite-diff',
    'chapter-adoption',
    'review-changes',
    'closeout',
]);

const DEFINITION_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'name', 'description', 'revision', 'steps', 'definitionHash',
]);
const STEP_FIELDS = Object.freeze([
    'id', 'title', 'kind', 'actor', 'dependsOn', 'artifactKind', 'condition',
]);
const DEFINITION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const STEP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXECUTABLE_MARKERS = /<%|%>|\$\{|\{\{|\}\}|javascript\s*:/iu;
const CONDITION_SOURCES = new Set(['input', 'run', 'artifact']);
const CONDITION_LOGICAL_OPS = new Set(['all', 'any']);
const CONDITION_COMPARE_OPS = new Set(['eq', 'neq']);

function fail(message, code = 'invalid_workflow_definition', details = {}) {
    throw new ApiError(400, code, message, details);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        fail(`${label} must be a plain object.`);
    }
    return value;
}

function assertKnownFields(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length > 0) {
        fail(`${label} contains unknown fields.`, 'unknown_workflow_fields', { label, fields: unknown });
    }
}

function cleanText(value, label, maximum, { required = false, executable = false } = {}) {
    if (typeof value !== 'string' || value.length > maximum || (required && value.trim().length === 0)) {
        fail(`${label} must be ${required ? 'a non-empty ' : 'a '}string no longer than ${maximum} characters.`);
    }
    const result = value.trim();
    if (executable && EXECUTABLE_MARKERS.test(result)) {
        fail(`${label} contains a forbidden template or executable marker.`, 'executable_workflow_definition', {
            field: label,
        });
    }
    return result;
}

function cleanDefinitionId(value) {
    if (typeof value !== 'string' || !DEFINITION_ID.test(value)) {
        fail('workflow definition id is invalid.', 'invalid_workflow_id');
    }
    return value;
}

function cleanStepId(value, label = 'workflow step id') {
    if (typeof value !== 'string' || !STEP_ID.test(value)) {
        fail(`${label} is invalid.`, 'invalid_workflow_step');
    }
    return value;
}

function cloneScalar(value, label) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (typeof value === 'string' && value.length <= 512) return value;
    fail(`${label} must be null, a boolean, a finite number, or a string no longer than 512 characters.`,
        'invalid_workflow_condition');
}

function normalizeReference(condition, label) {
    const source = condition.source;
    if (!CONDITION_SOURCES.has(source)) {
        fail(`${label}.source is invalid.`, 'invalid_workflow_condition');
    }
    if (!Array.isArray(condition.path) || condition.path.length < 1 || condition.path.length > 8) {
        fail(`${label}.path must contain from 1 to 8 safe path segments.`, 'invalid_workflow_condition');
    }
    const path = condition.path.map((segment, index) => {
        if (typeof segment !== 'string' || !PATH_SEGMENT.test(segment) || FORBIDDEN_KEYS.has(segment)) {
            fail(`${label}.path[${index}] is invalid.`, 'invalid_workflow_condition');
        }
        return segment;
    });
    return { source, path };
}

function normalizeConditionNode(value, state, depth, label) {
    if (depth > MAX_CONDITION_DEPTH) {
        fail(`Workflow condition depth exceeds ${MAX_CONDITION_DEPTH}.`, 'workflow_condition_too_complex');
    }
    state.nodes += 1;
    if (state.nodes > MAX_CONDITION_NODES) {
        fail(`Workflow condition exceeds ${MAX_CONDITION_NODES} nodes.`, 'workflow_condition_too_complex');
    }
    const condition = assertPlainObject(value, label);
    const op = condition.op;
    if (op === 'always') {
        assertKnownFields(condition, ['op'], label);
        return { op };
    }
    if (CONDITION_LOGICAL_OPS.has(op)) {
        assertKnownFields(condition, ['op', 'conditions'], label);
        if (!Array.isArray(condition.conditions) || condition.conditions.length < 1
            || condition.conditions.length > MAX_CONDITION_NODES) {
            fail(`${label}.conditions must be a non-empty bounded array.`, 'invalid_workflow_condition');
        }
        return {
            op,
            conditions: condition.conditions.map((item, index) => normalizeConditionNode(
                item, state, depth + 1, `${label}.conditions[${index}]`,
            )),
        };
    }
    if (op === 'not') {
        assertKnownFields(condition, ['op', 'condition'], label);
        return { op, condition: normalizeConditionNode(condition.condition, state, depth + 1, `${label}.condition`) };
    }
    if (op === 'exists') {
        assertKnownFields(condition, ['op', 'source', 'path'], label);
        return { op, ...normalizeReference(condition, label) };
    }
    if (CONDITION_COMPARE_OPS.has(op)) {
        assertKnownFields(condition, ['op', 'source', 'path', 'value'], label);
        return {
            op,
            ...normalizeReference(condition, label),
            value: cloneScalar(condition.value, `${label}.value`),
        };
    }
    if (op === 'in') {
        assertKnownFields(condition, ['op', 'source', 'path', 'values'], label);
        if (!Array.isArray(condition.values) || condition.values.length < 1 || condition.values.length > 32) {
            fail(`${label}.values must contain from 1 to 32 scalar values.`, 'invalid_workflow_condition');
        }
        return {
            op,
            ...normalizeReference(condition, label),
            values: condition.values.map((item, index) => cloneScalar(item, `${label}.values[${index}]`)),
        };
    }
    fail(`${label}.op is invalid.`, 'invalid_workflow_condition');
}

export function normalizeWorkflowCondition(value) {
    if (value === undefined || value === null) return { op: 'always' };
    if (typeof value === 'string') {
        fail('Workflow conditions cannot be string expressions.', 'executable_workflow_definition');
    }
    return normalizeConditionNode(value, { nodes: 0 }, 1, 'workflow condition');
}

function resolveConditionValue(condition, context) {
    let value = context?.[condition.source];
    for (const segment of condition.path) {
        if (!value || typeof value !== 'object'
            || !Object.prototype.hasOwnProperty.call(value, segment)) return { exists: false, value: undefined };
        value = value[segment];
    }
    return { exists: true, value };
}

export function evaluateWorkflowCondition(value, context = {}) {
    const condition = normalizeWorkflowCondition(value);
    switch (condition.op) {
        case 'always': return true;
        case 'all': return condition.conditions.every(item => evaluateWorkflowCondition(item, context));
        case 'any': return condition.conditions.some(item => evaluateWorkflowCondition(item, context));
        case 'not': return !evaluateWorkflowCondition(condition.condition, context);
        case 'exists': return resolveConditionValue(condition, context).exists;
        case 'eq': return Object.is(resolveConditionValue(condition, context).value, condition.value);
        case 'neq': return !Object.is(resolveConditionValue(condition, context).value, condition.value);
        case 'in': return condition.values.some(item => Object.is(resolveConditionValue(condition, context).value, item));
        default: return false;
    }
}

function normalizeStep(value, index) {
    const step = assertPlainObject(value, `workflow.steps[${index}]`);
    assertKnownFields(step, STEP_FIELDS, `workflow.steps[${index}]`);
    const id = cleanStepId(step.id, `workflow.steps[${index}].id`);
    if (!WORKFLOW_STEP_KINDS.includes(step.kind)) {
        fail(`workflow.steps[${index}].kind is invalid.`, 'invalid_workflow_step');
    }
    if (!WORKFLOW_STEP_ACTORS.includes(step.actor)) {
        fail(`workflow.steps[${index}].actor is invalid.`, 'invalid_workflow_step');
    }
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > MAX_WORKFLOW_STEPS) {
        fail(`workflow.steps[${index}].dependsOn must be an array.`, 'invalid_workflow_step');
    }
    const dependsOn = step.dependsOn.map((dependency, dependencyIndex) => cleanStepId(
        dependency, `workflow.steps[${index}].dependsOn[${dependencyIndex}]`,
    ));
    if (new Set(dependsOn).size !== dependsOn.length) {
        fail(`workflow.steps[${index}].dependsOn contains duplicates.`, 'invalid_workflow_dag');
    }
    const artifactKind = step.artifactKind === undefined || step.artifactKind === null
        ? null
        : step.artifactKind;
    if (artifactKind !== null && !WORKFLOW_ARTIFACT_KINDS.includes(artifactKind)) {
        fail(`workflow.steps[${index}].artifactKind is invalid.`, 'invalid_workflow_step');
    }
    if (step.actor === 'model' && artifactKind === null) {
        fail(`Model step ${id} must produce a typed candidate artifact.`, 'unsafe_model_workflow_step');
    }
    if (step.kind === 'human_gate' && (step.actor !== 'user' || artifactKind === null)) {
        fail(`Human gate ${id} must be executed by a user against a typed artifact.`, 'unsafe_workflow_step');
    }
    if (step.actor === 'model' && ['apply', 'adopt', 'closeout'].includes(step.kind)) {
        fail(`Model step ${id} cannot apply authoritative state.`, 'unsafe_model_workflow_step');
    }
    if (['apply', 'adopt'].includes(step.kind) && step.actor !== 'system') {
        fail(`Authoritative step ${id} must be executed by the system.`, 'unsafe_workflow_step');
    }
    return {
        id,
        title: cleanText(step.title, `workflow.steps[${index}].title`, 128, { required: true, executable: true }),
        kind: step.kind,
        actor: step.actor,
        dependsOn,
        artifactKind,
        condition: normalizeWorkflowCondition(step.condition),
    };
}

function validateDag(steps) {
    const byId = new Map(steps.map(step => [step.id, step]));
    if (byId.size !== steps.length) {
        fail('Workflow step ids must be unique.', 'invalid_workflow_dag');
    }
    for (const step of steps) {
        for (const dependency of step.dependsOn) {
            if (!byId.has(dependency) || dependency === step.id) {
                fail(`Workflow step ${step.id} has an invalid dependency.`, 'invalid_workflow_dag', {
                    stepId: step.id,
                    dependency,
                });
            }
        }
    }
    const indegree = new Map(steps.map(step => [step.id, step.dependsOn.length]));
    const dependents = new Map(steps.map(step => [step.id, []]));
    for (const step of steps) {
        for (const dependency of step.dependsOn) dependents.get(dependency).push(step.id);
    }
    const queue = steps.filter(step => indegree.get(step.id) === 0).map(step => step.id);
    let visited = 0;
    while (queue.length > 0) {
        const id = queue.shift();
        visited += 1;
        for (const dependent of dependents.get(id)) {
            indegree.set(dependent, indegree.get(dependent) - 1);
            if (indegree.get(dependent) === 0) queue.push(dependent);
        }
    }
    if (visited !== steps.length) {
        fail('Workflow dependencies contain a cycle.', 'invalid_workflow_dag');
    }
}

function stableNormalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableNormalize);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key])]));
}

function definitionPayload(definition) {
    const { definitionHash: ignored, ...payload } = definition;
    return payload;
}

export function hashWorkflowDefinition(value) {
    const payload = definitionPayload(value);
    return createHash('sha256').update(JSON.stringify(stableNormalize(payload)), 'utf8').digest('hex');
}

export function normalizeWorkflowDefinition(value, { requireHash = false } = {}) {
    const definition = assertPlainObject(value, 'workflow definition');
    assertKnownFields(definition, DEFINITION_FIELDS, 'workflow definition');
    if (definition.schemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION) {
        fail('Workflow definition schemaVersion is unsupported.', 'unsupported_workflow_schema');
    }
    if (!Number.isInteger(definition.revision) || definition.revision < 1 || definition.revision > 1_000_000) {
        fail('workflow definition revision must be a positive integer.', 'invalid_workflow_definition');
    }
    if (!Array.isArray(definition.steps) || definition.steps.length < 1
        || definition.steps.length > MAX_WORKFLOW_STEPS) {
        fail(`Workflow definitions must contain from 1 to ${MAX_WORKFLOW_STEPS} steps.`, 'invalid_workflow_definition');
    }
    const normalized = {
        schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
        id: cleanDefinitionId(definition.id),
        name: cleanText(definition.name, 'workflow definition name', 128, { required: true, executable: true }),
        description: cleanText(definition.description ?? '', 'workflow definition description', 2_048, { executable: true }),
        revision: definition.revision,
        steps: definition.steps.map(normalizeStep),
    };
    validateDag(normalized.steps);
    const computedHash = hashWorkflowDefinition(normalized);
    if (requireHash) {
        if (typeof definition.definitionHash !== 'string' || !HASH.test(definition.definitionHash)
            || definition.definitionHash !== computedHash) {
            throw new ApiError(500, 'workflow_definition_tampered', 'Stored workflow definition failed its integrity check.', {
                definitionId: normalized.id,
            });
        }
    } else if (definition.definitionHash !== undefined && definition.definitionHash !== computedHash) {
        fail('workflow definitionHash does not match its content.', 'invalid_workflow_hash');
    }
    return { ...normalized, definitionHash: computedHash };
}

const BUILTIN_CHAPTER_CYCLE_SOURCE = {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'builtin.chapter-cycle.v1',
    name: '章节创作闭环',
    description: '从诊断、章卡、正文、状态采纳到审查收尾的声明式章节工作流。',
    revision: 1,
    steps: [
        { id: 'diagnose', title: '策划诊断', kind: 'diagnose', actor: 'system', dependsOn: [], artifactKind: 'diagnosis' },
        { id: 'propose-card', title: '生成章卡候选', kind: 'propose', actor: 'system', dependsOn: ['diagnose'], artifactKind: 'chapter-card' },
        { id: 'approve-card', title: '审批章卡', kind: 'approve', actor: 'user', dependsOn: ['propose-card'], artifactKind: 'chapter-card' },
        { id: 'apply-card', title: '应用章卡', kind: 'apply', actor: 'system', dependsOn: ['approve-card'], artifactKind: 'chapter-card' },
        { id: 'draft', title: '生成正文候选', kind: 'draft', actor: 'model', dependsOn: ['apply-card'], artifactKind: 'chapter-draft' },
        { id: 'distill', title: '提取连续性变更候选', kind: 'distill', actor: 'model', dependsOn: ['draft'], artifactKind: 'state-change-set' },
        { id: 'approve-state', title: '审批连续性变更', kind: 'approve', actor: 'user', dependsOn: ['distill'], artifactKind: 'state-change-set' },
        { id: 'adopt', title: '原子采纳正文与状态', kind: 'adopt', actor: 'system', dependsOn: ['approve-state'], artifactKind: 'state-change-set' },
        { id: 'review', title: '生成质量审查候选', kind: 'review', actor: 'model', dependsOn: ['adopt'], artifactKind: 'chapter-review' },
        { id: 'apply-review', title: '应用审查结果', kind: 'apply', actor: 'system', dependsOn: ['review'], artifactKind: 'chapter-review' },
        { id: 'closeout', title: '完成章节闭环', kind: 'closeout', actor: 'system', dependsOn: ['apply-review'], artifactKind: 'closeout' },
    ],
};

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

export const BUILTIN_CHAPTER_CYCLE_DEFINITION = deepFreeze(normalizeWorkflowDefinition(
    BUILTIN_CHAPTER_CYCLE_SOURCE,
));

const REWRITE_REQUIRED_CONDITION = Object.freeze({
    op: 'eq', source: 'artifact', path: Object.freeze(['rewriteRequired']), value: true,
});

const BUILTIN_CHAPTER_CYCLE_V2_SOURCE = {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'builtin.chapter-cycle.v2',
    name: '网文章节生产闭环 V2',
    description: '互斥构思、事件链规划、正文、证据审查、定向修复、连续性蒸馏与人工采纳。',
    revision: 1,
    steps: [
        { id: 'brainstorm', title: '生成互斥方向', kind: 'brainstorm', actor: 'model', dependsOn: [], artifactKind: 'brainstorm-direction' },
        { id: 'select-direction', title: '选择创作方向', kind: 'human_gate', actor: 'user', dependsOn: ['brainstorm'], artifactKind: 'brainstorm-direction' },
        { id: 'plan', title: '生成事件链与章执行卡', kind: 'plan', actor: 'model', dependsOn: ['select-direction'], artifactKind: 'chapter-plan' },
        { id: 'approve-plan', title: '确认事件链与章执行卡', kind: 'human_gate', actor: 'user', dependsOn: ['plan'], artifactKind: 'chapter-plan' },
        { id: 'draft', title: '生成正文候选', kind: 'draft', actor: 'model', dependsOn: ['approve-plan'], artifactKind: 'chapter-draft' },
        { id: 'review', title: '证据定位审查', kind: 'review', actor: 'model', dependsOn: ['draft'], artifactKind: 'chapter-review' },
        { id: 'approve-review', title: '确认审查与修复范围', kind: 'human_gate', actor: 'user', dependsOn: ['review'], artifactKind: 'chapter-review' },
        { id: 'rewrite', title: '定向修复并生成 Diff', kind: 'rewrite', actor: 'model', dependsOn: ['approve-review'], artifactKind: 'rewrite-diff', condition: REWRITE_REQUIRED_CONDITION },
        { id: 'approve-rewrite', title: '确认定向修复', kind: 'human_gate', actor: 'user', dependsOn: ['rewrite'], artifactKind: 'rewrite-diff', condition: REWRITE_REQUIRED_CONDITION },
        { id: 'distill', title: '蒸馏连续性与采纳包', kind: 'distill', actor: 'model', dependsOn: ['approve-rewrite'], artifactKind: 'chapter-adoption' },
        { id: 'approve-adoption', title: '确认最终采纳包', kind: 'human_gate', actor: 'user', dependsOn: ['distill'], artifactKind: 'chapter-adoption' },
        { id: 'adopt', title: '原子采纳章节', kind: 'adopt', actor: 'system', dependsOn: ['approve-adoption'], artifactKind: 'chapter-adoption' },
    ],
};

export const BUILTIN_CHAPTER_CYCLE_V2_DEFINITION = deepFreeze(normalizeWorkflowDefinition(
    BUILTIN_CHAPTER_CYCLE_V2_SOURCE,
));

export const BUILTIN_WORKFLOW_DEFINITIONS = Object.freeze([
    BUILTIN_CHAPTER_CYCLE_DEFINITION,
    BUILTIN_CHAPTER_CYCLE_V2_DEFINITION,
]);
