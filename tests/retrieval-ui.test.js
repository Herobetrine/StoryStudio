import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('retrieval inspector UI contract', () => {
    test('provides model-independent retrieval preview inside the existing inspector', () => {
        assert.match(html, /id="ss_retrieval_preview"/);
        assert.match(html, /id="ss_context_retrieval"/);
        assert.match(html, /id="ss_context_retrieval_overrides"/);
        assert.match(html, /id="ss_clear_retrieval_overrides"/);
        assert.match(html, /id="ss_retrieval_rerank"/);
        assert.match(app, /async function previewRetrieval\(/);
        assert.match(app, /chapterPath\(projectId, chapterId, '\/retrieval\/preview'\)/);
        assert.match(app, /retrievalOverridesForRequest\(\{ includeRerank: true \}\)/);
        assert.match(app, /rerank: retrieval\.rerank/);
        assert.match(app, /diagnostics:\s*\{ retrieval: preview \}/);
    });

    test('renders source, score, reason and protected chapter navigation', () => {
        assert.match(app, /hit\.score/);
        assert.match(app, /hit\.reasons/);
        assert.match(app, /hit\.sourceType/);
        assert.match(app, /provider-ignored/);
        assert.match(app, /排序：本地回退/);
        assert.match(app, /dataset\.retrievalOverrideId/);
        assert.match(app, /retrieval:\s*retrievalOverridesForRequest\(\)/);
        assert.match(app, /data-retrieval-chapter-id/);
        assert.match(app, /jumpToContinuityChapter\(chapterButton\.dataset\.retrievalChapterId\)/);
        assert.match(app, /preparePendingChangeSetNavigation\('打开来源章节'\)/);
    });

    test('bounds long retrieval evidence on narrow screens', () => {
        const listRule = style.match(/\.ss-context-retrieval\s*\{([^}]*)\}/)?.[1] ?? '';
        assert.match(listRule, /max-height:/);
        assert.match(listRule, /overflow-y:\s*auto/);
        assert.match(style, /\.ss-diagnostic-tag[\s\S]*overflow-wrap:\s*anywhere/);
    });
});
