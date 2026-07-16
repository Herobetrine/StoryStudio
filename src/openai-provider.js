import { ApiError } from './api-error.js';

const GENERATE_FIELDS = [
    'prompt',
    'responseSchema',
    'systemPrompt',
    'responseLength',
    'minimumResponseLength',
    'jsonSchema',
    'stop',
    'temperature',
    'topP',
    'topK',
    'messages',
    'topA',
    'minP',
    'frequencyPenalty',
    'presencePenalty',
    'repetitionPenalty',
    'seed',
    'assistantPrefill',
];
const MAX_GENERATION_PROMPT_CHARACTERS = 1_000_000;

export const PROVIDER_RESPONSE_LIMITS = Object.freeze({
    streamBytes: 16 * 1024 * 1024,
    streamLineBytes: 8 * 1024 * 1024,
    streamEventBytes: 8 * 1024 * 1024,
    jsonBytes: 16 * 1024 * 1024,
    errorBytes: 64 * 1024,
    contentCharacters: 5_000_000,
});

const UNSUPPORTED_PARAMETER = null;
const PARAMETER_FIELDS = [
    'messages',
    'temperature',
    'topP',
    'topK',
    'topA',
    'minP',
    'frequencyPenalty',
    'presencePenalty',
    'repetitionPenalty',
    'seed',
    'assistantPrefill',
    'stop',
];

export const PROVIDER_PARAMETER_CAPABILITIES = Object.freeze({
    'openai-chat': Object.freeze({
        messages: 'messages',
        temperature: 'temperature',
        topP: 'top_p',
        topK: UNSUPPORTED_PARAMETER,
        topA: UNSUPPORTED_PARAMETER,
        minP: UNSUPPORTED_PARAMETER,
        frequencyPenalty: 'frequency_penalty',
        presencePenalty: 'presence_penalty',
        repetitionPenalty: UNSUPPORTED_PARAMETER,
        seed: 'seed',
        assistantPrefill: UNSUPPORTED_PARAMETER,
        stop: 'stop',
    }),
    'anthropic-messages': Object.freeze({
        messages: 'messages',
        temperature: 'temperature',
        topP: 'top_p',
        topK: 'top_k',
        topA: UNSUPPORTED_PARAMETER,
        minP: UNSUPPORTED_PARAMETER,
        frequencyPenalty: UNSUPPORTED_PARAMETER,
        presencePenalty: UNSUPPORTED_PARAMETER,
        repetitionPenalty: UNSUPPORTED_PARAMETER,
        seed: UNSUPPORTED_PARAMETER,
        assistantPrefill: 'messages[assistant]',
        stop: 'stop_sequences',
    }),
    'google-generate-content': Object.freeze({
        messages: 'contents',
        temperature: 'generationConfig.temperature',
        topP: 'generationConfig.topP',
        topK: 'generationConfig.topK',
        topA: UNSUPPORTED_PARAMETER,
        minP: UNSUPPORTED_PARAMETER,
        frequencyPenalty: 'generationConfig.frequencyPenalty',
        presencePenalty: 'generationConfig.presencePenalty',
        repetitionPenalty: UNSUPPORTED_PARAMETER,
        seed: 'generationConfig.seed',
        assistantPrefill: UNSUPPORTED_PARAMETER,
        stop: 'generationConfig.stopSequences',
    }),
    'openai-completions': Object.freeze({
        messages: UNSUPPORTED_PARAMETER,
        temperature: 'temperature',
        topP: 'top_p',
        topK: UNSUPPORTED_PARAMETER,
        topA: UNSUPPORTED_PARAMETER,
        minP: UNSUPPORTED_PARAMETER,
        frequencyPenalty: 'frequency_penalty',
        presencePenalty: 'presence_penalty',
        repetitionPenalty: UNSUPPORTED_PARAMETER,
        seed: 'seed',
        assistantPrefill: 'prompt',
        stop: 'stop',
    }),
    'ollama-generate': Object.freeze({
        messages: UNSUPPORTED_PARAMETER,
        temperature: 'options.temperature',
        topP: 'options.top_p',
        topK: 'options.top_k',
        topA: UNSUPPORTED_PARAMETER,
        minP: 'options.min_p',
        frequencyPenalty: 'options.frequency_penalty',
        presencePenalty: 'options.presence_penalty',
        repetitionPenalty: 'options.repeat_penalty',
        seed: 'options.seed',
        assistantPrefill: UNSUPPORTED_PARAMETER,
        stop: 'options.stop',
    }),
    'llamacpp-completion': Object.freeze({
        messages: UNSUPPORTED_PARAMETER,
        temperature: 'temperature',
        topP: 'top_p',
        topK: 'top_k',
        topA: UNSUPPORTED_PARAMETER,
        minP: 'min_p',
        frequencyPenalty: 'frequency_penalty',
        presencePenalty: 'presence_penalty',
        repetitionPenalty: 'repeat_penalty',
        seed: 'seed',
        assistantPrefill: 'prompt',
        stop: 'stop',
    }),
});

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, 'invalid_request', `${label} must be a JSON object.`);
    }
}

function assertKnownFields(value, fields, label) {
    const unknown = Object.keys(value).filter(key => !fields.includes(key));
    if (unknown.length > 0) {
        throw new ApiError(400, 'unknown_fields', `${label} contains unknown fields.`, { fields: unknown });
    }
}

function cleanString(value, label, maximum, { required = false } = {}) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || (required && value.length === 0)) {
        throw new ApiError(400, 'invalid_request', `${label} must be ${required ? 'a non-empty' : 'a'} string.`);
    }
    if (value.length > maximum) {
        throw new ApiError(413, 'payload_too_large', `${label} is too long.`, { field: label, maximum });
    }
    return value;
}

function cleanTokenCount(value, label, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 200_000) {
        throw new ApiError(400, 'invalid_request', `${label} must be an integer between 1 and 200000.`);
    }
    return value;
}

function cleanTopP(value, fallback = 1) {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
        throw new ApiError(400, 'invalid_request', 'topP must be a number between 0 and 1.');
    }
    return resolved;
}

