import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
    ChapterVersionStore,
    ChapterVersionStoreError,
    chapterChangesFromVersion,
    chapterVersionInput,
    summarizeContentDiff,
} from '../src/chapter-version-store.js';

describe('append-only chapter version history', () => {
    let root;
    let store;

    function input(changes = {}) {
        return {
            projectId: 'project-one',
            chapterId: 'chapter-one',
            projectVersion: 2,
            chapterRevision: 2,
            title: '雨夜入城',
            status: 'drafting',
            card: { summary: '主角在雨夜入城。', hook: '城门关闭。' },
            content: '雨落长街。',
            review: '节奏正常。',
            notes: '保留城门意象。',
            source: 'manual',
            ...changes,
        };
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-versions-'));
        store = new ChapterVersionStore(root, { clock: () => new Date('2026-07-14T01:02:03.000Z') });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('appends and reads a complete formal chapter snapshot', () => {
        const version = store.appendVersion(input());

        assert.match(version.versionId, /^r2-[0-9a-f]{24}$/);
        assert.equal(version.contentHash.length, 64);
        assert.equal(version.snapshotHash.length, 64);
        assert.equal(version.createdAt, '2026-07-14T01:02:03.000Z');
        assert.deepEqual(store.getVersion('project-one', 'chapter-one', version.versionId), version);
        assert.deepEqual(store.listVersions('project-one', 'chapter-one'), [{
            versionId: version.versionId,
            projectVersion: 2,
            chapterRevision: 2,
            title: '雨夜入城',
            status: 'drafting',
            source: 'manual',
            createdAt: version.createdAt,
            contentHash: version.contentHash,
            snapshotHash: version.snapshotHash,
            characters: 5,
            lines: 1,
        }]);
        assert.equal(fs.existsSync(store.versionPath('project-one', 'chapter-one', 2)), true);
        assert.equal(fs.readdirSync(store.chapterDirectory('project-one', 'chapter-one')).some(name => name.endsWith('.tmp')), false);
    });

    test('isolates versions by project and chapter', () => {
        const first = store.appendVersion(input());
        const otherChapter = store.appendVersion(input({ chapterId: 'chapter-two', source: 'adopt' }));
        const otherProject = store.appendVersion(input({ projectId: 'project-two', source: 'restore' }));

        assert.deepEqual(store.listVersions('project-one', 'chapter-one').map(item => item.versionId), [first.versionId]);
        assert.deepEqual(store.listVersions('project-one', 'chapter-two').map(item => item.versionId), [otherChapter.versionId]);
        assert.deepEqual(store.listVersions('project-two', 'chapter-one').map(item => item.versionId), [otherProject.versionId]);
        assert.deepEqual(store.listVersions('missing-project', 'missing-chapter'), []);
    });

    test('is idempotent for the same formal draft but rejects content or metadata conflicts', () => {
        const first = store.appendVersion(input());
        const repeated = store.appendVersion(input({ projectVersion: 99, source: 'adopt' }));

        assert.deepEqual(repeated, first);
        assert.equal(store.listVersions('project-one', 'chapter-one').length, 1);
        assert.throws(
            () => store.appendVersion(input({ content: '不同正文' })),
            error => error instanceof ChapterVersionStoreError
                && error.code === 'chapter_version_conflict'
                && error.status === 409
                && error.details.existingContentHash === first.contentHash,
        );
        assert.throws(
            () => store.appendVersion(input({ title: '同正文但不同标题' })),
            error => error instanceof ChapterVersionStoreError
                && error.code === 'chapter_version_conflict'
                && error.details.metadataConflict === true,
        );
        assert.equal(store.getVersion('project-one', 'chapter-one', first.versionId).content, '雨落长街。');
    });

    test('lists newest revisions first and summarizes version differences', () => {
        const first = store.appendVersion(input({ chapterRevision: 2, content: '门开\n旧路', notes: '' }));
        const second = store.appendVersion(input({
            projectVersion: 3,
            chapterRevision: 3,
            title: '城门之后',
            content: '门开\n新路！',
            notes: '第二稿',
        }));

        assert.deepEqual(store.listVersions('project-one', 'chapter-one').map(item => item.chapterRevision), [3, 2]);
        const diff = store.diffVersions('project-one', 'chapter-one', first.versionId, second.versionId);
        assert.deepEqual(diff.changedFields, ['title', 'content', 'notes']);
        assert.deepEqual(diff.content, {
            changed: true,
            beforeCharacters: 5,
            afterCharacters: 6,
            deltaCharacters: 1,
            beforeLines: 2,
            afterLines: 2,
            deltaLines: 0,
            commonPrefixCharacters: 3,
            commonSuffixCharacters: 0,
            removedCharacters: 2,
            addedCharacters: 3,
        });
    });

    test('builds integration input and a restore-ready chapter patch', () => {
        const chapter = {
            id: 'chapter-one',
            projectId: 'project-one',
            revision: 7,
            title: '旧稿',
            status: 'revising',
            card: { goal: '找人' },
            content: '旧稿正文',
            review: '待复核',
            notes: '人工备注',
            candidate: { content: '不应进入快照' },
        };
        const version = store.appendVersion(chapterVersionInput(12, chapter, 'restore'));
        const expected = {
            title: '旧稿',
            status: 'revising',
            card: { goal: '找人' },
            content: '旧稿正文',
            review: '待复核',
            notes: '人工备注',
        };

        assert.deepEqual(chapterChangesFromVersion(version), expected);
        assert.deepEqual(store.getRestoreChanges('project-one', 'chapter-one', version.versionId), expected);
        const changes = store.getRestoreChanges('project-one', 'chapter-one', version.versionId);
        changes.card.goal = '被调用方修改';
        assert.equal(store.getVersion('project-one', 'chapter-one', version.versionId).card.goal, '找人');

        const largeCard = Object.fromEntries(['summary', 'goal', 'conflict', 'turn'].map(field => [
            field,
            '界'.repeat(100_000),
        ]));
        const large = store.appendVersion(input({ chapterRevision: 8, card: largeCard }));
        assert.equal(store.getVersion('project-one', 'chapter-one', large.versionId).card.summary.length, 100_000);
    });

    test('rejects traversal identifiers, unknown fields, and unsafe card data', () => {
        assert.throws(
            () => store.appendVersion(input({ projectId: '..' })),
            error => error.code === 'invalid_id',
        );
        assert.throws(
            () => store.appendVersion({ ...input(), contents: '拼错字段' }),
            error => error.code === 'unknown_fields',
        );
        assert.throws(
            () => store.appendVersion(input({ card: { created: new Date() } })),
            error => error.code === 'invalid_chapter_version',
        );
        assert.throws(
            () => store.getVersion('project-one', 'chapter-one', '../version'),
            error => error.code === 'invalid_id',
        );
    });

    test('isolates corrupt records during listing and reports stable read errors', () => {
        const valid = store.appendVersion(input({ chapterRevision: 3 }));
        const corruptPath = store.versionPath('project-one', 'chapter-one', 2);
        fs.writeFileSync(corruptPath, '{broken json', 'utf8');

        const inspection = store.inspectVersions('project-one', 'chapter-one');
        assert.deepEqual(inspection.versions.map(item => item.versionId), [valid.versionId]);
        assert.deepEqual(inspection.corrupt, [{
            chapterRevision: 2,
            fileName: 'r000000000002.json',
            code: 'invalid_version_storage',
        }]);
        assert.throws(
            () => store.readRevision('project-one', 'chapter-one', 2),
            error => error instanceof ChapterVersionStoreError
                && error.code === 'invalid_version_storage'
                && error.status === 500,
        );
        assert.throws(
            () => store.appendVersion(input()),
            error => error.code === 'invalid_version_storage',
        );
    });

    test('detects content tampering instead of trusting a persisted hash', () => {
        const version = store.appendVersion(input());
        const filePath = store.versionPath('project-one', 'chapter-one', 2);
        const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        stored.content = '被篡改';
        fs.writeFileSync(filePath, JSON.stringify(stored), 'utf8');

        assert.throws(
            () => store.getVersion('project-one', 'chapter-one', version.versionId),
            error => error.code === 'invalid_version_storage',
        );

        const metadataVersion = store.appendVersion(input({ chapterRevision: 3 }));
        const metadataPath = store.versionPath('project-one', 'chapter-one', 3);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        metadata.title = '篡改标题';
        fs.writeFileSync(metadataPath, JSON.stringify(metadata), 'utf8');
        assert.throws(
            () => store.getVersion('project-one', 'chapter-one', metadataVersion.versionId),
            error => error.code === 'invalid_version_storage',
        );
    });

    test('does not expose a partial version when atomic publication fails', t => {
        t.mock.method(fs, 'linkSync', () => {
            const error = new Error('simulated publication failure');
            error.code = 'EIO';
            throw error;
        });

        assert.throws(
            () => store.appendVersion(input()),
            error => error instanceof ChapterVersionStoreError
                && error.code === 'version_write_failed'
                && error.status === 500,
        );
        assert.equal(fs.existsSync(store.versionPath('project-one', 'chapter-one', 2)), false);
        assert.deepEqual(fs.readdirSync(store.chapterDirectory('project-one', 'chapter-one')), []);
    });

    test('returns stable not-found errors and handles Unicode diff units', () => {
        assert.throws(
            () => store.readRevision('project-one', 'chapter-one', 9),
            error => error.code === 'chapter_version_not_found' && error.status === 404,
        );
        assert.deepEqual(summarizeContentDiff('甲😀乙', '甲😀丙乙'), {
            changed: true,
            beforeCharacters: 3,
            afterCharacters: 4,
            deltaCharacters: 1,
            beforeLines: 1,
            afterLines: 1,
            deltaLines: 0,
            commonPrefixCharacters: 2,
            commonSuffixCharacters: 1,
            removedCharacters: 0,
            addedCharacters: 1,
        });
    });
});
