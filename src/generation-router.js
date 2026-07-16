import express from 'express';

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

export async function writeGenerationEvent(response, event) {
    if (response.destroyed || response.writableEnded) return;
    if (response.write(`${JSON.stringify(event)}\n`)) return;
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            response.removeListener('drain', onDrain);
            response.removeListener('close', onClose);
            response.removeListener('error', onError);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new DOMException('Client disconnected.', 'AbortError')); };
        const onError = () => { cleanup(); reject(new DOMException('Client connection failed.', 'AbortError')); };
        response.once('drain', onDrain);
        response.once('close', onClose);
        response.once('error', onError);
    });
}

function publicStreamError(error) {
    const code = typeof error?.code === 'string' ? error.code : 'generation_failed';
    const messages = {
        provider_http_error: 'The model provider rejected the generation request.',
        provider_unreachable: 'Could not reach the model provider.',
        provider_timeout: 'The model provider timed out.',
        provider_invalid_response: 'The model provider returned an invalid stream.',
        generation_too_large: 'The generated candidate exceeded the local storage limit.',
    };
    return {
        type: 'error',
        error: code,
        message: error?.name === 'AbortError' ? 'Generation stopped.' : messages[code] ?? 'Generation failed.',
        generationId: error?.generationId ?? null,
        partial: error?.partial === true,
    };
}

export function createGenerationRouter(service) {
    const router = express.Router();

    router.post('/projects/:projectId/chapters/:chapterId/generation-preview', (request, response) => {
        response.send(service.previewGeneration(request.params.projectId, request.params.chapterId, request.body));
    });

    router.post('/projects/:projectId/chapters/:chapterId/generations/stream', asyncRoute(async (request, response, next) => {
        const controller = new AbortController();
        const abort = () => {
            if (!controller.signal.aborted) controller.abort(new DOMException('Client disconnected.', 'AbortError'));
        };
        request.once('aborted', abort);
        response.once('close', () => {
            if (!response.writableEnded) abort();
        });
        try {
            const result = await service.streamGeneration(
                request.params.projectId,
                request.params.chapterId,
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
                        await writeGenerationEvent(response, { type: 'meta', ...meta });
                    },
                    onDelta: delta => writeGenerationEvent(response, { type: 'delta', delta }),
                },
            );
            await writeGenerationEvent(response, {
                type: 'done',
                generation: result.generation,
                diagnostics: result.diagnostics,
            });
            if (!response.writableEnded && !response.destroyed) response.end();
        } catch (error) {
            if (!response.headersSent) {
                next(error);
                return;
            }
            await writeGenerationEvent(response, publicStreamError(error));
            if (!response.writableEnded && !response.destroyed) response.end();
        } finally {
            request.removeListener('aborted', abort);
        }
    }));

    router.get('/projects/:projectId/chapters/:chapterId/generations', (request, response) => {
        response.send(service.listGenerations(request.params.projectId, request.params.chapterId));
    });

    router.get('/projects/:projectId/chapters/:chapterId/generations/:generationId', (request, response) => {
        response.send(service.getGeneration(
            request.params.projectId,
            request.params.chapterId,
            request.params.generationId,
        ));
    });

    router.post('/projects/:projectId/chapters/:chapterId/generations/:generationId/distill', asyncRoute(async (request, response) => {
        response.send(await service.distillGeneration(
            request.params.projectId,
            request.params.chapterId,
            request.params.generationId,
            request.body,
        ));
    }));

    router.post('/projects/:projectId/chapters/:chapterId/generations/:generationId/adopt', (request, response) => {
        response.send(service.adoptGeneration(
            request.params.projectId,
            request.params.chapterId,
            request.params.generationId,
            request.body,
        ));
    });

    return router;
}