function cleanTemperature(value, fallback = 1) {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || resolved > 2) {
        throw new ApiError(400, 'invalid_request', 'temperature must be a number between 0 and 2.');
    }
    return resolved;
}

function cleanTopK(value, fallback = 0) {
    const resolved = value === undefined ? fallback : value;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved > 100_000) {
        throw new ApiError(400, 'invalid_request', 'topK must be an integer between 0 and 100000.');
    }
    return resolved;
}

function cleanOptionalNumber(value, label, minimum, maximum, { integer = false } = {}) {
    if (value === undefined) return undefined;
    const validNumber = typeof value === 'number' && Number.isFinite(value);
    if (!validNumber || (integer && !Number.isInteger(value)) || value < minimum || value > maximum) {
        throw new ApiError(
            400,
            'invalid_request',
            `${label} must be ${integer ? 'an integer' : 'a number'} between ${minimum} and ${maximum}.`,
        );
    }
    return value;
}

function cleanStop(value, fallback = []) {
    const resolved = value === undefined ? fallback : value;
    if (!Array.isArray(resolved) || resolved.length > 16
        || resolved.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1_000)) {
        throw new ApiError(400, 'invalid_request', 'stop must contain at most 16 non-empty strings of at most 1000 characters.');
    }
    return [...resolved];
}

function cleanMessages(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
        throw new ApiError(400, 'invalid_request', 'messages must contain between 1 and 500 entries.');
    }
    let totalCharacters = 0;
    return value.map((message, index) => {
        assertPlainObject(message, `messages[${index}]`);
        assertKnownFields(message, ['role', 'content'], `messages[${index}]`);
        if (!['system', 'user', 'assistant'].includes(message.role)) {
            throw new ApiError(400, 'invalid_request', `messages[${index}].role is invalid.`);
        }
        const content = cleanString(
            message.content,
            `messages[${index}].content`,
            MAX_GENERATION_PROMPT_CHARACTERS,
            { required: true },
        );
        totalCharacters += content.length;
        if (totalCharacters > MAX_GENERATION_PROMPT_CHARACTERS) {
            throw new ApiError(413, 'payload_too_large', 'messages are too long.', {
                field: 'messages',
                maximum: MAX_GENERATION_PROMPT_CHARACTERS,
            });
        }
        return { role: message.role, content };
    });
}

function serializedLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        throw new ApiError(400, 'invalid_response_schema', 'The response schema must be JSON-serializable.');
    }
}

function normalizeSchema(value) {
    if (value === undefined || value === null) return null;
    assertPlainObject(value, 'Response schema');
    if (serializedLength(value) > 1_000_000) {
        throw new ApiError(413, 'payload_too_large', 'The response schema is too large.', { maximum: 1_000_000 });
    }

    if ('value' in value || 'schema' in value) {
        const allowed = ['name', 'description', 'value', 'schema', 'strict'];
        assertKnownFields(value, allowed, 'Response schema');
        const schema = value.value ?? value.schema;
        assertPlainObject(schema, 'Response schema value');
        const name = value.name === undefined ? 'story_studio_response' : value.name;
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
            throw new ApiError(400, 'invalid_response_schema', 'Response schema name is invalid.');
        }
        if (value.strict !== undefined && typeof value.strict !== 'boolean') {
            throw new ApiError(400, 'invalid_response_schema', 'Response schema strict must be a boolean.');
        }
        if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1_000)) {
            throw new ApiError(400, 'invalid_response_schema', 'Response schema description must be a string no longer than 1000 characters.');
        }
        return {
            name,
            ...(value.description ? { description: value.description } : {}),
            schema,
            strict: value.strict ?? true,
        };
    }

    return { name: 'story_studio_response', schema: value, strict: true };
}

export function normalizeGenerationRequest(body, providerSettings) {
    assertPlainObject(body, 'Generation request');
    assertKnownFields(body, GENERATE_FIELDS, 'Generation request');
    if (body.responseSchema !== undefined && body.jsonSchema !== undefined) {
        throw new ApiError(400, 'invalid_response_schema', 'Use either responseSchema or jsonSchema, not both.');
    }

    const messages = cleanMessages(body.messages);
    const protocol = providerSettings.protocol ?? 'openai-chat';
    const supportsMessages = Boolean(PROVIDER_PARAMETER_CAPABILITIES[protocol]?.messages);
    const prompt = cleanString(body.prompt, 'prompt', MAX_GENERATION_PROMPT_CHARACTERS, {
        required: messages === undefined || !supportsMessages,
    });
    const systemPrompt = cleanString(body.systemPrompt, 'systemPrompt', MAX_GENERATION_PROMPT_CHARACTERS);
    const requestedResponseLength = cleanTokenCount(body.responseLength, 'responseLength', providerSettings.maxTokens);
    const responseLength = Math.min(requestedResponseLength, providerSettings.maxTokens);
    const minimumResponseLength = cleanTokenCount(body.minimumResponseLength, 'minimumResponseLength', 1);
    if (minimumResponseLength > responseLength) {
        throw new ApiError(400, 'generation_budget_too_small', 'The provider output limit is below minimumResponseLength.', {
            minimumResponseLength,
            maximumOutputTokens: responseLength,
        });
    }

    const topA = cleanOptionalNumber(body.topA, 'topA', 0, 1);
    const minP = cleanOptionalNumber(body.minP, 'minP', 0, 1);
    const frequencyPenalty = cleanOptionalNumber(body.frequencyPenalty, 'frequencyPenalty', -2, 2);
    const presencePenalty = cleanOptionalNumber(body.presencePenalty, 'presencePenalty', -2, 2);
    const repetitionPenalty = cleanOptionalNumber(body.repetitionPenalty, 'repetitionPenalty', 0, 10);
    const seed = cleanOptionalNumber(body.seed, 'seed', -1, 2_147_483_647, { integer: true });
    const assistantPrefill = body.assistantPrefill === undefined
        ? undefined
        : cleanString(body.assistantPrefill, 'assistantPrefill', 100_000);

    return {
        prompt,
        ...(messages ? { messages } : {}),
        systemPrompt,
        responseLength,
        minimumResponseLength,
        responseSchema: normalizeSchema(body.jsonSchema ?? body.responseSchema),
        stop: cleanStop(body.stop, providerSettings.stop ?? []),
        temperature: cleanTemperature(body.temperature, providerSettings.temperature ?? 1),
        topP: cleanTopP(body.topP, providerSettings.topP ?? 1),
        topK: cleanTopK(body.topK, providerSettings.topK ?? 0),
        ...(topA !== undefined ? { topA } : {}),
        ...(minP !== undefined ? { minP } : {}),
        ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
        ...(presencePenalty !== undefined ? { presencePenalty } : {}),
        ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(assistantPrefill !== undefined ? { assistantPrefill } : {}),
    };
}

