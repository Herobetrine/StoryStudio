const CLOSED_PROMISE_STATUSES = new Set([
    'resolved',
    'closed',
    'fulfilled',
    'retired',
    'cancelled',
    'canceled',
    'done',
]);

const ACTIVE_CONTINUITY_STATUSES = new Set([
    'active',
    'open',
    'pending',
    'ongoing',
    'in-progress',
    'blocked',
    'planned',
]);

const CHAPTER_STATUS_ORDER = Object.freeze({
    revising: 0,
    drafting: 1,
    planned: 2,
    done: 3,
});

function normalizedStatus(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

function safeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
}

function chapterSnapshot(chapter) {
    return {
        id: chapter.id,
        number: safeInteger(chapter.number),
        title: String(chapter.title ?? ''),
        status: String(chapter.status ?? 'planned'),
        wordCount: Math.max(0, safeInteger(chapter.wordCount)),
        volumeId: chapter.volumeId ?? null,
        updatedAt: chapter.updatedAt ?? null,
    };
}

function sortedChapters(project) {
    return safeArray(project?.chapters)
        .map(chapterSnapshot)
        .sort((left, right) => left.number - right.number);
}

function volumeSnapshot(volume) {
    return {
        id: volume.id,
        number: safeInteger(volume.number),
        title: String(volume.title ?? ''),
        revision: Math.max(1, safeInteger(volume.revision, 1)),
    };
}

function staleChapterPlans(project, chapters) {
    const volumeById = new Map(safeArray(project?.volumes).map(volume => [
        volume.id,
        volumeSnapshot(volume),
    ]));
    const sourceChapterById = new Map(safeArray(project?.chapters).map(chapter => [chapter.id, chapter]));
    return chapters
        .filter(chapter => normalizedStatus(chapter.status) !== 'done')
        .flatMap(chapter => {
            const source = sourceChapterById.get(chapter.id);
            const volume = volumeById.get(chapter.volumeId);
            const planRevision = safeInteger(source?.planBasis?.volumeRevision, 0);
            if (volume && planRevision === volume.revision) return [];
            return [{
                ...chapter,
                volume: volume ?? null,
                planRevision,
                currentVolumeRevision: volume?.revision ?? null,
                reason: volume ? 'volume-revision-changed' : 'volume-missing',
            }];
        });
}

function chooseFocusChapter(chapters) {
    return chapters
        .filter(chapter => normalizedStatus(chapter.status) !== 'done')
        .sort((left, right) => {
            const statusDifference = (CHAPTER_STATUS_ORDER[normalizedStatus(left.status)] ?? 9)
                - (CHAPTER_STATUS_ORDER[normalizedStatus(right.status)] ?? 9);
            return statusDifference || left.number - right.number;
        })[0] ?? null;
}

function nextAction(project, chapters, stalePlans) {
    const stale = stalePlans[0];
    if (stale) {
        return {
            kind: 'review-plan',
            label: `复核第${stale.number}章章纲`,
            detail: stale.volume
                ? `所属卷纲已从修订 ${stale.planRevision} 更新到 ${stale.currentVolumeRevision}。`
                : '章节引用的卷已不存在，需要重新绑定并复核章纲。',
            chapterId: stale.id,
            volumeId: stale.volumeId,
            view: 'editor',
        };
    }

    const focus = chooseFocusChapter(chapters);
    if (!focus) {
        const last = chapters.at(-1);
        const finalVolume = safeArray(project?.volumes)
            .map(volumeSnapshot)
            .sort((left, right) => left.number - right.number)
            .at(-1);
        return {
            kind: 'add-chapter',
            label: '规划下一章',
            detail: last
                ? `现有 ${chapters.length} 章均已完成，可以建立后续章节。`
                : '作品尚无章节，可以建立第一章。',
            chapterId: null,
            volumeId: finalVolume?.id ?? last?.volumeId ?? null,
            view: 'bible',
        };
    }

    const status = normalizedStatus(focus.status);
    const action = status === 'revising'
        ? ['continue-revision', `继续修订第${focus.number}章`, '章节处于修订状态，优先完成当前修订。']
        : status === 'drafting'
            ? ['continue-draft', `继续写第${focus.number}章`, '章节已有初稿进度，继续写作可减少上下文切换。']
            : ['start-chapter', `开始第${focus.number}章`, '从章纲、上下文预览或完整流程开始本章。'];
    return {
        kind: action[0],
        label: action[1],
        detail: action[2],
        chapterId: focus.id,
        volumeId: focus.volumeId,
        view: 'editor',
    };
}

