import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError } from './api-error.js';

export const COPILOT_SESSION_SCHEMA_VERSION = 1;
export const COPILOT_SETTINGS_SCHEMA_VERSION = 1;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SESSION_STATUSES = new Set(['draft', 'generating', 'ready', 'failed', 'cancelled']);
const ATTEMPT_STATUSES = new Set(['generating', 'completed', 'failed', 'cancelled', 'interrupted']);
const SESSION_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'projectId', 'revision', 'status', 'commandId', 'requestDigest',
    'base', 'input', 'selection', 'contextDigest', 'evidenceCatalog', 'targetSnapshot',
    'profile', 'provider', 'attempts', 'artifact', 'error', 'createdAt', 'updatedAt',
]);
const ATTEMPT_FIELDS = Object.freeze([
    'number', 'commandId', 'requestDigest', 'status', 'raw', 'error', 'startedAt', 'finishedAt',
    'model', 'usage', 'finishReason',
]);
const MAX_SESSION_BYTES = 24 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;

function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
    if (!isObject(value)) throw new ApiError(500, 'invalid_copilot_storage', `${label} must be an object.`);
    return value;
}

function assertExactFields(value, fields, label) {
    assertObject(value, label);
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    const missing = fields.filter(field => !Object.hasOwn(value, field));
    if (unknown.length > 0 || missing.length > 0) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} fields are invalid.`, { unknown, missing });
    }
}

function assertId(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) {
        throw new ApiError(400, 'invalid_copilot_id', `${label} is invalid.`);
    }
    return value;
}

function assertIso(value, label) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} is invalid.`);
    }
    return value;
}

function cloneJson(value, label, maximum) {
    let json;
    try {
        json = JSON.stringify(value);
    } catch {
        throw new ApiError(400, 'invalid_copilot_data', `${label} must be JSON serializable.`);
    }
    if (Buffer.byteLength(json, 'utf8') > maximum) {
        throw new ApiError(413, 'copilot_data_too_large', `${label} is too large.`, { maximum });
    }
    const clone = JSON.parse(json);
    const stack = [clone];
    while (stack.length > 0) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;
        for (const [key, child] of Object.entries(item)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw new ApiError(400, 'invalid_copilot_data', `${label} contains a forbidden key.`, { key });
            }
            if (child && typeof child === 'object') stack.push(child);
        }
    }
    return clone;
}

function readJson(filePath, missing = undefined) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT' && missing !== undefined) return structuredClone(missing);
        if (error?.code === 'ENOENT') throw new ApiError(404, 'copilot_session_not_found', 'Copilot session not found.');
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot storage is not valid JSON.', {
            file: path.basename(filePath),
        });
    }
}

function writeJson(filePath, value, maximum) {
    const clone = cloneJson(value, 'Copilot record', maximum);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, JSON.stringify(clone, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    }
    return clone;
}

function validateAttempt(value, index) {
    const label = `attempts[${index}]`;
    assertExactFields(value, ATTEMPT_FIELDS, label);
    if (value.number !== index + 1 || !ATTEMPT_STATUSES.has(value.status)) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} state is invalid.`);
    }
    assertId(value.commandId, `${label}.commandId`);
    if (typeof value.requestDigest !== 'string' || !SHA256.test(value.requestDigest)) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label}.requestDigest is invalid.`);
    }
    if (typeof value.raw !== 'string' || typeof value.error !== 'string') {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} text fields are invalid.`);
    }
    assertIso(value.startedAt, `${label}.startedAt`);
    if (value.finishedAt !== null) assertIso(value.finishedAt, `${label}.finishedAt`);
    if (value.status === 'generating' && value.finishedAt !== null) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} cannot be unfinished and finished.`);
    }
    if (value.status !== 'generating' && value.finishedAt === null) {
        throw new ApiError(500, 'invalid_copilot_storage', `${label} is missing its finish time.`);
    }
    return value;
}

