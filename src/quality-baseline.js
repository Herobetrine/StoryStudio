import { ApiError } from './api-error.js';

export const QUALITY_BASELINE_MANIFEST_VERSION = 1;

const MANIFEST_FIELDS = Object.freeze([
    'schemaVersion', 'suiteId', 'suiteRevision', 'suiteDigest',
    'builtinProfileRevision', 'reportDigest', 'metrics',
]);
const METRIC_FIELDS = Object.freeze([
    'cases', 'passedCases', 'casePassRate', 'profileCompilations',
    'passedProfileCompilations', 'profileCompileRate', 'blockers', 'majors',
    'blockersPerThousandUnits', 'majorsPerThousandUnits',
]);

function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new ApiError(500, 'quality_baseline_mismatch', `${label} must be a plain object.`);
    }
    return value;
}

function exact(value, fields, label) {
    const input = plain(value, label);
    const unknown = Object.keys(input).filter(field => !fields.includes(field));
    const missing = fields.filter(field => !Object.hasOwn(input, field));
    if (unknown.length > 0 || missing.length > 0) {
        throw new ApiError(500, 'quality_baseline_mismatch', `${label} fields are invalid.`, { unknown, missing });
    }
    return input;
}

export function createQualityBaselineManifest(report, suiteRevision) {
    return {
        schemaVersion: QUALITY_BASELINE_MANIFEST_VERSION,
        suiteId: report.suite.id,
        suiteRevision,
        suiteDigest: report.suite.digest,
        builtinProfileRevision: report.builtinProfileRevision,
        reportDigest: report.reportDigest,
        metrics: Object.fromEntries(METRIC_FIELDS.map(field => [field, report.metrics[field]])),
    };
}

export function assertQualityBaselineManifest(value, report, suiteRevision) {
    const manifest = exact(value, MANIFEST_FIELDS, 'Quality baseline manifest');
    exact(manifest.metrics, METRIC_FIELDS, 'Quality baseline metrics');
    const expected = createQualityBaselineManifest(report, suiteRevision);
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
        throw new ApiError(
            500,
            'quality_baseline_mismatch',
            'Fixed quality regression baseline no longer matches the implementation.',
        );
    }
    return structuredClone(manifest);
}