function openPromises(project, focusNumber, chapterNumberById) {
    return safeArray(project?.storyState?.promises)
        .filter(item => !CLOSED_PROMISE_STATUSES.has(normalizedStatus(item.status)))
        .map(item => {
            const dueChapterNumber = item.dueChapterId
                ? chapterNumberById.get(item.dueChapterId) ?? null
                : null;
            const introducedChapterNumber = item.introducedChapterId
                ? chapterNumberById.get(item.introducedChapterId) ?? null
                : null;
            const overdue = dueChapterNumber !== null
                && focusNumber !== null
                && dueChapterNumber <= focusNumber;
            return {
                id: item.id,
                title: String(item.title ?? ''),
                summary: String(item.summary ?? ''),
                kind: String(item.kind ?? 'foreshadowing'),
                status: String(item.status ?? 'open'),
                urgency: Math.max(0, Math.min(5, safeInteger(item.urgency))),
                introducedChapterId: item.introducedChapterId ?? null,
                introducedChapterNumber,
                dueChapterId: item.dueChapterId ?? null,
                dueChapterNumber,
                overdue,
            };
        })
        .sort((left, right) => Number(right.overdue) - Number(left.overdue)
            || right.urgency - left.urgency
            || (left.dueChapterNumber ?? Number.MAX_SAFE_INTEGER)
                - (right.dueChapterNumber ?? Number.MAX_SAFE_INTEGER)
            || left.title.localeCompare(right.title, 'zh-CN'));
}

function chapterCounts(chapters) {
    const counts = { planned: 0, drafting: 0, revising: 0, done: 0, other: 0 };
    for (const chapter of chapters) {
        const status = normalizedStatus(chapter.status);
        if (Object.hasOwn(counts, status) && status !== 'other') counts[status] += 1;
        else counts.other += 1;
    }
    return counts;
}

function workItems(primaryAction, promises, stalePlans) {
    const items = [{
        ...primaryAction,
        priority: 'primary',
    }];
    for (const promise of promises.filter(item => item.overdue || item.urgency >= 4).slice(0, 3)) {
        items.push({
            kind: 'promise-debt',
            priority: promise.overdue ? 'urgent' : 'high',
            label: promise.overdue ? `兑现逾期伏笔：${promise.title}` : `关注伏笔：${promise.title}`,
            detail: promise.dueChapterNumber === null
                ? `紧急度 ${promise.urgency}/5，尚未指定兑现章节。`
                : `计划在第 ${promise.dueChapterNumber} 章前后兑现，紧急度 ${promise.urgency}/5。`,
            promiseId: promise.id,
            chapterId: promise.dueChapterId,
            view: 'ledger',
        });
    }
    for (const chapter of stalePlans.slice(0, 3)) {
        if (primaryAction.kind === 'review-plan' && primaryAction.chapterId === chapter.id) continue;
        items.push({
            kind: 'review-plan',
            priority: 'high',
            label: `复核第${chapter.number}章章纲`,
            detail: `卷纲修订 ${chapter.planRevision} → ${chapter.currentVolumeRevision ?? '缺失'}。`,
            chapterId: chapter.id,
            volumeId: chapter.volumeId,
            view: 'editor',
        });
    }
    return items;
}

/**
 * Builds a deterministic author-facing "today" projection from an authoritative project snapshot.
 * The projection is read-only and never mutates Canon or chapter state.
 *
 * @param {object} project Validated StoryStudio project snapshot.
 * @returns {object} Dashboard V1 projection.
 */
export function buildProjectDashboard(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
        throw new TypeError('project must be an object');
    }
    const chapters = sortedChapters(project);
    const chapterNumberById = new Map(chapters.map(chapter => [chapter.id, chapter.number]));
    const stalePlans = staleChapterPlans(project, chapters);
    const focus = chooseFocusChapter(chapters);
    const focusNumber = focus?.number ?? chapters.at(-1)?.number ?? null;
    const promises = openPromises(project, focusNumber, chapterNumberById);
    const action = nextAction(project, chapters, stalePlans);
    const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
    const targetWords = Math.max(1, safeInteger(project.targetWords, 1));
    const activeContinuityCount = safeArray(project.continuity)
        .filter(item => ACTIVE_CONTINUITY_STATUSES.has(normalizedStatus(item.status))).length;
    const activeEntityCount = safeArray(project.storyState?.entities)
        .filter(item => !['retired', 'dead', 'inactive', 'removed'].includes(normalizedStatus(item.status))).length;
    const counts = chapterCounts(chapters);

    return {
        dashboardVersion: 1,
        project: {
            id: project.id,
            title: String(project.title ?? ''),
            genre: String(project.genre ?? ''),
            version: safeInteger(project.version),
            updatedAt: project.updatedAt ?? null,
        },
        progress: {
            totalWords,
            targetWords,
            percent: Math.min(100, Math.round((totalWords / targetWords) * 1_000) / 10),
            chapterCount: chapters.length,
            chapterTargetWords: Math.max(0, safeInteger(project.chapterTargetWords)),
            chapterStatuses: counts,
        },
        nextAction: action,
        focusChapter: focus,
        workItems: workItems(action, promises, stalePlans),
        debts: {
            openPromises: promises,
            openPromiseCount: promises.length,
            urgentPromiseCount: promises.filter(item => item.overdue || item.urgency >= 4).length,
            stalePlans,
            stalePlanCount: stalePlans.length,
            activeContinuityCount,
        },
        storyState: {
            activeEntityCount,
            relationCount: safeArray(project.storyState?.relations).length,
            eventCount: safeArray(project.storyState?.events).length,
            factCount: safeArray(project.storyState?.facts).length,
            memoryCount: safeArray(project.storyState?.memory).length,
        },
        recentChapters: [...chapters]
            .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
            .slice(0, 5),
    };
}
