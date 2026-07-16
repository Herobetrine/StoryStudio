import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { CopilotStore } from '../src/copilot-store.js';

const DIGEST = 'a'.repeat(64);

function record(overrides = {}) {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        id: 'copilot-session-one',
        projectId: 'project-one',
        revision: 1,
        status: 'draft',
        commandId: 'create-one',
        requestDigest: DIGEST,
        base: { projectId: 'project-one', projectVersion: 1 },
        input: { optionCount: 3 },
        selection: { volumeIds: [], chapterIds: [], entityIds: [], lorebookIds: [], selectedEvidenceIds: [] },
        contextDigest: DIGEST,
        evidenceCatalog: [],
        targetSnapshot: { project: { id: 'project-one' }, volumes: [], chapters: [], lorebooks: [] },
        profile: { source: 'builtin', id: 'builtin.planning-copilot.v1', name: 'Copilot', profileHash: DIGEST },
        provider: { modelMode: 'inherit', model: 'model', protocol: 'openai-chat', configHash: DIGEST },
        attempts: [],
        artifact: null,
        error: '',
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('Copilot sidecar store', () => {
    let root;
    let store;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-copilot-store-'));
        store = new CopilotStore(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('persists optimistic settings without exposing another storage surface', () => {
        const initial = store.getSettings();
        assert.equal(initial.modelMode, 'inherit');
        const updated = store.updateSettings({ revision: initial.revision, modelMode: 'override', model: 'planner-model' });
        assert.equal(updated.model, 'planner-model');
        assert.equal(updated.revision, 2);
        assert.throws(
            () => store.updateSettings({ revision: 1, modelMode: 'inherit', model: '' }),
            error => error.code === 'copilot_settings_conflict',
        );
    });

    test('recovers a persisted unknown Provider window as an interrupted retryable attempt', () => {
        const now = new Date().toISOString();
        const generating = record({
            status: 'generating',
            attempts: [{
                number: 1,
                commandId: 'generate-one',
                requestDigest: DIGEST,
                status: 'generating',
                raw: '',
                error: '',
                startedAt: now,
                finishedAt: null,
                model: '',
                usage: null,
                finishReason: '',
            }],
        });
        store.createSession(generating);
        const recovered = store.recoverInterrupted('project-one', 'copilot-session-one');
        assert.equal(recovered.status, 'failed');
        assert.equal(recovered.revision, 2);
        assert.equal(recovered.attempts[0].status, 'interrupted');
        assert.match(recovered.error, /restarted/);
    });

    test('isolates a corrupt session file from healthy session listings', () => {
        store.createSession(record());
        const corruptPath = store.sessionPath('project-one', 'copilot-corrupt');
        fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
        fs.writeFileSync(corruptPath, '{bad json', 'utf8');
        const listed = store.listSessions('project-one');
        assert.deepEqual(listed.sessions.map(item => item.id), ['copilot-session-one']);
        assert.deepEqual(listed.corrupt, [{ id: 'copilot-corrupt', error: 'invalid_copilot_storage' }]);
    });

    test('uses session revision checks for every state transition', () => {
        store.createSession(record());
        const changed = store.mutateSession('project-one', 'copilot-session-one', 1, session => {
            session.status = 'failed';
            session.error = 'failed before a Provider call';
            return session;
        });
        assert.equal(changed.revision, 2);
        assert.throws(
            () => store.mutateSession('project-one', 'copilot-session-one', 1, session => session),
            error => error.code === 'copilot_session_conflict',
        );
    });
});
