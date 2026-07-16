import express from 'express';
import { createHash } from 'node:crypto';

import { ApiError } from './api-error.js';
import { chapterSnapshotHash, chapterVersionInput } from './chapter-version-store.js';
import { buildProjectDashboard } from './project-dashboard.js';

const FORMAL_CHAPTER_FIELDS = new Set(['title', 'status', 'card', 'content', 'review', 'notes']);

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

function assertJsonObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, 'invalid_request', `${label} must be a JSON object.`);
    }
}

function assertEnvelope(value, allowedFields, label) {
    assertJsonObject(value, label);
    const unknownFields = Object.keys(value).filter(key => !allowedFields.includes(key));
    if (unknownFields.length > 0) {
        throw new ApiError(400, 'unknown_fields', `${label} contains unknown fields.`, { fields: unknownFields });
    }
}

function contentCharacters(value) {
    let count = 0;
    for (const _character of String(value ?? '')) count += 1;
    return count;
}

function contentLines(value) {
    const content = String(value ?? '');
    return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
}

function currentVersionSnapshot(project, chapter) {
    const input = chapterVersionInput(project.version, chapter, 'manual');
    return {
        schemaVersion: 1,
        versionId: 'current',
        ...input,
        source: 'current',
        createdAt: chapter.updatedAt,
        contentHash: createHash('sha256').update(chapter.content, 'utf8').digest('hex'),
        snapshotHash: chapterSnapshotHash(input),
        isCurrent: true,
    };
}

function currentVersionSummary(project, chapter) {
    const snapshot = currentVersionSnapshot(project, chapter);
    return {
        versionId: snapshot.versionId,
        projectVersion: snapshot.projectVersion,
        chapterRevision: snapshot.chapterRevision,
        title: snapshot.title,
        status: snapshot.status,
        source: snapshot.source,
        createdAt: snapshot.createdAt,
        contentHash: snapshot.contentHash,
        snapshotHash: snapshot.snapshotHash,
        characters: contentCharacters(snapshot.content),
        lines: contentLines(snapshot.content),
        isCurrent: true,
    };
}

function assertCurrentVersions(project, chapter, projectVersion, chapterRevision) {
    if (!Number.isInteger(projectVersion) || projectVersion < 1
        || !Number.isInteger(chapterRevision) || chapterRevision < 1) {
        throw new ApiError(400, 'invalid_request', 'projectVersion and chapterRevision must be positive integers.');
    }
    if (project.version !== projectVersion) {
        throw new ApiError(409, 'project_conflict', '作品已在其他窗口变化。', {
            currentVersion: project.version,
        });
    }
    if (chapter.revision !== chapterRevision) {
        throw new ApiError(409, 'chapter_conflict', '章节已在其他窗口变化。', {
            currentRevision: chapter.revision,
            currentProjectVersion: project.version,
        });
    }
}

function capturePreviousVersion(versionStore, source) {
    if (!versionStore) return null;
    return ({ projectVersion, chapter }) => versionStore.appendVersion(
        chapterVersionInput(projectVersion, chapter, source),
    );
}

function requireVersionStore(versionStore) {
    if (!versionStore) {
        throw new ApiError(503, 'version_history_unavailable', '正式稿版本仓库不可用。');
    }
    return versionStore;
}

function hasFormalChapterChanges(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).some(field => FORMAL_CHAPTER_FIELDS.has(field)));
}