export function validateCopilotSession(value, expected = {}) {
    const record = cloneJson(value, 'Copilot session', MAX_SESSION_BYTES);
    assertExactFields(record, SESSION_FIELDS, 'Copilot session');
    if (record.schemaVersion !== COPILOT_SESSION_SCHEMA_VERSION) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot session schema is unsupported.');
    }
    assertId(record.id, 'session.id');
    assertId(record.projectId, 'session.projectId');
    if ((expected.id && record.id !== expected.id) || (expected.projectId && record.projectId !== expected.projectId)) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot session identity does not match its path.');
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !SESSION_STATUSES.has(record.status)) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot session state is invalid.');
    }
    assertId(record.commandId, 'session.commandId');
    for (const field of ['requestDigest', 'contextDigest']) {
        if (typeof record[field] !== 'string' || !SHA256.test(record[field])) {
            throw new ApiError(500, 'invalid_copilot_storage', `session.${field} is invalid.`);
        }
    }
    if (!Array.isArray(record.evidenceCatalog) || !Array.isArray(record.attempts)) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot session arrays are invalid.');
    }
    record.attempts.forEach(validateAttempt);
    if (record.status === 'generating' && record.attempts.at(-1)?.status !== 'generating') {
        throw new ApiError(500, 'invalid_copilot_storage', 'Generating Copilot session has no active attempt.');
    }
    if (record.status === 'ready' && (!isObject(record.artifact) || record.artifact.status !== 'candidate')) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Ready Copilot session has no candidate artifact.');
    }
    if (typeof record.error !== 'string') {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot session error is invalid.');
    }
    assertIso(record.createdAt, 'session.createdAt');
    assertIso(record.updatedAt, 'session.updatedAt');
    return record;
}

function defaultSettings() {
    return {
        schemaVersion: COPILOT_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        modelMode: 'inherit',
        model: '',
        updatedAt: new Date(0).toISOString(),
    };
}

function validateSettings(value) {
    const settings = cloneJson(value, 'Copilot settings', MAX_SETTINGS_BYTES);
    assertExactFields(settings, ['schemaVersion', 'revision', 'modelMode', 'model', 'updatedAt'], 'Copilot settings');
    if (settings.schemaVersion !== COPILOT_SETTINGS_SCHEMA_VERSION
        || !Number.isSafeInteger(settings.revision) || settings.revision < 1
        || !['inherit', 'override'].includes(settings.modelMode)
        || typeof settings.model !== 'string' || settings.model.length > 256
        || (settings.modelMode === 'override' && !settings.model.trim())) {
        throw new ApiError(500, 'invalid_copilot_storage', 'Copilot settings are invalid.');
    }
    assertIso(settings.updatedAt, 'settings.updatedAt');
    return settings;
}

