import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { STORY_STUDIO_SCHEMA_VERSION, StoryStudioError, StoryStudioStore } from '../src/story-studio-store.js';

let rootDirectory;
let store;

function hasCode(code, extra = {}) {
    return error => {
        assert.ok(error instanceof StoryStudioError);
        assert.equal(error.code, code);
        for (const [key, value] of Object.entries(extra)) assert.deepEqual(error.details[key], value);
        return true;
    };
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
    return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function digestWithout(value, fields) {
    const invariant = structuredClone(value);
    for (const field of fields) delete invariant[field];
    return digest(invariant);
}

function pendingWriteJournal(transactionId, baseProject, baseChapter, project, chapter) {
    return {
        transactionId,
        baseProjectVersion: baseProject.version,
        baseProjectDigest: digest(baseProject),
        baseProjectInvariantDigest: digestWithout(
            baseProject,
            ['chapters', 'chapterBytes', 'storyState', 'version', 'updatedAt'],
        ),
        baseChapterIds: baseProject.chapters.map(item => item.id),
        baseProjectChapterBytes: baseProject.chapterBytes,
        baseChapterDigest: baseChapter ? digest(baseChapter) : null,
        baseChapterBytes: baseChapter ? Buffer.byteLength(JSON.stringify(baseChapter), 'utf8') : 0,
        baseChapterRevision: baseChapter ? baseChapter.revision : null,
        baseChapterNumber: baseChapter ? baseChapter.number : null,
        baseChapterCreatedAt: baseChapter ? baseChapter.createdAt : null,
        ...(baseProject.schemaVersion === STORY_STUDIO_SCHEMA_VERSION ? {
            baseChapterVolumeId: baseChapter?.volumeId ?? null,
            baseChapterPlanBasis: baseChapter?.planBasis ?? null,
        } : {}),
        project,
        chapter,
    };
}

beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-store-'));
    store = new StoryStudioStore(rootDirectory);
});

afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('StoryStudioStore compatibility contract', () => {
    test('1. creates an isolated project with its first chapter', () => {
        const { project, chapter } = store.createProject({ title: '新书', genre: '悬疑' });
        assert.equal(project.title, '新书');
        assert.equal(project.version, 1);
        assert.equal(project.chapters.length, 1);
        assert.equal(chapter.projectId, project.id);
        assert.equal(chapter.revision, 1);
        assert.deepEqual(store.listProjects().map(item => item.id), [project.id]);
    });

    test('2. saves chapter content and updates the project index', () => {
        const { project, chapter } = store.createProject({ title: '写作测试' });
        const result = store.updateChapter(project.id, chapter.id, project.version, chapter.revision, {
            title: '雨夜入城',
            status: 'drafting',
            content: '雨落长街。He ran.',
            card: { hook: '城门在身后关闭。' },
        });
        assert.equal(result.chapter.revision, 2);
        assert.equal(result.chapter.wordCount, 6);
        assert.deepEqual(result.project.chapters[0], {
            ...result.project.chapters[0],
            title: '雨夜入城',
            status: 'drafting',
            wordCount: 6,
        });
        assert.equal(store.getChapter(project.id, chapter.id).content, '雨落长街。He ran.');
    });

    test('3. rejects stale project and chapter versions', () => {
        const { project, chapter } = store.createProject({ title: '冲突测试' });
        store.updateChapter(project.id, chapter.id, project.version, chapter.revision, { content: '第一稿' });
        assert.throws(
            () => store.updateChapter(project.id, chapter.id, project.version, chapter.revision, { content: '旧窗口' }),
            hasCode('project_conflict', { currentVersion: 2 }),
        );
        assert.throws(() => store.updateProject(project.id, project.version, { genre: '玄幻' }), hasCode('project_conflict'));
    });

    test('4. exports and imports a complete project with fresh identifiers', async () => {
        const { project, chapter } = store.createProject({ title: '长篇样本', story: { premise: '城依靠谎言维持秩序。' } });
        const first = store.updateChapter(project.id, chapter.id, project.version, chapter.revision, { content: '第一章正文' });
        store.createChapter(project.id, first.project.version, { title: '第二章', content: '第二章正文' });
        const imported = await store.importProject(await store.exportProject(project.id));
        assert.notEqual(imported.project.id, project.id);
        assert.equal(imported.project.chapters.length, 2);
        assert.equal(imported.project.story.premise, '城依靠谎言维持秩序。');
        assert.notEqual(imported.chapter.id, chapter.id);
        assert.equal(imported.chapter.content, '第一章正文');
    });

    test('5. rejects unsupported imports without leaving a project behind', async () => {
        const { project } = store.createProject({ title: '原项目' });
        const payload = await store.exportProject(project.id);
        payload.schemaVersion = 999;
        await assert.rejects(() => store.importProject(payload), hasCode('unsupported_schema'));
        assert.equal(store.listProjects().length, 1);
    });

    test('6. rejects duplicate continuity ids during import', async () => {
        const { project } = store.createProject({ title: '重复线索基线' });
        const payload = await store.exportProject(project.id);
        payload.project.continuity = [
            { id: 'same-entry', category: 'character', label: '甲' },
            { id: 'same-entry', category: 'character', label: '乙' },
        ];
        await assert.rejects(
            () => store.importProject(payload),
            hasCode('duplicate_continuity_id', { id: 'same-entry', firstIndex: 0, duplicateIndex: 1 }),
        );
        assert.equal(store.listProjects().length, 1);
    });

    test('7. rejects unknown current-schema import fields', async () => {
        const { project } = store.createProject({ title: '严格导入基线' });
        const payload = await store.exportProject(project.id);
        payload.chapters[0].contents = payload.chapters[0].content;
        delete payload.chapters[0].content;
        await assert.rejects(() => store.importProject(payload), hasCode('unknown_fields'));
        assert.equal(store.listProjects().length, 1);
    });

    test('8. validates a complete import before creating a destination', async () => {
        const { project } = store.createProject({ title: '导入基线' });
        const payload = await store.exportProject(project.id);
        const source = payload.chapters[0];
        const sourceSummary = payload.project.chapters[0];
        payload.chapters = Array.from({ length: 55 }, (_, index) => ({
            ...source,
            id: `source-${index}`,
            number: index + 1,
            card: { ...source.card, summary: '设'.repeat(100_000) },
        }));
        payload.project.chapters = payload.chapters.map(chapter => ({
            ...sourceSummary,
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            status: chapter.status,
            summary: chapter.card.summary,
            volumeId: chapter.volumeId,
            planBasis: chapter.planBasis,
            wordCount: chapter.wordCount,
            updatedAt: chapter.updatedAt,
        }));
        await assert.rejects(() => store.importProject(payload), hasCode('payload_too_large'));
        assert.equal(store.listProjects().length, 1);
    });

    test('9. enforces the 3000 chapter limit without creating a file', () => {
        const { project } = store.createProject({ title: '章节上限测试' });
        const projectPath = store.projectPath(project.id);
        const stored = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        stored.chapters = Array.from({ length: store.maxProjectChapters }, (_, index) => ({ ...stored.chapters[0], number: index + 1 }));
        fs.writeFileSync(projectPath, JSON.stringify(stored), 'utf8');
        const chapterDirectory = path.join(store.projectDirectory(project.id), 'chapters');
        const before = fs.readdirSync(chapterDirectory);
        assert.throws(() => store.createChapter(project.id, project.version, { title: '越界章节' }), hasCode('chapter_limit_exceeded'));
        assert.deepEqual(fs.readdirSync(chapterDirectory), before);
    });

    test('10. rejects aggregate-byte overflow without changing stored data', () => {
        const { project, chapter } = store.createProject({ title: '更新容量测试' });
        const projectPath = store.projectPath(project.id);
        const chapterPath = store.chapterPath(project.id, chapter.id);
        const projectBefore = fs.readFileSync(projectPath, 'utf8');
        const chapterBefore = fs.readFileSync(chapterPath, 'utf8');
        store.maxProjectBytes = 10_000;
        assert.throws(
            () => store.updateChapter(project.id, chapter.id, project.version, chapter.revision, { content: '界'.repeat(5_000) }),
            hasCode('project_chapter_bytes_exceeded'),
        );
        assert.equal(fs.readFileSync(projectPath, 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterBefore);
    });

    test('11. reserves project and wrapper bytes inside the roundtrip limit', () => {
        const { project } = store.createProject({ title: '往返容量测试' });
        store.maxProjectBytes = project.chapterBytes + 100;
        assert.throws(() => store.getProject(project.id), hasCode('project_export_bytes_exceeded'));
    });

    test('12. export measures chapter data instead of trusting metadata', async () => {
        const { project, chapter } = store.createProject({ title: '导出容量测试' });
        const storedProject = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        const storedChapter = JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
        storedProject.chapterBytes = 1;
        storedChapter.content = 'x'.repeat(12_000);
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(storedProject), 'utf8');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(storedChapter), 'utf8');
        store.maxProjectBytes = 10_000;
        await assert.rejects(() => store.exportProject(project.id), hasCode('project_chapter_bytes_exceeded'));
    });

    test('13. rebuilds missing byte metadata and persists it on a later write', () => {
        const { project, chapter } = store.createProject({ title: '旧数据迁移测试' });
        const stored = JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8'));
        delete stored.chapterBytes;
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(stored), 'utf8');
        const rebuilt = store.getProject(project.id);
        const expected = Buffer.byteLength(JSON.stringify(store.getChapter(project.id, chapter.id)), 'utf8');
        assert.equal(rebuilt.chapterBytes, expected);
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')).chapterBytes, undefined);
        store.updateProject(project.id, rebuilt.version, { genre: '迁移后类型' });
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')).chapterBytes, expected);
    });

    test('14. rejects malformed input and unknown patch fields', () => {
        const { project, chapter } = store.createProject({ title: '校验测试' });
        assert.throws(() => store.createChapter(project.id, project.version, null), StoryStudioError);
        assert.throws(() => store.updateProject(project.id, project.version, { titel: '拼错字段' }), hasCode('unknown_fields'));
        assert.throws(
            () => store.updateChapter(project.id, chapter.id, project.version, chapter.revision, { contents: '拼错字段' }),
            hasCode('unknown_fields'),
        );
    });

    test('15. refuses a second writer while a lock is held', () => {
        const { project } = store.createProject({ title: '锁测试' });
        const lock = store.acquireProjectLock(project.id);
        try {
            assert.throws(() => store.updateProject(project.id, project.version, { title: '不应写入' }), hasCode('project_busy'));
        } finally {
            store.releaseProjectLock(lock);
        }
        assert.equal(store.getProject(project.id).title, '锁测试');
    });

    test('16. does not steal an expired lock from a live owner', () => {
        const { project } = store.createProject({ title: '活进程锁测试' });
        const lock = store.acquireProjectLock(project.id);
        const expiredAt = new Date(Date.now() - store.lockStaleMs - 1_000);
        fs.utimesSync(lock.ownerPath, expiredAt, expiredAt);
        fs.utimesSync(lock.path, expiredAt, expiredAt);
        try {
            assert.throws(() => store.acquireProjectLock(project.id), hasCode('project_busy'));
        } finally {
            store.releaseProjectLock(lock);
        }
    });

    test('17. recovers an expired same-PID owner not active in this process', () => {
        const { project } = store.createProject({ title: 'PID复用锁测试' });
        const lockPath = store.lockPath(project.id);
        const ownerPath = path.join(lockPath, 'owner-abandoned-token');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(ownerPath, JSON.stringify({ token: 'abandoned-token', pid: process.pid }), 'utf8');
        const expiredAt = new Date(Date.now() - store.lockStaleMs - 1_000);
        fs.utimesSync(ownerPath, expiredAt, expiredAt);
        fs.utimesSync(lockPath, expiredAt, expiredAt);
        const successor = store.acquireProjectLock(project.id);
        assert.notEqual(successor.ownerToken, 'abandoned-token');
        store.releaseProjectLock(successor);
    });

    test('18. lists a project while another operation holds its write lock', () => {
        const { project } = store.createProject({ title: '列表锁测试' });
        const lock = store.acquireProjectLock(project.id);
        try {
            assert.equal(store.listProjects().some(item => item.id === project.id), true);
        } finally {
            store.releaseProjectLock(lock);
        }
    });

    test('19. refuses to write after lock ownership is lost', () => {
        const { project } = store.createProject({ title: '失锁保护测试' });
        const original = store.assertProjectLockOwnership.bind(store);
        const lockPath = store.lockPath(project.id);
        const successorPath = path.join(lockPath, 'owner-successor');
        store.assertProjectLockOwnership = lock => {
            fs.unlinkSync(lock.ownerPath);
            fs.writeFileSync(successorPath, 'successor', 'utf8');
            return original(lock);
        };
        try {
            assert.throws(() => store.updateProject(project.id, project.version, { title: '不应落盘' }), hasCode('project_busy'));
        } finally {
            store.assertProjectLockOwnership = original;
            fs.rmSync(lockPath, { recursive: true, force: true });
        }
        assert.equal(store.getProject(project.id).title, '失锁保护测试');
    });

    test('20. keeps an async lock alive and stops its heartbeat after release', async () => {
        const { project } = store.createProject({ title: '长导出锁测试' });
        store.lockStaleMs = 80;
        store.lockHeartbeatMs = 10;
        let finish;
        const operation = store.withProjectLockAsync(project.id, () => new Promise(resolve => { finish = resolve; }));
        const lockPath = store.lockPath(project.id);
        const ownerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
        const initialMtime = fs.statSync(ownerPath).mtimeMs;
        await sleep(120);
        assert.ok(fs.statSync(ownerPath).mtimeMs > initialMtime);
        assert.throws(() => store.acquireProjectLock(project.id), hasCode('project_busy'));
        finish();
        await operation;
        assert.equal(fs.existsSync(lockPath), false);
    });

    test('21. an expired owner cannot delete its successor lock', () => {
        const { project } = store.createProject({ title: '锁接管测试' });
        const expired = store.acquireProjectLock(project.id);
        const expiredAt = new Date(Date.now() - store.lockStaleMs - 1_000);
        fs.writeFileSync(expired.ownerPath, JSON.stringify({ token: expired.ownerToken, pid: 2_147_483_647 }), 'utf8');
        fs.utimesSync(expired.ownerPath, expiredAt, expiredAt);
        fs.utimesSync(expired.path, expiredAt, expiredAt);
        const successor = store.acquireProjectLock(project.id);
        assert.equal(store.releaseProjectLock(expired), false);
        assert.equal(JSON.parse(fs.readFileSync(successor.ownerPath, 'utf8')).token, successor.ownerToken);
        assert.throws(() => store.updateProject(project.id, project.version, { title: '不应写入' }), hasCode('project_busy'));
        store.releaseProjectLock(successor);
        assert.equal(fs.existsSync(successor.path), false);
    });

    test('22. recovers a pending chapter and project-index write', () => {
        const { project, chapter } = store.createProject({ title: '恢复测试' });
        const recoveredProject = structuredClone(project);
        const recoveredChapter = structuredClone(chapter);
        recoveredChapter.content = '日志中的正文';
        recoveredChapter.wordCount = 6;
        recoveredChapter.revision = 2;
        recoveredProject.version = 2;
        recoveredProject.updatedAt = recoveredChapter.updatedAt;
        recoveredProject.chapters[0].wordCount = 6;
        recoveredProject.chapterBytes = Buffer.byteLength(JSON.stringify(recoveredChapter), 'utf8');
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'recovery-transaction',
            project,
            chapter,
            recoveredProject,
            recoveredChapter,
        )), 'utf8');
        assert.equal(store.getProject(project.id).version, 2);
        assert.equal(store.getChapter(project.id, chapter.id).content, '日志中的正文');
        assert.equal(fs.existsSync(journalPath), false);
    });

    test('23. completes a partially published write and cleans an already committed write', () => {
        const partial = store.createProject({ title: '章节先发布' });
        const partialTarget = store.updateChapter(
            partial.project.id,
            partial.chapter.id,
            partial.project.version,
            partial.chapter.revision,
            { content: '已经发布的目标章节' },
        );
        const partialJournalPath = path.join(store.projectDirectory(partial.project.id), '.pending-write.json');
        fs.writeFileSync(store.projectPath(partial.project.id), JSON.stringify(partial.project), 'utf8');
        fs.writeFileSync(partialJournalPath, JSON.stringify(pendingWriteJournal(
            'chapter-published-first',
            partial.project,
            partial.chapter,
            partialTarget.project,
            partialTarget.chapter,
        )), 'utf8');

        assert.equal(store.getProject(partial.project.id).version, partialTarget.project.version);
        assert.equal(store.getChapter(partial.project.id, partial.chapter.id).content, '已经发布的目标章节');
        assert.equal(fs.existsSync(partialJournalPath), false);

        const complete = store.createProject({ title: '项目与章节均发布' });
        const completeTarget = store.updateChapter(
            complete.project.id,
            complete.chapter.id,
            complete.project.version,
            complete.chapter.revision,
            { content: '完整目标状态' },
        );
        const completeJournalPath = path.join(store.projectDirectory(complete.project.id), '.pending-write.json');
        fs.writeFileSync(completeJournalPath, JSON.stringify(pendingWriteJournal(
            'project-and-chapter-published',
            complete.project,
            complete.chapter,
            completeTarget.project,
            completeTarget.chapter,
        )), 'utf8');

        assert.equal(store.getProject(complete.project.id).version, completeTarget.project.version);
        assert.equal(store.getChapter(complete.project.id, complete.chapter.id).content, '完整目标状态');
        assert.equal(fs.existsSync(completeJournalPath), false);
    });

    test('24. quarantines a stale pending write instead of overwriting newer data', t => {
        t.mock.method(console, 'warn', () => {});
        const { project, chapter } = store.createProject({ title: '新版本' });
        const staleProject = { ...structuredClone(project), version: 2 };
        const staleChapter = { ...structuredClone(chapter), revision: 2 };
        staleProject.updatedAt = staleChapter.updatedAt;
        const currentProject = { ...structuredClone(project), title: '更新版本', version: 3 };
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(currentProject), 'utf8');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'stale-transaction', project, chapter, staleProject, staleChapter,
        )), 'utf8');
        assert.equal(store.getProject(project.id).title, '更新版本');
        assert.equal(fs.existsSync(journalPath), false);
        assert.equal(fs.readdirSync(store.projectDirectory(project.id)).some(name => name.startsWith('.pending-write.conflict-stale-transaction-')), true);
    });

    test('25. quarantines a same-version journal with different content', t => {
        t.mock.method(console, 'warn', () => {});
        const { project, chapter } = store.createProject({ title: '同版本共同基线' });
        const journalProject = { ...structuredClone(project), version: 2 };
        const journalChapter = { ...structuredClone(chapter), revision: 2 };
        journalProject.updatedAt = journalChapter.updatedAt;
        const currentProject = { ...structuredClone(project), title: '同版本当前值', version: 2 };
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(currentProject), 'utf8');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'same-version-transaction', project, chapter, journalProject, journalChapter,
        )), 'utf8');
        assert.equal(store.getProject(project.id).title, '同版本当前值');
        assert.equal(fs.existsSync(journalPath), false);
    });

    test('26. blocks a conflicting pending write when the chapter file was partially published', () => {
        const { project, chapter } = store.createProject({ title: '分支冲突基线' });
        const targetChapter = {
            ...structuredClone(chapter),
            content: '部分写入',
            wordCount: 4,
            revision: 2,
        };
        const targetProject = {
            ...structuredClone(project),
            version: 2,
            chapters: [{ ...project.chapters[0], wordCount: 4 }],
            chapterBytes: Buffer.byteLength(JSON.stringify(targetChapter), 'utf8'),
            updatedAt: targetChapter.updatedAt,
        };
        const currentProject = { ...structuredClone(project), title: '并发的新分支', version: 3 };
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(targetChapter), 'utf8');
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(currentProject), 'utf8');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'partial-conflict-transaction', project, chapter, targetProject, targetChapter,
        )), 'utf8');

        assert.throws(
            () => store.getProject(project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('27. blocks recovery when the target project is published but its chapter diverges', () => {
        const { project, chapter } = store.createProject({ title: '目标项目章节分叉' });
        const target = store.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '目标正文' },
        );
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(chapter), 'utf8');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'target-project-divergent-chapter',
            project,
            chapter,
            target.project,
            target.chapter,
        )), 'utf8');

        assert.throws(
            () => store.getProject(project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8')).content, '');
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('28. rejects forged base byte metadata before replaying a pending write', () => {
        const { project, chapter } = store.createProject({ title: '伪造字节账本' });
        const target = store.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '目标正文' },
        );
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(project), 'utf8');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(chapter), 'utf8');
        const journal = pendingWriteJournal(
            'forged-base-byte-metadata',
            project,
            chapter,
            structuredClone(target.project),
            target.chapter,
        );
        journal.baseProjectChapterBytes += 100;
        journal.project.chapterBytes += 100;
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');

        assert.throws(() => store.getProject(project.id), hasCode('invalid_storage'));
        assert.equal(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')).chapterBytes, project.chapterBytes);
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('29. rejects a pending write whose chapter revision does not advance by one', () => {
        const { project, chapter } = store.createProject({ title: '非法章节修订号' });
        const target = store.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '目标正文' },
        );
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(project), 'utf8');
        fs.writeFileSync(store.chapterPath(project.id, chapter.id), JSON.stringify(chapter), 'utf8');
        const invalidChapter = { ...structuredClone(target.chapter), revision: 9 };
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'invalid-revision-transition',
            project,
            chapter,
            target.project,
            invalidChapter,
        )), 'utf8');

        assert.throws(() => store.getProject(project.id), hasCode('invalid_storage'));
        assert.equal(JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8')).revision, chapter.revision);
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('30. rejects a chapter commit whose target skips the base project version', () => {
        const { project, chapter } = store.createProject({ title: '章节版本跳级' });
        const commit = store.commitProjectAndChapter;
        store.commitProjectAndChapter = function (...args) {
            args[0].version += 1;
            return commit.call(this, ...args);
        };
        try {
            assert.throws(
                () => store.updateChapter(
                    project.id,
                    chapter.id,
                    project.version,
                    chapter.revision,
                    { content: '不应提交的跨版本正文' },
                ),
                hasCode('invalid_storage'),
            );
        } finally {
            store.commitProjectAndChapter = commit;
        }

        assert.equal(store.getProject(project.id).version, project.version);
        assert.equal(store.getChapter(project.id, chapter.id).content, chapter.content);
        assert.equal(fs.existsSync(path.join(store.projectDirectory(project.id), '.pending-write.json')), false);
    });

    test('31. removes only old Story Studio staging directories', () => {
        const stalePath = path.join(store.projectsDirectory, '.staging-11111111-1111-4111-8111-111111111111');
        const freshPath = path.join(store.projectsDirectory, '.staging-22222222-2222-4222-8222-222222222222');
        fs.mkdirSync(stalePath);
        fs.mkdirSync(freshPath);
        const staleAt = new Date(Date.now() - store.stagingStaleMs - 1_000);
        fs.utimesSync(stalePath, staleAt, staleAt);
        store.cleanupStaleStagingDirectories();
        assert.equal(fs.existsSync(stalePath), false);
        assert.equal(fs.existsSync(freshPath), true);
    });

    test('32. recovers a partially published chapter from a normalized V3 base without raw chapterBytes', () => {
        const { project, chapter } = store.createProject({ title: '缺字节账本恢复' });
        const target = store.updateChapter(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            { content: '章节已经先发布' },
        );
        const rawBaseProject = structuredClone(project);
        delete rawBaseProject.chapterBytes;
        fs.writeFileSync(store.projectPath(project.id), JSON.stringify(rawBaseProject), 'utf8');
        const journalPath = path.join(store.projectDirectory(project.id), '.pending-write.json');
        fs.writeFileSync(journalPath, JSON.stringify(pendingWriteJournal(
            'missing-raw-chapter-bytes',
            project,
            chapter,
            target.project,
            target.chapter,
        )), 'utf8');

        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(store.projectPath(project.id), 'utf8')), 'chapterBytes'), false);
        assert.equal(JSON.parse(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8')).content, '章节已经先发布');
        const recovered = store.getProject(project.id);
        assert.equal(recovered.version, target.project.version);
        assert.equal(recovered.chapterBytes, target.project.chapterBytes);
        assert.equal(store.getChapter(project.id, chapter.id).content, '章节已经先发布');
        assert.equal(fs.existsSync(journalPath), false);
    });
});
