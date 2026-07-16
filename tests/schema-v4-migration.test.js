import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { StoryStudioError, StoryStudioStore } from '../src/story-studio-store.js';

let rootDirectory;

function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
    return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function digestWithout(value, fields) {
    const projection = structuredClone(value);
    for (const field of fields) delete projection[field];
    return digest(projection);
}

function serializedBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function fileDigest(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(directory, prefix = '') {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...listFiles(filePath, relativePath));
        else result.push({ path: relativePath, bytes: fs.statSync(filePath).size, sha256: fileDigest(filePath) });
    }
    return result;
}

function stripV5StoryState(value) {
    const storyState = structuredClone(value);
    delete storyState.facts;
    delete storyState.knowledge;
    delete storyState.timeline;
    const addedFields = {
        entities: ['locationEntityId', 'currentGoal', 'currentAction', 'updatedChapterId'],
        relations: ['addressing', 'publicSummary', 'privateSummary', 'sinceChapterId'],
        events: ['timelineId', 'locationEntityId', 'progress', 'visibility'],
        promises: ['kind', 'urgency', 'evidenceChapterIds'],
        memory: ['status', 'supersededById', 'confidence', 'sourceChapterIds'],
    };
    for (const [category, fields] of Object.entries(addedFields)) {
        storyState[category] = storyState[category].map(record => {
            const legacy = structuredClone(record);
            for (const field of fields) delete legacy[field];
            return legacy;
        });
    }
    return storyState;
}

function downgradeExportPayload(value, schemaVersion) {
    const payload = structuredClone(value);
    payload.schemaVersion = schemaVersion;
    payload.project.schemaVersion = schemaVersion;
    for (const chapter of payload.chapters) chapter.schemaVersion = schemaVersion;
    if (schemaVersion < 5 && schemaVersion >= 3) {
        payload.project.storyState = stripV5StoryState(payload.project.storyState);
    }
    if (schemaVersion < 4) {
        delete payload.project.volumes;
        for (const summary of payload.project.chapters) {
            delete summary.volumeId;
            delete summary.planBasis;
        }
        for (const chapter of payload.chapters) {
            delete chapter.volumeId;
            delete chapter.planBasis;
        }
    }
    if (schemaVersion < 3) {
        delete payload.project.storyState;
        for (const chapter of payload.chapters) delete chapter.generationHistory;
    }
    if (schemaVersion < 2) {
        delete payload.project.resources;
        delete payload.resources;
    }
    return payload;
}

function legacyChapterSummary(chapter) {
    return {
        id: chapter.id,
        number: chapter.number,
        title: chapter.title,
        status: chapter.status,
        summary: chapter.card.summary,
        wordCount: chapter.wordCount,
        updatedAt: chapter.updatedAt,
    };
}

function volumeChapterSummary(chapter) {
    return {
        ...legacyChapterSummary(chapter),
        volumeId: chapter.volumeId,
        planBasis: structuredClone(chapter.planBasis),
    };
}

function hasCode(code, details = {}) {
    return error => {
        assert.ok(error instanceof StoryStudioError);
        assert.equal(error.code, code);
        for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details[key], value);
        return true;
    };
}

function createLegacyProject(schemaVersion, {
    chapterCount = 2,
    missingChapterBytes = false,
    directoryName = `schema-${schemaVersion}`,
} = {}) {
    const store = new StoryStudioStore(path.join(rootDirectory, directoryName));
    let result = store.createProject({ title: `V${schemaVersion} legacy project` });
    for (let number = 2; number <= chapterCount; number += 1) {
        result = store.createChapter(result.project.id, result.project.version, {
            title: `Legacy chapter ${number}`,
            content: `legacy-${number}`,
        });
    }

    const project = readJson(store.projectPath(result.project.id));
    const chapters = project.chapters.map(summary => readJson(store.chapterPath(project.id, summary.id)));
    project.schemaVersion = schemaVersion;
    delete project.volumes;
    if (schemaVersion < 3) delete project.storyState;
    if (schemaVersion === 3) project.storyState = stripV5StoryState(project.storyState);
    if (schemaVersion < 2) delete project.resources;

    for (const chapter of chapters) {
        chapter.schemaVersion = schemaVersion;
        delete chapter.volumeId;
        delete chapter.planBasis;
        if (schemaVersion < 3) delete chapter.generationHistory;
        writeJson(store.chapterPath(project.id, chapter.id), chapter);
    }
    project.chapters = chapters.map(legacyChapterSummary);
    project.chapterBytes = chapters.reduce((sum, chapter) => sum + serializedBytes(chapter), 0);
    if (missingChapterBytes) delete project.chapterBytes;
    writeJson(store.projectPath(project.id), project);
    return { store, project, chapters };
}

function createV4Project(directoryName = 'schema-4', backupRootOverride = null) {
    const storeRoot = path.join(rootDirectory, directoryName);
    const backupRoot = backupRootOverride ?? path.join(rootDirectory, `${directoryName}-backups`);
    const store = new StoryStudioStore(storeRoot, { migrationBackupsDirectory: backupRoot });
    let result = store.createProject({ title: 'V4 preserve project', genre: '玄幻' });
    const addedVolume = store.createVolume(result.project.id, result.project.version, {
        title: '第二卷', goal: '扩展冲突', outline: '第二卷原始卷纲', summary: '尚未开始',
    });
    result = store.createChapter(addedVolume.project.id, addedVolume.project.version, {
        title: '第二卷第一章', content: 'V4 原始正文', volumeId: addedVolume.volume.id,
    });
    const imported = store.importResource(result.project.id, result.project.version, {
        fileName: 'v4-preset.json', mediaType: 'application/json', encoding: 'json',
        data: { name: 'V4 sampling preset', temperature: 0.4 },
    });
    const firstChapterId = imported.project.chapters[0].id;
    const updated = store.updateProject(imported.project.id, imported.project.version, {
        story: { logline: '保留所有 V4 字段' },
        continuity: [{ id: 'continuity-v4', category: 'timeline', label: '旧连续性', detail: '不可丢失' }],
        storyState: {
            entities: [{ id: 'hero', kind: 'character', name: '林默', summary: 'V4 人物', aliases: [], status: 'active' }],
            relations: [],
            events: [{
                id: 'event-v4', kind: 'story', title: 'V4 事件', summary: '旧事件',
                chapterId: firstChapterId, entityIds: ['hero'], status: 'occurred', order: 1,
            }],
            promises: [{
                id: 'promise-v4', title: 'V4 伏笔', summary: '旧伏笔', introducedChapterId: firstChapterId,
                dueChapterId: null, resolvedChapterId: null, status: 'open',
            }],
            memory: [{
                id: 'memory-v4', kind: 'chapter', summary: 'V4 记忆', chapterId: firstChapterId,
                importance: 3, tags: ['旧版'],
            }],
        },
    });
    const project = readJson(store.projectPath(updated.id));
    const chapters = project.chapters.map(summary => readJson(store.chapterPath(project.id, summary.id)));
    project.schemaVersion = 4;
    project.storyState = stripV5StoryState(project.storyState);
    for (const chapter of chapters) {
        chapter.schemaVersion = 4;
        writeJson(store.chapterPath(project.id, chapter.id), chapter);
    }
    project.chapterBytes = chapters.reduce((sum, chapter) => sum + serializedBytes(chapter), 0);
    writeJson(store.projectPath(project.id), project);
    fs.writeFileSync(path.join(store.projectDirectory(project.id), 'v4-extra.bin'), Buffer.from([0, 1, 2, 255]));
    return { store, backupRoot, project, chapters };
}

