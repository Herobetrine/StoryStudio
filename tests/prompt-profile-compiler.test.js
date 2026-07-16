import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    compilePromptProfile,
    estimatePromptTokens,
} from '../public/prompt-profile-compiler.js';

function profile(overrides = {}) {
    return {
        profileVersion: 2,
        id: 'writer-v2',
        name: 'Writer V2',
        variables: [
            { id: 'strict', type: 'boolean', default: false },
            { id: 'tone', type: 'single', options: ['cold', 'warm'], default: 'cold' },
            { id: 'beats', type: 'multi', options: ['action', 'dialogue', 'reveal'], default: ['action'] },
            { id: 'targetWords', type: 'number', min: 100, max: 5_000, default: 2_000 },
            { id: 'instruction', type: 'text', default: '只输出正文' },
        ],
        variableValues: { tone: 'warm' },
        generation: { temperature: 0.8, topP: 0.9, seed: 7 },
        generationPolicies: {
            balanced: { temperature: 0.7, topK: 40 },
        },
        taskPolicies: {
            draft: {
                generationPolicy: 'balanced',
                generation: { topP: 0.95 },
                variables: { strict: true, targetWords: 3_000 },
            },
        },
        modules: [
            {
                id: 'task',
                name: 'Task',
                slot: 'task',
                role: 'user',
                template: '{{instruction}}；目标 {{targetWords}} 字；节拍 {{beats}}。',
                priority: 100,
                sourceRef: { version: '1.0', source: 'builtin' },
            },
            {
                id: 'style',
                name: 'Style',
                slot: 'style',
                role: 'system',
                template: '使用 {{tone}} 语调。',
                enabled: true,
                priority: 20,
                tokenBudget: 100,
                clipPolicy: 'head',
                requires: [],
                conflicts: [],
                exclusiveGroup: 'tone',
                when: { variable: 'strict', equals: true },
            },
        ],
        order: ['style', 'task'],
        ...overrides,
    };
}

