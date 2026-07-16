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

    test('does not follow project or distillation directory links outside its storage root', t => {
        const externalRoot = path.join(root, 'external-root');
        const linkedRoot = path.join(root, 'linked-root');
        const externalProject = path.join(root, '..', `${path.basename(root)}-external-project`);
        const externalChapter = path.join(root, '..', `${path.basename(root)}-external-chapter`);
        const externalDistillations = path.join(root, '..', `${path.basename(root)}-external-distillations`);
        t.after(() => {
            fs.rmSync(externalProject, { recursive: true, force: true });
            fs.rmSync(externalChapter, { recursive: true, force: true });
            fs.rmSync(externalDistillations, { recursive: true, force: true });
        });
        fs.mkdirSync(externalRoot);
        fs.symlinkSync(externalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(
            () => new GenerationStore(linkedRoot),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalRoot), []);
        assert.throws(
            () => store.storagePath('..', 'lexical-escape'),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        const replacedRoot = path.join(root, 'replaceable-root');
        const externalReplacedRoot = path.join(root, 'external-replaced-root');
        const replacedStore = new GenerationStore(replacedRoot);
        fs.mkdirSync(externalReplacedRoot);
        fs.rmSync(replacedRoot, { recursive: true });
        fs.symlinkSync(
            externalReplacedRoot,
            replacedRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        assert.throws(
            () => replacedStore.createGeneration({
                projectId: 'project',
                chapterId: 'chapter',
                kind: 'draft',
            }),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalReplacedRoot), []);

        fs.mkdirSync(externalProject, { recursive: true });
        fs.symlinkSync(
            externalProject,
            path.join(root, 'linked-project'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        assert.throws(
            () => store.createGeneration({
                projectId: 'linked-project',
                chapterId: 'chapter',
                kind: 'draft',
            }),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalProject), []);

        fs.mkdirSync(path.join(root, 'chapter-linked-project'));
        fs.mkdirSync(externalChapter);
        fs.symlinkSync(
            externalChapter,
            path.join(root, 'chapter-linked-project', 'linked-chapter'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        assert.throws(
            () => store.createGeneration({
                projectId: 'chapter-linked-project',
                chapterId: 'linked-chapter',
                kind: 'draft',
            }),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalChapter), []);

        const generation = store.createGeneration({
            projectId: 'safe-project',
            chapterId: 'chapter',
            kind: 'draft',
        });
        store.finishGeneration('safe-project', 'chapter', generation.id, { content: '正文' });
        fs.mkdirSync(externalDistillations, { recursive: true });
        fs.symlinkSync(
            externalDistillations,
            store.workflowDistillationDirectory('safe-project', 'chapter', generation.id),
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        assert.throws(
            () => store.saveWorkflowDistillation(
                'safe-project',
                'chapter',
                generation.id,
                'b'.repeat(64),
                {
                    slotDigest: 'b'.repeat(64),
                    status: 'ready',
                    changes: {},
                    raw: '',
                    error: '',
                    workflowGeneration: { id: 'workflow-generation' },
                },
            ),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalDistillations), []);

    });

    test('rejects writes after an ancestor of the guarded storage root is replaced', t => {
        const container = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-generation-ancestor-'));
        const parentDirectory = path.join(container, 'data-root');
        const originalParent = path.join(container, 'data-root-original');
        const externalParent = path.join(container, 'external-data-root');
        const guardedRoot = path.join(parentDirectory, 'generations');
        const externalGuardedRoot = path.join(externalParent, 'generations');
        t.after(() => fs.rmSync(container, { recursive: true, force: true }));
        const guardedStore = new GenerationStore(guardedRoot);
        fs.mkdirSync(externalGuardedRoot, { recursive: true });
        fs.renameSync(parentDirectory, originalParent);
        fs.symlinkSync(
            externalParent,
            parentDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        assert.throws(
            () => guardedStore.createGeneration({
                projectId: 'project',
                chapterId: 'chapter',
                kind: 'draft',
            }),
            error => error instanceof GenerationStoreError && error.code === 'unsafe_generation_path',
        );
        assert.deepEqual(fs.readdirSync(externalGuardedRoot), []);
    });
});
