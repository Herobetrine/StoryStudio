import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    normalizeBrainstormDirectionSet,
    normalizeWorkflowV2Direction,
    normalizeWorkflowV2ArtifactPayload,
    workflowContractDigest,
} from '../src/workflow-contracts.js';

const digest = value => workflowContractDigest(value);

function brainstormSet() {
    const generationId = 'generation-brainstorm';
    const exclusivityAxis = '主角在关城前只能选择一条离城路线';
    const diagnosisDigest = digest('diagnosis');
    const sourceSnapshotDigest = digest('snapshot');
    const directions = [
        {
            id: 'route-gate', title: '强闯城门', forkChoice: '公开强闯城门',
            protagonistAction: '主角借人群掩护冲击封锁线。', directResult: '守军被迫收缩阵形。',
            delayedCost: '主角身份完全暴露。', chapterPromise: '兑现守军搜捕压力。',
            eventSeeds: ['接近城门', '制造混乱', '越过封锁'],
        },
        {
            id: 'route-river', title: '潜入暗河', forkChoice: '秘密潜入暗河',
            protagonistAction: '主角寻找废弃排水口。', directResult: '暂时避开正面搜捕。',
            delayedCost: '必须放弃大部分装备。', chapterPromise: '兑现地下路线伏笔。',
            eventSeeds: ['找到入口', '舍弃装备', '进入暗河'],
        },
        {
            id: 'route-deal', title: '交换通行', forkChoice: '与守军交换通行资格',
            protagonistAction: '主角拿秘密向守将谈判。', directResult: '获得一次受监视的通行。',
            delayedCost: '秘密落入敌手。', chapterPromise: '兑现守将的利益诉求。',
            eventSeeds: ['接触守将', '交出筹码', '获得通行'],
        },
    ];
    const setDigest = digest({
        generationId, exclusivityAxis, directions, diagnosisDigest, sourceSnapshotDigest,
    });
    return directions.map((direction, directionIndex) => {
        const siblings = directions.filter(item => item.id !== direction.id);
        return {
            payloadVersion: 1,
            generationId,
            setDigest,
            directionIndex,
            directionCount: directions.length,
            exclusivityAxis,
            direction,
            siblingDigests: siblings.map(digest),
            pairwiseExclusion: siblings.map(item => ({
                otherDirectionId: item.id,
                reason: `${direction.forkChoice} 后无法同时执行 ${item.forkChoice}。`,
            })),
            diagnosisDigest,
            sourceSnapshotDigest,
        };
    });
}

function chapterPlan() {
    const eventChain = [
        {
            id: 'beat-1', causedBy: null, trigger: '封城令提前生效', choice: '立刻离城',
            action: '主角前往暗河入口', result: '发现入口被封', cost: '失去准备时间',
            valueShift: '安全转为暴露风险', information: '封锁者知道旧入口',
        },
        {
            id: 'beat-2', causedBy: 'beat-1', trigger: '入口被封', choice: '舍弃装备钻入裂口',
            action: '主角拆下甲片', result: '通过狭窄裂口', cost: '防护能力下降',
            valueShift: '受阻转为短暂推进', information: '暗河仍有水流',
        },
        {
            id: 'beat-3', causedBy: 'beat-2', trigger: '追兵进入暗河', choice: '破坏支撑柱',
            action: '主角引发局部塌方', result: '暂时截断追兵', cost: '退路也被封死',
            valueShift: '被追转为孤注一掷', information: '前方存在未知出口',
        },
        {
            id: 'beat-4', causedBy: 'beat-3', trigger: '水位突然上涨', choice: '冲向未知出口',
            action: '主角借水势撞开铁栅', result: '落入城外水渠', cost: '关键地图被冲走',
            valueShift: '困城转为逃出但失去指引', information: '城外已有接应者等待',
        },
    ];
    const chapterCard = {
        summary: '主角经暗河逃出封城，却失去关键地图。',
        goal: '在封城完成前离开城内。',
        conflict: '守军封锁暗河并派追兵进入。',
        turn: '塌方挡住追兵，也封死主角退路。',
        hook: '城外已有陌生接应者等待。',
        pov: '主角限知视角。',
        time: '封城令生效当夜。',
        location: '旧排水口至城外水渠。',
        required: '兑现暗河路线和封城压力。',
        avoid: '不得提前揭示接应者身份。',
    };
    const coverage = {
        required: [{ item: chapterCard.required, beatIds: ['beat-1', 'beat-2', 'beat-3'] }],
        avoid: [{ item: chapterCard.avoid, guard: '只写主角看见人影，不给身份信息。' }],
        volumeGoal: { summary: '主角离开长宁城。', beatIds: ['beat-4'] },
        promises: [{ promiseId: 'promise-dark-river', action: 'resolve', beatIds: ['beat-2', 'beat-4'] }],
    };
    const withoutDigest = {
        payloadVersion: 1,
        generationId: 'generation-plan',
        directionArtifactId: 'artifact-direction-river',
        directionDigest: digest(brainstormSet()[1].direction),
        eventChain,
        chapterCard,
        coverage,
    };
    return { ...withoutDigest, planDigest: digest(withoutDigest) };
}

