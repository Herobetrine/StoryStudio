import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { GenerationStore, GenerationStoreError } from '../src/generation-store.js';

describe('persistent generation history', () => {
    let root;
    let store;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-generations-'));
        store = new GenerationStore(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('keeps generate, regenerate, and continue candidates as separate records', () => {
        const first = store.createGeneration({
            projectId: 'project-one',
            chapterId: 'chapter-one',
            kind: 'draft',
            request: { promptDigest: 'a'.repeat(64), diagnostics: { activatedLore: ['gate'] } },
        });
        const completed = store.finishGeneration('project-one', 'chapter-one', first.id, {
            content: '第一版正文',
            finishReason: 'stop',
            model: 'writer-model',
            usage: { total_tokens: 120 },
        });
        const regenerated = store.createGeneration({
            projectId: 'project-one',
            chapterId: 'chapter-one',
            kind: 'draft',
            mode: 'regenerate',
            parentId: first.id,
        });
        const continued = store.createGeneration({
            projectId: 'project-one',
            chapterId: 'chapter-one',
            kind: 'draft',
            mode: 'continue',
            parentId: first.id,
        });

        assert.equal(completed.content, '第一版正文');
        assert.notEqual(regenerated.id, first.id);
        assert.notEqual(continued.id, first.id);
        assert.deepEqual(store.listGenerations('project-one', 'chapter-one').map(item => item.id).sort(),
            [first.id, regenerated.id, continued.id].sort());
        assert.equal(store.getGeneration('project-one', 'chapter-one', first.id).request.diagnostics.activatedLore[0], 'gate');
    });

    test('preserves partial output after cancellation or provider failure', () => {
        const generation = store.createGeneration({
            projectId: 'project-two', chapterId: 'chapter-two', kind: 'draft',
        });
        const partial = store.finishGeneration('project-two', 'chapter-two', generation.id, {
            status: 'partial',
            content: '门刚推开，',
            finishReason: 'aborted',
            error: 'Generation stopped by the user.',
        });
        assert.equal(partial.status, 'partial');
        assert.equal(store.getGeneration('project-two', 'chapter-two', generation.id).content, '门刚推开，');
    });

    test('stores selection editing tools in the same candidate history', () => {
        for (const kind of ['polish', 'rewrite', 'expand', 'brainstorm']) {
            const generation = store.createGeneration({ projectId: 'editing', chapterId: 'chapter', kind });
            store.finishGeneration('editing', 'chapter', generation.id, { content: `${kind} result` });
        }
        assert.deepEqual(
            new Set(store.listGenerations('editing', 'chapter').map(item => item.kind)),
            new Set(['polish', 'rewrite', 'expand', 'brainstorm']),
        );
    });

    test('stores a side-effect-free distillation and records later adoption', () => {
        const generation = store.createGeneration({
            projectId: 'project-three', chapterId: 'chapter-three', kind: 'draft',
        });
        store.finishGeneration('project-three', 'chapter-three', generation.id, { content: '正文' });
        const distilled = store.saveDistillation('project-three', 'chapter-three', generation.id, {
            status: 'ready',
            raw: '{"chapterSummary":"入城"}',
            changes: {
                chapterSummary: '主角进入城门。',
                events: [{ id: 'event-gate', title: '进入城门' }],
            },
        });
        assert.equal(distilled.status, 'completed');
        assert.equal(distilled.distillation.changes.events[0].id, 'event-gate');

        const adopted = store.markAdopted('project-three', 'chapter-three', generation.id);
        assert.equal(adopted.status, 'adopted');
        assert.ok(adopted.adoptedAt);
    });

    test('rejects traversal identifiers, mismatched parents, and corrupt path identities', () => {
        assert.throws(
            () => store.createGeneration({ projectId: '..', chapterId: 'chapter', kind: 'draft' }),
            error => error instanceof GenerationStoreError && error.code === 'invalid_id',
        );
        const parent = store.createGeneration({ projectId: 'project', chapterId: 'chapter', kind: 'plan' });
        assert.throws(
            () => store.createGeneration({
                projectId: 'project', chapterId: 'chapter', kind: 'draft', mode: 'continue', parentId: parent.id,
            }),
            error => error.code === 'invalid_generation_parent',
        );

        const filePath = store.generationPath('project', 'chapter', parent.id);
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        value.projectId = 'other-project';
        fs.writeFileSync(filePath, JSON.stringify(value));
        assert.throws(
            () => store.getGeneration('project', 'chapter', parent.id),
            error => error.code === 'invalid_generation_storage',
        );
    });
});
