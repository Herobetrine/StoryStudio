import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import {
    assertQualityBaselineManifest,
    createQualityBaselineManifest,
} from '../src/quality-baseline.js';
import {
    compareQualityRegression,
    normalizeQualityRegressionSuite,
    runQualityRegression,
} from '../src/quality-regression.js';
import { QualityStore } from '../src/quality-store.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSuitePath = path.join(projectRoot, 'fixtures', 'quality-regression-v1.json');
const defaultBaselinePath = path.join(projectRoot, 'fixtures', 'quality-regression-baseline-v1.json');

function parseArguments(argv) {
    const [command = '', ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
        const name = token.slice(2);
        const value = rest[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
        options[name] = value;
        index += 1;
    }
    return { command, options };
}

function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        throw new Error(`${label} is not readable JSON.`);
    }
}

function loadSuite(options) {
    const suitePath = path.resolve(options.suite ?? defaultSuitePath);
    return normalizeQualityRegressionSuite(readJson(suitePath, 'Quality regression suite'));
}

function modelBinding(options) {
    let parameters = {};
    if (options.parameters !== undefined) {
        try {
            parameters = JSON.parse(options.parameters);
        } catch {
            throw new Error('--parameters must be valid JSON.');
        }
    }
    return {
        providerProtocol: options.protocol ?? 'deterministic',
        model: options.model ?? 'none',
        parameters,
    };
}

function storeFor(options) {
    const dataRoot = path.resolve(options['data-root']
        ?? process.env.STORY_STUDIO_DATA_ROOT
        ?? path.join(projectRoot, 'data'));
    return new QualityStore(path.join(dataRoot, 'quality'));
}

function canonicalBaseline(suite, options) {
    const report = runQualityRegression({ suite });
    const baselinePath = path.resolve(options.baseline ?? defaultBaselinePath);
    const manifest = readJson(baselinePath, 'Quality regression baseline');
    assertQualityBaselineManifest(manifest, report, suite.revision);
    return { report, baselinePath };
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runCommand(options) {
    const suite = loadSuite(options);
    const report = runQualityRegression({
        suite,
        modelBinding: modelBinding(options),
        generatedAt: new Date().toISOString(),
    });
    const record = storeFor(options).saveRegressionRun(report);
    print({
        ok: true,
        command: 'run',
        runId: record.id,
        suiteId: record.suiteId,
        reportDigest: record.report.reportDigest,
        metrics: record.report.metrics,
    });
}

function checkCommand(options) {
    const suite = loadSuite(options);
    const baseline = canonicalBaseline(suite, options);
    const candidateReport = runQualityRegression({
        suite,
        modelBinding: modelBinding(options),
        generatedAt: new Date().toISOString(),
    });
    const store = storeFor(options);
    const run = store.saveRegressionRun(candidateReport);
    const comparison = compareQualityRegression(candidateReport, baseline.report);
    const comparisonRecord = store.saveComparison({
        suiteId: suite.id,
        candidateRunId: run.id,
        baseline: {
            type: 'fixture',
            id: suite.id,
            reportDigest: baseline.report.reportDigest,
        },
        comparison,
    });
    print({
        ok: comparison.passed,
        command: 'check',
        runId: run.id,
        comparisonId: comparisonRecord.id,
        reportDigest: candidateReport.reportDigest,
        baselineDigest: baseline.report.reportDigest,
        comparisonDigest: comparison.comparisonDigest,
        gates: comparison.gates,
    });
    if (!comparison.passed) process.exitCode = 1;
}

function baselineCommand(options) {
    if (!options.write) throw new Error('baseline requires --write <path>.');
    const suite = loadSuite(options);
    const report = runQualityRegression({ suite });
    const manifest = createQualityBaselineManifest(report, suite.revision);
    const outputPath = path.resolve(options.write);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileAtomicSync(outputPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    print({
        ok: true,
        command: 'baseline',
        path: outputPath,
        reportDigest: report.reportDigest,
    });
}

try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'run') runCommand(options);
    else if (command === 'check') checkCommand(options);
    else if (command === 'baseline') baselineCommand(options);
    else throw new Error('Usage: quality-regression-cli.js <run|check|baseline> [options]');
} catch (error) {
    print({
        ok: false,
        error: error?.code ?? 'quality_cli_error',
        message: error?.message ?? 'Quality regression command failed.',
    });
    process.exitCode = 2;
}
