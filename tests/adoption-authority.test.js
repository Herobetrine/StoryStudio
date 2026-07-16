import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { StoryStudioStore } from '../src/story-studio-store.js';

function completeCard() {
    return {
        summary: '周云越过封锁，但失去了关键地图。',
        goal: '在封城完成前离开长宁城。',
        conflict: '守军封锁暗河并派追兵进入。',
        turn: '塌方挡住追兵，也封死了退路。',
        hook: '城外已有陌生人等待。',
        pov: '周云限知视角。',
        time: '封城令生效当夜。',
        location: '旧排水口至城外水渠。',
        required: '兑现暗河路线和封城压力。',
        avoid: '不得提前揭示接应者身份。',
    };
}

function authoritativeAdoption() {
    const chapterCard = completeCard();
    return {
        generationId: 'workflow-final-generation',
        kind: 'rewrite',
        content: { mode: 'replace', text: '周云撞开铁栅，随水流跌入城外水渠。' },
        chapterCard,
        chapterSummary: chapterCard.summary,
        review: '证据审查通过：离城目标已兑现，接应者身份仍保持未知。',
        notes: 'Workflow V2 原子采纳。',
        status: 'done',
        storyStateChanges: {
            entities: {
                upsert: [{ id: 'hero-zhou', kind: 'character', name: '周云', status: 'active' }],
            },
            events: {
                upsert: [{
                    id: 'event-leave-city',
                    title: '离开长宁城',
                    summary: '周云经暗河抵达城外水渠。',
                    entityIds: ['hero-zhou'],
                    status: 'occurred',
                    order: 1,
                }],
            },
        },
    };
}

function hasCode(code) {
    return error => error?.code === code;
}