function isRequestedAdapterParameter(request, field) {
    if (request[field] === undefined || request[field] === null) return false;
    if (field === 'topK') return request.topK > 0;
    if (field === 'stop') return Array.isArray(request.stop) && request.stop.length > 0;
    if (field === 'assistantPrefill') {
        return typeof request.assistantPrefill === 'string' && request.assistantPrefill.length > 0;
    }
    return true;
}

export function getProviderAdapterDiagnostics(settings, request) {
    const protocol = settings.protocol ?? 'openai-chat';
    const capabilities = PROVIDER_PARAMETER_CAPABILITIES[protocol];
    if (!capabilities) {
        throw new ApiError(400, 'invalid_provider_settings', 'The configured provider protocol is not supported.');
    }
    const sentParameters = [];
    const droppedParameters = [];
    for (const field of PARAMETER_FIELDS) {
        if (!isRequestedAdapterParameter(request, field)) continue;
        if (capabilities[field]) {
            sentParameters.push(field);
        } else {
            droppedParameters.push({
                field,
                reason: `The ${protocol} protocol does not safely support this parameter.`,
            });
        }
    }
    return { protocol, sentParameters, droppedParameters };
}

function appendEndpoint(baseUrl, endpoint) {
    const normalized = baseUrl.replace(/\/$/, '');
    return normalized.endsWith(`/${endpoint}`) ? normalized : `${normalized}/${endpoint}`;
}

export function chatCompletionsUrl(baseUrl) {
    return appendEndpoint(baseUrl, 'chat/completions');
}

function googleGenerateContentUrl(baseUrl, model) {
    const normalized = baseUrl.replace(/\/$/, '');
    if (normalized.endsWith(':generateContent')) return normalized;
    if (/\/models\/[^/]+$/.test(normalized)) return `${normalized}:generateContent`;
    const modelId = String(model).replace(/^models\//, '');
    if (normalized.endsWith('/models')) {
        return `${normalized}/${encodeURIComponent(modelId)}:generateContent`;
    }
    return `${normalized}/models/${encodeURIComponent(modelId)}:generateContent`;
}

function googleStreamGenerateContentUrl(generateContentUrl) {
    const [withoutHash, hash = ''] = generateContentUrl.split('#', 2);
    const [pathname, query = ''] = withoutHash.split('?', 2);
    const streamPathname = pathname.replace(/:generateContent$/, ':streamGenerateContent');
    const search = new URLSearchParams(query);
    search.set('alt', 'sse');
    return `${streamPathname}?${search.toString()}${hash ? `#${hash}` : ''}`;
}

function ollamaGenerateUrl(baseUrl) {
    const normalized = baseUrl.replace(/\/$/, '');
    if (normalized.endsWith('/api/generate')) return normalized;
    if (normalized.endsWith('/api')) return `${normalized}/generate`;
    return `${normalized}/api/generate`;
}

function responseContent(messageContent) {
    if (typeof messageContent === 'string') return messageContent;
    if (!Array.isArray(messageContent)) return null;
    const parts = messageContent
        .map(part => typeof part === 'string' ? part : part?.text)
        .filter(part => typeof part === 'string');
    return parts.length > 0 ? parts.join('') : null;
}

function safeUpstreamMessage(payload, fallback) {
    const candidate = typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message ?? payload?.message;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate.slice(0, 1_000) : fallback;
}

function isUnsupportedSchema(status, message) {
    if (![400, 422].includes(status)) return false;
    const value = message.toLowerCase();
    const namesSchema = ['response_format', 'json_schema', 'json schema', 'structured output']
        .some(fragment => value.includes(fragment));
    const saysUnsupported = ['unsupported', 'not support', 'unknown', 'unrecognized', 'not permitted', 'extra inputs']
        .some(fragment => value.includes(fragment));
    return namesSchema && saysUnsupported;
}

function isUnsupportedMaxTokens(status, message) {
    if (![400, 422].includes(status)) return false;
    const value = message.toLowerCase();
    const namesField = value.includes('max_tokens');
    const saysUnsupported = ['unsupported', 'not support', 'unknown', 'unrecognized', 'max_completion_tokens']
        .some(fragment => value.includes(fragment));
    return namesField && saysUnsupported;
}

function jsonHeaders(settings, apiKeyHeader = 'Authorization') {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (!settings.apiKey) return headers;
    headers[apiKeyHeader] = apiKeyHeader === 'Authorization' ? `Bearer ${settings.apiKey}` : settings.apiKey;
    return headers;
}

function addStop(body, field, stop, limit = 16) {
    if (stop.length > 0) body[field] = stop.slice(0, limit);
}

function textCompletionPrompt(request) {
    const messages = [];
    if (request.systemPrompt) messages.push(`System: ${request.systemPrompt}`);
    messages.push(`User: ${request.prompt}`);
    messages.push(`Assistant:${request.assistantPrefill ?? ''}`);
    return messages.join('\n');
}

function chatMessages(request) {
    if (Array.isArray(request.messages)) {
        return request.messages.map(message => ({ ...message }));
    }
    const messages = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    return messages;
}

function appendAssistantPrefill(messages, prefill) {
    if (!prefill) return messages;
    const last = messages.at(-1);
    if (last?.role === 'assistant') {
        last.content += prefill;
    } else {
        messages.push({ role: 'assistant', content: prefill });
    }
    return messages;
}

function openAiChatAdapter(settings, request) {
    const messages = chatMessages(request);
    const body = {
        model: settings.model,
        messages,
        temperature: request.temperature,
        top_p: request.topP,
        max_tokens: request.responseLength,
    };
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.seed !== undefined) body.seed = request.seed;
    addStop(body, 'stop', request.stop, 4);
    if (request.responseSchema && settings.jsonSchema) {
        body.response_format = {
            type: 'json_schema',
            json_schema: request.responseSchema,
        };
    }
    return {
        url: chatCompletionsUrl(settings.baseUrl),
        headers: jsonHeaders(settings),
        body,
        parse(payload) {
            return {
                content: responseContent(payload?.choices?.[0]?.message?.content),
                model: payload?.model,
                usage: payload?.usage,
            };
        },
        openAiFallbacks: true,
    };
}

