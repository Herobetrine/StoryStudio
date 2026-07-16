import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    canonicalJson,
    createChapterCardCandidate,
    createReviewCandidate,
    createSuggestedChapterCardCandidate,
    diagnosePlanning,
    hashCanonical,
    suggestChapterCardPatch,
    validateCandidateArtifact,
    validateChapterCardPatch,
    validatePlanningDiagnosis,
    validateReviewPatch,
} from '../src/planning-copilot.js';

function fixture() {
    const chapters = [
        {
            id: 'chapter-one', projectId: 'project-one', number: 1, title: '入城',
            status: 'done', volumeId: 'volume-one', planBasis: { volumeRevision: 2 },
            card: { summary: '林照抵达赤门。', pov: 'hero', location: 'gate' },
            content: '林照在暮色中抵达赤门。', revision: 4,
        },
        {
            id: 'chapter-two', projectId: 'project-one', number: 2, title: '夜访',
            status: 'planned', volumeId: 'volume-one', planBasis: { volumeRevision: 2 },
            card: {
                summary: '林照接受守将盘问。',
                goal: '保住铜钥匙并通过赤门。',
                conflict: '守将要求检查行囊。',
                turn: '林照发现守将也在寻找钥匙。',
                hook: '城门内传来第二把钥匙落地的声音。',
                pov: 'hero',
                time: '入夜',
                location: 'gate',
                required: '回应路引伏笔；交代从城外到门洞的移动。',
                avoid: '不要提前揭示钥匙真正用途。',
            },
            content: '', revision: 7,
        },
        {
            id: 'chapter-three', projectId: 'project-one', number: 3, title: 'FUTURE_CHAPTER_TITLE',
            status: 'planned', volumeId: 'volume-one', planBasis: { volumeRevision: 2 },
            card: { summary: 'FUTURE_CHAPTER_SUMMARY', pov: 'hero', location: 'palace' },
            content: 'FUTURE_CHAPTER_CONTENT', revision: 1,
        },
    ];
    const project = {
        id: 'project-one', title: '赤门录', genre: '玄幻', version: 12,
        story: {
            logline: '林照带着一把来历不明的钥匙进入王都。',
            premise: '每一次开门都必须付出代价。',
            protagonist: '林照谨慎求生。',
            opposition: '王庭与守门人争夺钥匙。',
            world: '王都由七道城门分层。',
            powerSystem: '契约赋予钥匙不同权限。',
            styleGuide: '主角限知三人称。',
            masterOutline: 'FUTURE_MASTER_OUTLINE_SECRET',
            forbidden: '不得让主角无证据猜中幕后主使。',
        },
        volumes: [{
            id: 'volume-one', number: 1, title: '赤门卷', goal: '让林照取得合法入城身份。',
            summary: '林照已经抵达赤门。', outline: '围绕路引、钥匙和守将推进。', revision: 2,
        }],
        chapters: chapters.map(item => ({
            id: item.id,
            number: item.number,
            title: item.title,
            status: item.status,
            summary: item.card.summary,
            volumeId: item.volumeId,
            planBasis: item.planBasis,
            wordCount: 0,
            updatedAt: '2026-07-15T00:00:00.000Z',
        })),
        storyState: {
            entities: [
                {
                    id: 'hero', kind: 'character', name: '林照', aliases: ['阿照'], status: 'active',
                    summary: '谨慎的钥匙持有者。', locationEntityId: 'gate', currentGoal: '通过赤门',
                    currentAction: '接受守将盘问', updatedChapterId: 'chapter-one',
                },
                {
                    id: 'guard', kind: 'character', name: '守将', aliases: [], status: 'active',
                    summary: '负责检查路引。', locationEntityId: 'gate', currentGoal: '查清钥匙来源',
                    currentAction: '盘问林照', updatedChapterId: 'chapter-one',
                },
                {
                    id: 'gate', kind: 'location', name: '赤门', aliases: [], status: 'active',
                    summary: '王都最外层城门。', locationEntityId: null, currentGoal: '', currentAction: '',
                    updatedChapterId: 'chapter-one',
                },
                {
                    id: 'future-person', kind: 'character', name: 'FUTURE_PERSON_NAME', aliases: [], status: 'active',
                    summary: 'FUTURE_PERSON_SUMMARY', locationEntityId: null, currentGoal: '', currentAction: '',
                    updatedChapterId: 'chapter-three',
                },
            ],
            relations: [{
                id: 'relation-guard', fromEntityId: 'hero', toEntityId: 'guard', kind: 'inspection',
                summary: '两人在城门交谈。', publicSummary: '两人在城门交谈。',
                privateSummary: 'RELATION_PRIVATE_SECRET', addressing: '守将称林照为过客',
                sinceChapterId: 'chapter-one', status: 'active',
            }],
            events: [
                {
                    id: 'event-public', kind: 'action', title: '递交路引', summary: '林照把路引交给守将。',
                    chapterId: 'chapter-two', entityIds: ['hero', 'guard'], status: 'active', order: 20,
                    timelineId: 'time-current', locationEntityId: 'gate', progress: 30, visibility: 'public',
                },
                {
                    id: 'event-private', kind: 'secret', title: 'PRIVATE_EVENT_TITLE', summary: 'PRIVATE_EVENT_SECRET',
                    chapterId: 'chapter-two', entityIds: ['guard'], status: 'active', order: 21,
                    timelineId: 'time-current', locationEntityId: 'gate', progress: 10, visibility: 'private',
                },
                {
                    id: 'event-future', kind: 'reveal', title: 'FUTURE_EVENT_TITLE', summary: 'FUTURE_EVENT_SECRET',
                    chapterId: 'chapter-three', entityIds: ['hero'], status: 'planned', order: 30,
                    timelineId: 'time-future', locationEntityId: null, progress: 0, visibility: 'public',
                },
            ],
            promises: [{
                id: 'promise-pass', title: '路引检查', summary: '林照必须在本章通过路引检查。',
                introducedChapterId: 'chapter-one', dueChapterId: 'chapter-two', resolvedChapterId: null,
                status: 'open', kind: 'plot', urgency: 5, evidenceChapterIds: ['chapter-one'],
            }],
            memory: [
                {
                    id: 'memory-gate', kind: 'book', summary: '赤门只在暮色后检查路引。',
                    chapterId: 'chapter-one', importance: 5, tags: ['赤门'], status: 'active',
                    supersededById: null, confidence: 1, sourceChapterIds: ['chapter-one'],
                },
                {
                    id: 'memory-future', kind: 'book', summary: 'FUTURE_MEMORY_SECRET',
                    chapterId: 'chapter-three', importance: 5, tags: [], status: 'active',
                    supersededById: null, confidence: 1, sourceChapterIds: ['chapter-three'],
                },
            ],
            facts: [
                {
                    id: 'fact-known', summary: '林照持有铜钥匙。', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null,
                    confidence: 1, tags: ['钥匙'],
                },
                {
                    id: 'fact-hidden', summary: 'HIDDEN_FACT_SECRET', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-one', status: 'active', supersededById: null,
                    confidence: 1, tags: [],
                },
                {
                    id: 'fact-future', summary: 'FUTURE_FACT_SECRET', subjectEntityId: 'hero',
                    sourceChapterId: 'chapter-three', status: 'active', supersededById: null,
                    confidence: 1, tags: [],
                },
            ],
            knowledge: [
                {
                    id: 'knowledge-known', entityId: 'hero', factId: 'fact-known', stance: 'knows',
                    learnedChapterId: 'chapter-one', status: 'active',
                },
                {
                    id: 'knowledge-hidden', entityId: 'hero', factId: 'fact-hidden', stance: 'hides',
                    learnedChapterId: 'chapter-one', status: 'active',
                },
                {
                    id: 'knowledge-future', entityId: 'hero', factId: 'fact-future', stance: 'knows',
                    learnedChapterId: 'chapter-three', status: 'active',
                },
            ],
            timeline: [
                {
                    id: 'time-past', label: '林照抵达赤门', storyTime: '暮色', sequence: 10,
                    chapterId: 'chapter-one', locationEntityId: 'gate', status: 'occurred',
                },
                {
                    id: 'time-current', label: '守将开始盘问', storyTime: '入夜', sequence: 20,
                    chapterId: 'chapter-two', locationEntityId: 'gate', status: 'occurred',
                },
                {
                    id: 'time-future', label: 'FUTURE_TIMELINE_SECRET', storyTime: '子夜', sequence: 30,
                    chapterId: 'chapter-three', locationEntityId: null, status: 'planned',
                },
            ],
        },
    };
    const retrievalDiagnostics = {
        query: '铜钥匙',
        hits: [
            {
                id: 'fact:fact-known:0-9', text: '林照持有铜钥匙。', score: 5,
                sourceType: 'fact', sourceId: 'fact-known', chapterId: 'chapter-one',
                metadata: { chapterNumber: 1, factId: 'fact-known', status: 'active' },
            },
            {
                id: 'fact:fact-hidden:0-9', text: 'HIDDEN_FACT_SECRET', score: 9,
                sourceType: 'fact', sourceId: 'fact-hidden', chapterId: 'chapter-one',
                metadata: { chapterNumber: 1, factId: 'fact-hidden', status: 'active' },
            },
            {
                id: 'chapter:chapter-three:0-20', text: 'FUTURE_CHAPTER_CONTENT', score: 8,
                sourceType: 'chapter', sourceId: 'chapter-three', chapterId: 'chapter-three',
                metadata: { chapterNumber: 3, status: 'planned' },
            },
            {
                id: 'chapter:chapter-two:private-event', text: 'PRIVATE_EVENT_SECRET', score: 7,
                sourceType: 'chapter', sourceId: 'chapter-two', chapterId: 'chapter-two',
                metadata: { chapterNumber: 2, status: 'active' },
            },
            {
                id: 'chapter:chapter-two:private-relation', text: 'RELATION_PRIVATE_SECRET', score: 6,
                sourceType: 'chapter', sourceId: 'chapter-two', chapterId: 'chapter-two',
                metadata: { chapterNumber: 2, status: 'active' },
            },
            {
                id: 'chapter:chapter-one:0-20', text: '林照在暮色中抵达赤门。', score: 4,
                sourceType: 'chapter', sourceId: 'chapter-one', chapterId: 'chapter-one',
                metadata: { chapterNumber: 1, status: 'active' },
            },
        ],
    };
    return {
        project,
        chapter: chapters[1],
        chapters,
        previousChapter: chapters[0],
        retrievalDiagnostics,
    };
}

