import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import {
    buildGenerationRequest,
    buildContextualGenerationRequest,
    continuityView,
    countContentUnits,
    findConflictingPaths,
    fitGenerationBudget,
    mergeContinuity,
    mergeDirtyPaths,
    mergeProjectDirtyPaths,
    nextPromptCharacterLimit,
    parseStructuredResponse,
    PLAN_SCHEMA,
    DISTILLATION_SCHEMA,
    promptCharacterLimitForContext,
    safeFileName,
} from '../public/core.js';

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
