const DEFAULT_LIMITS = Object.freeze({
    entities: 100,
    relations: 100,
    events: 40,
    promises: 60,
    memory: 40,
    facts: 80,
    knowledge: 120,
    timeline: 40,
});
const KNOWLEDGE_STANCES = new Set(['knows', 'suspects', 'believes', 'denies', 'hides']);
const VISIBLE_KNOWLEDGE_STANCES = new Set(['knows', 'suspects', 'believes', 'denies']);
const PRIVATE_EVENT_VISIBILITIES = new Set(['private', 'behind-the-scenes', 'secret']);
const PUBLIC_EVENT_VISIBILITIES = new Set(['public', 'all', 'reader']);
const RETIRED_STATUSES = new Set(['retired', 'superseded']);
const COMPLETED_PROMISE_STATUSES = new Set(['resolved', 'closed', 'completed', 'complete', 'done']);

function sourceText(chapter, previousChapter, nextChapter) {
    return [
        chapter?.title,
        JSON.stringify(chapter?.card ?? {}),
        chapter?.content,
        previousChapter?.title,
        JSON.stringify(previousChapter?.card ?? {}),
        String(previousChapter?.content ?? '').slice(-8_000),
        nextChapter?.title,
        JSON.stringify(nextChapter?.card ?? {}),
    ].filter(Boolean).join('\n').toLocaleLowerCase();
}

function normalizedIds(value) {
    return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string'))] : [];
}

function addReason(reasonMap, id, reason) {
    if (!reasonMap.has(id)) reasonMap.set(id, new Set());
    reasonMap.get(id).add(reason);
}

function hasMention(entity, haystack) {
    return [entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]
        .filter(value => typeof value === 'string' && value.trim().length > 0)
        .some(value => haystack.includes(value.trim().toLocaleLowerCase()));
}

