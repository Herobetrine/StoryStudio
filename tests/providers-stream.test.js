import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createChatCompletion,
    createStreamingCompletion,
    normalizeGenerationRequest,
    PROVIDER_RESPONSE_LIMITS,
} from '../src/openai-provider.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/provider-store.js';

function settings(protocol, overrides = {}) {
    return {
        ...DEFAULT_PROVIDER_SETTINGS,
        protocol,
        baseUrl: 'https://provider.example/v1',
        model: 'writer-model',
        apiKey: 'provider-secret',
        temperature: 0.6,
        topP: 0.85,
        topK: 42,
        stop: ['END'],
        maxTokens: 4_096,
        jsonSchema: true,
        ...overrides,
    };
}

function generation(providerSettings, overrides = {}) {
    return normalizeGenerationRequest({
        systemPrompt: 'Follow the story bible.',
        prompt: 'Write the next scene.',
        responseLength: 1_024,
        ...overrides,
    }, providerSettings);
}

function fragmentedStreamResponse(text, {
    contentType = 'text/event-stream',
    fragmentSize = 7,
} = {}) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += fragmentSize) {
                controller.enqueue(bytes.slice(offset, offset + fragmentSize));
            }
            controller.close();
        },
    }), {
        headers: { 'Content-Type': contentType },
    });
}

function controlledStreamResponse(chunks, {
    close = false,
    contentType = 'text/event-stream',
    headers = {},
    status = 200,
} = {}) {
    const encoder = new TextEncoder();
    const encodedChunks = chunks.map(chunk => (
        typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    ));
    const state = {
        cancelled: false,
        cancelReason: undefined,
    };
    const response = new Response(new ReadableStream({
        start(controller) {
            for (const chunk of encodedChunks) controller.enqueue(chunk);
            if (close) controller.close();
        },
        cancel(reason) {
            state.cancelled = true;
            state.cancelReason = reason;
        },
    }), {
        status,
        headers: {
            'Content-Type': contentType,
            ...headers,
        },
    });
    return { response, state };
}

