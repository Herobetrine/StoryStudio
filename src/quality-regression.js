import { createHash } from 'node:crypto';

import { compilePromptProfile } from '../public/prompt-profile-compiler.js';
import {
    BUILTIN_WRITING_PROFILE_REVISION,
    BUILTIN_WRITING_PROFILES,
    GENRE_OVERLAYS,
} from './builtin-writing-profiles.js';
import { ApiError } from './api-error.js';
import { QUALITY_RULES, lintChapterQuality } from './quality-linter.js';

export const QUALITY_REGRESSION_SCHEMA_VERSION = 1;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_CASES = 100;
const MAX_TEXT = 5_000_000;
const FORBIDDEN_BINDING_KEYS = /(?:api[-_]?key|authorization|cookie|secret|token|password)/iu;
const PROFILE_OVERLAY_IDS = Object.freeze(['none', ...GENRE_OVERLAYS.map(item => item.id)]);
const EXPECTED_PROFILE_CATALOG = Object.freeze(BUILTIN_WRITING_PROFILES.flatMap(profile => (
    PROFILE_OVERLAY_IDS.map(genreOverlay => Object.freeze({
        profileId: profile.id,
        genreOverlay,
    }))
)));

function fail(message, details = {}) {
    throw new ApiError(400, 'invalid_quality_regression', message, details);
}

function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object.`);
    return value;
}

function known(value, fields, label) {
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    if (unknown.length > 0) fail(`${label} contains unknown fields.`, { fields: unknown });
}

function text(value, label, maximum, { optional = false } = {}) {
    if (optional && (value === undefined || value === null)) return '';
    if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) {
        fail(`${label} must be a bounded non-empty string.`);
    }
    return value;
}

function identifier(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid.`);
    return value;
}

function integer(value, label, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
}