function takeByReasons(records, reasonMap, maximum, preferredReason = '') {
    const selected = records.filter(record => reasonMap.has(record.id));
    const limit = boundedLimit(maximum);
    if (limit === 0) return [];
    const preferredReasons = Array.isArray(preferredReason)
        ? preferredReason.filter(Boolean)
        : [preferredReason].filter(Boolean);
    if (preferredReasons.length === 0) return selected.slice(0, limit);
    const priority = record => {
        const reasons = reasonMap.get(record.id);
        const index = preferredReasons.findIndex(reason => reasons?.has(reason));
        return index < 0 ? preferredReasons.length : index;
    };
    return selected
        .map((record, index) => ({ record, index, priority: priority(record) }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .slice(0, limit)
        .map(item => item.record);
}

function normalizedStatus(value) {
    return String(value ?? '').trim().toLocaleLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
}

function retiredReason(record) {
    if (RETIRED_STATUSES.has(normalizedStatus(record?.status))) return normalizedStatus(record.status);
    if (typeof record?.supersededById === 'string' && record.supersededById && record.supersededById !== record.id) {
        return 'superseded';
    }
    return '';
}

function safeRecords(records, category, filteredItems) {
    return records.filter(record => {
        const reason = retiredReason(record);
        if (!reason) return true;
        filteredItems.push({
            category,
            id: category === 'facts' ? null : record?.id ?? null,
            reason,
            ...(category === 'facts' ? { redacted: true } : {}),
        });
        return false;
    });
}

function safeRelations(records, filteredItems) {
    return records.map(record => {
        if (!record || !Object.hasOwn(record, 'privateSummary')) return record;
        const projected = { ...record };
        if (typeof projected.privateSummary === 'string' && projected.privateSummary.trim()) {
            projected.summary = typeof projected.publicSummary === 'string' ? projected.publicSummary : '';
        }
        delete projected.privateSummary;
        filteredItems.push({ category: 'relations', id: record.id ?? null, reason: 'private-summary-redacted' });
        return projected;
    });
}

function visibilityScopeMatches(value, povEntity) {
    if (!povEntity || typeof value !== 'string') return false;
    const source = value.trim();
    const lowered = lookupText(source);
    const ids = [povEntity.id].filter(item => typeof item === 'string' && item);
    const names = [povEntity.name, ...(Array.isArray(povEntity.aliases) ? povEntity.aliases : [])]
        .filter(item => typeof item === 'string' && item.trim());
    const prefixes = ['pov:', 'entity:', 'character:', 'reader-and-', 'reader+', 'reader:', 'scoped:'];
    for (const prefix of prefixes) {
        if (!lowered.startsWith(prefix)) continue;
        const scope = source.slice(prefix.length).trim();
        if (ids.some(id => scope === id)) return true;
        return names.some(name => lookupText(scope) === lookupText(name));
    }
    if (ids.some(id => source === id)) return true;
    return names.some(name => lowered === lookupText(name));
}

function eventIsVisible(event, povEntity, { legacyMissingVisibility = false } = {}) {
    const rawVisibility = event?.visibility;
    if ((rawVisibility === undefined || rawVisibility === null || rawVisibility === '') && legacyMissingVisibility) {
        return true;
    }
    const visibility = normalizedStatus(rawVisibility);
    if (PUBLIC_EVENT_VISIBILITIES.has(visibility)) return true;
    if (PRIVATE_EVENT_VISIBILITIES.has(visibility)) return false;
    return visibilityScopeMatches(String(rawVisibility ?? ''), povEntity);
}

function safeEvents(records, povEntity, filteredItems, options = {}) {
    return records.filter(event => {
        if (eventIsVisible(event, povEntity, options)) return true;
        filteredItems.push({
            category: 'events',
            id: null,
            reason: `visibility:${normalizedStatus(event?.visibility) || 'missing'}`,
            redacted: true,
        });
        return false;
    });
}

function lookupText(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function resolveEntity(value, entities, { locationsOnly = false } = {}) {
    const source = typeof value === 'string' ? value.trim() : '';
    const query = lookupText(source);
    if (!source) return { entity: null, resolution: 'not-specified', ambiguousIds: [] };
    const candidates = locationsOnly
        ? entities.filter(entity => ['location', 'setting', 'place'].includes(normalizedStatus(entity?.kind)))
        : entities;
    const byId = candidates.find(entity => typeof entity?.id === 'string' && entity.id === source);
    if (byId) return { entity: byId, resolution: 'id', ambiguousIds: [] };
    const matches = candidates.filter(entity => [
        entity?.name,
        ...(Array.isArray(entity?.aliases) ? entity.aliases : []),
    ]
        .some(name => lookupText(name) === query));
    if (matches.length === 1) {
        const resolution = lookupText(matches[0]?.name) === query ? 'name' : 'alias';
        return { entity: matches[0], resolution, ambiguousIds: [] };
    }
    if (matches.length > 1) {
        return { entity: null, resolution: 'ambiguous', ambiguousIds: matches.map(entity => entity.id) };
    }
    return { entity: null, resolution: 'unresolved', ambiguousIds: [] };
}

function compareTimeline(left, right) {
    const sequenceDifference = Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
    return sequenceDifference || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function boundedLimit(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function timelineWindow(records, current, maximum) {
    const limit = boundedLimit(maximum);
    if (limit === 0) return [];
    const selected = records.slice(-limit);
    if (current && !selected.some(item => item.id === current.id)) {
        selected.shift();
        selected.push(current);
        selected.sort(compareTimeline);
    }
    return selected;
}

function chapterNumberMap(project, chapter, previousChapter, nextChapter) {
    const result = new Map();
    for (const item of project?.chapters ?? []) {
        if (typeof item?.id === 'string' && Number.isFinite(Number(item?.number))) {
            result.set(item.id, Number(item.number));
        }
    }
    for (const item of [previousChapter, chapter, nextChapter]) {
        if (typeof item?.id === 'string' && Number.isFinite(Number(item?.number))) {
            result.set(item.id, Number(item.number));
        }
    }
    return result;
}

function currentChapterNumber(chapterNumbers, chapter) {
    const direct = Number(chapter?.number);
    if (Number.isFinite(direct)) return direct;
    const mapped = chapterNumbers.get(chapter?.id);
    return Number.isFinite(mapped) ? mapped : Number.NaN;
}

function chapterIsAvailable(chapterId, chapterNumbers, currentNumber) {
    if (!chapterId) return true;
    if (!Number.isFinite(currentNumber)) return true;
    const itemNumber = chapterNumbers.get(chapterId);
    return Number.isFinite(itemNumber) && itemNumber <= currentNumber;
}

function filterByChapter(records, category, chapterIds, chapterNumbers, currentNumber, filteredItems) {
    return records.filter(record => {
        const ids = chapterIds(record).filter(Boolean);
        if (ids.every(id => chapterIsAvailable(id, chapterNumbers, currentNumber))) return true;
        filteredItems.push({ category, id: null, reason: 'future-or-unknown-chapter', redacted: true });
        return false;
    });
}

function projectPromisesForChapter(records, chapterNumbers, currentNumber, filteredItems) {
    return records.flatMap(record => {
        if (!chapterIsAvailable(record?.introducedChapterId, chapterNumbers, currentNumber)) {
            filteredItems.push({ category: 'promises', id: null, reason: 'future-introduction', redacted: true });
            return [];
        }
        const evidenceChapterIds = Array.isArray(record?.evidenceChapterIds)
            ? record.evidenceChapterIds.filter(id => chapterIsAvailable(id, chapterNumbers, currentNumber))
            : [];
        const resolvedInFuture = record?.resolvedChapterId
            && !chapterIsAvailable(record.resolvedChapterId, chapterNumbers, currentNumber);
        if (!resolvedInFuture && evidenceChapterIds.length === (record?.evidenceChapterIds?.length ?? 0)) {
            return [record];
        }
        const projected = { ...record, evidenceChapterIds };
        if (resolvedInFuture) {
            projected.resolvedChapterId = null;
            if (COMPLETED_PROMISE_STATUSES.has(normalizedStatus(projected.status))) projected.status = 'open';
        }
        return [projected];
    });
}

function timelineForChapter(records, project, chapter, previousChapter, blockedTimelineIds = new Set()) {
    const chapterNumbers = chapterNumberMap(project, chapter, previousChapter, null);
    const currentNumber = currentChapterNumber(chapterNumbers, chapter);
    const eligible = records.filter(item => !blockedTimelineIds.has(item?.id)
        && chapterIsAvailable(item?.chapterId, chapterNumbers, currentNumber));
    const initiallyOrdered = [...eligible].sort(compareTimeline);
    const currentChapterItems = initiallyOrdered.filter(item => item.chapterId === chapter?.id);
    const previousChapterItems = initiallyOrdered.filter(item => item.chapterId === previousChapter?.id);
    const nonPlannedItems = initiallyOrdered.filter(item => !['planned', 'pending', 'future'].includes(normalizedStatus(item.status)));
    const current = currentChapterItems.at(-1) ?? previousChapterItems.at(-1) ?? nonPlannedItems.at(-1) ?? null;
    const currentSequence = current ? Number(current.sequence ?? 0) : Number.POSITIVE_INFINITY;
    const ordered = initiallyOrdered.filter(item => {
        if (item.chapterId) return !current || Number(item.sequence ?? 0) <= currentSequence;
        if (['planned', 'pending', 'future'].includes(normalizedStatus(item.status))) {
            return Boolean(current) && Number(item.sequence ?? 0) <= currentSequence;
        }
        return !current || Number(item.sequence ?? 0) <= currentSequence;
    });
    return {
        ordered,
        current: current && ordered.some(item => item.id === current.id) ? current : ordered.at(-1) ?? null,
    };
}

const FACT_OVERLAP_FIELDS = Object.freeze({
    entities: ['summary', 'currentGoal', 'currentAction'],
    relations: ['summary', 'publicSummary', 'addressing'],
    events: ['title', 'summary'],
    promises: ['title', 'summary'],
    memory: ['summary'],
    timeline: ['label'],
});

function recordSubjectIds(record, category) {
    if (category === 'entities') return [record?.id].filter(Boolean);
    if (category === 'relations') return [record?.fromEntityId, record?.toEntityId].filter(Boolean);
    if (category === 'events') return Array.isArray(record?.entityIds) ? record.entityIds : [];
    return [];
}

function recordSourceChapterIds(record, category) {
    if (category === 'entities') return [record?.updatedChapterId].filter(Boolean);
    if (category === 'relations') return [record?.sinceChapterId].filter(Boolean);
    if (category === 'events') return [record?.chapterId].filter(Boolean);
    if (category === 'promises') return [
        record?.introducedChapterId,
        ...(Array.isArray(record?.evidenceChapterIds) ? record.evidenceChapterIds : []),
    ].filter(Boolean);
    if (category === 'memory') return [
        record?.chapterId,
        ...(Array.isArray(record?.sourceChapterIds) ? record.sourceChapterIds : []),
    ].filter(Boolean);
    if (category === 'timeline') return [record?.chapterId].filter(Boolean);
    return [];
}

function fieldMatchesBlockedFact(record, category, field, blockedFacts) {
    const value = lookupText(record?.[field]);
    if (!value) return false;
    const subjects = recordSubjectIds(record, category);
    const sources = recordSourceChapterIds(record, category);
    return blockedFacts.some(fact => {
        if (lookupText(fact?.summary) !== value) return false;
        if (fact.subjectEntityId && subjects.length > 0 && !subjects.includes(fact.subjectEntityId)) return false;
        if (fact.sourceChapterId && sources.length > 0 && !sources.includes(fact.sourceChapterId)) return false;
        return true;
    });
}

function protectBlockedFactOverlaps(records, category, blockedFacts, filteredItems) {
    if (blockedFacts.length === 0) return records;
    const fields = FACT_OVERLAP_FIELDS[category] ?? [];
    return records.flatMap(record => {
        const matchedFields = fields.filter(field => fieldMatchesBlockedFact(record, category, field, blockedFacts));
        if (matchedFields.length === 0) return [record];
        filteredItems.push({ category, id: null, reason: 'blocked-fact-overlap', redacted: true });
        if (category !== 'entities') return [];
        const projected = { ...record };
        for (const field of matchedFields) projected[field] = '';
        return [projected];
    });
}

function currentTimelineProjection(item) {
    if (!item) return null;
    return {
        timelineId: item.id,
        label: item.label ?? '',
        storyTime: item.storyTime ?? '',
        sequence: item.sequence ?? 0,
        chapterId: item.chapterId ?? null,
        locationEntityId: item.locationEntityId ?? null,
    };
}

function characterEntities(entities) {
    return entities.filter(entity => ['character', 'person'].includes(normalizedStatus(entity?.kind))
        || entity?.currentAction || entity?.currentGoal);
}

function presenceProjection(entities, povEntity, sceneLocationEntityId) {
    const present = [];
    const absent = [];
    const unknown = [];
    for (const entity of characterEntities(entities)) {
        const item = {
            entityId: entity.id,
            name: entity.name ?? '',
            locationEntityId: entity.locationEntityId ?? null,
        };
        if (entity.id === povEntity?.id || (sceneLocationEntityId && entity.locationEntityId === sceneLocationEntityId)) {
            present.push(item);
        } else if (sceneLocationEntityId && entity.locationEntityId) {
            absent.push(item);
        } else {
            unknown.push(item);
        }
    }
    return { present, absent, unknown };
}

function incompleteProgress(event) {
    const status = normalizedStatus(event?.status);
    if (['completed', 'complete', 'resolved', 'occurred', 'done'].includes(status)) return false;
    if (['active', 'open', 'ongoing', 'in-progress', 'pending', 'blocked', 'planned'].includes(status)) return true;
    if (typeof event?.progress === 'number' && Number.isFinite(event.progress)) {
        return event.progress < 100;
    }
    return typeof event?.progress === 'string'
        && ['active', 'ongoing', 'in-progress', 'pending', 'blocked', 'planned']
            .includes(normalizedStatus(event.progress));
}

function unfinishedActionProjection(entities, events) {
    return [
        ...characterEntities(entities)
            .filter(entity => typeof entity?.currentAction === 'string' && entity.currentAction.trim())
            .map(entity => ({
                kind: 'entity-action',
                entityId: entity.id,
                name: entity.name ?? '',
                currentGoal: entity.currentGoal ?? '',
                currentAction: entity.currentAction,
                locationEntityId: entity.locationEntityId ?? null,
                updatedChapterId: entity.updatedChapterId ?? null,
            })),
        ...events.filter(incompleteProgress).map(event => ({
            kind: 'event',
            eventId: event.id,
            title: event.title ?? '',
            progress: event.progress ?? null,
            locationEntityId: event.locationEntityId ?? null,
            timelineId: event.timelineId ?? null,
        })),
    ];
}

function urgencyIsHigh(value) {
    if (typeof value === 'number') return value >= 4;
    return ['high', 'urgent', 'critical'].includes(normalizedStatus(value));
}

function promisePreflight(promises, chapter, scanText, project) {
    const chapterNumbers = chapterNumberMap(project, chapter, null, null);
    const currentNumber = Number(chapter?.number ?? chapterNumbers.get(chapter?.id));
    const touch = [];
    const doNotResolve = [];
    for (const item of promises) {
        if (!['open', 'active'].includes(normalizedStatus(item?.status))) continue;
        const mentioned = [item?.title, item?.summary]
            .filter(value => typeof value === 'string' && value.trim())
            .some(value => scanText.includes(value.trim().toLocaleLowerCase()));
        const dueNow = item.dueChapterId === chapter?.id;
        const introducedNow = item.introducedChapterId === chapter?.id;
        const evidenceNow = Array.isArray(item.evidenceChapterIds) && item.evidenceChapterIds.includes(chapter?.id);
        const reasons = [
            ...(dueNow ? ['due-current-chapter'] : []),
            ...(introducedNow ? ['introduced-current-chapter'] : []),
            ...(evidenceNow ? ['evidence-current-chapter'] : []),
            ...(urgencyIsHigh(item.urgency) ? ['high-urgency'] : []),
            ...(mentioned ? ['mentioned-in-chapter-context'] : []),
        ];
        const dueNumber = chapterNumbers.get(item.dueChapterId);
        const futureDue = item.dueChapterId && item.dueChapterId !== chapter?.id
            && (!Number.isFinite(currentNumber) || !Number.isFinite(dueNumber) || dueNumber > currentNumber);
        const mustNotResolve = !dueNow && (futureDue || !item.dueChapterId);
        const projected = {
            promiseId: item.id,
            title: item.title ?? '',
            kind: item.kind ?? '',
            urgency: item.urgency ?? null,
            dueChapterId: item.dueChapterId ?? null,
            reasons,
            mustNotResolve,
        };
        if (reasons.length > 0) touch.push(projected);
        if (mustNotResolve) doNotResolve.push({
            promiseId: item.id,
            dueChapterId: item.dueChapterId ?? null,
            reason: futureDue ? 'future-due-chapter' : 'resolution-not-scheduled',
        });
    }
    return { touch, doNotResolve };
}

/**
 * Selects deterministic story facts for a chapter and records why each item was included.
 * Explicit exclusions win over every automatic or explicit inclusion rule.
 */
export function compileStoryContext({
    project = {},
    chapter = {},
    previousChapter = null,
    nextChapter = null,
    overrides = {},
    limits = {},
} = {}) {
    const configuredLimits = { ...DEFAULT_LIMITS, ...(limits || {}) };
    const state = project?.storyState && typeof project.storyState === 'object'
        ? project.storyState
        : {};
    const categories = [
        'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
    ];
    const sourceRecords = Object.fromEntries([
        ...categories,
    ].map(category => [category, Array.isArray(state[category])
        ? structuredClone(state[category])
        : []]));
    const hasV5State = ['facts', 'knowledge', 'timeline'].some(category => Object.hasOwn(state, category));
    const filteredItems = [];
    const chapterNumbers = chapterNumberMap(project, chapter, previousChapter, nextChapter);
    const currentNumber = currentChapterNumber(chapterNumbers, chapter);
    const excluded = new Set(normalizedIds(overrides.excludeEntityIds));
    const excludedPromises = new Set(normalizedIds(overrides.excludePromiseIds));
    const entities = filterByChapter(
        safeRecords(sourceRecords.entities, 'entities', filteredItems),
        'entities',
        item => [item.updatedChapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const relations = safeRelations(filterByChapter(
        safeRecords(sourceRecords.relations, 'relations', filteredItems),
        'relations',
        item => [item.sinceChapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    ), filteredItems);
    const temporalEvents = filterByChapter(
        safeRecords(sourceRecords.events, 'events', filteredItems),
        'events',
        item => [item.chapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const promises = projectPromisesForChapter(
        safeRecords(sourceRecords.promises, 'promises', filteredItems),
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const memory = filterByChapter(
        safeRecords(sourceRecords.memory, 'memory', filteredItems),
        'memory',
        item => [item.chapterId, ...(Array.isArray(item.sourceChapterIds) ? item.sourceChapterIds : [])],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const activeFacts = safeRecords(sourceRecords.facts, 'facts', filteredItems);
    const facts = filterByChapter(
        activeFacts,
        'facts',
        item => [item.sourceChapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const knowledge = filterByChapter(
        safeRecords(sourceRecords.knowledge, 'knowledge', filteredItems),
        'knowledge',
        item => [item.learnedChapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const timeline = filterByChapter(
        safeRecords(sourceRecords.timeline, 'timeline', filteredItems),
        'timeline',
        item => [item.chapterId],
        chapterNumbers,
        currentNumber,
        filteredItems,
    );
    const entityById = new Map(entities.map(entity => [entity.id, entity]));
    const factById = new Map(facts.map(fact => [fact.id, fact]));
    const entityReasons = new Map();
    const eventReasons = new Map();
    const promiseReasons = new Map();
    const memoryReasons = new Map();
    const relationReasons = new Map();
    const factReasons = new Map();
    const knowledgeReasons = new Map();
    const timelineReasons = new Map();
    const scanText = sourceText(chapter, previousChapter, nextChapter);
    const requestedPov = typeof chapter?.card?.pov === 'string' ? chapter.card.pov.trim() : '';
    const povResolution = resolveEntity(requestedPov, entities.filter(entity => !excluded.has(entity.id)));
    const povEntity = povResolution.entity;
    const unresolvedPov = Boolean((requestedPov || facts.length > 0) && !povEntity);
    const preflightWarnings = [];
    if (unresolvedPov) {
        preflightWarnings.push({
            code: 'unresolved-pov',
            message: requestedPov
                ? 'The chapter POV did not match one unique entity; facts were withheld.'
                : 'The chapter has facts but no resolvable POV; facts were withheld.',
            requestedPov,
            ambiguousEntityIds: povResolution.ambiguousIds,
        });
    }
    if (povEntity) addReason(entityReasons, povEntity.id, `pov-${povResolution.resolution}`);

    const events = safeEvents(temporalEvents, povEntity, filteredItems, {
        legacyMissingVisibility: !hasV5State,
    });
    const visibleEventIds = new Set(events.map(event => event.id));
    const visibleTimelineIds = new Set(events.map(event => event.timelineId).filter(Boolean));
    const blockedTimelineIds = new Set(temporalEvents
        .filter(event => !visibleEventIds.has(event.id) && event.timelineId && !visibleTimelineIds.has(event.timelineId))
        .map(event => event.timelineId));

    const knowledgeByStance = Object.fromEntries([...KNOWLEDGE_STANCES].map(stance => [stance, []]));
    const hiddenFactIds = new Set(knowledge
        .filter(edge => povEntity && edge.entityId === povEntity.id && normalizedStatus(edge.stance) === 'hides')
        .map(edge => edge.factId)
        .filter(factId => factById.has(factId)));
    const visibleKnowledge = [];
    for (const edge of knowledge) {
        if (!povEntity || edge.entityId !== povEntity.id) continue;
        const stance = normalizedStatus(edge.stance);
        if (!KNOWLEDGE_STANCES.has(stance)) {
            filteredItems.push({ category: 'knowledge', id: edge.id ?? null, reason: 'invalid-stance' });
            continue;
        }
        const fact = factById.get(edge.factId);
        if (!fact) {
            filteredItems.push({ category: 'knowledge', id: edge.id ?? null, reason: 'missing-or-retired-fact' });
            continue;
        }
        if (stance === 'hides') {
            knowledgeByStance.hides.push({
                knowledgeId: edge.id,
                factId: fact.id,
                summary: fact.summary ?? '',
                subjectEntityId: fact.subjectEntityId ?? null,
                stance: 'hides',
                mustNotReveal: true,
            });
            filteredItems.push({ category: 'knowledge', id: edge.id ?? null, reason: 'protected-hidden-knowledge' });
            continue;
        }
        if (!VISIBLE_KNOWLEDGE_STANCES.has(stance)) continue;
        if (hiddenFactIds.has(fact.id)) {
            filteredItems.push({ category: 'knowledge', id: edge.id ?? null, reason: 'protected-by-hides' });
            continue;
        }
        visibleKnowledge.push(edge);
        addReason(knowledgeReasons, edge.id, `pov-${stance}`);
        addReason(factReasons, fact.id, `pov-${stance}`);
        knowledgeByStance[stance].push({ knowledgeId: edge.id, factId: fact.id });
    }
    for (const fact of facts) {
        if (!factReasons.has(fact.id)) {
            filteredItems.push({
                category: 'facts',
                id: null,
                reason: unresolvedPov
                    ? 'unresolved-pov'
                    : hiddenFactIds.has(fact.id) ? 'protected-hidden-fact' : 'not-known-to-pov',
                redacted: true,
            });
        }
    }

    const factCandidates = takeByReasons(facts, factReasons, configuredLimits.facts);
    const factCandidateIds = new Set(factCandidates.map(fact => fact.id));
    let selectedKnowledge = takeByReasons(
        visibleKnowledge.filter(edge => factCandidateIds.has(edge.factId)),
        knowledgeReasons,
        configuredLimits.knowledge,
    );
    let selectedFactIds = new Set(selectedKnowledge.map(edge => edge.factId));
    let selectedFacts = factCandidates.filter(fact => selectedFactIds.has(fact.id));
    let selectedKnowledgeIds = new Set(selectedKnowledge.map(edge => edge.id));
    let selectedPovKnowledge = Object.fromEntries(Object.entries(knowledgeByStance).map(([stance, items]) => [
        stance,
        stance === 'hides'
            ? items.slice(0, boundedLimit(configuredLimits.knowledge))
            : items.filter(item => selectedKnowledgeIds.has(item.knowledgeId) && selectedFactIds.has(item.factId)),
    ]));

    const timelineContext = timelineForChapter(timeline, project, chapter, previousChapter, blockedTimelineIds);
    const selectedTimeline = timelineWindow(
        timelineContext.ordered,
        timelineContext.current,
        configuredLimits.timeline,
    );
    for (const item of selectedTimeline) {
        addReason(timelineReasons, item.id, item.id === timelineContext.current?.id ? 'current-time-anchor' : 'timeline-context');
    }
    const candidateCurrentTimeline = currentTimelineProjection(timelineContext.current);
    const targetLocationResolution = resolveEntity(
        chapter?.card?.location,
        entities.filter(entity => !excluded.has(entity.id)),
        { locationsOnly: true },
    );
    if (chapter?.card?.location && !targetLocationResolution.entity) {
        preflightWarnings.push({
            code: 'unresolved-location',
            message: 'The chapter location did not match one unique entity.',
            requestedLocation: chapter.card.location,
            ambiguousEntityIds: targetLocationResolution.ambiguousIds,
        });
    }
    const fromLocationEntityId = candidateCurrentTimeline?.locationEntityId ?? povEntity?.locationEntityId ?? null;
    const targetLocationEntityId = targetLocationResolution.entity?.id ?? null;
    const sceneLocationEntityId = targetLocationEntityId ?? fromLocationEntityId;
    const requiresTransition = Boolean(fromLocationEntityId && targetLocationEntityId
        && fromLocationEntityId !== targetLocationEntityId);
    if (entityById.has(fromLocationEntityId)) addReason(entityReasons, fromLocationEntityId, 'current-location');
    if (entityById.has(targetLocationEntityId)) addReason(entityReasons, targetLocationEntityId, 'chapter-location');

    const candidatePresence = presenceProjection(
        entities.filter(entity => !excluded.has(entity.id)),
        povEntity,
        sceneLocationEntityId,
    );
    for (const item of candidatePresence.present) addReason(entityReasons, item.entityId, 'present-in-scene');
    for (const entity of characterEntities(entities)) {
        if (!excluded.has(entity.id) && typeof entity?.currentAction === 'string' && entity.currentAction.trim()) {
            addReason(entityReasons, entity.id, 'unfinished-action');
        }
    }

    for (const entity of entities) {
        if (hasMention(entity, scanText)) addReason(entityReasons, entity.id, 'mentioned-in-chapter-context');
    }
    for (const id of normalizedIds(overrides.includeEntityIds)) {
        if (entityById.has(id)) addReason(entityReasons, id, 'manually-included');
    }

    const recentEvents = [...events]
        .sort((left, right) => Number(right.order ?? 0) - Number(left.order ?? 0))
        .slice(0, Math.max(8, Math.floor(configuredLimits.events / 2)));
    for (const event of events) {
        if (event.chapterId === chapter?.id) addReason(eventReasons, event.id, 'current-chapter');
        if (event.chapterId && event.chapterId === previousChapter?.id) addReason(eventReasons, event.id, 'previous-chapter');
    }
    for (const event of recentEvents) addReason(eventReasons, event.id, 'recent-event');
    for (const event of takeByReasons(events, eventReasons, configuredLimits.events)) {
        for (const entityId of event.entityIds ?? []) {
            if (entityById.has(entityId)) addReason(entityReasons, entityId, `referenced-by-event:${event.id}`);
        }
    }
    for (const fact of selectedFacts) {
        if (entityById.has(fact.subjectEntityId)) {
            addReason(entityReasons, fact.subjectEntityId, `subject-of-fact:${fact.id}`);
        }
    }

    for (const item of promises) {
        if (['open', 'active'].includes(normalizedStatus(item.status))) addReason(promiseReasons, item.id, 'open-promise');
        if ([item.introducedChapterId, item.dueChapterId, item.resolvedChapterId].includes(chapter?.id)) {
            addReason(promiseReasons, item.id, 'current-chapter-lifecycle');
        }
    }
    for (const id of normalizedIds(overrides.includePromiseIds)) {
        if (promises.some(item => item.id === id)) addReason(promiseReasons, id, 'manually-included');
    }
    for (const id of excludedPromises) promiseReasons.delete(id);

    for (const item of memory) {
        if (['global', 'book', 'volume', 'arc'].includes(item.kind)) addReason(memoryReasons, item.id, 'structural-memory');
        if (Number(item.importance ?? 0) >= 4) addReason(memoryReasons, item.id, 'high-importance');
        if (item.chapterId === chapter?.id) addReason(memoryReasons, item.id, 'current-chapter');
        if (item.chapterId && item.chapterId === previousChapter?.id) addReason(memoryReasons, item.id, 'previous-chapter');
    }

    for (const id of excluded) entityReasons.delete(id);

    for (const relation of relations) {
        if (normalizedStatus(relation.status) === 'resolved') continue;
        const leftSelected = entityReasons.has(relation.fromEntityId);
        const rightSelected = entityReasons.has(relation.toEntityId);
        if (!leftSelected && !rightSelected) continue;
        addReason(relationReasons, relation.id, leftSelected && rightSelected ? 'between-selected-entities' : 'connected-to-selected-entity');
        const relatedId = leftSelected ? relation.toEntityId : relation.fromEntityId;
        if (entityById.has(relatedId) && !excluded.has(relatedId)) {
            addReason(entityReasons, relatedId, `connected-by-relation:${relation.id}`);
        }
    }

    for (const [id, relation] of relations.map(item => [item.id, item])) {
        if (excluded.has(relation.fromEntityId) || excluded.has(relation.toEntityId)) relationReasons.delete(id);
    }

    const povReason = povEntity ? `pov-${povResolution.resolution}` : '';
    let selectedEntities = takeByReasons(
        entities.filter(entity => !excluded.has(entity.id)),
        entityReasons,
        configuredLimits.entities,
        [povReason, 'manually-included'],
    );
    const selectedPovEntity = povEntity
        ? selectedEntities.find(entity => entity.id === povEntity.id) ?? null
        : null;
    if (povEntity && !selectedPovEntity) {
        preflightWarnings.push({
            code: 'pov-context-limited',
            message: 'The resolved POV did not fit the selected entity context; facts were withheld.',
            requestedPov,
        });
        selectedKnowledge = [];
        selectedFacts = [];
        selectedKnowledgeIds = new Set();
        selectedFactIds = new Set();
        selectedPovKnowledge = Object.fromEntries([...KNOWLEDGE_STANCES].map(stance => [stance, []]));
    }
    const blockedFacts = activeFacts.filter(fact => !selectedFactIds.has(fact.id));
    selectedEntities = protectBlockedFactOverlaps(
        selectedEntities,
        'entities',
        blockedFacts,
        filteredItems,
    );
    const selected = {
        entities: selectedEntities,
        relations: protectBlockedFactOverlaps(
            takeByReasons(relations, relationReasons, configuredLimits.relations),
            'relations', blockedFacts, filteredItems,
        ),
        events: protectBlockedFactOverlaps(
            takeByReasons(events, eventReasons, configuredLimits.events),
            'events', blockedFacts, filteredItems,
        ),
        promises: protectBlockedFactOverlaps(
            takeByReasons(promises, promiseReasons, configuredLimits.promises, 'manually-included'),
            'promises', blockedFacts, filteredItems,
        ),
        memory: protectBlockedFactOverlaps(
            takeByReasons(memory, memoryReasons, configuredLimits.memory),
            'memory', blockedFacts, filteredItems,
        ),
        facts: selectedFacts,
        knowledge: selectedKnowledge,
        timeline: protectBlockedFactOverlaps(
            selectedTimeline,
            'timeline', blockedFacts, filteredItems,
        ),
    };
    const selectedEntityById = new Map(selected.entities.map(entity => [entity.id, entity]));
    const finalPovEntity = povEntity ? selectedEntityById.get(povEntity.id) ?? null : null;
    const selectedTimelineById = new Map(selected.timeline.map(item => [item.id, item]));
    const finalCurrentTimelineItem = timelineContext.current
        ? selectedTimelineById.get(timelineContext.current.id) ?? selected.timeline.at(-1) ?? null
        : selected.timeline.at(-1) ?? null;
    const currentTimeline = currentTimelineProjection(finalCurrentTimelineItem);
    if (currentTimeline?.locationEntityId && !selectedEntityById.has(currentTimeline.locationEntityId)) {
        currentTimeline.locationEntityId = null;
    }
    const finalTargetLocationEntityId = selectedEntityById.has(targetLocationEntityId)
        ? targetLocationEntityId
        : null;
    const finalFromLocationEntityId = currentTimeline?.locationEntityId
        ?? (selectedEntityById.has(finalPovEntity?.locationEntityId) ? finalPovEntity.locationEntityId : null);
    const finalSceneLocationEntityId = finalTargetLocationEntityId ?? finalFromLocationEntityId;
    const presence = presenceProjection(selected.entities, finalPovEntity, finalSceneLocationEntityId);
    const unfinishedActions = unfinishedActionProjection(selected.entities, selected.events);
    const promisePlan = promisePreflight(selected.promises, chapter, scanText, project);
    const finalPreflightWarnings = preflightWarnings.map(item => (
        Array.isArray(item.ambiguousEntityIds)
            ? { ...item, ambiguousEntityIds: item.ambiguousEntityIds.filter(id => selectedEntityById.has(id)) }
            : item
    ));
    const finalRequiresTransition = Boolean(finalFromLocationEntityId && finalTargetLocationEntityId
        && finalFromLocationEntityId !== finalTargetLocationEntityId);
    const requirements = [
        ...(finalRequiresTransition ? [{
            code: 'location-transition-required',
            fromLocationEntityId: finalFromLocationEntityId,
            toLocationEntityId: finalTargetLocationEntityId,
        }] : []),
        ...selectedPovKnowledge.hides.map(item => ({
            code: 'must-not-reveal-fact',
            knowledgeId: item.knowledgeId,
            factId: item.factId,
            mustNotReveal: true,
        })),
        ...promisePlan.doNotResolve.map(item => ({
            code: 'do-not-resolve-promise',
            ...item,
        })),
    ];
    const effectiveUnresolvedPov = unresolvedPov || Boolean(povEntity && !finalPovEntity);
    const preflight = {
        status: effectiveUnresolvedPov && facts.length > 0
            ? 'blocked'
            : finalPreflightWarnings.length > 0 || requirements.length > 0 ? 'warning' : 'ready',
        pov: {
            requested: requestedPov,
            entityId: finalPovEntity?.id ?? null,
            name: finalPovEntity?.name ?? '',
            resolution: povResolution.resolution,
            unresolved: effectiveUnresolvedPov,
            knowledge: selectedPovKnowledge,
        },
        time: {
            current: currentTimeline,
        },
        movement: {
            fromLocationEntityId: finalFromLocationEntityId,
            targetLocationEntityId: finalTargetLocationEntityId,
            requestedLocation: typeof chapter?.card?.location === 'string' ? chapter.card.location : '',
            targetResolution: targetLocationResolution.resolution,
            requiresTransition: finalRequiresTransition,
        },
        presence,
        unfinishedActions,
        promises: promisePlan,
        requirements,
        warnings: finalPreflightWarnings,
        counts: {
            visibleFacts: selectedFacts.length,
            visibleKnowledge: selectedKnowledge.length,
            hiddenKnowledge: selectedPovKnowledge.hides.length,
            timeline: selected.timeline.length,
            presentCharacters: presence.present.length,
            absentCharacters: presence.absent.length,
            unknownLocationCharacters: presence.unknown.length,
            unfinishedActions: unfinishedActions.length,
            promisesToTouch: promisePlan.touch.length,
            promisesProtected: promisePlan.doNotResolve.length,
        },
    };
    const reasonsByCategory = {
        entities: entityReasons,
        relations: relationReasons,
        events: eventReasons,
        promises: promiseReasons,
        memory: memoryReasons,
        facts: factReasons,
        knowledge: knowledgeReasons,
        timeline: timelineReasons,
    };
    const items = Object.entries(selected).flatMap(([category, records]) => records.map(record => ({
        category,
        id: record.id,
        reasons: [...(reasonsByCategory[category].get(record.id) ?? [])],
        characters: JSON.stringify(record).length,
    })));
    const totals = Object.fromEntries(Object.entries(selected).map(([category, records]) => [category, {
        selected: records.length,
        available: sourceRecords[category].length,
    }]));
    return {
        storyState: selected,
        preflight,
        diagnostics: {
            items,
            totals,
            preflight,
            unresolvedPov: effectiveUnresolvedPov,
            filteredItems,
            overrides: {
                includeEntityIds: normalizedIds(overrides.includeEntityIds),
                excludeEntityIds: [...excluded],
                includePromiseIds: normalizedIds(overrides.includePromiseIds),
                excludePromiseIds: [...excludedPromises],
            },
            totalCharacters: JSON.stringify(selected).length,
        },
    };
}

export { DEFAULT_LIMITS as STORY_CONTEXT_LIMITS };
