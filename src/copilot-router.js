import express from 'express';

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

async function writeEvent(response, event) {
    if (response.destroyed || response.writableEnded) return;
    if (response.write(`${JSON.stringify(event)}\n`)) return;
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            response.removeListener('drain', drain);
            response.removeListener('close', close);
            response.removeListener('error', close);
        };
        const drain = () => { cleanup(); resolve(); };
        const close = () => { cleanup(); reject(new DOMException('Client disconnected.', 'AbortError')); };
        response.once('drain', drain);
        response.once('close', close);
        response.once('error', close);
    });
}

function streamError(error) {
    return {
        type: 'error',
        error: typeof error?.code === 'string' ? error.code : 'copilot_generation_failed',
        message: error?.name === 'AbortError' ? 'Copilot generation stopped.' : String(error?.message ?? 'Copilot generation failed.'),
    };
}

export function createCopilotRouter(service) {
    const router = express.Router();

    router.get('/copilot/settings', (_request, response) => {
        response.send(service.getSettings());
    });

    router.put('/copilot/settings', (request, response) => {
        response.send(service.updateSettings(request.body));
    });

    router.post('/copilot/settings/test', asyncRoute(async (_request, response) => {
        response.send(await service.testSettings());
    }));

    router.post('/story-studio/projects/:projectId/copilot/context-preview', (request, response) => {
        response.send(service.previewContext(request.params.projectId, request.body));
    });

    router.get('/story-studio/projects/:projectId/copilot/sessions', (request, response) => {
        response.send(service.listSessions(request.params.projectId));
    });

    router.post('/story-studio/projects/:projectId/copilot/sessions', (request, response) => {
        response.status(201).send(service.createSession(request.params.projectId, request.body));
    });

    router.get('/story-studio/projects/:projectId/copilot/sessions/:sessionId', (request, response) => {
        response.send(service.getSession(request.params.projectId, request.params.sessionId));
    });

    router.post('/story-studio/projects/:projectId/copilot/sessions/:sessionId/generate', asyncRoute(
        async (request, response, next) => {
            const controller = new AbortController();
            const abort = () => {
                if (!controller.signal.aborted) {
                    controller.abort(new DOMException('Client disconnected.', 'AbortError'));
                }
            };
            request.once('aborted', abort);
            response.once('close', () => {
                if (!response.writableEnded) abort();
            });
            try {
                const result = await service.generateSession(
                    request.params.projectId,
                    request.params.sessionId,
                    request.body,
                    {
                        signal: controller.signal,
                        onMeta: async meta => {
                            response.status(200);
                            response.set({
                                'Content-Type': 'application/x-ndjson; charset=utf-8',
                                'Cache-Control': 'no-store, no-transform',
                                'X-Accel-Buffering': 'no',
                            });
                            response.flushHeaders();
                            await writeEvent(response, { type: 'meta', ...meta });
                        },
                        onDelta: delta => writeEvent(response, { type: 'delta', delta }),
                    },
                );
                await writeEvent(response, { type: 'done', ...result });
                if (!response.writableEnded && !response.destroyed) response.end();
            } catch (error) {
                if (!response.headersSent) {
                    next(error);
                    return;
                }
                try {
                    await writeEvent(response, streamError(error));
                } catch {
                    // The client has already disconnected.
                }
                if (!response.writableEnded && !response.destroyed) response.end();
            } finally {
                request.removeListener('aborted', abort);
            }
        },
    ));

    router.post('/story-studio/projects/:projectId/copilot/sessions/:sessionId/cancel', (request, response) => {
        response.status(202).send(service.cancelSession(
            request.params.projectId,
            request.params.sessionId,
            request.body,
        ));
    });

    return router;
}
