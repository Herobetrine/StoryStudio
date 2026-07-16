import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError } from './api-error.js';

export const QUALITY_RECORD_SCHEMA_VERSION = 1;

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const CHAPTER_RECORD_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'kind', 'projectId', 'chapterId', 'source', 'authority',
    'input', 'report', 'createdAt', 'recordHash',
]);
const REGRESSION_RECORD_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'kind', 'suiteId', 'report', 'createdAt', 'recordHash',
]);
const COMPARISON_RECORD_FIELDS = Object.freeze([
    'schemaVersion', 'id', 'kind', 'suiteId', 'candidateRunId', 'baseline',
    'comparison', 'createdAt', 'recordHash',
]);

function storageFailure(message, code = 'quality_storage_corrupt', details = {}) {
    throw new ApiError(500, code, message, details);
}

function bad(message, code = 'invalid_quality_record', details = {}) {
    throw new ApiError(400, code, message, details);
}

function assertPlainObject(value, label, { stored = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        if (stored) storageFailure(`${label} must be a plain object.`);
        bad(`${label} must be a plain object.`);
    }
    return value;
}

function assertExactFields(value, fields, label, { stored = false } = {}) {
    assertPlainObject(value, label, { stored });
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    const missing = fields.filter(field => !Object.hasOwn(value, field));
    if (unknown.length > 0 || missing.length > 0) {
        if (stored) storageFailure(`${label} fields are invalid.`, 'quality_storage_corrupt', { unknown, missing });
        bad(`${label} fields are invalid.`, 'invalid_quality_record', { unknown, missing });
    }
}

function cleanId(value, label, { stored = false } = {}) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
        if (stored) storageFailure(`${label} is invalid.`);
        bad(`${label} is invalid.`, 'invalid_quality_id', { field: label });
    }
    return value;
}

function cleanIso(value, label, { stored = false } = {}) {
    if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
        if (stored) storageFailure(`${label} is invalid.`);
        bad(`${label} must be an ISO date-time string.`);
    }
    return value;
}

function cleanPositiveInteger(value, label, { stored = false } = {}) {
    if (!Number.isSafeInteger(value) || value < 1) {
        if (stored) storageFailure(`${label} is invalid.`);
        bad(`${label} must be a positive integer.`);
    }
    return value;
}

function cloneJson(value, label, { stored = false, maximum = MAX_RECORD_BYTES } = {}) {
    let nodes = 0;
    const visit = (item, depth) => {
        nodes += 1;
        if (nodes > 200_000 || depth > 64) {
            if (stored) storageFailure(`${label} is too complex.`);
            bad(`${label} is too complex.`, 'quality_record_too_large');
        }
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (Array.isArray(item)) {
            for (const child of item) visit(child, depth + 1);
            return;
        }
        if (item && typeof item === 'object'
            && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
            for (const [key, child] of Object.entries(item)) {
                if (FORBIDDEN_KEYS.has(key)) {
                    if (stored) storageFailure(`${label} contains a forbidden key.`);
                    bad(`${label} contains a forbidden key.`);
                }
                visit(child, depth + 1);
            }
            return;
        }
        if (stored) storageFailure(`${label} contains a non-JSON value.`);
        bad(`${label} must contain only JSON values.`);
    };
    visit(value, 0);
    let json;
    try {
        json = JSON.stringify(value);
    } catch {
        if (stored) storageFailure(`${label} is not JSON serializable.`);
        bad(`${label} must be JSON serializable.`);
    }
    if (Buffer.byteLength(json, 'utf8') > maximum) {
        if (stored) storageFailure(`${label} exceeds the storage limit.`, 'quality_record_too_large');
        bad(`${label} exceeds the storage limit.`, 'quality_record_too_large', { maximum });
    }
    return JSON.parse(json);
}

