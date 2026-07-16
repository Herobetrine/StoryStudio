import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, createStoragePathGuard } from './api-error.js';
import {
    RETRIEVAL_INDEX_SCHEMA_VERSION,
    RetrievalIndex,
    buildRetrievalChunks,
} from './retrieval-index.js';

const MAX_QUERY_LENGTH = 20_000;
const MAX_RESULTS = 100;
const MAX_BATCH_SIZE = 500;
const MAX_MANUAL_REFERENCES = 200;
const MAX_REFERENCE_CHARACTERS = 512;
const JOB_TTL_MS = 15 * 60 * 1_000;
const PREVIEW_FIELDS = new Set([
    'projectVersion', 'chapterRevision', 'chapterId', 'query', 'text', 'limit', 'maxResults', 'filters',
    'manualInclude', 'manualExclude', 'include', 'exclude', 'includeIds', 'excludeIds',
    'volumeIds', 'volumeId', 'personIds', 'personId', 'entityIds', 'entityId', 'chapterIds',
    'sourceTypes', 'sourceType', 'factStatuses', 'factStatus', 'statuses', 'status',
    'povKnowledge', 'knowledge', 'povEntityId', 'povId', 'pov', 'maxChapterNumber',
    'throughChapterNumber', 'beforeChapterNumber', 'currentChapterNumber', 'minChapterNumber',
    'afterChapterNumber', 'timeRange', 'time', 'includeSuperseded', 'excludeSuperseded',
    'knowledgeStances', 'allowedStances', 'rerank',
]);

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return structuredClone(value);
}

function stableNormalize(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => stableNormalize(item, seen));
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key], seen)]));
}

function stableJson(value) {
    return JSON.stringify(stableNormalize(value));
}

function sha256(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function nowIso() {
    return new Date().toISOString();
}

function nextEventLoopTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

function cleanProjectId(value) {
    const id = String(value ?? '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
        throw new ApiError(400, 'invalid_project_id', 'Project id is invalid.');
    }
    return id;
}

function cleanQuery(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) {
        throw new ApiError(400, 'invalid_retrieval_query', 'retrieval query must be a string no longer than 20000 characters.');
    }
    return value;
}

function cleanLimit(value, fallback = 20) {
    if (value === undefined || value === null || value === '') return fallback;
    if (!Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
        throw new ApiError(400, 'invalid_retrieval_limit', `retrieval limit must be an integer from 1 to ${MAX_RESULTS}.`);
    }
    return value;
}

