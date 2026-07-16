import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
    buildRetrievalQuery,
    GenerationService,
    MAX_RETRIEVAL_QUERY_CHARACTERS,
} from '../src/generation-service.js';
import { GenerationStore } from '../src/generation-store.js';
import { StoryStudioStore } from '../src/story-studio-store.js';

function cancellableSse() {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"model":"writer","choices":[{"delta":{"content":"已生成的半段"},"finish_reason":null}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"model":"writer","choices":[{"delta":{"content":"不应到达"},"finish_reason":"stop"}]}\n\n'));
            controller.close();
        },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('generation service cancellation recovery', () => {
    let root;
    let storyStore;
    let generationStore;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-generation-service-'));
        storyStore = new StoryStudioStore(path.join(root, 'stories'));
        generationStore = new GenerationStore(path.join(root, 'generations'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('keeps streamed text as a partial candidate without mutating the formal chapter', async () => {
        const { project, chapter } = storyStore.createProject({ title: '停止样本' });
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 32_768, maxTokens: 8_192,
            jsonSchema: false,
        };
        const service = new GenerationService({
            storyStore,
            generationStore,
            providerStore: { getResolved: () => provider },
            fetchImplementation: async () => cancellableSse(),
        });
        const controller = new AbortController();
        let generationId;
        await assert.rejects(
            service.streamGeneration(project.id, chapter.id, {
                kind: 'draft', mode: 'generate', projectVersion: project.version, chapterRevision: chapter.revision,
            }, {
                signal: controller.signal,
                onMeta: meta => { generationId = meta.generationId; },
                onDelta: () => controller.abort(new DOMException('Stopped by test.', 'AbortError')),
            }),
            error => error.name === 'AbortError',
        );
        const partial = generationStore.getGeneration(project.id, chapter.id, generationId);
        assert.equal(partial.status, 'partial');
        assert.equal(partial.content, '已生成的半段');
        assert.equal(partial.finishReason, 'aborted');
        assert.equal(storyStore.getChapter(project.id, chapter.id).content, '');
        assert.deepEqual(storyStore.getProject(project.id).storyState, {
            entities: [], relations: [], events: [], promises: [], memory: [],
            facts: [], knowledge: [], timeline: [],
        });
    });

    test('finalizes a candidate when the initial meta callback fails', async () => {
        const { project, chapter } = storyStore.createProject({ title: 'Meta 失败' });
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 32_768, maxTokens: 8_192, jsonSchema: false,
        };
        const service = new GenerationService({
            storyStore, generationStore, providerStore: { getResolved: () => provider },
            fetchImplementation: async () => cancellableSse(),
        });
        await assert.rejects(
            service.streamGeneration(project.id, chapter.id, {
                kind: 'draft', mode: 'generate', projectVersion: project.version, chapterRevision: chapter.revision,
            }, { onMeta: () => { throw new Error('response closed'); } }),
            /response closed/,
        );
        const history = generationStore.listGenerations(project.id, chapter.id);
        assert.equal(history.length, 1);
        assert.equal(history[0].status, 'failed');
    });

    test('keeps an existing ready ChangeSet when a distillation retry fails', async () => {
        const { project, chapter } = storyStore.createProject({ title: '蒸馏重试' });
        const candidate = generationStore.createGeneration({
            projectId: project.id, chapterId: chapter.id, kind: 'draft',
            request: { projectVersion: project.version, chapterRevision: chapter.revision },
        });
        generationStore.finishGeneration(project.id, chapter.id, candidate.id, { content: '候选正文。' });
        generationStore.saveDistillation(project.id, chapter.id, candidate.id, {
            status: 'ready',
            changes: { chapterSummary: '旧摘要', storyStateChanges: {} },
            raw: '{"chapterSummary":"旧摘要"}',
        });
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 32_768, maxTokens: 8_192, jsonSchema: false,
        };
        const service = new GenerationService({
            storyStore, generationStore, providerStore: { getResolved: () => provider },
            fetchImplementation: async () => { throw new Error('offline'); },
        });
        await assert.rejects(
            service.distillGeneration(project.id, chapter.id, candidate.id, {
                projectVersion: project.version, chapterRevision: chapter.revision,
            }),
        );
        const preserved = generationStore.getGeneration(project.id, chapter.id, candidate.id).distillation;
        assert.equal(preserved.status, 'ready');
        assert.equal(preserved.changes.chapterSummary, '旧摘要');
    });

    test('rejects Profile V2 generation when the required continuity preflight cannot fit', () => {
        const project = {
            id: 'project-preflight', title: '预检预算', genre: '', targetWords: 100_000,
            chapterTargetWords: 3_000, version: 1, story: {}, continuity: [], volumes: [],
            chapters: [{ id: 'chapter-preflight', number: 1, title: '开端' }],
            resources: {
                activeCharacterIds: [], activeLorebookIds: [],
                activePromptProfileId: 'profile-preflight', activePersonaId: null,
            },
            storyState: {
                entities: [{
                    id: 'hero', kind: 'character', name: '主角', summary: '', aliases: [], status: 'active',
                    locationEntityId: null, currentGoal: '', currentAction: '', updatedChapterId: 'chapter-preflight',
                }],
                relations: [], events: [], promises: [], memory: [], timeline: [],
                facts: [{
                    id: 'hidden-fact', summary: '秘密'.repeat(2_000), subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-preflight', status: 'active', supersededById: null,
                    confidence: 1, tags: [],
                }],
                knowledge: [{
                    id: 'hidden-knowledge', entityId: 'hero', factId: 'hidden-fact', stance: 'hides',
                    learnedChapterId: 'chapter-preflight', status: 'active',
                }],
            },
        };
        const chapter = {
            id: 'chapter-preflight', projectId: project.id, number: 1, title: '开端', status: 'drafting',
            card: { pov: 'hero' }, content: '', revision: 1,
        };
        const profile = {
            id: 'profile-preflight', profileVersion: 2, characterBudget: 800,
            modules: [], order: [], variables: [], taskPolicies: {}, generation: {},
        };
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 32_768, maxTokens: 8_192,
            jsonSchema: false,
        };
        const service = new GenerationService({
            storyStore: {
                getProject: () => structuredClone(project),
                getChapter: () => structuredClone(chapter),
                getResource: () => structuredClone(profile),
            },
            generationStore: {},
            providerStore: { getResolved: () => provider },
        });

        assert.throws(
            () => service.prepareGeneration(project.id, chapter.id, {
                kind: 'draft', mode: 'generate', projectVersion: 1, chapterRevision: 1,
            }),
            error => error.code === 'invalid_prompt_profile'
                && error.details.errors.some(item => item.code === 'required_continuity_preflight_missing'),
        );
    });

    test('injects traceable retrieval hits and exposes the same evidence in diagnostics', () => {
        const { project, chapter } = storyStore.createProject({ title: '检索生成' });
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 32_768, maxTokens: 8_192,
            jsonSchema: false,
        };
        const retrieval = {
            query: '铜钥匙',
            hits: [{
                id: 'fact:key:0-8', text: '铜钥匙能开启地库。', score: 4.2, reason: 'bm25', reasons: ['bm25'],
                sourceType: 'fact', sourceId: 'key', chapterId: chapter.id,
            }],
            total: 1,
            diagnostics: { sourceDigest: 'a'.repeat(64) },
        };
        const service = new GenerationService({
            storyStore,
            generationStore,
            retrievalStore: { preview: () => structuredClone(retrieval) },
            providerStore: { getResolved: () => provider },
        });
        const preview = service.previewGeneration(project.id, chapter.id, {
            kind: 'draft', mode: 'generate', projectVersion: project.version, chapterRevision: chapter.revision,
            retrieval: { query: '铜钥匙', include: ['key'], exclude: [] },
        });
        const prompt = Array.isArray(preview.messages)
            ? preview.messages.map(message => message.content).join('\n')
            : `${preview.systemPrompt}\n${preview.prompt}`;
        assert.match(prompt, /可追溯检索命中/);
        assert.match(prompt, /铜钥匙能开启地库/);
        assert.equal(preview.diagnostics.retrieval.query, '铜钥匙');
        assert.deepEqual(preview.diagnostics.retrieval.hits, retrieval.hits);
    });

    test('keeps maximum legal generation inputs while bounding the implicit retrieval query', () => {
        const { project, chapter } = storyStore.createProject({ title: '长输入检索' });
        const provider = {
            protocol: 'openai-chat', baseUrl: 'http://writer.local/v1', model: 'writer', apiKey: '',
            temperature: 0.7, topP: 1, topK: 0, stop: [], contextTokens: 1_000_000, maxTokens: 8_192,
            jsonSchema: false,
        };
        let retrievalInput = null;
        const service = new GenerationService({
            storyStore,
            generationStore,
            retrievalStore: {
                preview: (_projectId, _chapterId, input) => {
                    retrievalInput = structuredClone(input);
                    assert.ok(input.query.length <= 20_000, 'implicit retrieval query must respect the store limit');
                    return { query: input.query, hits: [], total: 0, diagnostics: {} };
                },
            },
            providerStore: { getResolved: () => provider },
        });
        const instructionTail = '[INSTRUCTION-TAIL]';
        const selectionTail = '[SELECTION-TAIL]';
        const instruction = `指${'令'.repeat(50_000 - instructionTail.length - 1)}${instructionTail}`;
        const selection = `选${'文'.repeat(500_000 - selectionTail.length - 1)}${selectionTail}`;

        const preview = service.previewGeneration(project.id, chapter.id, {
            kind: 'draft', mode: 'generate', projectVersion: project.version, chapterRevision: chapter.revision,
            instruction,
            selection: { text: selection, before: '', after: '', start: 0, end: selection.length },
        });

        assert.equal(instruction.length, 50_000);
        assert.equal(selection.length, 500_000);
        assert.equal(retrievalInput.rerank, false);
        assert.equal(preview.diagnostics.retrieval.query, retrievalInput.query);
    });

    test('builds a deterministic field-budgeted retrieval query shared by callers', () => {
        const fields = {
            chapterTitle: 'T'.repeat(2_000),
            chapterSummary: 'S'.repeat(6_000),
            chapterGoal: 'G'.repeat(6_000),
            chapterConflict: 'C'.repeat(6_000),
            instruction: 'I'.repeat(20_000),
            selection: 'X'.repeat(20_000),
        };

        const first = buildRetrievalQuery(fields);
        const second = buildRetrievalQuery(structuredClone(fields));

        assert.equal(first, second);
        assert.equal(first.length, MAX_RETRIEVAL_QUERY_CHARACTERS);
        for (const marker of ['T', 'S', 'G', 'C', 'I', 'X']) assert.match(first, new RegExp(marker));
        assert.equal(buildRetrievalQuery({ instruction: 'I'.repeat(50_000) }).length, 20_000);
    });
});
