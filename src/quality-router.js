import express from 'express';

export function createQualityRouter(service) {
    const router = express.Router();

    router.get('/prompt-profiles/builtins', (_request, response) => {
        response.send(service.listBuiltinProfiles());
    });

    router.get('/prompt-profiles/builtins/:profileId', (request, response) => {
        response.send(service.getBuiltinProfile(request.params.profileId));
    });

    router.post('/projects/:projectId/prompt-profiles/builtins/:profileId/copies', (request, response) => {
        response.status(201).send(service.copyBuiltinProfile(
            request.params.projectId,
            request.params.profileId,
            request.body,
        ));
    });

    router.post('/projects/:projectId/chapters/:chapterId/quality-preview', (request, response) => {
        response.send(service.previewChapter(
            request.params.projectId,
            request.params.chapterId,
            request.body,
        ));
    });

    router.post('/projects/:projectId/chapters/:chapterId/quality-reports', (request, response) => {
        response.status(201).send(service.createChapterReport(
            request.params.projectId,
            request.params.chapterId,
            request.body,
        ));
    });

    router.get('/projects/:projectId/chapters/:chapterId/quality-reports', (request, response) => {
        response.send(service.listChapterReports(
            request.params.projectId,
            request.params.chapterId,
        ));
    });

    router.get('/projects/:projectId/chapters/:chapterId/quality-reports/:reportId', (request, response) => {
        response.send(service.getChapterReport(
            request.params.projectId,
            request.params.chapterId,
            request.params.reportId,
        ));
    });

    router.get('/quality-regression/suite', (_request, response) => {
        response.send(service.getRegressionSuite());
    });

    router.get('/quality-regression/baseline', (_request, response) => {
        response.send(service.getRegressionBaseline());
    });

    router.post('/quality-regression/runs', (request, response) => {
        response.status(201).send(service.runRegression(request.body));
    });

    router.get('/quality-regression/runs', (_request, response) => {
        response.send(service.listRegressionRuns());
    });

    router.get('/quality-regression/runs/:runId', (request, response) => {
        response.send(service.getRegressionRun(request.params.runId));
    });

    router.post('/quality-regression/comparisons', (request, response) => {
        response.status(201).send(service.compareRegression(request.body));
    });

    router.get('/quality-regression/comparisons', (_request, response) => {
        response.send(service.listComparisons());
    });

    router.get('/quality-regression/comparisons/:comparisonId', (request, response) => {
        response.send(service.getComparison(request.params.comparisonId));
    });

    return router;
}
