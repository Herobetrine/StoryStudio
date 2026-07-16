import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createResourceRecord, parseCharacterPng } from '../src/compat-import.js';
import { STORY_STUDIO_SCHEMA_VERSION, StoryStudioError, StoryStudioStore } from '../src/story-studio-store.js';
import { compilePromptProfile } from '../public/prompt-profile-compiler.js';

const LOCAL_HOST = '127.0.0.1:8123';
let root;
let store;

function v1Card(name = '林照') {
    return {
        name,
        description: '边城巡夜人。',
        personality: '克制，记仇。',
        scenario: '城门将闭。',
        first_mes: '雨还没停。',
        mes_example: '{{char}}：先查灯塔。',
    };
}

function v2Card(name = '沈砚') {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '旧档案管理员。',
            personality: '谨慎。',
            scenario: '档案库失火。',
            first_mes: '这页不该存在。',
            mes_example: '沈砚：别碰封蜡。',
            creator_notes: '用于长篇创作。',
            system_prompt: '保持冷静语气。',
            post_history_instructions: '不要泄露终局。',
            alternate_greetings: ['门后有人。'],
            tags: ['主角'],
            creator: 'tester',
            character_version: '2',
            extensions: { depth_prompt: { prompt: '注意左手伤势', depth: 4, role: 'system' } },
            character_book: {
                name: '沈砚随身设定',
                extensions: {},
                entries: [{
                    id: 9,
                    keys: ['封蜡'],
                    secondary_keys: [],
                    comment: '封蜡规则',
                    content: '黑色封蜡只用于死者档案。',
                    constant: false,
                    selective: false,
                    insertion_order: 90,
                    enabled: true,
                    position: 'before_char',
                    extensions: {},
                }],
            },
        },
    };
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    typeBuffer.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return result;
}