function anthropicAdapter(settings, request) {
    const sourceMessages = chatMessages(request);
    const system = sourceMessages
        .filter(message => message.role === 'system')
        .map(message => message.content)
        .join('\n\n');
    const messages = appendAssistantPrefill(
        sourceMessages.filter(message => message.role !== 'system'),
        request.assistantPrefill,
    );
    const body = {
        model: settings.model,
        messages,
        max_tokens: request.responseLength,
        temperature: request.temperature,
        top_p: request.topP,
    };
    if (system) body.system = system;
    if (request.topK > 0) body.top_k = request.topK;
    addStop(body, 'stop_sequences', request.stop);
    if (request.responseSchema && settings.jsonSchema) {
        body.tools = [{
            name: request.responseSchema.name,
            description: request.responseSchema.description || 'Well-formed JSON object',
            input_schema: request.responseSchema.schema,
        }];
        body.tool_choice = { type: 'tool', name: request.responseSchema.name };
    }
    return {
        url: appendEndpoint(settings.baseUrl, 'messages'),
        headers: {
            ...jsonHeaders(settings, 'x-api-key'),
            'anthropic-version': '2023-06-01',
        },
        body,
        parse(payload) {
            const blocks = Array.isArray(payload?.content) ? payload.content : [];
            const schemaTool = request.responseSchema
                ? blocks.find(block => block?.type === 'tool_use' && block?.name === request.responseSchema.name)
                : null;
            const textParts = blocks
                .filter(block => block?.type === 'text' && typeof block.text === 'string')
                .map(block => block.text);
            return {
                content: schemaTool?.input && typeof schemaTool.input === 'object'
                    ? JSON.stringify(schemaTool.input)
                    : textParts.length > 0 ? textParts.join('') : null,
                model: payload?.model,
                usage: payload?.usage,
            };
        },
    };
}

function googleAdapter(settings, request) {
    const sourceMessages = chatMessages(request);
    const system = sourceMessages
        .filter(message => message.role === 'system')
        .map(message => message.content)
        .join('\n\n');
    const generationConfig = {
        maxOutputTokens: request.responseLength,
        temperature: request.temperature,
        topP: request.topP,
    };
    if (request.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) generationConfig.presencePenalty = request.presencePenalty;
    if (request.seed !== undefined) generationConfig.seed = request.seed;
    if (request.topK > 0) generationConfig.topK = request.topK;
    addStop(generationConfig, 'stopSequences', request.stop, 5);
    if (request.responseSchema && settings.jsonSchema) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = request.responseSchema.schema;
    }
    const body = {
        contents: sourceMessages
            .filter(message => message.role !== 'system')
            .map(message => ({
                role: message.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: message.content }],
            })),
        generationConfig,
    };
    if (system) {
        body.systemInstruction = { parts: [{ text: system }] };
    }
    return {
        url: googleGenerateContentUrl(settings.baseUrl, settings.model),
        headers: jsonHeaders(settings, 'x-goog-api-key'),
        body,
        parse(payload) {
            const parts = payload?.candidates?.[0]?.content?.parts;
            const textParts = Array.isArray(parts)
                ? parts.map(part => part?.text).filter(text => typeof text === 'string')
                : [];
            return {
                content: textParts.length > 0 ? textParts.join('') : null,
                model: payload?.modelVersion,
                usage: payload?.usageMetadata,
            };
        },
    };
}

function openAiCompletionsAdapter(settings, request) {
    const body = {
        model: settings.model,
        prompt: textCompletionPrompt(request),
        temperature: request.temperature,
        top_p: request.topP,
        max_tokens: request.responseLength,
    };
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.seed !== undefined) body.seed = request.seed;
    addStop(body, 'stop', request.stop, 4);
    return {
        url: appendEndpoint(settings.baseUrl, 'completions'),
        headers: jsonHeaders(settings),
        body,
        parse(payload) {
            return {
                content: typeof payload?.choices?.[0]?.text === 'string' ? payload.choices[0].text : null,
                model: payload?.model,
                usage: payload?.usage,
            };
        },
    };
}

function ollamaAdapter(settings, request) {
    const options = {
        temperature: request.temperature,
        top_p: request.topP,
        num_predict: request.responseLength,
    };
    if (request.topK > 0) options.top_k = request.topK;
    if (request.minP !== undefined) options.min_p = request.minP;
    if (request.frequencyPenalty !== undefined) options.frequency_penalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) options.presence_penalty = request.presencePenalty;
    if (request.repetitionPenalty !== undefined) options.repeat_penalty = request.repetitionPenalty;
    if (request.seed !== undefined) options.seed = request.seed;
    addStop(options, 'stop', request.stop);
    const body = {
        model: settings.model,
        prompt: request.prompt,
        stream: false,
        options,
    };
    if (request.systemPrompt) body.system = request.systemPrompt;
    if (request.responseSchema && settings.jsonSchema) body.format = request.responseSchema.schema;
    return {
        url: ollamaGenerateUrl(settings.baseUrl),
        headers: jsonHeaders(settings),
        body,
        parse(payload) {
            const promptTokens = Number.isInteger(payload?.prompt_eval_count) ? payload.prompt_eval_count : null;
            const completionTokens = Number.isInteger(payload?.eval_count) ? payload.eval_count : null;
            const usage = promptTokens !== null || completionTokens !== null
                ? {
                    prompt_tokens: promptTokens ?? 0,
                    completion_tokens: completionTokens ?? 0,
                    total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
                }
                : payload?.usage;
            return {
                content: typeof payload?.response === 'string' ? payload.response : null,
                model: payload?.model,
                usage,
            };
        },
    };
}

