import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import {
    PROFILE_EDITOR_TABS,
    buildCompatibilityReport,
    buildResourceCompatibilityReport,
    buildProfileChanges,
    assembleProfilePreview,
    compileProfilePreview,
    createProfileEditorDraft,
    isPromptProfileV2,
    projectPromptProfileDiagnostics,
} from '../public/prompt-profile-ui.js';

function resource(overrides = {}) {
    return {
        schemaVersion: 1,
        type: 'prompt-profile',
        id: 'profile-one',
        projectId: 'project-one',
        revision: 3,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T01:00:00.000Z',
        name: '正文配置',
        profileVersion: 2,
        generation: { temperature: 0.7, topP: 0.9 },
        modules: [
            { id: 'system', name: '系统', slot: 'main', role: 'system', template: '写作 {{tone}}', enabled: true, priority: 10, tokenBudget: null, clipPolicy: 'tail', requires: [], conflicts: [], exclusiveGroup: null, when: null, sourceRef: null, includeData: true, marker: false },
            { id: 'task', name: '任务', slot: 'task', role: 'user', template: '', enabled: true, priority: 20, tokenBudget: null, clipPolicy: 'middle', requires: ['system'], conflicts: [], exclusiveGroup: null, when: null, sourceRef: null, includeData: true, marker: true },
        ],
        order: ['system', 'task'],
        variables: [{ id: 'tone', type: 'single', options: ['克制', '激烈'], default: '克制' }],
        variableValues: { tone: '克制' },
        generationPolicies: { creative: { temperature: 0.9, topP: 0.95 } },
        taskPolicies: { draft: { generation: { temperature: 0.85 }, variables: { tone: '激烈' } } },
        tokenBudget: 4_000,
        characterBudget: 16_000,
        compatibility: {
            sourceFormat: 'sillytavern-openai',
            promptOrderMode: 'flat',
            warnings: [{ code: 'unknown_macro', message: 'Unknown macro', moduleId: 'system' }],
            unsupportedFeatures: ['unknown_macro'],
        },
        source: { removedSensitiveFields: ['api_key'] },
        ...overrides,
    };
}