function leaveMigrationJournal(store, projectId, publish) {
    const originalApply = store.applySchemaMigrationUnlocked;
    store.applySchemaMigrationUnlocked = function (targetProjectId, journal, lock) {
        publish.call(this, targetProjectId, journal, lock);
        throw new Error('simulated schema migration crash');
    };
    try {
        assert.throws(() => store.getProject(projectId), /simulated schema migration crash/);
    } finally {
        store.applySchemaMigrationUnlocked = originalApply;
    }
    const journalPath = store.schemaMigrationJournalPath(projectId);
    assert.equal(fs.existsSync(journalPath), true);
    return { journalPath, journal: readJson(journalPath) };
}

function writeLegacyChapterOperationsJournal(store, project, chapters) {
    const timestamp = new Date(Date.parse(project.updatedAt) + 1_000).toISOString();
    const targetChapters = [...chapters].reverse().map((chapter, index) => {
        const nextNumber = index + 1;
        if (chapter.number === nextNumber) return structuredClone(chapter);
        return {
            ...structuredClone(chapter),
            number: nextNumber,
            revision: chapter.revision + 1,
            updatedAt: timestamp,
        };
    });
    const targetProject = {
        ...structuredClone(project),
        chapters: targetChapters.map(legacyChapterSummary),
        chapterBytes: targetChapters.reduce((sum, chapter) => sum + serializedBytes(chapter), 0),
        version: project.version + 1,
        updatedAt: timestamp,
    };
    const journal = {
        transactionId: randomUUID(),
        baseProjectVersion: project.version,
        baseProjectDigest: digest(project),
        baseProjectInvariantDigest: digestWithout(project, [
            'volumes', 'chapters', 'chapterBytes', 'continuity', 'storyState', 'version', 'updatedAt',
        ]),
        baseChapterIds: chapters.map(chapter => chapter.id),
        baseProjectChapterBytes: project.chapterBytes,
        baseChapters: chapters.map(chapter => ({
            chapterId: chapter.id,
            exists: true,
            digest: digest(chapter),
            bytes: serializedBytes(chapter),
            revision: chapter.revision,
            number: chapter.number,
            createdAt: chapter.createdAt,
            updatedAt: chapter.updatedAt,
        })),
        project: targetProject,
        operations: targetChapters.map(chapter => ({
            operation: 'write',
            chapterId: chapter.id,
            chapter,
        })),
    };
    writeJson(store.chapterOperationsJournalPath(project.id), journal);
    return { journal, targetChapters };
}

function writeV4PendingWriteJournal(store, project, chapters) {
    const timestamp = new Date(Date.parse(project.updatedAt) + 1_000).toISOString();
    const chapter = { ...structuredClone(chapters[0]), notes: 'recovered V4 pending write' };
    chapter.revision += 1;
    chapter.updatedAt = timestamp;
    const targetChapters = [chapter, ...chapters.slice(1)];
    const targetProject = {
        ...structuredClone(project),
        chapters: targetChapters.map(volumeChapterSummary),
        chapterBytes: targetChapters.reduce((sum, item) => sum + serializedBytes(item), 0),
        version: project.version + 1,
        updatedAt: timestamp,
    };
    const journal = {
        transactionId: randomUUID(),
        baseProjectVersion: project.version,
        baseProjectDigest: digest(project),
        baseProjectInvariantDigest: digestWithout(project, ['chapters', 'chapterBytes', 'storyState', 'version', 'updatedAt']),
        baseChapterIds: project.chapters.map(item => item.id),
        baseProjectChapterBytes: project.chapterBytes,
        baseChapterDigest: digest(chapters[0]),
        baseChapterBytes: serializedBytes(chapters[0]),
        baseChapterRevision: chapters[0].revision,
        baseChapterNumber: chapters[0].number,
        baseChapterCreatedAt: chapters[0].createdAt,
        baseChapterVolumeId: chapters[0].volumeId,
        baseChapterPlanBasis: structuredClone(chapters[0].planBasis),
        project: targetProject,
        chapter,
    };
    writeJson(path.join(store.projectDirectory(project.id), '.pending-write.json'), journal);
    return { journal, targetProject, chapter };
}

function writeV4PendingResourceJournal(store, project) {
    const timestamp = new Date(Date.parse(project.updatedAt) + 1_000).toISOString();
    const resourceId = project.resources.promptProfileIds[0];
    const baseResource = readJson(store.resourcePath(project.id, 'prompt-profile', resourceId));
    const resource = {
        ...structuredClone(baseResource),
        name: 'Recovered V4 resource update',
        revision: baseResource.revision + 1,
        updatedAt: timestamp,
    };
    const targetProject = {
        ...structuredClone(project),
        version: project.version + 1,
        updatedAt: timestamp,
    };
    const journal = {
        transactionId: randomUUID(),
        baseProjectVersion: project.version,
        baseProjectDigest: digest(project),
        baseProjectInvariantDigest: digestWithout(project, ['resources', 'version', 'updatedAt']),
        baseResourceReferences: {
            characterIds: [...project.resources.characterIds],
            lorebookIds: [...project.resources.lorebookIds],
            promptProfileIds: [...project.resources.promptProfileIds],
        },
        baseResources: [{
            type: 'prompt-profile', resourceId, exists: true, digest: digest(baseResource),
            bytes: serializedBytes(baseResource), revision: baseResource.revision, createdAt: baseResource.createdAt,
        }],
        project: targetProject,
        operations: [{ operation: 'write', type: 'prompt-profile', resourceId, resource }],
    };
    writeJson(store.resourceJournalPath(project.id), journal);
    return { journal, targetProject, resource };
}

