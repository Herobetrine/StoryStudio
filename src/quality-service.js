import fs from 'node:fs';
import path from 'node:path';

import { compileStoryContext } from '../public/context-compiler.js';
import { ApiError } from './api-error.js';
import {
    BUILTIN_WRITING_PROFILE_REVISION,
    GENRE_OVERLAYS,
    copyBuiltinWritingProfile,
    getBuiltinWritingProfile,
    listBuiltinWritingProfiles,
} from './builtin-writing-profiles.js';
import { assertQualityBaselineManifest } from './quality-baseline.js';
import { lintChapterQuality } from './quality-linter.js';
import {
    compareQualityRegression,
    normalizeQualityRegressionSuite,
    runQualityRegression,
} from './quality-regression.js';

const QUALITY_API_SCHEMA_VERSION = 1;
const USABLE_GENERATION_STATUSES = new Set(['completed', 'partial', 'adopted']);

function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new ApiError(400, 'invalid_quality_request', `${label} must be a plain object.`);
    }
    return value;
}

function known(value, fields, label) {
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    if (unknown.length > 0) {
        throw new ApiError(400, 'unknown_quality_fields', `${label} contains unknown fields.`, { fields: unknown });
    }
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ApiError(400, 'invalid_quality_request', `${label} must be a positive integer.`);
    }
    return value;
}

function optionalText(value, label, maximum) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > maximum) {
        throw new ApiError(400, 'invalid_quality_request', `${label} must be a string no longer than ${maximum} characters.`);
    }
    return value;
}

function exactSource(value) {
    const source = plain(value, 'source');
    known(source, ['type', 'generationId'], 'source');
    if (!['chapter', 'generation'].includes(source.type)) {
        throw new ApiError(400, 'invalid_quality_source', 'source.type must be chapter or generation.');
    }
    if (source.type === 'chapter') {
        if (source.generationId !== undefined && source.generationId !== null) {
            throw new ApiError(400, 'invalid_quality_source', 'Chapter source cannot name a generation.');
        }
        return { type: 'chapter', generationId: null };
    }
    if (typeof source.generationId !== 'string' || !source.generationId) {
        throw new ApiError(400, 'invalid_quality_source', 'Generation source requires generationId.');
    }
    return { type: 'generation', generationId: source.generationId };
}

function profileSummary(profile) {
    return {
        id: profile.id,
        name: profile.name,
        task: profile.compatibility.task,
        generation: profile.generation,
        tokenBudget: profile.tokenBudget,
        characterBudget: profile.characterBudget,
        immutable: profile.compatibility.immutable,
        builtinRevision: profile.compatibility.builtinRevision,
        genreOverlays: profile.compatibility.genreOverlays,
    };
}

