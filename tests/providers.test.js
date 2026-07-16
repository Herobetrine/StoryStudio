import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
    createChatCompletion,
    createStreamingCompletion,
    getProviderAdapterDiagnostics,
    normalizeGenerationRequest,
    testProvider,
} from '../src/openai-provider.js';
import {
    DEFAULT_PROVIDER_SETTINGS,
    PROVIDER_PROTOCOLS,
    ProviderConfigError,
    ProviderStore,
} from '../src/provider-store.js';

const temporaryDirectories = [];

function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-provider-'));
    temporaryDirectories.push(directory);
    return directory;
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

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
        stop: ['END', 'STOP'],
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
        responseSchema: {
            name: 'scene_result',
            description: 'Structured scene result',
            value: {
                type: 'object',
                properties: { scene: { type: 'string' } },
                required: ['scene'],
            },
        },
        ...overrides,
    }, providerSettings);
}

async function captureGeneration(providerSettings, requestBody, responseBody) {
    let outbound;
    const result = await createChatCompletion(providerSettings, requestBody, {
        fetchImplementation: async (url, options) => {
            outbound = { url, options, body: JSON.parse(options.body) };
            return jsonResponse(responseBody);
        },
    });
    return {
        outbound,
        result,
        diagnostics: getProviderAdapterDiagnostics(providerSettings, requestBody),
    };
}

function extendedGeneration(providerSettings, overrides = {}) {
    return generation(providerSettings, {
        messages: [
            { role: 'system', content: 'Ordered system.' },
            { role: 'user', content: 'First request.' },
            { role: 'assistant', content: 'Earlier answer.' },
            { role: 'user', content: 'Continue now.' },
        ],
        topA: 0.25,
        minP: 0.08,
        frequencyPenalty: 0.4,
        presencePenalty: -0.2,
        repetitionPenalty: 1.12,
        seed: 31_415,
        assistantPrefill: 'PREFILL:',
        ...overrides,
    });
}

function droppedFields(diagnostics) {
    return diagnostics.droppedParameters.map(item => item.field);
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return server.address().port;
}

async function closeServer(server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
}