function llamaCppAdapter(settings, request) {
    const body = {
        prompt: textCompletionPrompt(request),
        n_predict: request.responseLength,
        temperature: request.temperature,
        top_p: request.topP,
        stream: false,
    };
    if (request.topK > 0) body.top_k = request.topK;
    if (request.minP !== undefined) body.min_p = request.minP;
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.repetitionPenalty !== undefined) body.repeat_penalty = request.repetitionPenalty;
    if (request.seed !== undefined) body.seed = request.seed;
    addStop(body, 'stop', request.stop);
    if (request.responseSchema && settings.jsonSchema) body.json_schema = request.responseSchema.schema;
    return {
        url: appendEndpoint(settings.baseUrl, 'completion'),
        headers: jsonHeaders(settings),
        body,
        parse(payload) {
            return {
                content: typeof payload?.content === 'string'
                    ? payload.content
                    : typeof payload?.choices?.[0]?.text === 'string' ? payload.choices[0].text : null,
                model: payload?.model,
                usage: payload?.usage,
            };
        },
    };
}

function createAdapter(settings, request) {
    let adapter;
    switch (settings.protocol ?? 'openai-chat') {
        case 'openai-chat': adapter = openAiChatAdapter(settings, request); break;
        case 'anthropic-messages': adapter = anthropicAdapter(settings, request); break;
        case 'google-generate-content': adapter = googleAdapter(settings, request); break;
        case 'openai-completions': adapter = openAiCompletionsAdapter(settings, request); break;
        case 'ollama-generate': adapter = ollamaAdapter(settings, request); break;
        case 'llamacpp-completion': adapter = llamaCppAdapter(settings, request); break;
        default:
            throw new ApiError(400, 'invalid_provider_settings', 'The configured provider protocol is not supported.');
    }
    adapter.diagnostics = getProviderAdapterDiagnostics(settings, request);
    return adapter;
}

function configureStreamingAdapter(adapter, protocol) {
    if (protocol === 'google-generate-content') {
        adapter.url = googleStreamGenerateContentUrl(adapter.url);
    } else {
        adapter.body.stream = true;
    }
    adapter.headers = {
        ...adapter.headers,
        Accept: protocol === 'ollama-generate' ? 'application/x-ndjson' : 'text/event-stream',
    };
    return adapter;
}

function externalAbortError(signal) {
    if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') {
        return signal.reason;
    }
    return new DOMException('The operation was aborted.', 'AbortError');
}

function createAbortContext(timeoutMs, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    }, timeoutMs);
    timeout.unref?.();

    const abortFromExternal = () => controller.abort(externalAbortError(externalSignal));
    if (externalSignal?.aborted) {
        abortFromExternal();
    } else {
        externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    }

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        externallyAborted: () => Boolean(externalSignal?.aborted),
        abort: reason => controller.abort(reason),
        cleanup() {
            clearTimeout(timeout);
            externalSignal?.removeEventListener('abort', abortFromExternal);
        },
    };
}

function throwStreamingTransportError(error, abortContext, externalSignal) {
    if (abortContext.externallyAborted()) {
        throw externalAbortError(externalSignal);
    }
    if (abortContext.timedOut() || error?.name === 'TimeoutError') {
        throw new ApiError(504, 'provider_timeout', 'The model provider timed out.');
    }
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
        throw new ApiError(502, 'provider_unreachable', 'The model provider connection was interrupted.');
    }
    throw new ApiError(502, 'provider_unreachable', 'Could not reach the model provider.');
}

function providerResponseTooLarge(label, maximum) {
    return new ApiError(
        502,
        'provider_response_too_large',
        `The model provider ${label} exceeded the response size limit.`,
        { limit: label, maximum },
    );
}

function providerRedirectRejected(response) {
    return new ApiError(
        502,
        'provider_redirect_rejected',
        'The model provider attempted an unsafe redirect.',
        { upstreamStatus: response.status },
    );
}

function contentLengthExceeds(response, maximum) {
    const value = response.headers.get('content-length')?.trim();
    if (!value || !/^[0-9]+$/u.test(value)) return false;
    try {
        return BigInt(value) > BigInt(maximum);
    } catch {
        return false;
    }
}

async function cancelResponseBody(response, reason) {
    if (!response.body || response.body.locked) return;
    await response.body.cancel(reason).catch(() => {});
}

async function assertResponseContentLength(response, maximum, label) {
    if (!contentLengthExceeds(response, maximum)) return;
    const error = providerResponseTooLarge(label, maximum);
    await cancelResponseBody(response, error);
    throw error;
}

async function rejectRedirectResponse(response, abortContext) {
    if (!response.redirected && (response.status < 300 || response.status >= 400)) return;
    const error = providerRedirectRejected(response);
    abortContext.abort(error);
    await cancelResponseBody(response, error);
    throw error;
}

async function readBoundedResponseText(response, signal, maximum, label) {
    await assertResponseContentLength(response, maximum, label);
    if (!response.body || typeof response.body.getReader !== 'function') return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let totalBytes = 0;
    let reachedEnd = false;
    let failure = null;
    const cancelReader = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancelReader, { once: true });

    try {
        while (true) {
            if (signal.aborted) throw signal.reason;
            const { value, done } = await reader.read();
            if (done) {
                parts.push(decoder.decode());
                reachedEnd = true;
                break;
            }
            totalBytes += value.byteLength;
            if (totalBytes > maximum) {
                throw providerResponseTooLarge(label, maximum);
            }
            parts.push(decoder.decode(value, { stream: true }));
        }
        if (signal.aborted) throw signal.reason;
        return parts.join('');
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        signal.removeEventListener('abort', cancelReader);
        if (!reachedEnd) await reader.cancel(failure ?? signal.reason).catch(() => {});
        reader.releaseLock();
    }
}