function writeV4PendingChapterOperationsJournal(store, project, chapters) {
    const timestamp = new Date(Date.parse(project.updatedAt) + 1_000).toISOString();
    const targetProject = {
        ...structuredClone(project),
        version: project.version + 1,
        updatedAt: timestamp,
    };
    const journal = {
        transactionId: randomUUID(),
        baseProjectVersion: project.version,
        baseProjectDigest: digest(project),
        baseProjectInvariantDigest: digestWithout(project, [
            'volumes', 'chapters', 'chapterBytes', 'continuity', 'storyState', 'version', 'updatedAt',
        ]),
        baseChapterIds: project.chapters.map(item => item.id),
        baseProjectChapterBytes: project.chapterBytes,
        baseChapters: chapters.map(chapter => ({
            chapterId: chapter.id, exists: true, digest: digest(chapter), bytes: serializedBytes(chapter),
            revision: chapter.revision, number: chapter.number, volumeId: chapter.volumeId,
            planBasis: structuredClone(chapter.planBasis), createdAt: chapter.createdAt, updatedAt: chapter.updatedAt,
        })),
        project: targetProject,
        operations: chapters.map(chapter => ({ operation: 'write', chapterId: chapter.id, chapter: structuredClone(chapter) })),
    };
    writeJson(store.chapterOperationsJournalPath(project.id), journal);
    return { journal, targetProject };
}

beforeEach(() => {
    rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-schema-v5-'));
});

afterEach(() => {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
});

