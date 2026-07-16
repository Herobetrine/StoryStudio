import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(projectRoot, 'scripts', 'quality-regression-cli.js');
const fixturePath = path.join(projectRoot, 'fixtures', 'quality-regression-v1.json');

function temporaryDirectory(t) {
    const directory = mkdtempSync(path.join(tmpdir(), 'StoryStudio quality CLI with spaces-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function runCli(arguments_, environment = {}) {
    const env = { ...process.env };
    delete env.STORY_STUDIO_DATA_ROOT;
    Object.assign(env, environment);
    return spawnSync(process.execPath, [cliPath, ...arguments_], {
        cwd: projectRoot,
        encoding: 'utf8',
        env,
        timeout: 60_000,
        windowsHide: true,
    });
}

function parseSingleJsonLine(result) {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1, `expected one JSON line, received:\n${result.stdout}`);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
    return JSON.parse(lines[0]);
}

function regressionRunPath(dataRoot, output) {
    return path.join(
        dataRoot,
        'quality',
        'regression',
        output.suiteId,
        'runs',
        `${output.runId}.json`,
    );
}

describe('quality regression CLI', () => {
    test('run uses STORY_STUDIO_DATA_ROOT and emits one successful JSON result', t => {
        const directory = temporaryDirectory(t);
        const dataRoot = path.join(directory, 'Environment Data Root');
        const parameters = {
            temperature: 0,
            sampling: { topP: 0.85 },
        };
        const result = runCli([
            'run',
            '--protocol', 'openai-chat',
            '--model', 'fixture-model-v1',
            '--parameters', JSON.stringify(parameters),
        ], {
            STORY_STUDIO_DATA_ROOT: dataRoot,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseSingleJsonLine(result);
        assert.equal(output.ok, true);
        assert.equal(output.command, 'run');
        assert.equal(output.suiteId, 'story-studio-public-webnovel-v1');
        assert.match(output.runId, /^[0-9a-f-]{36}$/u);
        assert.match(output.reportDigest, /^[0-9a-f]{64}$/u);
        assert.equal(output.metrics.casePassRate, 1);

        const recordPath = regressionRunPath(dataRoot, output);
        assert.equal(existsSync(recordPath), true);
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        assert.equal(record.report.modelBinding.providerProtocol, 'openai-chat');
        assert.equal(record.report.modelBinding.model, 'fixture-model-v1');
        assert.deepEqual(record.report.modelBinding.parameters, parameters);
    });

    test('--data-root overrides STORY_STUDIO_DATA_ROOT and accepts a Windows path containing spaces', t => {
        const directory = temporaryDirectory(t);
        const environmentRoot = path.join(directory, 'Unused Environment Root');
        const argumentRoot = path.join(directory, 'Selected CLI Data Root With Spaces');
        const result = runCli([
            'run',
            '--data-root', argumentRoot,
        ], {
            STORY_STUDIO_DATA_ROOT: environmentRoot,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseSingleJsonLine(result);
        assert.equal(output.ok, true);
        assert.equal(existsSync(regressionRunPath(argumentRoot, output)), true);
        assert.equal(existsSync(path.join(environmentRoot, 'quality')), false);
    });

    test('baseline writes a manifest and check records a passing comparison using spaced paths', t => {
        const directory = temporaryDirectory(t);
        const suiteDirectory = path.join(directory, 'Suite Fixtures With Spaces');
        const suitePath = path.join(suiteDirectory, 'quality suite.json');
        const baselinePath = path.join(directory, 'Baseline Fixtures With Spaces', 'quality baseline.json');
        const dataRoot = path.join(directory, 'Check Results With Spaces');
        mkdirSync(suiteDirectory, { recursive: true });
        copyFileSync(fixturePath, suitePath);

        const baselineResult = runCli([
            'baseline',
            '--suite', suitePath,
            '--write', baselinePath,
        ]);
        assert.equal(baselineResult.status, 0, baselineResult.stderr || baselineResult.stdout);
        const baselineOutput = parseSingleJsonLine(baselineResult);
        assert.equal(baselineOutput.ok, true);
        assert.equal(baselineOutput.command, 'baseline');
        assert.equal(path.normalize(baselineOutput.path), path.resolve(baselinePath));
        assert.match(baselineOutput.reportDigest, /^[0-9a-f]{64}$/u);
        assert.equal(existsSync(baselinePath), true);

        const manifest = JSON.parse(readFileSync(baselinePath, 'utf8'));
        assert.equal(manifest.schemaVersion, 1);
        assert.equal(manifest.suiteId, 'story-studio-public-webnovel-v1');
        assert.equal(manifest.reportDigest, baselineOutput.reportDigest);

        const checkResult = runCli([
            'check',
            '--suite', suitePath,
            '--baseline', baselinePath,
            '--data-root', dataRoot,
            '--parameters', JSON.stringify({ temperature: 0 }),
        ]);
        assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
        const checkOutput = parseSingleJsonLine(checkResult);
        assert.equal(checkOutput.ok, true);
        assert.equal(checkOutput.command, 'check');
        assert.equal(checkOutput.baselineDigest, baselineOutput.reportDigest);
        assert.equal(checkOutput.gates.every(gate => gate.passed), true);
        assert.equal(existsSync(regressionRunPath(dataRoot, {
            ...checkOutput,
            suiteId: 'story-studio-public-webnovel-v1',
        })), true);
        assert.equal(existsSync(path.join(
            dataRoot,
            'quality',
            'regression',
            'story-studio-public-webnovel-v1',
            'comparisons',
            `${checkOutput.comparisonId}.json`,
        )), true);
    });

    test('nested model secrets fail with JSON exit code 2 without echoing the secret value', t => {
        const directory = temporaryDirectory(t);
        const dataRoot = path.join(directory, 'Rejected Secret Data Root');
        const secretValue = 'CLI_SECRET_MUST_NOT_BE_ECHOED_7f4d2b';
        const result = runCli([
            'run',
            '--data-root', dataRoot,
            '--parameters', JSON.stringify({
                sampling: {
                    transports: [
                        {
                            credentials: {
                                'api-key': secretValue,
                            },
                        },
                    ],
                },
            }),
        ]);

        assert.equal(result.status, 2, result.stderr || result.stdout);
        const output = parseSingleJsonLine(result);
        assert.equal(output.ok, false);
        assert.equal(output.error, 'invalid_quality_regression');
        assert.match(output.message, /secret field/iu);
        assert.equal(`${result.stdout}${result.stderr}`.includes(secretValue), false);
        assert.equal(existsSync(path.join(dataRoot, 'quality')), false);
    });
});