describe('Prompt Profile V2 UI model', () => {
    test('detects V2 without treating legacy resources as editable V2', () => {
        assert.equal(isPromptProfileV2(resource()), true);
        assert.equal(isPromptProfileV2(resource({ profileVersion: undefined, modules: undefined, order: undefined })), false);
        assert.deepEqual(PROFILE_EDITOR_TABS.map(tab => tab.id), [
            'overview', 'modules', 'variables', 'tasks', 'compatibility', 'preview',
        ]);
    });

    test('creates stable editable text and parses only server-supported profile fields', () => {
        const input = resource();
        const draft = createProfileEditorDraft(input);
        assert.equal(draft.name, '正文配置');
        assert.match(draft.modulesText, /"system"/);
        assert.match(draft.taskPoliciesText, /"draft"/);
        assert.match(draft.variableValuesText, /"tone"/);
        assert.match(draft.generationPoliciesText, /"creative"/);
        assert.equal(draft.tokenBudget, '4000');
        assert.equal(draft.characterBudget, '16000');

        draft.name = '正文配置 V2';
        draft.generationText = '{"temperature":0.6,"seed":12}';
        const changes = buildProfileChanges(draft);
        assert.deepEqual(Object.keys(changes), [
            'name', 'generation', 'profileVersion', 'modules', 'order', 'variables', 'variableValues',
            'generationPolicies', 'taskPolicies', 'tokenBudget', 'characterBudget',
        ]);
        assert.equal(changes.name, '正文配置 V2');
        assert.equal(changes.generation.seed, 12);
        assert.equal(changes.profileVersion, 2);
        assert.equal(changes.tokenBudget, 4_000);
        assert.equal(changes.characterBudget, 16_000);
        assert.equal(Object.hasOwn(changes, 'source'), false);
        assert.equal(Object.hasOwn(changes, 'compatibility'), false);
        assert.deepEqual(input.generation, { temperature: 0.7, topP: 0.9 });
    });

    test('returns field-specific parse errors for invalid editor JSON', () => {
        const draft = createProfileEditorDraft(resource());
        draft.modulesText = '{bad json';
        assert.throws(() => buildProfileChanges(draft), error => (
            error.name === 'PromptProfileEditorError'
            && error.field === 'modules'
            && /模块/.test(error.message)
        ));
    });

    test('compiles current unsaved fields with task variables and literal slot data', () => {
        const draft = createProfileEditorDraft(resource());
        const result = compileProfilePreview(draft, {
            task: 'draft',
            variablesText: '{"tone":"克制"}',
            characterBudget: 2_000,
            tokenBudget: 500,
            context: { projectTitle: '样本书' },
            slotValues: { main: '系统资料 {{tone}}', task: '只输出正文' },
        });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.modules.map(module => module.id), ['system', 'task']);
        assert.match(result.messages[0].content, /写作 克制/);
        assert.match(result.messages[0].content, /系统资料 \{\{tone\}\}/);
        assert.equal(result.generation.temperature, 0.85);
        assert.match(result.profileHash, /^[a-f0-9]{64}$/);
    });

    test('assembles the final StoryStudio runtime, managed context, profile, and task messages', () => {
        const draft = createProfileEditorDraft(resource());
        const result = assembleProfilePreview(draft, {
            task: 'draft',
            variablesText: '{"tone":"克制"}',
            baseSystemPrompt: 'RUNTIME CONTRACT',
            taskText: 'FINAL STORY TASK',
            project: {
                id: 'project-one',
                title: '样本书',
                genre: '科幻',
                story: { premise: '夺回旧城', world: '旧城被封锁' },
                continuity: [{ id: 'ledger-one', label: '钥匙', detail: '仍在主角手中' }],
            },
            chapter: { id: 'chapter-one', number: 3, title: '回城', card: { goal: '穿过封锁' }, content: '' },
            resources: { taskKind: 'draft' },
            provider: { protocol: 'openai-chat', model: 'writer' },
            promptLimit: 20_000,
        });

        assert.deepEqual(result.errors, []);
        assert.ok(result.messages.some(message => message.content.includes('RUNTIME CONTRACT')));
        assert.ok(result.messages.some(message => message.content.includes('FINAL STORY TASK')));
        assert.ok(result.messages.some(message => message.content.includes('旧城被封锁')));
        assert.ok(result.messages.some(message => message.content.includes('写作 克制')));
        assert.ok(result.modules.some(module => module.slot === 'runtime'));
        assert.ok(result.modules.some(module => module.slot === 'managedContext'));
        assert.ok(result.modules.some(module => module.slot === 'task'));
    });

    test('collapses imported compatibility and security evidence into one report', () => {
        const report = buildCompatibilityReport(resource());
        assert.equal(report.mode, 'v2');
        assert.equal(report.sourceFormat, 'sillytavern-openai');
        assert.deepEqual(report.removedSensitiveFields, ['api_key']);
        assert.deepEqual(report.unsupportedFeatures, ['unknown_macro']);
        assert.equal(report.warnings.length, 1);

        const legacy = buildCompatibilityReport(resource({
            profileVersion: undefined,
            modules: undefined,
            order: undefined,
            compatibility: undefined,
        }));
        assert.equal(legacy.mode, 'legacy');
        assert.ok(legacy.warnings.some(item => item.code === 'legacy_profile'));
    });

    test('projects compatibility warnings for non-prompt SillyTavern resources', () => {
        const report = buildResourceCompatibilityReport({
            type: 'lorebook',
            source: {
                format: 'sillytavern-world-info',
                warnings: ['metadata_note'],
                compatibilityWarnings: [{
                    code: 'unsupported_lorebook_recursion',
                    message: 'Recursive scanning is preserved but not executed.',
                }],
            },
        });

        assert.equal(report.sourceFormat, 'sillytavern-world-info');
        assert.deepEqual(report.warnings.map(item => item.code), [
            'unsupported_lorebook_recursion',
            'metadata_note',
        ]);
        assert.deepEqual(report.unsupportedFeatures, []);
        assert.deepEqual(report.removedSensitiveFields, []);
    });

    test('projects compiler diagnostics from both local results and generation previews', () => {
        const compiled = compileProfilePreview(createProfileEditorDraft(resource()), {
            task: 'draft',
            slotValues: { main: '系统资料', task: '正文任务' },
        });
        const direct = projectPromptProfileDiagnostics({ promptProfile: compiled });
        assert.equal(direct.profileHash, compiled.profileHash);
        assert.equal(direct.modules.length, 2);
        assert.equal(direct.messages.length, 2);

        const nested = projectPromptProfileDiagnostics({
            activePromptProfileId: 'profile-one',
            profile: {
                profileHash: 'abc',
                taskPolicy: 'draft',
                modules: [{ id: 'main', included: true, compiledCharacters: 10, originalCharacters: 12, truncated: true, reason: null }],
                warnings: [{ code: 'module_clipped' }],
                errors: [],
                messages: [{ role: 'system', content: 'x' }],
            },
        });
        assert.equal(nested.activeProfileId, 'profile-one');
        assert.equal(nested.task, 'draft');
        assert.equal(nested.modules[0].truncated, true);
        assert.equal(nested.warnings[0].code, 'module_clipped');
    });

    test('ships accessible editor and Context Inspector surfaces', () => {
        const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
        const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
        const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
        assert.match(html, /id="ss_profile_editor"/);
        assert.match(html, /id="ss_resource_compatibility"/);
        assert.match(html, /id="ss_resource_compatibility_warnings"/);
        assert.match(html, /data-profile-tab="preview"/);
        assert.match(html, /id="ss_profile_save"/);
        assert.match(html, /id="ss_context_profile"/);
        assert.match(html, /id="ss_context_messages"/);
        assert.match(css, /\.ss-profile-tabs/);
        assert.match(css, /\.ss-resource-compatibility/);
        assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.ss-profile-editor/);
        assert.match(app, /confirmProjectReplacement\('新建作品'/);
        assert.match(app, /confirmProjectReplacement\('切换作品'/);
        assert.match(app, /confirmProjectReplacement\('导入作品'/);
        assert.match(app, /refreshAfterResourceConflict\(projectId, \{ preserveProfileDraft: true \}\)/);
        assert.match(app, /buildResourceCompatibilityReport\(resource\)/);
    });
});
