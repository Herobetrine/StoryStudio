import crypto from 'node:crypto';

import { ApiError } from './api-error.js';
import { chapterVersionInput } from './chapter-version-store.js';
import { MAX_CONTENT_CHARACTERS } from './generation-store.js';
import { compileStoryContext } from '../public/context-compiler.js';
import {
    createChatCompletion,
    createStreamingCompletion,
    getProviderAdapterDiagnostics,
    normalizeGenerationRequest,
} from './openai-provider.js';
import {
    buildContextualGenerationRequest,
    estimateTokenCount,
    fitGenerationBudget,
    nextPromptCharacterLimit,
    parseStructuredResponse,
    promptCharacterLimitForContext,
} from '../public/core.js';

const WRITING_KINDS = new Set([
    'plan', 'draft', 'review', 'continuity', 'polish', 'rewrite', 'expand', 'brainstorm',
]);
const GENERATION_MODES = new Set(['generate', 'regenerate', 'continue']);
const MAX_PROMPT_FIT_ATTEMPTS = 8;
export const MAX_RETRIEVAL_QUERY_CHARACTERS = 20_000;
const MAX_RETRIEVAL_REFERENCES = 200;
const WORKFLOW_GENERATION_SCHEMA_VERSION = 1;
const WORKFLOW_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REUSABLE_WORKFLOW_GENERATION_STATUSES = new Set(['completed', 'partial', 'adopted']);
const REUSABLE_WORKFLOW_V2_GENERATION_STATUSES = new Set(['completed', 'adopted']);
const WORKFLOW_V2_MODEL_SCHEMA_VERSION = 1;
const WORKFLOW_V2_MODEL_OPERATIONS = new Set([
    'brainstorm', 'plan', 'draft', 'review', 'rewrite', 'adoption',
]);
const WORKFLOW_V2_GENERATION_KINDS = new Set([
    'brainstorm', 'plan', 'draft', 'review', 'rewrite', 'distill',
]);
const MAX_WORKFLOW_V2_PROMPT_CHARACTERS = 2_000_000;

// The base budgets preserve every query signal when all fields are large. Any
// unused budget is then shared deterministically by the fields that still have
// content, so a lone instruction or selection can use the full query limit.
const RETRIEVAL_QUERY_FIELDS = Object.freeze([
    Object.freeze({ name: 'chapterTitle', budget: 1_000 }),
    Object.freeze({ name: 'chapterSummary', budget: 3_000 }),
    Object.freeze({ name: 'chapterGoal', budget: 3_000 }),
    Object.freeze({ name: 'chapterConflict', budget: 3_000 }),
    Object.freeze({ name: 'instruction', budget: 5_000 }),
    Object.freeze({ name: 'selection', budget: 4_995 }),
]);

function safePrefix(value, maximum) {
    if (value.length <= maximum) return value;
    let end = maximum;
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    return value.slice(0, end);
}

export function buildRetrievalQuery(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const parts = RETRIEVAL_QUERY_FIELDS
        .map(field => ({
            ...field,
            value: typeof source[field.name] === 'string' ? source[field.name].trim() : '',
            allocated: 0,
        }))
        .filter(field => field.value.length > 0);
    if (parts.length === 0) return '';

    const contentBudget = MAX_RETRIEVAL_QUERY_CHARACTERS - (parts.length - 1);
    for (const part of parts) part.allocated = Math.min(part.value.length, part.budget);
    let available = contentBudget - parts.reduce((total, part) => total + part.allocated, 0);

    // Water-fill the spare budget. Field order only resolves single-character
    // rounding, making the result reproducible across generation and preview.
    while (available > 0) {
        const pending = parts.filter(part => part.allocated < part.value.length);
        if (pending.length === 0) break;
        const share = Math.ceil(available / pending.length);
        for (const part of pending) {
            const granted = Math.min(share, available, part.value.length - part.allocated);
            part.allocated += granted;
            available -= granted;
            if (available === 0) break;
        }
    }

    return parts.map(part => safePrefix(part.value, part.allocated)).join('\n');
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, 'invalid_request', `${label} must be a JSON object.`);
    }
    return value;
}

function assertKnownFields(value, allowed, label) {
    const unknown = Object.keys(value).filter(field => !allowed.includes(field));
    if (unknown.length > 0) {
        throw new ApiError(400, 'unknown_fields', `${label} contains unknown fields.`, { fields: unknown });
    }
}

function cleanInstruction(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 50_000) {
        throw new ApiError(400, 'invalid_request', 'instruction must be a string no longer than 50000 characters.');
    }
    return value;
}

function cleanPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1) {
        throw new ApiError(400, 'invalid_request', `${label} must be a positive integer.`);
    }
    return value;
}

function normalizeContextOverrides(value = {}) {
    assertPlainObject(value, 'contextOverrides');
    assertKnownFields(value, [
        'includeEntityIds', 'excludeEntityIds', 'includePromiseIds', 'excludePromiseIds',
    ], 'contextOverrides');
    const result = {};
    for (const field of ['includeEntityIds', 'excludeEntityIds', 'includePromiseIds', 'excludePromiseIds']) {
        const items = value[field] ?? [];
        if (!Array.isArray(items) || items.length > 500
            || items.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item))) {
            throw new ApiError(400, 'invalid_context_overrides', `${field} must contain at most 500 valid ids.`);
        }
        result[field] = [...new Set(items)];
    }
    return result;
}

function normalizeRetrievalOptions(value = {}) {
    if (value === undefined || value === null) return {};
    assertPlainObject(value, 'retrieval');
    assertKnownFields(value, ['query', 'include', 'exclude', 'filters', 'limit'], 'retrieval');
    if (value.query !== undefined
        && (typeof value.query !== 'string' || value.query.length > MAX_RETRIEVAL_QUERY_CHARACTERS)) {
        throw new ApiError(400, 'invalid_retrieval_query', 'retrieval.query must be a string no longer than 20000 characters.');
    }
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) {
        throw new ApiError(400, 'invalid_retrieval_limit', 'retrieval.limit must be an integer from 1 to 100.');
    }
    for (const field of ['include', 'exclude']) {
        if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > MAX_RETRIEVAL_REFERENCES)) {
            throw new ApiError(400, 'invalid_retrieval_override', `retrieval.${field} must contain at most ${MAX_RETRIEVAL_REFERENCES} references.`);
        }
    }
    if (value.filters !== undefined && (!value.filters || typeof value.filters !== 'object' || Array.isArray(value.filters))) {
        throw new ApiError(400, 'invalid_retrieval_filters', 'retrieval.filters must be an object.');
    }
    return {
        ...(value.query !== undefined ? { query: value.query } : {}),
        ...(value.include !== undefined ? { manualInclude: value.include } : {}),
        ...(value.exclude !== undefined ? { manualExclude: value.exclude } : {}),
        ...(value.filters !== undefined ? { filters: value.filters } : {}),
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
    };
}