function chapterReview(sourceText) {
    const start = sourceText.indexOf('乙拔刀。');
    const end = start + '乙拔刀。'.length;
    const issues = [{
        id: 'issue-weapon',
        severity: 'major',
        category: 'motivation',
        start,
        end,
        paragraphIndex: 1,
        quote: '乙拔刀。',
        reason: '乙此前没有敌意，动作缺少触发。',
        suggestion: '改为乙确认来者身份后收刀让路。',
        evidenceIds: ['retrieval:chapter-1'],
    }];
    const withoutDigest = {
        payloadVersion: 1,
        generationId: 'generation-review',
        manuscriptArtifactId: 'artifact-draft',
        manuscriptGenerationId: 'generation-draft',
        manuscriptDigest: digest(sourceText),
        verdict: 'rewrite',
        rewriteRequired: true,
        summary: '主要问题是乙的动作缺少动机承接。',
        issues,
        rewriteTarget: {
            start,
            end,
            quote: '乙拔刀。',
            issueIds: ['issue-weapon'],
            instruction: '补足身份确认并让动作回到当前关系状态。',
        },
        coverage: {
            goal: { status: 'partial', evidenceIssueIds: ['issue-weapon'] },
            required: [{ item: '主角获得通行', status: 'partial', evidenceIssueIds: ['issue-weapon'] }],
            avoid: [{ item: '不让乙无故攻击', status: 'missed', evidenceIssueIds: ['issue-weapon'] }],
            volumeGoal: { status: 'met', evidenceIssueIds: [] },
            promises: [{ promiseId: 'promise-gate', status: 'partial', evidenceIssueIds: ['issue-weapon'] }],
        },
    };
    return { ...withoutDigest, reviewDigest: digest(withoutDigest) };
}

function rewriteDiff(baseText, review) {
    const { start, end, issueIds } = review.rewriteTarget;
    const before = baseText.slice(start, end);
    const after = '乙认出来人，缓缓收刀。';
    const resultText = `${baseText.slice(0, start)}${after}${baseText.slice(end)}`;
    return {
        resultText,
        payload: {
            payloadVersion: 1,
            generationId: 'generation-rewrite',
            baseManuscriptArtifactId: review.manuscriptArtifactId,
            baseGenerationId: review.manuscriptGenerationId,
            baseDigest: digest(baseText),
            reviewArtifactId: 'artifact-review',
            reviewDigest: review.reviewDigest,
            rewriteRequired: true,
            resultDigest: digest(resultText),
            transform: {
                type: 'replace-range-v1', start, end,
                beforeDigest: digest(before), afterDigest: digest(after), issueIds,
            },
            diff: { format: 'replace-range-v1', start, end, before, after, issueIds },
            contentUnits: resultText.length,
        },
    };
}

function emptyStoryStateChanges() {
    return Object.fromEntries([
        'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
    ].map(category => [category, { upsert: [], delete: [] }]));
}

