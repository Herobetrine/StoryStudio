import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    activateLoreEntries,
    assembleNovelPrompt,
    expandTavernMacros,
} from '../public/prompt-engine.js';

describe('standalone prompt compatibility engine', () => {
    test('expands only whitelisted Tavern and novel macros without recursion', () => {
        const result = expandTavernMacros(
            '{{user}}/{{char}}/{{group}}/{{projectTitle}}/{{chapterNumber}}/{{chapterPlan}}/{{unknown}}',
            {
                user: '作者',
                char: '顾野',
                group: ['顾野', '沈灯'],
                projectTitle: '盗火者',
                chapterNumber: 7,
                chapterPlan: { goal: '入城 {{char}}' },
            },
        );

        assert.equal(
            result.text,
            '作者/顾野/顾野, 沈灯/盗火者/7/{\n  "goal": "入城 {{char}}"\n}/{{unknown}}',
        );
        assert.deepEqual(result.warnings.map(item => [item.code, item.macro]), [['unknown_macro', 'unknown']]);
    });

    test('implements all four selective logics and constant activation', () => {
        const entries = [
            { id: 'constant', constant: true, content: '恒定', order: 5, position: 'before' },
            { id: 'and-any', key: ['城门'], keysecondary: ['守卫', '雨'], selectiveLogic: 0, content: '任一', order: 10, position: 0 },
            { id: 'not-all', key: ['城门'], keysecondary: ['守卫', '太阳'], selectiveLogic: 1, content: '非全', order: 20, position: 1 },
            { id: 'not-any', key: ['城门'], keysecondary: ['龙', '凤'], selectiveLogic: 2, content: '全无', order: 30, position: 'after' },
            { id: 'and-all', key: ['城门'], keysecondary: ['守卫', '雨'], selectiveLogic: 3, content: '全有', order: 40, position: 4, depth: 2 },
        ];
        const result = activateLoreEntries(entries, '雨夜，守卫站在城门前。', { characterBudget: 100 });

        assert.deepEqual(result.activated.map(entry => entry.id), ['constant', 'and-any', 'not-all', 'not-any', 'and-all']);
        assert.deepEqual(result.byPosition.before.map(entry => entry.id), ['constant', 'and-any']);
        assert.deepEqual(result.byPosition.after.map(entry => entry.id), ['not-all', 'not-any']);
        assert.deepEqual(result.byPosition.atDepth.map(entry => entry.id), ['and-all']);
    });

    test('respects depth, case, whole-word matching, order, and character budget', () => {
        const entries = [
            { id: 'old', key: ['DRAGON'], scanDepth: 1, caseSensitive: true, content: '旧消息不应命中', order: 300 },
            { id: 'case-miss', key: ['FIRE'], caseSensitive: true, content: '大小写不符', order: 250 },
            { id: 'whole-miss', key: ['cat'], matchWholeWords: true, content: '整词不符', order: 200 },
            { id: 'high', key: ['fire'], content: 'HIGH', order: 100, position: 'before' },
            { id: 'low', key: ['fire'], content: 'LOWER', order: 1, position: 'before' },
        ];
        const original = structuredClone(entries);
        const result = activateLoreEntries(entries, ['fire catalog', 'DRAGON'], { characterBudget: 5 });

        assert.deepEqual(result.activated.map(entry => entry.id), ['high']);
        assert.deepEqual(Object.fromEntries(result.skipped.map(item => [item.id, item.reason])), {
            old: 'primary_miss',
            'case-miss': 'primary_miss',
            'whole-miss': 'primary_miss',
            low: 'budget',
        });
        assert.equal(result.usedCharacters, 4);
        assert.deepEqual(entries, original);
    });

    test('honors probability zero deterministically without pretending to sample intermediate values', () => {
        const result = activateLoreEntries([
            { id: 'never', constant: true, content: '不应激活', useProbability: true, probability: 0 },
            { id: 'probability-disabled', constant: true, content: '应激活', useProbability: false, probability: 0 },
            { id: 'intermediate', constant: true, content: '保守激活', useProbability: true, probability: 50 },
        ], '');

        assert.deepEqual(result.activated.map(entry => entry.id), ['probability-disabled', 'intermediate']);
        assert.deepEqual(result.skipped.map(item => [item.id, item.reason]), [['never', 'probability_zero']]);
    });

    test('assembles blocks in the fixed writing order and keeps lore/manuscript macros literal', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'MAIN {{projectTitle}} {{char}}',
            baseSections: {
                worldBefore: 'WORLD_BEFORE',
                persona: 'PERSONA',
                character: 'CHARACTER',
                scenario: 'SCENARIO',
                worldAfter: 'WORLD_AFTER',
                examples: 'EXAMPLES',
                chapter: 'CHAPTER',
                ledger: 'LEDGER',
                task: 'TASK {{chapterNumber}}',
                postInstruction: 'POST',
            },
            project: {
                title: '样本书',
                genre: '玄幻',
                chapterTargetWords: 3_000,
                story: { premise: '离城' },
                continuity: [{ label: '钥匙', detail: '在顾野手中' }],
            },
            chapter: {
                number: 3,
                title: '夜门',
                card: { pov: '顾野', goal: '出城' },
                content: '已有正文 {{char}}，城门将开。',
            },
            previousChapter: { number: 2, title: '追兵', content: '追兵逼近。' },
            resources: {
                persona: { name: '叙述者', description: '冷峻书写 {{char}}' },
                character: { name: '顾野', description: '{{user}}笔下的负伤少年', personality: '克制', mes_example: '{{char}}：走。' },
                userName: '作者',
                loreEntries: [
                    { id: 'before', key: ['城门'], content: '前置世界书 {{char}}', position: 'before', order: 10 },
                    { id: 'after', constant: true, content: '后置世界书', position: 'after', order: 20 },
                ],
                task: '续写第{{chapterNumber}}章',
                postInstruction: '只输出正文',
                loreCharacterBudget: 100,
            },
            provider: { model: 'writer-model', transport: 'chat' },
            promptLimit: 8_000,
        });

        assert.equal(result.systemPrompt, 'MAIN 样本书 顾野');
        const markers = ['WORLD_BEFORE', 'PERSONA', 'CHARACTER', 'SCENARIO', 'WORLD_AFTER', 'EXAMPLES', 'CHAPTER', 'LEDGER', 'TASK 3', 'POST'];
        for (let index = 1; index < markers.length; index++) {
            assert.ok(result.prompt.indexOf(markers[index - 1]) < result.prompt.indexOf(markers[index]));
        }
        assert.match(result.prompt, /前置世界书 \{\{char\}\}/);
        assert.match(result.prompt, /已有正文 \{\{char\}\}/);
        assert.match(result.prompt, /冷峻书写 顾野/);
        assert.match(result.prompt, /作者笔下的负伤少年/);
        assert.match(result.prompt, /顾野：走。/);
        assert.match(result.prompt, /续写第3章/);
        assert.deepEqual(result.diagnostics.activatedLore.map(entry => entry.id), ['before', 'after']);
        assert.equal(result.diagnostics.totalCharacters, result.systemPrompt.length + result.prompt.length);
        assert.equal(result.serializedPrompt, null);
    });

    test('applies character prompt overrides with original exactly once', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'BASE {{projectTitle}}',
            project: { title: '原始系统', story: {} },
            chapter: { number: 1, title: '开篇', card: {} },
            resources: {
                character: {
                    name: '主角',
                    system_prompt: 'CARD [{{original}}] {{unknown}}',
                },
            },
        });

        assert.equal(result.systemPrompt, 'CARD [BASE 原始系统] {{unknown}}');
        assert.deepEqual(result.diagnostics.warnings.filter(item => item.code === 'unknown_macro').map(item => item.macro), ['unknown']);
    });

    test('serializes instruct sequences only for text transport', () => {
        const common = {
            baseSystemPrompt: 'SYSTEM',
            baseSections: { task: { content: 'USER TASK', includeData: false } },
            project: {},
            chapter: {},
            resources: {},
            provider: {
                instruct: {
                    enabled: true,
                    wrap: true,
                    system_sequence: '<SYS>',
                    input_sequence: '<USER>',
                    output_sequence: '<ASSISTANT>',
                },
            },
        };
        const chat = assembleNovelPrompt({ ...common, provider: { ...common.provider, transport: 'chat' } });
        const text = assembleNovelPrompt({ ...common, provider: { ...common.provider, transport: 'text' } });

        assert.equal(chat.serializedPrompt, null);
        assert.doesNotMatch(chat.prompt, /<USER>|<ASSISTANT>/);
        assert.ok(chat.diagnostics.warnings.some(item => item.code === 'instruct_ignored_for_chat'));
        assert.match(text.serializedPrompt, /^<SYS>\nSYSTEM\n<USER>\n/);
        assert.match(text.serializedPrompt, /USER TASK\n<ASSISTANT>$/);
    });

    test('is deterministic and enforces the combined character limit', () => {
        const input = {
            baseSystemPrompt: `SYSTEM ${'规'.repeat(500)}`,
            baseSections: { task: `TASK ${'写'.repeat(500)}`, postInstruction: `POST ${'止'.repeat(500)}` },
            project: { title: '预算样本', story: { world: '界'.repeat(1_000) }, continuity: [] },
            chapter: { number: 9, title: '预算', card: { goal: '行'.repeat(1_000) }, content: `START${'文'.repeat(1_000)}END` },
            resources: {
                loreEntries: [
                    { id: 'b', constant: true, content: 'B'.repeat(80), order: 20, position: 'before' },
                    { id: 'a', constant: true, content: 'A'.repeat(80), order: 10, position: 'before' },
                ],
                loreCharacterBudget: 100,
            },
            promptLimit: 800,
        };
        const first = assembleNovelPrompt(input);
        const second = assembleNovelPrompt(input);

        assert.deepEqual(first, second);
        assert.ok(first.systemPrompt.length + first.prompt.length <= 800);
        assert.deepEqual(first.diagnostics.activatedLore.map(entry => entry.id), ['b']);
        assert.ok(first.diagnostics.warnings.some(item => item.code === 'section_truncated'));
    });

    test('compiles Profile V2 into ordered messages while preserving runtime and task contracts', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'RUNTIME CONTRACT',
            project: { id: 'project-one', title: '消息顺序', story: { premise: '必须入城' } },
            chapter: { id: 'chapter-one', number: 1, title: '城门', card: { goal: '入城' } },
            resources: {
                taskKind: 'draft',
                task: 'WRITE CURRENT CHAPTER',
                character: { name: '林照', system_prompt: 'CHARACTER INSTRUCTION' },
                continuityLedger: [{ label: '钥匙', detail: '仍在手中' }],
                promptProfile: {
                    id: 'profile-v2',
                    profileVersion: 2,
                    systemPrompt: { enabled: true, content: 'PROFILE SYSTEM' },
                    modules: [
                        { id: 'style', slot: 'main', role: 'system', template: 'STYLE {{project.title}}' },
                        { id: 'task-anchor', slot: 'task', role: 'system', template: 'TASK ANCHOR', marker: true },
                        { id: 'ledger', slot: 'ledger', role: 'system', template: 'LEDGER', includeData: true },
                    ],
                    order: ['style', 'task-anchor', 'ledger'],
                    variables: [],
                    taskPolicies: {
                        draft: {
                            order: ['task-anchor', 'style', 'ledger'],
                            generation: { topP: 0.8 },
                        },
                    },
                    generation: { temperature: 0.6, topA: 0.1 },
                },
            },
            provider: { protocol: 'openai-chat', model: 'writer', transport: 'chat' },
            promptLimit: 12_000,
        });

        assert.deepEqual(result.messages.map(message => message.role), [
            'system', 'system', 'system', 'user', 'user', 'system', 'system',
        ]);
        assert.match(result.messages[0].content, /RUNTIME CONTRACT/);
        assert.match(result.messages[1].content, /PROFILE SYSTEM/);
        assert.match(result.messages[2].content, /CHARACTER INSTRUCTION/);
        assert.match(result.messages[3].content, /# 角色描述/);
        assert.match(result.messages[4].content, /WRITE CURRENT CHAPTER/);
        assert.match(result.messages[5].content, /STYLE 消息顺序/);
        assert.match(result.messages[6].content, /钥匙/);
        assert.equal(result.messages.filter(message => message.content.includes('WRITE CURRENT CHAPTER')).length, 1);
        assert.deepEqual(result.generation, { temperature: 0.6, topA: 0.1, topP: 0.8 });
        assert.match(result.profileHash, /^[0-9a-f]{64}$/);
        assert.equal(result.diagnostics.profile.errors.length, 0);
        assert.equal(result.diagnostics.profile.taskPolicy, 'draft');
        assert.deepEqual(result.diagnostics.sectionOrder.slice(0, 4), [
            '__story_studio_runtime',
            '__story_studio_profile_system',
            '__story_studio_character_instruction',
            '__story_studio_context',
        ]);
    });

    test('reports unsupported Profile V2 generation fields instead of dropping them silently', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'RUNTIME',
            resources: {
                task: 'TASK',
                promptProfile: {
                    profileVersion: 2,
                    modules: [],
                    order: [],
                    variables: [],
                    taskPolicies: {},
                    generation: { imaginarySampler: 42 },
                },
            },
        });

        assert.deepEqual(result.diagnostics.profile.errors.map(item => item.code), ['unsupported_generation_parameter']);
        assert.equal(result.diagnostics.profile.errors[0].field, 'imaginarySampler');
    });

    test('retains both ends of the required V2 task instead of rejecting a long context', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'RUNTIME CONTRACT',
            project: { title: '长上下文', story: { premise: '界'.repeat(20_000) } },
            chapter: { number: 9, title: '压力', card: { goal: '行'.repeat(10_000) } },
            resources: {
                task: `TASK_START${'文'.repeat(20_000)}TASK_END`,
                promptProfile: {
                    profileVersion: 2,
                    modules: [{ id: 'style', slot: 'main', role: 'system', template: 'STYLE' }],
                    order: ['style'],
                    variables: [],
                    taskPolicies: {},
                    generation: {},
                },
            },
            promptLimit: 4_000,
        });

        assert.deepEqual(result.diagnostics.profile.errors, []);
        assert.ok(result.diagnostics.totalCharacters <= 4_000);
        const taskMessage = result.messages.find(message => message.content.includes('TASK_START'));
        assert.ok(taskMessage);
        assert.match(taskMessage.content, /TASK_END$/);
        assert.ok(result.diagnostics.profile.warnings.some(item => (
            item.code === 'module_clipped' && item.moduleId === '__story_studio_task'
        )));
    });

    test('uses user instruct sequences for V2 system messages when system_same_as_user is enabled', () => {
        const result = assembleNovelPrompt({
            baseSystemPrompt: 'RUNTIME',
            resources: {
                task: 'TASK',
                promptProfile: {
                    profileVersion: 2,
                    modules: [],
                    order: [],
                    variables: [],
                    taskPolicies: {},
                    generation: {},
                },
            },
            provider: {
                transport: 'text',
                instruct: {
                    enabled: true,
                    system_same_as_user: true,
                    wrap: true,
                    system_sequence: '<SYSTEM>',
                    system_suffix: '</SYSTEM>',
                    input_sequence: '<USER>',
                    input_suffix: '</USER>',
                    output_sequence: '<ASSISTANT>',
                },
            },
        });

        assert.match(result.serializedPrompt, /^<USER>\nRUNTIME<\/USER>/);
        assert.doesNotMatch(result.serializedPrompt, /<SYSTEM>/);
        assert.match(result.serializedPrompt, /<ASSISTANT>$/);
    });
});
