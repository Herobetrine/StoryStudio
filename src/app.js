import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';

import { ApiError } from './api-error.js';
import { ChapterVersionStore } from './chapter-version-store.js';
import { createCopilotRouter } from './copilot-router.js';
import { CopilotService } from './copilot-service.js';
import { CopilotStore } from './copilot-store.js';
import { createGenerationRouter } from './generation-router.js';
import { GenerationService } from './generation-service.js';
import { GenerationStore } from './generation-store.js';
import { createChatCompletion, normalizeGenerationRequest, testProvider } from './openai-provider.js';
import { ProviderStore } from './provider-store.js';
import { createQualityRouter } from './quality-router.js';
import { QualityService } from './quality-service.js';
import { QualityStore } from './quality-store.js';
import { RetrievalStore } from './retrieval-store.js';
import { createStoryStudioRouter } from './story-studio-router.js';
import { StoryStudioStore } from './story-studio-store.js';
import { createWorkflowRouter } from './workflow-router.js';
import { WorkflowService } from './workflow-service.js';
import { WorkflowStore } from './workflow-store.js';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, '..');
const IMPORT_LIMIT = 100 * 1024 * 1024;
const RESOURCE_IMPORT_LIMIT = 30 * 1024 * 1024;
const API_LIMIT = 12 * 1024 * 1024;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalHostname(value) {
    return LOCAL_HOSTNAMES.has(String(value).toLowerCase());
}

function validHostHeader(hostHeader) {
    if (typeof hostHeader !== 'string' || hostHeader.length === 0 || /[@/?#\\]/.test(hostHeader)) return false;
    try {
        const url = new URL(`http://${hostHeader}`);
        return !url.username && !url.password && isLocalHostname(url.hostname);
    } catch {
        return false;
    }
}

function validOriginHeader(originHeader) {
    if (originHeader === undefined) return true;
    if (typeof originHeader !== 'string' || originHeader.length === 0) return false;
    try {
        const url = new URL(originHeader);
        return ['http:', 'https:'].includes(url.protocol)
            && !url.username
            && !url.password
            && isLocalHostname(url.hostname);
    } catch {
        return false;
    }
}

function tokenMatches(expected, actual) {
    if (typeof actual !== 'string') return false;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

function apiErrorHandler(error, _request, response, _next) {
    if (response.headersSent) return;
    if (error?.type === 'entity.too.large') {
        response.status(413).send({ error: 'payload_too_large', message: 'The JSON request body is too large.' });
        return;
    }
    if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
        response.status(400).send({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
        return;
    }
    if (error?.status === 404) {
        response.status(404).send({ error: 'not_found', message: 'Resource not found.' });
        return;
    }
    if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
        response.status(error.status).send({
            error: error.code,
            message: error.message,
            ...(error.details && typeof error.details === 'object' ? error.details : {}),
        });
        return;
    }
    console.error('Story Studio request failed:', error);
    response.status(500).send({ error: 'internal_error', message: 'Story Studio request failed.' });
}

function readVersion(projectRoot) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
        return typeof packageJson.version === 'string' ? packageJson.version : '0.7.0';
    } catch {
        return '0.7.0';
    }
}

function createRetrievalReranker(providerStore, fetchImplementation) {
    return async ({ query, hits }) => {
        const settings = providerStore.getResolved();
        const allowedIds = hits.map(hit => hit.id);
        const request = normalizeGenerationRequest({
            systemPrompt: 'Rank only the supplied retrieval ids by relevance. Return JSON and do not add ids.',
            prompt: JSON.stringify({ query, hits: hits.map(hit => ({ id: hit.id, text: hit.text })) }),
            responseLength: Math.min(512, settings.maxTokens),
            temperature: 0,
            jsonSchema: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string', enum: allowedIds } },
                },
                required: ['ids'],
                additionalProperties: false,
            },
        }, settings);
        const response = await createChatCompletion(settings, request, { fetchImplementation });
        const source = String(response.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(source);
        if (!Array.isArray(parsed?.ids)) throw new Error('Provider rerank response is invalid.');
        return parsed.ids;
    };
}