function cleanBatchSize(value) {
    if (value === undefined || value === null || value === '') return MAX_BATCH_SIZE;
    if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
        throw new ApiError(400, 'invalid_retrieval_batch', `batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
    }
    return value;
}

function validateManualReferences(body) {
    const groups = [
        ['include', ['manualInclude', 'manualIncludes', 'include', 'includeIds']],
        ['exclude', ['manualExclude', 'manualExcludes', 'exclude', 'excludeIds']],
    ];
    const containers = [body, isObject(body.filters) ? body.filters : null].filter(Boolean);
    for (const [kind, fields] of groups) {
        let count = 0;
        for (const container of containers) {
            for (const field of fields) {
                if (container[field] === undefined || container[field] === null) continue;
                const references = Array.isArray(container[field]) ? container[field] : [container[field]];
                count += references.length;
                for (const [index, reference] of references.entries()) {
                    const validText = value => typeof value === 'string'
                        && value.length >= 1 && value.length <= MAX_REFERENCE_CHARACTERS;
                    const validObject = isObject(reference)
                        && Object.keys(reference).every(key => ['id', 'sourceType', 'sourceId'].includes(key))
                        && ['id', 'sourceType', 'sourceId'].some(key => reference[key] !== undefined)
                        && Object.entries(reference).every(([key, value]) => (
                            key === 'sourceType' ? validText(value) && value.length <= 64 : validText(value)
                        ));
                    if (!validText(reference) && !validObject) {
                        throw new ApiError(400, 'invalid_retrieval_reference', `retrieval ${kind} contains an invalid reference.`, {
                            field,
                            index,
                        });
                    }
                }
            }
        }
        if (count > MAX_MANUAL_REFERENCES) {
            throw new ApiError(400, 'retrieval_reference_limit', `retrieval ${kind} references cannot exceed ${MAX_MANUAL_REFERENCES}.`, {
                field: kind,
                limit: MAX_MANUAL_REFERENCES,
            });
        }
    }
}

function resourceArrays(storyStore, projectId, project) {
    const resources = { characters: [], lorebooks: [], promptProfiles: [] };
    const types = [
        ['characterIds', 'character', 'characters'],
        ['lorebookIds', 'lorebook', 'lorebooks'],
        ['promptProfileIds', 'prompt-profile', 'promptProfiles'],
    ];
    for (const [referenceField, type, target] of types) {
        for (const id of project.resources?.[referenceField] ?? []) {
            const resource = storyStore.getResource(projectId, type, id);
            if (type === 'prompt-profile' || resource.active === true || resource.persona === true) {
                resources[target].push(resource);
            }
        }
    }
    return resources;
}

function projectSnapshot(storyStore, projectId) {
    const project = storyStore.getProject(projectId);
    const chapters = (project.chapters ?? [])
        .slice()
        .sort((left, right) => Number(left.number ?? 0) - Number(right.number ?? 0))
        .map(summary => storyStore.getChapter(projectId, summary.id));
    return {
        project: clone(project),
        chapters: clone(chapters),
        volumes: clone(project.volumes ?? []),
        resources: resourceArrays(storyStore, projectId, project),
        storyState: clone(project.storyState ?? {}),
    };
}

function sourceDigest(snapshot) {
    return sha256({
        project: snapshot.project,
        chapters: snapshot.chapters,
        volumes: snapshot.volumes,
        resources: snapshot.resources,
        storyState: snapshot.storyState,
    });
}

function retrievalInput(snapshot) {
    return {
        ...snapshot.project,
        chapters: snapshot.chapters,
        volumes: snapshot.volumes,
        resources: snapshot.resources,
        storyState: snapshot.storyState,
    };
}

function sourceKey(chunk) {
    return `${chunk.sourceType}\u0000${chunk.sourceId}`;
}

function diffChunks(previous, next) {
    const before = new Map(previous.map(chunk => [chunk.id, chunk]));
    const after = new Map(next.map(chunk => [chunk.id, chunk]));
    const deleted = [...before.keys()].filter(id => !after.has(id));
    const added = [...after.keys()].filter(id => !before.has(id));
    const unchanged = [...after.keys()].filter(id => before.has(id)
        && stableJson(before.get(id)) === stableJson(after.get(id))).length;
    const updated = after.size - unchanged - added.length;
    const changedSources = new Set([
        ...deleted.map(id => before.get(id)).filter(Boolean).map(sourceKey),
        ...added.map(id => after.get(id)).filter(Boolean).map(sourceKey),
        ...[...after.keys()].filter(id => before.has(id)
            && stableJson(before.get(id)) !== stableJson(after.get(id)))
            .map(id => after.get(id)).map(sourceKey),
    ]);
    return { added: added.length, updated, deleted: deleted.length, unchanged, changedSources };
}

function defaultQuery(chapter) {
    return [
        chapter?.title,
        chapter?.card?.summary,
        chapter?.card?.goal,
        chapter?.card?.conflict,
        chapter?.card?.required,
        chapter?.card?.pov,
        chapter?.card?.location,
    ].filter(value => typeof value === 'string' && value.trim()).join('\n');
}

function resolvePovEntity(project, chapter) {
    const requested = String(chapter?.card?.pov ?? '').trim();
    if (!requested) return null;
    const entities = Array.isArray(project.storyState?.entities) ? project.storyState.entities : [];
    const exact = entities.find(entity => entity?.id === requested);
    if (exact) return exact.id;
    const lowered = requested.toLocaleLowerCase();
    const matches = entities.filter(entity => [entity?.name, ...(entity?.aliases ?? [])]
        .some(value => typeof value === 'string' && value.trim().toLocaleLowerCase() === lowered));
    return matches.length === 1 ? matches[0].id : null;
}

function defaultFilters(snapshot, chapter) {
    const chapterNumber = Number(chapter?.number);
    const filters = {
        excludeSuperseded: true,
        chapterNumberById: Object.fromEntries(snapshot.chapters
            .filter(item => item?.id && Number.isFinite(Number(item.number)))
            .map(item => [item.id, Number(item.number)])),
        ...(Number.isInteger(chapterNumber) && chapterNumber >= 1 ? { maxChapterNumber: chapterNumber } : {}),
    };
    const povEntityId = resolvePovEntity(snapshot.project, chapter);
    if (chapter) filters.povKnowledge = [];
    if (povEntityId) {
        filters.povEntityId = povEntityId;
        filters.povKnowledge = snapshot.storyState?.knowledge ?? [];
    }
    return filters;
}

function publicStatus(record) {
    return {
        projectId: record.projectId,
        projectVersion: record.projectVersion,
        sourceDigest: record.sourceDigest,
        indexDigest: record.indexDigest,
        updatedAt: record.updatedAt,
        stale: record.stale === true,
        stats: record.index?.stats?.() ?? { documents: 0, chunks: 0, terms: 0 },
        lastDiff: record.lastDiff ?? null,
    };
}

function safeRerank(deterministicHits, reranked) {
    if (!Array.isArray(reranked)) return { hits: deterministicHits, accepted: 0 };
    const allowed = new Map(deterministicHits.map(hit => [hit.id, hit]));
    const manual = deterministicHits.filter(hit => hit.reasons?.includes('manual-include'));
    const manualIds = new Set(manual.map(hit => hit.id));
    const ordered = [];
    const seen = new Set(manualIds);
    let accepted = 0;
    for (const item of reranked) {
        const id = typeof item === 'string' ? item : item?.id;
        if (!allowed.has(id) || seen.has(id)) continue;
        ordered.push(allowed.get(id));
        seen.add(id);
        accepted += 1;
    }
    for (const hit of deterministicHits) {
        if (seen.has(hit.id)) continue;
        ordered.push(hit);
        seen.add(hit.id);
    }
    return { hits: [...manual, ...ordered].slice(0, deterministicHits.length), accepted };
}

export class RetrievalStore {
    constructor(rootDirectory, { storyStore, reranker = null } = {}) {
        if (!storyStore) throw new TypeError('RetrievalStore requires a storyStore.');
        this.pathGuard = createStoragePathGuard(rootDirectory, {
            label: 'Retrieval storage',
            createError: (message, details) => (
                new ApiError(500, 'unsafe_retrieval_path', message, details)
            ),
        });
        this.rootDirectory = this.pathGuard.rootDirectory;
        this.storyStore = storyStore;
        this.reranker = typeof reranker === 'function' ? reranker : null;
        this.jobs = new Map();
        this.cache = new Map();
    }

    storagePath(...segments) {
        return this.pathGuard.resolvePath(...segments);
    }

    indexPath(projectId) {
        return this.storagePath(cleanProjectId(projectId), 'index.json');
    }

    readRecord(projectId) {
        const filePath = this.indexPath(projectId);
        if (!fs.existsSync(filePath)) {
            this.cache.delete(projectId);
            return null;
        }
        try {
            this.pathGuard.assertPath(filePath);
            const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!isObject(value) || value.schemaVersion !== RETRIEVAL_INDEX_SCHEMA_VERSION
                || value.projectId !== projectId || !isObject(value.index)) {
                this.cache.delete(projectId);
                return null;
            }
            const computedDigest = sha256(value.index);
            if (!/^[0-9a-f]{64}$/u.test(String(value.indexDigest ?? '')) || value.indexDigest !== computedDigest) {
                this.cache.delete(projectId);
                return null;
            }
            const cached = this.cache.get(projectId);
            const index = cached?.indexDigest === computedDigest ? cached.index : RetrievalIndex.fromJSON(value.index);
            if (sha256(index.toJSON()) !== computedDigest) {
                this.cache.delete(projectId);
                return null;
            }
            if (cached?.indexDigest !== computedDigest) this.cache.set(projectId, { indexDigest: computedDigest, index });
            return {
                ...value,
                index,
            };
        } catch (error) {
            if (error?.code === 'unsafe_retrieval_path') throw error;
            this.cache.delete(projectId);
            return null;
        }
    }

    writeRecord(record) {
        const filePath = this.indexPath(record.projectId);
        this.pathGuard.ensureDirectory(path.dirname(filePath));
        const payload = {
            schemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
            projectId: record.projectId,
            projectVersion: record.projectVersion,
            sourceDigest: record.sourceDigest,
            indexDigest: record.indexDigest,
            updatedAt: record.updatedAt,
            stale: record.stale === true,
            lastDiff: record.lastDiff ?? null,
            index: record.index.toJSON(),
        };
        const serialized = JSON.stringify(payload, null, 2);
        this.pathGuard.assertPath(filePath);
        writeFileAtomicSync(filePath, serialized, { encoding: 'utf8' });
        this.cache.set(record.projectId, { indexDigest: record.indexDigest, index: record.index });
        return { ...record, ...payload, index: record.index };
    }

    buildRecord(projectId, snapshot, index, diff = null) {
        const sourceDigestValue = sourceDigest(snapshot);
        return {
            projectId,
            projectVersion: snapshot.project.version,
            sourceDigest: sourceDigestValue,
            indexDigest: sha256(index.toJSON()),
            updatedAt: nowIso(),
            stale: false,
            lastDiff: diff,
            index,
        };
    }

    ensureIndex(projectId) {
        const id = cleanProjectId(projectId);
        const snapshot = projectSnapshot(this.storyStore, id);
        const digest = sourceDigest(snapshot);
        const current = this.readRecord(id);
        if (current && current.sourceDigest === digest && current.projectVersion === snapshot.project.version) {
            return { record: current, rebuilt: false, snapshot };
        }
        const result = this.refreshProject(id, { snapshot, current, persist: true });
        return { record: result.record, rebuilt: true, snapshot };
    }

    refreshProject(projectId, { snapshot = null, current = null, persist = true } = {}) {
        const id = cleanProjectId(projectId);
        const nextSnapshot = snapshot ?? projectSnapshot(this.storyStore, id);
        const nextChunks = buildRetrievalChunks(retrievalInput(nextSnapshot));
        const prior = current ?? this.readRecord(id);
        // Never mutate the cached/index-on-disk instance before the atomic
        // replacement succeeds.  A failed refresh must leave the cached
        // digest paired with the exact index it authenticated.
        const index = prior ? RetrievalIndex.fromJSON(prior.index.toJSON()) : new RetrievalIndex();
        const beforeChunks = index.listChunks();
        const diff = diffChunks(beforeChunks, nextChunks);
        if (!prior || diff.deleted + diff.added + diff.updated === 0) {
            if (!prior) index.rebuild(nextChunks);
        } else {
            const nextSources = new Map();
            for (const chunk of nextChunks) {
                const key = sourceKey(chunk);
                if (!nextSources.has(key)) nextSources.set(key, []);
                nextSources.get(key).push(chunk);
            }
            for (const key of diff.changedSources) {
                const [sourceType, sourceId] = key.split('\u0000');
                index.remove({ sourceType, sourceId }, { deferReindex: true });
                index.upsert(nextSources.get(key) ?? [], {
                    replaceSource: false,
                    deferReindex: true,
                });
            }
            index.finalize();
        }
        const record = this.buildRecord(id, nextSnapshot, index, {
            added: diff.added,
            updated: diff.updated,
            deleted: diff.deleted,
            unchanged: diff.unchanged,
        });
        return { record: persist ? this.writeRecord(record) : record, diff, snapshot: nextSnapshot };
    }

    rebuildProject(projectId, { mode = 'incremental', batchSize = MAX_BATCH_SIZE } = {}) {
        const id = cleanProjectId(projectId);
        if (!['incremental', 'full'].includes(mode)) {
            throw new ApiError(400, 'invalid_retrieval_mode', 'Retrieval rebuild mode must be incremental or full.');
        }
        batchSize = cleanBatchSize(batchSize);
        const snapshot = projectSnapshot(this.storyStore, id);
        const current = this.readRecord(id);
        const startedAt = Date.now();
        let result;
        if (mode === 'full' || !current) {
            const chunks = buildRetrievalChunks(retrievalInput(snapshot));
            const index = new RetrievalIndex();
            for (let offset = 0; offset < chunks.length; offset += batchSize) {
                index.upsert(chunks.slice(offset, offset + batchSize), { replaceSource: false, deferReindex: true });
            }
            index.finalize();
            const diff = diffChunks(current?.index.listChunks() ?? [], chunks);
            result = { record: this.writeRecord(this.buildRecord(id, snapshot, index, {
                added: diff.added,
                updated: diff.updated,
                deleted: diff.deleted,
                unchanged: diff.unchanged,
            })), diff, snapshot };
        } else {
            result = this.refreshProject(id, { snapshot, current, persist: true });
        }
        return {
            ...publicStatus(result.record),
            mode,
            durationMs: Date.now() - startedAt,
            batchSize,
            rebuilt: true,
        };
    }

    async rebuildProjectAsync(projectId, {
        mode = 'incremental',
        batchSize = MAX_BATCH_SIZE,
        onProgress = null,
    } = {}) {
        const id = cleanProjectId(projectId);
        if (!['incremental', 'full'].includes(mode)) {
            throw new ApiError(400, 'invalid_retrieval_mode', 'Retrieval rebuild mode must be incremental or full.');
        }
        batchSize = cleanBatchSize(batchSize);
        const startedAt = Date.now();
        const snapshot = projectSnapshot(this.storyStore, id);
        const current = this.readRecord(id);
        const chunks = buildRetrievalChunks(retrievalInput(snapshot));
        const diff = diffChunks(current?.index.listChunks() ?? [], chunks);
        const report = progress => {
            if (typeof onProgress === 'function') onProgress({ ...progress, updatedAt: nowIso() });
        };

        let index;
        if (mode === 'full' || !current) {
            index = new RetrievalIndex();
            report({ phase: 'chunks', processed: 0, total: chunks.length });
            for (let offset = 0; offset < chunks.length; offset += batchSize) {
                index.upsert(chunks.slice(offset, offset + batchSize), {
                    replaceSource: false,
                    deferReindex: true,
                });
                report({ phase: 'chunks', processed: Math.min(offset + batchSize, chunks.length), total: chunks.length });
                await nextEventLoopTurn();
            }
            report({ phase: 'index', processed: 0, total: chunks.length });
            await index.finalizeAsync(batchSize);
            report({ phase: 'index', processed: chunks.length, total: chunks.length });
        } else {
            index = RetrievalIndex.fromJSON(current.index.toJSON());
            const changedSources = [...diff.changedSources];
            if (changedSources.length > 0) {
                const nextSources = new Map();
                for (const chunk of chunks) {
                    const key = sourceKey(chunk);
                    if (!nextSources.has(key)) nextSources.set(key, []);
                    nextSources.get(key).push(chunk);
                }
                report({ phase: 'sources', processed: 0, total: changedSources.length });
                for (let offset = 0; offset < changedSources.length; offset += batchSize) {
                    for (const key of changedSources.slice(offset, offset + batchSize)) {
                        const [sourceType, sourceId] = key.split('\u0000');
                        index.remove({ sourceType, sourceId }, { deferReindex: true });
                        index.upsert(nextSources.get(key) ?? [], { replaceSource: false, deferReindex: true });
                    }
                    report({
                        phase: 'sources',
                        processed: Math.min(offset + batchSize, changedSources.length),
                        total: changedSources.length,
                    });
                    await nextEventLoopTurn();
                }
                report({ phase: 'index', processed: 0, total: chunks.length });
                await index.finalizeAsync(batchSize);
                report({ phase: 'index', processed: chunks.length, total: chunks.length });
            }
        }

        // An asynchronous rebuild must never publish a snapshot assembled
        // from an authority version that changed while batches were yielding.
        await nextEventLoopTurn();
        const latest = projectSnapshot(this.storyStore, id);
        if (latest.project.version !== snapshot.project.version || sourceDigest(latest) !== sourceDigest(snapshot)) {
            throw new ApiError(409, 'retrieval_context_changed', 'Project context changed while retrieval was rebuilt.', {
                currentProjectVersion: latest.project.version,
            });
        }
        const record = this.writeRecord(this.buildRecord(id, snapshot, index, {
            added: diff.added,
            updated: diff.updated,
            deleted: diff.deleted,
            unchanged: diff.unchanged,
        }));
        return {
            ...publicStatus(record),
            mode,
            durationMs: Date.now() - startedAt,
            batchSize,
            rebuilt: true,
        };
    }

    status(projectId) {
        const id = cleanProjectId(projectId);
        const snapshot = projectSnapshot(this.storyStore, id);
        const current = this.readRecord(id);
        if (!current) return { projectId: id, projectVersion: snapshot.project.version, stale: true, stats: { documents: 0, chunks: 0, terms: 0 } };
        return publicStatus({
            ...current,
            stale: current.sourceDigest !== sourceDigest(snapshot) || current.projectVersion !== snapshot.project.version,
        });
    }

    preview(projectId, chapterId = null, input = {}) {
        const id = cleanProjectId(projectId);
        const body = isObject(input) ? input : {};
        const unknownFields = Object.keys(body).filter(field => !PREVIEW_FIELDS.has(field));
        if (unknownFields.length > 0) {
            throw new ApiError(400, 'unknown_fields', 'Retrieval preview contains unknown fields.', { fields: unknownFields });
        }
        validateManualReferences(body);
        if (body.rerank !== undefined && body.rerank !== true && body.rerank !== false
            && (!isObject(body.rerank) || Object.keys(body.rerank).some(field => !['enabled'].includes(field))
                || (body.rerank.enabled !== undefined && typeof body.rerank.enabled !== 'boolean'))) {
            throw new ApiError(400, 'invalid_retrieval_rerank', 'retrieval rerank must be a boolean or an enabled object.');
        }
        const { record, rebuilt, snapshot } = this.ensureIndex(id);
        const chapter = chapterId ? snapshot.chapters.find(item => item.id === chapterId) : null;
        if (chapterId && !chapter) throw new ApiError(404, 'not_found', 'Chapter not found.');
        if (body.projectVersion !== undefined && body.projectVersion !== snapshot.project.version) {
            throw new ApiError(409, 'project_conflict', 'Project changed before retrieval preview started.', {
                currentVersion: snapshot.project.version,
            });
        }
        if (chapterId && body.chapterRevision !== undefined && chapter?.revision !== body.chapterRevision) {
            throw new ApiError(409, 'chapter_conflict', 'Chapter changed before retrieval preview started.', {
                currentRevision: chapter?.revision,
                currentProjectVersion: snapshot.project.version,
            });
        }
        const query = cleanQuery(body.query ?? body.text ?? (chapter ? defaultQuery(chapter) : ''));
        const nestedFilters = isObject(body.filters) ? body.filters : {};
        const { chapterId: _chapterId, projectVersion: _projectVersion, chapterRevision: _chapterRevision, ...searchBody } = body;
        const safetyFilters = defaultFilters(snapshot, chapter);
        const filters = {
            ...nestedFilters,
            ...searchBody,
            maxResults: cleanLimit(body.limit ?? body.maxResults, 20),
        };
        if (chapter) {
            const requestedMaximum = Number(filters.maxChapterNumber);
            filters.maxChapterNumber = Number.isFinite(requestedMaximum)
                ? Math.min(safetyFilters.maxChapterNumber, requestedMaximum)
                : safetyFilters.maxChapterNumber;
            filters.povKnowledge = safetyFilters.povKnowledge;
            filters.chapterNumberById = safetyFilters.chapterNumberById;
            if (safetyFilters.povEntityId) filters.povEntityId = safetyFilters.povEntityId;
            else delete filters.povEntityId;
            filters.includeSuperseded = false;
            filters.excludeSuperseded = true;
        }
        const latestProject = this.storyStore.getProject(id);
        const latestChapter = chapterId ? this.storyStore.getChapter(id, chapterId) : null;
        if (latestProject.version !== snapshot.project.version
            || (latestChapter && latestChapter.revision !== chapter.revision)) {
            throw new ApiError(409, 'retrieval_context_changed', 'Project context changed while retrieval was assembled.', {
                currentProjectVersion: latestProject.version,
                ...(latestChapter ? { currentChapterRevision: latestChapter.revision } : {}),
            });
        }
        const hits = record.index.search(query, filters);
        const deterministic = {
            query,
            hits: [...hits],
            total: hits.total,
            diagnostics: {
                ...hits.diagnostics,
                sourceDigest: record.sourceDigest,
                projectVersion: record.projectVersion,
                rebuilt,
                chapterId: chapter?.id ?? null,
                filters: {
                    volumeIds: filters.volumeIds ?? filters.volumeId ?? [],
                    personIds: filters.personIds ?? filters.personId ?? [],
                    maxChapterNumber: filters.maxChapterNumber ?? null,
                    povEntityId: filters.povEntityId ?? null,
                    excludeSuperseded: filters.excludeSuperseded !== false,
                },
            },
            index: publicStatus(record),
        };
        const rerankRequested = body.rerank === true || body.rerank?.enabled === true;
        if (rerankRequested && this.reranker && deterministic.hits.length > 1) {
            return Promise.resolve(this.reranker({ query, hits: deterministic.hits, projectId: id, chapterId }))
                .then(reranked => {
                    const safe = safeRerank(deterministic.hits, reranked);
                    return {
                        ...deterministic,
                        hits: safe.hits,
                        diagnostics: {
                            ...deterministic.diagnostics,
                            rerank: safe.accepted > 0 ? 'provider' : 'provider-ignored',
                        },
                    };
                })
                .catch(() => ({
                    ...deterministic,
                    diagnostics: { ...deterministic.diagnostics, rerank: 'deterministic-fallback' },
                }));
        }
        if (rerankRequested) {
            deterministic.diagnostics.rerank = this.reranker ? 'skipped-insufficient-hits' : 'deterministic-fallback';
        }
        return deterministic;
    }

    requestRebuild(projectId, { async = false, mode = 'incremental', batchSize = MAX_BATCH_SIZE } = {}) {
        const id = cleanProjectId(projectId);
        if (typeof async !== 'boolean') throw new ApiError(400, 'invalid_retrieval_async', 'async must be a boolean.');
        if (!['incremental', 'full'].includes(mode)) {
            throw new ApiError(400, 'invalid_retrieval_mode', 'Retrieval rebuild mode must be incremental or full.');
        }
        batchSize = cleanBatchSize(batchSize);
        if (!async) return this.rebuildProject(id, { mode, batchSize });
        const jobId = randomUUID();
        const job = {
            jobId,
            projectId: id,
            status: 'queued',
            createdAt: nowIso(),
            progress: { phase: 'queued', processed: 0, total: 0 },
            result: null,
            error: null,
        };
        this.jobs.set(jobId, job);
        const run = async () => {
            job.status = 'running';
            try {
                job.result = await this.rebuildProjectAsync(id, {
                    mode,
                    batchSize,
                    onProgress: progress => { job.progress = progress; },
                });
                job.status = 'completed';
            } catch (error) {
                job.error = { code: error?.code ?? 'retrieval_rebuild_failed', message: error?.message ?? 'Retrieval rebuild failed.' };
                job.status = 'failed';
            }
            job.finishedAt = nowIso();
        };
        const handle = setImmediate(() => { void run(); });
        if (typeof handle.unref === 'function') handle.unref();
        return { jobId, projectId: id, status: job.status, createdAt: job.createdAt };
    }

    getJob(jobId) {
        const id = String(jobId ?? '');
        const job = this.jobs.get(id);
        if (!job) throw new ApiError(404, 'not_found', 'Retrieval rebuild job not found.');
        if (Date.now() - Date.parse(job.createdAt) > JOB_TTL_MS) {
            this.jobs.delete(id);
            throw new ApiError(404, 'not_found', 'Retrieval rebuild job not found.');
        }
        return clone(job);
    }
}

export function createRetrievalStore(rootDirectory, options) {
    return new RetrievalStore(rootDirectory, options);
}