function stable(value) {
    if (value === null || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    if (Array.isArray(value)) return value.map(stable);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function cloneJson(value, label, depth = 0) {
    if (depth > 12) fail(`${label} is too deeply nested.`);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (Array.isArray(value)) {
        if (value.length > 1_000) fail(`${label} contains too many items.`);
        return value.map((item, index) => cloneJson(item, `${label}[${index}]`, depth + 1));
    }
    const source = plain(value, label);
    const entries = Object.entries(source);
    if (entries.length > 1_000) fail(`${label} contains too many fields.`);
    return Object.fromEntries(entries.map(([key, item]) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}.${key} is forbidden.`);
        return [key, cloneJson(item, `${label}.${key}`, depth + 1)];
    }));
}

function rejectForbiddenBindingKeys(value, label) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => rejectForbiddenBindingKeys(item, `${label}[${index}]`));
        return;
    }
    Object.entries(value).forEach(([key, item]) => {
        if (FORBIDDEN_BINDING_KEYS.test(key)) {
            fail('Model binding parameters contain a secret field.', { field: `${label}.${key}` });
        }
        rejectForbiddenBindingKeys(item, `${label}.${key}`);
    });
}

function normalizeRuleIds(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > QUALITY_RULES.length) fail(`${label} must be a bounded array.`);
    const result = value.map((ruleId, index) => {
        if (!QUALITY_RULES.includes(ruleId)) fail(`${label}[${index}] is unknown.`);
        return ruleId;
    });
    if (new Set(result).size !== result.length) fail(`${label} contains duplicate rules.`);
    return result;
}

function normalizeExpectation(value = {}) {
    const input = plain(value, 'case.expect');
    known(input, ['requiredRuleIds', 'forbiddenRuleIds', 'maxBlockers', 'maxMajors'], 'case.expect');
    const requiredRuleIds = normalizeRuleIds(input.requiredRuleIds, 'case.expect.requiredRuleIds');
    const forbiddenRuleIds = normalizeRuleIds(input.forbiddenRuleIds, 'case.expect.forbiddenRuleIds');
    const overlap = requiredRuleIds.filter(ruleId => forbiddenRuleIds.includes(ruleId));
    if (overlap.length > 0) fail('case.expect requires and forbids the same rule.', { ruleIds: overlap });
    return {
        requiredRuleIds,
        forbiddenRuleIds,
        maxBlockers: integer(input.maxBlockers ?? 0, 'case.expect.maxBlockers', 0, 1_000),
        maxMajors: integer(input.maxMajors ?? 0, 'case.expect.maxMajors', 0, 1_000),
    };
}

function normalizeCase(value, index) {
    const input = plain(value, `cases[${index}]`);
    known(input, [
        'id', 'title', 'genreOverlay', 'content', 'chapterCard', 'volumeGoal', 'promises', 'entities',
        'protectedFacts', 'linterInput', 'expect',
    ], `cases[${index}]`);
    const overlayIds = new Set(['none', ...GENRE_OVERLAYS.map(item => item.id)]);
    const genreOverlay = identifier(input.genreOverlay ?? 'none', `cases[${index}].genreOverlay`);
    if (!overlayIds.has(genreOverlay)) fail(`cases[${index}].genreOverlay is unknown.`);
    const rawLinterInput = input.linterInput !== undefined
        ? plain(input.linterInput, `cases[${index}].linterInput`)
        : {
            content: text(input.content, `cases[${index}].content`, MAX_TEXT),
            ...(input.chapterCard !== undefined ? { chapterCard: input.chapterCard } : {}),
            ...(input.volumeGoal !== undefined ? { volumeGoal: input.volumeGoal } : {}),
            ...(input.promises !== undefined ? { promises: input.promises } : {}),
            ...(input.entities !== undefined ? { entities: input.entities } : {}),
            ...(input.protectedFacts !== undefined ? { protectedFacts: input.protectedFacts } : {}),
        };
    if (input.linterInput !== undefined && [
        'content', 'chapterCard', 'volumeGoal', 'promises', 'entities', 'protectedFacts',
    ].some(field => input[field] !== undefined)) {
        fail(`cases[${index}] cannot mix linterInput with source linter fields.`);
    }
    const linterInput = cloneJson(rawLinterInput, `cases[${index}].linterInput`);
    lintChapterQuality(linterInput);
    return {
        id: identifier(input.id, `cases[${index}].id`),
        title: text(input.title, `cases[${index}].title`, 200),
        genreOverlay,
        linterInput,
        expect: normalizeExpectation(input.expect ?? {}),
    };
}

export function normalizeQualityRegressionSuite(value) {
    const input = plain(value, 'quality regression suite');
    known(input, ['schemaVersion', 'id', 'name', 'revision', 'cases'], 'quality regression suite');
    if (input.schemaVersion !== QUALITY_REGRESSION_SCHEMA_VERSION) fail('Quality regression schema is unsupported.');
    if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > MAX_CASES) {
        fail(`Quality regression suite must contain from 1 to ${MAX_CASES} cases.`);
    }
    const cases = input.cases.map(normalizeCase);
    if (new Set(cases.map(item => item.id)).size !== cases.length) fail('Quality regression case ids must be unique.');
    return {
        schemaVersion: QUALITY_REGRESSION_SCHEMA_VERSION,
        id: identifier(input.id, 'suite.id'),
        name: text(input.name, 'suite.name', 200),
        revision: integer(input.revision, 'suite.revision', 1, 1_000_000),
        cases,
    };
}

function normalizeModelBinding(value = {}) {
    const input = plain(value, 'model binding');
    known(input, ['providerProtocol', 'model', 'parameters'], 'model binding');
    if (Object.keys(input).some(key => FORBIDDEN_BINDING_KEYS.test(key))) fail('Model binding contains a secret field.');
    const parameters = cloneJson(input.parameters ?? {}, 'model binding.parameters');
    rejectForbiddenBindingKeys(parameters, 'model binding.parameters');
    const serialized = JSON.stringify(parameters);
    if (serialized.length > 100_000) fail('Model binding parameters are oversized.');
    return {
        providerProtocol: text(input.providerProtocol ?? 'deterministic', 'model binding.providerProtocol', 64),
        model: text(input.model ?? 'none', 'model binding.model', 256),
        parameters,
    };
}

function evaluateCase(testCase, report) {
    const rules = new Set(report.issues.map(issue => issue.ruleId));
    const missingRequired = testCase.expect.requiredRuleIds.filter(ruleId => !rules.has(ruleId));
    const presentForbidden = testCase.expect.forbiddenRuleIds.filter(ruleId => rules.has(ruleId));
    const blockers = report.metrics.severityCounts.blocker;
    const majors = report.metrics.severityCounts.major;
    return {
        passed: missingRequired.length === 0
            && presentForbidden.length === 0
            && blockers <= testCase.expect.maxBlockers
            && majors <= testCase.expect.maxMajors,
        missingRequired,
        presentForbidden,
        blockers,
        majors,
    };
}

function compileProfiles(profiles) {
    const results = [];
    for (const profile of profiles) {
        const task = profile?.compatibility?.task;
        for (const genreOverlay of ['none', ...GENRE_OVERLAYS.map(item => item.id)]) {
            const compiled = compilePromptProfile(profile, { task, variables: { genreOverlay } });
            results.push({
                profileId: profile.id,
                profileRevision: profile?.compatibility?.builtinRevision ?? null,
                task,
                genreOverlay,
                profileHash: compiled.profileHash,
                passed: compiled.errors.length === 0,
                errors: compiled.errors,
                warnings: compiled.warnings,
                generation: compiled.generation,
            });
        }
    }
    return results;
}

export function runQualityRegression({
    suite,
    profiles = BUILTIN_WRITING_PROFILES,
    modelBinding = {},
    generatedAt = null,
} = {}) {
    const normalizedSuite = normalizeQualityRegressionSuite(suite);
    if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 100) {
        fail('profiles must be a non-empty bounded array.');
    }
    const binding = normalizeModelBinding(modelBinding);
    const profileResults = compileProfiles(profiles);
    const caseResults = normalizedSuite.cases.map(testCase => {
        const quality = lintChapterQuality(testCase.linterInput);
        return {
            id: testCase.id,
            title: testCase.title,
            genreOverlay: testCase.genreOverlay,
            inputDigest: digest(testCase.linterInput),
            quality,
            expectation: testCase.expect,
            result: evaluateCase(testCase, quality),
        };
    });
    const totalUnits = caseResults.reduce((sum, item) => sum + item.quality.contentUnits, 0);
    const blockers = caseResults.reduce((sum, item) => sum + item.quality.metrics.severityCounts.blocker, 0);
    const majors = caseResults.reduce((sum, item) => sum + item.quality.metrics.severityCounts.major, 0);
    const base = {
        schemaVersion: QUALITY_REGRESSION_SCHEMA_VERSION,
        suite: {
            id: normalizedSuite.id,
            name: normalizedSuite.name,
            revision: normalizedSuite.revision,
            digest: digest(normalizedSuite),
        },
        builtinProfileRevision: BUILTIN_WRITING_PROFILE_REVISION,
        modelBinding: binding,
        metrics: {
            cases: caseResults.length,
            passedCases: caseResults.filter(item => item.result.passed).length,
            casePassRate: caseResults.filter(item => item.result.passed).length / caseResults.length,
            profileCompilations: profileResults.length,
            passedProfileCompilations: profileResults.filter(item => item.passed).length,
            profileCompileRate: profileResults.filter(item => item.passed).length / profileResults.length,
            blockers,
            majors,
            blockersPerThousandUnits: totalUnits === 0 ? 0 : blockers * 1_000 / totalUnits,
            majorsPerThousandUnits: totalUnits === 0 ? 0 : majors * 1_000 / totalUnits,
        },
        profiles: profileResults,
        cases: caseResults,
        ...(generatedAt ? { generatedAt: text(generatedAt, 'generatedAt', 64) } : {}),
    };
    return { ...base, reportDigest: digest(base) };
}

function assertReport(value, label) {
    const report = plain(value, label);
    if (report.schemaVersion !== QUALITY_REGRESSION_SCHEMA_VERSION
        || typeof report.reportDigest !== 'string' || !HASH.test(report.reportDigest)
        || digest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportDigest'))) !== report.reportDigest) {
        fail(`${label} is invalid or has been changed.`);
    }
    return report;
}

function profileCatalogKey(profileId, genreOverlay) {
    return `${profileId}\u0000${genreOverlay}`;
}

function assertCompleteProfileCatalog(report, label) {
    if (report.builtinProfileRevision !== BUILTIN_WRITING_PROFILE_REVISION) {
        fail(`${label} uses an incompatible built-in profile revision.`, {
            expected: BUILTIN_WRITING_PROFILE_REVISION,
            actual: report.builtinProfileRevision,
        });
    }
    if (!Array.isArray(report.profiles)) fail(`${label}.profiles must be an array.`);
    const metrics = plain(report.metrics, `${label}.metrics`);
    if (!Number.isSafeInteger(metrics.profileCompilations)
        || metrics.profileCompilations !== report.profiles.length
        || metrics.profileCompilations !== EXPECTED_PROFILE_CATALOG.length) {
        fail(`${label} has an invalid profile catalog count.`, {
            expected: EXPECTED_PROFILE_CATALOG.length,
            reported: metrics.profileCompilations,
            actual: report.profiles.length,
        });
    }

    const expected = new Set(EXPECTED_PROFILE_CATALOG.map(item => (
        profileCatalogKey(item.profileId, item.genreOverlay)
    )));
    const actual = new Map();
    const duplicates = [];
    report.profiles.forEach((value, index) => {
        const profile = plain(value, `${label}.profiles[${index}]`);
        const profileId = identifier(profile.profileId, `${label}.profiles[${index}].profileId`);
        const genreOverlay = identifier(profile.genreOverlay, `${label}.profiles[${index}].genreOverlay`);
        const key = profileCatalogKey(profileId, genreOverlay);
        if (actual.has(key)) {
            duplicates.push({ profileId, genreOverlay });
        } else {
            actual.set(key, { profileId, genreOverlay });
        }
        if (profile.profileRevision !== report.builtinProfileRevision) {
            fail(`${label} contains an incompatible profile revision.`, {
                profileId,
                genreOverlay,
                expected: report.builtinProfileRevision,
                actual: profile.profileRevision,
            });
        }
    });
    if (duplicates.length > 0) {
        fail(`${label} contains duplicate profile catalog entries.`, { entries: duplicates });
    }

    const missing = EXPECTED_PROFILE_CATALOG.filter(item => (
        !actual.has(profileCatalogKey(item.profileId, item.genreOverlay))
    ));
    const added = [...actual.entries()]
        .filter(([key]) => !expected.has(key))
        .map(([, item]) => item);
    if (missing.length > 0 || added.length > 0) {
        fail(`${label} does not match the complete built-in profile catalog.`, { missing, added });
    }
    return actual;
}

export function compareQualityRegression(candidateValue, baselineValue) {
    const candidate = assertReport(candidateValue, 'candidate report');
    const baseline = assertReport(baselineValue, 'baseline report');
    if (candidate.suite.id !== baseline.suite.id || candidate.suite.digest !== baseline.suite.digest) {
        fail('Regression reports do not use the same fixed suite.');
    }
    const candidateProfiles = assertCompleteProfileCatalog(candidate, 'candidate report');
    const baselineProfiles = assertCompleteProfileCatalog(baseline, 'baseline report');
    if (candidate.builtinProfileRevision !== baseline.builtinProfileRevision
        || candidateProfiles.size !== baselineProfiles.size) {
        fail('Regression reports do not use the same built-in profile catalog.');
    }
    const gates = [
        ['casePassRate', 'minimum', candidate.metrics.casePassRate, baseline.metrics.casePassRate],
        ['profileCompileRate', 'minimum', candidate.metrics.profileCompileRate, baseline.metrics.profileCompileRate],
        ['blockersPerThousandUnits', 'maximum', candidate.metrics.blockersPerThousandUnits,
            baseline.metrics.blockersPerThousandUnits],
        ['majorsPerThousandUnits', 'maximum', candidate.metrics.majorsPerThousandUnits,
            baseline.metrics.majorsPerThousandUnits],
    ].map(([metric, direction, candidateValueForMetric, baselineValueForMetric]) => ({
        metric,
        direction,
        candidate: candidateValueForMetric,
        baseline: baselineValueForMetric,
        passed: direction === 'minimum'
            ? candidateValueForMetric >= baselineValueForMetric
            : candidateValueForMetric <= baselineValueForMetric,
        delta: candidateValueForMetric - baselineValueForMetric,
    }));
    const profileDiffs = candidate.profiles.map(profile => {
        const priorKey = profileCatalogKey(profile.profileId, profile.genreOverlay);
        const prior = baseline.profiles.find(item => (
            profileCatalogKey(item.profileId, item.genreOverlay) === priorKey
        ));
        return {
            profileId: profile.profileId,
            genreOverlay: profile.genreOverlay,
            baselineHash: prior?.profileHash ?? null,
            candidateHash: profile.profileHash,
            changed: !prior || prior.profileHash !== profile.profileHash,
            passed: profile.passed,
        };
    });
    return {
        schemaVersion: QUALITY_REGRESSION_SCHEMA_VERSION,
        suite: candidate.suite,
        passed: gates.every(gate => gate.passed) && profileDiffs.every(diff => diff.passed),
        gates,
        profileDiffs,
        comparisonDigest: digest({ candidate: candidate.reportDigest, baseline: baseline.reportDigest, gates, profileDiffs }),
    };
}