function adoptionBundle(plan, review, manuscriptDigest) {
    const chapterCard = { ...plan.chapterCard, summary: '主角经暗河逃出封城并失去地图。' };
    const storyStateChanges = emptyStoryStateChanges();
    const chapterSummary = chapterCard.summary;
    const changesDigest = digest({ chapterSummary, storyStateChanges });
    const withoutDigest = {
        payloadVersion: 1,
        manuscriptArtifactId: 'artifact-rewrite',
        manuscriptGenerationId: 'generation-rewrite',
        manuscriptDigest,
        directionArtifactId: plan.directionArtifactId,
        planArtifactId: 'artifact-plan',
        planDigest: plan.planDigest,
        reviewArtifactId: 'artifact-review',
        reviewDigest: review.reviewDigest,
        rewriteArtifactId: 'artifact-rewrite',
        chapterCard,
        chapterSummary,
        storyStateChanges,
        targetStoryStateDigest: digest('target-story-state'),
        changesDigest,
        authorityFingerprint: {
            projectDigest: digest('project-authority'),
            chapterDigest: digest('chapter-authority'),
        },
    };
    return { ...withoutDigest, adoptionDigest: digest(withoutDigest) };
}

describe('Workflow V2 artifact contracts', () => {
    test('accepts exactly one complete 3-6 direction set with pairwise exclusion evidence', () => {
        const source = brainstormSet();
        const normalized = normalizeBrainstormDirectionSet(source);
        assert.equal(normalized.length, 3);
        assert.deepEqual(normalized.map(item => item.directionIndex), [0, 1, 2]);
        assert.equal(Object.hasOwn(normalized[0].direction, 'sourceEventChain'), false);

        const missingPair = structuredClone(source);
        missingPair[0].pairwiseExclusion[0].otherDirectionId = missingPair[0].direction.id;
        assert.throws(
            () => normalizeBrainstormDirectionSet(missingPair),
            error => error.code === 'invalid_workflow_artifact_payload',
        );

        const duplicateChoice = structuredClone(source);
        duplicateChoice[1].direction.forkChoice = duplicateChoice[0].direction.forkChoice;
        assert.throws(
            () => normalizeBrainstormDirectionSet(duplicateChoice),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });

    test('preserves a complete optional Copilot source chain without changing ordinary directions', () => {
        const sourceEventChain = Array.from({ length: 12 }, (_unused, index) => ({
            order: index + 1,
            event: `源事件 ${index + 1}`,
            characterChoice: `源选择 ${index + 1}`,
            directResult: `源结果 ${index + 1}`,
            cost: `源代价 ${index + 1}`,
        }));
        const ordinary = brainstormSet()[0].direction;
        const normalized = normalizeWorkflowV2Direction({ ...ordinary, sourceEventChain });
        assert.deepEqual(normalized.sourceEventChain, sourceEventChain);
        assert.notEqual(digest(normalized), digest(ordinary));

        const skippedOrder = structuredClone(sourceEventChain);
        skippedOrder[11].order = 11;
        assert.throws(
            () => normalizeWorkflowV2Direction({ ...ordinary, sourceEventChain: skippedOrder }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
        assert.throws(
            () => normalizeWorkflowV2Direction({
                ...ordinary,
                sourceEventChain: [...sourceEventChain, {
                    order: 13,
                    event: '超出边界',
                    characterChoice: '选择',
                    directResult: '结果',
                    cost: '代价',
                }],
            }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
        const oversized = structuredClone(sourceEventChain);
        oversized[0].event = '过'.repeat(10_001);
        assert.throws(
            () => normalizeWorkflowV2Direction({ ...ordinary, sourceEventChain: oversized }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });

    test('binds a chapter plan digest to a strict causal event chain and coverage map', () => {
        const source = chapterPlan();
        const normalized = normalizeWorkflowV2ArtifactPayload('chapter-plan', source);
        assert.equal(normalized.eventChain.at(-1).causedBy, 'beat-3');
        assert.equal(normalized.chapterCard.hook, source.chapterCard.hook);

        const brokenChain = structuredClone(source);
        brokenChain.eventChain[2].causedBy = 'beat-1';
        brokenChain.planDigest = digest({ ...brokenChain, planDigest: undefined });
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-plan', brokenChain),
            error => error.code === 'invalid_workflow_artifact_payload',
        );

        const tampered = { ...source, planDigest: digest('other-plan') };
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-plan', tampered),
            error => error.code === 'invalid_workflow_artifact_payload',
        );

        const covered = {
            ...source,
            sourceEventCoverage: [
                { sourceOrder: 1, beatIds: ['beat-1'] },
                { sourceOrder: 2, beatIds: ['beat-2'] },
                { sourceOrder: 3, beatIds: ['beat-3'] },
            ],
        };
        covered.planDigest = digest(Object.fromEntries(
            Object.entries(covered).filter(([field]) => field !== 'planDigest'),
        ));
        assert.equal(
            normalizeWorkflowV2ArtifactPayload('chapter-plan', covered).sourceEventCoverage.length,
            3,
        );

        const mergedSourceEvents = structuredClone(covered);
        mergedSourceEvents.sourceEventCoverage[2].beatIds = ['beat-2'];
        mergedSourceEvents.planDigest = digest(Object.fromEntries(
            Object.entries(mergedSourceEvents).filter(([field]) => field !== 'planDigest'),
        ));
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-plan', mergedSourceEvents),
            error => error.code === 'invalid_workflow_artifact_payload'
                && /must not reuse beats/u.test(error.message),
        );
    });

    test('rejects partial draft artifacts and verifies completed manuscript digests', () => {
        const sourceText = '第一段完整正文。';
        const payload = {
            payloadVersion: 1,
            generationId: 'generation-draft',
            planArtifactId: 'artifact-plan',
            planDigest: chapterPlan().planDigest,
            contentDigest: digest(sourceText),
            contentUnits: sourceText.length,
            generationStatus: 'completed',
            promptDigest: digest('prompt'),
            sourceSnapshotDigest: digest('snapshot'),
            retrievalEvidenceIds: ['retrieval:chapter-1'],
        };
        assert.equal(normalizeWorkflowV2ArtifactPayload('chapter-draft', payload, { sourceText }).contentDigest,
            payload.contentDigest);
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-draft', {
                ...payload, generationStatus: 'partial',
            }, { sourceText }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });

    test('anchors every review issue and rewrite target to exact manuscript positions', () => {
        const sourceText = '甲推门。\n\n乙拔刀。\n\n丙后退。';
        const review = chapterReview(sourceText);
        const normalized = normalizeWorkflowV2ArtifactPayload('chapter-review', review, { sourceText });
        assert.equal(normalized.issues[0].paragraphIndex, 1);
        assert.equal(normalized.rewriteRequired, true);

        const wrongQuote = structuredClone(review);
        wrongQuote.issues[0].quote = '乙收刀。';
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-review', wrongQuote, { sourceText }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );

        const scoreOnly = {
            ...review, issues: [], rewriteTarget: null, reviewDigest: digest('score-only'),
        };
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-review', scoreOnly, { sourceText }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });

    test('proves the rewrite is one approved replacement and materializes the declared result', () => {
        const baseText = '甲推门。\n\n乙拔刀。\n\n丙后退。';
        const review = chapterReview(baseText);
        const { payload, resultText } = rewriteDiff(baseText, review);
        const normalized = normalizeWorkflowV2ArtifactPayload('rewrite-diff', payload, { baseText, resultText });
        assert.equal(normalized.diff.before, '乙拔刀。');
        assert.equal(normalized.resultDigest, digest(resultText));

        const drifted = structuredClone(payload);
        drifted.diff.before = '乙举刀。';
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('rewrite-diff', drifted, { baseText, resultText }),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });

    test('seals the final chapter card, summary, ChangeSet, lineage, and authority fingerprint', () => {
        const baseText = '甲推门。\n\n乙拔刀。\n\n丙后退。';
        const plan = chapterPlan();
        const review = chapterReview(baseText);
        const { resultText } = rewriteDiff(baseText, review);
        const payload = adoptionBundle(plan, review, digest(resultText));
        const normalized = normalizeWorkflowV2ArtifactPayload('chapter-adoption', payload);
        assert.equal(normalized.chapterSummary, normalized.chapterCard.summary);
        assert.equal(normalized.rewriteArtifactId, 'artifact-rewrite');

        const tampered = structuredClone(payload);
        tampered.chapterSummary = '被替换的摘要';
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('chapter-adoption', tampered),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
        assert.throws(
            () => normalizeWorkflowV2ArtifactPayload('unknown-kind', {}),
            error => error.code === 'invalid_workflow_artifact_payload',
        );
    });
});
