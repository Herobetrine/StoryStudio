import { compilePromptProfile } from './prompt-profile-compiler.js';
import { assembleNovelPrompt } from './prompt-engine.js';

export const PROFILE_EDITOR_TABS = Object.freeze([
    { id: 'overview', label: '概览' },
    { id: 'modules', label: '模块' },
    { id: 'variables', label: '变量' },
    { id: 'tasks', label: '任务参数' },
    { id: 'compatibility', label: '兼容性' },
    { id: 'preview', label: '编译预览' },
]);

const EDITABLE_FIELDS = [
    'name',
    'generation',
    'profileVersion',
    'modules',
    'order',
    'variables',
    'variableValues',
    'generationPolicies',
    'taskPolicies',
    'tokenBudget',
    'characterBudget',
];

export class PromptProfileEditorError extends Error {
    constructor(message, field, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = 'PromptProfileEditorError';
        this.field = field;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function pretty(value) {
    return JSON.stringify(value, null, 2);
}

function parseJsonField(value, field, label, expected) {
    let parsed;
    try {
        parsed = JSON.parse(String(value ?? ''));
    } catch (error) {
        throw new PromptProfileEditorError(`${label}不是有效的 JSON`, field, error);
    }
    const valid = expected === 'array' ? Array.isArray(parsed) : isPlainObject(parsed);
    if (!valid) {
        throw new PromptProfileEditorError(`${label}必须是 JSON ${expected === 'array' ? '数组' : '对象'}`, field);
    }
    return parsed;
}

function parseOptionalBudget(value, field, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 2_000_000) {
        throw new PromptProfileEditorError(`${label}必须是 0 到 2000000 的整数`, field);
    }
    return numeric;
}

function clone(value) {
    return structuredClone(value);
}

function uniqueStrings(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function uniqueWarnings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!value) continue;
        const normalized = typeof value === 'string' ? { code: value, message: value } : clone(value);
        const key = JSON.stringify(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
    }
    return result;
}

export function isPromptProfileV2(resource) {
    return resource?.type === 'prompt-profile'
        && resource.profileVersion === 2
        && Array.isArray(resource.modules)
        && Array.isArray(resource.order)
        && Array.isArray(resource.variables)
        && isPlainObject(resource.taskPolicies);
}

export function createProfileEditorDraft(resource) {
    if (!isPromptProfileV2(resource)) {
        throw new PromptProfileEditorError('Legacy Prompt Profile 不能直接用 V2 编辑器保存', 'profileVersion');
    }
    return {
        resourceId: String(resource.id ?? ''),
        revision: Number(resource.revision ?? 0),
        name: String(resource.name ?? ''),
        generationText: pretty(resource.generation ?? {}),
        modulesText: pretty(resource.modules),
        orderText: pretty(resource.order),
        variablesText: pretty(resource.variables),
        variableValuesText: pretty(resource.variableValues ?? {}),
        generationPoliciesText: pretty(resource.generationPolicies ?? {}),
        taskPoliciesText: pretty(resource.taskPolicies),
        tokenBudget: resource.tokenBudget === undefined || resource.tokenBudget === null
            ? ''
            : String(resource.tokenBudget),
        characterBudget: resource.characterBudget === undefined || resource.characterBudget === null
            ? ''
            : String(resource.characterBudget),
    };
}

export function buildProfileChanges(draft) {
    if (!isPlainObject(draft)) throw new PromptProfileEditorError('编辑草稿无效', 'profile');
    const name = String(draft.name ?? '').trim();
    if (!name) throw new PromptProfileEditorError('名称不能为空', 'name');
    const changes = {
        name,
        generation: parseJsonField(draft.generationText, 'generation', '生成参数', 'object'),
        profileVersion: 2,
        modules: parseJsonField(draft.modulesText, 'modules', '模块', 'array'),
        order: parseJsonField(draft.orderText, 'order', '模块顺序', 'array'),
        variables: parseJsonField(draft.variablesText, 'variables', '变量', 'array'),
        variableValues: parseJsonField(draft.variableValuesText, 'variableValues', '变量选择', 'object'),
        generationPolicies: parseJsonField(draft.generationPoliciesText, 'generationPolicies', '生成策略', 'object'),
        taskPolicies: parseJsonField(draft.taskPoliciesText, 'taskPolicies', '任务策略', 'object'),
        tokenBudget: parseOptionalBudget(draft.tokenBudget, 'tokenBudget', 'Token 预算'),
        characterBudget: parseOptionalBudget(draft.characterBudget, 'characterBudget', '字符预算'),
    };
    return Object.fromEntries(EDITABLE_FIELDS.map(field => [field, changes[field]]));
}

