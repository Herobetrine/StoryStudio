import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import {
    STORY_STUDIO_SCHEMA_VERSION,
    StoryStudioError,
    StoryStudioStore,
} from '../src/story-studio-store.js';

const LOCAL_HOST = '127.0.0.1:8123';
const STORY_STATE_CATEGORIES = [
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
];
let rootDirectory;
let store;

function hasCode(code) {
    return error => {
        assert.ok(error instanceof StoryStudioError);
        assert.equal(error.code, code);
        return true;
    };
}

function adoption(chapterId, overrides = {}) {
    return {
        generationId: 'generation-1',
        kind: 'chapter-draft',
        content: { mode: 'replace', text: '城门在雨中关闭。' },
        chapterSummary: '主角在封城前进入内城。',
        storyStateChanges: {
            entities: {
                upsert: [
                    { id: 'hero', kind: 'character', name: '林默', summary: '刚进入内城。' },
                    { id: 'gate', kind: 'location', name: '北门' },
                ],
            },
            relations: {
                upsert: [{
                    id: 'hero-at-gate', fromEntityId: 'hero', toEntityId: 'gate',
                    kind: 'located-at', summary: '林默从北门入城。',
                }],
            },
            events: {
                upsert: [{
                    id: 'event-entry', title: '雨夜入城', chapterId, entityIds: ['hero', 'gate'], order: 1,
                }],
            },
            promises: {
                upsert: [{
                    id: 'promise-bell', title: '午夜钟声的来源', introducedChapterId: chapterId,
                }],
            },
            memory: {
                upsert: [{
                    id: 'memory-entry', summary: '林默已进入内城，北门随后封闭。', chapterId, importance: 4,
                }],
            },
        },
        ...overrides,
    };
}

function seedStoryState(project, chapter, storyState, generationId = 'seed-story-state') {
    const storyStateChanges = {};
    for (const category of STORY_STATE_CATEGORIES) {
        if (Array.isArray(storyState[category]) && storyState[category].length > 0) {
            storyStateChanges[category] = { upsert: storyState[category] };
        }
    }
    return store.adoptGeneration(project.id, chapter.id, project.version, chapter.revision, {
        generationId,
        storyStateChanges,
    });
}

beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-state-'));
    store = new StoryStudioStore(rootDirectory);
});

afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('Story Studio distilled story state', () => {
    test('migrates V1 and V2 storage without losing V2 resource references', () => {
        for (const sourceVersion of [1, 2]) {
            const { project, chapter } = store.createProject({ title: `旧项目-${sourceVersion}` });
            const storedProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
            const storedChapter = JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
            storedProject.schemaVersion = sourceVersion;
            storedChapter.schemaVersion = sourceVersion;
            delete storedProject.storyState;
            delete storedProject.volumes;
            for (const summary of storedProject.chapters) {
                delete summary.volumeId;
                delete summary.planBasis;
            }
            delete storedChapter.generationHistory;
            delete storedChapter.volumeId;
            delete storedChapter.planBasis;
            if (sourceVersion === 1) {
                delete storedProject.resources;
            } else {
                delete storedProject.resources.activePersonaId;
            }
            storedProject.chapterBytes = Buffer.byteLength(JSON.stringify(storedChapter), 'utf8');
            fs.writeFileSync(store.projectPath(project.id), JSON.stringify(storedProject), 'utf8');
            fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(storedChapter), 'utf8');

            const migrated = store.getProject(project.id);
            const migratedChapter = store.getChapter(project.id, chapter.id);
            assert.equal(migrated.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
            assert.equal(migrated.version, project.version + 1);
            assert.deepEqual(migrated.storyState, {
                entities: [], relations: [], events: [], promises: [], memory: [],
                facts: [], knowledge: [], timeline: [],
            });
            assert.deepEqual(migrated.resources, {
                ...(storedProject.resources ?? {
                    characterIds: [], lorebookIds: [], promptProfileIds: [],
                    activeCharacterIds: [], activeLorebookIds: [], activePromptProfileId: null,
                }),
                activePersonaId: null,
            });
            assert.equal(migratedChapter.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
            assert.deepEqual(migratedChapter.generationHistory, []);
        }
    });

    test('persists the Persona default for V3 storage created before the additive field', () => {
        const { project, chapter } = store.createProject({ title: '旧 V3 Persona 默认值' });
        const stored = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        const storedChapter = JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
        stored.schemaVersion = 3;
        delete stored.volumes;
        delete stored.storyState.facts;
        delete stored.storyState.knowledge;
        delete stored.storyState.timeline;
        for (const summary of stored.chapters) {
            delete summary.volumeId;
            delete summary.planBasis;
        }
        delete stored.resources.activePersonaId;
        storedChapter.schemaVersion = 3;
        delete storedChapter.volumeId;
        delete storedChapter.planBasis;
        stored.chapterBytes = Buffer.byteLength(JSON.stringify(storedChapter), 'utf8');
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(stored), 'utf8');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(storedChapter), 'utf8');

        const migrated = store.getProject(project.id);
        const persisted = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        assert.equal(migrated.schemaVersion, STORY_STUDIO_SCHEMA_VERSION);
        assert.equal(migrated.version, project.version + 1);
        assert.equal(migrated.resources.activePersonaId, null);
        assert.equal(Object.hasOwn(persisted.resources, 'activePersonaId'), true);
        assert.equal(persisted.resources.activePersonaId, null);
    });

    test('protects authoritative V5 collections from project creation and ordinary updates', () => {
        const createCases = [
            {
                storyState: { facts: [{ id: 'fact-create', summary: '创建时注入事实。' }] },
                fields: ['facts'],
            },
            {
                storyState: { timeline: [{ id: 'timeline-create', label: '创建时注入时间点' }] },
                fields: ['timeline'],
            },
            {
                storyState: {
                    knowledge: [{
                        id: 'knowledge-create', entityId: 'hero-create', factId: 'fact-knowledge-create', stance: 'knows',
                    }],
                },
                fields: ['knowledge'],
            },
        ];
        for (const testCase of createCases) {
            assert.throws(
                () => store.createProject({ title: '禁止注入', storyState: testCase.storyState }),
                error => {
                    assert.ok(error instanceof StoryStudioError);
                    assert.equal(error.status, 400);
                    assert.equal(error.code, 'protected_story_state');
                    assert.deepEqual(error.details.fields, testCase.fields);
                    return true;
                },
            );
            assert.deepEqual(store.listProjects(), []);
        }

        const { project, chapter } = store.createProject({ title: '权威状态边界' });
        const emptyProjectPath = store.projectPath(project.id);
        const emptyChapterPath = store.chapterPath(project.id, chapter.id);
        const emptyProjectBytes = fs.readFileSync(emptyProjectPath, 'utf8');
        const emptyChapterBytes = fs.readFileSync(emptyChapterPath, 'utf8');
        const emptyUpdateCases = [
            {
                state: {
                    ...project.storyState,
                    facts: [{ id: 'fact-empty-update', summary: '空项目注入事实。' }],
                },
                fields: ['facts'],
            },
            {
                state: {
                    ...project.storyState,
                    timeline: [{ id: 'timeline-empty-update', label: '空项目注入时间点' }],
                },
                fields: ['timeline'],
            },
            {
                state: {
                    ...project.storyState,
                    entities: [{ id: 'hero-empty-update', name: '林默' }],
                    facts: [{ id: 'fact-knowledge-empty-update', summary: '林默知道暗号。' }],
                    knowledge: [{
                        id: 'knowledge-empty-update', entityId: 'hero-empty-update',
                        factId: 'fact-knowledge-empty-update', stance: 'knows',
                    }],
                },
                fields: ['facts', 'knowledge'],
            },
        ];
        for (const testCase of emptyUpdateCases) {
            assert.throws(
                () => store.updateProject(project.id, project.version, { storyState: testCase.state }),
                error => {
                    assert.ok(error instanceof StoryStudioError);
                    assert.equal(error.status, 400);
                    assert.equal(error.code, 'protected_story_state');
                    assert.deepEqual(error.details.fields, testCase.fields);
                    return true;
                },
            );
            assert.equal(fs.readFileSync(emptyProjectPath, 'utf8'), emptyProjectBytes);
            assert.equal(fs.readFileSync(emptyChapterPath, 'utf8'), emptyChapterBytes);
            assert.equal(store.getProject(project.id).version, project.version);
        }
        const seeded = seedStoryState(project, chapter, {
            entities: [{ id: 'hero', name: '林默' }],
            facts: [{ id: 'fact-authoritative', summary: '北门已经关闭。', subjectEntityId: 'hero' }],
            knowledge: [{
                id: 'knowledge-authoritative', entityId: 'hero', factId: 'fact-authoritative', stance: 'knows',
            }],
            timeline: [{ id: 'timeline-authoritative', label: '雨夜封城', chapterId: chapter.id }],
        }, 'seed-protected-boundary');
        const projectPath = store.projectPath(project.id);
        const chapterPath = store.chapterPath(project.id, chapter.id);
        const projectBefore = fs.readFileSync(projectPath, 'utf8');
        const chapterBefore = fs.readFileSync(chapterPath, 'utf8');
        const updateCases = [
            {
                field: 'facts',
                value: seeded.project.storyState.facts.map(fact => ({ ...fact, summary: '伪造后的事实。' })),
            },
            {
                field: 'knowledge',
                value: seeded.project.storyState.knowledge.map(item => ({ ...item, stance: 'suspects' })),
            },
            {
                field: 'timeline',
                value: seeded.project.storyState.timeline.map(item => ({ ...item, label: '被改写的时间点' })),
            },
        ];
        for (const testCase of updateCases) {
            assert.throws(
                () => store.updateProject(project.id, seeded.project.version, {
                    storyState: { ...seeded.project.storyState, [testCase.field]: testCase.value },
                }),
                error => {
                    assert.ok(error instanceof StoryStudioError);
                    assert.equal(error.status, 400);
                    assert.equal(error.code, 'protected_story_state');
                    assert.deepEqual(error.details.fields, [testCase.field]);
                    return true;
                },
            );
            assert.equal(fs.readFileSync(projectPath, 'utf8'), projectBefore);
            assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterBefore);
        }

        const compatible = store.updateProject(project.id, seeded.project.version, {
            storyState: {
                ...seeded.project.storyState,
                memory: [{ id: 'manual-memory', summary: '作者补充的旧五类记录。', chapterId: chapter.id }],
            },
        });
        assert.deepEqual(compatible.storyState.facts, seeded.project.storyState.facts);
        assert.deepEqual(compatible.storyState.knowledge, seeded.project.storyState.knowledge);
        assert.deepEqual(compatible.storyState.timeline, seeded.project.storyState.timeline);
        assert.equal(compatible.storyState.memory[0].summary, '作者补充的旧五类记录。');
    });

    test('adopts body, summary, and all distilled state classes in one transaction', () => {
        const { project, chapter } = store.createProject({ title: '采纳测试' });
        const result = store.adoptGeneration(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            adoption(chapter.id),
        );

        assert.equal(result.idempotent, false);
        assert.equal(result.project.version, 2);
        assert.equal(result.chapter.revision, 2);
        assert.equal(result.chapter.content, '城门在雨中关闭。');
        assert.equal(result.chapter.card.summary, '主角在封城前进入内城。');
        assert.equal(result.project.storyState.entities.length, 2);
        assert.equal(result.project.storyState.relations[0].fromEntityId, 'hero');
        assert.equal(result.project.storyState.events[0].chapterId, chapter.id);
        assert.equal(result.project.storyState.promises[0].status, 'open');
        assert.equal(result.project.storyState.memory[0].importance, 4);
        assert.equal(result.chapter.generationHistory.length, 1);
        assert.equal(result.chapter.generationHistory[0].generationId, 'generation-1');
        assert.match(result.chapter.generationHistory[0].payloadHash, /^[0-9a-f]{64}$/);
        assert.equal(Object.hasOwn(result.chapter.generationHistory[0], 'content'), false);
    });

    test('normalizes the complete V5 state graph and enforces bounded fields and references', () => {
        const { project, chapter } = store.createProject({ title: 'V5 状态图' });
        const updated = seedStoryState(project, chapter, {
                entities: [
                    {
                        id: 'capital', kind: 'location', name: '天衢城', status: 'active',
                        currentGoal: '', currentAction: '',
                    },
                    {
                        id: 'hero', kind: 'character', name: '林默', status: 'active',
                        locationEntityId: 'capital', currentGoal: '进入内城', currentAction: '寻找守门人',
                        updatedChapterId: chapter.id,
                    },
                ],
                relations: [{
                    id: 'hero-mentor', fromEntityId: 'hero', toEntityId: 'capital', kind: 'bound-to',
                    summary: '林默受城契约约束。', addressing: '城主', publicSummary: '公开盟约',
                    privateSummary: '隐藏代价', sinceChapterId: chapter.id,
                }],
                timeline: [{
                    id: 'time-entry', label: '雨夜入城', storyTime: '玄历七年秋', sequence: 3,
                    chapterId: chapter.id, locationEntityId: 'capital', status: 'occurred',
                }],
                events: [{
                    id: 'event-entry', title: '林默入城', chapterId: chapter.id,
                    entityIds: ['hero', 'capital'], timelineId: 'time-entry', locationEntityId: 'capital',
                    progress: 100, visibility: 'private',
                }],
                promises: [{
                    id: 'promise-gate', title: '城门契约的代价', introducedChapterId: chapter.id,
                    kind: 'mystery', urgency: 5, evidenceChapterIds: [chapter.id],
                }],
                memory: [
                    {
                        id: 'memory-current', summary: '林默已进入天衢城。', chapterId: chapter.id,
                        status: 'active', confidence: 0.9, sourceChapterIds: [chapter.id],
                    },
                    {
                        id: 'memory-old', summary: '林默仍在城外。', status: 'superseded',
                        supersededById: 'memory-current', confidence: 0.2,
                    },
                ],
                facts: [
                    {
                        id: 'fact-current', summary: '北门已经关闭。', subjectEntityId: 'capital',
                        sourceChapterId: chapter.id, confidence: 0.95, tags: ['城门'],
                    },
                    {
                        id: 'fact-old', summary: '北门仍然开放。', subjectEntityId: 'capital',
                        status: 'active', supersededById: 'fact-current', confidence: 0.1,
                    },
                ],
                knowledge: [{
                    id: 'knowledge-hero-gate', entityId: 'hero', factId: 'fact-current',
                    stance: 'knows', learnedChapterId: chapter.id, status: 'active',
                }],
        }).project;

        assert.equal(updated.schemaVersion, 5);
        assert.equal(updated.storyState.entities[1].locationEntityId, 'capital');
        assert.equal(updated.storyState.relations[0].privateSummary, '隐藏代价');
        assert.equal(updated.storyState.events[0].progress, 100);
        assert.equal(updated.storyState.promises[0].urgency, 5);
        assert.equal(updated.storyState.memory[0].confidence, 0.9);
        assert.equal(updated.storyState.facts[1].status, 'retired');
        assert.equal(updated.storyState.knowledge[0].stance, 'knows');
        assert.equal(updated.storyState.timeline[0].sequence, 3);

        for (const changes of [
            { knowledge: [{ ...updated.storyState.knowledge[0], stance: 'guesses' }] },
            { events: [{ ...updated.storyState.events[0], progress: 101 }] },
            { promises: [{ ...updated.storyState.promises[0], urgency: 6 }] },
            { facts: [{ ...updated.storyState.facts[0], confidence: 1.01 }] },
            { facts: [{ ...updated.storyState.facts[0], supersededById: 'fact-current' }] },
        ]) {
            assert.throws(
                () => store.updateProject(project.id, updated.version, {
                    storyState: { ...updated.storyState, ...changes },
                }),
                error => ['invalid_story_state', 'invalid_number', 'invalid_story_reference'].includes(error.code),
            );
        }
        for (const changes of [
            {
                facts: [
                    { id: 'fact-a', summary: 'A', supersededById: 'fact-b' },
                    { id: 'fact-b', summary: 'B', supersededById: 'fact-a' },
                ],
                knowledge: [],
            },
            {
                memory: [
                    { id: 'memory-a', summary: 'A', supersededById: 'memory-b' },
                    { id: 'memory-b', summary: 'B', supersededById: 'memory-a' },
                ],
            },
        ]) {
            assert.throws(
                () => store.updateProject(project.id, updated.version, {
                    storyState: { ...updated.storyState, ...changes },
                }),
                hasCode('invalid_story_reference'),
            );
        }
        assert.deepEqual(store.getProject(project.id).storyState, updated.storyState);
    });

    test('applies V5 ChangeSet categories atomically and rejects referenced deletes', () => {
        const { project, chapter } = store.createProject({ title: 'V5 ChangeSet' });
        const seededResult = seedStoryState(project, chapter, {
                entities: [{ id: 'hero', kind: 'character', name: '林默' }],
                relations: [],
                timeline: [{ id: 'timeline-entry', label: '入城', chapterId: chapter.id }],
                events: [{ id: 'event-entry', title: '入城', timelineId: 'timeline-entry' }],
                promises: [], memory: [],
                facts: [{ id: 'fact-entry', summary: '林默已经入城。', subjectEntityId: 'hero' }],
                knowledge: [{ id: 'knowledge-entry', entityId: 'hero', factId: 'fact-entry', stance: 'believes' }],
        });
        const seeded = seededResult.project;
        const seededChapter = seededResult.chapter;
        const beforeProject = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const beforeChapter = fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8');

        for (const [generationId, storyStateChanges] of [
            ['delete-referenced-entity', { entities: { delete: ['hero'] } }],
            ['delete-referenced-fact', { facts: { delete: ['fact-entry'] } }],
            ['delete-referenced-timeline', { timeline: { delete: ['timeline-entry'] } }],
        ]) {
            assert.throws(
                () => store.adoptGeneration(
                    project.id,
                    chapter.id,
                    seeded.version,
                    seededChapter.revision,
                    { generationId, storyStateChanges },
                ),
                hasCode('invalid_story_reference'),
            );
            assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), beforeProject);
            assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), beforeChapter);
        }

        const removed = store.adoptGeneration(
            project.id,
            chapter.id,
            seeded.version,
            seededChapter.revision,
            {
                generationId: 'delete-complete-subgraph',
                storyStateChanges: {
                    knowledge: { delete: ['knowledge-entry'] },
                    facts: { delete: ['fact-entry'] },
                    events: { delete: ['event-entry'] },
                    timeline: { delete: ['timeline-entry'] },
                    entities: { delete: ['hero'] },
                },
            },
        );
        assert.deepEqual(removed.project.storyState.entities, []);
        assert.deepEqual(removed.project.storyState.facts, []);
        assert.deepEqual(removed.project.storyState.knowledge, []);
        assert.deepEqual(removed.project.storyState.timeline, []);
    });

    test('preserves established fact supersession links across ChangeSets and full-state edits', () => {
        const { project, chapter } = store.createProject({ title: '事实审计链' });
        const seededResult = seedStoryState(project, chapter, {
                facts: [
                    { id: 'fact-current', summary: '北门已经关闭。' },
                    { id: 'fact-alternate', summary: '西门仍然开放。' },
                    { id: 'fact-old', summary: '北门仍然开放。', supersededById: 'fact-current' },
                ],
        });
        const seeded = seededResult.project;
        const seededChapter = seededResult.chapter;
        const beforeProject = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const beforeChapter = fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8');

        for (const [generationId, storyStateChanges] of [
            ['delete-retired-fact', { facts: { delete: ['fact-old'] } }],
            ['clear-supersession', { facts: { upsert: [{ id: 'fact-old', supersededById: null }] } }],
            ['redirect-supersession', { facts: { upsert: [{ id: 'fact-old', supersededById: 'fact-alternate' }] } }],
        ]) {
            assert.throws(
                () => store.adoptGeneration(project.id, chapter.id, seeded.version, seededChapter.revision, {
                    generationId,
                    storyStateChanges,
                }),
                hasCode('immutable_fact_supersession'),
            );
            assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), beforeProject);
            assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), beforeChapter);
        }

        const oldFact = seeded.storyState.facts.find(fact => fact.id === 'fact-old');
        for (const facts of [
            seeded.storyState.facts.filter(fact => fact.id !== 'fact-old'),
            seeded.storyState.facts.map(fact => fact.id === 'fact-old'
                ? { ...fact, supersededById: null }
                : fact),
            seeded.storyState.facts.map(fact => fact.id === 'fact-old'
                ? { ...fact, supersededById: 'fact-alternate' }
                : fact),
        ]) {
            assert.throws(
                () => store.updateProject(project.id, seeded.version, {
                    storyState: { ...seeded.storyState, facts },
                }),
                hasCode('protected_story_state'),
            );
            assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), beforeProject);
        }

        const allowed = store.adoptGeneration(project.id, chapter.id, seeded.version, seededChapter.revision, {
            generationId: 'annotate-retired-fact',
            storyStateChanges: {
                facts: { upsert: [{ id: oldFact.id, summary: '旧说法：北门仍然开放。', confidence: 0.2 }] },
            },
        });
        const retained = allowed.project.storyState.facts.find(fact => fact.id === oldFact.id);
        assert.equal(retained.summary, '旧说法：北门仍然开放。');
        assert.equal(retained.confidence, 0.2);
        assert.equal(retained.status, 'retired');
        assert.equal(retained.supersededById, 'fact-current');
    });

    test('detaches every V5 chapter reference when a chapter is deleted', () => {
        const { project, chapter } = store.createProject({ title: 'V5 章节引用脱离' });
        const added = store.createChapter(project.id, project.version, { title: '保留章节' });
        const updated = seedStoryState(added.project, chapter, {
                entities: [{ id: 'hero', kind: 'character', name: '林默', updatedChapterId: chapter.id }],
                relations: [{ id: 'relation', fromEntityId: 'hero', toEntityId: 'hero', sinceChapterId: chapter.id }],
                events: [{ id: 'event', title: '旧章事件', chapterId: chapter.id }],
                promises: [{
                    id: 'promise', title: '旧章伏笔', introducedChapterId: chapter.id,
                    dueChapterId: chapter.id, resolvedChapterId: chapter.id, evidenceChapterIds: [chapter.id],
                }],
                memory: [{
                    id: 'memory', summary: '旧章记忆', chapterId: chapter.id, sourceChapterIds: [chapter.id],
                }],
                facts: [{ id: 'fact', summary: '旧章事实', sourceChapterId: chapter.id }],
                knowledge: [{
                    id: 'knowledge', entityId: 'hero', factId: 'fact', stance: 'knows', learnedChapterId: chapter.id,
                }],
                timeline: [{ id: 'timeline', label: '旧章时间点', chapterId: chapter.id }],
        });

        const result = store.deleteChapter(project.id, chapter.id, updated.project.version, updated.chapter.revision);
        const state = result.project.storyState;
        assert.equal(state.entities[0].updatedChapterId, null);
        assert.equal(state.relations[0].sinceChapterId, null);
        assert.equal(state.events[0].chapterId, null);
        assert.equal(state.promises[0].introducedChapterId, null);
        assert.equal(state.promises[0].dueChapterId, null);
        assert.equal(state.promises[0].resolvedChapterId, null);
        assert.deepEqual(state.promises[0].evidenceChapterIds, []);
        assert.equal(state.memory[0].chapterId, null);
        assert.deepEqual(state.memory[0].sourceChapterIds, []);
        assert.equal(state.facts[0].sourceChapterId, null);
        assert.equal(state.knowledge[0].learnedChapterId, null);
        assert.equal(state.timeline[0].chapterId, null);
    });

    test('remaps every V5 chapter reference during project export and import', async () => {
        const { project, chapter } = store.createProject({ title: 'V5 引用往返' });
        const updated = seedStoryState(project, chapter, {
                entities: [{ id: 'hero', kind: 'character', name: '林默', updatedChapterId: chapter.id }],
                relations: [{ id: 'relation', fromEntityId: 'hero', toEntityId: 'hero', sinceChapterId: chapter.id }],
                events: [{ id: 'event', title: '事件', chapterId: chapter.id }],
                promises: [{ id: 'promise', title: '伏笔', evidenceChapterIds: [chapter.id] }],
                memory: [{ id: 'memory', summary: '记忆', chapterId: chapter.id, sourceChapterIds: [chapter.id] }],
                facts: [{ id: 'fact', summary: '事实', sourceChapterId: chapter.id }],
                knowledge: [{
                    id: 'knowledge', entityId: 'hero', factId: 'fact', stance: 'knows', learnedChapterId: chapter.id,
                }],
                timeline: [{ id: 'timeline', label: '时间点', chapterId: chapter.id }],
        }).project;
        const restored = await store.importProject(await store.exportProject(project.id));
        const restoredChapterId = restored.chapter.id;
        const state = restored.project.storyState;

        assert.notEqual(restoredChapterId, chapter.id);
        assert.equal(state.entities[0].updatedChapterId, restoredChapterId);
        assert.equal(state.relations[0].sinceChapterId, restoredChapterId);
        assert.equal(state.events[0].chapterId, restoredChapterId);
        assert.deepEqual(state.promises[0].evidenceChapterIds, [restoredChapterId]);
        assert.equal(state.memory[0].chapterId, restoredChapterId);
        assert.deepEqual(state.memory[0].sourceChapterIds, [restoredChapterId]);
        assert.equal(state.facts[0].sourceChapterId, restoredChapterId);
        assert.equal(state.knowledge[0].learnedChapterId, restoredChapterId);
        assert.equal(state.timeline[0].chapterId, restoredChapterId);
        assert.equal(updated.storyState.timeline[0].chapterId, chapter.id);
    });

    test('lets the author edit typed story state through the normal optimistic project update', () => {
        const { project, chapter } = store.createProject({ title: '人工事实' });
        const updated = store.updateProject(project.id, project.version, {
            storyState: {
                entities: [{ id: 'author-entity', kind: 'character', name: '作者确认角色', summary: '权威事实', aliases: [], status: 'active' }],
                relations: [],
                events: [{
                    id: 'author-event', kind: 'story', title: '人工事件', summary: '由作者录入',
                    chapterId: chapter.id, entityIds: ['author-entity'], status: 'occurred', order: 1,
                }],
                promises: [],
                memory: [],
            },
        });
        assert.equal(updated.storyState.entities[0].name, '作者确认角色');
        assert.equal(updated.storyState.events[0].chapterId, chapter.id);
        assert.throws(
            () => store.updateProject(project.id, updated.version, {
                storyState: { ...updated.storyState, relations: [{
                    id: 'bad-relation', fromEntityId: 'missing', toEntityId: 'author-entity', kind: 'enemy', summary: '', status: 'active',
                }] },
            }),
            hasCode('invalid_story_reference'),
        );
        assert.deepEqual(store.getProject(project.id).storyState, updated.storyState);
    });

    test('merges repeated entity upserts and makes a retried append idempotent', () => {
        const { project, chapter } = store.createProject({ title: '幂等测试' });
        const payload = {
            generationId: 'generation-retry',
            content: { mode: 'append', text: '只追加一次。' },
            storyStateChanges: {
                entities: {
                    upsert: [
                        { id: 'hero', name: '林默', kind: 'character', summary: '初始摘要' },
                        { id: 'hero', summary: '合并后的摘要', status: 'wounded' },
                    ],
                },
            },
        };
        const first = store.adoptGeneration(project.id, chapter.id, project.version, chapter.revision, payload);
        const retried = store.adoptGeneration(project.id, chapter.id, project.version, chapter.revision, payload);

        assert.equal(first.project.storyState.entities.length, 1);
        assert.equal(first.project.storyState.entities[0].summary, '合并后的摘要');
        assert.equal(first.project.storyState.entities[0].status, 'wounded');
        assert.equal(retried.idempotent, true);
        assert.equal(retried.project.version, first.project.version);
        assert.equal(retried.chapter.revision, first.chapter.revision);
        assert.equal(retried.chapter.content, '只追加一次。');
        assert.equal(retried.chapter.generationHistory.length, 1);

        const chapterPath = store.chapterPath(project.id, chapter.id);
        const projectPath = store.projectPath(project.id);
        const expandedChapter = JSON.parse(fs.readFileSync(chapterPath, 'utf8'));
        const receipt = expandedChapter.generationHistory[0];
        for (let index = 0; index < 500; index += 1) {
            expandedChapter.generationHistory.push({
                ...receipt,
                generationId: `historical-${String(index).padStart(4, '0')}`,
                previousRevision: index + 2,
                resultingRevision: index + 3,
            });
        }
        fs.writeFileSync(chapterPath, JSON.stringify(expandedChapter), 'utf8');
        const expandedProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        expandedProject.chapterBytes = Buffer.byteLength(JSON.stringify(expandedChapter), 'utf8');
        fs.writeFileSync(projectPath, JSON.stringify(expandedProject), 'utf8');

        const next = store.adoptGeneration(
            project.id,
            chapter.id,
            first.project.version,
            first.chapter.revision,
            { generationId: 'generation-after-500', content: { mode: 'append', text: '后来一次。' } },
        );
        assert.equal(next.chapter.generationHistory.length, 502);
        assert.equal(next.chapter.generationHistory[0].generationId, 'generation-retry');
        const oldReceiptRetry = store.adoptGeneration(
            project.id,
            chapter.id,
            next.project.version,
            next.chapter.revision,
            payload,
        );
        assert.equal(oldReceiptRetry.idempotent, true);
        assert.equal(oldReceiptRetry.chapter.content, '只追加一次。后来一次。');
        assert.equal(oldReceiptRetry.project.version, next.project.version);
    });

    test('rolls back both files on optimistic conflict', () => {
        const { project, chapter } = store.createProject({ title: '冲突回滚' });
        const projectPath = store.projectPath(project.id);
        const chapterPath = store.chapterPath(project.id, chapter.id);
        const projectBefore = fs.readFileSync(projectPath, 'utf8');
        const chapterBefore = fs.readFileSync(chapterPath, 'utf8');

        assert.throws(
            () => store.adoptGeneration(project.id, chapter.id, project.version + 1, chapter.revision, adoption(chapter.id)),
            hasCode('project_conflict'),
        );
        assert.equal(fs.readFileSync(projectPath, 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterBefore);
    });

    test('rejects dangling entity references before writing body or state', () => {
        const { project, chapter } = store.createProject({ title: '引用校验' });
        const projectPath = store.projectPath(project.id);
        const chapterPath = store.chapterPath(project.id, chapter.id);
        const projectBefore = fs.readFileSync(projectPath, 'utf8');
        const chapterBefore = fs.readFileSync(chapterPath, 'utf8');
        const payload = {
            generationId: 'generation-invalid-reference',
            content: { mode: 'replace', text: '这段正文不能落盘。' },
            storyStateChanges: {
                relations: {
                    upsert: [{
                        id: 'dangling', fromEntityId: 'missing-a', toEntityId: 'missing-b', kind: 'enemy',
                    }],
                },
            },
        };

        assert.throws(
            () => store.adoptGeneration(project.id, chapter.id, project.version, chapter.revision, payload),
            hasCode('invalid_story_reference'),
        );
        assert.equal(fs.readFileSync(projectPath, 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterBefore);
    });

    test('exposes adoption through the chapter POST route', async () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-state-api-'));
        try {
            const app = createApp({ dataRoot });
            const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
            const created = await request(app)
                .post('/api/story-studio/projects')
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', bootstrap.body.csrfToken)
                .send({ title: '路由采纳' })
                .expect(201);
            const { project, chapter } = created.body;
            const adopted = await request(app)
                .post(`/api/story-studio/projects/${project.id}/chapters/${chapter.id}/adopt`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', bootstrap.body.csrfToken)
                .send({
                    projectVersion: project.version,
                    revision: chapter.revision,
                    payload: { generationId: 'generation-http', content: { mode: 'replace', text: '路由正文。' } },
                })
                .expect(200);
            assert.equal(adopted.body.chapter.content, '路由正文。');
            assert.equal(adopted.body.adoption.generationId, 'generation-http');
        } finally {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    });

    test('enforces protected story-state boundaries through project POST and PATCH while allowing V5 import', async () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-protected-api-'));
        try {
            const app = createApp({ dataRoot });
            const bootstrap = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
            const csrfToken = bootstrap.body.csrfToken;
            const createCases = [
                {
                    storyState: { facts: [{ id: 'fact-http-create', summary: '路由注入事实。' }] },
                    fields: ['facts'],
                },
                {
                    storyState: { knowledge: [{
                        id: 'knowledge-http-create', entityId: 'hero-http-create',
                        factId: 'fact-http-create', stance: 'knows',
                    }] },
                    fields: ['knowledge'],
                },
                {
                    storyState: { timeline: [{ id: 'timeline-http-create', label: '路由注入时间点' }] },
                    fields: ['timeline'],
                },
            ];
            for (const testCase of createCases) {
                const rejectedCreate = await request(app)
                    .post('/api/story-studio/projects')
                    .set('Host', LOCAL_HOST)
                    .set('X-CSRF-Token', csrfToken)
                    .send({ title: '禁止路由注入', storyState: testCase.storyState })
                    .expect(400);
                assert.equal(rejectedCreate.body.error, 'protected_story_state');
                assert.deepEqual(rejectedCreate.body.fields, testCase.fields);
            }
            const emptyList = await request(app)
                .get('/api/story-studio/projects')
                .set('Host', LOCAL_HOST)
                .expect(200);
            assert.deepEqual(emptyList.body, []);

            const created = await request(app)
                .post('/api/story-studio/projects')
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({ title: '路由权威边界' })
                .expect(201);
            const emptyAuthority = created.body.project.storyState;
            const emptyPatchCases = [
                {
                    state: {
                        ...emptyAuthority,
                        facts: [{ id: 'fact-http-empty', summary: '空项目路由注入事实。' }],
                    },
                    fields: ['facts'],
                },
                {
                    state: {
                        ...emptyAuthority,
                        timeline: [{ id: 'timeline-http-empty', label: '空项目路由注入时间点' }],
                    },
                    fields: ['timeline'],
                },
                {
                    state: {
                        ...emptyAuthority,
                        entities: [{ id: 'hero-http-empty', name: '林默' }],
                        facts: [{ id: 'fact-knowledge-http-empty', summary: '林默知道暗号。' }],
                        knowledge: [{
                            id: 'knowledge-http-empty', entityId: 'hero-http-empty',
                            factId: 'fact-knowledge-http-empty', stance: 'knows',
                        }],
                    },
                    fields: ['facts', 'knowledge'],
                },
            ];
            for (const testCase of emptyPatchCases) {
                const rejectedPatch = await request(app)
                    .patch(`/api/story-studio/projects/${created.body.project.id}`)
                    .set('Host', LOCAL_HOST)
                    .set('X-CSRF-Token', csrfToken)
                    .send({
                        version: created.body.project.version,
                        changes: { storyState: testCase.state },
                    })
                    .expect(400);
                assert.equal(rejectedPatch.body.error, 'protected_story_state');
                assert.deepEqual(rejectedPatch.body.fields, testCase.fields);
            }
            const unchangedEmptyProject = await request(app)
                .get(`/api/story-studio/projects/${created.body.project.id}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            assert.equal(unchangedEmptyProject.body.version, created.body.project.version);
            assert.deepEqual(unchangedEmptyProject.body.storyState, emptyAuthority);
            const legacyPatched = await request(app)
                .patch(`/api/story-studio/projects/${created.body.project.id}`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    version: created.body.project.version,
                    changes: {
                        storyState: {
                            ...emptyAuthority,
                            memory: [{ id: 'memory-http-empty', summary: '空项目允许补充旧五类。' }],
                        },
                    },
                })
                .expect(200);
            assert.equal(legacyPatched.body.version, created.body.project.version + 1);
            assert.equal(legacyPatched.body.storyState.memory[0].summary, '空项目允许补充旧五类。');
            const adopted = await request(app)
                .post(`/api/story-studio/projects/${created.body.project.id}/chapters/${created.body.chapter.id}/adopt`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    projectVersion: legacyPatched.body.version,
                    revision: created.body.chapter.revision,
                    payload: {
                        generationId: 'seed-http-protected',
                        storyStateChanges: {
                            entities: { upsert: [{ id: 'hero-http', name: '林默' }] },
                            facts: { upsert: [{ id: 'fact-http', summary: '北门已经关闭。', subjectEntityId: 'hero-http' }] },
                            knowledge: { upsert: [{
                                id: 'knowledge-http', entityId: 'hero-http', factId: 'fact-http', stance: 'knows',
                            }] },
                            timeline: { upsert: [{
                                id: 'timeline-http', label: '路由封城', chapterId: created.body.chapter.id,
                            }] },
                        },
                    },
                })
                .expect(200);
            const authoritative = adopted.body.project.storyState;
            const rejectedUpdate = await request(app)
                .patch(`/api/story-studio/projects/${created.body.project.id}`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    version: adopted.body.project.version,
                    changes: {
                        storyState: {
                            ...authoritative,
                            facts: authoritative.facts.map(fact => ({ ...fact, summary: '路由伪造事实。' })),
                        },
                    },
                })
                .expect(400);
            assert.equal(rejectedUpdate.body.error, 'protected_story_state');
            assert.deepEqual(rejectedUpdate.body.fields, ['facts']);
            const unchanged = await request(app)
                .get(`/api/story-studio/projects/${created.body.project.id}`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            assert.equal(unchanged.body.version, adopted.body.project.version);
            assert.deepEqual(unchanged.body.storyState, authoritative);

            const compatible = await request(app)
                .patch(`/api/story-studio/projects/${created.body.project.id}`)
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send({
                    version: adopted.body.project.version,
                    changes: {
                        storyState: {
                            ...authoritative,
                            memory: [{ id: 'memory-http', summary: '路由补充记忆。' }],
                        },
                    },
                })
                .expect(200);
            assert.deepEqual(compatible.body.storyState.facts, authoritative.facts);
            assert.equal(compatible.body.storyState.memory[0].summary, '路由补充记忆。');

            const exported = await request(app)
                .get(`/api/story-studio/projects/${created.body.project.id}/export`)
                .set('Host', LOCAL_HOST)
                .expect(200);
            const imported = await request(app)
                .post('/api/story-studio/projects/import')
                .set('Host', LOCAL_HOST)
                .set('X-CSRF-Token', csrfToken)
                .send(exported.body)
                .expect(201);
            assert.equal(imported.body.project.storyState.facts[0].summary, '北门已经关闭。');
            assert.equal(imported.body.project.storyState.knowledge[0].stance, 'knows');
            assert.equal(imported.body.project.storyState.timeline[0].label, '路由封城');
        } finally {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    });
});