function cardPng(chara, ccv3 = null) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunks = [pngChunk('IHDR', ihdr)];
    const text = (keyword, value) => {
        const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
        return pngChunk('tEXt', Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(encoded, 'ascii')]));
    };
    chunks.push(text('chara', chara));
    if (ccv3) chunks.push(text('ccv3', ccv3));
    chunks.push(pngChunk('IEND'));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ...chunks]);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-resources-'));
    store = new StoryStudioStore(root);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('compatibility resource parsing and persistence', () => {
    test('imports V1 JSON and supports list, read, update, activation, and delete conflicts', () => {
        const { project } = store.createProject({ title: '资源测试' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'lin.json',
            mediaType: 'application/json',
            encoding: 'json',
            data: v1Card(),
        });
        assert.equal(imported.resource.type, 'character');
        assert.equal(imported.resource.name, '林照');
        assert.equal(imported.resource.instructionEnabled, false);
        assert.match(path.basename(store.resourcePath(project.id, 'character', imported.resource.id)), /^[0-9a-f-]{36}\.json$/);

        const listed = store.listResources(project.id, 'characters');
        assert.deepEqual(listed.map(item => item.name), ['林照']);
        assert.equal(listed[0].persona, false);
        const inactive = store.getResource(project.id, 'character', imported.resource.id);
        assert.equal(inactive.active, false);
        assert.equal(inactive.persona, false);

        const activated = store.updateResourceActivation(project.id, imported.project.version, {
            activeCharacterIds: [imported.resource.id],
        });
        assert.equal(store.getResource(project.id, 'character', imported.resource.id).active, true);
        const updated = store.updateResource(project.id, 'character', imported.resource.id, activated.version, 1, {
            personality: '克制，且不相信巧合。',
        });
        assert.equal(updated.resource.revision, 2);
        assert.throws(
            () => store.deleteResource(project.id, 'character', imported.resource.id, updated.project.version, 1),
            error => error.code === 'resource_conflict',
        );
        const deleted = store.deleteResource(project.id, 'character', imported.resource.id, updated.project.version, 2);
        assert.equal(deleted.project.resources.characterIds.length, 0);
        assert.equal(fs.existsSync(store.resourcePath(project.id, 'character', imported.resource.id)), false);
    });

    test('imports V2 and splits an embedded Character Book into a linked lorebook', () => {
        const { project } = store.createProject({ title: '嵌入书' });
        const result = store.importResource(project.id, project.version, {
            fileName: 'shen.json',
            mediaType: 'application/json',
            encoding: 'json',
            data: v2Card(),
        });
        assert.equal(result.resources.length, 2);
        assert.equal(result.project.resources.characterIds.length, 1);
        assert.equal(result.project.resources.lorebookIds.length, 1);
        assert.equal(result.resource.embeddedLorebookId, result.project.resources.lorebookIds[0]);
        const lorebook = store.getResource(project.id, 'lorebook', result.resource.embeddedLorebookId);
        assert.equal(lorebook.entries[0].content, '黑色封蜡只用于死者档案。');
        assert.deepEqual(lorebook.entries[0].keys, ['封蜡']);
    });

    test('uses an imported character as Persona independently and clears it on deletion', () => {
        const { project } = store.createProject({ title: 'Persona 测试' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'persona.json', mediaType: 'application/json', encoding: 'json', data: v1Card('执笔人'),
        });
        assert.throws(
            () => store.updateResourceActivation(project.id, imported.project.version, { activePersonaId: 'missing-character' }),
            error => error.code === 'invalid_active_resource',
        );

        const selected = store.updateResourceActivation(project.id, imported.project.version, {
            activePersonaId: imported.resource.id,
        });
        const read = store.getResource(project.id, 'character', imported.resource.id);
        const listed = store.listResources(project.id, 'characters')[0];
        assert.equal(read.active, false);
        assert.equal(read.persona, true);
        assert.equal(listed.active, false);
        assert.equal(listed.persona, true);

        const deleted = store.deleteResource(project.id, 'character', imported.resource.id, selected.version, 1);
        assert.equal(deleted.project.resources.activePersonaId, null);
    });

    test('accepts V3 JSON but rejects unsupported 4.x cards', () => {
        const { project } = store.createProject({ title: 'V3' });
        const card = { ...v2Card('闻雪'), spec: 'chara_card_v3', spec_version: '3.1' };
        const result = store.importResource(project.id, project.version, {
            fileName: 'v3.json', mediaType: 'application/json', encoding: 'json', data: card,
        });
        assert.equal(result.resource.source.spec, 'chara_card_v3');
        assert.throws(() => store.importResource(project.id, result.project.version, {
            fileName: 'v4.json', mediaType: 'application/json', encoding: 'json',
            data: { ...card, spec_version: '4.0' },
        }), error => error.code === 'unsupported_character_schema');
    });

    test('validates PNG CRC and gives ccv3 metadata precedence over chara', () => {
        const v3 = { ...v2Card('新版角色'), spec: 'chara_card_v3', spec_version: '3.0' };
        const png = cardPng(v1Card('旧版角色'), v3);
        const parsed = parseCharacterPng(png);
        assert.equal(parsed.metadataKind, 'ccv3');
        assert.equal(parsed.card.data.name, '新版角色');
        assert.deepEqual(parsed.warnings, ['ccv3_preferred_over_chara']);
        assert.equal(parsed.avatar.persisted, false);

        const corrupted = Buffer.from(png);
        corrupted[corrupted.length - 1] ^= 1;
        assert.throws(() => parseCharacterPng(corrupted), error => error.code === 'invalid_png_crc');
        assert.throws(() => parseCharacterPng(png.subarray(0, -5)), error => error.code === 'invalid_png');
    });

    test('imports native World Info and rejects duplicate entry identifiers atomically', () => {
        const { project } = store.createProject({ title: '世界书' });
        const book = {
            name: '城规',
            recursive_scanning: true,
            entries: {
                1: {
                    uid: 1,
                    key: ['城门'],
                    keysecondary: [],
                    content: '子时关闭。',
                    order: 90,
                    disable: false,
                    position: 4,
                    probability: 50,
                    excludeRecursion: true,
                    group: '城门规则',
                    sticky: 2,
                },
            },
        };
        const imported = store.importResource(project.id, project.version, {
            fileName: 'world.json', mediaType: 'application/json', encoding: 'json', data: book,
        });
        assert.equal(imported.resource.entries[0].enabled, true);
        const warningCodes = imported.resource.source.compatibilityWarnings.map(item => item.code);
        assert.deepEqual(warningCodes, [
            'unsupported_lorebook_probability_sampling',
            'unsupported_lorebook_recursion',
            'unsupported_lorebook_group_arbitration',
            'unsupported_lorebook_timed_state',
            'approximate_lorebook_depth_position',
        ]);
        const beforeFiles = fs.readdirSync(store.resourceDirectory(project.id, 'lorebook'));
        assert.throws(() => store.importResource(project.id, imported.project.version, {
            fileName: 'duplicate.json', mediaType: 'application/json', encoding: 'json',
            data: { entries: [{ id: 1, keys: [], content: '', extensions: {} }, { id: 1, keys: [], content: '', extensions: {} }] },
        }), error => error.code === 'duplicate_lorebook_entry');
        assert.deepEqual(fs.readdirSync(store.resourceDirectory(project.id, 'lorebook')), beforeFiles);
        assert.equal(store.getProject(project.id).version, imported.project.version);
    });

    test('normalizes combined prompt presets while removing endpoint, header, and key material', () => {
        const { project } = store.createProject({ title: '预设' });
        const result = store.importResource(project.id, project.version, {
            fileName: 'ST-formatting.json',
            mediaType: 'application/json',
            encoding: 'json',
            data: {
                instruct: { name: 'Story', input_sequence: '', output_sequence: '', wrap: true },
                context: { name: 'Story', story_string: 'CONTEXT_SENTINEL {{description}}', use_stop_strings: false },
                reasoning: { name: 'Reasoning wrapper', prefix: '<think>', suffix: '</think>', separator: '\n' },
                preset: {
                    temperature: 0.8,
                    top_p: 0.9,
                    openai_max_context: 32_768,
                    custom_url: 'https://attacker.invalid/v1',
                    custom_include_headers: 'Authorization: secret',
                    api_key: 'secret-key',
                    prompts: [{ identifier: 'main', role: 'system', content: 'Write fiction.' }],
                },
            },
        });
        assert.equal(result.resource.type, 'prompt-profile');
        assert.equal(result.resource.generation.temperature, 0.8);
        assert.equal(result.resource.generation.topP, 0.9);
        assert.equal(result.resource.generation.contextTokens, 32_768);
        const contextModule = result.resource.modules.find(module => module.sourceRef?.field === 'story_string');
        assert.match(contextModule.id, /^st-context-[0-9a-f]{24}$/);
        assert.equal(contextModule.slot, 'main');
        assert.equal(contextModule.role, 'system');
        assert.equal(contextModule.template, 'CONTEXT_SENTINEL {{description}}');
        assert.equal(result.resource.order.indexOf(contextModule.id), result.resource.order.indexOf('main') + 1);
        assert.equal(result.resource.compatibility.warnings.some(item => item.code === 'unsupported_reasoning'), true);
        const storedText = fs.readFileSync(store.resourcePath(project.id, 'prompt-profile', result.resource.id), 'utf8');
        assert.equal(storedText.includes('attacker.invalid'), false);
        assert.equal(storedText.includes('secret-key'), false);
        assert.equal(result.resource.source.removedSensitiveFields.length, 3);
    });

    test('converts the official Default prompt shape into stable Profile V2 modules and selected order', () => {
        const { project } = store.createProject({ title: '官方 Default 预设' });
        const preset = {
            name: 'Default',
            temperature: 0.73,
            top_p: 0.91,
            top_k: 40,
            top_a: 0.2,
            min_p: 0.05,
            frequency_penalty: 0.4,
            presence_penalty: -0.2,
            repetition_penalty: 1.08,
            openai_max_context: 65_536,
            openai_max_tokens: 4_096,
            seed: 42,
            assistant_prefill: '正文：',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write {{char}} fiction.' },
                { identifier: 'charDescription', name: 'Description', system_prompt: true, marker: true },
                { identifier: 'charPersonality', name: 'Personality', system_prompt: true, marker: true },
                { identifier: 'chatHistory', name: 'History', system_prompt: true, marker: true },
                { name: 'Stable unnamed module', role: 'user', content: 'Keep the scene causal.' },
            ],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: false },
                        { identifier: 'chatHistory', enabled: false },
                        { identifier: 'charDescription', enabled: true },
                        { identifier: 'charPersonality', enabled: false },
                    ],
                },
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'main', enabled: true },
                        { identifier: 'charDescription', enabled: false },
                        { identifier: 'charPersonality', enabled: true },
                    ],
                },
            ],
        };
        const first = store.importResource(project.id, project.version, {
            fileName: 'Default.json', mediaType: 'application/json', encoding: 'json', data: preset,
        });
        const second = store.importResource(project.id, first.project.version, {
            fileName: 'Default-copy.json', mediaType: 'application/json', encoding: 'json', data: preset,
        });

        assert.equal(first.resource.profileVersion, 2);
        assert.deepEqual(first.resource.generation, {
            temperature: 0.73,
            topP: 0.91,
            topK: 40,
            topA: 0.2,
            minP: 0.05,
            frequencyPenalty: 0.4,
            presencePenalty: -0.2,
            repetitionPenalty: 1.08,
            contextTokens: 65_536,
            maxTokens: 4_096,
            seed: 42,
            assistantPrefill: '正文：',
        });
        const byId = new Map(first.resource.modules.map(module => [module.id, module]));
        assert.deepEqual(first.resource.order.slice(0, 4), ['chatHistory', 'main', 'charDescription', 'charPersonality']);
        assert.equal(byId.get('main').slot, 'main');
        assert.equal(byId.get('main').enabled, true);
        assert.equal(byId.get('main').includeData, false);
        assert.equal(byId.get('charDescription').slot, 'characterDescription');
        assert.equal(byId.get('charDescription').enabled, false);
        assert.equal(byId.get('charDescription').marker, true);
        assert.equal(byId.get('charDescription').includeData, true);
        assert.equal(byId.get('charPersonality').slot, 'characterPersonality');
        assert.equal(byId.get('charPersonality').enabled, true);
        assert.equal(byId.get('charPersonality').marker, true);
        assert.equal(byId.get('charPersonality').includeData, true);
        assert.equal(byId.get('chatHistory').slot, 'task');
        assert.equal(first.resource.compatibility.selectedCharacterId, '100001');
        assert.equal(first.resource.compatibility.promptOrderMode, 'character');
        const reducedOrderWarning = first.resource.compatibility.warnings
            .find(item => item.code === 'prompt_order_groups_reduced');
        assert.deepEqual(reducedOrderWarning.ignoredCharacterIds, ['100000']);
        assert.deepEqual(first.resource.chatCompletion.promptOrder, preset.prompt_order);
        assert.deepEqual(first.resource.chatCompletion.prompts, preset.prompts);
        const generatedId = first.resource.modules.at(-1).id;
        assert.match(generatedId, /^st-[0-9a-f]{24}$/);
        assert.equal(second.resource.modules.at(-1).id, generatedId);
        assert.equal(first.resource.order.at(-1), generatedId);
    });

    test('records script, EJS, and unknown macros as inert compatibility warnings', () => {
        globalThis.__storyStudioPresetExecuted = false;
        try {
            const { project } = store.createProject({ title: '不执行社区脚本' });
            const result = store.importResource(project.id, project.version, {
                fileName: 'unsafe-template.json',
                mediaType: 'application/json',
                encoding: 'json',
                data: {
                    temperature: 0.5,
                    prompts: [{
                        identifier: 'unsafe',
                        name: 'Unsafe template',
                        role: 'system',
                        content: '<% globalThis.__storyStudioPresetExecuted = true %><script>globalThis.__storyStudioPresetExecuted = true</script>{{getvar::secret}}',
                        script: 'globalThis.__storyStudioPresetExecuted = true',
                        position: 1,
                        injection_depth: 4,
                    }],
                    prompt_order: [{ identifier: 'unsafe', enabled: true }],
                },
            });
            assert.equal(globalThis.__storyStudioPresetExecuted, false);
            assert.equal(result.resource.modules[0].when, null);
            const warningCodes = result.resource.compatibility.warnings.map(item => item.code);
            assert.equal(warningCodes.includes('unsupported_ejs'), true);
            assert.equal(warningCodes.includes('unsupported_script'), true);
            assert.equal(warningCodes.includes('unsupported_script_field'), true);
            assert.equal(warningCodes.includes('unknown_macro'), true);
            const unsupportedFields = result.resource.compatibility.warnings
                .filter(item => item.code === 'unsupported_prompt_field')
                .map(item => item.feature);
            assert.deepEqual(unsupportedFields, ['position', 'injection_depth']);
            assert.deepEqual(result.resource.source.compatibilityWarnings, result.resource.compatibility.warnings);
        } finally {
            delete globalThis.__storyStudioPresetExecuted;
        }
    });

    test('strictly rejects oversized and duplicate Prompt Profile V2 identifiers', () => {
        const { project } = store.createProject({ title: 'V2 边界' });
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'too-many.json', mediaType: 'application/json', encoding: 'json',
            data: { temperature: 1, prompts: Array.from({ length: 501 }, (_, index) => ({ identifier: `p${index}` })) },
        }), error => error.code === 'invalid_resource_field');
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'duplicate.json', mediaType: 'application/json', encoding: 'json',
            data: { temperature: 1, prompts: [{ identifier: 'same' }, { identifier: 'same' }] },
        }), error => error.code === 'duplicate_prompt_identifier');

        const baseModule = { id: 'main', name: 'Main', slot: 'main', role: 'system', template: '' };
        assert.throws(() => createResourceRecord('prompt-profile', 'project-id', {
            name: 'Duplicate order', instruct: null, context: null, generation: {}, chatCompletion: {},
            systemPrompt: null, reasoning: null, startReplyWith: null, source: {}, profileVersion: 2,
            modules: [baseModule], order: ['main', 'main'], variables: [], taskPolicies: {}, compatibility: {},
        }), error => error.code === 'duplicate_prompt_identifier');
        assert.throws(() => createResourceRecord('prompt-profile', 'project-id', {
            name: 'Long ID', instruct: null, context: null, generation: {}, chatCompletion: {},
            systemPrompt: null, reasoning: null, startReplyWith: null, source: {}, profileVersion: 2,
            modules: [{ ...baseModule, id: 'x'.repeat(129) }], order: ['x'.repeat(129)],
            variables: [], taskPolicies: {}, compatibility: {},
        }), error => error.code === 'resource_field_too_large');
    });

    test('preserves the complete native Prompt Profile V2 execution contract through save and export', async () => {
        const { project } = store.createProject({ title: '原生 V2 往返' });
        const nativeProfile = {
            profileVersion: 2,
            name: 'Native Writer V2',
            generation: {
                temperature: 0.65,
                topP: 0.9,
                stop: ['<END>', '<CHAPTER>'],
                assistantPrefill: '正文：',
            },
            generationPolicies: {
                deterministic: {
                    temperature: 0.2,
                    seed: 7,
                    stop: ['<DONE>'],
                    assistantPrefill: '{',
                },
            },
            variables: [{
                id: 'tone', type: 'single', options: ['cold', 'warm'], default: 'cold',
            }],
            variableValues: { tone: 'warm' },
            taskPolicies: {
                draft: {
                    generationPolicy: 'deterministic',
                    variables: { tone: 'cold' },
                    tokenBudget: 700,
                    characterBudget: 2_800,
                },
            },
            tokenBudget: 900,
            characterBudget: 3_600,
            modules: [{
                id: 'task', name: 'Task', slot: 'task', role: 'user', template: '使用 {{tone}} 语气。',
                tokenBudget: 300,
            }],
            order: ['task'],
            compatibility: { sourceFormat: 'native-v2' },
        };
        const imported = store.importResource(project.id, project.version, {
            fileName: 'native-writer-v2.json',
            mediaType: 'application/json',
            encoding: 'json',
            data: nativeProfile,
        });

        assert.deepEqual(imported.resource.generation, nativeProfile.generation);
        assert.deepEqual(imported.resource.generationPolicies, nativeProfile.generationPolicies);
        assert.deepEqual(imported.resource.variableValues, { tone: 'warm' });
        assert.equal(imported.resource.tokenBudget, 900);
        assert.equal(imported.resource.characterBudget, 3_600);
        assert.equal(imported.resource.modules[0].tokenBudget, 300);
        assert.equal(imported.resource.source.format, 'story-studio-prompt-profile-v2');
        assert.equal(imported.resource.source.fileName, 'native-writer-v2.json');

        const updated = store.updateResource(
            project.id,
            'prompt-profile',
            imported.resource.id,
            imported.project.version,
            imported.resource.revision,
            {
                variableValues: { tone: 'cold' },
                generationPolicies: {
                    deterministic: nativeProfile.generationPolicies.deterministic,
                    creative: { temperature: 1.1, stop: ['<NEXT>'], assistantPrefill: '第一句：' },
                },
                tokenBudget: 1_000,
                characterBudget: 4_000,
            },
        );
        assert.deepEqual(updated.resource.variableValues, { tone: 'cold' });
        assert.deepEqual(updated.resource.generationPolicies, {
            deterministic: nativeProfile.generationPolicies.deterministic,
            creative: { temperature: 1.1, stop: ['<NEXT>'], assistantPrefill: '第一句：' },
        });

        const tokenCleared = store.updateResource(
            project.id,
            'prompt-profile',
            imported.resource.id,
            updated.project.version,
            updated.resource.revision,
            { tokenBudget: null },
        );
        assert.equal(Object.hasOwn(tokenCleared.resource, 'tokenBudget'), false);
        assert.equal(tokenCleared.resource.characterBudget, 4_000);
        const budgetsCleared = store.updateResource(
            project.id,
            'prompt-profile',
            imported.resource.id,
            tokenCleared.project.version,
            tokenCleared.resource.revision,
            { characterBudget: null },
        );
        assert.equal(Object.hasOwn(budgetsCleared.resource, 'tokenBudget'), false);
        assert.equal(Object.hasOwn(budgetsCleared.resource, 'characterBudget'), false);

        const exported = await store.exportProject(project.id);
        const restored = await store.importProject(exported);
        const restoredId = restored.project.resources.promptProfileIds[0];
        const profile = store.getResource(restored.project.id, 'prompt-profile', restoredId);
        assert.deepEqual(profile.generation, nativeProfile.generation);
        assert.deepEqual(profile.generationPolicies, updated.resource.generationPolicies);
        assert.deepEqual(profile.variableValues, { tone: 'cold' });
        assert.equal(Object.hasOwn(profile, 'tokenBudget'), false);
        assert.equal(Object.hasOwn(profile, 'characterBudget'), false);
        assert.equal(profile.taskPolicies.draft.tokenBudget, 700);
        assert.equal(profile.taskPolicies.draft.characterBudget, 2_800);
        assert.equal(profile.modules[0].tokenBudget, 300);

        const compiled = compilePromptProfile(profile, { task: 'draft' });
        assert.deepEqual(compiled.errors, []);
        assert.equal(compiled.variables.tone, 'cold');
        assert.deepEqual(compiled.generation, {
            assistantPrefill: '{',
            seed: 7,
            stop: ['<DONE>'],
            temperature: 0.2,
            topP: 0.9,
        });
        assert.equal(compiled.diagnostics.budgets.characterBudget, 2_800);
        assert.equal(compiled.diagnostics.budgets.tokenBudget, 700);
        assert.match(compiled.messages[0].content, /cold/);
    });

    test('rejects invalid native Profile V2 budgets, stop strings, prefill, and oversized policy maps', () => {
        const base = {
            name: 'Native bounds', instruct: null, context: null, generation: {}, chatCompletion: {},
            systemPrompt: null, reasoning: null, startReplyWith: null, source: {}, profileVersion: 2,
            modules: [{ id: 'main', name: 'Main', slot: 'main', role: 'system', template: '' }],
            order: ['main'], variables: [], variableValues: {}, generationPolicies: {},
            taskPolicies: {}, compatibility: {}, tokenBudget: 100, characterBudget: 1_000,
        };
        const create = overrides => createResourceRecord('prompt-profile', 'project-id', { ...base, ...overrides });

        assert.throws(() => create({ tokenBudget: -1 }), error => error.code === 'invalid_resource_field');
        assert.throws(() => create({ characterBudget: 2_000_001 }), error => error.code === 'invalid_resource_field');
        assert.throws(() => create({ generation: { stop: [''] } }), error => error.code === 'invalid_resource_field');
        assert.throws(() => create({ generation: { stop: Array(17).fill('END') } }), error => error.code === 'invalid_resource_field');
        assert.throws(() => create({ generation: { stop: ['x'.repeat(1_001)] } }), error => error.code === 'resource_field_too_large');
        assert.throws(() => create({ generation: { assistantPrefill: 42 } }), error => error.code === 'invalid_resource_field');
        assert.throws(() => create({
            generation: { assistantPrefill: 'x'.repeat(100_001) },
        }), error => error.code === 'resource_field_too_large');
        assert.throws(() => create({
            variableValues: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`v${index}`, index])),
        }), error => error.code === 'resource_too_complex');
        assert.throws(() => create({
            generationPolicies: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, {}])),
        }), error => error.code === 'resource_too_complex');

        const minimal = createResourceRecord('prompt-profile', 'project-id', {
            profileVersion: 2,
            name: 'Minimal native profile',
            generation: {},
            modules: [{ id: 'main', template: 'Write.' }],
            order: ['main'],
        });
        assert.deepEqual(minimal.variables, []);
        assert.deepEqual(minimal.variableValues, {});
        assert.deepEqual(minimal.generationPolicies, {});
        assert.deepEqual(minimal.taskPolicies, {});
        assert.deepEqual(minimal.compatibility, {});
    });

    test('roundtrips legacy prompt profiles without silently upgrading them to V2', async () => {
        const { project } = store.createProject({ title: '旧 Profile 往返' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'legacy.json', mediaType: 'application/json', encoding: 'json',
            data: { name: 'Legacy generation preset', temperature: 0.6, top_p: 0.8 },
        });
        assert.equal(Object.hasOwn(imported.resource, 'profileVersion'), false);
        assert.equal(Object.hasOwn(imported.resource, 'modules'), false);

        const exported = await store.exportProject(project.id);
        const restored = await store.importProject(exported);
        const restoredId = restored.project.resources.promptProfileIds[0];
        const profile = store.getResource(restored.project.id, 'prompt-profile', restoredId);
        assert.equal(profile.generation.temperature, 0.6);
        assert.equal(profile.generation.topP, 0.8);
        assert.equal(Object.hasOwn(profile, 'profileVersion'), false);
        assert.equal(Object.hasOwn(profile, 'modules'), false);
        assert.equal(Object.hasOwn(profile, 'order'), false);
    });

    test('roundtrips project resources with fresh identifiers and active links', async () => {
        const { project } = store.createProject({ title: '资源往返' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'shen.json', mediaType: 'application/json', encoding: 'json', data: v2Card(),
        });
        const activated = store.updateResourceActivation(project.id, imported.project.version, {
            activeCharacterIds: [imported.resource.id],
            activeLorebookIds: [imported.resource.embeddedLorebookId],
            activePersonaId: imported.resource.id,
        });
        const exported = await store.exportProject(project.id);
        assert.equal(exported.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
        assert.equal(exported.resources.characters.length, 1);
        assert.equal(exported.resources.lorebooks.length, 1);

        const restored = await store.importProject(exported);
        assert.notEqual(restored.project.resources.characterIds[0], imported.resource.id);
        assert.notEqual(restored.project.resources.lorebookIds[0], imported.resource.embeddedLorebookId);
        assert.deepEqual(restored.project.resources.activeCharacterIds, restored.project.resources.characterIds);
        assert.deepEqual(restored.project.resources.activeLorebookIds, restored.project.resources.lorebookIds);
        assert.equal(restored.project.resources.activePersonaId, restored.project.resources.characterIds[0]);
        assert.notEqual(restored.project.resources.activePersonaId, imported.resource.id);
        const restoredCharacter = store.getResource(restored.project.id, 'character', restored.project.resources.characterIds[0]);
        assert.equal(restoredCharacter.embeddedLorebookId, restored.project.resources.lorebookIds[0]);
        assert.equal(restoredCharacter.persona, true);
        assert.equal(restored.project.version, 1);
        assert.equal(activated.version, 3);
    });

    test('imports a legacy V1 export as an explicit V5 migration', async () => {
        const { project } = store.createProject({ title: '旧导出', story: { premise: '天幕正在熄灭。' } });
        const payload = await store.exportProject(project.id);
        payload.schemaVersion = 1;
        payload.project.schemaVersion = 1;
        delete payload.project.resources;
        delete payload.project.storyState;
        delete payload.project.volumes;
        for (const summary of payload.project.chapters) {
            delete summary.volumeId;
            delete summary.planBasis;
        }
        delete payload.resources;
        for (const chapter of payload.chapters) {
            chapter.schemaVersion = 1;
            delete chapter.volumeId;
            delete chapter.planBasis;
            delete chapter.generationHistory;
        }

        const imported = await store.importProject(payload);
        assert.equal(imported.project.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
        assert.equal(imported.project.story.premise, '天幕正在熄灭。');
        assert.deepEqual(imported.project.resources.characterIds, []);
    });

    test('migrates stored V1 projects and chapters explicitly on first locked read', () => {
        const { project, chapter } = store.createProject({ title: '旧项目' });
        const storedProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        const storedChapter = JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
        storedProject.schemaVersion = 1;
        delete storedProject.resources;
        delete storedProject.storyState;
        delete storedProject.volumes;
        for (const summary of storedProject.chapters) {
            delete summary.volumeId;
            delete summary.planBasis;
        }
        storedChapter.schemaVersion = 1;
        delete storedChapter.volumeId;
        delete storedChapter.planBasis;
        delete storedChapter.generationHistory;
        storedProject.chapterBytes = Buffer.byteLength(JSON.stringify(storedChapter), 'utf8');
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(storedProject), 'utf8');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(storedChapter), 'utf8');

        const migrated = store.getProject(project.id);
        assert.equal(migrated.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
        assert.equal(migrated.version, project.version + 1);
        assert.deepEqual(migrated.resources, {
            characterIds: [], lorebookIds: [], promptProfileIds: [],
            activeCharacterIds: [], activeLorebookIds: [], activePromptProfileId: null, activePersonaId: null,
        });
        const migratedChapter = store.getChapter(project.id, chapter.id);
        assert.equal(migratedChapter.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
        assert.deepEqual(migratedChapter.generationHistory, []);
        assert.deepEqual(migrated.storyState, {
            entities: [], relations: [], events: [], promises: [], memory: [],
            facts: [], knowledge: [], timeline: [],
        });
    });

    test('recovers a pending resource and project-index write', () => {
        const { project } = store.createProject({ title: '资源恢复' });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('simulated crash before resource publish'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'pending.json', mediaType: 'application/json', encoding: 'json', data: v1Card('待恢复角色'),
        }), /simulated crash before resource publish/);
        store.applyResourceOperations = apply;

        const journal = JSON.parse(fs.readFileSync(store.resourceJournalPath(project.id), 'utf8'));
        assert.match(journal.baseProjectDigest, /^[0-9a-f]{64}$/);
        assert.equal(journal.baseResources.length, 1);
        assert.equal(journal.baseResources[0].exists, false);
        assert.equal(journal.baseResources[0].revision, null);
        assert.equal(journal.baseResources[0].createdAt, null);
        const resourceId = journal.operations[0].resourceId;
        assert.equal(store.getProject(project.id).version, 2);
        assert.equal(store.getResource(project.id, 'character', resourceId).name, '待恢复角色');
        assert.equal(fs.existsSync(store.resourceJournalPath(project.id)), false);
    });

    test('recovers a resource import when commit and replay normalize the same V3 base without raw chapterBytes', () => {
        const { project } = store.createProject({ title: '资源规范基线恢复' });
        const rawProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        delete rawProject.chapterBytes;
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(rawProject), 'utf8');
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('simulated crash from normalized resource base'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'normalized-base.json',
            mediaType: 'application/json',
            encoding: 'json',
            data: v1Card('规范基线角色'),
        }), /simulated crash from normalized resource base/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')), 'chapterBytes'), false);
        assert.equal(journal.project.chapterBytes, project.chapterBytes);
        assert.equal(journal.baseResources[0].revision, null);
        assert.equal(journal.baseResources[0].createdAt, null);
        const resourceId = journal.operations[0].resourceId;
        const recovered = store.getProject(project.id);
        assert.equal(recovered.version, project.version + 1);
        assert.equal(store.getResource(project.id, 'character', resourceId).name, '规范基线角色');
        assert.equal(fs.existsSync(journalPath), false);
    });

    test('rejects tampered revision and createdAt transitions in existing-resource journals', async t => {
        const cases = [
            {
                name: 'revision',
                mutate(resource) { resource.revision = 99; },
            },
            {
                name: 'createdAt',
                mutate(resource) { resource.createdAt = '2000-01-01T00:00:00.000Z'; },
            },
        ];
        for (const testCase of cases) {
            await t.test(testCase.name, () => {
                const caseStore = new StoryStudioStore(path.join(root, testCase.name));
                const { project } = caseStore.createProject({ title: `资源转移约束-${testCase.name}` });
                const imported = caseStore.importResource(project.id, project.version, {
                    fileName: `${testCase.name}.json`,
                    mediaType: 'application/json',
                    encoding: 'json',
                    data: v1Card(`基线角色-${testCase.name}`),
                });
                const resourcePath = caseStore.resourcePath(project.id, 'character', imported.resource.id);
                const formalResource = fs.readFileSync(resourcePath, 'utf8');
                const apply = caseStore.applyResourceOperations.bind(caseStore);
                caseStore.applyResourceOperations = () => { throw new Error(`stop before ${testCase.name} target publish`); };
                assert.throws(() => caseStore.updateResource(
                    project.id,
                    'character',
                    imported.resource.id,
                    imported.project.version,
                    imported.resource.revision,
                    { personality: `目标修改-${testCase.name}` },
                ), new RegExp(`stop before ${testCase.name} target publish`));
                caseStore.applyResourceOperations = apply;

                const journalPath = caseStore.resourceJournalPath(project.id);
                const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
                testCase.mutate(journal.operations[0].resource);
                fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');

                assert.throws(
                    () => caseStore.getProject(project.id),
                    error => error instanceof StoryStudioError && error.code === 'invalid_storage',
                );
                assert.equal(fs.existsSync(journalPath), true);
                assert.equal(fs.readFileSync(resourcePath, 'utf8'), formalResource);
                assert.equal(JSON.parse(fs.readFileSync(caseStore.projectPath(project.id), 'utf8')).version, imported.project.version);
            });
        }
    });

    test('blocks recovery when the target project is published before its resource files', () => {
        const { project } = store.createProject({ title: '资源目标态缺文件' });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('simulated crash before resource publish'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'target-first.json', mediaType: 'application/json', encoding: 'json', data: v1Card('不应自动覆盖'),
        }), /simulated crash before resource publish/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(journal.project), 'utf8');

        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError
                && error.code === 'stale_journal'
                && error.details.recoveryBlocked === true,
        );
        assert.equal(fs.existsSync(journalPath), true);
        assert.equal(fs.existsSync(store.resourcePath(
            project.id,
            journal.operations[0].type,
            journal.operations[0].resourceId,
        )), false);
    });

    test('rejects resource journals whose operations do not exactly match the project index', () => {
        const { project } = store.createProject({ title: '资源索引校验' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'indexed.json', mediaType: 'application/json', encoding: 'json', data: v1Card('索引角色'),
        });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('stop before invalid resource operation'); };
        assert.throws(() => store.updateResource(
            project.id,
            'character',
            imported.resource.id,
            imported.project.version,
            imported.resource.revision,
            { personality: '目标修订不应被删除。' },
        ), /stop before invalid resource operation/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        journal.operations[0].operation = 'delete';
        journal.operations[0].resource = null;
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');

        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError && error.code === 'invalid_storage',
        );
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')).version, imported.project.version);
        assert.equal(JSON.parse(fs.readFileSync(
            store.resourcePath(project.id, 'character', imported.resource.id),
            'utf8',
        )).revision, 1);
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('rejects duplicate and unknown resource journal operations before publishing files', () => {
        const { project } = store.createProject({ title: '资源日志结构' });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('stop before malformed resource journal'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'duplicate.json', mediaType: 'application/json', encoding: 'json', data: v1Card('重复角色'),
        }), /stop before malformed resource journal/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        journal.unexpected = true;
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');
        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError && error.code === 'invalid_storage',
        );
        delete journal.unexpected;
        journal.operations.push(structuredClone(journal.operations[0]));
        journal.baseResources.push(structuredClone(journal.baseResources[0]));
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');
        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError && error.code === 'invalid_storage',
        );
        assert.equal(fs.existsSync(store.resourcePath(
            project.id,
            journal.operations[0].type,
            journal.operations[0].resourceId,
        )), false);
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('blocks a divergent project after a resource was partially published', () => {
        const { project } = store.createProject({ title: '资源分叉' });
        const imported = store.importResource(project.id, project.version, {
            fileName: 'branch.json', mediaType: 'application/json', encoding: 'json', data: v1Card('分叉角色'),
        });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = (projectId, operations, lock) => {
            apply(projectId, operations, lock);
            throw new Error('simulated crash after resource publish');
        };
        assert.throws(() => store.updateResource(
            project.id,
            'character',
            imported.resource.id,
            imported.project.version,
            imported.resource.revision,
            { personality: '已部分发布的旧分支。' },
        ), /simulated crash after resource publish/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const divergentProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        divergentProject.version = journal.project.version + 1;
        divergentProject.title = '并发形成的新分支';
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(divergentProject), 'utf8');

        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError
                && error.code === 'stale_journal'
                && error.details.recoveryBlocked === true,
        );
        assert.equal(fs.existsSync(journalPath), true);
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')).title, '并发形成的新分支');
        assert.equal(JSON.parse(fs.readFileSync(
            store.resourcePath(project.id, 'character', imported.resource.id),
            'utf8',
        )).revision, 2);
    });

    test('quarantines an unapplied stale resource journal only when current files remain coherent', t => {
        t.mock.method(console, 'warn', () => {});
        const { project } = store.createProject({ title: '安全隔离资源日志' });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('stop before stale resource publish'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'stale.json', mediaType: 'application/json', encoding: 'json', data: v1Card('过期角色'),
        }), /stop before stale resource publish/);
        store.applyResourceOperations = apply;

        const journalPath = store.resourceJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const branchedProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        branchedProject.title = '同版本但不同内容的分支';
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(branchedProject), 'utf8');

        assert.equal(store.getProject(project.id).title, '同版本但不同内容的分支');
        assert.equal(fs.existsSync(journalPath), false);
        assert.equal(fs.readdirSync(store.projectDirectory(project.id)).some(name => (
            name.startsWith('.pending-resource-write.conflict-')
        )), true);
        assert.equal(fs.existsSync(store.resourcePath(
            project.id,
            journal.operations[0].type,
            journal.operations[0].resourceId,
        )), false);
    });

    test('rechecks aggregate resource limits before replaying a journal', () => {
        const { project } = store.createProject({ title: '资源恢复上限' });
        const apply = store.applyResourceOperations.bind(store);
        store.applyResourceOperations = () => { throw new Error('stop before limited resource publish'); };
        assert.throws(() => store.importResource(project.id, project.version, {
            fileName: 'limit.json', mediaType: 'application/json', encoding: 'json', data: v1Card('超限角色'),
        }), /stop before limited resource publish/);
        store.applyResourceOperations = apply;
        store.maxProjectBytes = 1;

        assert.throws(
            () => store.getProject(project.id),
            error => error instanceof StoryStudioError && error.code === 'invalid_storage',
        );
        assert.equal(fs.existsSync(store.resourceJournalPath(project.id)), true);
    });
});

describe('resource HTTP API', () => {
    test('imports and retrieves a resource through the CSRF-protected API', async () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-resource-api-'));
        try {
            const app = createApp({ dataRoot });
            const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
            const created = await request(app)
                .post('/api/story-studio/projects')
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', bootstrap.body.csrfToken)
                .send({ title: 'API 资源' })
                .expect(201);
            const imported = await request(app)
                .post(`/api/story-studio/projects/${created.body.project.id}/resources/import`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', bootstrap.body.csrfToken)
                .send({
                    projectVersion: created.body.project.version,
                    import: { fileName: 'card.json', mediaType: 'application/json', encoding: 'json', data: v1Card() },
                })
                .expect(201);
            const listed = await request(app)
                .get(`/api/story-studio/projects/${created.body.project.id}/resources?type=characters`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            assert.equal(listed.body[0].id, imported.body.resource.id);
            await request(app)
                .get(`/api/story-studio/projects/${created.body.project.id}/resources/characters/${imported.body.resource.id}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
        } finally {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    });
});