function appendDecodedLines(state, text) {
    const lines = [];
    let start = 0;
    while (start <= text.length) {
        const newlineIndex = text.indexOf('\n', start);
        const end = newlineIndex === -1 ? text.length : newlineIndex;
        const fragment = text.slice(start, end);
        if (fragment.length > 0) {
            state.bytes += Buffer.byteLength(fragment, 'utf8');
            if (state.bytes > PROVIDER_RESPONSE_LIMITS.streamLineBytes) {
                throw providerResponseTooLarge(
                    'stream line',
                    PROVIDER_RESPONSE_LIMITS.streamLineBytes,
                );
            }
            state.parts.push(fragment);
        }
        if (newlineIndex === -1) break;
        let line = state.parts.join('');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
        state.parts = [];
        state.bytes = 0;
        start = newlineIndex + 1;
    }
    return lines;
}

async function* streamLines(body, signal) {
    if (!body || typeof body.getReader !== 'function') {
        throw new ApiError(502, 'provider_invalid_response', 'The model provider returned no streaming body.');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const lineState = { parts: [], bytes: 0 };
    let totalBytes = 0;
    let reachedEnd = false;
    let failure = null;
    const cancelReader = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancelReader, { once: true });

    try {
        while (true) {
            if (signal.aborted) throw signal.reason;
            const { value, done } = await reader.read();
            if (signal.aborted) throw signal.reason;
            if (done) {
                const finalLines = appendDecodedLines(lineState, decoder.decode());
                if (signal.aborted) throw signal.reason;
                for (const line of finalLines) yield line;
                if (lineState.parts.length > 0) {
                    let line = lineState.parts.join('');
                    if (line.endsWith('\r')) line = line.slice(0, -1);
                    if (signal.aborted) throw signal.reason;
                    yield line;
                }
                if (signal.aborted) throw signal.reason;
                reachedEnd = true;
                break;
            }
            totalBytes += value.byteLength;
            if (totalBytes > PROVIDER_RESPONSE_LIMITS.streamBytes) {
                throw providerResponseTooLarge(
                    'stream body',
                    PROVIDER_RESPONSE_LIMITS.streamBytes,
                );
            }
            for (const line of appendDecodedLines(
                lineState,
                decoder.decode(value, { stream: true }),
            )) yield line;
        }
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        signal.removeEventListener('abort', cancelReader);
        if (!reachedEnd) await reader.cancel(failure ?? signal.reason).catch(() => {});
        reader.releaseLock();
    }
}

