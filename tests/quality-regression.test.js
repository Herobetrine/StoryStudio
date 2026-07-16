import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { BUILTIN_WRITING_PROFILES } from '../src/builtin-writing-profiles.js';
import {
    QUALITY_REGRESSION_SCHEMA_VERSION,
    compareQualityRegression,
    normalizeQualityRegressionSuite,
    runQualityRegression,
} from '../src/quality-regression.js';

const fixtureUrl = new URL('../fixtures/quality-regression-v1.json', import.meta.url);

async function suite() {
    return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

function stable(value) {
    if (value === null || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    if (Array.isArray(value)) return value.map(stable);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function resign(report) {
    const value = structuredClone(report);
    delete value.reportDigest;
    value.reportDigest = createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
    return value;
}

describe('fixed webnovel quality regression gate', () => {
    test('normalizes the public non-user suite and runs every case deterministically', async () => {
        const input = await suite();
        const normalized = normalizeQualityRegressionSuite(input);
        const first = runQualityRegression({
            suite: normalized,
            modelBinding: {
                providerProtocol: 'openai-chat',
                model: 'fixture-evaluator-v1',
                parameters: { temperature: 0, seed: 7 },
            },
        });
        const second = runQualityRegression({
            suite: structuredClone(input),
            modelBinding: {
                providerProtocol: 'openai-chat',
                model: 'fixture-evaluator-v1',
                parameters: { seed: 7, temperature: 0 },
            },
        });
        assert.deepEqual(first, second);
        assert.equal(first.schemaVersion, QUALITY_REGRESSION_SCHEMA_VERSION);
        assert.equal(first.metrics.cases, input.cases.length);
        assert.equal(first.metrics.passedCases, input.cases.length);
        assert.equal(first.metrics.casePassRate, 1);
        assert.equal(first.metrics.profileCompilations, BUILTIN_WRITING_PROFILES.length * 6);
        assert.equal(first.metrics.profileCompileRate, 1);
        assert.equal(first.profiles.every(item => /^[0-9a-f]{64}$/u.test(item.profileHash)), true);
        assert.match(first.reportDigest, /^[0-9a-f]{64}$/u);
    });

    test('records exact expected linter behavior for every fixed case', async () => {
        const report = runQualityRegression({ suite: await suite() });
        const byId = new Map(report.cases.map(item => [item.id, item]));
        assert.equal(byId.get('progression-clean').result.passed, true);
        assert.ok(byId.get('urban-protected-knowledge').quality.issues
            .some(issue => issue.ruleId === 'pov-knowledge-leak'));
        assert.ok(byId.get('suspense-repetition').quality.issues
            .some(issue => issue.ruleId === 'repeated-imagery'));
        assert.ok(byId.get('historical-time-regression').quality.issues
            .some(issue => issue.ruleId === 'time-jump'));
        assert.ok(byId.get('romance-boundary-violation').quality.issues
            .some(issue => issue.ruleId === 'chapter-avoid-hit'));
    });

    test('compares an identical candidate to its baseline without profile drift', async () => {
        const baseline = runQualityRegression({ suite: await suite() });
        const comparison = compareQualityRegression(structuredClone(baseline), baseline);
        assert.equal(comparison.passed, true);
        assert.equal(comparison.gates.every(gate => gate.passed && gate.delta === 0), true);
        assert.equal(comparison.profileDiffs.every(diff => !diff.changed && diff.passed), true);
        assert.match(comparison.comparisonDigest, /^[0-9a-f]{64}$/u);
    });

    test('blocks a candidate when a built-in profile no longer compiles', async () => {
        const input = await suite();
        const baseline = runQualityRegression({ suite: input });
        const brokenProfile = {
            ...structuredClone(BUILTIN_WRITING_PROFILES[0]),
            modules: [{ id: 'broken', slot: 'system', role: 'root', template: 'invalid role' }],
            order: ['broken'],
        };
        const candidate = runQualityRegression({
            suite: input,
            profiles: [brokenProfile, ...BUILTIN_WRITING_PROFILES.slice(1)],
        });
        const comparison = compareQualityRegression(candidate, baseline);
        assert.equal(candidate.metrics.profileCompileRate, 42 / 48);
        assert.equal(comparison.passed, false);
        assert.equal(comparison.gates.find(gate => gate.metric === 'profileCompileRate').passed, false);
        assert.equal(comparison.profileDiffs.filter(diff => !diff.passed).length, 6);
    });

    test('blocks incomplete, added, and duplicate profile-overlay catalogs on either side', async () => {
        const input = await suite();
        const complete = runQualityRegression({ suite: input });
        const missing = runQualityRegression({
            suite: input,
            profiles: BUILTIN_WRITING_PROFILES.slice(1),
        });
        const addedProfile = {
            ...structuredClone(BUILTIN_WRITING_PROFILES[0]),
            id: 'builtin.webnovel.unexpected.v1',
        };
        const added = runQualityRegression({
            suite: input,
            profiles: [...BUILTIN_WRITING_PROFILES, addedProfile],
        });
        const duplicate = runQualityRegression({
            suite: input,
            profiles: [
                ...BUILTIN_WRITING_PROFILES.slice(0, -1),
                structuredClone(BUILTIN_WRITING_PROFILES[0]),
            ],
        });

        for (const [candidate, baseline] of [
            [missing, complete],
            [added, complete],
            [duplicate, complete],
            [complete, missing],
            [complete, added],
            [complete, duplicate],
        ]) {
            assert.throws(
                () => compareQualityRegression(candidate, baseline),
                error => error.code === 'invalid_quality_regression',
            );
        }
    });

    test('blocks changed built-in revisions and inconsistent catalog counts', async () => {
        const complete = runQualityRegression({ suite: await suite() });
        const changedRevision = structuredClone(complete);
        changedRevision.builtinProfileRevision += 1;
        assert.throws(
            () => compareQualityRegression(resign(changedRevision), complete),
            error => error.code === 'invalid_quality_regression',
        );

        const changedCount = structuredClone(complete);
        changedCount.metrics.profileCompilations -= 1;
        assert.throws(
            () => compareQualityRegression(resign(changedCount), complete),
            error => error.code === 'invalid_quality_regression',
        );
    });

    test('refuses comparisons across changed suites or tampered reports', async () => {
        const input = await suite();
        const baseline = runQualityRegression({ suite: input });
        const changedSuite = structuredClone(input);
        changedSuite.revision += 1;
        const candidate = runQualityRegression({ suite: changedSuite });
        assert.throws(
            () => compareQualityRegression(candidate, baseline),
            error => error.code === 'invalid_quality_regression',
        );

        const tampered = structuredClone(baseline);
        tampered.metrics.casePassRate = 0;
        assert.throws(
            () => compareQualityRegression(tampered, baseline),
            error => error.code === 'invalid_quality_regression',
        );
    });

    test('rejects model secrets and malformed suite expectations', async () => {
        const input = await suite();
        assert.throws(
            () => runQualityRegression({ suite: input, modelBinding: { apiKey: 'secret' } }),
            error => error.code === 'invalid_quality_regression',
        );
        assert.throws(
            () => runQualityRegression({
                suite: input,
                modelBinding: { parameters: { authorization: 'Bearer secret' } },
            }),
            error => error.code === 'invalid_quality_regression',
        );
        for (const parameters of [
            { sampling: { credentials: { 'api-key': 'secret' } } },
            { transports: [{ headers: { Authorization: 'Bearer secret' } }] },
            { nested: { deeper: [{ cookie: 'session=secret' }] } },
            { nested: { secret: 'secret' } },
            { nested: { accessToken: 'secret' } },
            { nested: { password: 'secret' } },
        ]) {
            assert.throws(
                () => runQualityRegression({ suite: input, modelBinding: { parameters } }),
                error => error.code === 'invalid_quality_regression',
            );
        }
        assert.doesNotThrow(() => runQualityRegression({
            suite: input,
            modelBinding: { parameters: { headers: { accept: 'application/json' }, temperature: 0 } },
        }));
        const malformed = structuredClone(input);
        malformed.cases[0].expect.requiredRuleIds = ['not-a-rule'];
        assert.throws(
            () => normalizeQualityRegressionSuite(malformed),
            error => error.code === 'invalid_quality_regression',
        );
    });
});