afterEach(() => {
    while (temporaryDirectories.length > 0) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe('provider configuration protocols', () => {
    test('publishes the supported protocol enum and defaults old settings to OpenAI chat', () => {
        assert.deepEqual(PROVIDER_PROTOCOLS, [
            'openai-chat',
            'anthropic-messages',
            'google-generate-content',
            'openai-completions',
            'ollama-generate',
            'llamacpp-completion',
        ]);

        const dataRoot = temporaryDirectory();
        fs.writeFileSync(path.join(dataRoot, 'provider.json'), JSON.stringify({
            baseUrl: 'https://legacy.example/v1',
            model: 'legacy-model',
            temperature: 0.4,
            contextTokens: 16_384,
            maxTokens: 2_048,
            jsonSchema: true,
        }));
        fs.writeFileSync(path.join(dataRoot, 'secrets.json'), JSON.stringify({ apiKey: 'legacy-secret' }));

        const store = new ProviderStore(dataRoot);
        assert.equal(store.getResolved().protocol, 'openai-chat');
        assert.equal(store.getResolved().apiKey, 'legacy-secret');

        store.update({ model: 'migrated-model' });
        const persistedConfig = JSON.parse(fs.readFileSync(path.join(dataRoot, 'provider.json'), 'utf8'));
        const persistedSecrets = JSON.parse(fs.readFileSync(path.join(dataRoot, 'secrets.json'), 'utf8'));
        assert.equal(persistedConfig.protocol, 'openai-chat');
        assert.equal(persistedSecrets.origin, 'https://legacy.example');
        assert.equal(persistedSecrets.protocol, 'openai-chat');
        assert.equal(persistedSecrets.apiKey, 'legacy-secret');
    });

    test('validates sampling settings and clears omitted keys across origin or protocol changes', () => {
        const store = new ProviderStore(temporaryDirectory());
        assert.throws(() => store.update({ protocol: 'unknown' }), ProviderConfigError);
        assert.throws(() => store.update({ topP: 1.1 }), ProviderConfigError);
        assert.throws(() => store.update({ topK: -1 }), ProviderConfigError);
        assert.throws(() => store.update({ stop: [''] }), ProviderConfigError);

        store.update({
            baseUrl: 'https://shared.example/v1',
            protocol: 'openai-chat',
            model: 'writer-model',
            apiKey: 'openai-secret',
            topP: 0.8,
            topK: 40,
            stop: ['END'],
        });
        assert.equal(store.resolve({ baseUrl: 'https://shared.example/v2' }).apiKey, 'openai-secret');
        assert.equal(store.resolve({ protocol: 'anthropic-messages' }).apiKey, '');

        store.update({ protocol: 'anthropic-messages', apiKey: 'anthropic-secret' });
        assert.equal(store.getResolved().apiKey, 'anthropic-secret');
        assert.equal(store.resolve({ baseUrl: 'https://other.example/v1' }).apiKey, '');
        assert.deepEqual(store.getPublic().stop, ['END']);
    });
});

describe('provider protocol request and response adapters', () => {
    test('keeps the legacy direct createChatCompletion request shape working', async () => {
        const providerSettings = settings('openai-chat', { topP: 0.9, topK: 0, stop: [] });
        let outbound;
        const result = await createChatCompletion(providerSettings, {
            prompt: 'Legacy direct request.',
            systemPrompt: '',
            responseLength: 256,
            minimumResponseLength: 1,
            responseSchema: null,
        }, {
            fetchImplementation: async (_url, options) => {
                outbound = JSON.parse(options.body);
                return jsonResponse({ choices: [{ message: { content: 'OK' } }] });
            },
        });

        assert.equal(result.content, 'OK');
        assert.equal(outbound.top_p, 0.9);
        assert.equal('stop' in outbound, false);
    });

    test('rejects redirects before Anthropic or Gemini keys reach a second origin', async () => {
        const redirectedHeaders = [];
        let secondOriginRequests = 0;
        const secondOrigin = http.createServer((_request, response) => {
            secondOriginRequests += 1;
            response.end('unexpected');
        });
        const secondPort = await listen(secondOrigin);
        const redirectingOrigin = http.createServer((request, response) => {
            redirectedHeaders.push(request.headers);
            response.writeHead(302, {
                Connection: 'close',
                Location: `http://127.0.0.1:${secondPort}/capture`,
            });
            response.end();
        });
        const redirectPort = await listen(redirectingOrigin);

        try {
            const anthropicSettings = settings('anthropic-messages', {
                baseUrl: `http://127.0.0.1:${redirectPort}/v1`,
            });
            await assert.rejects(
                createChatCompletion(anthropicSettings, generation(anthropicSettings)),
                error => error?.code === 'provider_redirect_rejected'
                    && error?.status === 502
                    && error?.details?.upstreamStatus === 302,
            );

            const googleSettings = settings('google-generate-content', {
                baseUrl: `http://127.0.0.1:${redirectPort}/v1beta`,
                model: 'gemini-writer',
            });
            await assert.rejects(
                createStreamingCompletion(googleSettings, generation(googleSettings)),
                error => error?.code === 'provider_redirect_rejected'
                    && error?.status === 502
                    && error?.details?.upstreamStatus === 302,
            );

            assert.equal(redirectedHeaders.length, 2);
            assert.equal(redirectedHeaders[0]['x-api-key'], 'provider-secret');
            assert.equal(redirectedHeaders[0]['x-goog-api-key'], undefined);
            assert.equal(redirectedHeaders[1]['x-goog-api-key'], 'provider-secret');
            assert.equal(redirectedHeaders[1]['x-api-key'], undefined);
            assert.equal(secondOriginRequests, 0);
        } finally {
            await closeServer(redirectingOrigin);
            await closeServer(secondOrigin);
        }
    });

    test('propagates an external AbortSignal through non-streaming Provider requests', async () => {
        const providerSettings = settings('openai-chat');
        const controller = new AbortController();
        let fetchSignal;
        let started;
        const began = new Promise(resolve => { started = resolve; });
        const completion = createChatCompletion(providerSettings, generation(providerSettings), {
            signal: controller.signal,
            fetchImplementation: async (_url, options) => {
                fetchSignal = options.signal;
                started();
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
            },
        });
        await began;
        controller.abort(new DOMException('Stopped by workflow.', 'AbortError'));
        await assert.rejects(completion, error => error?.name === 'AbortError'
            && error?.message === 'Stopped by workflow.');
        assert.equal(fetchSignal.aborted, true);
    });

    test('keeps the non-streaming internal deadline distinct from external cancellation', async () => {
        const providerSettings = settings('openai-chat');
        await assert.rejects(
            createChatCompletion(providerSettings, generation(providerSettings), {
                timeoutMs: 10,
                fetchImplementation: async (_url, options) => new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
            }),
            error => error?.code === 'provider_timeout' && error?.status === 504,
        );
    });

    test('maps OpenAI Chat Completions fields and omits unsupported top_k', async () => {
        const providerSettings = settings('openai-chat');
        const requestBody = generation(providerSettings, {
            topP: 0.7,
            topK: 99,
            stop: ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'],
        });
        const { outbound, result } = await captureGeneration(providerSettings, requestBody, {
            model: 'openai-result-model',
            choices: [{ message: { content: [{ text: '{"scene":"gate"}' }] } }],
            usage: { total_tokens: 22 },
        });

        assert.equal(outbound.url, 'https://provider.example/v1/chat/completions');
        assert.equal(outbound.options.redirect, 'manual');
        assert.equal(outbound.options.headers.Authorization, 'Bearer provider-secret');
        assert.equal(outbound.body.top_p, 0.7);
        assert.equal('top_k' in outbound.body, false);
        assert.deepEqual(outbound.body.stop, ['ONE', 'TWO', 'THREE', 'FOUR']);
        assert.equal(outbound.body.response_format.json_schema.name, 'scene_result');
        assert.equal(result.content, '{"scene":"gate"}');
        assert.equal(result.model, 'openai-result-model');
        assert.equal(result.usage.total_tokens, 22);
    });

    test('maps Anthropic Messages system, sampling, stops, and schema tool output', async () => {
        const providerSettings = settings('anthropic-messages', {
            baseUrl: 'https://api.anthropic.test/v1',
        });
        const { outbound, result } = await captureGeneration(providerSettings, generation(providerSettings), {
            model: 'claude-result-model',
            content: [{ type: 'tool_use', name: 'scene_result', input: { scene: 'gate' } }],
            usage: { input_tokens: 12, output_tokens: 8 },
        });

        assert.equal(outbound.url, 'https://api.anthropic.test/v1/messages');
        assert.equal(outbound.options.headers['x-api-key'], 'provider-secret');
        assert.equal(outbound.options.headers['anthropic-version'], '2023-06-01');
        assert.equal(outbound.options.headers.Authorization, undefined);
        assert.equal(outbound.body.system, 'Follow the story bible.');
        assert.deepEqual(outbound.body.messages, [{ role: 'user', content: 'Write the next scene.' }]);
        assert.equal(outbound.body.max_tokens, 1_024);
        assert.equal(outbound.body.top_p, 0.85);
        assert.equal(outbound.body.top_k, 42);
        assert.deepEqual(outbound.body.stop_sequences, ['END', 'STOP']);
        assert.equal(outbound.body.tools[0].input_schema.type, 'object');
        assert.deepEqual(outbound.body.tool_choice, { type: 'tool', name: 'scene_result' });
        assert.equal(result.content, '{"scene":"gate"}');
        assert.equal(result.usage.output_tokens, 8);
    });

    test('maps Google GenerateContent fields and joins candidate text parts', async () => {
        const providerSettings = settings('google-generate-content', {
            baseUrl: 'https://generativelanguage.test/v1beta',
            model: 'gemini-writer',
        });
        const { outbound, result } = await captureGeneration(providerSettings, generation(providerSettings), {
            modelVersion: 'gemini-writer-002',
            candidates: [{ content: { parts: [{ text: '{"scene":' }, { text: '"gate"}' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        });

        assert.equal(outbound.url, 'https://generativelanguage.test/v1beta/models/gemini-writer:generateContent');
        assert.equal(outbound.options.headers['x-goog-api-key'], 'provider-secret');
        assert.equal(outbound.options.headers.Authorization, undefined);
        assert.deepEqual(outbound.body.systemInstruction, { parts: [{ text: 'Follow the story bible.' }] });
        assert.deepEqual(outbound.body.contents, [{ role: 'user', parts: [{ text: 'Write the next scene.' }] }]);
        assert.equal(outbound.body.generationConfig.maxOutputTokens, 1_024);
        assert.equal(outbound.body.generationConfig.topP, 0.85);
        assert.equal(outbound.body.generationConfig.topK, 42);
        assert.deepEqual(outbound.body.generationConfig.stopSequences, ['END', 'STOP']);
        assert.equal(outbound.body.generationConfig.responseMimeType, 'application/json');
        assert.equal(outbound.body.generationConfig.responseSchema.type, 'object');
        assert.equal(result.content, '{"scene":"gate"}');
        assert.equal(result.model, 'gemini-writer-002');
        assert.equal(result.usage.totalTokenCount, 15);
    });

    test('maps OpenAI text completions without chat-only schema or top_k fields', async () => {
        const providerSettings = settings('openai-completions');
        const { outbound, result } = await captureGeneration(providerSettings, generation(providerSettings), {
            model: 'completion-result-model',
            choices: [{ text: 'The gate opened.' }],
            usage: { total_tokens: 17 },
        });

        assert.equal(outbound.url, 'https://provider.example/v1/completions');
        assert.equal(outbound.body.prompt, 'System: Follow the story bible.\nUser: Write the next scene.\nAssistant:');
        assert.equal(outbound.body.max_tokens, 1_024);
        assert.equal(outbound.body.top_p, 0.85);
        assert.deepEqual(outbound.body.stop, ['END', 'STOP']);
        assert.equal('top_k' in outbound.body, false);
        assert.equal('response_format' in outbound.body, false);
        assert.equal(result.content, 'The gate opened.');
    });

    test('maps Ollama generate options, native schema format, and token counts', async () => {
        const providerSettings = settings('ollama-generate', {
            baseUrl: 'http://127.0.0.1:11434',
            model: 'qwen-writer',
        });
        const { outbound, result } = await captureGeneration(providerSettings, generation(providerSettings), {
            model: 'qwen-writer',
            response: 'The gate opened.',
            prompt_eval_count: 11,
            eval_count: 7,
        });

        assert.equal(outbound.url, 'http://127.0.0.1:11434/api/generate');
        assert.equal(outbound.body.system, 'Follow the story bible.');
        assert.equal(outbound.body.prompt, 'Write the next scene.');
        assert.equal(outbound.body.stream, false);
        assert.equal(outbound.body.options.num_predict, 1_024);
        assert.equal(outbound.body.options.top_p, 0.85);
        assert.equal(outbound.body.options.top_k, 42);
        assert.deepEqual(outbound.body.options.stop, ['END', 'STOP']);
        assert.equal(outbound.body.format.type, 'object');
        assert.equal(result.content, 'The gate opened.');
        assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    test('maps llama.cpp completion fields and accepts native content', async () => {
        const providerSettings = settings('llamacpp-completion', {
            baseUrl: 'http://127.0.0.1:8080',
            model: 'local-writer.gguf',
        });
        const { outbound, result } = await captureGeneration(providerSettings, generation(providerSettings), {
            content: 'The gate opened.',
            model: 'local-writer.gguf',
        });

        assert.equal(outbound.url, 'http://127.0.0.1:8080/completion');
        assert.equal(outbound.body.prompt, 'System: Follow the story bible.\nUser: Write the next scene.\nAssistant:');
        assert.equal(outbound.body.n_predict, 1_024);
        assert.equal(outbound.body.top_p, 0.85);
        assert.equal(outbound.body.top_k, 42);
        assert.deepEqual(outbound.body.stop, ['END', 'STOP']);
        assert.equal(outbound.body.json_schema.type, 'object');
        assert.equal(outbound.body.stream, false);
        assert.equal(result.content, 'The gate opened.');
    });

    test('maps extended OpenAI Chat fields, preserves message order, and diagnoses unsupported controls', async () => {
        const providerSettings = settings('openai-chat');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            choices: [{ message: { content: 'continuation' } }],
        });

        assert.deepEqual(outbound.body.messages, requestBody.messages);
        assert.equal(outbound.body.frequency_penalty, 0.4);
        assert.equal(outbound.body.presence_penalty, -0.2);
        assert.equal(outbound.body.seed, 31_415);
        for (const field of ['top_k', 'top_a', 'min_p', 'repetition_penalty', 'assistant_prefill']) {
            assert.equal(field in outbound.body, false);
        }
        assert.deepEqual(droppedFields(diagnostics), [
            'topK', 'topA', 'minP', 'repetitionPenalty', 'assistantPrefill',
        ]);
        assert.equal(result.content, 'continuation');
        assert.equal(result.content.includes('PREFILL:'), false);
    });

    test('maps Anthropic ordered messages and safe assistant prefill while dropping unsupported sampling', async () => {
        const providerSettings = settings('anthropic-messages');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            content: [{ type: 'text', text: 'continuation' }],
        });

        assert.equal(outbound.body.system, 'Ordered system.');
        assert.deepEqual(outbound.body.messages, [
            { role: 'user', content: 'First request.' },
            { role: 'assistant', content: 'Earlier answer.' },
            { role: 'user', content: 'Continue now.' },
            { role: 'assistant', content: 'PREFILL:' },
        ]);
        for (const field of [
            'top_a', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed',
        ]) {
            assert.equal(field in outbound.body, false);
        }
        assert.deepEqual(droppedFields(diagnostics), [
            'topA', 'minP', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty', 'seed',
        ]);
        assert.equal(result.content, 'continuation');
        assert.equal(result.content.includes('PREFILL:'), false);
    });

    test('maps Gemini ordered messages and native penalties while diagnosing unsupported controls', async () => {
        const providerSettings = settings('google-generate-content');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            candidates: [{ content: { parts: [{ text: 'continuation' }] } }],
        });

        assert.deepEqual(outbound.body.systemInstruction, { parts: [{ text: 'Ordered system.' }] });
        assert.deepEqual(outbound.body.contents, [
            { role: 'user', parts: [{ text: 'First request.' }] },
            { role: 'model', parts: [{ text: 'Earlier answer.' }] },
            { role: 'user', parts: [{ text: 'Continue now.' }] },
        ]);
        assert.equal(outbound.body.generationConfig.frequencyPenalty, 0.4);
        assert.equal(outbound.body.generationConfig.presencePenalty, -0.2);
        assert.equal(outbound.body.generationConfig.seed, 31_415);
        for (const field of ['topA', 'minP', 'repetitionPenalty', 'assistantPrefill']) {
            assert.equal(field in outbound.body.generationConfig, false);
        }
        assert.deepEqual(droppedFields(diagnostics), [
            'topA', 'minP', 'repetitionPenalty', 'assistantPrefill',
        ]);
        assert.equal(result.content, 'continuation');
    });

    test('maps OpenAI text-completion controls and prefill but never sends structured messages', async () => {
        const providerSettings = settings('openai-completions');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            choices: [{ text: 'continuation' }],
        });

        assert.equal(outbound.body.prompt, [
            'System: Follow the story bible.',
            'User: Write the next scene.',
            'Assistant:PREFILL:',
        ].join('\n'));
        assert.equal(outbound.body.frequency_penalty, 0.4);
        assert.equal(outbound.body.presence_penalty, -0.2);
        assert.equal(outbound.body.seed, 31_415);
        assert.equal('messages' in outbound.body, false);
        assert.deepEqual(droppedFields(diagnostics), [
            'messages', 'topK', 'topA', 'minP', 'repetitionPenalty',
        ]);
        assert.equal(result.content, 'continuation');
        assert.equal(result.content.includes('PREFILL:'), false);
    });

    test('maps Ollama min-p and penalty options while dropping messages, top-a, and prefill', async () => {
        const providerSettings = settings('ollama-generate');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            response: 'continuation',
        });

        assert.equal(outbound.body.options.min_p, 0.08);
        assert.equal(outbound.body.options.frequency_penalty, 0.4);
        assert.equal(outbound.body.options.presence_penalty, -0.2);
        assert.equal(outbound.body.options.repeat_penalty, 1.12);
        assert.equal(outbound.body.options.seed, 31_415);
        assert.equal('messages' in outbound.body, false);
        assert.equal('top_a' in outbound.body.options, false);
        assert.equal(outbound.body.prompt.includes('PREFILL:'), false);
        assert.deepEqual(droppedFields(diagnostics), ['messages', 'topA', 'assistantPrefill']);
        assert.equal(result.content, 'continuation');
    });

    test('maps llama.cpp native controls and text prefill while dropping structured messages and top-a', async () => {
        const providerSettings = settings('llamacpp-completion');
        const requestBody = extendedGeneration(providerSettings);
        const { outbound, result, diagnostics } = await captureGeneration(providerSettings, requestBody, {
            content: 'continuation',
        });

        assert.equal(outbound.body.min_p, 0.08);
        assert.equal(outbound.body.frequency_penalty, 0.4);
        assert.equal(outbound.body.presence_penalty, -0.2);
        assert.equal(outbound.body.repeat_penalty, 1.12);
        assert.equal(outbound.body.seed, 31_415);
        assert.equal(outbound.body.prompt.endsWith('Assistant:PREFILL:'), true);
        assert.equal('messages' in outbound.body, false);
        assert.equal('top_a' in outbound.body, false);
        assert.deepEqual(droppedFields(diagnostics), ['messages', 'topA']);
        assert.equal(result.content, 'continuation');
        assert.equal(result.content.includes('PREFILL:'), false);
    });

    test('normalizes extended wire parameters and rejects invalid values and messages', () => {
        const providerSettings = settings('openai-chat');
        const normalized = extendedGeneration(providerSettings);
        assert.equal(normalized.topA, 0.25);
        assert.equal(normalized.minP, 0.08);
        assert.equal(normalized.frequencyPenalty, 0.4);
        assert.equal(normalized.presencePenalty, -0.2);
        assert.equal(normalized.repetitionPenalty, 1.12);
        assert.equal(normalized.seed, 31_415);
        assert.equal(normalized.assistantPrefill, 'PREFILL:');
        assert.equal(normalized.messages.length, 4);

        assert.throws(() => generation(providerSettings, { minP: 1.1 }), /minP/);
        assert.throws(() => generation(providerSettings, { seed: 1.5 }), /seed/);
        assert.throws(() => generation(providerSettings, {
            messages: [{ role: 'tool', content: 'unsafe' }],
        }), /role/);
        const messageOnly = normalizeGenerationRequest({
            messages: [{ role: 'user', content: 'Message-only request.' }],
            responseLength: 32,
        }, providerSettings);
        assert.equal(messageOnly.prompt, '');
        assert.deepEqual(messageOnly.messages, [{ role: 'user', content: 'Message-only request.' }]);
        assert.throws(() => normalizeGenerationRequest({
            messages: [{ role: 'user', content: 'Cannot be serialized implicitly.' }],
            responseLength: 32,
        }, settings('openai-completions')), /prompt/);
    });

    test('uses the configured protocol for connection tests', async () => {
        const providerSettings = settings('anthropic-messages', {
            baseUrl: 'https://api.anthropic.test/v1/messages',
            model: 'claude-test',
        });
        let outbound;
        const result = await testProvider(providerSettings, {
            fetchImplementation: async (url, options) => {
                outbound = { url, body: JSON.parse(options.body) };
                return jsonResponse({ model: 'claude-test', content: [{ type: 'text', text: 'OK' }] });
            },
        });

        assert.deepEqual(result, { ok: true, message: 'Provider connection succeeded.', model: 'claude-test' });
        assert.equal(outbound.url, 'https://api.anthropic.test/v1/messages');
        assert.deepEqual(outbound.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
        assert.equal(outbound.body.max_tokens, 8);
    });
});
