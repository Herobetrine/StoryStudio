import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
    LEGACY_STREAM_CHUNKS,
    classifyMockProviderRequest,
    createMockProviderServer,
    mockCompletionForRequest,
} from '../scripts/mock-provider-server.js';
import { validateCopilotModelOutput } from '../src/copilot-schema.js';
import { validateStoryStateChangeSet } from '../src/story-studio-store.js';
import {
    normalizeWorkflowV2ArtifactPayload,
    workflowContractDigest,
} from '../src/workflow-contracts.js';
import {
    buildWorkflowV2Prompt,
    materializeAdoptionPayload,
    materializeBrainstormPayloads,
    materializeDraftPayload,
    materializePlanPayload,
    materializeReviewPayload,
    materializeRewritePayload,
} from '../src/workflow-v2-runtime.js';

const fixturePath = fileURLToPath(new URL('../scripts/mock-provider-server.js', import.meta.url));
const EMPTY_STORY_STATE = Object.freeze({
    entities: [],
    relations: [],
    events: [],
    promises: [],
    memory: [],
    facts: [],
    knowledge: [],
    timeline: [],
});
const EVIDENCE_ID = 'evidence_0123456789abcdef0123456789abcdef01234567';

function workflowBody(operation, materials) {
    const prompt = buildWorkflowV2Prompt(operation, materials);
    return {
        model: 'mock-workflow-v2',
        stream: true,
        messages: [
            { role: 'system', content: prompt.systemPrompt },
            { role: 'user', content: prompt.userPrompt },
        ],
    };
}

function parsedCompletion(body) {
    return JSON.parse(mockCompletionForRequest(body).content);
}

function copilotBody(optionCount) {
    return {
        model: 'mock-copilot',
        stream: true,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'story_studio_planning_copilot' },
        },
        messages: [{
            role: 'system',
            content: 'StoryStudio Copilot is read-only.',
        }, {
            role: 'user',
            content: [
                '# 作品身份',
                'projectId=project-one',
                '# 作者手选证据',
                `[${EVIDENCE_ID}] 项目设定`,
                'source=project:project-one visibility=author',
                '旧规则',
                `[${EVIDENCE_ID}] 赤门设定集`,
                'source=lorebook:lore-one visibility=author',
                '赤门资料',
                '# 输出要求',
                `必须输出恰好 ${optionCount} 个互不兼容的情节方向。`,
            ].join('\n'),
        }],
    };
}

function copilotValidationContext() {
    return {
        optionCount: 3,
        evidenceCatalog: [{
            evidenceId: EVIDENCE_ID,
            source: { type: 'project', id: 'project-one', path: 'project/story' },
            title: '项目设定',
            excerpt: '旧规则',
            visibility: 'author',
            selectedByDefault: true,
            tags: [],
        }],
        targetSnapshot: {
            project: { id: 'project-one', story: { world: '旧规则' } },
            volumes: [],
            chapters: [],
            lorebooks: [{ id: 'lore-one', revision: 2, name: '赤门设定集', entries: [] }],
        },
        identitySeed: 'mock-session',
    };
}

function postJson({ port, body, onResponse }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, response => {
            if (onResponse) {
                onResponse(response, resolve, reject);
                return;
            }
            let value = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { value += chunk; });
            response.on('end', () => resolve({ response, value }));
            response.on('error', reject);
        });
        request.on('error', reject);
        request.end(JSON.stringify(body));
    });
}

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function closeServer(server) {
    if (!server.listening) return;
    server.close();
    await once(server, 'close');
}

async function availablePort() {
    const server = http.createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
}

function immediate() {
    return new Promise(resolve => setImmediate(resolve));
}

