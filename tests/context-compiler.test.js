import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compileStoryContext } from '../public/context-compiler.js';

const STORY_STATE_CATEGORIES = [
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
];

function createV5Project() {
    return {
        chapters: [
            { id: 'chapter-one', number: 1 },
            { id: 'chapter-two', number: 2 },
            { id: 'chapter-three', number: 3 },
        ],
        storyState: {
            entities: [
                {
                    id: 'hero', kind: 'character', name: '林照', aliases: ['小林'], status: 'active',
                    locationEntityId: 'location-gate', currentGoal: '查清铜钥匙来历',
                    currentAction: '等待守将放行', updatedChapterId: 'chapter-one',
                },
                {
                    id: 'guard', kind: 'character', name: '守将', aliases: [], status: 'active',
                    locationEntityId: 'location-gate', currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
                },
                {
                    id: 'ally', kind: 'character', name: '青禾', aliases: [], status: 'active',
                    locationEntityId: 'location-hall', currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
                },
                {
                    id: 'wanderer', kind: 'character', name: '游商', aliases: [], status: 'active',
                    locationEntityId: null, currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
                },
                { id: 'location-gate', kind: 'location', name: '赤门', aliases: ['城门'], status: 'active' },
                { id: 'location-hall', kind: 'location', name: '王庭', aliases: [], status: 'active' },
                { id: 'retired-character', kind: 'character', name: '旧角色', aliases: [], status: 'retired' },
            ],
            relations: [
                {
                    id: 'relation-guard', fromEntityId: 'hero', toEntityId: 'guard', kind: 'duty',
                    summary: '守将正在盘问林照。', publicSummary: '两人在城门交谈。',
                    privateSummary: '守将暗中奉命扣留铜钥匙。', status: 'active',
                },
                {
                    id: 'relation-retired', fromEntityId: 'hero', toEntityId: 'retired-character',
                    kind: 'former', summary: '已废弃关系。', status: 'superseded',
                },
            ],
            events: [
                {
                    id: 'event-progress-one', kind: 'action', title: '盘问仍在继续', summary: '盘问刚刚开始。',
                    chapterId: 'chapter-one', entityIds: ['hero', 'guard'], status: 'recorded', order: 3,
                    timelineId: 'time-early', locationEntityId: 'location-gate', progress: 1, visibility: 'public',
                },
                {
                    id: 'event-complete', kind: 'action', title: '递交路引', summary: '路引已经递交。',
                    chapterId: 'chapter-one', entityIds: ['hero'], status: 'recorded', order: 2,
                    timelineId: 'time-early', locationEntityId: 'location-gate', progress: 100, visibility: 'public',
                },
                {
                    id: 'event-private', kind: 'secret', title: '幕后调令', summary: '密探在幕后调动禁军。',
                    chapterId: 'chapter-one', entityIds: ['guard'], status: 'active', order: 99,
                    timelineId: 'time-early', locationEntityId: 'location-gate', progress: 10, visibility: 'private',
                },
                {
                    id: 'event-retired', kind: 'action', title: '废弃事件', summary: '不应进入上下文。',
                    chapterId: 'chapter-one', entityIds: ['hero'], status: 'retired', order: 100,
                    timelineId: 'time-early', locationEntityId: 'location-gate', progress: 50, visibility: 'public',
                },
            ],
            promises: [
                {
                    id: 'promise-future', title: '城门之约', summary: '第三章前不得揭晓钥匙归属。',
                    introducedChapterId: 'chapter-one', dueChapterId: 'chapter-three', resolvedChapterId: null,
                    status: ' OPEN ', kind: 'reveal', urgency: 5, evidenceChapterIds: ['chapter-two'],
                },
                {
                    id: 'promise-current', title: '交出路引', summary: '本章需要回应路引。',
                    introducedChapterId: 'chapter-one', dueChapterId: 'chapter-two', resolvedChapterId: null,
                    status: 'active', kind: 'payoff', urgency: 2, evidenceChapterIds: [],
                },
                {
                    id: 'promise-retired', title: '废弃承诺', summary: '不应进入上下文。',
                    introducedChapterId: 'chapter-one', dueChapterId: null, resolvedChapterId: null,
                    status: 'retired', kind: 'reveal', urgency: 5, evidenceChapterIds: [],
                },
            ],
            memory: [
                {
                    id: 'memory-book', kind: 'book', summary: '赤门只在暮色开放。', chapterId: null,
                    importance: 4, tags: ['赤门'], status: 'active', supersededById: null,
                    confidence: 1, sourceChapterIds: ['chapter-one'],
                },
                {
                    id: 'memory-retired', kind: 'book', summary: '废弃记忆。', chapterId: null,
                    importance: 5, tags: [], status: 'retired', supersededById: null,
                    confidence: 1, sourceChapterIds: ['chapter-one'],
                },
            ],
            facts: [
                {
                    id: 'fact-knows', summary: '林照持有铜钥匙。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 1, tags: ['钥匙'],
                },
                {
                    id: 'fact-suspects', summary: '守将可能受人指使。', subjectEntityId: 'guard',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 0.6, tags: ['守将'],
                },
                {
                    id: 'fact-believes', summary: '林照相信王庭内有人接应。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 0.5, tags: ['王庭'],
                },
                {
                    id: 'fact-denies', summary: '林照否认见过密探。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 0.8, tags: ['密探'],
                },
                {
                    id: 'fact-hidden', summary: '铜钥匙其实能开启王庭地库。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 1, tags: ['地库'],
                },
                {
                    id: 'fact-other-pov', summary: '守将知道幕后主使是摄政王。', subjectEntityId: 'guard',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 1, tags: ['主使'],
                },
                {
                    id: 'fact-retired', summary: '已经作废的旧事实。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'retired', supersededById: null, confidence: 1, tags: [],
                },
                {
                    id: 'fact-superseded', summary: '已被新事实取代。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: 'fact-knows', confidence: 1, tags: [],
                },
            ],
            knowledge: [
                { id: 'knowledge-knows', entityId: 'hero', factId: 'fact-knows', stance: 'knows', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-suspects', entityId: 'hero', factId: 'fact-suspects', stance: 'suspects', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-believes', entityId: 'hero', factId: 'fact-believes', stance: 'believes', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-denies', entityId: 'hero', factId: 'fact-denies', stance: 'denies', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-hidden', entityId: 'hero', factId: 'fact-hidden', stance: 'hides', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-other-pov', entityId: 'guard', factId: 'fact-other-pov', stance: 'knows', learnedChapterId: 'chapter-one', status: 'active' },
                { id: 'knowledge-retired', entityId: 'hero', factId: 'fact-retired', stance: 'knows', learnedChapterId: 'chapter-one', status: 'retired' },
            ],
            timeline: [
                {
                    id: 'time-early', label: '林照抵达赤门', storyTime: '暮色', sequence: 10,
                    chapterId: 'chapter-one', locationEntityId: 'location-gate', status: 'occurred',
                },
                {
                    id: 'time-current', label: '守将开始盘问', storyTime: '入夜', sequence: 20,
                    chapterId: 'chapter-two', locationEntityId: 'location-gate', status: 'occurred',
                },
                {
                    id: 'time-future', label: '林照进入王庭', storyTime: '子夜', sequence: 30,
                    chapterId: 'chapter-three', locationEntityId: 'location-hall', status: 'planned',
                },
                {
                    id: 'time-retired', label: '废弃时间点', storyTime: '黄昏', sequence: 5,
                    chapterId: 'chapter-one', locationEntityId: 'location-gate', status: 'retired',
                },
            ],
        },
    };
}

function currentChapter(card = {}) {
    return {
        id: 'chapter-two', number: 2, title: '夜访',
        card: { goal: '林照处理城门之约', ...card }, content: '',
    };
}

const previousChapter = {
    id: 'chapter-one', number: 1, title: '入城', card: {}, content: '林照抵达赤门。',
};

describe('deterministic story context compiler', () => {
    const project = {
        storyState: {
            entities: [
                { id: 'lin', name: '林照', aliases: ['小林'] },
                { id: 'guard', name: '守将', aliases: [] },
                { id: 'remote', name: '远山老人', aliases: [] },
            ],
            relations: [
                { id: 'r1', fromEntityId: 'lin', toEntityId: 'guard', status: 'active' },
                { id: 'r2', fromEntityId: 'lin', toEntityId: 'remote', status: 'resolved' },
            ],
            events: [
                { id: 'e1', chapterId: 'previous', entityIds: ['lin'], order: 2 },
                { id: 'e2', chapterId: 'old', entityIds: ['remote'], order: 1 },
            ],
            promises: [
                { id: 'p1', status: 'open' },
                { id: 'p2', status: 'resolved' },
            ],
            memory: [
                { id: 'm1', kind: 'book', importance: 3 },
                { id: 'm2', kind: 'chapter', chapterId: 'old', importance: 1 },
            ],
        },
    };

    test('selects mentions, connected entities, recent events, open promises, and structural memory', () => {
        const result = compileStoryContext({
            project,
            chapter: { id: 'current', card: { goal: '林照接受守将审问' }, content: '' },
            previousChapter: { id: 'previous', content: '小林抵达城门。' },
        });
        assert.deepEqual(result.storyState.entities.map(item => item.id), ['lin', 'guard', 'remote']);
        assert.deepEqual(result.storyState.relations.map(item => item.id), ['r1']);
        assert.deepEqual(result.storyState.events.map(item => item.id), ['e1', 'e2']);
        assert.deepEqual(result.storyState.promises.map(item => item.id), ['p1']);
        assert.deepEqual(result.storyState.memory.map(item => item.id), ['m1']);
        assert.deepEqual(Object.keys(result.storyState), STORY_STATE_CATEGORIES);
        assert.deepEqual(result.storyState.facts, []);
        assert.deepEqual(result.storyState.knowledge, []);
        assert.deepEqual(result.storyState.timeline, []);
        assert.ok(result.diagnostics.items.find(item => item.id === 'lin').reasons.includes('mentioned-in-chapter-context'));
    });

    test('lets explicit exclusion win and reports manual inclusion reasons', () => {
        const result = compileStoryContext({
            project,
            chapter: { id: 'current', card: {}, content: '' },
            overrides: {
                includeEntityIds: ['remote'],
                excludeEntityIds: ['lin'],
                includePromiseIds: ['p2'],
                excludePromiseIds: ['p1'],
            },
        });
        assert.deepEqual(result.storyState.entities.map(item => item.id), ['remote']);
        assert.deepEqual(result.storyState.promises.map(item => item.id), ['p2']);
        assert.ok(result.diagnostics.items.find(item => item.id === 'remote').reasons.includes('manually-included'));
        assert.deepEqual(result.diagnostics.overrides.excludeEntityIds, ['lin']);
        assert.deepEqual(result.diagnostics.overrides.excludePromiseIds, ['p1']);
    });

    test('does not reintroduce an excluded entity through an active relation', () => {
        const result = compileStoryContext({
            project,
            chapter: { id: 'current', card: { goal: '林照独自行动' }, content: '' },
            overrides: { excludeEntityIds: ['guard'] },
        });
        assert.ok(result.storyState.entities.some(item => item.id === 'lin'));
        assert.equal(result.storyState.entities.some(item => item.id === 'guard'), false);
        assert.equal(result.storyState.relations.some(item => item.id === 'r1'), false);
    });

    test('prioritizes manual inclusions before applying the entity count limit', () => {
        const entities = Array.from({ length: 101 }, (_, index) => ({
            id: `entity-${index}`,
            name: `人物${index}`,
            aliases: [],
        }));
        const result = compileStoryContext({
            project: {
                storyState: { entities, relations: [], events: [], promises: [], memory: [] },
            },
            chapter: { card: { goal: entities.map(entity => entity.name).join('、') }, content: '' },
            overrides: { includeEntityIds: ['entity-100'] },
        });

        assert.equal(result.storyState.entities.length, 100);
        assert.equal(result.storyState.entities[0].id, 'entity-100');
        assert.ok(result.diagnostics.items.find(item => item.id === 'entity-100').reasons.includes('manually-included'));
    });
});

describe('V5 continuity preflight', () => {
    for (const [label, pov, resolution] of [
        ['id', 'hero', 'id'],
        ['name', '林照', 'name'],
        ['alias', '小林', 'alias'],
    ]) {
        test(`resolves POV by ${label}`, () => {
            const result = compileStoryContext({
                project: createV5Project(),
                chapter: currentChapter({ pov }),
                previousChapter,
            });

            assert.equal(result.preflight.pov.entityId, 'hero');
            assert.equal(result.preflight.pov.resolution, resolution);
            assert.equal(result.preflight.pov.unresolved, false);
            assert.equal(result.diagnostics.preflight, result.preflight);
            assert.equal(result.diagnostics.unresolvedPov, false);
        });
    }

    test('projects visible knowledge stances and protects hides outside ordinary story state', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });

        for (const stance of ['knows', 'suspects', 'believes', 'denies']) {
            assert.equal(result.preflight.pov.knowledge[stance].length, 1);
            assert.equal(result.preflight.pov.knowledge[stance][0].knowledgeId, `knowledge-${stance}`);
            assert.equal(result.preflight.pov.knowledge[stance][0].factId, `fact-${stance}`);
        }
        assert.deepEqual(result.preflight.pov.knowledge.hides, [{
            knowledgeId: 'knowledge-hidden',
            factId: 'fact-hidden',
            summary: '铜钥匙其实能开启王庭地库。',
            subjectEntityId: 'hero',
            stance: 'hides',
            mustNotReveal: true,
        }]);
        assert.ok(result.preflight.requirements.some(item => (
            item.code === 'must-not-reveal-fact'
            && item.factId === 'fact-hidden'
            && item.mustNotReveal === true
        )));
        assert.equal(result.storyState.facts.some(item => item.id === 'fact-hidden'), false);
        assert.equal(result.storyState.knowledge.some(item => item.id === 'knowledge-hidden'), false);
        assert.doesNotMatch(JSON.stringify(result.storyState), /铜钥匙其实能开启王庭地库|fact-hidden|knowledge-hidden/);
    });

    test('does not leak facts that have no knowledge edge for the resolved POV', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });
        const serialized = JSON.stringify(result);

        assert.doesNotMatch(serialized, /fact-other-pov|knowledge-other-pov|守将知道幕后主使是摄政王/);
        assert.equal(result.preflight.counts.visibleFacts, 4);
        assert.equal(result.preflight.counts.visibleKnowledge, 4);
    });

    test('does not leak an unavailable fact through an overlapping legacy memory record', () => {
        const project = createV5Project();
        project.storyState.memory.push({
            id: 'memory-other-pov', kind: 'chapter', summary: '守将知道幕后主使是摄政王。',
            chapterId: 'chapter-one', importance: 5, tags: ['主使'], status: 'active',
            supersededById: null, confidence: 1, sourceChapterIds: ['chapter-one'],
        });
        project.storyState.memory.push({
            id: 'memory-visible', kind: 'chapter', summary: '林照持有铜钥匙。',
            chapterId: 'chapter-one', importance: 5, tags: ['钥匙'], status: 'active',
            supersededById: null, confidence: 1, sourceChapterIds: ['chapter-one'],
        });

        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });
        const serialized = JSON.stringify(result);

        assert.doesNotMatch(serialized, /守将知道幕后主使是摄政王|memory-other-pov/);
        assert.match(serialized, /林照持有铜钥匙|memory-visible/);
    });

    test('uses exact case-sensitive ids before case-insensitive names and aliases', () => {
        const project = createV5Project();
        project.storyState.entities.unshift({
            id: 'Hero', kind: 'character', name: '错误人物', aliases: [], status: 'active',
            locationEntityId: null, currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
        });
        project.storyState.facts.unshift({
            id: 'fact-wrong-case', summary: '错误人物掌握不该进入的秘密。', subjectEntityId: 'Hero',
            sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 1, tags: [],
        });
        project.storyState.knowledge.unshift({
            id: 'knowledge-wrong-case', entityId: 'Hero', factId: 'fact-wrong-case',
            stance: 'knows', learnedChapterId: 'chapter-one', status: 'active',
        });

        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });

        assert.equal(result.preflight.pov.entityId, 'hero');
        assert.doesNotMatch(JSON.stringify(result), /错误人物掌握不该进入的秘密|fact-wrong-case/);
    });

    test('fails closed when POV is missing, unresolved, or ambiguous', () => {
        const project = createV5Project();
        project.storyState.entities.push({
            id: 'other-lin', kind: 'character', name: '林凌', aliases: ['小林'], status: 'active',
            locationEntityId: null, currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
        });
        for (const [pov, expectedResolution] of [
            ['', 'not-specified'],
            ['不存在的人', 'unresolved'],
            ['小林', 'ambiguous'],
        ]) {
            const result = compileStoryContext({
                project,
                chapter: currentChapter({ pov }),
                previousChapter,
            });
            const serialized = JSON.stringify(result);

            assert.equal(result.preflight.status, 'blocked');
            assert.equal(result.preflight.pov.entityId, null);
            assert.equal(result.preflight.pov.resolution, expectedResolution);
            assert.equal(result.preflight.pov.unresolved, true);
            assert.deepEqual(result.storyState.facts, []);
            assert.deepEqual(result.storyState.knowledge, []);
            assert.doesNotMatch(serialized, /林照持有铜钥匙|fact-knows|knowledge-knows/);
        }
    });

    test('excludes retired and superseded records from every V5 projection', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });

        for (const records of Object.values(result.storyState)) {
            assert.equal(records.some(item => /retired|superseded/.test(item.id)), false);
        }
        assert.equal(result.storyState.facts.some(item => item.id === 'fact-superseded'), false);
        assert.ok(result.diagnostics.filteredItems.some(item => item.reason === 'retired'));
        assert.ok(result.diagnostics.filteredItems.some(item => item.reason === 'superseded'));
    });

    test('removes private events and private relation summaries without mutating authoritative state', () => {
        const project = createV5Project();
        const snapshot = structuredClone(project);
        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });
        const relation = result.storyState.relations.find(item => item.id === 'relation-guard');
        const serialized = JSON.stringify(result);

        assert.deepEqual(project, snapshot);
        assert.equal(Object.hasOwn(relation, 'privateSummary'), false);
        assert.equal(relation.publicSummary, '两人在城门交谈。');
        assert.equal(result.storyState.events.some(item => item.id === 'event-private'), false);
        assert.doesNotMatch(serialized, /event-private|密探在幕后调动禁军|守将暗中奉命扣留铜钥匙/);
    });

    test('derives ordered time, movement, presence, and unfinished actions while excluding future time', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero', location: '王庭' }),
            previousChapter,
            limits: { timeline: 2 },
        });

        assert.deepEqual(result.storyState.timeline.map(item => item.id), ['time-early', 'time-current']);
        assert.equal(result.preflight.time.current.timelineId, 'time-current');
        assert.deepEqual(result.preflight.movement, {
            fromLocationEntityId: 'location-gate',
            targetLocationEntityId: 'location-hall',
            requestedLocation: '王庭',
            targetResolution: 'name',
            requiresTransition: true,
        });
        assert.deepEqual(result.preflight.presence.present.map(item => item.entityId), ['hero', 'ally']);
        assert.deepEqual(result.preflight.presence.absent.map(item => item.entityId), ['guard']);
        assert.deepEqual(result.preflight.presence.unknown.map(item => item.entityId), []);
        assert.ok(result.preflight.unfinishedActions.some(item => item.kind === 'entity-action' && item.entityId === 'hero'));
        assert.ok(result.preflight.unfinishedActions.some(item => item.kind === 'event' && item.eventId === 'event-progress-one'));
        assert.equal(result.preflight.unfinishedActions.some(item => item.eventId === 'event-complete'), false);
        assert.equal(result.preflight.unfinishedActions.some(item => item.eventId === 'event-private'), false);
        assert.ok(result.preflight.requirements.some(item => item.code === 'location-transition-required'));
    });

    test('excludes every state projection that only becomes valid in a future chapter', () => {
        const project = createV5Project();
        project.storyState.entities.push({
            id: 'future-character', kind: 'character', name: '未来人物', aliases: [], status: 'active',
            locationEntityId: 'location-hall', currentGoal: 'FUTURE_GOAL', currentAction: 'FUTURE_ACTION',
            updatedChapterId: 'chapter-three',
        });
        project.storyState.relations.push({
            id: 'future-relation', fromEntityId: 'hero', toEntityId: 'guard', kind: 'future',
            summary: 'FUTURE_RELATION', publicSummary: 'FUTURE_RELATION', privateSummary: '',
            addressing: '', sinceChapterId: 'chapter-three', status: 'active',
        });
        project.storyState.events.push({
            id: 'future-event', kind: 'story', title: 'FUTURE_EVENT', summary: 'FUTURE_EVENT',
            chapterId: 'chapter-three', entityIds: ['hero'], status: 'planned', order: 999,
            timelineId: 'time-future', locationEntityId: 'location-hall', progress: 0, visibility: 'public',
        });
        project.storyState.promises.push({
            id: 'future-promise', title: 'FUTURE_PROMISE', summary: 'FUTURE_PROMISE',
            introducedChapterId: 'chapter-three', dueChapterId: null, resolvedChapterId: null,
            status: 'open', kind: 'reveal', urgency: 5, evidenceChapterIds: [],
        });
        project.storyState.memory.push({
            id: 'future-memory', kind: 'book', summary: 'FUTURE_MEMORY', chapterId: 'chapter-three',
            importance: 5, tags: [], status: 'active', supersededById: null, confidence: 1,
            sourceChapterIds: ['chapter-three'],
        });
        project.storyState.facts.push(
            {
                id: 'future-source-fact', summary: 'FUTURE_SOURCE_FACT', subjectEntityId: 'hero',
                sourceChapterId: 'chapter-three', status: 'active', supersededById: null, confidence: 1, tags: [],
            },
            {
                id: 'future-learned-fact', summary: 'FUTURE_LEARNED_FACT', subjectEntityId: 'hero',
                sourceChapterId: 'chapter-one', status: 'active', supersededById: null, confidence: 1, tags: [],
            },
        );
        project.storyState.knowledge.push(
            {
                id: 'knowledge-future-source', entityId: 'hero', factId: 'future-source-fact',
                stance: 'knows', learnedChapterId: 'chapter-one', status: 'active',
            },
            {
                id: 'knowledge-future-learned', entityId: 'hero', factId: 'future-learned-fact',
                stance: 'knows', learnedChapterId: 'chapter-three', status: 'active',
            },
        );
        project.storyState.timeline.push({
            id: 'future-unassigned-time', label: 'FUTURE_UNASSIGNED_TIME', storyTime: '更晚', sequence: 999,
            chapterId: null, locationEntityId: 'location-hall', status: 'planned',
        });

        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });

        assert.doesNotMatch(JSON.stringify(result), /FUTURE_(?:GOAL|ACTION|RELATION|EVENT|PROMISE|MEMORY|SOURCE_FACT|LEARNED_FACT|UNASSIGNED_TIME)/);
        assert.ok(result.storyState.promises.some(item => item.id === 'promise-future'));
    });

    test('fails closed for unknown event visibility and removes private-event-only timeline details', () => {
        const project = createV5Project();
        project.storyState.relations[0].summary = '守将暗中奉命扣留铜钥匙。';
        project.storyState.timeline.push(
            {
                id: 'time-private-only', label: 'PRIVATE_TIMELINE_SECRET', storyTime: '入夜', sequence: 21,
                chapterId: 'chapter-two', locationEntityId: 'location-gate', status: 'occurred',
            },
            {
                id: 'time-scoped', label: 'SCOPED_TIMELINE', storyTime: '入夜', sequence: 22,
                chapterId: 'chapter-two', locationEntityId: 'location-gate', status: 'occurred',
            },
        );
        project.storyState.events.push(
            {
                id: 'event-private-only', kind: 'secret', title: 'PRIVATE_EVENT_SECRET', summary: 'PRIVATE_EVENT_SECRET',
                chapterId: 'chapter-two', entityIds: ['guard'], status: 'active', order: 101,
                timelineId: 'time-private-only', locationEntityId: 'location-gate', progress: 10, visibility: 'private',
            },
            {
                id: 'event-unknown-visibility', kind: 'secret', title: 'UNKNOWN_VISIBILITY_SECRET', summary: 'UNKNOWN_VISIBILITY_SECRET',
                chapterId: 'chapter-two', entityIds: ['guard'], status: 'active', order: 102,
                timelineId: null, locationEntityId: 'location-gate', progress: 10, visibility: 'reader-and-someone-else',
            },
            {
                id: 'event-scoped-hero', kind: 'story', title: 'SCOPED_HERO_EVENT', summary: 'SCOPED_HERO_EVENT',
                chapterId: 'chapter-two', entityIds: ['hero'], status: 'active', order: 103,
                timelineId: 'time-scoped', locationEntityId: 'location-gate', progress: 10, visibility: 'reader-and-hero',
            },
            {
                id: 'event-reader-visible', kind: 'story', title: 'READER_VISIBLE_EVENT', summary: 'READER_VISIBLE_EVENT',
                chapterId: 'chapter-two', entityIds: ['hero'], status: 'active', order: 104,
                timelineId: null, locationEntityId: 'location-gate', progress: 10, visibility: 'reader',
            },
            {
                id: 'event-all-visible', kind: 'story', title: 'ALL_VISIBLE_EVENT', summary: 'ALL_VISIBLE_EVENT',
                chapterId: 'chapter-two', entityIds: ['hero'], status: 'active', order: 105,
                timelineId: null, locationEntityId: 'location-gate', progress: 10, visibility: 'all',
            },
        );

        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });
        const serialized = JSON.stringify(result);
        const relation = result.storyState.relations.find(item => item.id === 'relation-guard');

        assert.equal(relation.summary, '两人在城门交谈。');
        assert.equal(Object.hasOwn(relation, 'privateSummary'), false);
        assert.doesNotMatch(serialized, /PRIVATE_EVENT_SECRET|PRIVATE_TIMELINE_SECRET|UNKNOWN_VISIBILITY_SECRET/);
        assert.match(serialized, /SCOPED_HERO_EVENT|SCOPED_TIMELINE/);
        assert.match(serialized, /READER_VISIBLE_EVENT/);
        assert.match(serialized, /ALL_VISIBLE_EVENT/);
    });

    test('builds preflight only from final limited records and does not share source objects', () => {
        const project = createV5Project();
        for (let index = 0; index < 8; index++) {
            project.storyState.entities.push({
                id: `extra-${index}`, kind: 'character', name: `额外人物${index}`, aliases: [], status: 'active',
                locationEntityId: null, currentGoal: '', currentAction: `EXTRA_ACTION_${index}`,
                updatedChapterId: 'chapter-one',
            });
        }
        const snapshot = structuredClone(project);
        const result = compileStoryContext({
            project,
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
            overrides: { excludeEntityIds: ['extra-7'] },
            limits: { entities: 3, events: 1 },
        });
        const preflightEntityIds = new Set([
            ...result.preflight.presence.present,
            ...result.preflight.presence.absent,
            ...result.preflight.presence.unknown,
            ...result.preflight.unfinishedActions.filter(item => item.entityId),
        ].map(item => item.entityId));
        const selectedEntityIds = new Set(result.storyState.entities.map(item => item.id));

        assert.ok(result.storyState.entities.length <= 3);
        assert.ok(result.storyState.events.length <= 1);
        assert.ok([...preflightEntityIds].every(id => selectedEntityIds.has(id)));
        assert.doesNotMatch(JSON.stringify(result.preflight), /EXTRA_ACTION_7|extra-7/);
        result.storyState.entities[0].name = 'MUTATED_OUTPUT';
        assert.deepEqual(project, snapshot);
    });

    test('does not resolve a chapter location to a non-location entity', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero', location: '守将' }),
            previousChapter,
        });

        assert.equal(result.preflight.movement.targetLocationEntityId, null);
        assert.equal(result.preflight.movement.targetResolution, 'unresolved');
        assert.ok(result.preflight.warnings.some(item => item.code === 'unresolved-location'));
    });

    test('normalizes active promise status and separates touch from do-not-resolve constraints', () => {
        const result = compileStoryContext({
            project: createV5Project(),
            chapter: currentChapter({ pov: 'hero' }),
            previousChapter,
        });
        const future = result.preflight.promises.touch.find(item => item.promiseId === 'promise-future');
        const current = result.preflight.promises.touch.find(item => item.promiseId === 'promise-current');

        assert.ok(future.reasons.includes('high-urgency'));
        assert.ok(future.reasons.includes('evidence-current-chapter'));
        assert.equal(future.mustNotResolve, true);
        assert.ok(current.reasons.includes('due-current-chapter'));
        assert.equal(current.mustNotResolve, false);
        assert.deepEqual(result.preflight.promises.doNotResolve, [{
            promiseId: 'promise-future',
            dueChapterId: 'chapter-three',
            reason: 'future-due-chapter',
        }]);
        assert.ok(result.preflight.requirements.some(item => (
            item.code === 'do-not-resolve-promise' && item.promiseId === 'promise-future'
        )));
    });
});