export function profileDraftFingerprint(draft) {
    return JSON.stringify(buildProfileChanges(draft));
}

export function profileTaskNames(draft) {
    try {
        return Object.keys(parseJsonField(draft?.taskPoliciesText, 'taskPolicies', '任务策略', 'object')).sort();
    } catch {
        return [];
    }
}

export function compileProfilePreview(draft, options = {}) {
    const changes = buildProfileChanges(draft);
    const variables = options.variablesText === undefined || String(options.variablesText).trim() === ''
        ? {}
        : parseJsonField(options.variablesText, 'previewVariables', '预览变量', 'object');
    return compilePromptProfile(changes, {
        task: String(options.task ?? '').trim() || undefined,
        variables,
        context: isPlainObject(options.context) ? options.context : {},
        slotValues: isPlainObject(options.slotValues) ? options.slotValues : {},
        generation: isPlainObject(options.generation) ? options.generation : undefined,
        tokenBudget: options.tokenBudget === '' || options.tokenBudget === undefined
            ? undefined
            : Number(options.tokenBudget),
        characterBudget: options.characterBudget === '' || options.characterBudget === undefined
            ? undefined
            : Number(options.characterBudget),
    });
}

export function assembleProfilePreview(draft, options = {}) {
    const profile = buildProfileChanges(draft);
    if (options.tokenBudget !== undefined && options.tokenBudget !== '') {
        profile.tokenBudget = parseOptionalBudget(options.tokenBudget, 'previewTokenBudget', '预览 Token 预算');
    }
    if (options.characterBudget !== undefined && options.characterBudget !== '') {
        profile.characterBudget = parseOptionalBudget(options.characterBudget, 'previewCharacterBudget', '预览字符预算');
    }
    const variables = options.variablesText === undefined || String(options.variablesText).trim() === ''
        ? {}
        : parseJsonField(options.variablesText, 'previewVariables', '预览变量', 'object');
    const selectedTask = String(options.task ?? '').trim();
    const sourceResources = isPlainObject(options.resources) ? options.resources : {};
    const assembled = assembleNovelPrompt({
        baseSystemPrompt: String(options.baseSystemPrompt ?? ''),
        project: isPlainObject(options.project) ? options.project : {},
        chapter: isPlainObject(options.chapter) ? options.chapter : {},
        previousChapter: isPlainObject(options.previousChapter) ? options.previousChapter : null,
        resources: {
            ...sourceResources,
            promptProfile: profile,
            task: String(options.taskText ?? sourceResources.task ?? ''),
            taskKind: String(options.taskKind ?? sourceResources.taskKind ?? 'draft'),
            promptTask: selectedTask,
            promptVariables: variables,
            promptSlotValues: isPlainObject(options.slotValues) ? options.slotValues : {},
        },
        provider: isPlainObject(options.provider) ? options.provider : {},
        promptLimit: Number(options.promptLimit) || 64_000,
    });
    const profileDiagnostics = isPlainObject(assembled.diagnostics?.profile)
        ? assembled.diagnostics.profile
        : {};
    const diagnosticModules = Array.isArray(profileDiagnostics.modules) ? profileDiagnostics.modules : [];
    const blocks = isPlainObject(assembled.diagnostics?.blocks) ? assembled.diagnostics.blocks : {};
    const modules = diagnosticModules.filter(module => module?.included !== false).map(module => ({
        id: String(module?.id ?? 'unknown'),
        role: blocks[module?.id]?.role ?? null,
        slot: blocks[module?.id]?.slot ?? null,
        characters: Number(module?.compiledCharacters ?? 0),
        originalCharacters: Number(module?.originalCharacters ?? 0),
        tokens: Number(blocks[module?.id]?.tokens ?? 0),
        clipped: module?.truncated === true,
    }));
    return {
        profileVersion: 2,
        task: profileDiagnostics.taskPolicy ?? null,
        variables: clone(profileDiagnostics.variables ?? {}),
        modules,
        messages: Array.isArray(assembled.messages) ? clone(assembled.messages) : [],
        generation: clone(assembled.generation ?? {}),
        warnings: clone(profileDiagnostics.warnings ?? []),
        errors: clone(profileDiagnostics.errors ?? []),
        profileHash: profileDiagnostics.profileHash ?? assembled.profileHash ?? '',
        diagnostics: {
            modules: clone(diagnosticModules),
            budgets: clone(profileDiagnostics.budgets ?? null),
        },
        systemPrompt: assembled.systemPrompt,
        prompt: assembled.prompt,
        serializedPrompt: assembled.serializedPrompt,
        transport: assembled.transport,
    };
}