export function createApp({
    dataRoot = path.join(DEFAULT_PROJECT_ROOT, 'data'),
    projectRoot = DEFAULT_PROJECT_ROOT,
    publicDirectory = path.join(projectRoot, 'public'),
    iconsDirectory = path.join(projectRoot, 'node_modules', 'lucide-static', 'icons'),
    fetchImplementation = globalThis.fetch,
} = {}) {
    const resolvedDataRoot = path.resolve(dataRoot);
    const storyStore = new StoryStudioStore(path.join(resolvedDataRoot, 'story-studio'), {
        migrationBackupsDirectory: path.join(resolvedDataRoot, 'migration-backups'),
    });
    const generationStore = new GenerationStore(path.join(resolvedDataRoot, 'generation-history'));
    const chapterVersionStore = new ChapterVersionStore(path.join(resolvedDataRoot, 'chapter-versions'));
    const providerStore = new ProviderStore(resolvedDataRoot);
    const retrievalStore = new RetrievalStore(path.join(resolvedDataRoot, 'retrieval'), {
        storyStore,
        reranker: createRetrievalReranker(providerStore, fetchImplementation),
    });
    const generationService = new GenerationService({
        storyStore,
        generationStore,
        chapterVersionStore,
        providerStore,
        retrievalStore,
        fetchImplementation,
    });
    const workflowStore = new WorkflowStore(path.join(resolvedDataRoot, 'workflows'));
    const copilotStore = new CopilotStore(path.join(resolvedDataRoot, 'copilot'));
    const copilotService = new CopilotService({
        copilotStore,
        storyStore,
        providerStore,
        retrievalStore,
        fetchImplementation,
    });
    const workflowService = new WorkflowService({
        workflowStore,
        storyStore,
        generationService,
        chapterVersionStore,
        retrievalStore,
        copilotService,
    });
    const qualityStore = new QualityStore(path.join(resolvedDataRoot, 'quality'));
    const qualityService = new QualityService({
        storyStore,
        generationStore,
        providerStore,
        qualityStore,
        projectRoot,
    });
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const app = express();

    app.disable('x-powered-by');
    app.disable('etag');
    app.set('trust proxy', false);
    app.locals.csrfToken = csrfToken;
    app.locals.dataRoot = resolvedDataRoot;

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'none'"],
                frameAncestors: ["'none'"],
                formAction: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));

    app.use((request, response, next) => {
        if (!validHostHeader(request.headers.host)) {
            response.status(403).send({ error: 'invalid_host', message: 'Story Studio only accepts local Host headers.' });
            return;
        }
        if (!validOriginHeader(request.headers.origin)) {
            response.status(403).send({ error: 'invalid_origin', message: 'Story Studio only accepts local browser origins.' });
            return;
        }
        next();
    });

    app.use('/api', (request, response, next) => {
        response.set('Cache-Control', 'no-store');
        if (!WRITE_METHODS.has(request.method)) {
            next();
            return;
        }
        if (!request.is('application/json')) {
            response.status(415).send({ error: 'unsupported_media_type', message: 'API writes require application/json.' });
            return;
        }
        if (!tokenMatches(csrfToken, request.get('X-CSRF-Token'))) {
            response.status(403).send({ error: 'csrf_failed', message: 'The CSRF token is missing or invalid.' });
            return;
        }
        next();
    });

    // The import parser must run before the smaller general API parser.
    app.use('/api/story-studio/projects/import', express.json({ limit: IMPORT_LIMIT, strict: true }));
    app.use(/^\/api\/story-studio\/projects\/[^/]+\/resources\/import$/, express.json({ limit: RESOURCE_IMPORT_LIMIT, strict: true }));
    app.use('/api', express.json({ limit: API_LIMIT, strict: true }));

    app.get('/api/bootstrap', (_request, response) => {
        response.send({
            name: 'Story Studio',
            version: readVersion(projectRoot),
            csrfToken,
        });
    });

    app.get('/api/provider', (_request, response) => {
        response.send(providerStore.getPublic());
    });

    app.put('/api/provider', (request, response) => {
        response.send(providerStore.update(request.body));
    });

    app.post('/api/provider/test', asyncRoute(async (request, response) => {
        const settings = providerStore.resolve(request.body, { allowEmpty: true });
        response.send(await testProvider(settings, { fetchImplementation }));
    }));

    app.post('/api/generate', asyncRoute(async (request, response) => {
        const settings = providerStore.getResolved();
        const generationRequest = normalizeGenerationRequest(request.body, settings);
        response.send(await createChatCompletion(settings, generationRequest, { fetchImplementation }));
    }));

    app.use('/api/story-studio', createGenerationRouter(generationService));
    app.use('/api/story-studio', createWorkflowRouter(workflowService));
    app.use('/api/story-studio', createQualityRouter(qualityService));
    app.use('/api/story-studio', createStoryStudioRouter(storyStore, chapterVersionStore, retrievalStore));
    app.use('/api', createCopilotRouter(copilotService));

    app.use('/api', (_request, response) => {
        response.status(404).send({ error: 'not_found', message: 'API endpoint not found.' });
    });

    app.use('/icons', express.static(iconsDirectory, { fallthrough: false, immutable: true, maxAge: '1d' }));
    app.use(express.static(publicDirectory, { extensions: ['html'], maxAge: 0 }));
    app.get(/.*/, (_request, response, next) => {
        const indexPath = path.join(publicDirectory, 'index.html');
        if (!fs.existsSync(indexPath)) {
            next();
            return;
        }
        response.sendFile(indexPath);
    });

    app.use(apiErrorHandler);
    return app;
}

export { API_LIMIT, IMPORT_LIMIT, RESOURCE_IMPORT_LIMIT };
