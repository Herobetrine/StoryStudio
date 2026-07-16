import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, createStoragePathGuard } from './api-error.js';

export const PROVIDER_PROTOCOLS = Object.freeze([
    'openai-chat',
    'anthropic-messages',
    'google-generate-content',
    'openai-completions',
    'ollama-generate',
    'llamacpp-completion',
]);

const CONFIG_FIELDS = [
    'protocol',
    'baseUrl',
    'model',
    'temperature',
    'topP',
    'topK',
    'stop',
    'contextTokens',
    'maxTokens',
    'jsonSchema',
];
const UPDATE_FIELDS = [...CONFIG_FIELDS, 'apiKey'];

export const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    temperature: 0.7,
    topP: 1,
    topK: 0,
    stop: Object.freeze([]),
    contextTokens: 32_768,
    maxTokens: 8_192,
    jsonSchema: true,
});

export class ProviderConfigError extends Error {
    constructor(message, code = 'invalid_provider_settings', details = {}) {
        super(message);
        this.name = 'ProviderConfigError';
        this.status = 400;
        this.code = code;
        this.details = details;
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProviderConfigError(`${label} must be an object.`);
    }
}

function assertKnownFields(value, fields) {
    const unknown = Object.keys(value).filter(key => !fields.includes(key));
    if (unknown.length > 0) {
        throw new ProviderConfigError('Provider settings contain unknown fields.', 'unknown_fields', { fields: unknown });
    }
}

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
        throw new ProviderConfigError('baseUrl must be a non-empty URL no longer than 2048 characters.');
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ProviderConfigError('baseUrl must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new ProviderConfigError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment.');
    }
    return url.toString().replace(/\/$/, '');
}

function normalizeProtocol(value) {
    if (typeof value !== 'string' || !PROVIDER_PROTOCOLS.includes(value)) {
        throw new ProviderConfigError(`protocol must be one of: ${PROVIDER_PROTOCOLS.join(', ')}.`);
    }
    return value;
}

function normalizeModel(value) {
    if (typeof value !== 'string' || value.length > 256) {
        throw new ProviderConfigError('model must be a string no longer than 256 characters.');
    }
    return value.trim();
}

function normalizeTemperature(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
        throw new ProviderConfigError('temperature must be a number between 0 and 2.');
    }
    return value;
}

function normalizeTopP(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new ProviderConfigError('topP must be a number between 0 and 1.');
    }
    return value;
}

function normalizeTopK(value) {
    if (!Number.isInteger(value) || value < 0 || value > 100_000) {
        throw new ProviderConfigError('topK must be an integer between 0 and 100000.');
    }
    return value;
}

function normalizeStop(value) {
    if (!Array.isArray(value) || value.length > 16
        || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1_000)) {
        throw new ProviderConfigError('stop must contain at most 16 non-empty strings of at most 1000 characters.');
    }
    return [...value];
}

function normalizeMaxTokens(value) {
    if (!Number.isInteger(value) || value < 256 || value > 200_000) {
        throw new ProviderConfigError('maxTokens must be an integer between 256 and 200000.');
    }
    return value;
}

function normalizeContextTokens(value) {
    if (!Number.isInteger(value) || value < 2_048 || value > 2_000_000) {
        throw new ProviderConfigError('contextTokens must be an integer between 2048 and 2000000.');
    }
    return value;
}

function normalizeJsonSchema(value) {
    if (typeof value !== 'boolean') {
        throw new ProviderConfigError('jsonSchema must be a boolean.');
    }
    return value;
}

function normalizeApiKey(value) {
    if (value === null) return '';
    if (typeof value !== 'string' || value.length > 8_192 || /[\r\n]/.test(value)) {
        throw new ProviderConfigError('apiKey must be null or a string no longer than 8192 characters without line breaks.');
    }
    return value;
}

function normalizeStoredConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PROVIDER_SETTINGS };
    const result = { ...DEFAULT_PROVIDER_SETTINGS };
    try {
        if (value.protocol !== undefined) result.protocol = normalizeProtocol(value.protocol);
        if (value.baseUrl !== undefined) result.baseUrl = normalizeBaseUrl(value.baseUrl);
        if (value.model !== undefined) result.model = normalizeModel(value.model);
        if (value.temperature !== undefined) result.temperature = normalizeTemperature(value.temperature);
        if (value.topP !== undefined) result.topP = normalizeTopP(value.topP);
        if (value.topK !== undefined) result.topK = normalizeTopK(value.topK);
        if (value.stop !== undefined) result.stop = normalizeStop(value.stop);
        if (value.contextTokens !== undefined) result.contextTokens = normalizeContextTokens(value.contextTokens);
        if (value.maxTokens !== undefined) result.maxTokens = normalizeMaxTokens(value.maxTokens);
        if (value.jsonSchema !== undefined) result.jsonSchema = normalizeJsonSchema(value.jsonSchema);
    } catch {
        return { ...DEFAULT_PROVIDER_SETTINGS };
    }
    return result;
}