function sse(...events) {
    return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function expectResponseTooLarge(providerSettings, response, {
    limit,
    maximum,
    onDelta,
    streaming = true,
} = {}) {
    let fetchSignal;
    const complete = streaming ? createStreamingCompletion : createChatCompletion;
    await assert.rejects(
        () => complete(providerSettings, generation(providerSettings), {
            fetchImplementation: async (_url, options) => {
                fetchSignal = options.signal;
                return response;
            },
            ...(streaming && typeof onDelta === 'function' ? { onDelta } : {}),
        }),
        error => error?.code === 'provider_response_too_large'
            && error?.status === 502
            && error?.details?.limit === limit
            && error?.details?.maximum === maximum,
    );
    assert.equal(fetchSignal?.aborted, true);
}

async function capture(providerSettings, request, response, options = {}) {
    let outbound;
    const deltas = [];
    const result = await createStreamingCompletion(providerSettings, request, {
        fetchImplementation: async (url, fetchOptions) => {
            outbound = {
                url,
                options: fetchOptions,
                body: JSON.parse(fetchOptions.body),
            };
            return response;
        },
        onDelta: delta => deltas.push(delta),
        ...options,
    });
    return { outbound, deltas, result };
}

describe('streaming provider adapters', () => {
    test('parses fragmented OpenAI chat SSE and preserves usage and finish reason', async () => {
        const providerSettings = settings('openai-chat');
        const response = fragmentedStreamResponse(sse(
            { model: 'writer-model-v2', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ delta: { content: '第一' }, finish_reason: null }] },
            { choices: [{ delta: { content: [{ type: 'text', text: '章' }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ), { fragmentSize: 5 });

        const { outbound, deltas, result } = await capture(
            providerSettings,
            generation(providerSettings),
            response,
        );

        assert.equal(outbound.url, 'https://provider.example/v1/chat/completions');
        assert.equal(outbound.body.stream, true);
        assert.equal(outbound.options.redirect, 'manual');
        assert.equal(outbound.options.headers.Accept, 'text/event-stream');
        assert.deepEqual(deltas, ['第一', '章']);
        assert.deepEqual(result, {
            content: '第一章',
            model: 'writer-model-v2',
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            finishReason: 'stop',
        });
    });

    test('parses Anthropic event streams and merges message usage', async () => {
        const providerSettings = settings('anthropic-messages', {
            baseUrl: 'https://api.anthropic.test/v1',
        });
        const response = fragmentedStreamResponse([
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-writer","usage":{"input_tokens":14}}}',
            '',
            'event: content_block_start',
            'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The gate"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" opened."}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
        ].join('\r\n'), { fragmentSize: 11 });

        const { outbound, deltas, result } = await capture(
            providerSettings,
            generation(providerSettings),
            response,
        );

        assert.equal(outbound.url, 'https://api.anthropic.test/v1/messages');
        assert.equal(outbound.body.stream, true);
        assert.deepEqual(deltas, ['The gate', ' opened.']);
        assert.deepEqual(result, {
            content: 'The gate opened.',
            model: 'claude-writer',
            usage: { input_tokens: 14, output_tokens: 5 },
            finishReason: 'end_turn',
        });
    });

    test('uses each native streaming transport for Google, text completions, Ollama, and llama.cpp', async () => {
        const cases = [
            {
                protocol: 'google-generate-content',
                settings: { baseUrl: 'https://generativelanguage.test/v1beta', model: 'gemini-writer' },
                response: fragmentedStreamResponse(sse(
                    { modelVersion: 'gemini-writer-002', candidates: [{ content: { parts: [{ text: 'Star' }] } }] },
                    { candidates: [{ content: { parts: [{ text: ' gate' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 8 } },
                )),
                expectedUrl: 'https://generativelanguage.test/v1beta/models/gemini-writer:streamGenerateContent?alt=sse',
                expectedStreamField: false,
                expectedModel: 'gemini-writer-002',
                expectedFinishReason: 'STOP',
                expectedUsage: { totalTokenCount: 8 },
            },
            {
                protocol: 'openai-completions',
                response: fragmentedStreamResponse(sse(
                    { model: 'legacy-writer', choices: [{ text: 'Star', finish_reason: null }] },
                    { choices: [{ text: ' gate', finish_reason: 'length' }], usage: { total_tokens: 8 } },
                )),
                expectedUrl: 'https://provider.example/v1/completions',
                expectedStreamField: true,
                expectedModel: 'legacy-writer',
                expectedFinishReason: 'length',
                expectedUsage: { total_tokens: 8 },
            },
            {
                protocol: 'ollama-generate',
                settings: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen-writer' },
                response: fragmentedStreamResponse([
                    '{"model":"qwen-writer","response":"Star","done":false}',
                    '{"model":"qwen-writer","response":" gate","done":false}',
                    '{"model":"qwen-writer","response":"","done":true,"done_reason":"length","prompt_eval_count":6,"eval_count":2}',
                    '',
                ].join('\n'), { contentType: 'application/x-ndjson' }),
                expectedUrl: 'http://127.0.0.1:11434/api/generate',
                expectedStreamField: true,
                expectedModel: 'qwen-writer',
                expectedFinishReason: 'length',
                expectedUsage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
            },
            {
                protocol: 'llamacpp-completion',
                settings: { baseUrl: 'http://127.0.0.1:8080', model: 'writer.gguf' },
                response: fragmentedStreamResponse(sse(
                    { model: 'writer.gguf', content: 'Star' },
                    { content: ' gate' },
                    { content: '', stop: true, stop_type: 'eos' },
                )),
                expectedUrl: 'http://127.0.0.1:8080/completion',
                expectedStreamField: true,
                expectedModel: 'writer.gguf',
                expectedFinishReason: 'eos',
            },
        ];

        for (const item of cases) {
            const providerSettings = settings(item.protocol, item.settings);
            const { outbound, deltas, result } = await capture(
                providerSettings,
                generation(providerSettings),
                item.response,
            );
            assert.equal(outbound.url, item.expectedUrl, item.protocol);
            assert.equal('stream' in outbound.body, item.expectedStreamField, item.protocol);
            if (item.expectedStreamField) assert.equal(outbound.body.stream, true, item.protocol);
            assert.deepEqual(deltas, ['Star', ' gate'], item.protocol);
            assert.equal(result.content, 'Star gate', item.protocol);
            assert.equal(result.model, item.expectedModel, item.protocol);
            assert.equal(result.finishReason, item.expectedFinishReason, item.protocol);
            assert.deepEqual(result.usage, item.expectedUsage, item.protocol);
        }
    });

    test('external AbortSignal cancels the upstream body and remains distinguishable from timeout', async () => {
        const providerSettings = settings('openai-chat');
        const controller = new AbortController();
        let fetchSignal;
        let bodyCancelled = false;
        const firstEvent = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        const response = new Response(new ReadableStream({
            start(streamController) {
                streamController.enqueue(firstEvent);
            },
            cancel() {
                bodyCancelled = true;
            },
        }), { headers: { 'Content-Type': 'text/event-stream' } });

        await assert.rejects(() => createStreamingCompletion(
            providerSettings,
            generation(providerSettings),
            {
                signal: controller.signal,
                fetchImplementation: async (_url, options) => {
                    fetchSignal = options.signal;
                    return response;
                },
                onDelta() {
                    controller.abort();
                },
            },
        ), error => error?.name === 'AbortError');

        assert.equal(fetchSignal.aborted, true);
        assert.equal(bodyCancelled, true);
    });

    test('external abort while waiting for the next body chunk never accepts partial content', async () => {
        const providerSettings = settings('openai-chat');
        const controller = new AbortController();
        let fetchSignal;
        let bodyCancelled = false;
        let abortTimer;
        const firstEvent = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        const response = new Response(new ReadableStream({
            start(streamController) {
                streamController.enqueue(firstEvent);
            },
            cancel() {
                bodyCancelled = true;
            },
        }), { headers: { 'Content-Type': 'text/event-stream' } });

        await assert.rejects(() => createStreamingCompletion(
            providerSettings,
            generation(providerSettings),
            {
                signal: controller.signal,
                fetchImplementation: async (_url, options) => {
                    fetchSignal = options.signal;
                    return response;
                },
                onDelta() {
                    abortTimer ??= setTimeout(() => controller.abort(), 0);
                },
            },
        ), error => error?.name === 'AbortError');

        clearTimeout(abortTimer);
        assert.equal(fetchSignal.aborted, true);
        assert.equal(bodyCancelled, true);
    });

    test('timeout while waiting for the next body chunk rejects instead of accepting partial content', async () => {
        const providerSettings = settings('openai-chat');
        let fetchSignal;
        let bodyCancelled = false;
        const firstEvent = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        const response = new Response(new ReadableStream({
            start(streamController) {
                streamController.enqueue(firstEvent);
            },
            cancel() {
                bodyCancelled = true;
            },
        }), { headers: { 'Content-Type': 'text/event-stream' } });

        await assert.rejects(() => createStreamingCompletion(
            providerSettings,
            generation(providerSettings),
            {
                timeoutMs: 20,
                fetchImplementation: async (_url, options) => {
                    fetchSignal = options.signal;
                    return response;
                },
            },
        ), error => error?.code === 'provider_timeout' && error?.status === 504);

        assert.equal(fetchSignal.aborted, true);
        assert.equal(bodyCancelled, true);
    });

    test('rejects an oversized Content-Length before reading and cancels the upstream body', async () => {
        const providerSettings = settings('openai-chat');
        const { response, state } = controlledStreamResponse([], {
            headers: {
                'Content-Length': String(PROVIDER_RESPONSE_LIMITS.streamBytes + 1),
            },
        });

        await expectResponseTooLarge(providerSettings, response, {
            limit: 'stream body',
            maximum: PROVIDER_RESPONSE_LIMITS.streamBytes,
        });

        assert.equal(state.cancelled, true);
    });

    test('rejects a no-newline stream over the per-line limit and cancels its reader', async () => {
        const providerSettings = settings('openai-chat');
        const oversizedLine = new Uint8Array(PROVIDER_RESPONSE_LIMITS.streamLineBytes + 1);
        oversizedLine.fill(0x61);
        const { response, state } = controlledStreamResponse([oversizedLine]);

        await expectResponseTooLarge(providerSettings, response, {
            limit: 'stream line',
            maximum: PROVIDER_RESPONSE_LIMITS.streamLineBytes,
        });

        assert.equal(state.cancelled, true);
    });

    test('rejects total stream bytes even when every SSE comment line is bounded', async () => {
        const providerSettings = settings('openai-chat');
        const chunkBytes = 1024 * 1024;
        const commentChunk = new TextEncoder().encode(`:${'x'.repeat(chunkBytes - 2)}\n`);
        const chunks = Array.from({
            length: Math.floor(PROVIDER_RESPONSE_LIMITS.streamBytes / chunkBytes) + 1,
        }, () => commentChunk);
        const { response, state } = controlledStreamResponse(chunks);

        await expectResponseTooLarge(providerSettings, response, {
            limit: 'stream body',
            maximum: PROVIDER_RESPONSE_LIMITS.streamBytes,
        });

        assert.equal(state.cancelled, true);
    });

    test('rejects one oversized multi-line SSE event and cancels its reader', async () => {
        const providerSettings = settings('openai-chat');
        const eventPart = 'x'.repeat(1024 * 1024);
        const chunks = Array.from({ length: 8 }, () => `data: ${eventPart}\n`);
        const { response, state } = controlledStreamResponse(chunks);

        await expectResponseTooLarge(providerSettings, response, {
            limit: 'stream event',
            maximum: PROVIDER_RESPONSE_LIMITS.streamEventBytes,
        });

        assert.equal(state.cancelled, true);
    });

    test('bounds oversized error bodies for streaming and non-streaming requests', async () => {
        const providerSettings = settings('openai-chat');
        const errorBody = new Uint8Array(PROVIDER_RESPONSE_LIMITS.errorBytes + 1);
        errorBody.fill(0x78);

        for (const streaming of [true, false]) {
            const { response, state } = controlledStreamResponse([errorBody], {
                contentType: 'application/json',
                status: 500,
            });

            await expectResponseTooLarge(providerSettings, response, {
                limit: 'error body',
                maximum: PROVIDER_RESPONSE_LIMITS.errorBytes,
                streaming,
            });

            assert.equal(state.cancelled, true);
        }
    });

    test('rejects oversized non-stream JSON and cancels its reader', async () => {
        const providerSettings = settings('openai-chat');
        const payload = JSON.stringify({
            choices: [{
                message: {
                    content: 'x'.repeat(PROVIDER_RESPONSE_LIMITS.jsonBytes),
                },
            }],
        });
        const { response, state } = controlledStreamResponse([payload], {
            contentType: 'application/json',
        });

        await expectResponseTooLarge(providerSettings, response, {
            limit: 'JSON body',
            maximum: PROVIDER_RESPONSE_LIMITS.jsonBytes,
            streaming: false,
        });

        assert.equal(state.cancelled, true);
    });

    test('rejects oversized generated content in streaming and non-streaming responses', async () => {
        const providerSettings = settings('openai-chat');
        const content = 'x'.repeat(PROVIDER_RESPONSE_LIMITS.contentCharacters + 1);
        const streamed = controlledStreamResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        ]);
        const deltas = [];

        await expectResponseTooLarge(providerSettings, streamed.response, {
            limit: 'generated content',
            maximum: PROVIDER_RESPONSE_LIMITS.contentCharacters,
            onDelta: delta => deltas.push(delta),
        });

        assert.deepEqual(deltas, []);
        assert.equal(streamed.state.cancelled, true);

        const nonStreaming = controlledStreamResponse([
            JSON.stringify({ choices: [{ message: { content } }] }),
        ], {
            close: true,
            contentType: 'application/json',
        });

        await expectResponseTooLarge(providerSettings, nonStreaming.response, {
            limit: 'generated content',
            maximum: PROVIDER_RESPONSE_LIMITS.contentCharacters,
            streaming: false,
        });
    });

    test('maps the internal streaming deadline to provider_timeout', async () => {
        const providerSettings = settings('openai-chat');
        await assert.rejects(() => createStreamingCompletion(
            providerSettings,
            generation(providerSettings),
            {
                timeoutMs: 10,
                fetchImplementation: async (_url, options) => new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
            },
        ), error => error?.code === 'provider_timeout' && error?.status === 504);
    });
});
