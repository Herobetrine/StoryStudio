import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { lintChapterQuality } from '../src/quality-linter.js';
import {
    compareQualityRegression,
    runQualityRegression,
} from '../src/quality-regression.js';
import { QualityStore } from '../src/quality-store.js';

const regressionReports = new Map();

function chapterValue({
    projectId = 'project-one',
    chapterId = 'chapter-one',
    content = '林照推开窗，晨光落在桌面。他收起信纸，准备出门。',
    projectVersion = 1,
    chapterRevision = 1,
    volumeId = 'volume-one',
    volumeRevision = 1,
} = {}) {
    const input = {
        content,
        chapterCard: { required: '', avoid: '' },
        volumeGoal: '',
        promises: [],
        entities: [],
        protectedFacts: [],
    };
    const report = lintChapterQuality(input);
    return {
        projectId,
        chapterId,
        source: { type: 'chapter', generationId: null },
        authority: {
            projectVersion,
            chapterRevision,
            volumeId,
            volumeRevision,
            contentDigest: report.contentDigest,
        },
        input,
        report,
    };
}

function regressionReport(suiteId = 'quality-suite-one') {
    if (!regressionReports.has(suiteId)) {
        regressionReports.set(suiteId, runQualityRegression({
            suite: {
                schemaVersion: 1,
                id: suiteId,
                name: `固定回归集 ${suiteId}`,
                revision: 1,
                cases: [{
                    id: 'clean-chapter',
                    title: '稳定正文',
                    genreOverlay: 'none',
                    content: '林照推开窗，晨光落在桌面。他收起信纸，准备出门。',
                    expect: {
                        requiredRuleIds: [],
                        forbiddenRuleIds: [],
                        maxBlockers: 0,
                        maxMajors: 0,
                    },
                }],
            },
            modelBinding: {
                providerProtocol: 'deterministic',
                model: 'quality-store-fixture-v1',
                parameters: { temperature: 0, seed: 7 },
            },
            generatedAt: '2026-07-16T00:00:00.000Z',
        }));
    }
    return structuredClone(regressionReports.get(suiteId));
}

function saveComparison(store, run, report) {
    return store.saveComparison({
        suiteId: run.suiteId,
        candidateRunId: run.id,
        baseline: {
            type: 'fixture',
            id: run.suiteId,
            reportDigest: report.reportDigest,
        },
        comparison: compareQualityRegression(report, report),
    });
}

