import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { StoryStudioError, StoryStudioStore } from '../src/story-studio-store.js';

const LOCAL_HOST = '127.0.0.1:8123';
let rootDirectory;

function hasCode(code, details = {}) {
    return error => {
        assert.ok(error instanceof StoryStudioError);
        assert.equal(error.code, code);
        for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details[key], value);
        return true;
    };
}

function createThreeChapters(store) {
    const created = store.createProject({ title: '章节管理测试' });
    const second = store.createChapter(created.project.id, created.project.version, { title: '第二章', content: '乙' });
    const third = store.createChapter(created.project.id, second.project.version, { title: '第三章', content: '丙' });
    return {
        project: third.project,
        chapters: [created.chapter, second.chapter, third.chapter],
    };
}

async function csrfFor(app) {
    const response = await request(app).get('/api/bootstrap').set('Host', LOCAL_HOST).expect(200);
    return response.body.csrfToken;
}

beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-chapter-management-'));
});

afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('chapter management storage', () => {
    test('reorders every chapter exactly once and keeps file numbers, summaries, and revisions consistent', () => {
        const store = new StoryStudioStore(rootDirectory);
        const created = createThreeChapters(store);
        const [first, second, third] = created.chapters;
        const project = store.updateProject(created.project.id, created.project.version, {
            continuity: [{
                id: 'ledger-1',
                category: 'setting',
                label: '第一章线索',
                detail: '',
                status: 'active',
                firstSeenChapter: 1,
                lastTouchedChapter: 3,
            }],
        });
        const result = store.reorderChapters(project.id, project.version, [third.id, first.id, second.id]);

        assert.equal(result.project.version, project.version + 1);
        assert.deepEqual(result.project.chapters.map(chapter => chapter.id), [third.id, first.id, second.id]);
        assert.deepEqual(result.project.chapters.map(chapter => chapter.number), [1, 2, 3]);
        assert.deepEqual(result.chapters.map(chapter => chapter.number), [1, 2, 3]);
        assert.deepEqual(result.chapters.map(chapter => chapter.revision), [2, 2, 2]);
        assert.equal(result.project.continuity[0].firstSeenChapter, 2);
        assert.equal(result.project.continuity[0].lastTouchedChapter, 1);
        for (const chapter of result.chapters) {
            const stored = store.getChapter(project.id, chapter.id);
            assert.equal(stored.number, chapter.number);
            assert.equal(stored.revision, chapter.revision);
        }
        assert.deepEqual(store.getProject(project.id).chapters, result.project.chapters);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);

        const unchanged = store.reorderChapters(
            project.id,
            result.project.version,
            result.project.chapters.map(chapter => chapter.id),
        );
        assert.equal(unchanged.project.version, result.project.version);
        assert.deepEqual(unchanged.chapters.map(chapter => chapter.revision), result.chapters.map(chapter => chapter.revision));
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);
    });

    test('rejects stale, duplicate, missing, and foreign reorder ids without changing storage', () => {
        const store = new StoryStudioStore(rootDirectory);
        const { project, chapters: [first, second, third] } = createThreeChapters(store);
        const other = store.createProject({ title: '另一项目' });
        const projectPath = store.projectPath(project.id);
        const chapterDirectory = path.dirname(store.chapterPath(project.id, first.id));
        const beforeProject = fs.readFileSync(projectPath, 'utf8');
        const beforeChapters = new Map(fs.readdirSync(chapterDirectory).map(file => [file, fs.readFileSync(path.join(chapterDirectory, file), 'utf8')]));

        assert.throws(
            () => store.reorderChapters(project.id, project.version - 1, [first.id, second.id, third.id]),
            hasCode('project_conflict', { currentVersion: project.version }),
        );
        assert.throws(
            () => store.reorderChapters(project.id, project.version, [first.id, first.id, third.id]),
            hasCode('duplicate_chapter_id'),
        );
        assert.throws(
            () => store.reorderChapters(project.id, project.version, [first.id, second.id]),
            hasCode('invalid_chapter_order', { missingIds: [third.id], unknownIds: [] }),
        );
        assert.throws(
            () => store.reorderChapters(project.id, project.version, [first.id, second.id, other.chapter.id]),
            hasCode('invalid_chapter_order', { missingIds: [third.id], unknownIds: [other.chapter.id] }),
        );
        assert.equal(fs.readFileSync(projectPath, 'utf8'), beforeProject);
        assert.deepEqual(
            new Map(fs.readdirSync(chapterDirectory).map(file => [file, fs.readFileSync(path.join(chapterDirectory, file), 'utf8')])),
            beforeChapters,
        );
    });

    test('deletes a chapter, detaches story-state references, renumbers successors, and selects the nearest chapter', () => {
        const store = new StoryStudioStore(rootDirectory);
        const created = createThreeChapters(store);
        const [first, second, third] = created.chapters;
        const project = store.updateProject(created.project.id, created.project.version, {
            storyState: {
                entities: [],
                relations: [],
                events: [{ id: 'event-1', title: '中章事件', chapterId: second.id }],
                promises: [{
                    id: 'promise-1',
                    title: '中章伏笔',
                    introducedChapterId: second.id,
                    dueChapterId: second.id,
                    resolvedChapterId: second.id,
                }],
                memory: [{ id: 'memory-1', summary: '中章记忆', chapterId: second.id }],
            },
            continuity: [{
                id: 'ledger-1',
                category: 'plot',
                label: '中章到末章',
                detail: '',
                status: 'active',
                firstSeenChapter: 2,
                lastTouchedChapter: 3,
            }],
        });

        assert.throws(
            () => store.deleteChapter(project.id, second.id, project.version, second.revision + 1),
            hasCode('chapter_conflict', { currentRevision: second.revision, currentProjectVersion: project.version }),
        );
        const result = store.deleteChapter(project.id, second.id, project.version, second.revision);
        assert.deepEqual(result.deleted, { id: second.id, number: 2 });
        assert.equal(result.activeChapterId, third.id);
        assert.deepEqual(result.project.chapters.map(chapter => chapter.id), [first.id, third.id]);
        assert.deepEqual(result.project.chapters.map(chapter => chapter.number), [1, 2]);
        assert.equal(fs.existsSync(store.chapterPath(project.id, second.id)), false);
        assert.equal(store.getChapter(project.id, first.id).revision, first.revision);
        const renumbered = store.getChapter(project.id, third.id);
        assert.equal(renumbered.number, 2);
        assert.equal(renumbered.revision, third.revision + 1);
        assert.equal(result.project.storyState.events[0].chapterId, null);
        assert.equal(result.project.storyState.promises[0].introducedChapterId, null);
        assert.equal(result.project.storyState.promises[0].dueChapterId, null);
        assert.equal(result.project.storyState.promises[0].resolvedChapterId, null);
        assert.equal(result.project.storyState.memory[0].chapterId, null);
        assert.equal(result.project.continuity[0].firstSeenChapter, 0);
        assert.equal(result.project.continuity[0].lastTouchedChapter, 2);
    });

    test('does not delete the last chapter or a chapter belonging to another project', () => {
        const store = new StoryStudioStore(rootDirectory);
        const first = store.createProject({ title: '保底章节' });
        const other = store.createProject({ title: '另一作品' });

        assert.throws(
            () => store.deleteChapter(first.project.id, other.chapter.id, first.project.version, other.chapter.revision),
            hasCode('not_found'),
        );
        assert.throws(
            () => store.deleteChapter(first.project.id, first.chapter.id, first.project.version, first.chapter.revision),
            hasCode('last_chapter_required', {
                currentProjectVersion: first.project.version,
                chapterId: first.chapter.id,
            }),
        );
        assert.equal(store.getProject(first.project.id).chapters.length, 1);
        assert.equal(fs.existsSync(store.chapterPath(first.project.id, first.chapter.id)), true);
    });

    test('rejects a chapter-operation commit whose target skips the base project version', () => {
        const store = new StoryStudioStore(rootDirectory);
        const { project, chapters: [first, second, third] } = createThreeChapters(store);
        const commit = store.commitProjectAndChapterOperations;
        store.commitProjectAndChapterOperations = function (...args) {
            args[0].version += 1;
            return commit.call(this, ...args);
        };
        try {
            assert.throws(
                () => store.reorderChapters(project.id, project.version, [third.id, second.id, first.id]),
                hasCode('invalid_storage'),
            );
        } finally {
            store.commitProjectAndChapterOperations = commit;
        }

        const persisted = store.getProject(project.id);
        assert.equal(persisted.version, project.version);
        assert.deepEqual(persisted.chapters.map(chapter => chapter.id), [first.id, second.id, third.id]);
        assert.deepEqual([first.id, second.id, third.id].map(id => store.getChapter(project.id, id).number), [1, 2, 3]);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);
    });

    test('recovers a reorder after only part of its chapter files were written', () => {
        const store = new StoryStudioStore(rootDirectory);
        const { project, chapters: [first, second, third] } = createThreeChapters(store);
        const apply = store.applyChapterOperations.bind(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations.slice(0, 1), lock);
            throw new Error('simulated crash after first chapter write');
        };
        assert.throws(
            () => store.reorderChapters(project.id, project.version, [third.id, second.id, first.id]),
            /simulated crash/,
        );
        store.applyChapterOperations = apply;
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), true);

        const recoveredProject = store.getProject(project.id);
        assert.deepEqual(recoveredProject.chapters.map(chapter => chapter.id), [third.id, second.id, first.id]);
        assert.deepEqual([third.id, second.id, first.id].map(id => store.getChapter(project.id, id).number), [1, 2, 3]);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);
    });

    test('recovers a pending reorder from a normalized V3 base without raw chapterBytes', () => {
        const store = new StoryStudioStore(rootDirectory);
        const { project, chapters: [first, second, third] } = createThreeChapters(store);
        const rawProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        delete rawProject.chapterBytes;
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(rawProject), 'utf8');
        const apply = store.applyChapterOperations.bind(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations.slice(0, 1), lock);
            throw new Error('simulated crash with legacy V3 project');
        };
        assert.throws(
            () => store.reorderChapters(project.id, project.version, [third.id, second.id, first.id]),
            /simulated crash with legacy V3 project/,
        );
        store.applyChapterOperations = apply;

        const journalPath = store.chapterOperationsJournalPath(project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')), 'chapterBytes'), false);
        assert.equal(journal.baseProjectChapterBytes, project.chapterBytes);
        const recovered = store.getProject(project.id);
        assert.deepEqual(recovered.chapters.map(chapter => chapter.id), [third.id, second.id, first.id]);
        assert.deepEqual([third.id, second.id, first.id].map(id => store.getChapter(project.id, id).number), [1, 2, 3]);
        assert.equal(fs.existsSync(journalPath), false);
    });

    test('recovers a deletion when chapter files changed but project.json did not', () => {
        const store = new StoryStudioStore(rootDirectory);
        const { project, chapters: [first, second, third] } = createThreeChapters(store);
        const apply = store.applyChapterOperations.bind(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations, lock);
            throw new Error('simulated crash before project commit');
        };
        assert.throws(
            () => store.deleteChapter(project.id, second.id, project.version, second.revision),
            /simulated crash/,
        );
        store.applyChapterOperations = apply;
        assert.equal(fs.existsSync(store.chapterPath(project.id, second.id)), false);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), true);

        const recoveredProject = store.getProject(project.id);
        assert.deepEqual(recoveredProject.chapters.map(chapter => chapter.id), [first.id, third.id]);
        assert.deepEqual(recoveredProject.chapters.map(chapter => chapter.number), [1, 2]);
        assert.equal(store.getChapter(project.id, third.id).number, 2);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);
    });

    test('requires all target chapters once the target project index is published', () => {
        const store = new StoryStudioStore(rootDirectory);
        const apply = store.applyChapterOperations.bind(store);

        const incomplete = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop before chapter publish'); };
        assert.throws(
            () => store.reorderChapters(
                incomplete.project.id,
                incomplete.project.version,
                [...incomplete.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop before chapter publish/,
        );
        store.applyChapterOperations = apply;
        const incompleteJournalPath = store.chapterOperationsJournalPath(incomplete.project.id);
        const incompleteJournal = JSON.parse(fs.readFileSync(incompleteJournalPath, 'utf8'));
        const baseChapterText = fs.readFileSync(
            store.chapterPath(incomplete.project.id, incomplete.chapters[0].id),
            'utf8',
        );
        fs.writeFileSync(store.projectPath(incomplete.project.id), JSON.stringify(incompleteJournal.project), 'utf8');
        assert.throws(
            () => store.getProject(incomplete.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.readFileSync(
            store.chapterPath(incomplete.project.id, incomplete.chapters[0].id),
            'utf8',
        ), baseChapterText);
        assert.equal(fs.existsSync(incompleteJournalPath), true);

        const complete = createThreeChapters(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations, lock);
            throw new Error('stop after all chapter files');
        };
        assert.throws(
            () => store.reorderChapters(
                complete.project.id,
                complete.project.version,
                [...complete.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop after all chapter files/,
        );
        store.applyChapterOperations = apply;
        const completeJournalPath = store.chapterOperationsJournalPath(complete.project.id);
        const completeJournal = JSON.parse(fs.readFileSync(completeJournalPath, 'utf8'));
        fs.writeFileSync(store.projectPath(complete.project.id), JSON.stringify(completeJournal.project), 'utf8');
        assert.deepEqual(
            store.getProject(complete.project.id).chapters.map(chapter => chapter.id),
            [...complete.chapters].reverse().map(chapter => chapter.id),
        );
        assert.equal(fs.existsSync(completeJournalPath), false);
    });

    test('blocks divergent chapter files in both base and target project states', () => {
        const store = new StoryStudioStore(rootDirectory);
        const apply = store.applyChapterOperations.bind(store);

        const baseState = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop with base project'); };
        assert.throws(
            () => store.reorderChapters(
                baseState.project.id,
                baseState.project.version,
                [...baseState.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop with base project/,
        );
        store.applyChapterOperations = apply;
        const baseJournalPath = store.chapterOperationsJournalPath(baseState.project.id);
        const baseDivergentPath = store.chapterPath(baseState.project.id, baseState.chapters[1].id);
        const baseDivergent = JSON.parse(fs.readFileSync(baseDivergentPath, 'utf8'));
        baseDivergent.content = '丁';
        fs.writeFileSync(baseDivergentPath, JSON.stringify(baseDivergent), 'utf8');
        assert.throws(
            () => store.getProject(baseState.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(JSON.parse(fs.readFileSync(baseDivergentPath, 'utf8')).content, '丁');
        assert.equal(fs.existsSync(baseJournalPath), true);

        const targetState = createThreeChapters(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations, lock);
            throw new Error('stop with target files');
        };
        assert.throws(
            () => store.reorderChapters(
                targetState.project.id,
                targetState.project.version,
                [...targetState.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop with target files/,
        );
        store.applyChapterOperations = apply;
        const targetJournalPath = store.chapterOperationsJournalPath(targetState.project.id);
        const targetJournal = JSON.parse(fs.readFileSync(targetJournalPath, 'utf8'));
        fs.writeFileSync(store.projectPath(targetState.project.id), JSON.stringify(targetJournal.project), 'utf8');
        const targetOperation = targetJournal.operations.find(item => item.chapter?.content === '乙');
        const targetDivergentPath = store.chapterPath(targetState.project.id, targetOperation.chapterId);
        const targetDivergent = JSON.parse(fs.readFileSync(targetDivergentPath, 'utf8'));
        targetDivergent.content = '丁';
        fs.writeFileSync(targetDivergentPath, JSON.stringify(targetDivergent), 'utf8');
        assert.throws(
            () => store.getProject(targetState.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(JSON.parse(fs.readFileSync(targetDivergentPath, 'utf8')).content, '丁');
        assert.equal(fs.existsSync(targetJournalPath), true);
    });

    test('rejects unrelated and unknown target project fields in chapter operation journals', () => {
        const store = new StoryStudioStore(rootDirectory);
        const apply = store.applyChapterOperations.bind(store);
        const created = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop before project validation'); };
        assert.throws(
            () => store.reorderChapters(
                created.project.id,
                created.project.version,
                [...created.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop before project validation/,
        );
        store.applyChapterOperations = apply;
        const journalPath = store.chapterOperationsJournalPath(created.project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const originalTitle = journal.project.title;
        journal.project.title = '日志不应修改标题';
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');
        assert.throws(() => store.getProject(created.project.id), hasCode('invalid_storage'));
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(created.project.id), 'utf8')).title, originalTitle);

        journal.project.title = originalTitle;
        journal.project.unexpected = true;
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');
        assert.throws(() => store.getProject(created.project.id), hasCode('invalid_storage'));
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('rejects moved chapter content that is not derived from the recorded base file', () => {
        const store = new StoryStudioStore(rootDirectory);
        const apply = store.applyChapterOperations.bind(store);
        const created = createThreeChapters(store);
        const [, second, third] = created.chapters;
        store.applyChapterOperations = () => { throw new Error('stop before moved chapter publish'); };
        assert.throws(
            () => store.reorderChapters(
                created.project.id,
                created.project.version,
                [second.id, third.id, created.chapters[0].id],
            ),
            /stop before moved chapter publish/,
        );
        store.applyChapterOperations = apply;

        const journalPath = store.chapterOperationsJournalPath(created.project.id);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const movedOperation = journal.operations.find(item => item.chapterId === second.id);
        movedOperation.chapter.content = '丁';
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');

        assert.throws(() => store.getProject(created.project.id), hasCode('invalid_storage'));
        assert.equal(JSON.parse(fs.readFileSync(
            store.chapterPath(created.project.id, second.id),
            'utf8',
        )).content, '乙');
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('rejects unsafe journals and blocks fail-open recovery after partial writes diverge', t => {
        t.mock.method(console, 'warn', () => {});
        const store = new StoryStudioStore(rootDirectory);
        const apply = store.applyChapterOperations.bind(store);

        const zeroTarget = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop before journal operations'); };
        assert.throws(
            () => store.deleteChapter(
                zeroTarget.project.id,
                zeroTarget.chapters[1].id,
                zeroTarget.project.version,
                zeroTarget.chapters[1].revision,
            ),
            /stop before journal operations/,
        );
        store.applyChapterOperations = apply;
        const zeroJournalPath = store.chapterOperationsJournalPath(zeroTarget.project.id);
        const zeroJournal = JSON.parse(fs.readFileSync(zeroJournalPath, 'utf8'));
        zeroJournal.project.chapters = [];
        zeroJournal.project.chapterBytes = 0;
        zeroJournal.operations = zeroJournal.baseChapterIds.map(chapterId => ({
            operation: 'delete', chapterId, chapter: null,
        }));
        fs.writeFileSync(zeroJournalPath, JSON.stringify(zeroJournal), 'utf8');
        assert.throws(
            () => store.getProject(zeroTarget.project.id),
            hasCode('invalid_storage'),
        );
        assert.equal(fs.existsSync(store.chapterPath(zeroTarget.project.id, zeroTarget.chapters[0].id)), true);
        fs.rmSync(zeroJournalPath, { force: true });

        const oversized = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop before oversized recovery'); };
        assert.throws(
            () => store.deleteChapter(
                oversized.project.id,
                oversized.chapters[1].id,
                oversized.project.version,
                oversized.chapters[1].revision,
            ),
            /stop before oversized recovery/,
        );
        store.applyChapterOperations = apply;
        const oversizedJournalPath = store.chapterOperationsJournalPath(oversized.project.id);
        const oversizedJournal = JSON.parse(fs.readFileSync(oversizedJournalPath, 'utf8'));
        const oversizedWrite = oversizedJournal.operations.find(item => item.operation === 'write');
        oversizedWrite.chapter.content = 'x'.repeat(11 * 1024 * 1024);
        oversizedWrite.chapter.wordCount = 1;
        const oversizedSummary = oversizedJournal.project.chapters.find(item => item.id === oversizedWrite.chapterId);
        oversizedSummary.wordCount = 1;
        oversizedJournal.project.chapterBytes = oversizedJournal.operations
            .filter(item => item.operation === 'write')
            .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.chapter), 'utf8'), 0);
        fs.writeFileSync(oversizedJournalPath, JSON.stringify(oversizedJournal), 'utf8');
        assert.throws(
            () => store.getProject(oversized.project.id),
            hasCode('invalid_storage'),
        );
        fs.rmSync(oversizedJournalPath, { force: true });

        const branched = createThreeChapters(store);
        store.applyChapterOperations = () => { throw new Error('stop before branch recovery'); };
        assert.throws(
            () => store.reorderChapters(
                branched.project.id,
                branched.project.version,
                [...branched.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop before branch recovery/,
        );
        store.applyChapterOperations = apply;
        const branchedJournalPath = store.chapterOperationsJournalPath(branched.project.id);
        const branchedProject = JSON.parse(fs.readFileSync(store.projectPath(branched.project.id), 'utf8'));
        branchedProject.title = '同版本的另一分支';
        fs.writeFileSync(store.projectPath(branched.project.id), JSON.stringify(branchedProject), 'utf8');
        assert.equal(store.getProject(branched.project.id).title, '同版本的另一分支');
        assert.equal(fs.existsSync(branchedJournalPath), false);
        assert.equal(fs.readdirSync(store.projectDirectory(branched.project.id)).some(name => (
            name.startsWith('.pending-chapter-operations.conflict-')
        )), true);

        const divergent = createThreeChapters(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            apply(projectId, operations.slice(0, 1), lock);
            throw new Error('stop after partial divergent write');
        };
        assert.throws(
            () => store.reorderChapters(
                divergent.project.id,
                divergent.project.version,
                [...divergent.chapters].reverse().map(chapter => chapter.id),
            ),
            /stop after partial divergent write/,
        );
        store.applyChapterOperations = apply;
        const divergentJournalPath = store.chapterOperationsJournalPath(divergent.project.id);
        const divergentJournal = JSON.parse(fs.readFileSync(divergentJournalPath, 'utf8'));
        const newerProject = JSON.parse(fs.readFileSync(store.projectPath(divergent.project.id), 'utf8'));
        newerProject.version = divergentJournal.project.version + 1;
        newerProject.title = '并发写入后的新项目';
        fs.writeFileSync(store.projectPath(divergent.project.id), JSON.stringify(newerProject), 'utf8');
        assert.throws(
            () => store.getProject(divergent.project.id),
            error => error instanceof StoryStudioError
                && error.code === 'stale_journal'
                && error.details.recoveryBlocked === true,
        );
        assert.equal(fs.existsSync(divergentJournalPath), true);
    });
});

describe('chapter management HTTP contract', () => {
    test('reorders and deletes chapters with explicit response contracts', async () => {
        const app = createApp({ dataRoot: rootDirectory });
        const csrfToken = await csrfFor(app);
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: 'HTTP章节管理' })
            .expect(201);
        const second = await request(app)
            .post(`/api/story-studio/projects/${created.body.project.id}/chapters`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: created.body.project.version, chapter: { title: '第二章' } })
            .expect(201);
        const third = await request(app)
            .post(`/api/story-studio/projects/${created.body.project.id}/chapters`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: second.body.project.version, chapter: { title: '第三章' } })
            .expect(201);

        const reordered = await request(app)
            .post(`/api/story-studio/projects/${created.body.project.id}/chapters/reorder`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: third.body.project.version,
                chapterIds: [third.body.chapter.id, created.body.chapter.id, second.body.chapter.id],
            })
            .expect(200);
        assert.deepEqual(Object.keys(reordered.body).sort(), ['chapters', 'project']);
        assert.deepEqual(reordered.body.chapters.map(chapter => chapter.number), [1, 2, 3]);

        const removedChapter = reordered.body.chapters[1];
        const deleted = await request(app)
            .delete(`/api/story-studio/projects/${created.body.project.id}/chapters/${removedChapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({
                projectVersion: reordered.body.project.version,
                chapterRevision: removedChapter.revision,
                activeChapterId: third.body.chapter.id,
            })
            .expect(200);
        assert.deepEqual(Object.keys(deleted.body).sort(), ['activeChapter', 'activeChapterId', 'deleted', 'project']);
        assert.deepEqual(deleted.body.deleted, { id: removedChapter.id, number: 2 });
        assert.equal(deleted.body.activeChapterId, third.body.chapter.id);
        assert.equal(deleted.body.activeChapter.id, third.body.chapter.id);
        assert.deepEqual(deleted.body.project.chapters.map(chapter => chapter.number), [1, 2]);
    });

    test('returns stable validation, conflict, and last-chapter errors', async () => {
        const app = createApp({ dataRoot: rootDirectory });
        const csrfToken = await csrfFor(app);
        const created = await request(app)
            .post('/api/story-studio/projects')
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ title: 'HTTP错误合同' })
            .expect(201);
        const base = `/api/story-studio/projects/${created.body.project.id}`;

        const invalid = await request(app)
            .post(`${base}/chapters/reorder`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: created.body.project.version, chapterIds: [] })
            .expect(400);
        assert.equal(invalid.body.error, 'invalid_chapter_order');
        assert.deepEqual(invalid.body.missingIds, [created.body.chapter.id]);

        const stale = await request(app)
            .delete(`${base}/chapters/${created.body.chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: created.body.project.version - 1, chapterRevision: created.body.chapter.revision })
            .expect(409);
        assert.equal(stale.body.error, 'project_conflict');

        const last = await request(app)
            .delete(`${base}/chapters/${created.body.chapter.id}`)
            .set('Host', LOCAL_HOST)
            .set('X-CSRF-Token', csrfToken)
            .send({ projectVersion: created.body.project.version, chapterRevision: created.body.chapter.revision })
            .expect(409);
        assert.equal(last.body.error, 'last_chapter_required');
        assert.equal(last.body.message, '作品必须保留至少一章。');
        assert.equal(last.body.chapterId, created.body.chapter.id);
        assert.equal(last.body.currentProjectVersion, created.body.project.version);
    });
});