describe('authoritative chapter adoption payload', () => {
    let rootDirectory;
    let store;

    beforeEach(() => {
        rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-authoritative-adoption-'));
        store = new StoryStudioStore(rootDirectory);
    });

    afterEach(() => {
        fs.rmSync(rootDirectory, { recursive: true, force: true });
    });

    test('commits content, the complete card, review metadata, status, and Story State once', () => {
        const { project, chapter } = store.createProject({ title: '原子章节采纳' });
        const payload = authoritativeAdoption();
        let beforeCommitCalls = 0;
        const result = store.adoptGeneration(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            payload,
            { beforeCommit: () => { beforeCommitCalls += 1; } },
        );

        assert.equal(beforeCommitCalls, 1);
        assert.equal(result.idempotent, false);
        assert.equal(result.project.version, project.version + 1);
        assert.equal(result.chapter.revision, chapter.revision + 1);
        assert.equal(result.chapter.content, payload.content.text);
        assert.deepEqual(result.chapter.card, payload.chapterCard);
        assert.equal(result.chapter.review, payload.review);
        assert.equal(result.chapter.notes, payload.notes);
        assert.equal(result.chapter.status, 'done');
        assert.equal(result.project.storyState.entities[0].id, 'hero-zhou');
        assert.equal(result.project.storyState.events[0].chapterId, null);
        assert.equal(result.chapter.generationHistory.length, 1);
        assert.equal(result.chapter.generationHistory[0].generationId, payload.generationId);
        assert.match(result.chapter.generationHistory[0].payloadHash, /^[0-9a-f]{64}$/u);
        assert.equal(result.project.chapters[0].summary, payload.chapterCard.summary);
        assert.equal(result.project.chapters[0].status, 'done');
    });

    test('replays an identical expanded payload without versions or beforeCommit moving twice', () => {
        const { project, chapter } = store.createProject({ title: '扩展采纳幂等' });
        const payload = authoritativeAdoption();
        let firstCallbacks = 0;
        const first = store.adoptGeneration(
            project.id, chapter.id, project.version, chapter.revision, payload,
            { beforeCommit: () => { firstCallbacks += 1; } },
        );
        let retryCallbacks = 0;
        const retry = store.adoptGeneration(
            project.id, chapter.id, project.version, chapter.revision, structuredClone(payload),
            { beforeCommit: () => { retryCallbacks += 1; } },
        );

        assert.equal(firstCallbacks, 1);
        assert.equal(retryCallbacks, 0);
        assert.equal(retry.idempotent, true);
        assert.equal(retry.project.version, first.project.version);
        assert.equal(retry.chapter.revision, first.chapter.revision);
        assert.equal(retry.chapter.generationHistory.length, 1);
        assert.deepEqual(retry.chapter.card, payload.chapterCard);
    });

    test('treats any changed authoritative field under the same generation id as a conflict', () => {
        const { project, chapter } = store.createProject({ title: '扩展采纳冲突' });
        const payload = authoritativeAdoption();
        const first = store.adoptGeneration(
            project.id, chapter.id, project.version, chapter.revision, payload,
        );
        const projectBefore = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const chapterBefore = fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8');

        for (const changed of [
            { ...payload, review: '另一份审查结论。' },
            { ...payload, notes: '另一份备注。' },
            { ...payload, status: 'revising' },
            { ...payload, chapterCard: { ...payload.chapterCard, hook: '另一条钩子。' }, chapterSummary: payload.chapterSummary },
        ]) {
            assert.throws(
                () => store.adoptGeneration(
                    project.id, chapter.id, first.project.version, first.chapter.revision, changed,
                ),
                hasCode('generation_conflict'),
            );
        }
        assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), chapterBefore);
    });

    test('rejects unknown, incomplete, inconsistent, invalid, and oversized authoritative fields', () => {
        const { project, chapter } = store.createProject({ title: '扩展采纳校验' });
        const payload = authoritativeAdoption();
        const projectBefore = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const chapterBefore = fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8');
        const withoutHook = structuredClone(payload.chapterCard);
        delete withoutHook.hook;

        const cases = [
            [{ ...payload, unexpected: true }, 'unknown_fields'],
            [{ ...payload, chapterCard: withoutHook }, 'invalid_adoption_card'],
            [{ ...payload, chapterCard: { ...payload.chapterCard, extra: 'no' } }, 'unknown_fields'],
            [{ ...payload, chapterSummary: '与完整章卡不一致' }, 'invalid_adoption_card'],
            [{ ...payload, status: 'published' }, 'invalid_status'],
            [{ ...payload, review: 'x'.repeat(1_000_001) }, 'text_too_long'],
            [{ ...payload, notes: 'x'.repeat(1_000_001) }, 'text_too_long'],
        ];
        for (const [invalid, code] of cases) {
            assert.throws(
                () => store.adoptGeneration(project.id, chapter.id, project.version, chapter.revision, invalid),
                hasCode(code),
            );
        }
        assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), chapterBefore);
    });

    test('leaves both authoritative files untouched when beforeCommit fails, then remains retryable', () => {
        const { project, chapter } = store.createProject({ title: '扩展采纳原子失败' });
        const payload = authoritativeAdoption();
        const projectBefore = fs.readFileSync(store.projectPath(project.id), 'utf8');
        const chapterBefore = fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8');
        let failedCallbacks = 0;

        assert.throws(
            () => store.adoptGeneration(
                project.id,
                chapter.id,
                project.version,
                chapter.revision,
                payload,
                {
                    beforeCommit: () => {
                        failedCallbacks += 1;
                        throw new Error('stop before authoritative commit');
                    },
                },
            ),
            /stop before authoritative commit/u,
        );
        assert.equal(failedCallbacks, 1);
        assert.equal(fs.readFileSync(store.projectPath(project.id), 'utf8'), projectBefore);
        assert.equal(fs.readFileSync(store.chapterPath(project.id, chapter.id), 'utf8'), chapterBefore);

        let successfulCallbacks = 0;
        const recovered = store.adoptGeneration(
            project.id,
            chapter.id,
            project.version,
            chapter.revision,
            payload,
            { beforeCommit: () => { successfulCallbacks += 1; } },
        );
        assert.equal(successfulCallbacks, 1);
        assert.equal(recovered.project.version, project.version + 1);
        assert.equal(recovered.chapter.revision, chapter.revision + 1);
        assert.deepEqual(recovered.chapter.card, payload.chapterCard);
    });

    test('retains the legacy adoption shape and retry contract', () => {
        const { project, chapter } = store.createProject({ title: '旧采纳兼容' });
        const legacy = {
            generationId: 'legacy-generation',
            content: { mode: 'append', text: '旧调用正文。' },
            chapterSummary: '旧调用摘要。',
        };
        const first = store.adoptGeneration(
            project.id, chapter.id, project.version, chapter.revision, legacy,
        );
        const retry = store.adoptGeneration(
            project.id, chapter.id, project.version, chapter.revision, structuredClone(legacy),
        );
        assert.equal(retry.idempotent, true);
        assert.equal(retry.project.version, first.project.version);
        assert.equal(retry.chapter.revision, first.chapter.revision);
        assert.equal(retry.chapter.content, legacy.content.text);
        assert.equal(retry.chapter.card.summary, legacy.chapterSummary);
    });
});