async function* sseRecords(body, signal) {
    let event = 'message';
    let data = [];
    let dataBytes = 0;

    for await (const line of streamLines(body, signal)) {
        if (line === '') {
            if (data.length > 0) yield { event, data: data.join('\n') };
            event = 'message';
            data = [];
            dataBytes = 0;
            continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value || 'message';
        if (field === 'data') {
            dataBytes += Buffer.byteLength(value, 'utf8') + (data.length > 0 ? 1 : 0);
            if (dataBytes > PROVIDER_RESPONSE_LIMITS.streamEventBytes) {
                throw providerResponseTooLarge(
                    'stream event',
                    PROVIDER_RESPONSE_LIMITS.streamEventBytes,
                );
            }
            data.push(value);
        }
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
}

async function* ndjsonRecords(body, signal) {
    for await (const line of streamLines(body, signal)) {
        const data = line.trim();
        if (data.length > 0) {
            if (Buffer.byteLength(data, 'utf8') > PROVIDER_RESPONSE_LIMITS.streamEventBytes) {
                throw providerResponseTooLarge(
                    'stream event',
                    PROVIDER_RESPONSE_LIMITS.streamEventBytes,
                );
            }
            yield { event: 'message', data };
        }
    }
}

function parseStreamPayload(record) {
    if (record.data === '[DONE]') return null;
    try {
        return JSON.parse(record.data);
    } catch {
        throw new ApiError(502, 'provider_invalid_response', 'The model provider returned an invalid stream event.');
    }
}

function mergeUsage(current, next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return current;
    return { ...(current ?? {}), ...next };
}

function openAiChatStreamChunk(payload) {
    const choice = payload?.choices?.[0];
    const content = responseContent(choice?.delta?.content);
    return {
        delta: content ?? '',
        hasContent: content !== null,
        model: payload?.model,
        usage: payload?.usage,
        finishReason: choice?.finish_reason ?? choice?.finishReason,
    };
}

function openAiCompletionStreamChunk(payload) {
    const choice = payload?.choices?.[0];
    const content = typeof choice?.text === 'string'
        ? choice.text
        : responseContent(choice?.delta?.content);
    return {
        delta: content ?? '',
        hasContent: content !== null,
        model: payload?.model,
        usage: payload?.usage,
        finishReason: choice?.finish_reason ?? choice?.finishReason,
    };
}

function anthropicStreamChunk(payload, event) {
    const type = payload?.type ?? event;
    if (type === 'content_block_start') {
        const text = payload?.content_block?.type === 'text' ? payload.content_block.text : null;
        return { delta: typeof text === 'string' ? text : '', hasContent: typeof text === 'string' };
    }
    if (type === 'content_block_delta') {
        const delta = payload?.delta;
        const content = delta?.type === 'text_delta'
            ? delta.text
            : delta?.type === 'input_json_delta' ? delta.partial_json : null;
        return { delta: typeof content === 'string' ? content : '', hasContent: typeof content === 'string' };
    }
    if (type === 'message_start') {
        return {
            delta: '',
            hasContent: false,
            model: payload?.message?.model,
            usage: payload?.message?.usage,
        };
    }
    if (type === 'message_delta') {
        return {
            delta: '',
            hasContent: false,
            usage: payload?.usage,
            finishReason: payload?.delta?.stop_reason,
        };
    }
    return { delta: '', hasContent: false };
}

function googleStreamChunk(payload) {
    const candidate = payload?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const textParts = Array.isArray(parts)
        ? parts.map(part => part?.text).filter(text => typeof text === 'string')
        : [];
    return {
        delta: textParts.join(''),
        hasContent: textParts.length > 0,
        model: payload?.modelVersion,
        usage: payload?.usageMetadata,
        finishReason: candidate?.finishReason,
    };
}

function ollamaUsage(payload) {
    const promptTokens = Number.isInteger(payload?.prompt_eval_count) ? payload.prompt_eval_count : null;
    const completionTokens = Number.isInteger(payload?.eval_count) ? payload.eval_count : null;
    if (promptTokens === null && completionTokens === null) return payload?.usage;
    return {
        prompt_tokens: promptTokens ?? 0,
        completion_tokens: completionTokens ?? 0,
        total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    };
}

function ollamaStreamChunk(payload) {
    return {
        delta: typeof payload?.response === 'string' ? payload.response : '',
        hasContent: typeof payload?.response === 'string',
        model: payload?.model,
        usage: ollamaUsage(payload),
        finishReason: payload?.done_reason ?? (payload?.done ? 'stop' : null),
    };
}

function llamaCppStreamChunk(payload) {
    const choice = payload?.choices?.[0];
    const content = typeof payload?.content === 'string'
        ? payload.content
        : typeof choice?.text === 'string'
            ? choice.text
            : responseContent(choice?.delta?.content);
    return {
        delta: content ?? '',
        hasContent: content !== null,
        model: payload?.model,
        usage: payload?.usage,
        finishReason: choice?.finish_reason ?? payload?.stop_type ?? (payload?.stop ? 'stop' : null),
    };
}

function parseStreamingChunk(protocol, payload, event) {
    switch (protocol) {
        case 'openai-chat': return openAiChatStreamChunk(payload);
        case 'anthropic-messages': return anthropicStreamChunk(payload, event);
        case 'google-generate-content': return googleStreamChunk(payload);
        case 'openai-completions': return openAiCompletionStreamChunk(payload);
        case 'ollama-generate': return ollamaStreamChunk(payload);
        case 'llamacpp-completion': return llamaCppStreamChunk(payload);
        default:
            throw new ApiError(400, 'invalid_provider_settings', 'The configured provider protocol is not supported.');
    }
}

function streamingRecords(response, protocol, signal) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const useNdjson = protocol === 'ollama-generate'
        || (protocol === 'llamacpp-completion' && contentType.includes('ndjson'));
    return useNdjson ? ndjsonRecords(response.body, signal) : sseRecords(response.body, signal);
}

async function streamingErrorPayload(response, signal) {
    const raw = await readBoundedResponseText(
        response,
        signal,
        PROVIDER_RESPONSE_LIMITS.errorBytes,
        'error body',
    );
    try {
        return JSON.parse(raw);
    } catch {
        return raw ? { message: raw } : null;
    }
}

export async function createStreamingCompletion(settings, request, {
    fetchImplementation = globalThis.fetch,
    timeoutMs = 120_000,
    signal: externalSignal,
    onDelta,
} = {}) {
    if (!settings.model) {
        throw new ApiError(400, 'provider_not_configured', 'Configure a model before generating.');
    }

    const protocol = settings.protocol ?? 'openai-chat';
    const adapterRequest = {
        ...request,
        stop: cleanStop(request.stop, settings.stop ?? []),
        temperature: cleanTemperature(request.temperature, settings.temperature ?? 1),
        topP: cleanTopP(request.topP, settings.topP ?? 1),
        topK: cleanTopK(request.topK, settings.topK ?? 0),
    };
    const adapter = configureStreamingAdapter(createAdapter(settings, adapterRequest), protocol);
    const abortContext = createAbortContext(timeoutMs, externalSignal);
    const maximumAttempts = adapter.openAiFallbacks ? 3 : 1;

    try {
        if (abortContext.signal.aborted) {
            throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
        }
        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
            let response;
            try {
                response = await fetchImplementation(adapter.url, {
                    method: 'POST',
                    headers: adapter.headers,
                    body: JSON.stringify(adapter.body),
                    signal: abortContext.signal,
                    redirect: 'manual',
                });
            } catch (error) {
                throwStreamingTransportError(error, abortContext, externalSignal);
            }
            if (abortContext.signal.aborted) {
                throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
            }
            await rejectRedirectResponse(response, abortContext);

            if (!response.ok) {
                let payload;
                try {
                    payload = await streamingErrorPayload(response, abortContext.signal);
                } catch (error) {
                    abortContext.abort(error);
                    throwStreamingTransportError(error, abortContext, externalSignal);
                }
                if (abortContext.signal.aborted) {
                    throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
                }
                const upstreamMessage = safeUpstreamMessage(payload, 'The model provider rejected the request.');
                if (adapter.openAiFallbacks && adapter.body.response_format
                    && isUnsupportedSchema(response.status, upstreamMessage)) {
                    delete adapter.body.response_format;
                    continue;
                }
                if (adapter.openAiFallbacks && 'max_tokens' in adapter.body
                    && isUnsupportedMaxTokens(response.status, upstreamMessage)) {
                    adapter.body.max_completion_tokens = adapter.body.max_tokens;
                    delete adapter.body.max_tokens;
                    continue;
                }
                throw new ApiError(502, 'provider_http_error', upstreamMessage, { upstreamStatus: response.status });
            }

            let content = '';
            let model = settings.model;
            let usage;
            let finishReason = null;
            let hasContent = false;
            try {
                await assertResponseContentLength(
                    response,
                    PROVIDER_RESPONSE_LIMITS.streamBytes,
                    'stream body',
                );
                for await (const record of streamingRecords(response, protocol, abortContext.signal)) {
                    const payload = parseStreamPayload(record);
                    if (payload === null) break;
                    if (payload?.error || record.event === 'error') {
                        throw new ApiError(502, 'provider_http_error', safeUpstreamMessage(payload, 'The model provider stream failed.'));
                    }
                    const chunk = parseStreamingChunk(protocol, payload, record.event);
                    if (typeof chunk.model === 'string' && chunk.model.length > 0) model = chunk.model;
                    usage = mergeUsage(usage, chunk.usage);
                    if (chunk.finishReason !== undefined && chunk.finishReason !== null) {
                        finishReason = chunk.finishReason;
                    }
                    if (chunk.hasContent) hasContent = true;
                    if (chunk.delta.length > 0) {
                        if (content.length + chunk.delta.length
                            > PROVIDER_RESPONSE_LIMITS.contentCharacters) {
                            throw providerResponseTooLarge(
                                'generated content',
                                PROVIDER_RESPONSE_LIMITS.contentCharacters,
                            );
                        }
                        content += chunk.delta;
                        if (typeof onDelta === 'function') await onDelta(chunk.delta);
                        if (abortContext.signal.aborted) throw abortContext.signal.reason;
                    }
                }
                if (abortContext.signal.aborted) throw abortContext.signal.reason;
            } catch (error) {
                abortContext.abort(error);
                throwStreamingTransportError(error, abortContext, externalSignal);
            }

            if (!hasContent) {
                throw new ApiError(502, 'provider_invalid_response', 'The model provider response did not contain content.');
            }
            return {
                content,
                model,
                ...(usage ? { usage } : {}),
                finishReason,
            };
        }
        throw new ApiError(502, 'provider_http_error', 'The model provider is incompatible with this request.');
    } finally {
        abortContext.cleanup();
    }
}

