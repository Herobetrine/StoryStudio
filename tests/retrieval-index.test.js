import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    RetrievalIndex,
    buildRetrievalChunks,
    createRetrievalIndex,
    hashText,
    tokenize,
} from '../src/retrieval-index.js';

describe('local retrieval index', () => {
    test('builds deterministic chunks for manuscript and supported project sources', () => {
        const project = {
            chapters: [{
                id: 'chapter-1', number: 1, volumeId: 'volume-1',
                content: '林照在赤门找到铜钥匙。', summary: '林照进入赤门。',
            }],
            volumes: [{ id: 'volume-1', summary: '赤门卷：寻找钥匙。' }],
            resources: {
                characters: [{ id: 'hero', name: '林照', description: '谨慎的调查者。' }],
                lorebooks: [{
                    id: 'world', name: '赤门世界书', entries: [
                        { id: 'entry-1', content: '钥匙能开启地库。', enabled: true },
                        { id: 'entry-disabled', content: '禁用条目绝不能进入索引。', enabled: false },
                    ],
                }],
            },
            storyState: {
                facts: [{ id: 'fact-1', summary: '铜钥匙能开启地库。', subjectEntityId: 'hero', sourceChapterId: 'chapter-1', status: 'active' }],
                memory: [{ id: 'memory-1', summary: '林照记得赤门的雨。', chapterId: 'chapter-1', status: 'active' }],
                knowledge: [{ entityId: 'hero', factId: 'fact-1', stance: 'knows', status: 'active' }],
            },
        };
        const first = buildRetrievalChunks(project, { chunkSize: 40, chunkOverlap: 4 });
        const second = buildRetrievalChunks(project, { chunkSize: 40, chunkOverlap: 4 });
        assert.deepEqual(first, second);
        assert.ok(first.some(chunk => chunk.sourceType === 'chapter'));
        assert.ok(first.some(chunk => chunk.sourceType === 'chapter-summary'));
        assert.ok(first.some(chunk => chunk.sourceType === 'volume-summary'));
        assert.ok(first.some(chunk => chunk.sourceType === 'character'));
        assert.ok(first.some(chunk => chunk.sourceType === 'lorebook'));
        assert.ok(first.some(chunk => chunk.sourceType === 'fact'));
        assert.ok(first.some(chunk => chunk.sourceType === 'memory'));
        assert.equal(first.some(chunk => chunk.text.includes('禁用条目绝不能进入索引')), false);
        for (const chunk of first) {
            assert.equal(chunk.hash, hashText(chunk.text));
            assert.equal(chunk.end - chunk.start, chunk.text.length);
            assert.equal(typeof chunk.sourceType, 'string');
            assert.equal(typeof chunk.sourceId, 'string');
            assert.ok(chunk.chapterId === null || typeof chunk.chapterId === 'string');
        }
        assert.deepEqual(tokenize('林照 walks 城门 12'), ['林', '照', 'walks', '城', '门', '12']);
    });

    test('uses BM25-style deterministic scores and exposes source/reason', () => {
        const index = createRetrievalIndex({ chunkSize: 200, maxResults: 10 });
        index.rebuild([
            { sourceType: 'chapter', sourceId: 'a', chapterId: 'a', text: '铜钥匙 铜钥匙 在赤门。' },
            { sourceType: 'chapter', sourceId: 'b', chapterId: 'b', text: '赤门有一把铜钥匙。' },
            { sourceType: 'memory', sourceId: 'm', chapterId: 'a', text: '完全无关的记忆。' },
        ]);
        const hits = index.search('铜钥匙');
        assert.equal(hits[0].sourceId, 'a');
        assert.ok(hits[0].score > hits[1].score);
        assert.deepEqual(hits[0].source, {
            key: 'chapter:a', sourceType: 'chapter', sourceId: 'a', chapterId: 'a', volumeId: null, title: null, entryId: null,
        });
        assert.deepEqual(hits[0].reasons, ['bm25']);
        assert.equal(hits.hits, hits);
        assert.equal(hits.total, 2);
    });

    test('applies volume, person, time, status, POV knowledge and superseded filters before ranking', () => {
        const index = new RetrievalIndex({ chunkSize: 200, maxResults: 20 });
        index.rebuild({
            chapters: [
                { id: 'chapter-1', number: 1, volumeId: 'v1', content: '密钥线索。' },
                { id: 'chapter-2', number: 2, volumeId: 'v2', content: '密钥终局。' },
            ],
            storyState: {
                facts: [
                    { id: 'known', summary: '已知密钥在城门。', subjectEntityId: 'hero', sourceChapterId: 'chapter-1', status: 'active' },
                    { id: 'hidden', summary: '隐秘密钥在地库。', subjectEntityId: 'hero', sourceChapterId: 'chapter-1', status: 'active' },
                    { id: 'old', summary: '旧密钥位置。', subjectEntityId: 'hero', sourceChapterId: 'chapter-1', status: 'retired', supersededById: 'known' },
                ],
                knowledge: [
                    { entityId: 'hero', factId: 'known', stance: 'knows', status: 'active' },
                    { entityId: 'hero', factId: 'hidden', stance: 'hides', status: 'active' },
                ],
            },
        });
        const hits = index.search('密钥', {
            volumeId: 'v1',
            maxChapterNumber: 1,
            povEntityId: 'hero',
            povKnowledge: [
                { entityId: 'hero', factId: 'known', stance: 'knows', status: 'active' },
                { entityId: 'hero', factId: 'hidden', stance: 'hides', status: 'active' },
                { entityId: 'hero', factId: 'old', stance: 'knows', status: 'retired' },
            ],
            factStatus: 'active',
        });
        assert.ok(hits.some(hit => hit.sourceId === 'known'));
        assert.equal(hits.some(hit => hit.sourceId === 'hidden'), false);
        assert.equal(hits.some(hit => hit.sourceId === 'old'), false);
        assert.equal(hits.some(hit => hit.sourceId === 'chapter-2'), false);

        const personHits = index.search('密钥', {
            personId: 'hero',
            sourceType: 'fact',
            povEntityId: 'hero',
            povKnowledge: [{ entityId: 'hero', factId: 'known', stance: 'knows', status: 'active' }],
        });
        assert.deepEqual(personHits.map(hit => hit.sourceId), ['known']);
    });

    test('keeps knowledge/provenance metadata and fail-closes future or hidden POV material', () => {
        const index = new RetrievalIndex({ chunkSize: 200, maxResults: 20 });
        index.rebuild({
            chapters: [
                { id: 'chapter-1', number: 1, content: '第一章正文。' },
                { id: 'chapter-2', number: 2, content: '第二章正文。' },
            ],
            storyState: {
                facts: [
                    { id: 'hidden', summary: '密语是银月。', sourceChapterId: 'chapter-1', status: 'active' },
                    { id: 'future-known', summary: '密语在第二章才确认。', sourceChapterId: 'chapter-1', status: 'active' },
                ],
                memory: [
                    {
                        id: 'hidden-copy', summary: '密语是银月。', chapterId: 'chapter-1',
                        sourceChapterIds: ['chapter-1'], status: 'active',
                    },
                    {
                        id: 'future-memory', summary: '密语来自未来证词。', chapterId: 'chapter-1',
                        sourceChapterIds: ['chapter-1', 'chapter-2'], status: 'active',
                    },
                ],
                knowledge: [
                    { id: 'hidden-knows', entityId: 'hero', factId: 'hidden', stance: 'knows', learnedChapterId: 'chapter-1', status: 'active' },
                    { id: 'hidden-edge', entityId: 'hero', factId: 'hidden', stance: 'hides', learnedChapterId: 'chapter-1', status: 'active' },
                    { id: 'future-edge', entityId: 'hero', factId: 'future-known', stance: 'knows', learnedChapterId: 'chapter-2', status: 'active' },
                ],
            },
        });

        const hiddenFact = index.listChunks().find(chunk => chunk.sourceType === 'fact' && chunk.sourceId === 'hidden');
        const hiddenCopy = index.listChunks().find(chunk => chunk.sourceType === 'memory' && chunk.sourceId === 'hidden-copy');
        const futureMemory = index.listChunks().find(chunk => chunk.sourceType === 'memory' && chunk.sourceId === 'future-memory');
        assert.equal(hiddenFact.knowledge.some(edge => edge.learnedChapterId === 'chapter-1'), true);
        assert.deepEqual(hiddenCopy.linkedFactIds, ['hidden']);
        assert.deepEqual(futureMemory.sourceChapterIds, ['chapter-1', 'chapter-2']);
        assert.deepEqual(futureMemory.sourceChapterNumbers, [1, 2]);

        const chapterNumbers = { 'chapter-1': 1, 'chapter-2': 2 };
        const current = index.search('密语', {
            maxChapterNumber: 1,
            chapterNumberById: chapterNumbers,
            povEntityId: 'hero',
            povKnowledge: [
                { entityId: 'hero', factId: 'hidden', stance: 'knows', learnedChapterId: 'chapter-1', status: 'active' },
                { entityId: 'hero', factId: 'hidden', stance: 'hides', learnedChapterId: 'chapter-1', status: 'active' },
                { entityId: 'hero', factId: 'future-known', stance: 'knows', learnedChapterId: 'chapter-2', status: 'active' },
            ],
        });
        assert.equal(current.some(hit => ['hidden', 'hidden-copy', 'future-known', 'future-memory'].includes(hit.sourceId)), false);

        const later = index.search('密语', {
            maxChapterNumber: 2,
            chapterNumberById: chapterNumbers,
            povEntityId: 'hero',
            povKnowledge: [
                { entityId: 'hero', factId: 'hidden', stance: 'knows', learnedChapterId: 'chapter-1', status: 'active' },
                { entityId: 'hero', factId: 'hidden', stance: 'hides', learnedChapterId: 'chapter-1', status: 'active' },
                { entityId: 'hero', factId: 'future-known', stance: 'knows', learnedChapterId: 'chapter-2', status: 'active' },
            ],
        });
        assert.equal(later.some(hit => hit.sourceId === 'future-known'), true);
        assert.equal(later.some(hit => hit.sourceId === 'future-memory'), true);
        assert.equal(later.some(hit => ['hidden', 'hidden-copy'].includes(hit.sourceId)), false);
    });

    test('manual include is ranked first and manual exclude is irreversible', () => {
        const index = new RetrievalIndex({ chunkSize: 200, maxResults: 2 });
        index.rebuild([
            { sourceType: 'chapter', sourceId: 'best', text: '目标词 目标词 目标词。' },
            { sourceType: 'chapter', sourceId: 'forced', text: '没有查询词，但需要保留。' },
            { sourceType: 'chapter', sourceId: 'blocked', text: '目标词 目标词。' },
        ]);
        const hits = index.search('目标词', { manualInclude: ['forced'], manualExclude: ['blocked'] });
        assert.deepEqual(hits.map(hit => hit.sourceId), ['forced', 'best']);
        assert.equal(hits[0].reason, 'manual-include');
        assert.equal(hits.some(hit => hit.sourceId === 'blocked'), false);
        assert.deepEqual(index.search('', { manualInclude: ['forced'] }).map(hit => hit.sourceId), ['forced']);
    });

    test('supports incremental upsert/remove, rebuild and portable snapshots', () => {
        const index = new RetrievalIndex({ chunkSize: 200 });
        index.upsert({ sourceType: 'chapter', sourceId: 'chapter-1', text: '旧文本。' });
        assert.equal(index.search('旧文本')[0].sourceId, 'chapter-1');
        index.update({ sourceType: 'chapter', sourceId: 'chapter-1', text: '新文本。' });
        assert.equal(index.search('旧').length, 0);
        assert.equal(index.search('新文本')[0].sourceId, 'chapter-1');
        index.upsert([
            { sourceType: 'memory', sourceId: 'memory-1', text: '记忆。' },
            { sourceType: 'memory', sourceId: 'memory-2', text: '另一条记忆。' },
        ]);
        assert.equal(index.remove('memory-1'), 1);
        assert.equal(index.search('记忆').some(hit => hit.sourceId === 'memory-1'), false);
        const restored = RetrievalIndex.fromJSON(index.toJSON());
        assert.deepEqual(restored.listChunks(), index.listChunks());
        assert.equal(restored.search('新文本').length, 1);
        assert.equal(restored.stats().documents, 2);
        index.batchRebuild([{ sourceType: 'chapter', sourceId: 'only', text: '重建完成。' }]);
        assert.equal(index.stats().documents, 1);
    });
});