describe('deterministic planning copilot', () => {
    test('produces a stable diagnosis and never mutates its source snapshot', () => {
        const input = fixture();
        const before = structuredClone(input);
        const first = diagnosePlanning(input);
        const second = diagnosePlanning(input);

        assert.deepEqual(first, second);
        assert.deepEqual(input, before);
        assert.equal(first.kind, 'planning-diagnosis');
        assert.match(first.diagnosisDigest, /^[0-9a-f]{64}$/);
        const core = { ...first };
        delete core.diagnosisDigest;
        assert.equal(first.diagnosisDigest, hashCanonical(core));
        assert.deepEqual(validatePlanningDiagnosis(first), first);
        assert.ok(first.evidenceCatalog.length > 0);
        assert.equal(new Set(first.evidenceCatalog.map(item => item.evidenceId)).size, first.evidenceCatalog.length);
        assert.ok(first.evidenceCatalog.every(item => item.source.path && item.evidenceId.startsWith('evidence_')));
        assert.ok(first.evidenceCatalog.every(item => ['author', 'pov-safe'].includes(item.visibility)));
        assert.ok(first.metrics.authorEvidence > 0);
        assert.ok(first.metrics.povSafeEvidence > 0);
        assert.equal(first.metrics.authorEvidence + first.metrics.povSafeEvidence, first.metrics.evidenceCount);
        assert.equal(first.context.povEntityId, 'hero');
        assert.equal(first.context.previousChapterId, 'chapter-one');
        assert.ok(first.references.entities.some(item => item.id === 'hero'));
        assert.ok(first.references.locations.some(item => item.id === 'gate'));
        assert.ok(first.risks.some(item => item.code === 'protected-pov-knowledge'));
        assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
    });

    test('fails closed for future, hidden, private and unsafe retrieval material', () => {
        const diagnosis = diagnosePlanning(fixture());
        const serialized = JSON.stringify(diagnosis);
        for (const marker of [
            'FUTURE_CHAPTER_TITLE',
            'FUTURE_CHAPTER_SUMMARY',
            'FUTURE_CHAPTER_CONTENT',
            'FUTURE_PERSON_NAME',
            'FUTURE_PERSON_SUMMARY',
            'FUTURE_EVENT_TITLE',
            'FUTURE_EVENT_SECRET',
            'FUTURE_MEMORY_SECRET',
            'FUTURE_FACT_SECRET',
            'FUTURE_TIMELINE_SECRET',
            'HIDDEN_FACT_SECRET',
            'PRIVATE_EVENT_TITLE',
            'PRIVATE_EVENT_SECRET',
            'RELATION_PRIVATE_SECRET',
            'fact-hidden',
            'knowledge-hidden',
        ]) {
            assert.doesNotMatch(serialized, new RegExp(marker));
        }
        const authorOutline = diagnosis.evidenceCatalog.find(item => (
            item.source.path === 'project/story/masterOutline'
        ));
        assert.ok(authorOutline);
        assert.equal(authorOutline.visibility, 'author');
        assert.equal(authorOutline.scope, 'planning');
        assert.match(authorOutline.excerpt, /FUTURE_MASTER_OUTLINE_SECRET/);
        const povSafeEvidence = JSON.stringify(diagnosis.evidenceCatalog.filter(item => item.visibility === 'pov-safe'));
        assert.doesNotMatch(povSafeEvidence, /FUTURE_MASTER_OUTLINE_SECRET/);
        assert.match(serialized, /林照持有铜钥匙/);
        assert.match(serialized, /两人在城门交谈/);
        assert.equal(diagnosis.metrics.retrievalHits, 2);
        assert.equal(diagnosis.metrics.redactedRetrievalHits, 4);
        assert.ok(diagnosis.evidenceCatalog.some(item => item.source.type === 'retrieval'));
    });

    test('creates stable chapter-card candidates that cite only catalog evidence without applying them', () => {
        const input = fixture();
        const before = structuredClone(input);
        const diagnosis = diagnosePlanning(input);
        const evidenceIds = diagnosis.evidenceCatalog
            .filter(item => ['chapter-card', 'story-state-entities'].includes(item.source.type))
            .slice(0, 3)
            .map(item => item.evidenceId);
        const outlineEvidence = diagnosis.evidenceCatalog.find(item => item.source.path === 'project/story/masterOutline');
        evidenceIds.push(outlineEvidence.evidenceId);
        assert.ok(evidenceIds.length > 0);

        const candidateInput = {
            diagnosis,
            patch: {
                goal: '在不暴露钥匙用途的前提下通过赤门。',
                pov: 'hero',
                location: 'gate',
                required: '完成路引检查并交代转场。',
            },
            evidenceIds,
        };
        const first = createChapterCardCandidate(candidateInput);
        const second = createChapterCardCandidate(candidateInput);

        assert.deepEqual(first, second);
        assert.deepEqual(validateCandidateArtifact(first, diagnosis), first);
        assert.equal(first.kind, 'chapter-card');
        assert.equal(first.status, 'candidate');
        assert.equal(first.target.type, 'chapter-card');
        assert.equal(first.target.chapterId, input.chapter.id);
        assert.equal(first.diagnosisDigest, diagnosis.diagnosisDigest);
        assert.match(first.artifactId, /^artifact_[0-9a-f]{40}$/);
        assert.equal(Object.hasOwn(first, 'operations'), false);
        assert.equal(Object.hasOwn(first.patch, 'path'), false);
        assert.deepEqual(input, before);
    });

    test('rejects fabricated evidence, mismatched targets and tampered artifacts', () => {
        const input = fixture();
        const diagnosis = diagnosePlanning(input);
        const evidenceId = diagnosis.evidenceCatalog[0].evidenceId;

        assert.throws(
            () => createChapterCardCandidate({
                diagnosis,
                patch: { goal: '通过赤门。' },
                evidenceIds: [`evidence_${'f'.repeat(40)}`],
            }),
            error => error.code === 'unknown_evidence',
        );
        assert.throws(
            () => createChapterCardCandidate({
                diagnosis,
                target: {
                    type: 'chapter-card', projectId: diagnosis.target.projectId,
                    chapterId: 'chapter-one', projectVersion: diagnosis.target.projectVersion,
                    chapterRevision: diagnosis.target.chapterRevision,
                },
                patch: { goal: '通过赤门。' },
                evidenceIds: [evidenceId],
            }),
            error => error.code === 'stale_or_mismatched_target',
        );
        const artifact = createChapterCardCandidate({
            diagnosis,
            patch: { goal: '通过赤门。' },
            evidenceIds: [evidenceId],
        });
        artifact.patch.goal = '篡改后的目标';
        assert.throws(
            () => validateCandidateArtifact(artifact, diagnosis),
            error => error.code === 'artifact_digest_mismatch',
        );

        const tamperedDiagnosis = structuredClone(diagnosis);
        tamperedDiagnosis.evidenceCatalog[0].excerpt = '伪造证据';
        assert.throws(
            () => validatePlanningDiagnosis(tamperedDiagnosis),
            error => ['invalid_evidence', 'diagnosis_digest_mismatch'].includes(error.code),
        );
    });

    test('rejects arbitrary patch operations, invalid types and unresolved references', () => {
        const diagnosis = diagnosePlanning(fixture());
        assert.throws(
            () => validateChapterCardPatch({ path: '/card/goal', value: '越权' }, diagnosis),
            error => error.code === 'unknown_fields',
        );
        assert.throws(
            () => validateChapterCardPatch({ goal: { template: '{{secret}}' } }, diagnosis),
            error => error.code === 'invalid_patch_type',
        );
        assert.throws(
            () => validateChapterCardPatch({ goal: '根据 {{ project.secret }} 自动改写' }, diagnosis),
            error => error.code === 'forbidden_patch_syntax',
        );
        assert.throws(
            () => validateReviewPatch({ review: '<script>alert(1)</script>' }),
            error => error.code === 'forbidden_patch_syntax',
        );
        assert.throws(
            () => validateChapterCardPatch({ pov: 'future-person' }, diagnosis),
            error => error.code === 'invalid_reference',
        );
        assert.throws(
            () => validateChapterCardPatch({ pov: 'gate' }, diagnosis),
            error => error.code === 'invalid_reference',
        );
        assert.throws(
            () => validateChapterCardPatch({ location: '不存在的地点' }, diagnosis),
            error => error.code === 'invalid_reference',
        );
        assert.throws(
            () => validateReviewPatch({ review: '通过', operations: [{ op: 'replace', path: '/status' }] }),
            error => error.code === 'unknown_fields',
        );
        assert.throws(
            () => validateReviewPatch({ review: { result: '通过' } }),
            error => error.code === 'invalid_patch_type',
        );
        assert.throws(
            () => validateReviewPatch({ notes: '只有备注' }),
            error => error.code === 'missing_review',
        );
    });

    test('creates review candidates as inert, evidence-bound artifacts', () => {
        const input = fixture();
        input.chapter.content = '林照把路引递给守将，仍然没有解释铜钥匙。';
        const before = structuredClone(input);
        const diagnosis = diagnosePlanning(input);
        const contentEvidence = diagnosis.evidenceCatalog.find(item => (
            item.source.path === `chapters/${input.chapter.id}/content`
        ));
        assert.ok(contentEvidence);

        const artifact = createReviewCandidate({
            diagnosis,
            patch: {
                review: '路引动作已经落地，但章尾钩子尚未兑现。',
                notes: '下一轮只补章尾回声，不改动连续性账本。',
            },
            evidenceIds: [contentEvidence.evidenceId],
        });
        assert.equal(artifact.kind, 'chapter-review');
        assert.equal(artifact.target.type, 'chapter-quality');
        assert.deepEqual(validateCandidateArtifact(artifact, diagnosis), artifact);
        assert.deepEqual(input, before);
    });

    test('suggests only missing chapter-card fields from safe planning evidence', () => {
        const input = fixture();
        input.chapter.card = {
            ...input.chapter.card,
            summary: '',
            conflict: '',
            turn: '',
            hook: '',
            time: '',
            required: '',
            avoid: '',
        };
        const before = structuredClone(input);
        const diagnosis = diagnosePlanning(input);
        const first = suggestChapterCardPatch({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });
        const second = suggestChapterCardPatch({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });

        assert.deepEqual(first, second);
        assert.deepEqual(input, before);
        assert.equal(Object.hasOwn(first, 'goal'), false);
        assert.equal(Object.hasOwn(first, 'pov'), false);
        assert.equal(Object.hasOwn(first, 'location'), false);
        assert.ok(['summary', 'conflict', 'turn', 'hook', 'time', 'required', 'avoid']
            .every(field => typeof first[field] === 'string' && first[field].trim()));
        assert.match(first.summary, /林照抵达赤门|合法入城身份/);
        assert.match(first.conflict, /路引检查/);
        assert.match(first.turn, /围绕路引、钥匙和守将推进/);
        assert.equal(first.time, '入夜');
        assert.match(first.required, /路引检查/);
        assert.match(first.avoid, /未来或私密事实/);
        const serialized = JSON.stringify(first);
        assert.doesNotMatch(serialized, /FUTURE_|HIDDEN_FACT_SECRET|PRIVATE_EVENT|RELATION_PRIVATE|masterOutline/);
        assert.doesNotMatch(serialized, /\{\{|<script|javascript:/i);
    });

    test('creates deterministic suggested candidates with safe auto-selected evidence', () => {
        const input = fixture();
        input.chapter.card = {
            ...input.chapter.card,
            summary: '',
            conflict: '',
            turn: '',
            hook: '',
            required: '',
            avoid: '',
        };
        const before = structuredClone(input);
        const diagnosis = diagnosePlanning(input);
        const expectedPatch = suggestChapterCardPatch({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });
        const first = createSuggestedChapterCardCandidate({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });
        const second = createSuggestedChapterCardCandidate({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });

        assert.deepEqual(first, second);
        assert.deepEqual(first.patch, expectedPatch);
        assert.deepEqual(validateCandidateArtifact(first, diagnosis), first);
        assert.ok(first.evidenceIds.length > 0);
        const evidenceById = new Map(diagnosis.evidenceCatalog.map(item => [item.evidenceId, item]));
        for (const id of first.evidenceIds) {
            const evidence = evidenceById.get(id);
            assert.ok(evidence);
            assert.equal(evidence.source.path === 'project/story/masterOutline', false);
            assert.ok(evidence.visibility === 'pov-safe' || evidence.scope === 'planning');
        }
        assert.deepEqual(input, before);

        const masterOutline = diagnosis.evidenceCatalog.find(item => item.source.path === 'project/story/masterOutline');
        assert.throws(
            () => createSuggestedChapterCardCandidate({
                project: input.project,
                chapter: input.chapter,
                diagnosis,
                evidenceIds: [masterOutline.evidenceId],
            }),
            error => error.code === 'unsafe_suggestion_evidence',
        );
    });

    test('returns no suggestion and refuses a candidate when the chapter card is already complete', () => {
        const input = fixture();
        const diagnosis = diagnosePlanning(input);
        assert.deepEqual(suggestChapterCardPatch({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        }), {});
        assert.throws(
            () => createSuggestedChapterCardCandidate({
                project: input.project,
                chapter: input.chapter,
                diagnosis,
            }),
            error => error.code === 'no_missing_card_fields',
        );
    });

    test('falls back safely when optional planning evidence is absent', () => {
        const input = fixture();
        input.project.story = Object.fromEntries(Object.keys(input.project.story).map(field => [field, '']));
        input.project.volumes[0] = {
            ...input.project.volumes[0],
            goal: '', outline: '', summary: '',
        };
        input.project.storyState.promises = [];
        input.chapters[0].card.summary = '';
        input.chapters[0].content = '';
        input.chapter.card = Object.fromEntries(Object.keys(input.chapter.card).map(field => [field, '']));
        const diagnosis = diagnosePlanning(input);
        const patch = suggestChapterCardPatch({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });
        const artifact = createSuggestedChapterCardCandidate({
            project: input.project,
            chapter: input.chapter,
            diagnosis,
        });

        assert.match(patch.goal, /阶段目标/);
        assert.match(patch.conflict, /明确阻力/);
        assert.match(patch.hook, /下一章必须回应/);
        assert.equal(artifact.kind, 'chapter-card');
        assert.ok(artifact.evidenceIds.length >= 1);
        assert.deepEqual(artifact.patch, patch);
    });
});