function sessionSummary(record) {
    return {
        id: record.id,
        projectId: record.projectId,
        revision: record.revision,
        status: record.status,
        optionCount: record.input.optionCount,
        profile: {
            source: record.profile.source,
            id: record.profile.id,
            name: record.profile.name,
            profileHash: record.profile.profileHash,
        },
        provider: record.provider,
        artifactId: record.artifact?.id ?? null,
        error: record.error,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}

export class CopilotStore {
    constructor(rootDirectory) {
        this.rootDirectory = path.resolve(rootDirectory);
        this.settingsPath = path.join(this.rootDirectory, 'settings.json');
        fs.mkdirSync(this.rootDirectory, { recursive: true });
    }

    projectDirectory(projectId) {
        return path.join(this.rootDirectory, 'projects', assertId(projectId, 'projectId'));
    }

    sessionsDirectory(projectId) {
        return path.join(this.projectDirectory(projectId), 'sessions');
    }

    sessionPath(projectId, sessionId) {
        return path.join(this.sessionsDirectory(projectId), `${assertId(sessionId, 'sessionId')}.json`);
    }

    getSettings() {
        const stored = readJson(this.settingsPath, defaultSettings());
        return validateSettings(stored);
    }

    updateSettings(value) {
        if (!isObject(value)) throw new ApiError(400, 'invalid_copilot_settings', 'Copilot settings must be an object.');
        const fields = ['revision', 'modelMode', 'model'];
        const unknown = Object.keys(value).filter(field => !fields.includes(field));
        const missing = fields.filter(field => !Object.hasOwn(value, field));
        if (unknown.length > 0 || missing.length > 0) {
            throw new ApiError(400, 'invalid_copilot_settings', 'Copilot settings fields are invalid.', { unknown, missing });
        }
        const current = this.getSettings();
        if (value.revision !== current.revision) {
            throw new ApiError(409, 'copilot_settings_conflict', 'Copilot settings changed.', {
                currentRevision: current.revision,
            });
        }
        if (!['inherit', 'override'].includes(value.modelMode)
            || typeof value.model !== 'string' || value.model.length > 256
            || (value.modelMode === 'override' && !value.model.trim())) {
            throw new ApiError(400, 'invalid_copilot_settings', 'Copilot model selection is invalid.');
        }
        return validateSettings(writeJson(this.settingsPath, {
            schemaVersion: COPILOT_SETTINGS_SCHEMA_VERSION,
            revision: current.revision + 1,
            modelMode: value.modelMode,
            model: value.modelMode === 'override' ? value.model.trim() : '',
            updatedAt: new Date().toISOString(),
        }, MAX_SETTINGS_BYTES));
    }

    createSession(value) {
        const record = validateCopilotSession(value);
        const filePath = this.sessionPath(record.projectId, record.id);
        if (fs.existsSync(filePath)) {
            throw new ApiError(409, 'copilot_session_exists', 'Copilot session already exists.');
        }
        writeJson(filePath, record, MAX_SESSION_BYTES);
        return record;
    }

    getSession(projectId, sessionId) {
        return validateCopilotSession(
            readJson(this.sessionPath(projectId, sessionId)),
            { projectId, id: sessionId },
        );
    }

    mutateSession(projectId, sessionId, expectedRevision, updater) {
        const current = this.getSession(projectId, sessionId);
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
            throw new ApiError(409, 'copilot_session_conflict', 'Copilot session changed.', {
                currentRevision: current.revision,
            });
        }
        const nextValue = updater(structuredClone(current));
        if (!isObject(nextValue)) throw new ApiError(500, 'invalid_copilot_state', 'Copilot updater returned invalid state.');
        const next = validateCopilotSession({
            ...nextValue,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
        }, { projectId, id: sessionId });
        writeJson(this.sessionPath(projectId, sessionId), next, MAX_SESSION_BYTES);
        return next;
    }

    recoverInterrupted(projectId, sessionId) {
        const current = this.getSession(projectId, sessionId);
        if (current.status !== 'generating') return current;
        return this.mutateSession(projectId, sessionId, current.revision, session => {
            const attempt = session.attempts.at(-1);
            attempt.status = 'interrupted';
            attempt.error = 'The service restarted before the Provider result was known.';
            attempt.finishedAt = new Date().toISOString();
            session.status = 'failed';
            session.error = attempt.error;
            return session;
        });
    }

    listSessions(projectId) {
        const directory = this.sessionsDirectory(projectId);
        if (!fs.existsSync(directory)) return { sessions: [], corrupt: [] };
        const sessions = [];
        const corrupt = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/u.test(entry.name)) continue;
            const sessionId = entry.name.slice(0, -5);
            try {
                sessions.push(sessionSummary(this.getSession(projectId, sessionId)));
            } catch {
                corrupt.push({ id: sessionId, error: 'invalid_copilot_storage' });
            }
        }
        sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        corrupt.sort((left, right) => left.id.localeCompare(right.id));
        return { sessions, corrupt };
    }
}