function readJsonOrDefault(filePath, fallback, pathGuard) {
    const safePath = pathGuard.assertPath(filePath);
    try {
        return JSON.parse(fs.readFileSync(safePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

function writeJson(filePath, value, mode, pathGuard) {
    const safePath = pathGuard.assertPath(filePath);
    pathGuard.ensureDirectory(path.dirname(safePath));
    pathGuard.assertPath(safePath);
    writeFileAtomicSync(safePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
    pathGuard.assertPath(safePath);
    try {
        fs.chmodSync(safePath, mode);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    }
}

export function maskApiKey(apiKey) {
    if (!apiKey) return '';
    const suffix = apiKey.length > 4 ? apiKey.slice(-4) : '';
    return `****${suffix}`;
}

export class ProviderStore {
    constructor(dataRoot) {
        this.pathGuard = createStoragePathGuard(dataRoot, {
            label: 'Provider storage',
            createError: (message, details) => (
                new ApiError(500, 'unsafe_provider_path', message, details)
            ),
        });
        this.dataRoot = this.pathGuard.rootDirectory;
        this.configPath = this.storagePath('provider.json');
        this.secretsPath = this.storagePath('secrets.json');
    }

    storagePath(...segments) {
        return this.pathGuard.resolvePath(...segments);
    }

    readSecrets(settings, { allowLegacy = false } = {}) {
        const value = readJsonOrDefault(this.secretsPath, {}, this.pathGuard);
        const apiKey = typeof value?.apiKey === 'string' ? value.apiKey : '';
        if (!apiKey) return { apiKey: '' };

        const hasScope = typeof value.origin === 'string' && typeof value.protocol === 'string';
        if (!hasScope) {
            return { apiKey: allowLegacy && settings.protocol === 'openai-chat' ? apiKey : '' };
        }

        const matchesOrigin = value.origin === new URL(settings.baseUrl).origin;
        const matchesProtocol = value.protocol === settings.protocol;
        return { apiKey: matchesOrigin && matchesProtocol ? apiKey : '' };
    }

    getResolved() {
        const stored = readJsonOrDefault(this.configPath, {}, this.pathGuard);
        const settings = normalizeStoredConfig(stored);
        const allowLegacy = stored?.protocol === undefined;
        return { ...settings, ...this.readSecrets(settings, { allowLegacy }) };
    }

    getPublic() {
        const { apiKey, ...settings } = this.getResolved();
        return {
            ...settings,
            hasApiKey: apiKey.length > 0,
            maskedApiKey: maskApiKey(apiKey),
        };
    }

    resolve(changes, { allowEmpty = false } = {}) {
        assertPlainObject(changes, 'Provider settings');
        assertKnownFields(changes, UPDATE_FIELDS);
        if (!allowEmpty && Object.keys(changes).length === 0) {
            throw new ProviderConfigError('Provider settings cannot be empty.', 'empty_changes');
        }

        const current = this.getResolved();
        const protocol = changes.protocol === undefined ? current.protocol : normalizeProtocol(changes.protocol);
        const baseUrl = changes.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(changes.baseUrl);
        const baseUrlOriginChanged = new URL(baseUrl).origin !== new URL(current.baseUrl).origin;
        const protocolChanged = protocol !== current.protocol;
        return {
            protocol,
            baseUrl,
            model: changes.model === undefined ? current.model : normalizeModel(changes.model),
            temperature: changes.temperature === undefined ? current.temperature : normalizeTemperature(changes.temperature),
            topP: changes.topP === undefined ? current.topP : normalizeTopP(changes.topP),
            topK: changes.topK === undefined ? current.topK : normalizeTopK(changes.topK),
            stop: changes.stop === undefined ? [...current.stop] : normalizeStop(changes.stop),
            contextTokens: changes.contextTokens === undefined ? current.contextTokens : normalizeContextTokens(changes.contextTokens),
            maxTokens: changes.maxTokens === undefined ? current.maxTokens : normalizeMaxTokens(changes.maxTokens),
            jsonSchema: changes.jsonSchema === undefined ? current.jsonSchema : normalizeJsonSchema(changes.jsonSchema),
            apiKey: changes.apiKey === undefined
                ? (baseUrlOriginChanged || protocolChanged ? '' : current.apiKey)
                : normalizeApiKey(changes.apiKey),
        };
    }

    update(changes) {
        const next = this.resolve(changes);

        const config = Object.fromEntries(CONFIG_FIELDS.map(field => [field, next[field]]));
        writeJson(this.configPath, config, 0o600, this.pathGuard);
        writeJson(this.secretsPath, {
            apiKey: next.apiKey,
            origin: new URL(next.baseUrl).origin,
            protocol: next.protocol,
        }, 0o600, this.pathGuard);
        return this.getPublic();
    }
}
