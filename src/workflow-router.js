import express from 'express';

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

export function createWorkflowRouter(service) {
    const router = express.Router();

    router.get('/workflows/definitions', (_request, response) => {
        response.send(service.listDefinitions());
    });

    router.post('/projects/:projectId/chapters/:chapterId/copilot/diagnose', (request, response) => {
        response.send(service.previewDiagnosis(
            request.params.projectId,
            request.params.chapterId,
            request.body,
        ));
    });

    router.get('/projects/:projectId/chapters/:chapterId/workflow-runs', (request, response) => {
        response.send(service.listRuns(request.params.projectId, request.params.chapterId));
    });

    router.post('/projects/:projectId/chapters/:chapterId/workflow-runs', (request, response) => {
        response.status(201).send(service.startRun(
            request.params.projectId,
            request.params.chapterId,
            request.body,
        ));
    });

    router.get('/projects/:projectId/chapters/:chapterId/workflow-runs/:runId', (request, response) => {
        response.send(service.getRun(
            request.params.projectId,
            request.params.chapterId,
            request.params.runId,
        ));
    });

    router.post('/projects/:projectId/chapters/:chapterId/workflow-runs/:runId/commands', asyncRoute(
        async (request, response) => {
            response.send(await service.executeCommand(
                request.params.projectId,
                request.params.chapterId,
                request.params.runId,
                request.body,
            ));
        },
    ));

    return router;
}