function retrievalContextText(retrieval) {
    const hits = Array.isArray(retrieval?.hits) ? retrieval.hits : [];
    if (hits.length === 0) return '';
    return [
        '# 可追溯检索命中（仅作参考，必须遵守连续性预检）',
        ...hits.map((hit, index) => {
            const source = [hit.sourceType, hit.sourceId, hit.chapterId ? `章:${hit.chapterId}` : '']
                .filter(Boolean).join(' / ');
            return `[${index + 1}] ${source} · ${hit.reason || 'bm25'}\n${hit.text}`;
        }),
    ].join('\n');
}

function normalizeSelection(value) {
    if (value === undefined || value === null) return null;
    assertPlainObject(value, 'selection');
    assertKnownFields(value, ['text', 'before', 'after', 'start', 'end'], 'selection');
    const clean = (field, maximum) => {
        const item = value[field] ?? '';
        if (typeof item !== 'string' || item.length > maximum) {
            throw new ApiError(400, 'invalid_selection', `selection.${field} is invalid.`);
        }
        return item;
    };
    const text = clean('text', 500_000);
    const before = clean('before', 100_000);
    const after = clean('after', 100_000);
    const start = value.start;
    const end = value.end;
    if ((start !== undefined && (!Number.isInteger(start) || start < 0))
        || (end !== undefined && (!Number.isInteger(end) || end < 0 || (start !== undefined && end < start)))) {
        throw new ApiError(400, 'invalid_selection', 'selection offsets are invalid.');
    }
    return { text, before, after, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableNormalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableNormalize);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key])]));
}

function stableDigest(value) {
    return sha256(JSON.stringify(stableNormalize(value)));
}

function invalidWorkflowIntent(message) {
    throw new ApiError(500, 'invalid_workflow_generation_intent', message);
}

function normalizeWorkflowGenerationIntent(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidWorkflowIntent('Trusted workflow generation intent must be an object.');
    }
    const slot = value.slot;
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
        invalidWorkflowIntent('Trusted workflow generation slot must be an object.');
    }
    const expectedSlot = {
        projectId: expected.projectId,
        chapterId: expected.chapterId,
        runId: slot.runId,
        stepId: slot.stepId,
        runRevision: slot.runRevision,
        ...(expected.generationId !== undefined ? { generationId: expected.generationId } : {}),
        kind: expected.kind,
    };
    const identifiers = [slot.projectId, slot.chapterId, slot.runId, slot.stepId, slot.kind, value.commandId];
    if (expected.generationId !== undefined) identifiers.push(slot.generationId);
    if (!identifiers
        .every(item => typeof item === 'string' && WORKFLOW_ID.test(item))
        || !Number.isSafeInteger(slot.runRevision) || slot.runRevision < 1
        || slot.projectId !== expected.projectId
        || slot.chapterId !== expected.chapterId
        || slot.kind !== expected.kind
        || stableDigest(slot) !== stableDigest(expectedSlot)
        || !SHA256.test(value.slotDigest ?? '')
        || value.slotDigest !== stableDigest(expectedSlot)
        || !SHA256.test(value.commandDigest ?? '')) {
        invalidWorkflowIntent('Trusted workflow generation intent does not match the requested generation.');
    }
    return {
        schemaVersion: WORKFLOW_GENERATION_SCHEMA_VERSION,
        slot: expectedSlot,
        slotDigest: value.slotDigest,
        commandDigest: value.commandDigest,
        commandId: value.commandId,
    };
}

function workflowGenerationConflict(message = 'Workflow generation slot is already bound to another command.') {
    throw new ApiError(409, 'workflow_generation_conflict', message);
}