describe('browser mock provider fixture', () => {
    test('preserves V1 OK, chapter streaming chunks, and state distillation behavior', () => {
        const ordinary = mockCompletionForRequest({
            stream: false,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
        });
        assert.equal(ordinary.kind, 'legacy-response');
        assert.equal(ordinary.content, 'OK');

        const streaming = mockCompletionForRequest({
            stream: true,
            messages: [{ role: 'user', content: '写下一段正文。' }],
        });
        assert.equal(streaming.kind, 'legacy-stream');
        assert.deepEqual(streaming.chunks, [...LEGACY_STREAM_CHUNKS]);
        assert.equal(streaming.content, LEGACY_STREAM_CHUNKS.join(''));

        const distilled = mockCompletionForRequest({
            stream: false,
            messages: [{
                role: 'system',
                content: '你是状态蒸馏器。本章 ID 是 chapter-one',
            }],
        });
        assert.equal(distilled.kind, 'legacy-distillation');
        const intent = JSON.parse(distilled.content);
        const validated = validateStoryStateChangeSet(
            EMPTY_STORY_STATE,
            intent.storyStateChanges,
            ['chapter-one'],
        );
        assert.equal(validated.next.entities.length, 2);
        assert.equal(validated.next.events[0].chapterId, 'chapter-one');
        assert.equal(validated.next.facts[0].subjectEntityId, 'char-linzhao');
    });

    test('feeds all six Workflow V2 model stages through the production materializers', () => {
        const diagnosis = { evidenceCatalog: [] };
        const sourceSnapshot = { chapter: { id: 'chapter-one' }, project: { id: 'project-one' } };

        const brainstormRequest = workflowBody('brainstorm', { diagnosis, sourceSnapshot, instruction: '' });
        assert.deepEqual(classifyMockProviderRequest(brainstormRequest), {
            kind: 'workflow-v2',
            operation: 'brainstorm',
            prompt: brainstormRequest.messages.map(message => message.content).join('\n'),
            materials: { diagnosis, sourceSnapshot, instruction: '' },
        });
        const directions = materializeBrainstormPayloads({
            modelOutput: mockCompletionForRequest(brainstormRequest).content,
            generationId: 'generation-brainstorm',
            diagnosis,
            sourceSnapshot,
        });
        assert.equal(directions.length, 3);
        const selectedDirection = directions[0];

        const planRequest = workflowBody('plan', {
            selectedDirection,
            diagnosis,
            sourceSnapshot,
            instruction: '',
        });
        const plan = materializePlanPayload({
            modelOutput: mockCompletionForRequest(planRequest).content,
            generationId: 'generation-plan',
            directionArtifactId: 'artifact-direction',
            directionPayload: selectedDirection,
        });
        assert.equal(plan.eventChain.length, 4);
        assert.equal(plan.eventChain.at(-1).causedBy, 'beat-3');

        const draftRequest = workflowBody('draft', {
            approvedPlan: plan,
            selectedDirection,
            diagnosis,
            sourceSnapshot,
            instruction: '',
        });
        const draftCompletion = mockCompletionForRequest(draftRequest);
        assert.equal(draftCompletion.kind, 'workflow-v2');
        assert.equal(draftCompletion.operation, 'draft');
        assert.match(draftCompletion.content, /林照没有核对暗号/u);
        const draft = materializeDraftPayload({
            generationId: 'generation-draft',
            planArtifactId: 'artifact-plan',
            planPayload: plan,
            manuscript: draftCompletion.content,
            prompt: draftRequest.messages.map(message => message.content).join('\n'),
            sourceSnapshot,
            retrievalEvidenceIds: [],
        });
        normalizeWorkflowV2ArtifactPayload('chapter-draft', draft, { sourceText: draftCompletion.content });

        const reviewRequest = workflowBody('review', {
            candidateManuscript: draftCompletion.content,
            approvedPlan: plan,
            selectedDirection,
            diagnosis,
            sourceSnapshot,
            instruction: '',
        });
        const review = materializeReviewPayload({
            modelOutput: mockCompletionForRequest(reviewRequest).content,
            generationId: 'generation-review',
            manuscriptArtifactId: 'artifact-draft',
            manuscriptGenerationId: 'generation-draft',
            manuscript: draftCompletion.content,
        });
        assert.equal(review.rewriteRequired, true);
        assert.equal(
            draftCompletion.content.slice(review.rewriteTarget.start, review.rewriteTarget.end),
            review.rewriteTarget.quote,
        );

        const rewriteRequest = workflowBody('rewrite', {
            approvedReview: review,
            approvedRange: review.rewriteTarget,
            contextBefore: draftCompletion.content.slice(0, review.rewriteTarget.start),
            contextAfter: draftCompletion.content.slice(review.rewriteTarget.end),
            instruction: '',
        });
        const rewritten = materializeRewritePayload({
            modelOutput: mockCompletionForRequest(rewriteRequest).content,
            generationId: 'generation-rewrite',
            reviewArtifactId: 'artifact-review',
            reviewPayload: review,
            baseManuscript: draftCompletion.content,
        });
        assert.deepEqual(rewritten.payload.transform.issueIds, review.rewriteTarget.issueIds);
        assert.notEqual(rewritten.resultText, draftCompletion.content);

        const adoptionRequest = workflowBody('adoption', {
            finalManuscript: rewritten.resultText,
            approvedPlan: plan,
            selectedDirection,
            approvedReview: review,
            rewriteDiff: rewritten.payload,
            diagnosis,
            sourceSnapshot,
            instruction: '',
        });
        const adoptionIntent = parsedCompletion(adoptionRequest);
        const targetStoryState = validateStoryStateChangeSet(
            EMPTY_STORY_STATE,
            adoptionIntent.storyStateChanges,
            ['chapter-one'],
        ).next;
        const adoption = materializeAdoptionPayload({
            modelOutput: JSON.stringify(adoptionIntent),
            runId: 'run-one',
            directionArtifactId: 'artifact-direction',
            directionPayload: selectedDirection,
            planArtifactId: 'artifact-plan',
            planPayload: plan,
            reviewArtifactId: 'artifact-review',
            reviewPayload: review,
            rewriteArtifactId: 'artifact-rewrite',
            rewritePayload: rewritten.payload,
            reviewedManuscript: draftCompletion.content,
            manuscriptArtifactId: 'artifact-rewrite',
            manuscriptGenerationId: 'generation-rewrite',
            manuscript: rewritten.resultText,
            targetStoryState,
            authorityFingerprint: {
                projectDigest: workflowContractDigest({ id: 'project-one' }),
                chapterDigest: workflowContractDigest({ id: 'chapter-one' }),
            },
        });
        assert.equal(adoption.payload.chapterSummary, plan.chapterCard.summary);
        assert.equal(adoption.payload.storyStateChanges.events.upsert[0].chapterId, 'chapter-one');
        assert.equal(
            adoption.payload.targetStoryStateDigest,
            workflowContractDigest(targetStoryState),
        );
        normalizeWorkflowV2ArtifactPayload('chapter-adoption', adoption.payload);
    });

    test('anchors review spans with UTF-16 offsets and echoes only approved rewrite issue ids', () => {
        const manuscript = [
            '😀引子先占用一个代理对。',
            '林照没有核对暗号，便把铜钥匙交到守将掌心。',
            '追兵已经逼近。',
        ].join('\n\n');
        const reviewRequest = workflowBody('review', {
            candidateManuscript: manuscript,
            approvedPlan: {
                chapterCard: {
                    required: '主角必须保持对铜钥匙的控制。',
                    avoid: '不得无动机交出关键道具。',
                },
            },
        });
        const reviewIntent = parsedCompletion(reviewRequest);
        const quote = '林照没有核对暗号，便把铜钥匙交到守将掌心。';
        assert.equal(reviewIntent.issues[0].start, manuscript.indexOf(quote));
        assert.equal(reviewIntent.issues[0].end, manuscript.indexOf(quote) + quote.length);
        assert.equal(reviewIntent.issues[0].paragraphIndex, 1);
        const review = materializeReviewPayload({
            modelOutput: JSON.stringify(reviewIntent),
            generationId: 'generation-review-utf16',
            manuscriptArtifactId: 'artifact-draft-utf16',
            manuscriptGenerationId: 'generation-draft-utf16',
            manuscript,
        });

        const rewriteRequest = workflowBody('rewrite', {
            approvedReview: review,
            approvedRange: review.rewriteTarget,
            contextBefore: manuscript.slice(0, review.rewriteTarget.start),
            contextAfter: manuscript.slice(review.rewriteTarget.end),
        });
        const rewriteIntent = parsedCompletion(rewriteRequest);
        assert.deepEqual(rewriteIntent.issueIds, review.rewriteTarget.issueIds);
        const rewritten = materializeRewritePayload({
            modelOutput: JSON.stringify(rewriteIntent),
            generationId: 'generation-rewrite-utf16',
            reviewArtifactId: 'artifact-review-utf16',
            reviewPayload: review,
            baseManuscript: manuscript,
        });
        assert.equal(
            rewritten.resultText,
            `${manuscript.slice(0, review.rewriteTarget.start)}${rewriteIntent.replacement}`
                + manuscript.slice(review.rewriteTarget.end),
        );
    });

    test('returns schema-valid three- and six-direction Copilot bundles with evidence and inert diffs', () => {
        for (const optionCount of [3, 6]) {
            const request = copilotBody(optionCount);
            const route = classifyMockProviderRequest(request);
            assert.equal(route.kind, 'copilot');
            const context = copilotValidationContext();
            context.optionCount = optionCount;
            const normalized = validateCopilotModelOutput(parsedCompletion(request), context);
            assert.equal(normalized.plotOptions.length, optionCount);
            assert.ok(normalized.plotOptions.every(option => option.evidenceIds.includes(EVIDENCE_ID)));
            assert.equal(normalized.changeSet.settingDiffs.length, 1);
            assert.equal(normalized.changeSet.settingDiffs[0].target.id, 'project-one');
            assert.equal(normalized.changeSet.lorebookDiffs.length, 1);
            assert.equal(normalized.changeSet.lorebookDiffs[0].lorebookId, 'lore-one');
            assert.equal(normalized.changeSet.lorebookDiffs[0].beforeEntry, null);
            assert.match(normalized.changeSet.lorebookDiffs[0].afterEntry.content, /赤门侧门/u);
        }
    });

    test('clears a delayed stream timer when the request is aborted before the first chunk', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        const streamTimers = new Set();
        let streamTimerScheduled;
        const scheduled = new Promise(resolve => { streamTimerScheduled = resolve; });
        globalThis.setTimeout = (callback, delay, ...args) => {
            const timer = originalSetTimeout(() => {
                streamTimers.delete(timer);
                callback(...args);
            }, delay);
            if (delay === 60_000) {
                streamTimers.add(timer);
                streamTimerScheduled(timer);
            }
            return timer;
        };
        globalThis.clearTimeout = timer => {
            streamTimers.delete(timer);
            return originalClearTimeout(timer);
        };

        const server = createMockProviderServer({ chunkDelay: 60_000 });
        const port = await listen(server);
        let request;
        try {
            request = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            request.on('error', () => {});
            request.end(JSON.stringify({
                model: 'abort-test',
                stream: true,
                messages: [{ role: 'user', content: 'legacy stream' }],
            }));
            const timer = await scheduled;
            assert.ok(streamTimers.has(timer));
            request.destroy();
            await immediate();
            await immediate();
            assert.equal(streamTimers.has(timer), false);
        } finally {
            request?.destroy();
            for (const timer of streamTimers) originalClearTimeout(timer);
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            await closeServer(server);
        }
    });

    test('clears the next chunk timer when the client closes an established stream', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        const streamTimers = new Set();
        const clearedStreamTimers = new Set();
        globalThis.setTimeout = (callback, delay, ...args) => {
            const timer = originalSetTimeout(() => {
                streamTimers.delete(timer);
                callback(...args);
            }, delay);
            if (delay === 25) streamTimers.add(timer);
            return timer;
        };
        globalThis.clearTimeout = timer => {
            if (streamTimers.has(timer)) clearedStreamTimers.add(timer);
            streamTimers.delete(timer);
            return originalClearTimeout(timer);
        };

        const server = createMockProviderServer({ chunkDelay: 25 });
        const port = await listen(server);
        try {
            await postJson({
                port,
                body: {
                    model: 'close-test',
                    stream: true,
                    messages: [{ role: 'user', content: 'legacy stream' }],
                },
                onResponse(response, resolve) {
                    response.once('data', () => {
                        response.destroy();
                        resolve();
                    });
                },
            });
            await immediate();
            await immediate();
            await new Promise(resolve => originalSetTimeout(resolve, 50));
            assert.equal(streamTimers.size, 0);
            assert.ok(clearedStreamTimers.size >= 1);
        } finally {
            for (const timer of streamTimers) originalClearTimeout(timer);
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            await closeServer(server);
        }
    });

    test('still runs directly as the npm mock-provider entry point', async () => {
        const port = await availablePort();
        const child = spawn(process.execPath, [fixturePath], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: {
                ...process.env,
                MOCK_PROVIDER_PORT: String(port),
                MOCK_PROVIDER_CHUNK_DELAY: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(
                    `mock provider did not start\nstdout=${stdout}\nstderr=${stderr}`,
                )), 5_000);
                const inspect = () => {
                    if (!stdout.includes('Mock provider listening at')) return;
                    clearTimeout(timeout);
                    child.stdout.off('data', inspect);
                    resolve();
                };
                child.stdout.on('data', inspect);
                child.once('exit', code => {
                    clearTimeout(timeout);
                    reject(new Error(`mock provider exited before startup with code ${code}\nstderr=${stderr}`));
                });
                inspect();
            });
            const { response, value } = await postJson({
                port,
                body: {
                    model: 'standalone-test',
                    stream: false,
                    messages: [{ role: 'user', content: 'Reply with OK.' }],
                },
            });
            assert.equal(response.statusCode, 200);
            assert.equal(JSON.parse(value).choices[0].message.content, 'OK');
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                let timeout;
                try {
                    await Promise.race([
                        exited,
                        new Promise(resolve => { timeout = setTimeout(resolve, 2_000); }),
                    ]);
                } finally {
                    clearTimeout(timeout);
                }
            }
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    });
});