export function buildResourceCompatibilityReport(resource) {
    const compatibility = isPlainObject(resource?.compatibility) ? resource.compatibility : {};
    const source = isPlainObject(resource?.source) ? resource.source : {};
    const warnings = [
        ...(Array.isArray(compatibility.warnings) ? compatibility.warnings : []),
        ...(Array.isArray(source.compatibilityWarnings) ? source.compatibilityWarnings : []),
        ...(Array.isArray(source.warnings) ? source.warnings : []),
    ];
    return {
        sourceFormat: String(
            compatibility.sourceFormat
            ?? source.detectedFormat
            ?? source.format
            ?? source.type
            ?? 'native',
        ),
        promptOrderMode: compatibility.promptOrderMode ?? null,
        selectedCharacterId: compatibility.selectedCharacterId ?? null,
        warnings: uniqueWarnings(warnings.map(value => typeof value === 'string' ? value : clone(value))),
        unsupportedFeatures: uniqueStrings([
            ...(Array.isArray(compatibility.unsupportedFeatures) ? compatibility.unsupportedFeatures : []),
        ]),
        removedSensitiveFields: uniqueStrings([
            ...(Array.isArray(source.removedSensitiveFields) ? source.removedSensitiveFields : []),
        ]),
    };
}

export function buildCompatibilityReport(resource) {
    const mode = isPromptProfileV2(resource) ? 'v2' : 'legacy';
    const report = buildResourceCompatibilityReport(resource);
    const warnings = [...report.warnings];
    if (mode === 'legacy') {
        warnings.unshift({
            code: 'legacy_profile',
            message: '该资源继续使用 Legacy 编译路径，未自动转换为 Profile V2。',
        });
    }
    return {
        ...report,
        mode,
        warnings: uniqueWarnings(warnings),
    };
}

function normalizeDiagnosticModule(module) {
    return {
        id: String(module?.id ?? 'unknown'),
        included: module?.included !== false,
        originalCharacters: Number(module?.originalCharacters ?? module?.characters ?? 0),
        compiledCharacters: Number(module?.compiledCharacters ?? module?.characters ?? 0),
        tokens: Number(module?.tokens ?? 0),
        truncated: module?.truncated === true || module?.clipped === true,
        reason: module?.reason ?? null,
        role: module?.role ?? null,
        slot: module?.slot ?? null,
    };
}

export function projectPromptProfileDiagnostics(diagnostics) {
    const root = isPlainObject(diagnostics) ? diagnostics : {};
    const source = [root.profile, root.promptProfile, root.profileCompiler, root.compiledProfile]
        .find(isPlainObject) ?? {};
    const nestedDiagnostics = isPlainObject(source.diagnostics) ? source.diagnostics : {};
    const moduleSource = Array.isArray(nestedDiagnostics.modules)
        ? nestedDiagnostics.modules
        : Array.isArray(source.modules) ? source.modules : [];
    const messages = Array.isArray(source.messages)
        ? source.messages
        : Array.isArray(root.messages) ? root.messages : [];
    return {
        activeProfileId: root.activePromptProfileId ?? source.activeProfileId ?? null,
        profileHash: source.profileHash ?? root.profileHash ?? null,
        task: source.task ?? source.taskPolicy ?? nestedDiagnostics.taskPolicy ?? null,
        modules: moduleSource.map(normalizeDiagnosticModule),
        messages: messages.map(message => ({
            role: String(message?.role ?? 'user'),
            content: String(message?.content ?? ''),
        })),
        generation: isPlainObject(source.generation) ? clone(source.generation) : {},
        warnings: Array.isArray(source.warnings) ? clone(source.warnings) : [],
        errors: Array.isArray(source.errors) ? clone(source.errors) : [],
        budgets: isPlainObject(source.budgets)
            ? clone(source.budgets)
            : isPlainObject(nestedDiagnostics.budgets) ? clone(nestedDiagnostics.budgets) : null,
    };
}