function stable(value) {
    if (value === null || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    if (Array.isArray(value)) return value.map(stable);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
    const source = typeof value === 'string' ? value : JSON.stringify(stable(value));
    return createHash('sha256').update(source, 'utf8').digest('hex');
}

function seal(record) {
    const { recordHash: ignored, ...payload } = record;
    return { ...payload, recordHash: digest(payload) };
}

function verifySeal(record, label) {
    const { recordHash, ...payload } = record;
    if (typeof recordHash !== 'string' || !HASH.test(recordHash) || recordHash !== digest(payload)) {
        storageFailure(`${label} record hash is invalid.`, 'quality_storage_tampered');
    }
}

function validateSource(value, { stored = false } = {}) {
    const source = assertPlainObject(value, 'quality source', { stored });
    const fields = source.type === 'chapter' ? ['type', 'generationId'] : ['type', 'generationId'];
    assertExactFields(source, fields, 'quality source', { stored });
    if (!['chapter', 'generation'].includes(source.type)) {
        if (stored) storageFailure('quality source type is invalid.');
        bad('quality source type is invalid.');
    }
    if (source.type === 'chapter' && source.generationId !== null) {
        if (stored) storageFailure('chapter quality source cannot have generationId.');
        bad('chapter quality source cannot have generationId.');
    }
    if (source.type === 'generation') cleanId(source.generationId, 'quality source.generationId', { stored });
    return source;
}

function validateAuthority(value, { stored = false } = {}) {
    const authority = assertPlainObject(value, 'quality authority', { stored });
    assertExactFields(authority, [
        'projectVersion', 'chapterRevision', 'volumeId', 'volumeRevision', 'contentDigest',
    ], 'quality authority', { stored });
    cleanPositiveInteger(authority.projectVersion, 'quality authority.projectVersion', { stored });
    cleanPositiveInteger(authority.chapterRevision, 'quality authority.chapterRevision', { stored });
    cleanId(authority.volumeId, 'quality authority.volumeId', { stored });
    cleanPositiveInteger(authority.volumeRevision, 'quality authority.volumeRevision', { stored });
    if (typeof authority.contentDigest !== 'string' || !HASH.test(authority.contentDigest)) {
        if (stored) storageFailure('quality authority.contentDigest is invalid.');
        bad('quality authority.contentDigest is invalid.');
    }
    return authority;
}

function validateChapterRecord(value, expected = {}, { requireHash = true } = {}) {
    const record = cloneJson(value, 'chapter quality record', { stored: requireHash });
    assertExactFields(record, CHAPTER_RECORD_FIELDS, 'chapter quality record', { stored: requireHash });
    if (record.schemaVersion !== QUALITY_RECORD_SCHEMA_VERSION || record.kind !== 'chapter-quality') {
        if (requireHash) storageFailure('Chapter quality record schema or kind is invalid.');
        bad('Chapter quality record schema or kind is invalid.');
    }
    cleanId(record.id, 'chapter quality record.id', { stored: requireHash });
    cleanId(record.projectId, 'chapter quality record.projectId', { stored: requireHash });
    cleanId(record.chapterId, 'chapter quality record.chapterId', { stored: requireHash });
    if ((expected.id && record.id !== expected.id)
        || (expected.projectId && record.projectId !== expected.projectId)
        || (expected.chapterId && record.chapterId !== expected.chapterId)) {
        storageFailure('Chapter quality record identity does not match its path.', 'quality_storage_tampered');
    }
    validateSource(record.source, { stored: requireHash });
    validateAuthority(record.authority, { stored: requireHash });
    assertPlainObject(record.input, 'chapter quality record.input', { stored: requireHash });
    assertPlainObject(record.report, 'chapter quality record.report', { stored: requireHash });
    if (typeof record.input.content !== 'string'
        || digest(record.input.content) !== record.authority.contentDigest
        || record.report.contentDigest !== record.authority.contentDigest
        || typeof record.report.reportDigest !== 'string'
        || !HASH.test(record.report.reportDigest)) {
        if (requireHash) storageFailure('Chapter quality record content binding is invalid.');
        bad('Chapter quality record content binding is invalid.');
    }
    cleanIso(record.createdAt, 'chapter quality record.createdAt', { stored: requireHash });
    if (requireHash) verifySeal(record, 'Chapter quality');
    return record;
}

function validateRegressionRecord(value, expected = {}, { requireHash = true } = {}) {
    const record = cloneJson(value, 'quality regression record', { stored: requireHash });
    assertExactFields(record, REGRESSION_RECORD_FIELDS, 'quality regression record', { stored: requireHash });
    if (record.schemaVersion !== QUALITY_RECORD_SCHEMA_VERSION || record.kind !== 'quality-regression') {
        if (requireHash) storageFailure('Quality regression record schema or kind is invalid.');
        bad('Quality regression record schema or kind is invalid.');
    }
    cleanId(record.id, 'quality regression record.id', { stored: requireHash });
    cleanId(record.suiteId, 'quality regression record.suiteId', { stored: requireHash });
    if ((expected.id && record.id !== expected.id) || (expected.suiteId && record.suiteId !== expected.suiteId)) {
        storageFailure('Quality regression record identity does not match its path.', 'quality_storage_tampered');
    }
    assertPlainObject(record.report, 'quality regression record.report', { stored: requireHash });
    if (record.report?.suite?.id !== record.suiteId
        || typeof record.report.reportDigest !== 'string'
        || !HASH.test(record.report.reportDigest)) {
        if (requireHash) storageFailure('Quality regression report binding is invalid.');
        bad('Quality regression report binding is invalid.');
    }
    cleanIso(record.createdAt, 'quality regression record.createdAt', { stored: requireHash });
    if (requireHash) verifySeal(record, 'Quality regression');
    return record;
}

function validateComparisonRecord(value, expected = {}, { requireHash = true } = {}) {
    const record = cloneJson(value, 'quality comparison record', { stored: requireHash });
    assertExactFields(record, COMPARISON_RECORD_FIELDS, 'quality comparison record', { stored: requireHash });
    if (record.schemaVersion !== QUALITY_RECORD_SCHEMA_VERSION || record.kind !== 'quality-regression-comparison') {
        if (requireHash) storageFailure('Quality comparison record schema or kind is invalid.');
        bad('Quality comparison record schema or kind is invalid.');
    }
    cleanId(record.id, 'quality comparison record.id', { stored: requireHash });
    cleanId(record.suiteId, 'quality comparison record.suiteId', { stored: requireHash });
    cleanId(record.candidateRunId, 'quality comparison record.candidateRunId', { stored: requireHash });
    if ((expected.id && record.id !== expected.id) || (expected.suiteId && record.suiteId !== expected.suiteId)) {
        storageFailure('Quality comparison record identity does not match its path.', 'quality_storage_tampered');
    }
    assertPlainObject(record.baseline, 'quality comparison record.baseline', { stored: requireHash });
    assertPlainObject(record.comparison, 'quality comparison record.comparison', { stored: requireHash });
    if (!['fixture', 'run'].includes(record.baseline.type)
        || (record.baseline.type === 'run' && !SAFE_ID.test(record.baseline.id ?? ''))
        || typeof record.baseline.reportDigest !== 'string'
        || !HASH.test(record.baseline.reportDigest)
        || typeof record.comparison.comparisonDigest !== 'string'
        || !HASH.test(record.comparison.comparisonDigest)) {
        if (requireHash) storageFailure('Quality comparison binding is invalid.');
        bad('Quality comparison binding is invalid.');
    }
    cleanIso(record.createdAt, 'quality comparison record.createdAt', { stored: requireHash });
    if (requireHash) verifySeal(record, 'Quality comparison');
    return record;
}

function chapterSummary(record) {
    return {
        id: record.id,
        projectId: record.projectId,
        chapterId: record.chapterId,
        source: record.source,
        authority: record.authority,
        passed: record.report.passed,
        severityCounts: record.report.metrics?.severityCounts ?? {},
        reportDigest: record.report.reportDigest,
        createdAt: record.createdAt,
    };
}

function regressionSummary(record) {
    return {
        id: record.id,
        suiteId: record.suiteId,
        reportDigest: record.report.reportDigest,
        generatedAt: record.report.generatedAt ?? null,
        metrics: record.report.metrics,
        createdAt: record.createdAt,
    };
}

function comparisonSummary(record) {
    return {
        id: record.id,
        suiteId: record.suiteId,
        candidateRunId: record.candidateRunId,
        baseline: record.baseline,
        passed: record.comparison.passed,
        comparisonDigest: record.comparison.comparisonDigest,
        createdAt: record.createdAt,
    };
}

export class QualityStore {
    constructor(rootDirectory) {
        if (typeof rootDirectory !== 'string' || !rootDirectory) {
            throw new TypeError('QualityStore requires a root directory.');
        }
        this.rootDirectory = path.resolve(rootDirectory);
        fs.mkdirSync(this.rootDirectory, { recursive: true });
        const stat = fs.lstatSync(this.rootDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            storageFailure('Quality storage root must be a real directory.', 'unsafe_quality_path');
        }
        this.ensureDirectory(this.safePath('projects'));
        this.ensureDirectory(this.safePath('regression'));
    }

    safePath(...segments) {
        const target = path.resolve(this.rootDirectory, ...segments);
        if (target !== this.rootDirectory && !target.startsWith(`${this.rootDirectory}${path.sep}`)) {
            storageFailure('Quality storage path escaped its root.', 'unsafe_quality_path');
        }
        this.assertNoLinks(target);
        return target;
    }

    assertNoLinks(target) {
        const relative = path.relative(this.rootDirectory, target);
        let current = this.rootDirectory;
        if (!relative) return;
        for (const segment of relative.split(path.sep)) {
            current = path.join(current, segment);
            if (!fs.existsSync(current)) continue;
            if (fs.lstatSync(current).isSymbolicLink()) {
                storageFailure('Quality storage cannot traverse symbolic links or junctions.', 'unsafe_quality_path');
            }
        }
    }

    ensureDirectory(directory) {
        this.assertNoLinks(directory);
        fs.mkdirSync(directory, { recursive: true });
        this.assertNoLinks(directory);
        if (!fs.lstatSync(directory).isDirectory()) {
            storageFailure('Quality storage path is not a directory.', 'unsafe_quality_path');
        }
    }

    writeJson(filePath, value) {
        this.ensureDirectory(path.dirname(filePath));
        if (fs.existsSync(filePath)) {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                storageFailure('Quality record path is unsafe.', 'unsafe_quality_path');
            }
        }
        const json = JSON.stringify(value, null, 2);
        if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
            bad('Quality record exceeds the storage limit.', 'quality_record_too_large', { maximum: MAX_RECORD_BYTES });
        }
        writeFileAtomicSync(filePath, json, { encoding: 'utf8', mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (error) {
            if (process.platform !== 'win32') throw error;
        }
    }

    readJson(filePath, label) {
        this.assertNoLinks(filePath);
        if (!fs.existsSync(filePath)) return null;
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES) {
            storageFailure(`${label} path or size is invalid.`, 'unsafe_quality_path');
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            storageFailure(`${label} is invalid JSON.`);
        }
    }

    chapterReportPath(projectId, chapterId, reportId) {
        return this.safePath(
            'projects',
            cleanId(projectId, 'projectId'),
            'chapters',
            cleanId(chapterId, 'chapterId'),
            'reports',
            `${cleanId(reportId, 'reportId')}.json`,
        );
    }

    regressionRunPath(suiteId, runId) {
        return this.safePath(
            'regression',
            cleanId(suiteId, 'suiteId'),
            'runs',
            `${cleanId(runId, 'runId')}.json`,
        );
    }

    comparisonPath(suiteId, comparisonId) {
        return this.safePath(
            'regression',
            cleanId(suiteId, 'suiteId'),
            'comparisons',
            `${cleanId(comparisonId, 'comparisonId')}.json`,
        );
    }

    saveChapterReport(value) {
        const timestamp = new Date().toISOString();
        const record = validateChapterRecord(seal({
            schemaVersion: QUALITY_RECORD_SCHEMA_VERSION,
            id: randomUUID(),
            kind: 'chapter-quality',
            projectId: value.projectId,
            chapterId: value.chapterId,
            source: value.source,
            authority: value.authority,
            input: value.input,
            report: value.report,
            createdAt: timestamp,
        }), {}, { requireHash: true });
        this.writeJson(this.chapterReportPath(record.projectId, record.chapterId, record.id), record);
        return structuredClone(record);
    }

    getChapterReport(projectId, chapterId, reportId) {
        const filePath = this.chapterReportPath(projectId, chapterId, reportId);
        const value = this.readJson(filePath, 'Chapter quality report');
        if (!value) throw new ApiError(404, 'quality_report_not_found', 'Chapter quality report not found.');
        return validateChapterRecord(value, { projectId, chapterId, id: reportId });
    }

    listChapterReports(projectId, chapterId) {
        const project = cleanId(projectId, 'projectId');
        const chapter = cleanId(chapterId, 'chapterId');
        const directory = this.safePath('projects', project, 'chapters', chapter, 'reports');
        if (!fs.existsSync(directory)) return { reports: [], corrupt: [] };
        this.assertNoLinks(directory);
        const reports = [];
        const corrupt = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
            if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_ID.test(id)) continue;
            try {
                reports.push(chapterSummary(this.getChapterReport(project, chapter, id)));
            } catch (error) {
                corrupt.push({ id, error: error?.code ?? 'quality_storage_corrupt' });
            }
        }
        reports.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        corrupt.sort((left, right) => left.id.localeCompare(right.id));
        return { reports, corrupt };
    }

    saveRegressionRun(report) {
        const timestamp = new Date().toISOString();
        const record = validateRegressionRecord(seal({
            schemaVersion: QUALITY_RECORD_SCHEMA_VERSION,
            id: randomUUID(),
            kind: 'quality-regression',
            suiteId: report?.suite?.id,
            report,
            createdAt: timestamp,
        }), {}, { requireHash: true });
        this.writeJson(this.regressionRunPath(record.suiteId, record.id), record);
        return structuredClone(record);
    }

    getRegressionRun(suiteId, runId) {
        const filePath = this.regressionRunPath(suiteId, runId);
        const value = this.readJson(filePath, 'Quality regression run');
        if (!value) throw new ApiError(404, 'quality_regression_run_not_found', 'Quality regression run not found.');
        return validateRegressionRecord(value, { suiteId, id: runId });
    }

    listRegressionRuns(suiteId) {
        const suite = cleanId(suiteId, 'suiteId');
        const directory = this.safePath('regression', suite, 'runs');
        if (!fs.existsSync(directory)) return { runs: [], corrupt: [] };
        this.assertNoLinks(directory);
        const runs = [];
        const corrupt = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
            if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_ID.test(id)) continue;
            try {
                runs.push(regressionSummary(this.getRegressionRun(suite, id)));
            } catch (error) {
                corrupt.push({ id, error: error?.code ?? 'quality_storage_corrupt' });
            }
        }
        runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        corrupt.sort((left, right) => left.id.localeCompare(right.id));
        return { runs, corrupt };
    }

    saveComparison(value) {
        const timestamp = new Date().toISOString();
        const record = validateComparisonRecord(seal({
            schemaVersion: QUALITY_RECORD_SCHEMA_VERSION,
            id: randomUUID(),
            kind: 'quality-regression-comparison',
            suiteId: value.suiteId,
            candidateRunId: value.candidateRunId,
            baseline: value.baseline,
            comparison: value.comparison,
            createdAt: timestamp,
        }), {}, { requireHash: true });
        this.writeJson(this.comparisonPath(record.suiteId, record.id), record);
        return structuredClone(record);
    }

    getComparison(suiteId, comparisonId) {
        const filePath = this.comparisonPath(suiteId, comparisonId);
        const value = this.readJson(filePath, 'Quality regression comparison');
        if (!value) throw new ApiError(404, 'quality_comparison_not_found', 'Quality comparison not found.');
        return validateComparisonRecord(value, { suiteId, id: comparisonId });
    }

    listComparisons(suiteId) {
        const suite = cleanId(suiteId, 'suiteId');
        const directory = this.safePath('regression', suite, 'comparisons');
        if (!fs.existsSync(directory)) return { comparisons: [], corrupt: [] };
        this.assertNoLinks(directory);
        const comparisons = [];
        const corrupt = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
            if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_ID.test(id)) continue;
            try {
                comparisons.push(comparisonSummary(this.getComparison(suite, id)));
            } catch (error) {
                corrupt.push({ id, error: error?.code ?? 'quality_storage_corrupt' });
            }
        }
        comparisons.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        corrupt.sort((left, right) => left.id.localeCompare(right.id));
        return { comparisons, corrupt };
    }
}