function writeRaw(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

describe('persistent quality records', () => {
    let root;
    let store;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-quality-store-'));
        store = new QualityStore(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('persists chapter reports, regression runs, and comparisons across a store restart', () => {
        const chapter = store.saveChapterReport(chapterValue());
        const report = regressionReport();
        const run = store.saveRegressionRun(report);
        const comparison = saveComparison(store, run, report);

        for (const filePath of [
            store.chapterReportPath(chapter.projectId, chapter.chapterId, chapter.id),
            store.regressionRunPath(run.suiteId, run.id),
            store.comparisonPath(comparison.suiteId, comparison.id),
        ]) {
            assert.equal(fs.existsSync(filePath), true, filePath);
            assert.match(JSON.parse(fs.readFileSync(filePath, 'utf8')).recordHash, /^[0-9a-f]{64}$/u);
        }

        store = new QualityStore(root);
        assert.deepEqual(store.getChapterReport(chapter.projectId, chapter.chapterId, chapter.id), chapter);
        assert.deepEqual(store.getRegressionRun(run.suiteId, run.id), run);
        assert.deepEqual(store.getComparison(comparison.suiteId, comparison.id), comparison);
        assert.deepEqual(
            store.listChapterReports(chapter.projectId, chapter.chapterId).reports.map(item => item.id),
            [chapter.id],
        );
        assert.deepEqual(store.listRegressionRuns(run.suiteId).runs.map(item => item.id), [run.id]);
        assert.deepEqual(
            store.listComparisons(comparison.suiteId).comparisons.map(item => item.id),
            [comparison.id],
        );
    });

    test('isolates chapter records by project and chapter and regression records by suite', () => {
        const projectOneChapterOne = store.saveChapterReport(chapterValue({
            projectId: 'project-one',
            chapterId: 'chapter-one',
            content: '甲项目第一章保留自己的正文。',
        }));
        const projectOneChapterTwo = store.saveChapterReport(chapterValue({
            projectId: 'project-one',
            chapterId: 'chapter-two',
            content: '甲项目第二章保留另一份正文。',
        }));
        const projectTwoChapterOne = store.saveChapterReport(chapterValue({
            projectId: 'project-two',
            chapterId: 'chapter-one',
            content: '乙项目第一章与甲项目隔离。',
        }));

        assert.deepEqual(
            store.listChapterReports('project-one', 'chapter-one').reports.map(item => item.id),
            [projectOneChapterOne.id],
        );
        assert.deepEqual(
            store.listChapterReports('project-one', 'chapter-two').reports.map(item => item.id),
            [projectOneChapterTwo.id],
        );
        assert.deepEqual(
            store.listChapterReports('project-two', 'chapter-one').reports.map(item => item.id),
            [projectTwoChapterOne.id],
        );
        for (const readWrongLocation of [
            () => store.getChapterReport('project-one', 'chapter-two', projectOneChapterOne.id),
            () => store.getChapterReport('project-two', 'chapter-one', projectOneChapterOne.id),
        ]) {
            assert.throws(
                readWrongLocation,
                error => error.status === 404 && error.code === 'quality_report_not_found',
            );
        }

        const suiteOneReport = regressionReport('quality-suite-one');
        const suiteTwoReport = regressionReport('quality-suite-two');
        const suiteOneRun = store.saveRegressionRun(suiteOneReport);
        const suiteTwoRun = store.saveRegressionRun(suiteTwoReport);
        const suiteOneComparison = saveComparison(store, suiteOneRun, suiteOneReport);
        const suiteTwoComparison = saveComparison(store, suiteTwoRun, suiteTwoReport);
        assert.deepEqual(store.listRegressionRuns('quality-suite-one').runs.map(item => item.id), [suiteOneRun.id]);
        assert.deepEqual(store.listRegressionRuns('quality-suite-two').runs.map(item => item.id), [suiteTwoRun.id]);
        assert.deepEqual(
            store.listComparisons('quality-suite-one').comparisons.map(item => item.id),
            [suiteOneComparison.id],
        );
        assert.deepEqual(
            store.listComparisons('quality-suite-two').comparisons.map(item => item.id),
            [suiteTwoComparison.id],
        );
        assert.throws(
            () => store.getRegressionRun('quality-suite-two', suiteOneRun.id),
            error => error.status === 404 && error.code === 'quality_regression_run_not_found',
        );
        assert.throws(
            () => store.getComparison('quality-suite-two', suiteOneComparison.id),
            error => error.status === 404 && error.code === 'quality_comparison_not_found',
        );
    });

    test('binds a chapter record identity to its project and chapter path', () => {
        const record = store.saveChapterReport(chapterValue());
        const copiedPath = store.chapterReportPath('project-two', 'chapter-two', record.id);
        writeRaw(copiedPath, fs.readFileSync(
            store.chapterReportPath(record.projectId, record.chapterId, record.id),
            'utf8',
        ));

        assert.throws(
            () => store.getChapterReport('project-two', 'chapter-two', record.id),
            error => error.status === 500 && error.code === 'quality_storage_tampered',
        );
        assert.deepEqual(store.listChapterReports('project-two', 'chapter-two'), {
            reports: [],
            corrupt: [{ id: record.id, error: 'quality_storage_tampered' }],
        });
        assert.equal(store.getChapterReport(record.projectId, record.chapterId, record.id).projectId, 'project-one');
    });

    test('rejects recordHash tampering for every persisted record kind', () => {
        const chapter = store.saveChapterReport(chapterValue());
        const report = regressionReport();
        const run = store.saveRegressionRun(report);
        const comparison = saveComparison(store, run, report);
        const cases = [
            {
                path: store.chapterReportPath(chapter.projectId, chapter.chapterId, chapter.id),
                read: () => store.getChapterReport(chapter.projectId, chapter.chapterId, chapter.id),
            },
            {
                path: store.regressionRunPath(run.suiteId, run.id),
                read: () => store.getRegressionRun(run.suiteId, run.id),
            },
            {
                path: store.comparisonPath(comparison.suiteId, comparison.id),
                read: () => store.getComparison(comparison.suiteId, comparison.id),
            },
        ];

        for (const item of cases) {
            const original = fs.readFileSync(item.path, 'utf8');
            const value = JSON.parse(original);
            value.recordHash = value.recordHash.startsWith('0')
                ? `1${value.recordHash.slice(1)}`
                : `0${value.recordHash.slice(1)}`;
            fs.writeFileSync(item.path, JSON.stringify(value, null, 2), 'utf8');
            assert.throws(
                item.read,
                error => error.status === 500 && error.code === 'quality_storage_tampered',
            );
            fs.writeFileSync(item.path, original, 'utf8');
            assert.doesNotThrow(item.read);
        }
    });

    test('keeps healthy list entries readable while reporting malformed sibling records', () => {
        const chapter = store.saveChapterReport(chapterValue());
        const report = regressionReport();
        const run = store.saveRegressionRun(report);
        const comparison = saveComparison(store, run, report);

        writeRaw(
            store.chapterReportPath(chapter.projectId, chapter.chapterId, 'corrupt-chapter'),
            '{not valid json',
        );
        writeRaw(store.regressionRunPath(run.suiteId, 'corrupt-run'), '{not valid json');
        writeRaw(store.comparisonPath(comparison.suiteId, 'corrupt-comparison'), '{not valid json');

        assert.deepEqual(store.listChapterReports(chapter.projectId, chapter.chapterId), {
            reports: [{
                id: chapter.id,
                projectId: chapter.projectId,
                chapterId: chapter.chapterId,
                source: chapter.source,
                authority: chapter.authority,
                passed: chapter.report.passed,
                severityCounts: chapter.report.metrics.severityCounts,
                reportDigest: chapter.report.reportDigest,
                createdAt: chapter.createdAt,
            }],
            corrupt: [{ id: 'corrupt-chapter', error: 'quality_storage_corrupt' }],
        });
        assert.deepEqual(store.listRegressionRuns(run.suiteId), {
            runs: [{
                id: run.id,
                suiteId: run.suiteId,
                reportDigest: run.report.reportDigest,
                generatedAt: run.report.generatedAt,
                metrics: run.report.metrics,
                createdAt: run.createdAt,
            }],
            corrupt: [{ id: 'corrupt-run', error: 'quality_storage_corrupt' }],
        });
        assert.deepEqual(store.listComparisons(comparison.suiteId), {
            comparisons: [{
                id: comparison.id,
                suiteId: comparison.suiteId,
                candidateRunId: comparison.candidateRunId,
                baseline: comparison.baseline,
                passed: comparison.comparison.passed,
                comparisonDigest: comparison.comparison.comparisonDigest,
                createdAt: comparison.createdAt,
            }],
            corrupt: [{ id: 'corrupt-comparison', error: 'quality_storage_corrupt' }],
        });
    });

    test('rejects traversal and out-of-bound ids before resolving record paths', () => {
        const maximumId = `a${'x'.repeat(127)}`;
        assert.equal(path.isAbsolute(store.chapterReportPath(maximumId, maximumId, maximumId)), true);
        assert.equal(path.isAbsolute(store.regressionRunPath(maximumId, maximumId)), true);
        assert.equal(path.isAbsolute(store.comparisonPath(maximumId, maximumId)), true);

        const invalidIds = [
            '',
            '.',
            '..',
            '../escape',
            'nested/id',
            'nested\\id',
            'question?mark',
            '项目',
            `a${'x'.repeat(128)}`,
            null,
        ];
        for (const value of invalidIds) {
            for (const resolvePath of [
                () => store.chapterReportPath(value, 'chapter', 'report'),
                () => store.chapterReportPath('project', value, 'report'),
                () => store.chapterReportPath('project', 'chapter', value),
                () => store.regressionRunPath(value, 'run'),
                () => store.regressionRunPath('suite', value),
                () => store.comparisonPath(value, 'comparison'),
                () => store.comparisonPath('suite', value),
            ]) {
                assert.throws(
                    resolvePath,
                    error => error.status === 400 && error.code === 'invalid_quality_id',
                );
            }
        }
        assert.throws(
            () => store.safePath('..', 'outside-quality-root'),
            error => error.status === 500 && error.code === 'unsafe_quality_path',
        );
    });
});