describe('Schema V5 legacy migration', () => {
    test('migrates realistic V1, V2, and V3 records into one default volume with current plan baselines', () => {
        for (const schemaVersion of [1, 2, 3]) {
            const { store, project, chapters } = createLegacyProject(schemaVersion);
            const migrated = store.getProject(project.id);

            assert.equal(migrated.schemaVersion, 5);
            assert.equal(migrated.version, project.version + 1);
            assert.equal(migrated.volumes.length, 1);
            assert.equal(migrated.volumes[0].number, 1);
            assert.equal(migrated.volumes[0].revision, 1);
            assert.equal(migrated.chapters.length, chapters.length);
            for (const [index, summary] of migrated.chapters.entries()) {
                const chapter = store.getChapter(project.id, summary.id);
                assert.equal(chapter.schemaVersion, 5);
                assert.equal(chapter.volumeId, migrated.volumes[0].id);
                assert.deepEqual(chapter.planBasis, { volumeRevision: migrated.volumes[0].revision });
                assert.deepEqual(summary.planBasis, chapter.planBasis);
                assert.equal(chapter.revision, chapters[index].revision + 1);
            }
            assert.equal(fs.existsSync(store.schemaMigrationJournalPath(project.id)), false);
        }
    });

    test('accepts missing legacy chapterBytes but rejects present incorrect byte metadata and index drift', () => {
        const missing = createLegacyProject(3, {
            missingChapterBytes: true,
            directoryName: 'missing-chapter-bytes',
        });
        assert.equal(missing.store.getProject(missing.project.id).schemaVersion, 5);

        const incorrect = createLegacyProject(3, { directoryName: 'incorrect-chapter-bytes' });
        const incorrectProject = readJson(incorrect.store.projectPath(incorrect.project.id));
        incorrectProject.chapterBytes += 1;
        writeJson(incorrect.store.projectPath(incorrect.project.id), incorrectProject);
        assert.throws(
            () => incorrect.store.getProject(incorrect.project.id),
            hasCode('invalid_storage'),
        );
        assert.equal(fs.existsSync(incorrect.store.schemaMigrationJournalPath(incorrect.project.id)), false);

        const drifted = createLegacyProject(3, { directoryName: 'drifted-index' });
        const driftedProject = readJson(drifted.store.projectPath(drifted.project.id));
        driftedProject.chapters[0].title = 'index-only title';
        writeJson(drifted.store.projectPath(drifted.project.id), driftedProject);
        assert.throws(
            () => drifted.store.getProject(drifted.project.id),
            hasCode('invalid_storage'),
        );
        assert.equal(fs.existsSync(drifted.store.schemaMigrationJournalPath(drifted.project.id)), false);
    });

    test('preserves every V4 field while adding V5 defaults and writes a verified whole-project backup', () => {
        const { store, backupRoot, project, chapters } = createV4Project('v4-preserve');
        const projectDirectory = store.projectDirectory(project.id);
        const sourceFiles = listFiles(projectDirectory);

        const migrated = store.getProject(project.id);
        assert.equal(migrated.schemaVersion, 5);
        assert.equal(migrated.version, project.version);
        assert.equal(migrated.createdAt, project.createdAt);
        assert.equal(migrated.updatedAt, project.updatedAt);
        assert.deepEqual(migrated.volumes, project.volumes);
        assert.deepEqual(migrated.resources, project.resources);
        assert.deepEqual(migrated.continuity, project.continuity);
        assert.deepEqual(migrated.story, project.story);
        assert.deepEqual(stripV5StoryState(migrated.storyState), project.storyState);
        assert.deepEqual(migrated.storyState.facts, []);
        assert.deepEqual(migrated.storyState.knowledge, []);
        assert.deepEqual(migrated.storyState.timeline, []);
        assert.equal(migrated.storyState.entities[0].locationEntityId, null);
        assert.equal(migrated.storyState.events[0].progress, 0);
        assert.equal(migrated.storyState.promises[0].urgency, 0);
        assert.equal(migrated.storyState.memory[0].confidence, 1);

        const projectedProject = structuredClone(migrated);
        projectedProject.schemaVersion = 4;
        projectedProject.storyState = stripV5StoryState(projectedProject.storyState);
        assert.deepEqual(projectedProject, project);
        for (const [index, summary] of migrated.chapters.entries()) {
            const target = store.getChapter(project.id, summary.id);
            const projectedChapter = { ...structuredClone(target), schemaVersion: 4 };
            assert.deepEqual(projectedChapter, chapters[index]);
            assert.equal(target.revision, chapters[index].revision);
            assert.equal(target.updatedAt, chapters[index].updatedAt);
        }

        const projectBackupRoot = path.join(backupRoot, project.id);
        const backupIds = fs.readdirSync(projectBackupRoot);
        assert.equal(backupIds.length, 1);
        const backupDirectory = path.join(projectBackupRoot, backupIds[0]);
        const manifest = readJson(path.join(backupDirectory, 'manifest.json'));
        assert.equal(manifest.format, 'story-studio-migration-backup-v1');
        assert.equal(manifest.projectId, project.id);
        assert.equal(manifest.transactionId, backupIds[0]);
        assert.equal(manifest.fromSchemaVersion, 4);
        assert.deepEqual(manifest.files, sourceFiles);
        assert.deepEqual(readJson(path.join(backupDirectory, 'snapshot', 'project.json')), project);
        assert.equal(fs.readFileSync(path.join(backupDirectory, 'snapshot', 'v4-extra.bin')).equals(Buffer.from([0, 1, 2, 255])), true);
        assert.equal(manifest.files.some(file => file.path === 'manifest.json'), false);
        assert.equal(fs.existsSync(store.schemaMigrationJournalPath(project.id)), false);
    });

    test('keeps a source manifest.json in the snapshot without colliding with the control manifest', () => {
        const { store, backupRoot, project } = createV4Project('v4-source-manifest');
        const sourceManifest = Buffer.from('{"source":"project fixture"}\n', 'utf8');
        fs.writeFileSync(path.join(store.projectDirectory(project.id), 'manifest.json'), sourceManifest);

        const migrated = store.getProject(project.id);
        assert.equal(migrated.schemaVersion, 5);
        const transactionId = fs.readdirSync(path.join(backupRoot, project.id))[0];
        const backupDirectory = store.migrationBackupDirectory(project.id, transactionId);
        const controlManifest = readJson(store.migrationBackupManifestPath(project.id, transactionId));
        assert.equal(controlManifest.files.some(file => file.path === 'manifest.json'), true);
        assert.equal(
            fs.readFileSync(path.join(backupDirectory, 'snapshot', 'manifest.json')).equals(sourceManifest),
            true,
        );
        assert.equal(readJson(path.join(backupDirectory, 'manifest.json')).format, 'story-studio-migration-backup-v1');
    });

    test('initializes an empty backup root without creating migration content', () => {
        const storeRoot = path.join(rootDirectory, 'empty-backup-store');
        const backupRoot = path.join(rootDirectory, 'empty-backup-root');
        const store = new StoryStudioStore(storeRoot, { migrationBackupsDirectory: backupRoot });
        store.createProject({ title: '无需迁移的当前项目' });

        assert.equal(fs.statSync(backupRoot).isDirectory(), true);
        assert.deepEqual(fs.readdirSync(backupRoot), []);
    });

    test('rejects linked backup roots and project directories without writing outside the backup root', () => {
        for (const linkLevel of ['root', 'project']) {
            const fixture = createV4Project(`v4-linked-backup-${linkLevel}`);
            const externalDirectory = path.join(rootDirectory, `external-backup-target-${linkLevel}`);
            fs.mkdirSync(externalDirectory);
            fs.writeFileSync(path.join(externalDirectory, 'marker.txt'), 'unchanged', 'utf8');
            if (linkLevel === 'root') {
                fs.rmSync(fixture.backupRoot, { recursive: true, force: true });
                fs.symlinkSync(
                    externalDirectory,
                    fixture.backupRoot,
                    process.platform === 'win32' ? 'junction' : 'dir',
                );
            } else {
                fs.symlinkSync(
                    externalDirectory,
                    path.join(fixture.backupRoot, fixture.project.id),
                    process.platform === 'win32' ? 'junction' : 'dir',
                );
            }
            const projectBytes = fs.readFileSync(fixture.store.projectPath(fixture.project.id));
            const chapterBytes = fixture.chapters.map(chapter => fs.readFileSync(
                fixture.store.chapterPath(fixture.project.id, chapter.id),
            ));

            assert.throws(() => fixture.store.getProject(fixture.project.id), hasCode('invalid_storage'));
            assert.deepEqual(fs.readdirSync(externalDirectory), ['marker.txt']);
            assert.deepEqual(fs.readFileSync(fixture.store.projectPath(fixture.project.id)), projectBytes);
            for (const [index, chapter] of fixture.chapters.entries()) {
                assert.deepEqual(fs.readFileSync(fixture.store.chapterPath(fixture.project.id, chapter.id)), chapterBytes[index]);
            }
            assert.equal(fs.existsSync(fixture.store.schemaMigrationJournalPath(fixture.project.id)), false);
        }
    });

    test('rejects a migration backup root whose existing ancestor is linked at construction', () => {
        const linkedParent = path.join(rootDirectory, 'initial-linked-backup-parent');
        const externalParent = path.join(rootDirectory, 'initial-linked-backup-target');
        const externalMarker = path.join(externalParent, 'marker.txt');
        fs.mkdirSync(externalParent);
        fs.writeFileSync(externalMarker, 'unchanged', 'utf8');
        fs.symlinkSync(
            externalParent,
            linkedParent,
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        assert.throws(
            () => new StoryStudioStore(path.join(rootDirectory, 'initial-linked-backup-store'), {
                migrationBackupsDirectory: path.join(linkedParent, 'nested', 'backups'),
            }),
            hasCode('invalid_storage'),
        );
        assert.deepEqual(fs.readdirSync(externalParent), ['marker.txt']);
        assert.equal(fs.readFileSync(externalMarker, 'utf8'), 'unchanged');
    });

    test('rejects migration backup writes after an ancestor is replaced by a junction', () => {
        const backupParent = path.join(rootDirectory, 'replaceable-backup-parent');
        const backupRoot = path.join(backupParent, 'backups');
        const originalParent = path.join(rootDirectory, 'replaceable-backup-parent-original');
        const externalParent = path.join(rootDirectory, 'replacement-backup-parent');
        const externalBackupRoot = path.join(externalParent, 'backups');
        const fixture = createV4Project('v4-replaced-backup-ancestor', backupRoot);
        const projectBytes = fs.readFileSync(fixture.store.projectPath(fixture.project.id));
        const chapterBytes = fixture.chapters.map(chapter => fs.readFileSync(
            fixture.store.chapterPath(fixture.project.id, chapter.id),
        ));
        fs.renameSync(backupParent, originalParent);
        fs.mkdirSync(externalBackupRoot, { recursive: true });
        fs.symlinkSync(
            externalParent,
            backupParent,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        try {
            assert.throws(() => fixture.store.getProject(fixture.project.id), hasCode('invalid_storage'));
            assert.deepEqual(fs.readdirSync(externalBackupRoot), []);
            assert.deepEqual(fs.readFileSync(fixture.store.projectPath(fixture.project.id)), projectBytes);
            for (const [index, chapter] of fixture.chapters.entries()) {
                assert.deepEqual(
                    fs.readFileSync(fixture.store.chapterPath(fixture.project.id, chapter.id)),
                    chapterBytes[index],
                );
            }
            assert.equal(fs.existsSync(fixture.store.schemaMigrationJournalPath(fixture.project.id)), false);
        } finally {
            fs.unlinkSync(backupParent);
            fs.renameSync(originalParent, backupParent);
        }
    });

    test('rejects backup configurations that overlap the projects tree', () => {
        for (const [name, backupDirectory] of [
            ['same', storeRoot => path.join(storeRoot, 'projects')],
            ['inside', storeRoot => path.join(storeRoot, 'projects', 'nested-backups')],
            ['ancestor', storeRoot => storeRoot],
        ]) {
            const storeRoot = path.join(rootDirectory, `overlap-${name}`);
            assert.throws(
                () => new StoryStudioStore(storeRoot, {
                    migrationBackupsDirectory: backupDirectory(storeRoot),
                }),
                hasCode('invalid_storage'),
            );
            assert.equal(fs.existsSync(path.join(storeRoot, 'projects')), false);
        }
    });

    test('preflights missing, corrupt, and mismatched V4 resources before backup or publication', () => {
        for (const corruption of ['missing', 'corrupt', 'mismatched']) {
            const fixture = createV4Project(`v4-resource-preflight-${corruption}`);
            const resourceId = fixture.project.resources.promptProfileIds[0];
            const resourcePath = fixture.store.resourcePath(fixture.project.id, 'prompt-profile', resourceId);
            if (corruption === 'missing') {
                fs.rmSync(resourcePath);
            } else if (corruption === 'corrupt') {
                fs.writeFileSync(resourcePath, '{not-json', 'utf8');
            } else {
                const resource = readJson(resourcePath);
                resource.projectId = 'different-project';
                writeJson(resourcePath, resource);
            }
            const sourceFiles = listFiles(fixture.store.projectDirectory(fixture.project.id));

            assert.throws(() => fixture.store.getProject(fixture.project.id), hasCode('invalid_storage'));
            assert.deepEqual(listFiles(fixture.store.projectDirectory(fixture.project.id)), sourceFiles);
            assert.equal(readJson(fixture.store.projectPath(fixture.project.id)).schemaVersion, 4);
            assert.equal(fs.existsSync(fixture.store.schemaMigrationJournalPath(fixture.project.id)), false);
            assert.deepEqual(fs.readdirSync(fixture.backupRoot), []);
        }
    });
});

describe('Schema migration journal recovery', () => {
    test('replays a partially published migration from the base project', () => {
        const { store, project } = createLegacyProject(3, { directoryName: 'partial-base' });
        const { journalPath } = leaveMigrationJournal(store, project.id, function (projectId, journal) {
            writeJson(this.chapterPath(projectId, journal.chapters[0].id), journal.chapters[0]);
        });

        const recovered = store.getProject(project.id);
        assert.equal(recovered.schemaVersion, 5);
        assert.equal(fs.existsSync(journalPath), false);
        for (const summary of recovered.chapters) {
            assert.equal(store.getChapter(project.id, summary.id).schemaVersion, 5);
        }
    });

    test('cleans a fully published target but blocks a target project with partial chapters', () => {
        const complete = createLegacyProject(3, { directoryName: 'complete-target' });
        const completeCrash = leaveMigrationJournal(complete.store, complete.project.id, function (projectId, journal) {
            for (const chapter of journal.chapters) writeJson(this.chapterPath(projectId, chapter.id), chapter);
            writeJson(this.projectPath(projectId), journal.project);
        });
        assert.equal(complete.store.getProject(complete.project.id).schemaVersion, 5);
        assert.equal(fs.existsSync(completeCrash.journalPath), false);

        const partial = createLegacyProject(3, { directoryName: 'partial-target' });
        const partialCrash = leaveMigrationJournal(partial.store, partial.project.id, function (projectId, journal) {
            writeJson(this.chapterPath(projectId, journal.chapters[0].id), journal.chapters[0]);
            writeJson(this.projectPath(projectId), journal.project);
        });
        assert.throws(
            () => partial.store.getProject(partial.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.existsSync(partialCrash.journalPath), true);
    });

    test('quarantines a coherent legacy branch but blocks incoherent and divergent branches', t => {
        t.mock.method(console, 'warn', () => {});

        const coherent = createLegacyProject(3, { directoryName: 'coherent-branch' });
        const coherentCrash = leaveMigrationJournal(coherent.store, coherent.project.id, () => {});
        const coherentBranch = readJson(coherent.store.projectPath(coherent.project.id));
        coherentBranch.title = 'coherent newer branch';
        writeJson(coherent.store.projectPath(coherent.project.id), coherentBranch);
        const migratedBranch = coherent.store.getProject(coherent.project.id);
        assert.equal(migratedBranch.schemaVersion, 5);
        assert.equal(migratedBranch.title, 'coherent newer branch');
        assert.equal(fs.existsSync(coherentCrash.journalPath), false);
        assert.equal(fs.readdirSync(coherent.store.projectDirectory(coherent.project.id)).some(name => (
            name.startsWith('.pending-schema-migration.conflict-')
        )), true);

        const incoherent = createLegacyProject(3, { directoryName: 'incoherent-v4-branch' });
        const incoherentCrash = leaveMigrationJournal(incoherent.store, incoherent.project.id, () => {});
        const v4Branch = structuredClone(incoherentCrash.journal.project);
        v4Branch.title = 'V4 project with V3 chapter files';
        writeJson(incoherent.store.projectPath(incoherent.project.id), v4Branch);
        assert.throws(
            () => incoherent.store.getProject(incoherent.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.existsSync(incoherentCrash.journalPath), true);

        const divergent = createLegacyProject(3, { directoryName: 'divergent-chapter' });
        const divergentCrash = leaveMigrationJournal(divergent.store, divergent.project.id, () => {});
        const divergentChapter = readJson(divergent.store.chapterPath(divergent.project.id, divergent.chapters[0].id));
        divergentChapter.title = 'neither base nor target';
        writeJson(divergent.store.chapterPath(divergent.project.id, divergentChapter.id), divergentChapter);
        assert.throws(
            () => divergent.store.getProject(divergent.project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.existsSync(divergentCrash.journalPath), true);
    });

    test('recovers a partially published V4 migration while keeping project.json as the final commit point', () => {
        const { store, project, chapters } = createV4Project('v4-partial-chapters');
        const crash = leaveMigrationJournal(store, project.id, function (projectId, journal) {
            writeJson(this.chapterPath(projectId, journal.chapters[0].id), journal.chapters[0]);
        });

        assert.equal(readJson(store.projectPath(project.id)).schemaVersion, 4);
        assert.equal(readJson(store.chapterPath(project.id, chapters[0].id)).schemaVersion, 5);
        assert.equal(readJson(store.chapterPath(project.id, chapters[1].id)).schemaVersion, 4);
        const recovered = store.getProject(project.id);
        assert.equal(recovered.schemaVersion, 5);
        assert.equal(recovered.version, project.version);
        assert.equal(fs.existsSync(crash.journalPath), false);
        assert.equal(fs.existsSync(store.migrationBackupManifestPath(project.id, crash.journal.transactionId)), true);
        for (const chapter of chapters) {
            assert.equal(store.getChapter(project.id, chapter.id).schemaVersion, 5);
        }
    });

    test('fails closed when a V4 target project is published before every target chapter', () => {
        const { store, project, chapters } = createV4Project('v4-project-published-early');
        const crash = leaveMigrationJournal(store, project.id, function (projectId, journal) {
            writeJson(this.chapterPath(projectId, journal.chapters[0].id), journal.chapters[0]);
            writeJson(this.projectPath(projectId), journal.project);
        });

        assert.throws(
            () => store.getProject(project.id),
            hasCode('stale_journal', { recoveryBlocked: true }),
        );
        assert.equal(fs.existsSync(crash.journalPath), true);
        assert.equal(fs.existsSync(store.migrationBackupManifestPath(project.id, crash.journal.transactionId)), true);
        assert.equal(readJson(store.projectPath(project.id)).schemaVersion, 5);
        assert.equal(readJson(store.chapterPath(project.id, chapters[1].id)).schemaVersion, 4);
    });

    test('rejects tampered V4 migration journals without changing source files', () => {
        const { store, project, chapters } = createV4Project('v4-tampered-journal');
        const crash = leaveMigrationJournal(store, project.id, () => {});
        const sourceProjectText = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const sourceChapterTexts = chapters.map(chapter => fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
        const journal = readJson(crash.journalPath);
        journal.project.version += 1;
        writeJson(crash.journalPath, journal);

        assert.throws(() => store.getProject(project.id), hasCode('invalid_storage'));
        assert.equal(fs.existsSync(crash.journalPath), true);
        assert.equal(fs.existsSync(store.migrationBackupManifestPath(project.id, crash.journal.transactionId)), true);
        assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), sourceProjectText);
        for (const [index, chapter] of chapters.entries()) {
            assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), sourceChapterTexts[index]);
        }
    });

    test('rejects tampered backup manifests and backup bytes while retaining recovery evidence', () => {
        for (const testCase of ['manifest', 'file']) {
            const { store, project, chapters } = createV4Project(`v4-tampered-backup-${testCase}`);
            const crash = leaveMigrationJournal(store, project.id, () => {});
            const sourceProjectText = fs.readFileSync(store.projectPath(project.id), 'utf8');
            const sourceChapterTexts = chapters.map(chapter => fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
            const manifestPath = store.migrationBackupManifestPath(project.id, crash.journal.transactionId);
            if (testCase === 'manifest') {
                const manifest = readJson(manifestPath);
                manifest.files[0].bytes += 1;
                writeJson(manifestPath, manifest);
            } else {
                fs.appendFileSync(path.join(path.dirname(manifestPath), 'snapshot', 'project.json'), '\nTAMPERED', 'utf8');
            }

            assert.throws(() => store.getProject(project.id), hasCode('invalid_storage'));
            assert.equal(fs.existsSync(crash.journalPath), true);
            assert.equal(fs.existsSync(manifestPath), true);
            assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), sourceProjectText);
            for (const [index, chapter] of chapters.entries()) {
                assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), sourceChapterTexts[index]);
            }
        }
    });

    test('does not create a migration journal when backup verification fails', () => {
        const { store, project, chapters } = createV4Project('v4-backup-validation-failure');
        const sourceProjectText = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const sourceChapterTexts = chapters.map(chapter => fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'));
        const originalValidate = store.validateMigrationBackupUnlocked;
        store.validateMigrationBackupUnlocked = () => {
            throw new StoryStudioError('simulated backup verification failure', 500, 'invalid_storage');
        };
        try {
            assert.throws(() => store.getProject(project.id), hasCode('invalid_storage'));
        } finally {
            store.validateMigrationBackupUnlocked = originalValidate;
        }
        assert.equal(fs.existsSync(store.schemaMigrationJournalPath(project.id)), false);
        assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), sourceProjectText);
        for (const [index, chapter] of chapters.entries()) {
            assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), sourceChapterTexts[index]);
        }
    });
});

