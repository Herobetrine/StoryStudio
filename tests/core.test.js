import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import {
    buildGenerationRequest,
    buildContextualGenerationRequest,
    compareAndRemoveWorkspaceRecoveryDraft,
    combineFieldPaths,
    continuityView,
    countContentUnits,
    findConflictingPaths,
    fitGenerationBudget,
    isWorkspaceRecoveryDraftIdentity,
    mergeContinuity,
    mergeDirtyPaths,
    mergeProjectDirtyPaths,
    nextPromptCharacterLimit,
    normalizeWorkspaceRecoveryDraft,
    parseStructuredResponse,
    PLAN_SCHEMA,
    DISTILLATION_SCHEMA,
    promptCharacterLimitForContext,
    safeFileName,
    scanWorkspaceRecoveryDrafts,
    selectWorkspaceRecoveryDraft,
    workspaceRecoveryDraftAlreadyApplied,
    workspaceRecoveryDraftCleanupDecision,
    workspaceRecoveryDraftRestorePolicy,
    workspaceRecoveryDraftStorageKey,
    workspaceRecoveryDraftStoragePrefix,
    workspaceRecoveryWriterCollisionAction,
    workspaceAuthorityMutationAllowsView,
} from '../public/core.js';

function createMemoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get length() {
            return values.size;
        },
        key(index) {
            return [...values.keys()][index] ?? null;
        },
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(String(key), String(value));
        },
        removeItem(key) {
            values.delete(key);
        },
    };
}