function normalizeWorkflowV2ModelRequest(value, expected) {
    const body = assertPlainObject(value, 'Workflow V2 model request');
    assertKnownFields(body, [
        'kind', 'operation', 'projectVersion', 'chapterRevision', 'prompt',
    ], 'Workflow V2 model request');
    if (!WORKFLOW_V2_GENERATION_KINDS.has(body.kind)
        || !WORKFLOW_V2_MODEL_OPERATIONS.has(body.operation)
        || (body.operation === 'adoption' ? body.kind !== 'distill' : body.kind !== body.operation)) {
        throw new ApiError(500, 'invalid_workflow_v2_model_request',
            'Trusted Workflow V2 model operation and generation kind do not match.');
    }
    const prompt = assertPlainObject(body.prompt, 'Workflow V2 prompt');
    assertKnownFields(prompt, [
        'operation', 'systemPrompt', 'userPrompt', 'materialsDigest',
    ], 'Workflow V2 prompt');
    if (prompt.operation !== body.operation
        || typeof prompt.systemPrompt !== 'string' || !prompt.systemPrompt.trim()
        || prompt.systemPrompt.length > MAX_WORKFLOW_V2_PROMPT_CHARACTERS
        || typeof prompt.userPrompt !== 'string' || !prompt.userPrompt.trim()
        || prompt.userPrompt.length > MAX_WORKFLOW_V2_PROMPT_CHARACTERS
        || typeof prompt.materialsDigest !== 'string' || !SHA256.test(prompt.materialsDigest)) {
        throw new ApiError(500, 'invalid_workflow_v2_model_request',
            'Trusted Workflow V2 prompt is invalid.');
    }
    const projectVersion = cleanPositiveInteger(body.projectVersion, 'projectVersion');
    const chapterRevision = cleanPositiveInteger(body.chapterRevision, 'chapterRevision');
    if (expected.projectVersion !== undefined && expected.projectVersion !== projectVersion) {
        invalidWorkflowIntent('Workflow V2 project authority does not match its trusted request.');
    }
    if (expected.chapterRevision !== undefined && expected.chapterRevision !== chapterRevision) {
        invalidWorkflowIntent('Workflow V2 chapter authority does not match its trusted request.');
    }
    const promptDigest = sha256(`${prompt.systemPrompt}\n\n${prompt.userPrompt}`);
    return {
        kind: body.kind,
        operation: body.operation,
        projectVersion,
        chapterRevision,
        prompt: {
            operation: prompt.operation,
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            materialsDigest: prompt.materialsDigest,
        },
        binding: {
            schemaVersion: WORKFLOW_V2_MODEL_SCHEMA_VERSION,
            operation: body.operation,
            materialsDigest: prompt.materialsDigest,
            promptDigest,
        },
    };
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

function promptProfileContextLimit(provider, resources, generation = null) {
    const configured = Number(generation?.contextTokens ?? resources?.promptProfile?.generation?.contextTokens);
    return Number.isFinite(configured) && configured >= 2_048
        ? Math.min(provider.contextTokens, Math.floor(configured))
        : provider.contextTokens;
}

function promptProfileOutputLimit(provider, resources, generation = null) {
    const configured = Number(generation?.maxTokens ?? resources?.promptProfile?.generation?.maxTokens);
    return Number.isFinite(configured) && configured >= 1
        ? Math.min(provider.maxTokens, Math.floor(configured))
        : provider.maxTokens;
}

export function generationWireRequest(request) {
    return Object.fromEntries([
        'prompt', 'responseSchema', 'systemPrompt', 'responseLength', 'minimumResponseLength',
        'jsonSchema', 'messages', 'stop', 'temperature', 'topP', 'topK', 'topA', 'minP',
        'frequencyPenalty', 'presencePenalty', 'repetitionPenalty', 'seed', 'assistantPrefill',
    ].filter(field => request[field] !== undefined).map(field => [field, request[field]]));
}

function assertSnapshot(expectedProjectVersion, expectedChapterRevision, project, chapter) {
    if (expectedProjectVersion !== undefined && project.version !== expectedProjectVersion) {
        throw new ApiError(409, 'project_conflict', 'Project changed before generation started.', {
            currentVersion: project.version,
        });
    }
    if (expectedChapterRevision !== undefined && chapter.revision !== expectedChapterRevision) {
        throw new ApiError(409, 'chapter_conflict', 'Chapter changed before generation started.', {
            currentRevision: chapter.revision,
        });
    }
}

export class GenerationService {
    constructor({
        storyStore,
        generationStore,
        chapterVersionStore = null,
        providerStore,
        retrievalStore = null,
        fetchImplementation = globalThis.fetch,
    }) {
        this.storyStore = storyStore;
        this.generationStore = generationStore;
        this.chapterVersionStore = chapterVersionStore;
        this.providerStore = providerStore;
        this.retrievalStore = retrievalStore;
        this.fetchImplementation = fetchImplementation;
        this.workflowGenerationInflight = new Map();
        this.workflowDistillationInflight = new Map();
    }

    loadContext(projectId, chapterId, expected = {}) {
        const project = this.storyStore.getProject(projectId);
        const chapter = this.storyStore.getChapter(projectId, chapterId);
        assertSnapshot(expected.projectVersion, expected.chapterRevision, project, chapter);
        const ordered = [...(project.chapters ?? [])].sort((left, right) => left.number - right.number);
        const chapterIndex = ordered.findIndex(item => item.id === chapter.id);
        const previousSummary = chapterIndex > 0 ? ordered[chapterIndex - 1] : null;
        const nextSummary = chapterIndex >= 0 ? ordered[chapterIndex + 1] : null;
        const previousChapter = previousSummary
            ? this.storyStore.getChapter(projectId, previousSummary.id)
            : null;
        const nextChapter = nextSummary
            ? this.storyStore.getChapter(projectId, nextSummary.id)
            : null;
        const references = project.resources ?? {};
        const characters = (references.activeCharacterIds ?? [])
            .map(id => ({ ...this.storyStore.getResource(projectId, 'character', id), active: true }));
        const lorebooks = (references.activeLorebookIds ?? [])
            .map(id => ({ ...this.storyStore.getResource(projectId, 'lorebook', id), active: true }));
        const promptProfile = references.activePromptProfileId
            ? { ...this.storyStore.getResource(projectId, 'prompt-profile', references.activePromptProfileId), active: true }
            : null;
        const persona = references.activePersonaId
            ? { ...this.storyStore.getResource(projectId, 'character', references.activePersonaId), persona: true }
            : null;
        const latestProject = this.storyStore.getProject(projectId);
        const latestChapter = this.storyStore.getChapter(projectId, chapterId);
        if (latestProject.version !== project.version || latestChapter.revision !== chapter.revision) {
            throw new ApiError(409, 'generation_context_changed', 'Project context changed while it was being assembled.');
        }
        return {
            project,
            chapter,
            previousChapter,
            nextChapter,
            resources: { characters, lorebooks, promptProfile, persona },
        };
    }

    prepareGeneration(projectId, chapterId, body, { internalKind = null, sourceContent = '' } = {}) {
        assertPlainObject(body, 'Generation request');
        assertKnownFields(body, [
            'kind', 'mode', 'parentId', 'instruction', 'projectVersion', 'chapterRevision', 'contextOverrides', 'selection',
            'retrieval',
        ], 'Generation request');
        const kind = internalKind ?? body.kind;
        if (internalKind === null && !WRITING_KINDS.has(kind)) {
            throw new ApiError(400, 'invalid_generation_kind', 'Generation kind is not supported.');
        }
        const mode = body.mode ?? 'generate';
        if (!GENERATION_MODES.has(mode)) {
            throw new ApiError(400, 'invalid_generation_mode', 'Generation mode is not supported.');
        }
        if (mode === 'continue' && kind !== 'draft') {
            throw new ApiError(400, 'invalid_generation_mode', 'Only draft candidates can be continued.');
        }
        const projectVersion = cleanPositiveInteger(body.projectVersion, 'projectVersion');
        const chapterRevision = cleanPositiveInteger(body.chapterRevision, 'chapterRevision');
        const instruction = cleanInstruction(body.instruction);
        const selection = normalizeSelection(body.selection);
        if (['polish', 'rewrite', 'expand', 'brainstorm'].includes(kind) && !selection?.text.trim()) {
            throw new ApiError(400, 'selection_required', 'This generation tool requires a non-empty manuscript selection.');
        }
        const context = this.loadContext(projectId, chapterId, { projectVersion, chapterRevision });
        const contextOverrides = normalizeContextOverrides(body.contextOverrides ?? {});
        const compiledStoryContext = compileStoryContext({
            project: context.project,
            chapter: context.chapter,
            previousChapter: context.previousChapter,
            nextChapter: context.nextChapter,
            overrides: contextOverrides,
        });
        const retrievalOptions = normalizeRetrievalOptions(body.retrieval);
        const retrievalQuery = retrievalOptions.query ?? buildRetrievalQuery({
            chapterTitle: context.chapter.title,
            chapterSummary: context.chapter.card?.summary,
            chapterGoal: context.chapter.card?.goal,
            chapterConflict: context.chapter.card?.conflict,
            instruction,
            selection: selection?.text,
        });
        const retrieval = this.retrievalStore
            ? this.retrievalStore.preview(projectId, chapterId, {
                ...retrievalOptions,
                query: retrievalQuery,
                rerank: false,
            })
            : null;
        let parent = null;
        if (body.parentId !== undefined && body.parentId !== null) {
            parent = this.generationStore.getGeneration(projectId, chapterId, body.parentId);
            if (parent.kind !== kind || !['completed', 'partial', 'adopted'].includes(parent.status)) {
                throw new ApiError(409, 'invalid_generation_parent', 'The selected parent candidate is not usable.');
            }
        }
        if (mode !== 'generate' && !parent) {
            throw new ApiError(400, 'invalid_generation_parent', `${mode} mode requires a parent candidate.`);
        }
        if (mode === 'generate' && parent) {
            throw new ApiError(400, 'invalid_generation_parent', 'Generate mode cannot specify a parent candidate.');
        }
        const provider = this.providerStore.getResolved();
        if (!provider.model) {
            throw new ApiError(400, 'provider_not_configured', 'Configure a model before generating.');
        }
        let contextTokens = promptProfileContextLimit(provider, context.resources);
        let outputLimit = promptProfileOutputLimit(provider, context.resources);
        let promptCharacterLimit = promptCharacterLimitForContext(contextTokens);
        let assembled;
        let promptTokens = 0;
        let responseLength = 0;
        for (let attempt = 0; attempt < MAX_PROMPT_FIT_ATTEMPTS; attempt++) {
            assembled = buildContextualGenerationRequest(
                kind,
                context.project,
                context.chapter,
                context.previousChapter,
                {
                    promptCharacterLimit,
                    resources: context.resources,
                    provider,
                    nextChapter: context.nextChapter,
                    additionalInstruction: instruction,
                    continuationContent: mode === 'continue' ? parent.content : '',
                    sourceContent,
                    storyState: compiledStoryContext.storyState,
                    continuityPreflight: compiledStoryContext.preflight,
                    retrievalContext: retrievalContextText(retrieval),
                    retrieval,
                    selection,
                },
            );
            const profileErrors = assembled.diagnostics?.profile?.errors ?? [];
            if (profileErrors.length > 0) {
                throw new ApiError(400, 'invalid_prompt_profile', 'The active Prompt Profile could not be compiled.', {
                    profileId: context.resources.promptProfile?.id ?? null,
                    profileHash: assembled.profileHash ?? assembled.diagnostics?.profile?.profileHash ?? null,
                    errors: profileErrors,
                    warnings: assembled.diagnostics?.profile?.warnings ?? [],
                });
            }
            const compiledContextTokens = promptProfileContextLimit(
                provider,
                context.resources,
                assembled.profileGeneration,
            );
            const compiledPromptLimit = promptCharacterLimitForContext(compiledContextTokens);
            if (compiledContextTokens !== contextTokens) {
                contextTokens = compiledContextTokens;
                promptCharacterLimit = compiledPromptLimit;
                continue;
            }
            outputLimit = promptProfileOutputLimit(provider, context.resources, assembled.profileGeneration);
            const promptText = Array.isArray(assembled.messages)
                ? assembled.messages.map(message => `${message.role}:\n${message.content}`).join('\n\n')
                : `${assembled.systemPrompt}\n\n${assembled.prompt}`;
            promptTokens = estimateTokenCount(promptText);
            const desired = Math.min(assembled.responseLength, outputLimit);
            responseLength = fitGenerationBudget(contextTokens, promptTokens, desired, {
                minimumResponseTokens: assembled.minimumResponseLength,
            });
            if (responseLength > 0) break;
            const nextLimit = nextPromptCharacterLimit(
                promptCharacterLimit,
                contextTokens,
                promptTokens,
                assembled.minimumResponseLength,
            );
            if (nextLimit >= promptCharacterLimit) break;
            promptCharacterLimit = nextLimit;
        }
        if (!responseLength) {
            throw new ApiError(400, 'generation_budget_too_small', 'The configured context cannot fit this task and its minimum output.', {
                contextTokens,
                promptTokens,
                minimumResponseTokens: assembled?.minimumResponseLength,
            });
        }
        let normalized;
        try {
            normalized = normalizeGenerationRequest(generationWireRequest({
                ...assembled,
                responseLength,
            }), provider);
        } catch (error) {
            if (context.resources.promptProfile?.profileVersion === 2 && error?.code === 'invalid_request') {
                throw new ApiError(400, 'invalid_prompt_profile', 'The active Prompt Profile contains an invalid generation parameter.', {
                    profileId: context.resources.promptProfile?.id ?? null,
                    profileHash: assembled.profileHash ?? null,
                    causeCode: error.code,
                    cause: error.message,
                });
            }
            throw error;
        }
        const diagnostics = {
            ...assembled.diagnostics,
            storyContext: compiledStoryContext.diagnostics,
            retrieval: retrieval
                ? {
                    query: retrieval.query,
                    hits: retrieval.hits,
                    total: retrieval.total,
                    diagnostics: retrieval.diagnostics,
                }
                : null,
            providerAdapter: getProviderAdapterDiagnostics(provider, normalized),
            promptTokens,
            contextTokens,
            responseTokens: responseLength,
            outputLimited: responseLength < assembled.responseLength,
            promptDigest: sha256(normalized.messages
                ? JSON.stringify(normalized.messages)
                : `${normalized.systemPrompt}\n\n${normalized.prompt}`),
        };
        return { kind, mode, parent, provider, context, request: normalized, diagnostics };
    }

    previewGeneration(projectId, chapterId, body) {
        const prepared = this.prepareGeneration(projectId, chapterId, body);
        return {
            kind: prepared.kind,
            mode: prepared.mode,
            parentId: prepared.parent?.id ?? null,
            systemPrompt: prepared.request.systemPrompt,
            prompt: prepared.request.prompt,
            ...(prepared.request.messages ? { messages: prepared.request.messages } : {}),
            responseLength: prepared.request.responseLength,
            diagnostics: prepared.diagnostics,
        };
    }

    listGenerations(projectId, chapterId) {
        this.storyStore.assertChapterExistsReadOnly(projectId, chapterId);
        return this.generationStore.listGenerations(projectId, chapterId);
    }

    getGeneration(projectId, chapterId, generationId) {
        this.storyStore.assertChapterExistsReadOnly(projectId, chapterId);
        return this.generationStore.getGeneration(projectId, chapterId, generationId);
    }

    workflowGenerations(projectId, chapterId, intent) {
        return this.generationStore.listGenerations(projectId, chapterId)
            .map(item => this.generationStore.getGeneration(projectId, chapterId, item.id))
            .filter(item => item.request?.workflowGeneration?.slotDigest === intent.slotDigest);
    }

    assertWorkflowGenerationBinding(generation, intent) {
        const stored = generation.request?.workflowGeneration;
        if (!stored || stored.schemaVersion !== WORKFLOW_GENERATION_SCHEMA_VERSION
            || stored.slotDigest !== intent.slotDigest
            || stableDigest(stored.slot) !== stableDigest(intent.slot)) {
            workflowGenerationConflict('Persisted workflow generation does not match its slot binding.');
        }
        if (stored.commandDigest !== intent.commandDigest || stored.commandId !== intent.commandId) {
            workflowGenerationConflict();
        }
    }

    async streamWorkflowGeneration(projectId, chapterId, body, callbacks, intent) {
        const existing = this.workflowGenerations(projectId, chapterId, intent);
        for (const generation of existing) this.assertWorkflowGenerationBinding(generation, intent);
        const reusable = existing.find(generation => REUSABLE_WORKFLOW_GENERATION_STATUSES.has(generation.status));
        if (reusable) {
            await callbacks.onMeta?.({
                generationId: reusable.id,
                kind: reusable.kind,
                mode: reusable.mode,
                parentId: reusable.parentId,
                baseContent: '',
                diagnostics: reusable.request?.diagnostics ?? null,
                reused: true,
            });
            return {
                generation: reusable,
                diagnostics: reusable.request?.diagnostics ?? null,
                reused: true,
            };
        }

        const interrupted = existing.filter(generation => generation.status === 'streaming');
        for (const generation of interrupted) {
            this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                status: 'failed',
                finishReason: 'workflow-retry',
                error: 'Workflow generation was interrupted before completion; a bound retry was started.',
            });
        }
        const retrySource = existing[0] ?? null;
        const attempt = existing.reduce((maximum, generation) => (
            Math.max(maximum, Number(generation.request?.workflowGeneration?.attempt) || 1)
        ), 0) + 1;
        return this.streamNewGeneration(projectId, chapterId, body, callbacks, {
            ...intent,
            attempt: Math.max(1, attempt),
            retryOf: retrySource?.id ?? null,
        });
    }

    async streamGeneration(projectId, chapterId, body, {
        signal,
        onMeta,
        onDelta,
        workflowIntent = null,
    } = {}) {
        const callbacks = { signal, onMeta, onDelta };
        if (!workflowIntent) return this.streamNewGeneration(projectId, chapterId, body, callbacks);
        const intent = normalizeWorkflowGenerationIntent(workflowIntent, {
            projectId,
            chapterId,
            kind: body?.kind,
        });
        const active = this.workflowGenerationInflight.get(intent.slotDigest);
        if (active) {
            if (active.commandDigest !== intent.commandDigest || active.commandId !== intent.commandId) {
                workflowGenerationConflict();
            }
            return active.promise;
        }
        const promise = this.streamWorkflowGeneration(projectId, chapterId, body, callbacks, intent);
        this.workflowGenerationInflight.set(intent.slotDigest, {
            commandDigest: intent.commandDigest,
            commandId: intent.commandId,
            promise,
        });
        try {
            return await promise;
        } finally {
            const current = this.workflowGenerationInflight.get(intent.slotDigest);
            if (current?.promise === promise) this.workflowGenerationInflight.delete(intent.slotDigest);
        }
    }

    assertWorkflowV2ModelBinding(generation, binding) {
        const stored = generation.request?.workflowV2;
        if (!stored || stored.schemaVersion !== WORKFLOW_V2_MODEL_SCHEMA_VERSION
            || stableDigest(stored) !== stableDigest(binding)) {
            workflowGenerationConflict('Persisted Workflow V2 generation does not match its prompt binding.');
        }
    }

    async streamWorkflowV2Model(projectId, chapterId, body, {
        signal,
        workflowIntent,
    } = {}) {
        if (!workflowIntent) {
            invalidWorkflowIntent('Workflow V2 model execution requires a trusted persisted intent.');
        }
        const request = normalizeWorkflowV2ModelRequest(body, {});
        const intent = normalizeWorkflowGenerationIntent(workflowIntent, {
            projectId,
            chapterId,
            kind: request.kind,
        });
        const active = this.workflowGenerationInflight.get(intent.slotDigest);
        if (active) {
            if (active.commandDigest !== intent.commandDigest || active.commandId !== intent.commandId) {
                workflowGenerationConflict();
            }
            return active.promise;
        }
        const promise = this.streamWorkflowV2ModelBound(projectId, chapterId, request, intent, { signal });
        this.workflowGenerationInflight.set(intent.slotDigest, {
            commandDigest: intent.commandDigest,
            commandId: intent.commandId,
            promise,
        });
        try {
            return await promise;
        } finally {
            const current = this.workflowGenerationInflight.get(intent.slotDigest);
            if (current?.promise === promise) this.workflowGenerationInflight.delete(intent.slotDigest);
        }
    }

    async streamWorkflowV2ModelBound(projectId, chapterId, request, intent, { signal } = {}) {
        throwIfAborted(signal);
        const { project, chapter } = this.loadContext(projectId, chapterId, {
            projectVersion: request.projectVersion,
            chapterRevision: request.chapterRevision,
        });
        const existing = this.workflowGenerations(projectId, chapterId, intent);
        for (const generation of existing) {
            this.assertWorkflowGenerationBinding(generation, intent);
            this.assertWorkflowV2ModelBinding(generation, request.binding);
        }
        const reusable = existing.find(generation => (
            REUSABLE_WORKFLOW_V2_GENERATION_STATUSES.has(generation.status)
        ));
        if (reusable) {
            return {
                generation: reusable,
                diagnostics: reusable.request?.diagnostics ?? null,
                reused: true,
            };
        }
        for (const generation of existing.filter(item => item.status === 'streaming')) {
            this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                status: 'failed',
                finishReason: 'workflow-retry',
                error: 'Workflow V2 generation was interrupted before completion; a bound retry was started.',
            });
        }

        const provider = this.providerStore.getResolved();
        if (!provider.model) {
            throw new ApiError(400, 'provider_not_configured', 'Configure a model before generating.');
        }
        const promptText = `${request.prompt.systemPrompt}\n\n${request.prompt.userPrompt}`;
        const promptTokens = estimateTokenCount(promptText);
        const minimumResponseTokens = Math.min(
            provider.maxTokens,
            request.operation === 'draft' ? 256 : 64,
        );
        const responseLength = fitGenerationBudget(
            provider.contextTokens,
            promptTokens,
            provider.maxTokens,
            { minimumResponseTokens },
        );
        if (!responseLength) {
            throw new ApiError(400, 'generation_budget_too_small',
                'The configured context cannot fit this Workflow V2 task.', {
                    contextTokens: provider.contextTokens,
                    promptTokens,
                    minimumResponseTokens,
                });
        }
        const normalized = normalizeGenerationRequest({
            systemPrompt: request.prompt.systemPrompt,
            prompt: request.prompt.userPrompt,
            responseLength,
            minimumResponseLength: minimumResponseTokens,
        }, provider);
        const diagnostics = {
            workflowV2: request.binding,
            providerAdapter: getProviderAdapterDiagnostics(provider, normalized),
            promptTokens,
            contextTokens: provider.contextTokens,
            responseTokens: responseLength,
            outputLimited: responseLength < provider.maxTokens,
            promptDigest: request.binding.promptDigest,
        };
        const retrySource = existing[0] ?? null;
        const attempt = existing.reduce((maximum, generation) => (
            Math.max(maximum, Number(generation.request?.workflowGeneration?.attempt) || 1)
        ), 0) + 1;
        const workflowGeneration = {
            ...intent,
            attempt: Math.max(1, attempt),
            retryOf: retrySource?.id ?? null,
        };
        const generation = this.generationStore.createGeneration({
            projectId,
            chapterId,
            kind: request.kind,
            mode: 'generate',
            request: {
                projectVersion: project.version,
                chapterRevision: chapter.revision,
                promptDigest: request.binding.promptDigest,
                promptCharacters: promptText.length,
                promptTokens,
                contextTokens: provider.contextTokens,
                responseTokens: responseLength,
                diagnostics,
                workflowGeneration,
                workflowV2: request.binding,
            },
        });
        let streamed = '';
        try {
            const result = await createStreamingCompletion(provider, normalized, {
                fetchImplementation: this.fetchImplementation,
                signal,
                onDelta: async delta => {
                    streamed += delta;
                    if (streamed.length > MAX_CONTENT_CHARACTERS) {
                        throw new ApiError(413, 'generation_too_large',
                            'Generated Workflow V2 output exceeds the storage limit.');
                    }
                },
            });
            throwIfAborted(signal);
            return {
                generation: this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                    status: 'completed',
                    content: result.content,
                    finishReason: result.finishReason ?? 'stop',
                    model: result.model,
                    usage: result.usage,
                }),
                diagnostics,
                reused: false,
            };
        } catch (error) {
            const externallyAborted = signal?.aborted || error?.name === 'AbortError';
            this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                status: streamed.length > 0 ? 'partial' : 'failed',
                content: streamed.slice(0, MAX_CONTENT_CHARACTERS),
                finishReason: externallyAborted ? 'aborted' : 'error',
                error: externallyAborted
                    ? 'Workflow V2 generation stopped by the user.'
                    : String(error?.message ?? 'Workflow V2 generation failed.'),
            });
            if (error && typeof error === 'object') {
                error.generationId = generation.id;
                error.partial = streamed.length > 0;
            }
            throw error;
        }
    }

    async streamNewGeneration(projectId, chapterId, body, { signal, onMeta, onDelta }, workflowGeneration = null) {
        throwIfAborted(signal);
        const prepared = this.prepareGeneration(projectId, chapterId, body);
        const generation = this.generationStore.createGeneration({
            projectId,
            chapterId,
            kind: prepared.kind,
            mode: prepared.mode,
            parentId: prepared.parent?.id ?? null,
            request: {
                projectVersion: prepared.context.project.version,
                chapterRevision: prepared.context.chapter.revision,
                promptDigest: prepared.diagnostics.promptDigest,
                promptCharacters: prepared.diagnostics.totalCharacters,
                promptTokens: prepared.diagnostics.promptTokens,
                contextTokens: prepared.diagnostics.contextTokens,
                responseTokens: prepared.diagnostics.responseTokens,
                diagnostics: prepared.diagnostics,
                ...(workflowGeneration ? { workflowGeneration } : {}),
                ...(body.selection ? {
                    selection: {
                        start: body.selection.start ?? null,
                        end: body.selection.end ?? null,
                        characters: body.selection.text?.length ?? 0,
                        contentHash: sha256(body.selection.text ?? ''),
                    },
                } : {}),
            },
        });
        const baseContent = prepared.mode === 'continue' ? prepared.parent.content : '';
        let streamed = '';
        try {
            await onMeta?.({
                generationId: generation.id,
                kind: generation.kind,
                mode: generation.mode,
                parentId: generation.parentId,
                baseContent,
                diagnostics: prepared.diagnostics,
            });
            const result = await createStreamingCompletion(prepared.provider, prepared.request, {
                fetchImplementation: this.fetchImplementation,
                signal,
                onDelta: async delta => {
                    streamed += delta;
                    if (baseContent.length + streamed.length > MAX_CONTENT_CHARACTERS) {
                        throw new ApiError(413, 'generation_too_large', 'Generated candidate exceeds the storage limit.');
                    }
                    await onDelta?.(delta);
                },
            });
            throwIfAborted(signal);
            const completed = this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                status: 'completed',
                content: `${baseContent}${result.content}`,
                finishReason: result.finishReason ?? 'stop',
                model: result.model,
                usage: result.usage,
            });
            return { generation: completed, diagnostics: prepared.diagnostics };
        } catch (error) {
            const externallyAborted = signal?.aborted || error?.name === 'AbortError';
            const content = `${baseContent}${streamed}`.slice(0, MAX_CONTENT_CHARACTERS);
            const status = streamed.length > 0 ? 'partial' : 'failed';
            this.generationStore.finishGeneration(projectId, chapterId, generation.id, {
                status,
                content,
                finishReason: externallyAborted ? 'aborted' : 'error',
                error: externallyAborted ? 'Generation stopped by the user.' : String(error?.message ?? 'Generation failed.'),
            });
            error.generationId = generation.id;
            error.partial = streamed.length > 0;
            throw error;
        }
    }

    assertWorkflowDistillationBinding(distillation, intent) {
        const stored = distillation?.workflowGeneration;
        if (!stored || stored.schemaVersion !== WORKFLOW_GENERATION_SCHEMA_VERSION
            || stored.slotDigest !== intent.slotDigest
            || stableDigest(stored.slot) !== stableDigest(intent.slot)
            || !Number.isSafeInteger(stored.attempt) || stored.attempt < 1) {
            workflowGenerationConflict('Persisted workflow distillation does not match its slot binding.');
        }
        if (stored.commandDigest !== intent.commandDigest || stored.commandId !== intent.commandId) {
            workflowGenerationConflict('Workflow distillation slot is already bound to another command.');
        }
        return stored;
    }

    workflowDistillation(projectId, chapterId, generationId, source, intent) {
        let stored = this.generationStore.getWorkflowDistillation(
            projectId,
            chapterId,
            generationId,
            intent.slotDigest,
            { optional: true },
        );
        if (stored) return stored;

        const legacy = source.distillation;
        if (legacy?.workflowGeneration?.slotDigest !== intent.slotDigest) return null;
        this.assertWorkflowDistillationBinding(legacy, intent);
        if (!['running', 'ready', 'failed'].includes(legacy.status)) {
            workflowGenerationConflict('Legacy workflow distillation has an invalid state.');
        }
        stored = this.generationStore.saveWorkflowDistillation(
            projectId,
            chapterId,
            generationId,
            intent.slotDigest,
            {
                status: legacy.status,
                changes: legacy.changes,
                raw: legacy.raw,
                error: legacy.error,
                createdAt: legacy.createdAt,
                workflowGeneration: legacy.workflowGeneration,
            },
        );
        return stored;
    }

    assertDistillableSource(source) {
        if (source.kind !== 'draft' || !['completed', 'partial'].includes(source.status) || !source.content) {
            throw new ApiError(409, 'generation_not_ready', 'Only a non-empty draft candidate can be distilled.');
        }
    }

    async distillGeneration(projectId, chapterId, generationId, body, {
        workflowIntent = null,
        signal,
    } = {}) {
        assertPlainObject(body, 'Distillation request');
        assertKnownFields(body, ['projectVersion', 'chapterRevision', 'instruction', 'contextOverrides'], 'Distillation request');
        if (!workflowIntent) return this.distillGenerationManually(projectId, chapterId, generationId, body, { signal });
        const intent = normalizeWorkflowGenerationIntent(workflowIntent, {
            projectId,
            chapterId,
            generationId,
            kind: 'distill',
        });
        const active = this.workflowDistillationInflight.get(intent.slotDigest);
        if (active) {
            if (active.commandDigest !== intent.commandDigest || active.commandId !== intent.commandId) {
                workflowGenerationConflict('Workflow distillation slot is already bound to another command.');
            }
            return active.promise;
        }
        const promise = this.distillWorkflowGeneration(projectId, chapterId, generationId, body, intent, { signal });
        this.workflowDistillationInflight.set(intent.slotDigest, {
            commandDigest: intent.commandDigest,
            commandId: intent.commandId,
            promise,
        });
        try {
            return await promise;
        } finally {
            const current = this.workflowDistillationInflight.get(intent.slotDigest);
            if (current?.promise === promise) this.workflowDistillationInflight.delete(intent.slotDigest);
        }
    }

    async distillGenerationManually(projectId, chapterId, generationId, body, { signal } = {}) {
        throwIfAborted(signal);
        const source = this.generationStore.getGeneration(projectId, chapterId, generationId);
        this.assertDistillableSource(source);
        if (source.distillation?.workflowGeneration) {
            workflowGenerationConflict('A workflow-bound distillation cannot be replaced by a manual request.');
        }
        let prepared;
        const priorDistillation = source.distillation;
        try {
            prepared = this.prepareGeneration(projectId, chapterId, {
                ...body,
                kind: 'distill',
                mode: 'generate',
            }, { internalKind: 'distill', sourceContent: source.content });
            const result = await createChatCompletion(prepared.provider, prepared.request, {
                fetchImplementation: this.fetchImplementation,
                signal,
            });
            throwIfAborted(signal);
            const changes = parseStructuredResponse(result.content);
            if (!changes || typeof changes !== 'object' || Array.isArray(changes)
                || typeof changes.chapterSummary !== 'string'
                || !changes.storyStateChanges || typeof changes.storyStateChanges !== 'object') {
                throw new ApiError(502, 'invalid_distillation', 'The model did not return a valid distillation ChangeSet.');
            }
            const generation = this.generationStore.saveDistillation(projectId, chapterId, generationId, {
                status: 'ready',
                changes,
                raw: result.content,
            });
            return { generation, changes, model: result.model, usage: result.usage, diagnostics: prepared.diagnostics };
        } catch (error) {
            if (priorDistillation?.status !== 'ready') {
                try {
                    this.generationStore.saveDistillation(projectId, chapterId, generationId, {
                        status: 'failed',
                        changes: null,
                        raw: '',
                        error: String(error?.message ?? 'Distillation failed.'),
                    });
                } catch {
                    // The original error is authoritative; the draft candidate remains intact.
                }
            }
            throw error;
        }
    }

    async distillWorkflowGeneration(projectId, chapterId, generationId, body, intent, { signal } = {}) {
        throwIfAborted(signal);
        const source = this.generationStore.getGeneration(projectId, chapterId, generationId);
        this.assertDistillableSource(source);
        const prior = this.workflowDistillation(projectId, chapterId, generationId, source, intent);
        let priorBinding = null;
        if (prior) {
            priorBinding = this.assertWorkflowDistillationBinding(prior, intent);
            if (prior.status === 'ready') {
                return {
                    generation: source,
                    changes: prior.changes,
                    workflowDistillation: prior,
                    model: '',
                    usage: null,
                    diagnostics: null,
                    reused: true,
                };
            }
            if (!['running', 'failed'].includes(prior.status)) {
                workflowGenerationConflict('Persisted workflow distillation has an invalid retry state.');
            }
        }

        const prepared = this.prepareGeneration(projectId, chapterId, {
            ...body,
            kind: 'distill',
            mode: 'generate',
        }, { internalKind: 'distill', sourceContent: source.content });
        const workflowGeneration = {
            ...intent,
            attempt: (priorBinding?.attempt ?? 0) + 1,
        };
        const running = this.generationStore.saveWorkflowDistillation(
            projectId,
            chapterId,
            generationId,
            intent.slotDigest,
            {
                status: 'running',
                changes: null,
                raw: '',
                error: prior?.status === 'running'
                    ? 'The previous workflow distillation was interrupted before completion.'
                    : '',
                workflowGeneration,
            },
        );
        try {
            const result = await createChatCompletion(prepared.provider, prepared.request, {
                fetchImplementation: this.fetchImplementation,
                signal,
            });
            throwIfAborted(signal);
            const changes = parseStructuredResponse(result.content);
            if (!changes || typeof changes !== 'object' || Array.isArray(changes)
                || typeof changes.chapterSummary !== 'string'
                || !changes.storyStateChanges || typeof changes.storyStateChanges !== 'object') {
                throw new ApiError(502, 'invalid_distillation', 'The model did not return a valid distillation ChangeSet.');
            }
            const workflowDistillation = this.generationStore.saveWorkflowDistillation(
                projectId,
                chapterId,
                generationId,
                intent.slotDigest,
                {
                    status: 'ready',
                    changes,
                    raw: result.content,
                    error: '',
                    createdAt: running.createdAt,
                    workflowGeneration,
                },
            );
            return {
                generation: this.generationStore.getGeneration(projectId, chapterId, generationId),
                changes,
                workflowDistillation,
                model: result.model,
                usage: result.usage,
                diagnostics: prepared.diagnostics,
            };
        } catch (error) {
            try {
                const current = this.generationStore.getWorkflowDistillation(
                    projectId, chapterId, generationId, intent.slotDigest,
                );
                if (current.status !== 'ready') {
                    this.assertWorkflowDistillationBinding(current, intent);
                    this.generationStore.saveWorkflowDistillation(
                        projectId,
                        chapterId,
                        generationId,
                        intent.slotDigest,
                        {
                        status: 'failed',
                        changes: null,
                        raw: '',
                        error: String(error?.message ?? 'Distillation failed.'),
                        createdAt: running.createdAt,
                        workflowGeneration,
                        },
                    );
                }
            } catch {
                // Preserve the original Provider or parsing error.
            }
            throw error;
        }
    }

    adoptGeneration(projectId, chapterId, generationId, body) {
        assertPlainObject(body, 'Adoption request');
        assertKnownFields(body, [
            'projectVersion', 'chapterRevision', 'contentMode', 'contentOffset', 'includeContent',
            'chapterSummary', 'storyStateChanges',
        ], 'Adoption request');
        const candidate = this.generationStore.getGeneration(projectId, chapterId, generationId);
        if (!['completed', 'partial', 'adopted'].includes(candidate.status)) {
            throw new ApiError(409, 'generation_not_ready', 'Generation is not ready for adoption.');
        }
        const requestedProjectVersion = cleanPositiveInteger(body.projectVersion, 'projectVersion');
        const requestedChapterRevision = cleanPositiveInteger(body.chapterRevision, 'chapterRevision');
        const alreadyAdopted = this.storyStore.getChapter(projectId, chapterId).generationHistory
            ?.some(entry => entry.generationId === generationId) ?? false;
        if (candidate.status !== 'adopted'
            && !alreadyAdopted
            && (Number(candidate.request?.projectVersion) !== requestedProjectVersion
                || Number(candidate.request?.chapterRevision) !== requestedChapterRevision)) {
            throw new ApiError(409, 'candidate_stale', '候选生成后，正式作品或章节已经变化；请重新生成或手工合并。', {
                generatedFromProjectVersion: candidate.request?.projectVersion ?? null,
                generatedFromChapterRevision: candidate.request?.chapterRevision ?? null,
            });
        }
        const distilled = candidate.distillation.status === 'ready' ? candidate.distillation.changes : null;
        const includeContent = body.includeContent ?? candidate.kind === 'draft';
        const contentMode = body.contentMode ?? 'replace';
        const adoption = {
            generationId,
            kind: candidate.kind,
            ...(includeContent ? {
                content: {
                    mode: contentMode,
                    text: candidate.content,
                    ...(contentMode === 'insert' ? { offset: body.contentOffset } : {}),
                },
            } : {}),
            ...((body.chapterSummary ?? distilled?.chapterSummary) !== undefined ? {
                chapterSummary: body.chapterSummary ?? distilled.chapterSummary,
            } : {}),
            ...((body.storyStateChanges ?? distilled?.storyStateChanges) ? {
                storyStateChanges: body.storyStateChanges ?? distilled.storyStateChanges,
            } : {}),
        };
        const result = this.storyStore.adoptGeneration(
            projectId,
            chapterId,
            requestedProjectVersion,
            requestedChapterRevision,
            adoption,
            {
                beforeCommit: this.chapterVersionStore
                    ? ({ projectVersion, chapter }) => this.chapterVersionStore.appendVersion(
                        chapterVersionInput(projectVersion, chapter, 'adopt'),
                    )
                    : null,
            },
        );
        try {
            this.generationStore.markAdopted(projectId, chapterId, generationId);
        } catch (error) {
            console.warn(`Could not mark adopted generation ${generationId}:`, error.message);
        }
        return { ...result, generation: this.generationStore.getGeneration(projectId, chapterId, generationId) };
    }
}
