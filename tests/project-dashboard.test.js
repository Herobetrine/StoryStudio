import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildProjectDashboard } from '../src/project-dashboard.js';

function projectFixture() {
    return {
        id: 'project-one',
        title: '长宁夜行',
        genre: '玄幻',
        version: 12,
        targetWords: 100_000,
        chapterTargetWords: 3_000,
        updatedAt: '2026-07-16T08:00:00.000Z',
        volumes: [
            { id: 'volume-one', number: 1, title: '长宁卷', revision: 3 },
        ],
        chapters: [
            {
                id: 'chapter-one',
                number: 1,
                title: '雨夜',
                status: 'done',
                wordCount: 2_800,
                volumeId: 'volume-one',
                planBasis: { volumeRevision: 2 },
                updatedAt: '2026-07-14T08:00:00.000Z',
            },
            {
                id: 'chapter-two',
                number: 2,
                title: '入城',
                status: 'drafting',
                wordCount: 1_200,
                volumeId: 'volume-one',
                planBasis: { volumeRevision: 2 },
                updatedAt: '2026-07-16T08:00:00.000Z',
            },
            {
                id: 'chapter-three',
                number: 3,
                title: '路引',
                status: 'planned',
                wordCount: 0,
                volumeId: 'volume-one',
                planBasis: { volumeRevision: 3 },
                updatedAt: '2026-07-15T08:00:00.000Z',
            },
        ],
        continuity: [
            { id: 'continuity-one', status: 'active' },
            { id: 'continuity-two', status: 'retired' },
        ],
        storyState: {
            entities: [
                { id: 'hero', status: 'active' },
                { id: 'former-guard', status: 'retired' },
            ],
            relations: [{ id: 'relation-one' }],
            events: [{ id: 'event-one' }],
            facts: [{ id: 'fact-one' }],
            memory: [{ id: 'memory-one' }],
            promises: [
                {
                    id: 'promise-key',
                    title: '铜钥匙来源',
                    summary: '钥匙与旧城门有关。',
                    status: 'open',
                    urgency: 5,
                    introducedChapterId: 'chapter-one',
                    dueChapterId: 'chapter-two',
                },
                {
                    id: 'promise-closed',
                    title: '已兑现',
                    status: 'resolved',
                    urgency: 5,
                    dueChapterId: 'chapter-one',
                },
            ],
        },
    };
}

describe('project dashboard projection', () => {
    test('prioritizes stale chapter plans and exposes urgent promise debt', () => {
        const dashboard = buildProjectDashboard(projectFixture());

        assert.equal(dashboard.dashboardVersion, 1);
        assert.deepEqual(dashboard.progress, {
            totalWords: 4_000,
            targetWords: 100_000,
            percent: 4,
            chapterCount: 3,
            chapterTargetWords: 3_000,
            chapterStatuses: {
                planned: 1,
                drafting: 1,
                revising: 0,
                done: 1,
                other: 0,
            },
        });
        assert.equal(dashboard.nextAction.kind, 'review-plan');
        assert.equal(dashboard.nextAction.chapterId, 'chapter-two');
        assert.equal(dashboard.debts.stalePlanCount, 1);
        assert.equal(dashboard.debts.openPromiseCount, 1);
        assert.equal(dashboard.debts.urgentPromiseCount, 1);
        assert.equal(dashboard.debts.openPromises[0].overdue, true);
        const promiseDebt = dashboard.workItems.find(item => item.kind === 'promise-debt');
        assert.ok(promiseDebt);
        assert.equal(promiseDebt.view, 'ledger');
        assert.equal(promiseDebt.promiseId, 'promise-key');
        assert.equal(dashboard.storyState.activeEntityCount, 1);
        assert.equal(dashboard.debts.activeContinuityCount, 1);
        assert.equal(dashboard.recentChapters[0].id, 'chapter-two');
    });

    test('continues revisions before drafts and plans when no plan is stale', () => {
        const project = projectFixture();
        project.volumes[0].revision = 2;
        project.chapters[2].planBasis.volumeRevision = 2;
        project.chapters[2].status = 'revising';

        const dashboard = buildProjectDashboard(project);

        assert.equal(dashboard.nextAction.kind, 'continue-revision');
        assert.equal(dashboard.nextAction.chapterId, 'chapter-three');
        assert.equal(dashboard.focusChapter.id, 'chapter-three');
        assert.equal(dashboard.debts.stalePlanCount, 0);
    });

    test('suggests adding a chapter after all existing chapters are done', () => {
        const project = projectFixture();
        project.volumes[0].revision = 2;
        project.volumes.push({ id: 'volume-two', number: 2, title: '新卷', revision: 1 });
        for (const chapter of project.chapters) {
            chapter.status = 'done';
            chapter.planBasis.volumeRevision = 2;
        }

        const dashboard = buildProjectDashboard(project);

        assert.equal(dashboard.nextAction.kind, 'add-chapter');
        assert.equal(dashboard.nextAction.chapterId, null);
        assert.equal(dashboard.nextAction.volumeId, 'volume-two');
        assert.equal(dashboard.nextAction.view, 'bible');
        assert.equal(dashboard.focusChapter, null);
    });

    test('rejects non-object input', () => {
        assert.throws(() => buildProjectDashboard(null), /project must be an object/);
        assert.throws(() => buildProjectDashboard([]), /project must be an object/);
    });
});