export function createStoryStudioRouter(store, chapterVersionStore = null, retrievalStore = null) {
    const router = express.Router();

    router.get('/projects', (_request, response) => {
        response.send(store.listProjects());
    });

    router.post('/projects', (request, response) => {
        response.status(201).send(store.createProject(request.body));
    });

    router.post('/projects/import', async (request, response) => {
        response.status(201).send(await store.importProject(request.body));
    });

    router.get('/projects/:projectId/export', async (request, response) => {
        response.send(await store.exportProject(request.params.projectId));
    });

    router.get('/projects/:projectId', (request, response) => {
        response.send(store.getProject(request.params.projectId));
    });

    router.get('/projects/:projectId/dashboard', (request, response) => {
        response.send(buildProjectDashboard(store.getProject(request.params.projectId)));
    });

    router.patch('/projects/:projectId', (request, response) => {
        assertEnvelope(request.body, ['version', 'changes'], 'Project update');
        const project = store.updateProject(request.params.projectId, request.body.version, request.body.changes);
        response.send(project);
    });

    router.post('/projects/:projectId/volumes', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'volume'], 'Volume creation');
        const result = store.createVolume(
            request.params.projectId,
            request.body.projectVersion,
            request.body.volume,
        );
        response.status(201).send(result);
    });

    router.patch('/projects/:projectId/volumes/:volumeId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision', 'changes'], 'Volume update');
        response.send(store.updateVolume(
            request.params.projectId,
            request.params.volumeId,
            request.body.projectVersion,
            request.body.revision,
            request.body.changes,
        ));
    });

    router.delete('/projects/:projectId/volumes/:volumeId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision'], 'Volume deletion');
        response.send(store.deleteVolume(
            request.params.projectId,
            request.params.volumeId,
            request.body.projectVersion,
            request.body.revision,
        ));
    });

    router.post('/projects/:projectId/structure', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'volumes'], 'Structure update');
        response.send(store.updateStructure(
            request.params.projectId,
            request.body.projectVersion,
            request.body.volumes,
        ));
    });

    router.post('/projects/:projectId/chapters', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'chapter'], 'Chapter creation');
        const result = store.createChapter(request.params.projectId, request.body.projectVersion, request.body.chapter);
        response.status(201).send(result);
    });

    router.post('/projects/:projectId/chapters/reorder', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'chapterIds'], 'Chapter reorder');
        response.send(store.reorderChapters(
            request.params.projectId,
            request.body.projectVersion,
            request.body.chapterIds,
        ));
    });

    router.get('/projects/:projectId/resources', (request, response) => {
        response.send(store.listResources(request.params.projectId, request.query.type || null));
    });

    router.post('/projects/:projectId/resources/import', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'import'], 'Resource import');
        const result = store.importResource(request.params.projectId, request.body.projectVersion, request.body.import);
        response.status(201).send(result);
    });

    router.patch('/projects/:projectId/resources/activation', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'changes'], 'Resource activation');
        response.send(store.updateResourceActivation(request.params.projectId, request.body.projectVersion, request.body.changes));
    });

    router.get('/projects/:projectId/retrieval/status', (request, response) => {
        if (!retrievalStore) {
            throw new ApiError(503, 'retrieval_unavailable', 'Retrieval index is unavailable.');
        }
        response.send(retrievalStore.status(request.params.projectId));
    });

    router.post('/projects/:projectId/retrieval/preview', asyncRoute(async (request, response) => {
        if (!retrievalStore) {
            throw new ApiError(503, 'retrieval_unavailable', 'Retrieval index is unavailable.');
        }
        assertJsonObject(request.body, 'Retrieval preview');
        const body = request.body;
        const result = retrievalStore.preview(request.params.projectId, body.chapterId ?? null, body);
        response.send(await result);
    }));

    router.post('/projects/:projectId/chapters/:chapterId/retrieval/preview', asyncRoute(async (request, response) => {
        if (!retrievalStore) {
            throw new ApiError(503, 'retrieval_unavailable', 'Retrieval index is unavailable.');
        }
        assertJsonObject(request.body, 'Retrieval preview');
        const body = request.body;
        const result = retrievalStore.preview(request.params.projectId, request.params.chapterId, body);
        response.send(await result);
    }));

    router.post('/projects/:projectId/retrieval/rebuild', (request, response) => {
        if (!retrievalStore) {
            throw new ApiError(503, 'retrieval_unavailable', 'Retrieval index is unavailable.');
        }
        assertEnvelope(request.body, ['projectVersion', 'mode', 'batchSize', 'async'], 'Retrieval rebuild');
        const project = store.getProject(request.params.projectId);
        if (request.body.projectVersion !== undefined && request.body.projectVersion !== project.version) {
            throw new ApiError(409, 'project_conflict', 'Project changed before retrieval rebuild started.', {
                currentVersion: project.version,
            });
        }
        const result = retrievalStore.requestRebuild(request.params.projectId, {
            async: request.body.async,
            mode: request.body.mode,
            batchSize: request.body.batchSize,
        });
        response.status(request.body.async === true ? 202 : 200).send(result);
    });

    router.get('/projects/:projectId/retrieval/rebuild/:jobId', (request, response) => {
        if (!retrievalStore) {
            throw new ApiError(503, 'retrieval_unavailable', 'Retrieval index is unavailable.');
        }
        const job = retrievalStore.getJob(request.params.jobId);
        if (job.projectId !== request.params.projectId) {
            throw new ApiError(404, 'not_found', 'Retrieval rebuild job not found.');
        }
        response.send(job);
    });

    router.get('/projects/:projectId/resources/:resourceType/:resourceId', (request, response) => {
        response.send(store.getResource(
            request.params.projectId,
            request.params.resourceType,
            request.params.resourceId,
        ));
    });

    router.patch('/projects/:projectId/resources/:resourceType/:resourceId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision', 'changes'], 'Resource update');
        response.send(store.updateResource(
            request.params.projectId,
            request.params.resourceType,
            request.params.resourceId,
            request.body.projectVersion,
            request.body.revision,
            request.body.changes,
        ));
    });

    router.delete('/projects/:projectId/resources/:resourceType/:resourceId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision'], 'Resource deletion');
        response.send(store.deleteResource(
            request.params.projectId,
            request.params.resourceType,
            request.params.resourceId,
            request.body.projectVersion,
            request.body.revision,
        ));
    });

    router.get('/projects/:projectId/chapters/:chapterId', (request, response) => {
        response.send(store.getChapter(request.params.projectId, request.params.chapterId));
    });

    router.delete('/projects/:projectId/chapters/:chapterId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'chapterRevision', 'activeChapterId'], 'Chapter deletion');
        response.send(store.deleteChapter(
            request.params.projectId,
            request.params.chapterId,
            request.body.projectVersion,
            request.body.chapterRevision,
            request.body.activeChapterId,
        ));
    });

    router.patch('/projects/:projectId/chapters/:chapterId', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision', 'changes'], 'Chapter update');
        const result = store.updateChapter(
            request.params.projectId,
            request.params.chapterId,
            request.body.projectVersion,
            request.body.revision,
            request.body.changes,
            {
                beforeCommit: hasFormalChapterChanges(request.body.changes)
                    ? capturePreviousVersion(chapterVersionStore, 'manual')
                    : null,
            },
        );
        response.send(result);
    });

    router.get('/projects/:projectId/chapters/:chapterId/versions', (request, response) => {
        const versionStore = requireVersionStore(chapterVersionStore);
        const { project, chapter } = store.getProjectAndChapter(
            request.params.projectId,
            request.params.chapterId,
        );
        const current = currentVersionSummary(project, chapter);
        const history = versionStore.listVersions(project.id, chapter.id)
            .filter(version => version.chapterRevision !== chapter.revision);
        response.send([current, ...history]);
    });

    router.get('/projects/:projectId/chapters/:chapterId/versions/:versionId', (request, response) => {
        const versionStore = requireVersionStore(chapterVersionStore);
        const { project, chapter } = store.getProjectAndChapter(
            request.params.projectId,
            request.params.chapterId,
        );
        if (request.params.versionId === 'current') {
            response.send(currentVersionSnapshot(project, chapter));
            return;
        }
        response.send(versionStore.getVersion(project.id, chapter.id, request.params.versionId));
    });

    router.post('/projects/:projectId/chapters/:chapterId/versions/:versionId/restore', (request, response) => {
        const versionStore = requireVersionStore(chapterVersionStore);
        assertEnvelope(request.body, ['projectVersion', 'chapterRevision'], 'Chapter version restore');
        if (request.params.versionId === 'current') {
            throw new ApiError(409, 'version_is_current', '当前正式稿不需要恢复。');
        }
        const { project, chapter } = store.getProjectAndChapter(
            request.params.projectId,
            request.params.chapterId,
        );
        assertCurrentVersions(
            project,
            chapter,
            request.body.projectVersion,
            request.body.chapterRevision,
        );
        const changes = versionStore.getRestoreChanges(project.id, chapter.id, request.params.versionId);
        const result = store.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            changes,
            { beforeCommit: capturePreviousVersion(versionStore, 'restore') },
        );
        response.send({
            ...result,
            version: currentVersionSummary(result.project, result.chapter),
        });
    });

    router.post('/projects/:projectId/chapters/:chapterId/adopt', (request, response) => {
        assertEnvelope(request.body, ['projectVersion', 'revision', 'payload'], 'Generation adoption');
        response.send(store.adoptGeneration(
            request.params.projectId,
            request.params.chapterId,
            request.body.projectVersion,
            request.body.revision,
            request.body.payload,
            { beforeCommit: capturePreviousVersion(chapterVersionStore, 'adopt') },
        ));
    });

    return router;
}