describe('Prompt Profile V2 compiler', () => {
    test('normalizes modules, resolves every variable type, applies explicit order, and merges task policy', () => {
        const result = compilePromptProfile(profile(), {
            task: 'draft',
            variables: { beats: ['dialogue', 'reveal'], instruction: '续写当前场景' },
            generation: { seed: 11 },
        });

        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.variables, {
            beats: ['dialogue', 'reveal'],
            instruction: '续写当前场景',
            strict: true,
            targetWords: 3_000,
            tone: 'warm',
        });
        assert.deepEqual(result.generation, {
            seed: 11,
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
        });
        assert.deepEqual(result.modules.map(item => item.id), ['style', 'task']);
        assert.deepEqual(result.messages, [
            { role: 'system', content: '使用 warm 语调。' },
            { role: 'user', content: '续写当前场景；目标 3000 字；节拍 dialogue, reveal。' },
        ]);
        assert.deepEqual(
            Object.keys(result.modules[0]),
            [
                'id', 'name', 'slot', 'role', 'template', 'includeData', 'marker', 'enabled', 'priority', 'tokenBudget',
                'clipPolicy', 'requires', 'conflicts', 'exclusiveGroup', 'when', 'sourceRef',
                'content', 'originalCharacters', 'characters', 'originalTokens', 'tokens', 'clipped',
            ],
        );
        assert.match(result.profileHash, /^[a-f0-9]{64}$/);
        assert.deepEqual(compilePromptProfile(profile(), {
            task: 'draft',
            variables: { instruction: '续写当前场景', beats: ['dialogue', 'reveal'] },
            generation: { seed: 11 },
        }), result);
    });

    test('injects marker and includeData slot values as literal data and exposes complete diagnostics', () => {
        const value = profile({
            variables: [{ id: 'tone', type: 'text', default: 'cold' }],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            modules: [
                {
                    id: 'main',
                    slot: 'main',
                    role: 'system',
                    template: 'SYSTEM {{tone}}',
                    includeData: true,
                },
                {
                    id: 'lore',
                    slot: 'worldBefore',
                    role: 'system',
                    template: '',
                    marker: true,
                },
                {
                    id: 'notes',
                    slot: 'custom',
                    role: 'user',
                    template: 'NOTES',
                    includeData: true,
                },
                {
                    id: 'plain',
                    slot: 'chapter',
                    role: 'user',
                    template: 'PLAIN',
                },
            ],
            order: ['main', 'lore', 'notes', 'plain'],
        });

        const result = compilePromptProfile(value, {
            slotValues: {
                main: 'CANON {{tone}}',
                worldBefore: ['LORE A', 'LORE B'],
                chapter: 'MUST NOT BE INCLUDED',
                custom: { notes: 'CUSTOM NOTES' },
            },
        });

        assert.deepEqual(result.messages, [
            { role: 'system', content: 'SYSTEM cold\n\nCANON {{tone}}' },
            { role: 'system', content: 'LORE A\n\nLORE B' },
            { role: 'user', content: 'NOTES\n\nCUSTOM NOTES' },
            { role: 'user', content: 'PLAIN' },
        ]);
        assert.deepEqual(result.modules.map(item => [item.id, item.includeData, item.marker]), [
            ['main', true, false],
            ['lore', false, true],
            ['notes', true, false],
            ['plain', false, false],
        ]);
        for (const diagnostic of result.diagnostics.modules) {
            assert.equal(typeof diagnostic.originalCharacters, 'number');
            assert.equal(typeof diagnostic.compiledCharacters, 'number');
            assert.equal(typeof diagnostic.included, 'boolean');
            assert.equal(typeof diagnostic.truncated, 'boolean');
            assert.ok(Object.hasOwn(diagnostic, 'reason'));
        }
        assert.deepEqual(result.diagnostics.modules.map(item => ({
            id: item.id,
            included: item.included,
            truncated: item.truncated,
            reason: item.reason,
            originalCharacters: item.originalCharacters,
            compiledCharacters: item.compiledCharacters,
        })), result.modules.map(item => ({
            id: item.id,
            included: true,
            truncated: false,
            reason: null,
            originalCharacters: item.originalCharacters,
            compiledCharacters: item.characters,
        })));
    });

    test('supports a structured condition DSL and never evaluates string or EJS conditions', () => {
        delete globalThis.__promptProfileExecuted;
        const value = profile({
            variables: [
                { id: 'mode', type: 'single', options: ['draft', 'review'], default: 'draft' },
                { id: 'tags', type: 'multi', options: ['urgent', 'quiet'], default: ['urgent'] },
            ],
            variableValues: {},
            modules: [
                {
                    id: 'valid',
                    template: 'VALID',
                    when: {
                        all: [
                            { variable: 'mode', operator: 'equals', value: 'draft' },
                            { variable: 'tags', includes: 'urgent' },
                            { not: { variable: 'mode', equals: 'review' } },
                        ],
                    },
                },
                {
                    id: 'js',
                    template: 'JS',
                    when: 'globalThis.__promptProfileExecuted = true',
                },
                {
                    id: 'ejs',
                    template: 'EJS',
                    when: { expression: '<%= process.exit() %>' },
                },
            ],
            order: ['valid', 'js', 'ejs'],
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
        });

        const result = compilePromptProfile(value);
        assert.deepEqual(result.modules.map(item => item.id), ['valid']);
        assert.equal(globalThis.__promptProfileExecuted, undefined);
        assert.deepEqual(result.errors.map(item => item.code), ['invalid_condition', 'invalid_condition']);
    });

    test('validates dependencies and deterministically resolves conflicts and exclusive groups', () => {
        const value = profile({
            variables: [],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            modules: [
                { id: 'base', template: 'BASE', priority: 10 },
                { id: 'dependent', template: 'DEPENDENT', requires: ['missing'], priority: 100 },
                { id: 'conflict-low', template: 'LOW', conflicts: ['base'], priority: 1 },
                { id: 'first-pov', template: 'FIRST', exclusiveGroup: 'pov', priority: 5 },
                { id: 'third-pov', template: 'THIRD', exclusiveGroup: 'pov', priority: 20 },
            ],
            order: ['base', 'dependent', 'conflict-low', 'first-pov', 'third-pov'],
        });

        const result = compilePromptProfile(value);
        assert.deepEqual(result.modules.map(item => item.id), ['base', 'third-pov']);
        assert.deepEqual(result.errors.map(item => item.code), [
            'module_conflict',
            'exclusive_group_conflict',
            'missing_module_dependency',
        ]);
        assert.deepEqual(
            result.diagnostics.modules.filter(item => !item.included).map(item => [item.id, item.reason]),
            [
                ['dependent', 'missing_dependency'],
                ['conflict-low', 'conflict'],
                ['first-pov', 'exclusive_group'],
            ],
        );
    });

    test('applies per-module token limits and combined token/character budgets by priority', () => {
        const value = profile({
            variables: [],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            tokenBudget: 10,
            characterBudget: 30,
            modules: [
                { id: 'low', template: 'l'.repeat(20), priority: 1, clipPolicy: 'drop' },
                { id: 'high', template: '高'.repeat(20), priority: 100, tokenBudget: 7, clipPolicy: 'head' },
                { id: 'middle', template: '0123456789ABCDEFGHIJ', priority: 50, clipPolicy: 'middle' },
            ],
            order: ['low', 'middle', 'high'],
        });

        const result = compilePromptProfile(value);
        assert.deepEqual(result.modules.map(item => item.id), ['middle', 'high']);
        assert.equal(result.modules.at(-1).content, '高'.repeat(6));
        assert.ok(result.modules[0].content.includes('\n...\n'));
        assert.ok(result.modules.reduce((sum, item) => sum + item.characters, 0) <= 30);
        assert.ok(result.modules.reduce((sum, item) => sum + item.tokens, 0) <= 10);
        assert.ok(result.warnings.some(item => item.code === 'module_clipped' && item.moduleId === 'high'));
        assert.ok(result.warnings.some(item => item.code === 'module_dropped' && item.moduleId === 'low'));
    });

    test('implements every clip policy and independently enforces the character budget', () => {
        const value = profile({
            variables: [],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            modules: [
                { id: 'head', template: 'ABCDEFGHIJ', tokenBudget: 2, clipPolicy: 'head' },
                { id: 'tail', template: 'ABCDEFGHIJ', tokenBudget: 2, clipPolicy: 'tail' },
                { id: 'middle', template: 'ABCDEFGHIJ', tokenBudget: 2, clipPolicy: 'middle' },
                { id: 'drop', template: 'ABCDEFGHIJ', tokenBudget: 2, clipPolicy: 'drop' },
                { id: 'error', template: 'ABCDEFGHIJ', tokenBudget: 2, clipPolicy: 'error' },
            ],
            order: ['head', 'tail', 'middle', 'drop', 'error'],
        });

        const result = compilePromptProfile(value);
        assert.deepEqual(result.modules.map(item => item.id), ['head', 'tail', 'middle']);
        assert.equal(result.modules.find(item => item.id === 'head').content, 'ABCD');
        assert.equal(result.modules.find(item => item.id === 'tail').content, 'GHIJ');
        assert.match(result.modules.find(item => item.id === 'middle').content, /\.\.\./);
        assert.ok(result.errors.some(item => item.code === 'module_budget_exceeded' && item.moduleId === 'error'));

        const characterLimited = compilePromptProfile(profile({
            variables: [],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            modules: [{ id: 'only', template: '0123456789', clipPolicy: 'tail' }],
            order: ['only'],
        }), { characterBudget: 4 });
        assert.equal(characterLimited.modules[0].content, '6789');
        assert.equal(characterLimited.diagnostics.budgets.usedCharacters, 4);
        assert.equal(characterLimited.diagnostics.modules[0].truncated, true);
    });

    test('reports invalid overrides and order entries instead of silently accepting them', () => {
        const value = profile({ order: ['unknown', 'task', 'task'] });
        const result = compilePromptProfile(value, {
            task: 'missing-task',
            variables: { strict: 'yes', tone: 'purple', unknown: true },
        });

        assert.ok(result.errors.some(item => item.code === 'invalid_variable_value' && item.variableId === 'strict'));
        assert.ok(result.errors.some(item => item.code === 'invalid_variable_value' && item.variableId === 'tone'));
        assert.ok(result.errors.some(item => item.code === 'unknown_variable' && item.variableId === 'unknown'));
        assert.ok(result.errors.some(item => item.code === 'unknown_order_module' && item.moduleId === 'unknown'));
        assert.ok(result.errors.some(item => item.code === 'duplicate_order_module' && item.moduleId === 'task'));
        assert.ok(result.warnings.some(item => item.code === 'unknown_task_policy'));
        assert.ok(result.warnings.some(item => item.code === 'module_missing_from_order' && item.moduleId === 'style'));
    });

    test('rejects ambiguous condition objects and validates module-only fields and references', () => {
        const value = profile({
            variables: [{ id: 'enabled', type: 'boolean', default: true }],
            variableValues: {},
            generation: {},
            generationPolicies: {},
            taskPolicies: {},
            modules: [
                {
                    id: 'ambiguous',
                    template: 'MUST NOT COMPILE',
                    when: { all: [{ variable: 'enabled', equals: true }], expression: '<%= run() %>' },
                },
                {
                    id: 'invalid-fields',
                    template: 'VALID TEXT',
                    includeData: 'yes',
                    marker: 1,
                    conflicts: ['ghost'],
                },
            ],
            order: ['ambiguous', 'invalid-fields'],
        });

        const result = compilePromptProfile(value);
        assert.deepEqual(result.modules.map(item => item.id), ['invalid-fields']);
        assert.ok(result.errors.some(item => item.code === 'invalid_condition' && item.moduleId === 'ambiguous'));
        assert.ok(result.errors.some(item => item.code === 'invalid_module_include_data' && item.moduleId === 'invalid-fields'));
        assert.ok(result.errors.some(item => item.code === 'invalid_module_marker' && item.moduleId === 'invalid-fields'));
        assert.ok(result.errors.some(item => item.code === 'unknown_module_conflict' && item.moduleId === 'invalid-fields'));
    });

    test('accepts every known generation field at its strict boundary', () => {
        const generation = {
            temperature: 2,
            topP: 1,
            topK: 100_000,
            topA: 1,
            minP: 0,
            frequencyPenalty: -2,
            presencePenalty: 2,
            repetitionPenalty: 10,
            seed: 2_147_483_647,
            contextTokens: 2_000_000,
            maxTokens: 200_000,
            stop: Array.from({ length: 16 }, (_, index) => `STOP-${index}`),
            assistantPrefill: 'x'.repeat(100_000),
        };
        const result = compilePromptProfile(profile({
            generation,
            generationPolicies: {},
            taskPolicies: {},
        }));

        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.generation, generation);
    });

    test('rejects every invalid known generation value without silently replacing it', () => {
        const cases = [
            ['temperature', '1'],
            ['topP', -0.01],
            ['topK', 100_001],
            ['topK', 1.5],
            ['topA', 1.01],
            ['minP', -0.01],
            ['frequencyPenalty', -2.01],
            ['presencePenalty', 2.01],
            ['repetitionPenalty', 10.01],
            ['seed', 1.5],
            ['contextTokens', 2_047],
            ['maxTokens', 0],
            ['stop', 'END'],
            ['stop', Array(17).fill('END')],
            ['stop', ['']],
            ['stop', ['x'.repeat(1_001)]],
            ['assistantPrefill', 42],
            ['assistantPrefill', 'x'.repeat(100_001)],
        ];

        for (const [field, invalidValue] of cases) {
            const result = compilePromptProfile(profile({
                generation: { [field]: invalidValue },
                generationPolicies: {},
                taskPolicies: {},
            }));
            assert.ok(
                result.errors.some(item => item.code === 'invalid_generation_value'
                    && item.path === `generation.${field}`),
                `expected ${field}=${JSON.stringify(invalidValue).slice(0, 80)} to be rejected`,
            );
            assert.deepEqual(result.generation[field], invalidValue);
        }
    });

    test('validates named, task, inline, unused, and compile-time generation layers while retaining unknown fields', () => {
        const value = profile({
            generation: { temperature: 0.8, unknownBase: 'base' },
            generationPolicies: {
                selected: { contextTokens: 2_047, unknownPolicy: 'policy' },
                unused: { maxTokens: 0 },
            },
            taskPolicies: {
                draft: {
                    generationPolicy: 'selected',
                    generation: { stop: [''], unknownTask: 'task' },
                },
                review: {
                    generationPolicy: { topA: 2 },
                    generation: { assistantPrefill: 7 },
                },
            },
        });
        const result = compilePromptProfile(value, {
            task: 'draft',
            generation: { seed: 1.5, unknownOverride: 'override' },
        });
        const errorPaths = new Set(result.errors
            .filter(item => item.code === 'invalid_generation_value')
            .map(item => item.path));

        assert.deepEqual(errorPaths, new Set([
            'generationPolicies.selected.contextTokens',
            'generationPolicies.unused.maxTokens',
            'taskPolicies.draft.generation.stop',
            'taskPolicies.review.generationPolicy.topA',
            'taskPolicies.review.generation.assistantPrefill',
            'options.generation.seed',
        ]));
        assert.equal(result.generation.unknownBase, 'base');
        assert.equal(result.generation.unknownPolicy, 'policy');
        assert.equal(result.generation.unknownTask, 'task');
        assert.equal(result.generation.unknownOverride, 'override');
        assert.equal(result.errors.some(item => item.field?.startsWith('unknown')), false);

        const inline = compilePromptProfile(profile({ generationPolicies: {}, taskPolicies: {} }), {
            taskPolicy: {
                generationPolicy: { minP: 2 },
                generation: { frequencyPenalty: -3 },
            },
        });
        assert.ok(inline.errors.some(item => item.path === 'taskPolicies.custom.generationPolicy.minP'));
        assert.ok(inline.errors.some(item => item.path === 'taskPolicies.custom.generation.frequencyPenalty'));
    });

    test('hashes canonical normalized profile data independently of object key insertion order', () => {
        const first = profile({ metadata: { z: 1, a: 2 } });
        const second = { metadata: { a: 2, z: 1 }, ...profile() };
        assert.equal(compilePromptProfile(first).profileHash, compilePromptProfile(second).profileHash);
        assert.equal(estimatePromptTokens('中文ab cd'), 4);
    });
});