describe('standalone frontend core compatibility', () => {
    test('counts Han characters and non-Han word runs', () => {
        assert.equal(countContentUnits('修仙 world 2026，开始。'), 6);
    });

    test('recovers structured JSON from a fenced model response', () => {
        assert.deepEqual(parseStructuredResponse('说明\n```json\n{"goal":"入城"}\n```'), { goal: '入城' });
    });

    test('merges continuity entries by category and label', () => {
        const merged = mergeContinuity(
            [{ id: 'one', category: 'item', label: '铜钥匙', detail: '在甲手中', status: 'active', firstSeenChapter: 1, lastTouchedChapter: 1 }],
            { entries: [{ category: 'item', label: '铜钥匙', detail: '转交给乙', status: 'active' }] },
            3,
            () => 'new-id',
        );
        assert.equal(merged.length, 1);
        assert.equal(merged[0].detail, '转交给乙');
        assert.equal(merged[0].lastTouchedChapter, 3);
    });

    test('builds an auditable draft prompt without mutating source data', () => {
        const project = { title: '样本', genre: '玄幻', targetWords: 2_000_000, chapterTargetWords: 3_000, story: { premise: '主角必须离城。' }, chapters: [] };
        const chapter = { number: 1, title: '出城', status: 'planned', card: { goal: '穿过城门' }, content: '' };
        const request = buildGenerationRequest('draft', project, chapter);
        assert.match(request.prompt, /主角必须离城。/);
        assert.match(request.prompt, /穿过城门/);
        assert.match(request.systemPrompt, /只输出可直接采用的正文/);
        assert.equal(request.responseLength, 4_500);
        assert.equal(chapter.content, '');
    });

    test('wraps native structured-output schemas for the generation contract', () => {
        const request = buildGenerationRequest(
            'plan',
            { title: '结构化样本', story: {}, chapters: [] },
            { number: 1, title: '开端', status: 'planned', card: {}, content: '' },
        );
        assert.equal(request.jsonSchema.name, 'story_studio_chapter_plan');
        assert.deepEqual(request.jsonSchema.value, PLAN_SCHEMA);
        assert.equal(request.jsonSchema.strict, true);
    });

    test('fits a shorter segment inside a 4095-token context', () => {
        assert.equal(promptCharacterLimitForContext(4_095), 2_303);
        assert.equal(fitGenerationBudget(4_095, 1_400, 4_500), 2_439);
        assert.equal(fitGenerationBudget(4_095, 3_400, 4_500, { minimumResponseTokens: 512 }), 0);
    });

    test('shrinks a high-token-density prompt before rejecting generation', () => {
        const initialCharacters = promptCharacterLimitForContext(4_095);
        const nextCharacters = nextPromptCharacterLimit(initialCharacters, 4_095, 4_525, 512);
        const reducedTokens = Math.ceil(4_525 * nextCharacters / initialCharacters);
        assert.ok(nextCharacters >= 800);
        assert.ok(nextCharacters < initialCharacters);
        assert.ok(fitGenerationBudget(4_095, reducedTokens, 4_500, { minimumResponseTokens: 512 }) > 0);
    });

    test('continues from the current manuscript tail instead of restarting', () => {
        const request = buildGenerationRequest(
            'draft',
            { title: '续写样本', chapterTargetWords: 3_000, story: {}, chapters: [] },
            {
                number: 2,
                title: '追兵',
                status: 'drafting',
                card: { goal: '逃出城门' },
                content: `BODY_START${'中段'.repeat(4_000)}BODY_END`,
            },
            null,
            { promptCharacterLimit: promptCharacterLimitForContext(4_095) },
        );
        assert.ok(request.prompt.length <= promptCharacterLimitForContext(4_095));
        assert.match(request.prompt, /BODY_END/);
        assert.doesNotMatch(request.prompt, /BODY_START/);
        assert.match(request.prompt, /续写/);
        assert.match(request.prompt, /不要复述、改写或重新开始已有正文/);
    });

    function buildLongManuscriptRequest(kind) {
        const limit = promptCharacterLimitForContext(4_095);
        return {
            limit,
            request: buildGenerationRequest(
                kind,
                { title: '首尾样本', chapterTargetWords: 3_000, story: { premise: '设定'.repeat(10_000) }, chapters: [] },
                {
                    number: 8,
                    title: '兑现',
                    status: 'revising',
                    card: { goal: '完成选择' },
                    content: `BODY_START${'中段'.repeat(5_000)}BODY_END`,
                },
                null,
                { promptCharacterLimit: limit },
            ),
        };
    }

    for (const kind of ['review', 'continuity']) {
        test(`keeps both manuscript ends for ${kind} prompts`, () => {
            const { limit, request } = buildLongManuscriptRequest(kind);
            assert.ok(request.prompt.length <= limit);
            assert.match(request.prompt, /BODY_START/);
            assert.match(request.prompt, /BODY_END/);
            assert.match(request.prompt, /\[中段因上下文预算省略\]/);
        });
    }

    test('keeps current chapter constraints in every prompt mode', () => {
        const repeated = '超长设定'.repeat(20_000);
        const project = {
            title: '上下文优先级样本',
            genre: '玄幻',
            chapterTargetWords: 3_000,
            story: {
                premise: `PREMISE ${repeated}`,
                world: `WORLD_RULE ${repeated}`,
                styleGuide: `STYLE_GUIDE ${repeated}`,
                masterOutline: `MASTER_OUTLINE ${repeated}`,
                forbidden: `FORBIDDEN_RULE ${repeated}`,
            },
            chapters: [],
        };
        const chapter = {
            number: 9,
            title: 'CURRENT_CHAPTER',
            status: 'drafting',
            card: { goal: `CARD_GOAL ${repeated}`, required: `CARD_REQUIRED ${repeated}`, avoid: `CARD_AVOID ${repeated}` },
            content: `BODY_START${'正文'.repeat(10_000)}BODY_END`,
        };
        const limit = promptCharacterLimitForContext(4_095);
        for (const kind of ['plan', 'draft', 'review', 'continuity']) {
            const { prompt } = buildGenerationRequest(kind, project, chapter, null, { promptCharacterLimit: limit });
            for (const marker of ['CURRENT_CHAPTER', 'CARD_GOAL', 'CARD_REQUIRED', 'CARD_AVOID', 'FORBIDDEN_RULE', 'STYLE_GUIDE', 'MASTER_OUTLINE']) {
                assert.match(prompt, new RegExp(marker));
            }
            assert.ok(prompt.length <= limit);
        }
    });

    test('neutralizes SillyTavern-style macros as literal manuscript text', () => {
        const request = buildGenerationRequest(
            'draft',
            { title: '宏隔离样本', story: { premise: '不得展开 {{lastMessage}} 或 {{char}}。' }, chapters: [] },
            {
                number: 1,
                title: '宏隔离',
                status: 'drafting',
                card: { goal: '保留字面文本 {{user}}' },
                content: '正文中的 {{lastMessage}} 也只是文本。',
            },
            null,
            { promptCharacterLimit: 4_000 },
        );
        assert.doesNotMatch(request.prompt, /\{\{(?:lastMessage|char|user)\}\}/);
        assert.match(request.prompt, /lastMessage/);
        assert.match(request.prompt, /char/);
        assert.match(request.prompt, /user/);
    });

    test('includes schemas in prompts and caps total prompt characters', () => {
        const repeated = '设定'.repeat(100_000);
        const project = {
            title: '长上下文样本',
            genre: '玄幻',
            chapterTargetWords: 3_000,
            story: { premise: repeated, world: repeated, masterOutline: repeated },
            chapters: [],
        };
        const chapter = { number: 1, title: '开端', status: 'planned', card: { goal: repeated }, content: repeated };
        const plan = buildGenerationRequest('plan', project, chapter, null, { promptCharacterLimit: 8_000 });
        const continuity = buildGenerationRequest('continuity', project, chapter, null, { promptCharacterLimit: 8_000 });
        assert.match(plan.prompt, /# 输出 JSON Schema/);
        assert.match(plan.prompt, /"goal":\{"type":"string"\}/);
        assert.match(continuity.prompt, /"contradiction"/);
        assert.ok(plan.prompt.length <= 8_000);
        assert.ok(continuity.prompt.length <= 8_000);
    });

    test('assembles active cards, lore, prompt profile, typed state, and next-chapter constraints', () => {
        const request = buildContextualGenerationRequest(
            'draft',
            {
                title: '资源上下文',
                genre: '玄幻',
                chapterTargetWords: 3_000,
                story: { premise: '必须入城。' },
                continuity: [],
                storyState: { promises: [{ id: 'promise-gate', label: '城门之约', status: 'open' }] },
                chapters: [],
            },
            { number: 2, title: '入城', status: 'planned', card: { goal: '越过门槛' }, content: '' },
            { number: 1, title: '城外', status: 'done', card: { summary: '抵达城门' }, content: '铁门缓缓开启。' },
            {
                promptCharacterLimit: 24_000,
                provider: { protocol: 'openai-chat', model: 'writer' },
                nextChapter: { number: 3, title: '审问', card: { goal: '面对守将' } },
                resources: {
                    characters: [{
                        id: 'char-lin',
                        name: '林照',
                        description: '谨慎的主角',
                        instruction: '原系统：{{original}}\n保持冷静。',
                        instructionEnabled: true,
                    }],
                    persona: { id: 'persona-author', name: '作者化身', description: '偏好克制叙事' },
                    lorebooks: [{
                        id: 'lore-city',
                        entries: [{ id: 'gate', keys: ['铁门'], content: '城门只能在日落前开启。', enabled: true, constant: false }],
                    }],
                    promptProfile: {
                        id: 'profile-one',
                        systemPrompt: { enabled: true, content: '基础写作规则。' },
                        generation: { topP: 0.85 },
                    },
                },
            },
        );
        assert.match(request.systemPrompt, /基础写作规则/);
        assert.match(request.systemPrompt, /保持冷静/);
        assert.match(request.prompt, /城门只能在日落前开启/);
        assert.match(request.prompt, /promise-gate/);
        assert.match(request.prompt, /第3章 审问/);
        assert.equal(request.topP, 0.85);
        assert.deepEqual(request.diagnostics.activeCharacterIds, ['char-lin']);
        assert.deepEqual(request.diagnostics.activeLorebookIds, ['lore-city']);
        assert.equal(request.diagnostics.activePromptProfileId, 'profile-one');
        assert.equal(request.diagnostics.activePersonaId, 'persona-author');
        assert.match(request.prompt, /作者化身/);
        assert.equal(request.diagnostics.activatedLore[0].id, 'gate');
    });

    test('sends Profile V2 ordered messages and every supported generation control', () => {
        const request = buildContextualGenerationRequest(
            'draft',
            {
                id: 'project-v2',
                title: 'V2 长篇',
                genre: '科幻',
                story: { premise: '夺回城市' },
                continuity: [],
                storyState: {},
                chapters: [],
            },
            { id: 'chapter-v2', number: 4, title: '回城', status: 'planned', card: { goal: '穿过封锁' }, content: '' },
            null,
            {
                promptCharacterLimit: 24_000,
                provider: { protocol: 'openai-chat', model: 'writer-v2' },
                resources: {
                    promptProfile: {
                        id: 'profile-v2',
                        profileVersion: 2,
                        modules: [
                            { id: 'style', slot: 'main', role: 'system', template: 'PROFILE STYLE' },
                        ],
                        order: ['style'],
                        variables: [],
                        taskPolicies: {},
                        generation: {
                            stop: ['END'],
                            temperature: 0.61,
                            topP: 0.82,
                            topK: 31,
                            topA: 0.12,
                            minP: 0.04,
                            frequencyPenalty: 0.2,
                            presencePenalty: -0.1,
                            repetitionPenalty: 1.07,
                            seed: 7,
                            assistantPrefill: '正文：',
                        },
                    },
                },
            },
        );

        assert.ok(Array.isArray(request.messages));
        assert.match(request.messages[0].content, /成熟的中文网文作者/);
        assert.match(request.messages.find(message => message.content === 'PROFILE STYLE')?.content ?? '', /PROFILE STYLE/);
        assert.match(request.messages.at(-1).content, /请从第4章开头/);
        assert.equal(request.temperature, 0.61);
        assert.equal(request.topP, 0.82);
        assert.equal(request.topK, 31);
        assert.equal(request.topA, 0.12);
        assert.equal(request.minP, 0.04);
        assert.equal(request.frequencyPenalty, 0.2);
        assert.equal(request.presencePenalty, -0.1);
        assert.equal(request.repetitionPenalty, 1.07);
        assert.equal(request.seed, 7);
        assert.deepEqual(request.stop, ['END']);
        assert.equal(request.assistantPrefill, '正文：');
        assert.match(request.profileHash, /^[0-9a-f]{64}$/);
        assert.equal(request.diagnostics.profile.errors.length, 0);
        assert.equal(request.diagnostics.profile.profileHash, request.profileHash);
    });

    test('injects only the chapter current volume in every contextual generation mode', () => {
        const project = {
            title: '卷纲上下文',
            chapterTargetWords: 3_000,
            story: { masterOutline: '全书总纲。' },
            storyState: {},
            continuity: [],
            chapters: [],
            volumes: [
                {
                    id: 'volume-one',
                    title: '第一卷：旧城',
                    goal: 'OTHER_VOLUME_GOAL',
                    outline: 'OTHER_VOLUME_OUTLINE',
                    summary: 'OTHER_VOLUME_SUMMARY',
                },
                {
                    id: 'volume-two',
                    title: '第二卷：天门',
                    goal: 'CURRENT_VOLUME_GOAL',
                    outline: 'CURRENT_VOLUME_OUTLINE',
                    summary: 'CURRENT_VOLUME_SUMMARY',
                },
            ],
        };
        const chapter = {
            id: 'chapter-two',
            volumeId: 'volume-two',
            number: 8,
            title: '登门',
            status: 'drafting',
            card: { goal: '越过天门' },
            content: '林照抵达天门。',
        };
        const kinds = ['plan', 'draft', 'review', 'polish', 'rewrite', 'expand', 'brainstorm', 'continuity', 'distill'];

        for (const kind of kinds) {
            const options = {
                promptCharacterLimit: 24_000,
                provider: { protocol: 'openai-chat' },
                selection: { before: '前文', text: '林照抬头。', after: '后文' },
                sourceContent: '林照推开天门。',
            };
            const directRequest = buildGenerationRequest(kind, project, chapter, null, options);
            assert.match(directRequest.prompt, /CURRENT_VOLUME_OUTLINE/);
            assert.doesNotMatch(directRequest.prompt, /OTHER_VOLUME_(?:GOAL|OUTLINE|SUMMARY)/);

            const request = buildContextualGenerationRequest(kind, project, chapter, null, options);
            assert.match(request.prompt, /# 当前卷纲/);
            assert.match(request.prompt, /第二卷：天门/);
            assert.match(request.prompt, /CURRENT_VOLUME_GOAL/);
            assert.match(request.prompt, /CURRENT_VOLUME_OUTLINE/);
            assert.match(request.prompt, /CURRENT_VOLUME_SUMMARY/);
            assert.doesNotMatch(request.prompt, /OTHER_VOLUME_(?:GOAL|OUTLINE|SUMMARY)/);
            assert.equal(request.diagnostics.currentVolume.id, 'currentVolume');
            assert.equal(request.diagnostics.currentVolume.volumeId, 'volume-two');
            assert.equal(request.diagnostics.currentVolume.source, 'project.volumes');
            assert.equal(request.diagnostics.currentVolume.reason, 'chapter-volume-id');
            assert.equal(request.diagnostics.blocks.currentVolume.included, true);
            assert.ok(request.diagnostics.taskSections.some(section => section.id === 'currentVolume'));
        }
    });

    test('preserves both ends of a critical current-volume plan under prompt pressure', () => {
        const request = buildContextualGenerationRequest(
            'draft',
            {
                title: '卷纲预算',
                chapterTargetWords: 3_000,
                story: {
                    premise: '普通设定'.repeat(8_000),
                    masterOutline: '总纲内容'.repeat(8_000),
                },
                storyState: { memory: [{ id: 'ordinary-state', summary: '普通状态'.repeat(8_000) }] },
                continuity: [],
                chapters: [],
                volumes: [{
                    id: 'volume-budget',
                    title: '预算卷',
                    goal: `VOLUME_GOAL_KEEP ${'目标推进'.repeat(2_000)}`,
                    outline: `VOLUME_OUTLINE_MIDDLE ${'中段卷纲'.repeat(2_000)}`,
                    summary: `${'卷末摘要'.repeat(200)} VOLUME_SUMMARY_TAIL_KEEP`,
                }],
            },
            {
                id: 'chapter-budget',
                volumeId: 'volume-budget',
                number: 20,
                title: '决战',
                status: 'drafting',
                card: { goal: `本章决战 ${'必须执行'.repeat(3_000)}` },
                content: '正文'.repeat(8_000),
            },
            null,
            {
                promptCharacterLimit: 2_400,
                provider: { protocol: 'openai-chat' },
            },
        );

        assert.ok(request.systemPrompt.length + request.prompt.length <= 2_400);
        assert.match(request.prompt, /# 当前卷纲/);
        assert.match(request.prompt, /卷名：预算卷/);
        assert.match(request.prompt, /VOLUME_GOAL_KEEP/);
        assert.match(request.prompt, /VOLUME_SUMMARY_TAIL_KEEP/);
        assert.equal(request.diagnostics.blocks.currentVolume.included, true);
        assert.equal(request.diagnostics.blocks.currentVolume.truncated, true);
        assert.ok(request.diagnostics.blocks.currentVolume.characters > 0);
        assert.ok(request.diagnostics.blocks.currentVolume.tokens > 0);
        assert.ok(request.diagnostics.blocks.currentVolume.characters
            < request.diagnostics.blocks.currentVolume.originalCharacters);
    });

    test('keeps critical contextual task sections when the combined prompt is over budget', () => {
        const repeated = '超长上下文'.repeat(20_000);
        const limit = 4_000;
        const request = buildContextualGenerationRequest(
            'draft',
            {
                title: '关键任务预算',
                chapterTargetWords: 3_000,
                story: { premise: repeated, world: repeated, masterOutline: repeated },
                storyState: {},
                continuity: [],
                chapters: [],
            },
            {
                number: 2,
                title: '追击',
                status: 'drafting',
                card: { goal: repeated, required: repeated, avoid: repeated },
                content: repeated,
            },
            null,
            {
                promptCharacterLimit: limit,
                additionalInstruction: 'INSTRUCTION_MUST_SURVIVE',
                continuationContent: `PARENT_START${'候选正文'.repeat(10_000)}PARENT_END_MUST_SURVIVE`,
                storyState: {
                    entities: [{ id: 'state-head', summary: repeated }],
                    memories: [{ id: 'state-tail', content: 'STORY_STATE_TAIL_MUST_SURVIVE' }],
                },
                resources: { persona: { name: '作者', description: repeated } },
                provider: { protocol: 'openai-chat' },
            },
        );

        assert.ok(request.systemPrompt.length + request.prompt.length <= limit);
        assert.equal(request.diagnostics.blocks.task.truncated, true);
        assert.match(request.prompt, /INSTRUCTION_MUST_SURVIVE/);
        assert.match(request.prompt, /PARENT_END_MUST_SURVIVE/);
        assert.match(request.prompt, /STORY_STATE_TAIL_MUST_SURVIVE/);
    });

    test('scales prompt character budgets with configured context instead of an 8000-character ceiling', () => {
        assert.ok(promptCharacterLimitForContext(32_768) > 8_000);
        const request = buildGenerationRequest(
            'draft',
            {
                title: '长上下文',
                chapterTargetWords: 3_000,
                story: Object.fromEntries([
                    'logline', 'premise', 'protagonist', 'opposition', 'world', 'powerSystem', 'styleGuide', 'masterOutline', 'forbidden',
                ].map(field => [field, `${field}:` + '设定'.repeat(20_000)])),
                chapters: [],
            },
            {
                number: 1,
                title: '开端',
                status: 'planned',
                card: Object.fromEntries([
                    'summary', 'goal', 'conflict', 'turn', 'hook', 'pov', 'time', 'location', 'required', 'avoid',
                ].map(field => [field, `${field}:` + '行动'.repeat(10_000)])),
                content: '',
            },
            null,
            { promptCharacterLimit: 20_000 },
        );
        assert.ok(request.prompt.length > 8_000);
        assert.ok(request.prompt.length <= 20_000);
    });

    test('builds a side-effect-free typed distillation ChangeSet request', () => {
        const request = buildGenerationRequest(
            'distill',
            {
                title: '蒸馏样本',
                story: {},
                storyState: { entities: [{ id: 'char-lin', kind: 'character', name: '林照', summary: '', aliases: [], status: 'active' }] },
                chapters: [],
            },
            { id: 'chapter-one', number: 1, title: '入城', status: 'drafting', card: {}, content: '' },
            null,
            { sourceContent: '林照推开城门，铜钥匙留在他手里。', promptCharacterLimit: 16_000 },
        );
        assert.match(request.prompt, /待蒸馏候选正文/);
        assert.match(request.prompt, /chapter-one/);
        assert.match(request.prompt, /char-lin/);
        assert.match(request.prompt, /人物知识边界/);
        assert.match(request.prompt, /supersede/);
        assert.equal(request.jsonSchema.name, 'story_studio_distillation');
        assert.deepEqual(DISTILLATION_SCHEMA.properties.storyStateChanges.required, [
            'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
        ]);
        const changes = DISTILLATION_SCHEMA.properties.storyStateChanges.properties;
        assert.deepEqual(changes.knowledge.properties.upsert.items.properties.stance.enum, [
            'knows', 'suspects', 'believes', 'denies', 'hides',
        ]);
        assert.equal(changes.facts.properties.upsert.items.properties.confidence.minimum, 0);
        assert.equal(changes.facts.properties.upsert.items.properties.confidence.maximum, 1);
        assert.equal(changes.timeline.properties.upsert.items.properties.sequence.minimum, 0);
        assert.equal(changes.events.properties.upsert.items.properties.progress.maximum, 100);
        assert.equal(changes.promises.properties.upsert.items.properties.urgency.maximum, 5);
    });

    test('injects structured continuity preflight into the final contextual prompt', () => {
        const request = buildContextualGenerationRequest(
            'draft',
            {
                title: '预检样本',
                story: {},
                storyState: {},
                continuity: [],
                chapters: [],
            },
            { id: 'chapter-preflight', number: 2, title: '夜访', status: 'drafting', card: {}, content: '' },
            null,
            {
                promptCharacterLimit: 16_000,
                provider: { protocol: 'openai-chat' },
                continuityPreflight: {
                    status: 'warning',
                    conflicts: [{ code: 'knowledge-boundary', summary: '林照尚不知道密令内容。' }],
                    requirements: ['保持时间线在子夜之后'],
                },
            },
        );
        assert.match(request.prompt, /# 连续性预检/);
        assert.match(request.prompt, /knowledge-boundary/);
        assert.match(request.prompt, /林照尚不知道密令内容/);
        assert.ok(request.diagnostics.taskSections.some(section => section.id === 'continuityPreflight'));
    });

    test('retains continuity preflight as an independent required Profile V2 message under task pressure', () => {
        const repeated = '超长上下文'.repeat(10_000);
        const request = buildContextualGenerationRequest(
            'draft',
            {
                id: 'project-preflight-v2', title: 'V2 预检', story: { premise: repeated },
                storyState: {}, continuity: [], chapters: [], chapterTargetWords: 3_000,
            },
            {
                id: 'chapter-preflight-v2', number: 2, title: '夜访', status: 'drafting',
                card: { goal: repeated }, content: repeated,
            },
            null,
            {
                promptCharacterLimit: 64_000,
                provider: { protocol: 'openai-chat' },
                resources: {
                    promptProfile: {
                        id: 'profile-preflight-v2', profileVersion: 2, characterBudget: 2_000,
                        modules: [{ id: 'style', slot: 'main', role: 'system', template: 'STYLE' }],
                        order: ['style'], variables: [], taskPolicies: {}, generation: {},
                    },
                },
                storyState: { entities: [{ id: 'state', summary: repeated }] },
                continuityPreflight: {
                    status: 'warning',
                    requirements: [{ code: 'PREFLIGHT_MUST_SURVIVE', detail: 'PRECHECK_DETAIL' }],
                },
                additionalInstruction: `AFTER_START${'附加'.repeat(15_000)}AFTER_END`,
                continuationContent: `CONT_START${'续写'.repeat(15_000)}CONT_END`,
            },
        );
        const wire = request.messages.map(message => message.content).join('\n');
        const preflightModule = request.diagnostics.profile.modules
            .find(module => module.id === '__story_studio_continuity_preflight');

        assert.match(wire, /PREFLIGHT_MUST_SURVIVE/);
        assert.match(wire, /PRECHECK_DETAIL/);
        assert.equal(preflightModule.included, true);
        assert.equal(preflightModule.truncated, false);
        assert.equal(request.messages.find(message => message.content.includes('PREFLIGHT_MUST_SURVIVE'))?.role, 'system');
        assert.equal(request.diagnostics.profile.errors.length, 0);
    });

    test('reports a blocking Profile V2 error when the required continuity preflight cannot fit', () => {
        const request = buildContextualGenerationRequest(
            'draft',
            { id: 'project-preflight-error', title: 'V2 预检错误', story: {}, storyState: {}, continuity: [], chapters: [] },
            { id: 'chapter-preflight-error', number: 1, title: '开端', status: 'drafting', card: {}, content: '' },
            null,
            {
                promptCharacterLimit: 64_000,
                provider: { protocol: 'openai-chat' },
                resources: {
                    promptProfile: {
                        id: 'profile-preflight-error', profileVersion: 2, characterBudget: 800,
                        modules: [], order: [], variables: [], taskPolicies: {}, generation: {},
                    },
                },
                continuityPreflight: {
                    status: 'warning',
                    requirements: [{ code: 'OVERSIZED_PREFLIGHT', detail: '秘密'.repeat(2_000) }],
                },
            },
        );

        assert.ok(request.diagnostics.profile.errors.some(error => (
            error.code === 'required_continuity_preflight_missing'
        )));
    });

    for (const kind of ['polish', 'rewrite', 'expand', 'brainstorm']) {
        test(`builds a selection-scoped ${kind} request with surrounding context`, () => {
            const request = buildGenerationRequest(
                kind,
                { title: '选区工具', story: { styleGuide: '短句，有动作。' }, chapters: [] },
                { number: 4, title: '交锋', status: 'drafting', card: { goal: '逼问真相' }, content: '全文不应直接进入选区工具。' },
                null,
                { selection: { before: '前文标记', text: '待处理句子', after: '后文标记' }, promptCharacterLimit: 12_000 },
            );
            assert.match(request.prompt, /前文标记/);
            assert.match(request.prompt, /待处理句子/);
            assert.match(request.prompt, /后文标记/);
            assert.doesNotMatch(request.prompt, /全文不应直接进入选区工具/);
            assert.equal(request.jsonSchema, null);
        });
    }

    test('sanitizes exported file names', () => {
        assert.equal(safeFileName('长篇:第一部?.json'), '长篇_第一部_.json');
    });

    test('normalizes writer-bound recovery drafts while retaining legacy v1 records', () => {
        const writerId = 'writer-one-0000000000000001';
        const draftId = 'draft-one-00000000000000001';
        assert.equal(
            workspaceRecoveryDraftStorageKey('project one', 'chapter/one'),
            'story-studio:workspace-recovery:v1:project%20one:chapter%2Fone',
        );
        assert.equal(
            workspaceRecoveryDraftStorageKey('project one', 'chapter/one', writerId),
            `story-studio:workspace-recovery:v1:project%20one:chapter%2Fone:${writerId}`,
        );
        assert.equal(
            workspaceRecoveryDraftStoragePrefix('project one', 'chapter/one'),
            'story-studio:workspace-recovery:v1:project%20one:chapter%2Fone:',
        );
        assert.equal(isWorkspaceRecoveryDraftIdentity(writerId), true);
        assert.equal(isWorkspaceRecoveryDraftIdentity('short'), false);
        assert.equal(workspaceRecoveryDraftStorageKey('project-one', 'chapter-one', 'bad:id'), '');

        const rawDraft = {
            version: 1,
            writerId,
            draftId,
            projectId: 'project-one',
            projectVersion: 7,
            chapterId: 'chapter-one',
            chapterRevision: 3,
            volumeId: 'volume-one',
            volumeRevision: 2,
            projectDirtyPaths: ['story.premise', 'story.premise', '__proto__.polluted'],
            chapterDirtyPaths: ['content'],
            volumeDirtyFields: ['title'],
            projectChanges: { story: { premise: '本地命题' } },
            chapterChanges: { content: '未保存正文' },
            volumeChanges: { title: '本地卷名' },
            updatedAt: '2026-07-16T00:00:00.000Z',
        };
        const draft = normalizeWorkspaceRecoveryDraft(rawDraft, {
            projectId: 'project-one',
            chapterId: 'chapter-one',
        });
        assert.equal(draft.writerId, writerId);
        assert.equal(draft.draftId, draftId);
        assert.deepEqual(draft.projectDirtyPaths, ['story.premise']);
        assert.deepEqual(draft.chapterDirtyPaths, ['content']);
        assert.deepEqual(draft.volumeDirtyFields, ['title']);
        assert.equal(
            normalizeWorkspaceRecoveryDraft({ ...draft, projectVersion: 0 }),
            null,
        );
        assert.equal(
            normalizeWorkspaceRecoveryDraft(draft, { projectId: 'project-two' }),
            null,
        );
        assert.equal(
            normalizeWorkspaceRecoveryDraft({ ...rawDraft, writerId: 'short' }),
            null,
        );
        const missingDraftId = { ...rawDraft };
        delete missingDraftId.draftId;
        assert.equal(normalizeWorkspaceRecoveryDraft(missingDraftId), null);

        const legacyDraft = { ...rawDraft };
        delete legacyDraft.writerId;
        delete legacyDraft.draftId;
        const normalizedLegacy = normalizeWorkspaceRecoveryDraft(legacyDraft);
        assert.ok(normalizedLegacy);
        assert.equal(Object.hasOwn(normalizedLegacy, 'writerId'), false);
        assert.equal(Object.hasOwn(normalizedLegacy, 'draftId'), false);
    });

    test('scans every same-chapter writer key and prefers the current writer record', () => {
        const ownWriterId = 'writer-own-00000000000000001';
        const foreignWriterId = 'writer-foreign-0000000000001';
        const mismatchedWriterId = 'writer-mismatch-000000000000';
        const baseDraft = {
            version: 1,
            projectId: 'project-one',
            projectVersion: 7,
            chapterId: 'chapter-one',
            chapterRevision: 3,
            volumeId: '',
            volumeRevision: null,
            projectDirtyPaths: [],
            chapterDirtyPaths: ['content'],
            volumeDirtyFields: [],
            projectChanges: {},
            chapterChanges: { content: '未保存正文' },
            volumeChanges: {},
        };
        const ownDraft = {
            ...baseDraft,
            writerId: ownWriterId,
            draftId: 'draft-own-000000000000000001',
            updatedAt: '2026-07-16T00:00:01.000Z',
        };
        const foreignDraft = {
            ...baseDraft,
            writerId: foreignWriterId,
            draftId: 'draft-foreign-00000000000001',
            updatedAt: '2026-07-16T00:00:03.000Z',
        };
        const legacyDraft = {
            ...baseDraft,
            updatedAt: '2026-07-16T00:00:02.000Z',
        };
        const storage = createMemoryStorage({
            [workspaceRecoveryDraftStorageKey('project-one', 'chapter-one', ownWriterId)]: JSON.stringify(ownDraft),
            [workspaceRecoveryDraftStorageKey('project-one', 'chapter-one', foreignWriterId)]: JSON.stringify(foreignDraft),
            [workspaceRecoveryDraftStorageKey('project-one', 'chapter-one')]: JSON.stringify(legacyDraft),
            [workspaceRecoveryDraftStorageKey('project-one', 'chapter-one', mismatchedWriterId)]: JSON.stringify(foreignDraft),
            [workspaceRecoveryDraftStorageKey('project-one', 'chapter-two', ownWriterId)]: JSON.stringify({
                ...ownDraft,
                chapterId: 'chapter-two',
            }),
        });

        const scan = scanWorkspaceRecoveryDrafts(storage, 'project-one', 'chapter-one');
        assert.equal(scan.records.length, 3);
        assert.equal(scan.invalid.length, 1);
        assert.equal(scan.records[0].draft.writerId, foreignWriterId);
        assert.equal(selectWorkspaceRecoveryDraft(scan.records, ownWriterId).draft.writerId, ownWriterId);
        assert.equal(
            selectWorkspaceRecoveryDraft(scan.records, 'writer-new-00000000000000001').draft.writerId,
            foreignWriterId,
        );
    });

    test('auto-restores only an exact draft owned by the current writer', () => {
        const writerId = 'writer-own-00000000000000001';
        const ownDraft = { writerId };
        const foreignDraft = { writerId: 'writer-foreign-0000000000001' };
        const legacyDraft = {};
        assert.equal(
            workspaceRecoveryDraftRestorePolicy(ownDraft, { writerId, exactAuthority: true }),
            'auto',
        );
        assert.equal(
            workspaceRecoveryDraftRestorePolicy(ownDraft, { writerId, exactAuthority: false }),
            'confirm',
        );
        assert.equal(
            workspaceRecoveryDraftRestorePolicy(foreignDraft, { writerId, exactAuthority: true }),
            'confirm',
        );
        assert.equal(
            workspaceRecoveryDraftRestorePolicy(legacyDraft, { writerId, exactAuthority: true }),
            'confirm',
        );
    });

    test('keeps the established earlier writer when duplicated tabs copy its session identity', () => {
        const writerId = 'writer-shared-000000000000001';
        const lowerInstanceId = 'instance-a-00000000000000001';
        const higherInstanceId = 'instance-z-00000000000000001';
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: higherInstanceId,
            established: true,
            startedAt: 100,
            remoteWriterId: writerId,
            remoteInstanceId: lowerInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 200,
        }), 'keep');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: lowerInstanceId,
            established: false,
            startedAt: 200,
            remoteWriterId: writerId,
            remoteInstanceId: higherInstanceId,
            remoteEstablished: true,
            remoteStartedAt: 100,
        }), 'rotate');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: higherInstanceId,
            established: false,
            startedAt: 100,
            remoteWriterId: writerId,
            remoteInstanceId: lowerInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 200,
        }), 'keep');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: lowerInstanceId,
            established: false,
            startedAt: 200,
            remoteWriterId: writerId,
            remoteInstanceId: higherInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 100,
        }), 'rotate');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: higherInstanceId,
            established: false,
            startedAt: 100,
            remoteWriterId: writerId,
            remoteInstanceId: lowerInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 100,
        }), 'rotate');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: lowerInstanceId,
            established: false,
            startedAt: 100,
            remoteWriterId: writerId,
            remoteInstanceId: higherInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 100,
        }), 'keep');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: lowerInstanceId,
            established: true,
            startedAt: 100,
            remoteWriterId: 'writer-other-0000000000000001',
            remoteInstanceId: higherInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 200,
        }), 'ignore');
        assert.equal(workspaceRecoveryWriterCollisionAction({
            writerId,
            instanceId: lowerInstanceId,
            established: true,
            startedAt: 100,
            remoteWriterId: writerId,
            remoteInstanceId: lowerInstanceId,
            remoteEstablished: false,
            remoteStartedAt: 200,
        }), 'ignore');
    });

    test('compare-and-remove preserves drafts changed during save and every foreign writer key', () => {
        const ownKey = workspaceRecoveryDraftStorageKey(
            'project-one',
            'chapter-one',
            'writer-own-00000000000000001',
        );
        const foreignKey = workspaceRecoveryDraftStorageKey(
            'project-one',
            'chapter-one',
            'writer-foreign-0000000000001',
        );
        const storage = createMemoryStorage({
            [ownKey]: 'own-before-save',
            [foreignKey]: 'foreign-before-save',
        });
        const ownAtSaveStart = storage.getItem(ownKey);
        storage.setItem(ownKey, 'own-updated-during-save');
        assert.equal(
            compareAndRemoveWorkspaceRecoveryDraft(storage, ownKey, ownAtSaveStart),
            false,
        );
        assert.equal(storage.getItem(ownKey), 'own-updated-during-save');
        assert.equal(storage.getItem(foreignKey), 'foreign-before-save');

        const foreignAtRestore = storage.getItem(foreignKey);
        storage.setItem(foreignKey, 'foreign-updated-before-authoritative-save');
        assert.equal(
            compareAndRemoveWorkspaceRecoveryDraft(storage, foreignKey, foreignAtRestore),
            false,
        );
        assert.equal(storage.getItem(foreignKey), 'foreign-updated-before-authoritative-save');
        assert.equal(
            compareAndRemoveWorkspaceRecoveryDraft(storage, ownKey, 'own-updated-during-save'),
            true,
        );
        assert.equal(storage.getItem(ownKey), null);
        assert.equal(storage.getItem(foreignKey), 'foreign-updated-before-authoritative-save');
    });

    test('rechecks a CAS-mismatched recovery draft before skipping its storage key', () => {
        const record = { storageKey: 'draft-key', raw: 'already-applied' };
        const updated = { storageKey: 'draft-key', raw: 'new-unsaved-content' };
        assert.equal(workspaceRecoveryDraftCleanupDecision(record, true, null), 'removed');
        assert.equal(workspaceRecoveryDraftCleanupDecision(record, false, updated), 'updated');
        assert.equal(
            workspaceRecoveryDraftCleanupDecision(record, false, { ...record }),
            'skip',
        );
        assert.equal(
            workspaceRecoveryDraftCleanupDecision(
                record,
                false,
                { storageKey: 'another-key', raw: 'new-unsaved-content' },
            ),
            'skip',
        );
    });

    test('detects recovery drafts already persisted by a lifecycle keepalive save', () => {
        const draft = normalizeWorkspaceRecoveryDraft({
            version: 1,
            projectId: 'project-one',
            projectVersion: 7,
            chapterId: 'chapter-one',
            chapterRevision: 3,
            volumeId: 'volume-one',
            volumeRevision: 2,
            projectDirtyPaths: ['story.premise'],
            chapterDirtyPaths: ['content'],
            volumeDirtyFields: ['title'],
            projectChanges: { story: { premise: '本地命题' } },
            chapterChanges: { content: '未保存正文' },
            volumeChanges: { title: '本地卷名' },
        });
        const project = {
            id: 'project-one',
            story: { premise: '本地命题' },
        };
        const chapter = { id: 'chapter-one', content: '未保存正文' };
        const volume = { id: 'volume-one', title: '本地卷名' };
        assert.equal(workspaceRecoveryDraftAlreadyApplied(draft, { project, chapter, volume }), true);
        assert.equal(workspaceRecoveryDraftAlreadyApplied(
            draft,
            { project, chapter: { ...chapter, content: '服务端旧正文' }, volume },
        ), false);
    });

    test('keeps authority-mutating workspaces active while blocking navigation into editable views', () => {
        assert.equal(workspaceAuthorityMutationAllowsView('', 'write'), true);
        assert.equal(workspaceAuthorityMutationAllowsView('workflow', 'workflow'), true);
        assert.equal(workspaceAuthorityMutationAllowsView('workflow', 'write'), false);
        assert.equal(workspaceAuthorityMutationAllowsView('quality', 'resources'), false);
    });

    test('persists authoring recovery synchronously and retries on mobile lifecycle changes', () => {
        const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
        const recoverySource = app.slice(
            app.indexOf('function createWorkspaceRecoveryIdentity'),
            app.indexOf('function qualityChapterPath'),
        );
        assert.match(app, /function persistWorkspaceRecoveryDraft\(/);
        assert.match(app, /window\.sessionStorage\.getItem\(WORKSPACE_RECOVERY_WRITER_STORAGE_KEY\)/);
        assert.match(app, /new globalThis\.BroadcastChannel\(\s*WORKSPACE_RECOVERY_WRITER_CHANNEL_NAME,/);
        assert.match(app, /window\.addEventListener\('storage'/);
        assert.match(app, /workspaceRecoveryWriterCollisionAction\(/);
        assert.match(app, /established:\s*workspaceRecoveryWriterEstablished/);
        assert.match(app, /startedAt:\s*workspaceRecoveryWriterStartedAt/);
        assert.match(app, /workspaceRecoveryWriterEstablished = true;\s*postWorkspaceRecoveryWriterMessage\('claim'\)/);
        assert.match(app, /await workspaceRecoveryWriterLeaseReady;/);
        assert.match(app, /workspaceRecoveryDraftStorageKey\(\s*draft\.projectId,\s*draft\.chapterId,\s*workspaceRecoveryWriterId,/);
        assert.match(app, /window\.localStorage\.setItem\(storageKey,\s*raw\)/);
        assert.match(recoverySource, /scanWorkspaceRecoveryDrafts\(/);
        assert.match(recoverySource, /excludedStorageKeys\.has\(record\.storageKey\)/);
        assert.match(recoverySource, /workspaceRecoveryDraftRestorePolicy\(/);
        assert.match(
            recoverySource,
            /while \(record && workspaceRecoveryDraftAlreadyApplied\(record\.draft,[\s\S]*workspaceRecoveryDraftCleanupDecision\([\s\S]*cleanupDecision === 'updated'[\s\S]*cleanupDecision === 'skip'\) skippedStorageKeys\.add\(record\.storageKey\);[\s\S]*readWorkspaceRecoveryDraft\(project\.id, chapter\.id, skippedStorageKeys\);/,
        );
        assert.match(recoverySource, /foreignDraft[\s\S]*window\.confirm\(confirmationMessage\)/);
        assert.doesNotMatch(recoverySource, /window\.localStorage\.removeItem\(record\.storageKey\)/);
        assert.match(app, /function restoreWorkspaceRecoveryDraft\(/);
        assert.match(app, /restoreWorkspaceRecoveryDraft\(project,\s*chapter\)/);
        const loadChapterSource = app.slice(
            app.indexOf('async function loadChapter('),
            app.indexOf('async function exportProject('),
        );
        assert.match(loadChapterSource, /restoredWorkspaceRecoverySource = null;/);
        assert.match(loadChapterSource, /restoreWorkspaceRecoveryDraft\(state\.project,\s*chapter\)/);
        assert.match(app, /const recoveryDraftAtSaveStart = workspaceRecoveryDraftRecordForWriter\(/);
        assert.match(app, /removeWorkspaceRecoveryDraftRecord\(recoveryDraftAtSaveStart\)/);
        assert.match(app, /const restoredRecoverySourceAtSaveStart = restoredWorkspaceRecoverySource/);
        assert.match(app, /removeWorkspaceRecoveryDraftRecord\(restoredRecoverySourceAtSaveStart\)/);
        assert.match(app, /document\.addEventListener\('visibilitychange'/);
        assert.match(app, /window\.addEventListener\('pagehide',\s*persistLifecycleRecoveryDraft\)/);
        assert.match(app, /keepalive:\s*true/);
        assert.match(
            recoverySource,
            /projectVersion:\s*optimisticTokenFor\(state\.projectBase,\s*state\.project,\s*'version'\)/,
        );
        assert.match(
            recoverySource,
            /revision:\s*optimisticTokenFor\(state\.chapterBase,\s*state\.chapter,\s*'revision'\)/,
        );
    });

    test('guards authority mutations and preserves edits made while refreshed authority is pending', () => {
        const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
        assert.match(app, /beginAuthorityMutation\('workflow'\)/);
        assert.match(app, /beginAuthorityMutation\('quality'\)/);
        assert.match(app, /beginAuthorityMutation\('resources'\)/);
        assert.match(app, /workspaceAuthorityMutationAllowsView\(authorityMutationView\(\),\s*view\)/);
        assert.match(app, /button\.disabled = authorityMutationLocked\(\)/);
        const workflowCommand = app.slice(
            app.indexOf('async function sendWorkflowCommand('),
            app.indexOf('async function cancelWorkflowRun('),
        );
        assert.ok(
            workflowCommand.indexOf("beginAuthorityMutation('workflow')")
                < workflowCommand.indexOf('await enqueueSave()'),
        );

        const workflowRefresh = app.slice(
            app.indexOf('async function refreshWorkflowAuthority('),
            app.indexOf('async function sendWorkflowCommand('),
        );
        assert.match(workflowRefresh, /acceptServerProject\(project\);/);
        assert.match(workflowRefresh, /acceptServerChapter\(chapter\);/);
        assert.match(workflowRefresh, /scheduleAutosave\(\);/);
        assert.doesNotMatch(workflowRefresh, /acceptServer(Project|Chapter)\([^)]*new Set\(\)/);

        const qualityCopy = app.slice(
            app.indexOf('async function copyQualityProfile('),
            app.indexOf('async function previewCurrentChapterQuality('),
        );
        assert.match(qualityCopy, /acceptServerProject\(result\.project\);/);
        assert.doesNotMatch(qualityCopy, /acceptServerProject\([^)]*new Set\(\)/);

        const resourceMutation = app.slice(
            app.indexOf('async function refreshAfterResourceConflict('),
            app.indexOf('async function updateResourceActivation('),
        );
        assert.match(resourceMutation, /acceptServerProject\(project\);/);
        assert.match(resourceMutation, /acceptServerProject\(result\.project\);/);
        assert.doesNotMatch(resourceMutation, /acceptServerProject\([^)]*new Set\(\)/);
    });

    test('keeps the mobile drawer scrim pinned to the viewport', () => {
        const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
        const drawerRule = style.match(/\.ss-drawer-scrim\s*\{([^}]*)\}/)?.[1] ?? '';
        assert.match(drawerRule, /height: 100vh;/);
        assert.match(drawerRule, /height: 100dvh;/);
        assert.doesNotMatch(drawerRule, /height: 100%;/);
    });

    test('merges only locally dirty fields onto a newer remote record', () => {
        const base = { title: '旧标题', genre: '玄幻', story: { premise: '旧命题', world: '旧世界' } };
        const local = { ...structuredClone(base), genre: '科幻', story: { ...base.story, premise: '本地命题' } };
        const remote = { ...structuredClone(base), title: '远端标题', story: { ...base.story, world: '远端世界' } };
        assert.deepEqual(mergeDirtyPaths(remote, local, ['genre', 'story.premise']), {
            title: '远端标题',
            genre: '科幻',
            story: { premise: '本地命题', world: '远端世界' },
        });
        assert.deepEqual(findConflictingPaths(base, remote, local, ['genre', 'story.premise']), []);
    });

    test('preserves queued and in-flight fields while merging a newer authority snapshot', () => {
        const paths = combineFieldPaths(
            new Set(['story.premise']),
            new Set(['title']),
            false,
            null,
        );
        assert.deepEqual([...paths], ['story.premise', 'title']);

        const remoteProject = {
            title: '远端标题',
            story: { premise: '远端命题', outline: '远端总纲' },
        };
        const localProject = {
            title: '保存中的标题',
            story: { premise: '排队中的命题', outline: '本地旧总纲' },
        };
        assert.deepEqual(mergeProjectDirtyPaths(remoteProject, localProject, paths), {
            title: '保存中的标题',
            story: { premise: '排队中的命题', outline: '远端总纲' },
            continuity: [],
        });

        assert.deepEqual(
            mergeDirtyPaths(
                { title: '远端章名', content: '远端正文' },
                { title: '保存中的章名', content: '本地待保存正文' },
                combineFieldPaths([], ['content']),
            ),
            { title: '远端章名', content: '本地待保存正文' },
        );
    });

    test('retains pre-refresh conflict values and optimistic tokens for preserved edits', () => {
        const projectPaths = combineFieldPaths(
            new Set(['story.premise']),
            new Set(['title']),
        );
        const projectBase = {
            id: 'project-1',
            version: 1,
            title: '旧标题',
            story: { premise: '旧命题', outline: '旧总纲' },
            continuity: [],
        };
        const remoteProject = {
            id: 'project-1',
            version: 2,
            title: '远端标题',
            story: { premise: 'Workflow 命题', outline: '远端总纲' },
            continuity: [],
        };
        const localProject = mergeProjectDirtyPaths(remoteProject, {
            ...structuredClone(projectBase),
            title: '保存中的标题',
            story: { ...projectBase.story, premise: '本地命题' },
        }, projectPaths);
        const preservedProjectBase = mergeProjectDirtyPaths(
            remoteProject,
            projectBase,
            combineFieldPaths(projectPaths, ['version']),
        );
        assert.equal(preservedProjectBase.version, 1);
        assert.equal(preservedProjectBase.title, '旧标题');
        assert.equal(preservedProjectBase.story.premise, '旧命题');
        assert.equal(preservedProjectBase.story.outline, '远端总纲');
        assert.deepEqual(
            findConflictingPaths(preservedProjectBase, remoteProject, localProject, projectPaths),
            ['story.premise', 'title'],
        );

        const chapterPaths = combineFieldPaths(
            new Set(['content']),
            new Set(['title']),
        );
        const chapterBase = {
            id: 'chapter-1',
            revision: 1,
            title: '旧章名',
            content: '旧正文',
        };
        const remoteChapter = {
            id: 'chapter-1',
            revision: 2,
            title: '远端章名',
            content: 'Workflow 正文',
        };
        const localChapter = mergeDirtyPaths(remoteChapter, {
            ...chapterBase,
            title: '保存中的章名',
            content: '本地正文',
        }, chapterPaths);
        const preservedChapterBase = mergeDirtyPaths(
            remoteChapter,
            chapterBase,
            combineFieldPaths(chapterPaths, ['revision']),
        );
        assert.equal(preservedChapterBase.revision, 1);
        assert.equal(preservedChapterBase.content, '旧正文');
        assert.equal(preservedChapterBase.title, '旧章名');
        assert.deepEqual(
            findConflictingPaths(preservedChapterBase, remoteChapter, localChapter, chapterPaths),
            ['content', 'title'],
        );
    });

    test('wires in-flight autosave fields into recovery drafts and authority merges', () => {
        const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
        assert.match(app, /projectSavingPaths:\s*new Set\(\)/);
        assert.match(app, /chapterSavingPaths:\s*new Set\(\)/);
        assert.match(app, /volumeSavingFields:\s*new Set\(\)/);
        assert.match(app, /combineFieldPaths\(\s*state\.projectDirtyPaths,\s*state\.projectSavingPaths,/);
        assert.match(app, /mergeProjectAuthoritySnapshot\(\{[\s\S]*relatedPending:\s*preservedVolumes\.size > 0,/);
        assert.match(app, /mergeChapterAuthoritySnapshot\(\{/);
        assert.match(app, /advanceBaseline:\s*advancePreservedBase,/);
        assert.match(app, /classifyConflictPaths\(\{/);

        const flushSource = app.slice(
            app.indexOf('async function flushDirtyImpl('),
            app.indexOf('async function flushDirty('),
        );
        assert.match(flushSource, /beginSaveBatch\(state\.projectDirtyPaths\)/);
        assert.match(flushSource, /beginSaveBatch\(state\.volumeDirtyFields\)/);
        assert.match(flushSource, /beginSaveBatch\(state\.chapterDirtyPaths\)/);
        assert.match(flushSource, /state\.projectDirtyPaths = rollbackSaveBatch\(state\.projectDirtyPaths,\s*dirtyPaths\)/);
        assert.match(flushSource, /state\.volumeDirtyFields = rollbackSaveBatch\(state\.volumeDirtyFields,\s*dirtyFields\)/);
        assert.match(flushSource, /state\.chapterDirtyPaths = rollbackSaveBatch\(state\.chapterDirtyPaths,\s*dirtyPaths\)/);
        assert.match(flushSource, /optimisticTokenFor\(state\.projectBase,\s*state\.project,\s*'version'\)/);
        assert.match(flushSource, /optimisticTokenFor\(state\.volumeBase,\s*volume,\s*'revision'\)/);
        assert.match(flushSource, /optimisticTokenFor\(state\.chapterBase,\s*state\.chapter,\s*'revision'\)/);
        assert.match(flushSource, /buildProjectChanges\(state\.project,\s*dirtyPaths\)/);
        assert.match(flushSource, /buildRecordChanges\(state\.chapter,\s*dirtyPaths\)/);
        assert.equal(
            (flushSource.match(/authorityResponseTokenIsStale\(/g) || []).length,
            5,
        );
        assert.match(
            flushSource,
            /authorityResponseTokenIsStale\(serverProject,\s*state\.project,\s*'version'\)[\s\S]*state\.projectDirtyPaths = rollbackSaveBatch\([\s\S]*resolveProjectConflict\(projectId\)/,
        );
        assert.match(
            flushSource,
            /authorityResponseTokenIsStale\(responseVolume,\s*currentVolume,\s*'revision'\)[\s\S]*state\.volumeDirtyFields = rollbackSaveBatch\([\s\S]*resolveVolumeConflict\(projectId\)/,
        );
        assert.match(
            flushSource,
            /authorityResponseTokenIsStale\(result\.chapter,\s*state\.chapter,\s*'revision'\)[\s\S]*state\.chapterDirtyPaths = rollbackSaveBatch\([\s\S]*resolveChapterConflict\(projectId,\s*chapterId\)/,
        );
        assert.match(app, /acceptServerProject\(remoteProject,\s*state\.projectDirtyPaths,\s*\{\s*advancePreservedBase: true,/);
        assert.match(app, /acceptServerChapter\(remoteChapter,\s*state\.chapterDirtyPaths,\s*\{\s*advancePreservedBase: true,/);

        const chapterConflict = app.slice(
            app.indexOf('async function resolveChapterConflict('),
            app.indexOf('function reconcileVolumeConflict('),
        );
        assert.match(chapterConflict, /\/authority/);
        assert.doesNotMatch(chapterConflict, /Promise\.all\(/);

        const workflowRefresh = app.slice(
            app.indexOf('async function refreshWorkflowAuthority('),
            app.indexOf('async function sendWorkflowCommand('),
        );
        assert.match(workflowRefresh, /\/authority/);
        assert.doesNotMatch(workflowRefresh, /Promise\.all\(/);
        assert.match(workflowRefresh, /hasSavingEdits[\s\S]*setSaveStatus\('保存中', 'saving'\)/);
    });

    test('reports only dirty paths changed differently on both sides', () => {
        const base = { title: '旧标题', genre: '玄幻' };
        const local = { title: '本地标题', genre: '科幻' };
        const remote = { title: '远端标题', genre: '科幻' };
        assert.deepEqual(findConflictingPaths(base, remote, local, ['title', 'genre']), ['title']);
    });

    test('merges edits to different continuity entries without replacing rows', () => {
        const base = {
            continuity: [
                { id: 'a', label: '甲', detail: 'A0', status: 'active' },
                { id: 'b', label: '乙', detail: 'B0', status: 'active' },
            ],
        };
        const local = structuredClone(base);
        local.continuity[1].detail = 'B1';
        const remote = structuredClone(base);
        remote.continuity[0].detail = 'A1';
        const dirtyPaths = ['continuityById.b.detail'];
        assert.deepEqual(findConflictingPaths(continuityView(base), continuityView(remote), continuityView(local), dirtyPaths), []);
        assert.deepEqual(mergeProjectDirtyPaths(remote, local, dirtyPaths).continuity, [
            { id: 'a', label: '甲', detail: 'A1', status: 'active' },
            { id: 'b', label: '乙', detail: 'B1', status: 'active' },
        ]);
    });
});