export async function createChatCompletion(settings, request, {
    fetchImplementation = globalThis.fetch,
    timeoutMs = 120_000,
    signal: externalSignal,
} = {}) {
    if (!settings.model) {
        throw new ApiError(400, 'provider_not_configured', 'Configure a model before generating.');
    }

    const adapterRequest = {
        ...request,
        stop: cleanStop(request.stop, settings.stop ?? []),
        temperature: cleanTemperature(request.temperature, settings.temperature ?? 1),
        topP: cleanTopP(request.topP, settings.topP ?? 1),
        topK: cleanTopK(request.topK, settings.topK ?? 0),
    };
    const adapter = createAdapter(settings, adapterRequest);
    const maximumAttempts = adapter.openAiFallbacks ? 3 : 1;
    const abortContext = createAbortContext(timeoutMs, externalSignal);
    try {
        if (abortContext.signal.aborted) {
            throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
        }
        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
            let response;
            try {
                response = await fetchImplementation(adapter.url, {
                    method: 'POST',
                    headers: adapter.headers,
                    body: JSON.stringify(adapter.body),
                    signal: abortContext.signal,
                    redirect: 'manual',
                });
            } catch (error) {
                throwStreamingTransportError(error, abortContext, externalSignal);
            }
            if (abortContext.signal.aborted) {
                throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
            }
            await rejectRedirectResponse(response, abortContext);

            let payload;
            try {
                const raw = await readBoundedResponseText(
                    response,
                    abortContext.signal,
                    response.ok
                        ? PROVIDER_RESPONSE_LIMITS.jsonBytes
                        : PROVIDER_RESPONSE_LIMITS.errorBytes,
                    response.ok ? 'JSON body' : 'error body',
                );
                payload = JSON.parse(raw);
            } catch (error) {
                if (error instanceof ApiError) abortContext.abort(error);
                if (abortContext.signal.aborted) {
                    throwStreamingTransportError(error, abortContext, externalSignal);
                }
                if (!response.ok) {
                    throw new ApiError(502, 'provider_http_error', 'The model provider rejected the request.', {
                        upstreamStatus: response.status,
                    });
                }
                throw new ApiError(502, 'provider_invalid_response', 'The model provider returned invalid JSON.', {
                    upstreamStatus: response.status,
                });
            }
            if (!response.ok) {
                const upstreamMessage = safeUpstreamMessage(payload, 'The model provider rejected the request.');
                if (adapter.openAiFallbacks && adapter.body.response_format
                    && isUnsupportedSchema(response.status, upstreamMessage)) {
                    delete adapter.body.response_format;
                    continue;
                }
                if (adapter.openAiFallbacks && 'max_tokens' in adapter.body
                    && isUnsupportedMaxTokens(response.status, upstreamMessage)) {
                    adapter.body.max_completion_tokens = adapter.body.max_tokens;
                    delete adapter.body.max_tokens;
                    continue;
                }
                throw new ApiError(502, 'provider_http_error', upstreamMessage, { upstreamStatus: response.status });
            }

            if (abortContext.signal.aborted) {
                throwStreamingTransportError(abortContext.signal.reason, abortContext, externalSignal);
            }
            const parsed = adapter.parse(payload);
            if (parsed.content === null) {
                throw new ApiError(502, 'provider_invalid_response', 'The model provider response did not contain content.');
            }
            if (parsed.content.length > PROVIDER_RESPONSE_LIMITS.contentCharacters) {
                const error = providerResponseTooLarge(
                    'generated content',
                    PROVIDER_RESPONSE_LIMITS.contentCharacters,
                );
                abortContext.abort(error);
                throw error;
            }
            return {
                content: parsed.content,
                model: typeof parsed.model === 'string' ? parsed.model : settings.model,
                ...(parsed.usage && typeof parsed.usage === 'object' ? { usage: parsed.usage } : {}),
            };
        }
        throw new ApiError(502, 'provider_http_error', 'The model provider is incompatible with this request.');
    } finally {
        abortContext.cleanup();
    }
}

export async function testProvider(settings, options = {}) {
    const result = await createChatCompletion(settings, {
        prompt: 'Reply with OK.',
        systemPrompt: 'This is a connection test. Reply briefly.',
        responseLength: Math.min(settings.maxTokens, 8),
        minimumResponseLength: 1,
        responseSchema: null,
        stop: [],
        temperature: settings.temperature ?? 1,
        topP: settings.topP ?? 1,
        topK: settings.topK ?? 0,
    }, options);
    return {
        ok: true,
        message: 'Provider connection succeeded.',
        model: result.model,
    };
}
