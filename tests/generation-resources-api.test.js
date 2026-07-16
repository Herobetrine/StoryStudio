import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';

function characterCard() {
    return {
        name: '林照', description: '谨慎的入城者', personality: '克制', scenario: '抵达赤门',
        first_mes: '', mes_example: '', system_prompt: '写作系统：{{original}}\n保持人物克制。',
        post_history_instructions: '不要替人物解释动机。',
    };
}

describe('active compatibility resources in generation context', () => {
    let dataRoot;
    let app;
    let csrfToken;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-generation-resources-'));
        app = createApp({ dataRoot });
        const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
        csrfToken = bootstrap.body.csrfToken;
        await request(app)
            .put('/api/provider')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                protocol: 'openai-chat', baseUrl: 'http://model.local/v1', model: 'writer', contextTokens: 32_768,
                maxTokens: 8_192, temperature: 0.7, topP: 1, topK: 0, stop: [], jsonSchema: true,
            })
            .expect(200);
    });

    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    test('compiles active Character Card, Persona, World Info, and Prompt Profile with diagnostics', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '资源上下文' })
            .expect(201);
        let project = created.body.project;
        let chapter = created.body.chapter;
        const projectId = project.id;
        const chapterId = chapter.id;
        const importResource = async (fileName, data) => {
            const imported = await request(app)
                .post(`/api/story-studio/projects/${projectId}/resources/import`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    projectVersion: project.version,
                    import: { fileName, mediaType: 'application/json', encoding: 'json', data },
                })
                .expect(201);
            project = imported.body.project;
            return imported.body.resource;
        };
        let character = await importResource('lin.json', characterCard());
        const lorebook = await importResource('gate.json', {
            name: '赤门世界书',
            entries: {
                1: { uid: 1, key: ['赤门'], content: '赤门只在日落前开启。', disable: false, constant: false, order: 100, position: 0 },
                2: { uid: 2, key: ['白塔'], content: '白塔位于北境。', disable: false, constant: false, order: 90, position: 0 },
            },
        });
        const profile = await importResource('writer-profile.json', {
            name: '克制写法',
            temperature: 0.55,
            top_p: 0.82,
            prompts: [{ identifier: 'main', role: 'system', content: '只写具有因果结果的场景。' }],
        });
        const enabledInstruction = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/resources/characters/${character.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                revision: character.revision,
                changes: { instructionEnabled: true },
            })
            .expect(200);
        project = enabledInstruction.body.project;
        character = enabledInstruction.body.resource;
        const activated = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/resources/activation`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                changes: {
                    activeCharacterIds: [character.id],
                    activeLorebookIds: [lorebook.id],
                    activePromptProfileId: profile.id,
                    activePersonaId: character.id,
                },
            })
            .expect(200);
        project = activated.body;
        const updated = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                revision: chapter.revision,
                changes: { card: { goal: '在日落前穿过赤门' } },
            })
            .expect(200);
        project = updated.body.project;
        chapter = updated.body.chapter;

        const storyStateUpdate = await request(app)
            .patch(`/api/story-studio/projects/${projectId}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                version: project.version,
                changes: {
                    storyState: {
                        entities: [
                            { id: 'entity-gate', kind: 'setting', name: '赤门', summary: '城门设定', aliases: [], status: 'active' },
                            { id: 'entity-remote', kind: 'character', name: '远山老人', summary: '未在本章出现', aliases: [], status: 'active' },
                        ],
                        relations: [],
                        events: [],
                        promises: [
                            {
                                id: 'promise-open', title: '赤门之约', summary: '自动命中的开放事项',
                                introducedChapterId: null, dueChapterId: null, resolvedChapterId: null, status: 'open',
                            },
                            {
                                id: 'promise-manual', title: '白塔之约', summary: '只由作者手工包含',
                                introducedChapterId: null, dueChapterId: null, resolvedChapterId: null, status: 'resolved',
                            },
                        ],
                        memory: [],
                    },
                },
            })
            .expect(200);
        project = storyStateUpdate.body;

        const preview = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft',
                mode: 'generate',
                projectVersion: project.version,
                chapterRevision: chapter.revision,
                contextOverrides: {
                    includeEntityIds: ['entity-remote'],
                    excludeEntityIds: ['entity-gate'],
                    includePromiseIds: ['promise-manual'],
                    excludePromiseIds: ['promise-open'],
                },
            })
            .expect(200);
        assert.match(preview.body.systemPrompt, /具有因果结果/);
        assert.match(preview.body.systemPrompt, /保持人物克制/);
        assert.match(preview.body.prompt, /谨慎的入城者/);
        assert.match(preview.body.prompt, /赤门只在日落前开启/);
        assert.match(preview.body.prompt, /作者化身|林照/);
        assert.equal(preview.body.diagnostics.activePromptProfileId, profile.id);
        assert.equal(preview.body.diagnostics.activePersonaId, character.id);
        assert.deepEqual(preview.body.diagnostics.activeCharacterIds, [character.id]);
        assert.deepEqual(preview.body.diagnostics.activeLorebookIds, [lorebook.id]);
        assert.equal(preview.body.diagnostics.activatedLore[0].id, '1');
        assert.deepEqual(preview.body.diagnostics.skippedLore, [{ id: '2', reason: 'primary_miss' }]);
        assert.match(preview.body.prompt, /entity-remote/);
        assert.match(preview.body.prompt, /promise-manual/);
        assert.doesNotMatch(preview.body.prompt, /entity-gate/);
        assert.doesNotMatch(preview.body.prompt, /promise-open/);
        assert.deepEqual(preview.body.diagnostics.storyContext.overrides, {
            includeEntityIds: ['entity-remote'],
            excludeEntityIds: ['entity-gate'],
            includePromiseIds: ['promise-manual'],
            excludePromiseIds: ['promise-open'],
        });

        const invalidProfile = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/resources/prompt-profiles/${profile.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                revision: profile.revision,
                changes: {
                    modules: profile.modules.map((module, index) => index === 0
                        ? { ...module, when: { javascript: 'return true' } }
                        : module),
                },
            })
            .expect(200);
        project = invalidProfile.body.project;
        const rejected = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft',
                mode: 'generate',
                projectVersion: project.version,
                chapterRevision: chapter.revision,
            })
            .expect(400);
        assert.equal(rejected.body.error, 'invalid_prompt_profile');
        assert.equal(rejected.body.errors[0].code, 'invalid_condition');
    });

    test('applies task-specific Profile V2 context and output budgets before provider normalization', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: '任务预算' })
            .expect(201);
        const projectId = created.body.project.id;
        const chapterId = created.body.chapter.id;
        const imported = await request(app)
            .post(`/api/story-studio/projects/${projectId}/resources/import`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: created.body.project.version,
                import: {
                    fileName: 'native-v2.json',
                    mediaType: 'application/json',
                    encoding: 'json',
                    data: {
                        name: '任务预算 V2',
                        profileVersion: 2,
                        generation: { temperature: 0.5 },
                        modules: [{ id: 'style', name: 'Style', slot: 'main', role: 'system', template: '保持紧凑。' }],
                        order: ['style'],
                        variables: [],
                        variableValues: {},
                        generationPolicies: {},
                        taskPolicies: { draft: { generation: { contextTokens: 4_096, maxTokens: 1_024 } } },
                        compatibility: {},
                    },
                },
            })
            .expect(201);
        const activated = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/resources/activation`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: imported.body.project.version,
                changes: { activePromptProfileId: imported.body.resource.id },
            })
            .expect(200);
        const preview = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft',
                mode: 'generate',
                projectVersion: activated.body.version,
                chapterRevision: created.body.chapter.revision,
            })
            .expect(200);

        assert.equal(preview.body.diagnostics.contextTokens, 4_096);
        assert.equal(preview.body.diagnostics.responseTokens, 1_024);
        assert.equal(preview.body.diagnostics.profile.taskPolicy, 'draft');
        assert.equal(preview.body.diagnostics.profile.generation.maxTokens, 1_024);
        assert.ok(Array.isArray(preview.body.messages));
    });

    test('executes imported formatting context once and reports unsupported preset semantics end to end', async () => {
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: 'Formatting Bundle 执行' })
            .expect(201);
        let project = created.body.project;
        const chapter = created.body.chapter;
        const projectId = project.id;
        const importResource = async (fileName, data) => {
            const imported = await request(app)
                .post(`/api/story-studio/projects/${projectId}/resources/import`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    projectVersion: project.version,
                    import: { fileName, mediaType: 'application/json', encoding: 'json', data },
                })
                .expect(201);
            project = imported.body.project;
            return imported.body.resource;
        };
        const character = await importResource('character.json', {
            ...characterCard(),
            description: 'UNIQUE_CHARACTER_DESCRIPTION',
            personality: 'UNIQUE_CHARACTER_PERSONALITY',
        });
        const profile = await importResource('formatting-bundle.json', {
            instruct: { name: 'Story', input_sequence: '', output_sequence: '', wrap: true },
            context: { name: 'Story Context', story_string: 'CONTEXT_STORY_EXECUTED {{projectTitle}}' },
            reasoning: { name: 'Reasoning', prefix: '<think>', suffix: '</think>', separator: '\n' },
            preset: {
                temperature: 0.6,
                assistant_prefill: 'PREFILL_SENTINEL',
                prompts: [
                    { identifier: 'main', name: 'Main', role: 'system', content: 'PROFILE_MAIN' },
                    { identifier: 'charDescription', name: 'Description', role: 'system', marker: true },
                    { identifier: 'charPersonality', name: 'Personality', role: 'system', marker: true },
                    { identifier: 'chatHistory', name: 'History', role: 'system', marker: true },
                    { identifier: 'depthPrompt', name: 'Depth', role: 'system', content: 'DEPTH_CONTENT', position: 1, injection_depth: 4 },
                ],
                prompt_order: [{
                    character_id: 100001,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'charDescription', enabled: true },
                        { identifier: 'charPersonality', enabled: true },
                        { identifier: 'depthPrompt', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                    ],
                }],
            },
        });
        const activated = await request(app)
            .patch(`/api/story-studio/projects/${projectId}/resources/activation`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: project.version,
                changes: { activeCharacterIds: [character.id], activePromptProfileId: profile.id },
            })
            .expect(200);

        const preview = await request(app)
            .post(`/api/story-studio/projects/${projectId}/chapters/${chapter.id}/generation-preview`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                kind: 'draft', mode: 'generate',
                projectVersion: activated.body.version,
                chapterRevision: chapter.revision,
            })
            .expect(200);
        const messageText = preview.body.messages.map(message => message.content).join('\n\n');
        assert.equal((messageText.match(/CONTEXT_STORY_EXECUTED/g) ?? []).length, 1);
        assert.equal((messageText.match(/UNIQUE_CHARACTER_DESCRIPTION/g) ?? []).length, 1);
        assert.equal((messageText.match(/UNIQUE_CHARACTER_PERSONALITY/g) ?? []).length, 1);
        assert.equal(preview.body.diagnostics.profile.generation.assistantPrefill, 'PREFILL_SENTINEL');
        assert.ok(preview.body.diagnostics.providerAdapter.droppedParameters
            .some(item => item.field === 'assistantPrefill'));
        const compatibilityWarnings = preview.body.diagnostics.profile.compatibility.warnings;
        assert.ok(compatibilityWarnings.some(item => item.code === 'unsupported_reasoning'));
        assert.deepEqual(
            compatibilityWarnings.filter(item => item.code === 'unsupported_prompt_field').map(item => item.feature),
            ['position', 'injection_depth'],
        );
        assert.doesNotMatch(messageText, /<think>|<\/think>/);
    });
});