function contentMentionsEntity(content, entity) {
    return [entity.name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
        .some(label => typeof label === 'string' && label.length >= 2 && content.includes(label));
}

function contentCouldMentionFact(content, fact) {
    const summary = String(fact?.summary ?? '').trim();
    if (!summary) return false;
    if (content.includes(summary)) return true;
    const fragments = summary
        .split(/[\s，。！？、；：,.!?;:（）()[\]{}《》“”"'—-]+/u)
        .map(item => item.trim())
        .filter(item => item.length >= 3);
    return fragments.some(fragment => content.includes(fragment));
}

function previousAndNext(project, chapter) {
    const ordered = [...project.chapters].sort((left, right) => left.number - right.number);
    const index = ordered.findIndex(item => item.id === chapter.id);
    return {
        previousId: index > 0 ? ordered[index - 1].id : null,
        nextId: index >= 0 && index < ordered.length - 1 ? ordered[index + 1].id : null,
    };
}

function providerBinding(providerStore) {
    const settings = providerStore.getPublic();
    return {
        providerProtocol: settings.protocol,
        model: settings.model || 'none',
        parameters: {
            temperature: settings.temperature,
            topP: settings.topP,
            topK: settings.topK,
            contextWindow: settings.contextTokens,
            outputLimit: settings.maxTokens,
            structuredOutput: settings.jsonSchema,
        },
    };
}

export class QualityService {
    constructor({
        storyStore,
        generationStore,
        providerStore,
        qualityStore,
        projectRoot,
    }) {
        this.storyStore = storyStore;
        this.generationStore = generationStore;
        this.providerStore = providerStore;
        this.qualityStore = qualityStore;
        this.projectRoot = path.resolve(projectRoot);
        this.suitePath = path.join(this.projectRoot, 'fixtures', 'quality-regression-v1.json');
        this.baselinePath = path.join(this.projectRoot, 'fixtures', 'quality-regression-baseline-v1.json');
    }

    listBuiltinProfiles() {
        return {
            schemaVersion: QUALITY_API_SCHEMA_VERSION,
            builtinRevision: BUILTIN_WRITING_PROFILE_REVISION,
            genreOverlays: structuredClone(GENRE_OVERLAYS),
            profiles: listBuiltinWritingProfiles().map(profileSummary),
        };
    }

    getBuiltinProfile(profileId) {
        return {
            schemaVersion: QUALITY_API_SCHEMA_VERSION,
            builtinRevision: BUILTIN_WRITING_PROFILE_REVISION,
            profile: getBuiltinWritingProfile(profileId),
        };
    }

    copyBuiltinProfile(projectId, profileId, bodyValue) {
        const body = plain(bodyValue, 'Built-in Profile copy');
        known(body, ['projectVersion', 'name', 'genreOverlay'], 'Built-in Profile copy');
        const projectVersion = positiveInteger(body.projectVersion, 'projectVersion');
        const copy = copyBuiltinWritingProfile(profileId, {
            name: optionalText(body.name, 'name', 160) ?? '',
            genreOverlay: body.genreOverlay ?? 'none',
        });
        return this.storyStore.importResource(projectId, projectVersion, {
            fileName: `${profileId}.story-studio-profile.json`,
            mediaType: 'application/json',
            encoding: 'json',
            data: copy,
        });
    }

    loadAuthority(projectId, chapterId, projectVersion, chapterRevision) {
        positiveInteger(projectVersion, 'projectVersion');
        positiveInteger(chapterRevision, 'chapterRevision');
        const { project, chapter } = this.storyStore.getProjectAndChapter(projectId, chapterId);
        if (project.version !== projectVersion) {
            throw new ApiError(409, 'project_conflict', 'Project changed before quality analysis started.', {
                currentVersion: project.version,
            });
        }
        if (chapter.revision !== chapterRevision) {
            throw new ApiError(409, 'chapter_conflict', 'Chapter changed before quality analysis started.', {
                currentRevision: chapter.revision,
                currentProjectVersion: project.version,
            });
        }
        const adjacent = previousAndNext(project, chapter);
        const previousChapter = adjacent.previousId
            ? this.storyStore.getChapter(projectId, adjacent.previousId)
            : null;
        const nextChapter = adjacent.nextId
            ? this.storyStore.getChapter(projectId, adjacent.nextId)
            : null;
        this.assertCurrent(projectId, chapterId, projectVersion, chapterRevision);
        return { project, chapter, previousChapter, nextChapter };
    }

    assertCurrent(projectId, chapterId, projectVersion, chapterRevision) {
        const { project, chapter } = this.storyStore.getProjectAndChapter(projectId, chapterId);
        if (project.version !== projectVersion || chapter.revision !== chapterRevision) {
            throw new ApiError(409, 'quality_authority_changed', 'Project or chapter changed during quality analysis.', {
                currentProjectVersion: project.version,
                currentChapterRevision: chapter.revision,
            });
        }
    }

    buildInput(context, content) {
        const { project, chapter, previousChapter, nextChapter } = context;
        const analysisChapter = { ...chapter, content };
        const compiled = compileStoryContext({
            project,
            chapter: analysisChapter,
            previousChapter,
            nextChapter,
        });
        const touchedPromiseIds = new Set(compiled.preflight.promises.touch.map(item => item.promiseId));
        const visibleFactIds = new Set(compiled.storyState.facts.map(item => item.id));
        const volume = project.volumes.find(item => item.id === chapter.volumeId);
        if (!volume) throw new ApiError(500, 'invalid_storage', 'Chapter volume is missing.');
        return {
            content,
            chapterCard: {
                required: chapter.card.required,
                avoid: chapter.card.avoid,
            },
            volumeGoal: volume.goal,
            promises: project.storyState.promises
                .filter(item => touchedPromiseIds.has(item.id))
                .map(item => ({
                    id: item.id,
                    title: item.title,
                    summary: item.summary,
                    status: item.status,
                })),
            entities: compiled.storyState.entities
                .filter(item => contentMentionsEntity(content, item))
                .slice(0, 2_000)
                .map(item => ({ id: item.id, name: item.name, aliases: item.aliases ?? [] })),
            protectedFacts: project.storyState.facts
                .filter(item => item.status !== 'retired' && !item.supersededById && !visibleFactIds.has(item.id))
                .filter(item => contentCouldMentionFact(content, item))
                .slice(0, 2_000)
                .map(item => ({ id: item.id, summary: item.summary })),
        };
    }

    previewChapter(projectId, chapterId, bodyValue) {
        const body = plain(bodyValue, 'Quality preview');
        known(body, ['projectVersion', 'chapterRevision', 'content'], 'Quality preview');
        const context = this.loadAuthority(
            projectId,
            chapterId,
            body.projectVersion,
            body.chapterRevision,
        );
        const content = optionalText(body.content, 'content', 5_000_000) ?? context.chapter.content;
        const input = this.buildInput(context, content);
        const report = lintChapterQuality(input);
        this.assertCurrent(projectId, chapterId, body.projectVersion, body.chapterRevision);
        const volume = context.project.volumes.find(item => item.id === context.chapter.volumeId);
        return {
            schemaVersion: QUALITY_API_SCHEMA_VERSION,
            kind: 'chapter-quality-preview',
            projectId,
            chapterId,
            authority: {
                projectVersion: context.project.version,
                chapterRevision: context.chapter.revision,
                volumeId: volume.id,
                volumeRevision: volume.revision,
                contentDigest: report.contentDigest,
            },
            report,
        };
    }

    createChapterReport(projectId, chapterId, bodyValue) {
        const body = plain(bodyValue, 'Quality report');
        known(body, ['projectVersion', 'chapterRevision', 'source'], 'Quality report');
        const source = exactSource(body.source);
        const context = this.loadAuthority(
            projectId,
            chapterId,
            body.projectVersion,
            body.chapterRevision,
        );
        let content = context.chapter.content;
        if (source.type === 'generation') {
            const generation = this.generationStore.getGeneration(projectId, chapterId, source.generationId);
            if (!USABLE_GENERATION_STATUSES.has(generation.status)) {
                throw new ApiError(409, 'quality_generation_unavailable', 'Generation is not complete enough for quality analysis.');
            }
            if (generation.request?.projectVersion !== context.project.version
                || generation.request?.chapterRevision !== context.chapter.revision) {
                throw new ApiError(409, 'quality_generation_stale', 'Generation does not bind to the current authority.');
            }
            content = generation.content;
        }
        const input = this.buildInput(context, content);
        const report = lintChapterQuality(input);
        this.assertCurrent(projectId, chapterId, body.projectVersion, body.chapterRevision);
        const volume = context.project.volumes.find(item => item.id === context.chapter.volumeId);
        return this.qualityStore.saveChapterReport({
            projectId,
            chapterId,
            source,
            authority: {
                projectVersion: context.project.version,
                chapterRevision: context.chapter.revision,
                volumeId: volume.id,
                volumeRevision: volume.revision,
                contentDigest: report.contentDigest,
            },
            input,
            report,
        });
    }

    listChapterReports(projectId, chapterId) {
        this.storyStore.getProjectAndChapter(projectId, chapterId);
        return this.qualityStore.listChapterReports(projectId, chapterId);
    }

    getChapterReport(projectId, chapterId, reportId) {
        this.storyStore.getProjectAndChapter(projectId, chapterId);
        return this.qualityStore.getChapterReport(projectId, chapterId, reportId);
    }

    loadSuite() {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this.suitePath, 'utf8'));
        } catch {
            throw new ApiError(500, 'quality_suite_unavailable', 'Fixed quality regression suite is unavailable.');
        }
        return normalizeQualityRegressionSuite(parsed);
    }

    loadBaseline() {
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(this.baselinePath, 'utf8'));
        } catch {
            throw new ApiError(500, 'quality_baseline_unavailable', 'Fixed quality regression baseline is unavailable.');
        }
        const suite = this.loadSuite();
        const report = runQualityRegression({ suite });
        assertQualityBaselineManifest(manifest, report, suite.revision);
        compareQualityRegression(report, report);
        return report;
    }

    getRegressionSuite() {
        const suite = this.loadSuite();
        return {
            schemaVersion: QUALITY_API_SCHEMA_VERSION,
            suite: {
                id: suite.id,
                name: suite.name,
                revision: suite.revision,
                cases: suite.cases.map(item => ({
                    id: item.id,
                    title: item.title,
                    genreOverlay: item.genreOverlay,
                })),
            },
        };
    }

    getRegressionBaseline() {
        return this.loadBaseline();
    }

    runRegression(bodyValue = {}) {
        const body = plain(bodyValue, 'Quality regression run');
        known(body, ['modelBinding'], 'Quality regression run');
        const report = runQualityRegression({
            suite: this.loadSuite(),
            modelBinding: body.modelBinding ?? providerBinding(this.providerStore),
            generatedAt: new Date().toISOString(),
        });
        return this.qualityStore.saveRegressionRun(report);
    }

    listRegressionRuns() {
        return this.qualityStore.listRegressionRuns(this.loadSuite().id);
    }

    getRegressionRun(runId) {
        return this.qualityStore.getRegressionRun(this.loadSuite().id, runId);
    }

    compareRegression(bodyValue) {
        const body = plain(bodyValue, 'Quality regression comparison');
        known(body, ['candidateRunId', 'baselineRunId'], 'Quality regression comparison');
        if (typeof body.candidateRunId !== 'string' || !body.candidateRunId) {
            throw new ApiError(400, 'invalid_quality_request', 'candidateRunId is required.');
        }
        if (body.baselineRunId !== undefined
            && (typeof body.baselineRunId !== 'string' || !body.baselineRunId)) {
            throw new ApiError(400, 'invalid_quality_request', 'baselineRunId is invalid.');
        }
        const suiteId = this.loadSuite().id;
        const candidate = this.qualityStore.getRegressionRun(suiteId, body.candidateRunId);
        const baselineRecord = body.baselineRunId
            ? this.qualityStore.getRegressionRun(suiteId, body.baselineRunId)
            : null;
        const baselineReport = baselineRecord?.report ?? this.loadBaseline();
        const comparison = compareQualityRegression(candidate.report, baselineReport);
        return this.qualityStore.saveComparison({
            suiteId,
            candidateRunId: candidate.id,
            baseline: {
                type: baselineRecord ? 'run' : 'fixture',
                id: baselineRecord?.id ?? suiteId,
                reportDigest: baselineReport.reportDigest,
            },
            comparison,
        });
    }

    listComparisons() {
        return this.qualityStore.listComparisons(this.loadSuite().id);
    }

    getComparison(comparisonId) {
        return this.qualityStore.getComparison(this.loadSuite().id, comparisonId);
    }
}