describe('Schema V5 transaction compatibility and invariants', () => {
    test('recovers V4 pending write, resource, and chapter-operation journals before V5 migration', async t => {
        const cases = [
            {
                name: 'pending-write',
                write: writeV4PendingWriteJournal,
                journalPath: (store, project) => path.join(store.projectDirectory(project.id), '.pending-write.json'),
                verify(store, project, chapters) {
                    assert.equal(store.getChapter(project.id, chapters[0].id).notes, 'recovered V4 pending write');
                },
            },
            {
                name: 'pending-resource',
                write: (store, project) => writeV4PendingResourceJournal(store, project),
                journalPath: (store, project) => store.resourceJournalPath(project.id),
                verify(store, project) {
                    const resourceId = project.resources.promptProfileIds[0];
                    assert.equal(store.getResource(project.id, 'prompt-profile', resourceId).name, 'Recovered V4 resource update');
                },
            },
            {
                name: 'pending-chapter-operations',
                write: writeV4PendingChapterOperationsJournal,
                journalPath: (store, project) => store.chapterOperationsJournalPath(project.id),
                verify() {},
            },
        ];
        for (const testCase of cases) {
            await t.test(testCase.name, () => {
                const { store, backupRoot, project, chapters } = createV4Project(`v4-${testCase.name}`);
                const pending = testCase.write(store, project, chapters);
                const journalPath = testCase.journalPath(store, project);
                assert.equal(fs.existsSync(journalPath), true);

                const migrated = store.getProject(project.id);
                assert.equal(migrated.schemaVersion, 5);
                assert.equal(migrated.version, pending.targetProject.version);
                assert.equal(fs.existsSync(journalPath), false);
                testCase.verify(store, project, chapters);

                const backupIds = fs.readdirSync(path.join(backupRoot, project.id));
                assert.equal(backupIds.length, 1);
                const backupProject = readJson(path.join(backupRoot, project.id, backupIds[0], 'snapshot', 'project.json'));
                assert.deepEqual(backupProject, pending.targetProject);
            });
        }
    });

    test('recovers an old V3 chapter-operations journal before migrating the recovered order', () => {
        const { store, project, chapters } = createLegacyProject(3, {
            chapterCount: 3,
            directoryName: 'legacy-chapter-operations',
        });
        const { targetChapters } = writeLegacyChapterOperationsJournal(store, project, chapters);

        const recovered = store.getProject(project.id);
        assert.equal(recovered.schemaVersion, 5);
        assert.deepEqual(recovered.chapters.map(chapter => chapter.id), targetChapters.map(chapter => chapter.id));
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(project.id)), false);
        for (const summary of recovered.chapters) {
            const chapter = store.getChapter(project.id, summary.id);
            assert.equal(chapter.schemaVersion, 5);
            assert.deepEqual(chapter.planBasis, { volumeRevision: recovered.volumes[0].revision });
        }
    });

    test('recovers a partially published chapter inserted into a non-final volume', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'non-final-volume-insert'));
        const created = store.createProject({ title: 'non-final volume insert' });
        const firstVolume = created.project.volumes[0];
        const added = store.createVolume(created.project.id, created.project.version, { title: 'second volume' });
        const second = store.createChapter(added.project.id, added.project.version, {
            title: 'later volume chapter',
            volumeId: added.volume.id,
        });
        const originalApply = store.applyChapterOperations.bind(store);
        store.applyChapterOperations = (projectId, operations, lock) => {
            originalApply(projectId, operations.slice(0, 2), lock);
            throw new Error('simulated inserted chapter crash');
        };
        try {
            assert.throws(
                () => store.createChapter(second.project.id, second.project.version, {
                    title: 'inserted chapter',
                    volumeId: firstVolume.id,
                }),
                /simulated inserted chapter crash/,
            );
        } finally {
            store.applyChapterOperations = originalApply;
        }
        const journal = readJson(store.chapterOperationsJournalPath(created.project.id));
        const insertedOperation = journal.operations.find(operation => operation.chapter?.title === 'inserted chapter');
        assert.ok(insertedOperation);

        const recovered = store.getProject(created.project.id);
        assert.deepEqual(recovered.chapters.map(chapter => chapter.volumeId), [
            firstVolume.id,
            firstVolume.id,
            added.volume.id,
        ]);
        assert.deepEqual(recovered.chapters.map(chapter => chapter.number), [1, 2, 3]);
        const inserted = store.getChapter(created.project.id, insertedOperation.chapterId);
        assert.deepEqual(inserted.planBasis, { volumeRevision: firstVolume.revision });
        assert.equal(store.getChapter(created.project.id, second.chapter.id).revision, second.chapter.revision + 1);
        assert.equal(fs.existsSync(store.chapterOperationsJournalPath(created.project.id)), false);
    });

    test('rejects an introduced chapter whose journal schema differs from the target project', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'introduced-chapter-schema'));
        const created = store.createProject({ title: 'introduced chapter schema' });
        const sourceProjectText = fs.readFileSync(store.projectPath(created.project.id), 'utf8');
        const originalApply = store.applyChapterOperations;
        store.applyChapterOperations = () => {
            throw new Error('stop before chapter publication');
        };
        try {
            assert.throws(
                () => store.createChapter(created.project.id, created.project.version, { title: 'new chapter' }),
                /stop before chapter publication/,
            );
        } finally {
            store.applyChapterOperations = originalApply;
        }

        const journalPath = store.chapterOperationsJournalPath(created.project.id);
        const journal = readJson(journalPath);
        const introduced = journal.operations.find(operation => (
            !journal.baseChapterIds.includes(operation.chapterId)
        ));
        assert.ok(introduced);
        introduced.chapter.schemaVersion = 4;
        writeJson(journalPath, journal);

        assert.throws(() => store.getProject(created.project.id), hasCode('invalid_storage'));
        assert.equal(fs.existsSync(journalPath), true);
        assert.equal(fs.readFileSync(store.projectPath(created.project.id), 'utf8'), sourceProjectText);
        assert.equal(fs.existsSync(store.chapterPath(created.project.id, introduced.chapterId)), false);
    });

    test('treats a same-value volume patch as a storage no-op', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'same-volume-value'));
        const created = store.createProject({ title: 'same volume value' });
        const volume = created.project.volumes[0];
        const projectText = fs.readFileSync(store.projectPath(created.project.id), 'utf8');

        const result = store.updateVolume(
            created.project.id,
            volume.id,
            created.project.version,
            volume.revision,
            { title: volume.title },
        );
        assert.equal(result.project.version, created.project.version);
        assert.equal(result.volume.revision, volume.revision);
        assert.equal(result.project.updatedAt, created.project.updatedAt);
        assert.equal(fs.readFileSync(store.projectPath(created.project.id), 'utf8'), projectText);
    });

    test('rejects a V4 import whose chapter records disagree with the project index', async () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'v4-import-mismatch'));
        const created = store.createProject({ title: 'V4 import mismatch' });
        const added = store.createVolume(created.project.id, created.project.version, { title: 'second volume' });
        store.createChapter(added.project.id, added.project.version, {
            title: 'second volume chapter',
            volumeId: added.volume.id,
        });
        const payload = await store.exportProject(created.project.id);
        [payload.chapters[0].volumeId, payload.chapters[1].volumeId] = [
            payload.chapters[1].volumeId,
            payload.chapters[0].volumeId,
        ];
        const projectCount = store.listProjects().length;

        await assert.rejects(
            () => store.importProject(payload),
            error => error instanceof StoryStudioError
                && error.status === 400
                && error.code === 'invalid_import',
        );
        assert.equal(store.listProjects().length, projectCount);
    });

    test('rejects fields from newer schemas in V1-V4 imports before creating a project', async () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'versioned-import-fields'));
        const created = store.createProject({ title: 'versioned import source' });
        const exported = await store.exportProject(created.project.id);

        for (const schemaVersion of [1, 2, 3, 4]) {
            const baseline = downgradeExportPayload(exported, schemaVersion);
            const imported = await store.importProject(baseline);
            assert.equal(imported.project.schemaVersion, 5);
        }

        const cases = [
            {
                schemaVersion: 1,
                mutate(payload) { payload.project.resources = {}; },
            },
            {
                schemaVersion: 2,
                mutate(payload) { payload.project.storyState = {}; },
            },
            {
                schemaVersion: 2,
                mutate(payload) { payload.chapters[0].generationHistory = []; },
            },
            {
                schemaVersion: 3,
                mutate(payload) { payload.project.volumes = []; },
            },
            {
                schemaVersion: 3,
                mutate(payload) { payload.chapters[0].volumeId = 'future-volume'; },
            },
            {
                schemaVersion: 4,
                mutate(payload) { payload.project.storyState.facts = []; },
            },
            {
                schemaVersion: 4,
                mutate(payload) {
                    payload.project.storyState.entities = [{
                        id: 'future-entity', kind: 'character', name: 'future', locationEntityId: null,
                    }];
                },
            },
        ];
        for (const [index, testCase] of cases.entries()) {
            const payload = downgradeExportPayload(exported, testCase.schemaVersion);
            testCase.mutate(payload);
            const countBefore = store.listProjects().length;
            await assert.rejects(
                () => store.importProject(payload),
                error => error instanceof StoryStudioError
                    && error.status === 400
                    && ['invalid_import', 'unknown_fields'].includes(error.code),
                `case ${index} should reject a future field`,
            );
            assert.equal(store.listProjects().length, countBefore);
        }
    });

    test('rejects V5 story-state fields in V4 storage and pending journals', () => {
        const stored = createV4Project('v4-future-storage');
        const storedProjectPath = stored.store.projectPath(stored.project.id);
        const invalidStoredProject = readJson(storedProjectPath);
        invalidStoredProject.storyState.facts = [];
        writeJson(storedProjectPath, invalidStoredProject);
        const storedBytes = fs.readFileSync(storedProjectPath);
        assert.throws(() => stored.store.getProject(stored.project.id), hasCode('invalid_storage'));
        assert.deepEqual(fs.readFileSync(storedProjectPath), storedBytes);
        assert.equal(fs.existsSync(stored.store.schemaMigrationJournalPath(stored.project.id)), false);

        const pending = createV4Project('v4-future-pending');
        writeV4PendingWriteJournal(pending.store, pending.project, pending.chapters);
        const journalPath = path.join(pending.store.projectDirectory(pending.project.id), '.pending-write.json');
        const journal = readJson(journalPath);
        journal.project.storyState.facts = [];
        writeJson(journalPath, journal);
        const sourceProjectBytes = fs.readFileSync(pending.store.projectPath(pending.project.id));
        assert.throws(() => pending.store.getProject(pending.project.id), hasCode('invalid_storage'));
        assert.deepEqual(fs.readFileSync(pending.store.projectPath(pending.project.id)), sourceProjectBytes);
        assert.equal(fs.existsSync(journalPath), true);
    });

    test('rejects a tampered cross-volume structure journal that clears the review marker', () => {
        const store = new StoryStudioStore(path.join(rootDirectory, 'tampered-structure-basis'));
        const created = store.createProject({ title: 'tampered structure basis' });
        const firstVolume = created.project.volumes[0];
        const added = store.createVolume(created.project.id, created.project.version, { title: 'second volume' });
        const second = store.createChapter(added.project.id, added.project.version, {
            title: 'second volume chapter',
            volumeId: added.volume.id,
        });
        const projectText = fs.readFileSync(store.projectPath(created.project.id), 'utf8');
        const originalApply = store.applyChapterOperations;
        store.applyChapterOperations = () => {
            throw new Error('stop before structure publish');
        };
        try {
            assert.throws(
                () => store.updateStructure(second.project.id, second.project.version, [
                    { id: firstVolume.id, chapterIds: [] },
                    { id: added.volume.id, chapterIds: [created.chapter.id, second.chapter.id] },
                ]),
                /stop before structure publish/,
            );
        } finally {
            store.applyChapterOperations = originalApply;
        }

        const journalPath = store.chapterOperationsJournalPath(created.project.id);
        const journal = readJson(journalPath);
        const movedOperation = journal.operations.find(operation => operation.chapterId === created.chapter.id);
        movedOperation.chapter.planBasis = { volumeRevision: added.volume.revision };
        const movedSummary = journal.project.chapters.find(chapter => chapter.id === created.chapter.id);
        movedSummary.planBasis = { volumeRevision: added.volume.revision };
        journal.project.chapterBytes = journal.operations
            .filter(operation => operation.operation === 'write')
            .reduce((sum, operation) => sum + serializedBytes(operation.chapter), 0);
        writeJson(journalPath, journal);

        assert.throws(
            () => store.getProject(created.project.id),
            hasCode('invalid_storage'),
        );
        assert.equal(fs.existsSync(journalPath), true);
        assert.equal(fs.readFileSync(store.projectPath(created.project.id), 'utf8'), projectText);
        const storedChapter = readJson(store.chapterPath(created.project.id, created.chapter.id));
        assert.equal(storedChapter.volumeId, firstVolume.id);
        assert.deepEqual(storedChapter.planBasis, created.chapter.planBasis);
    });
});
