import { ApiError } from './api-error.js';
import { chapterVersionInput } from './chapter-version-store.js';
import { hashCopilotValue } from './copilot-schema.js';
import { buildRetrievalQuery } from './generation-service.js';
import {
    createReviewCandidate,
    createSuggestedChapterCardCandidate,
    diagnosePlanning,
    validateChapterCardPatch,
    validateReviewPatch,
} from './planning-copilot.js';
import {
    createAuthorityRecoveryFingerprint,
    matchesAppliedAuthority,
    matchesBaseAuthority,
    matchesRecoverableAuthority,
} from './workflow-authority.js';
import { evaluateWorkflowCondition } from './workflow-schema.js';
import { hashWorkflowValue } from './workflow-store.js';
import { validateStoryStateChangeSet } from './story-studio-store.js';
import {
    normalizeBrainstormDirectionSet,
    normalizeWorkflowV2ArtifactPayload,
    workflowContractDigest,
} from './workflow-contracts.js';
import {
    buildWorkflowV2Prompt,
    materializeAdoptionPayload,
    materializeBrainstormPayloads,
    materializeDraftPayload,
    materializePlanPayload,
    materializeReviewPayload,
    materializeRewritePayload,
    materializeTrustedBrainstormPayloads,
    parseWorkflowV2ModelJson,
} from './workflow-v2-runtime.js';

const START_FIELDS = Object.freeze([
    'commandId', 'definitionId', 'definitionHash', 'projectVersion', 'chapterRevision', 'input',
]);
const COMMAND_FIELDS = Object.freeze(['commandId', 'runRevision', 'type', 'payload']);
const COMMAND_PAYLOAD_FIELDS = Object.freeze([
    'stepId', 'artifactId', 'artifactHash', 'instruction', 'contextOverrides', 'retrieval',
    'generationId', 'reason',
]);
const DIRECT_DIAGNOSIS_FIELDS = Object.freeze([
    'projectVersion', 'chapterRevision', 'retrieval',
]);
const COMMAND_TYPES = new Set(['execute', 'attach-generation', 'cancel']);
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_approval', 'failed']);
const WRITE_STEP_KINDS = new Set(['apply', 'adopt', 'closeout']);
const WORKFLOW_V2_DEFINITION_ID = 'builtin.chapter-cycle.v2';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const COPILOT_HANDOFF_FIELDS = Object.freeze(['sessionId', 'artifactId', 'optionId']);
const COPILOT_HANDOFF_VERSION = 2;
const COPILOT_HANDOFF_MATERIALIZER_VERSION = 2;
const APPLIED_STEP_TARGETS = Object.freeze({
    'apply-card': 'chapter-card',
    adopt: 'story-state',
    'apply-review': 'chapter-quality',
    closeout: 'chapter-quality',
});
const PRODUCER_BY_STEP = Object.freeze({
    'select-direction': 'brainstorm',
    'approve-plan': 'plan',
    'approve-review': 'review',
    'approve-rewrite': 'rewrite',
    'approve-adoption': 'distill',
    'approve-card': 'propose-card',
    'apply-card': 'propose-card',
    distill: 'draft',
    'approve-state': 'distill',
    adopt: 'distill',
    'apply-review': 'review',
});

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
    if (!isObject(value)) throw new ApiError(400, 'invalid_workflow_request', `${label} must be an object.`);
    return value;
}

function assertKnownFields(value, fields, label) {
    const unknown = Object.keys(value).filter(field => !fields.includes(field));
    if (unknown.length > 0) {
        throw new ApiError(400, 'unknown_fields', `${label} contains unknown fields.`, { fields: unknown });
    }
}

function cleanId(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) {
        throw new ApiError(400, 'invalid_workflow_id', `${label} is invalid.`);
    }
    return value;
}

function cleanHash(value, label, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || value === '')) return null;
    if (typeof value !== 'string' || !HASH.test(value)) {
        throw new ApiError(400, 'invalid_workflow_hash', `${label} is invalid.`);
    }
    return value;
}

function cleanRevision(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ApiError(400, 'invalid_workflow_revision', `${label} must be a positive integer.`);
    }
    return value;
}

function clone(value) {
    return structuredClone(value);
}

function cleanReason(value) {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 500) {
        throw new ApiError(400, 'invalid_workflow_request', 'reason must be a string no longer than 500 characters.');
    }
    return value;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

function writeCapableDefinition(definition) {
    return definition.steps.some(step => WRITE_STEP_KINDS.has(step.kind));
}

function authorityView(project, chapter) {
    return {
        projectVersion: project.version,
        chapterRevision: chapter.revision,
        chapterStatus: chapter.status,
        cardDigest: hashWorkflowValue(chapter.card),
        contentDigest: hashWorkflowValue(chapter.content),
        reviewDigest: hashWorkflowValue({ review: chapter.review, notes: chapter.notes }),
        storyStateDigest: hashWorkflowValue(project.storyState),
    };
}

function adoptionDigest(project, chapter) {
    return hashWorkflowValue({
        content: chapter.content,
        summary: chapter.card.summary,
        storyState: project.storyState,
    });
}

function adoptionTargetMatches(project, chapter, artifact, draftArtifact) {
    return hashWorkflowValue(chapter.content) === draftArtifact.payload.contentDigest
        && chapter.card.summary === artifact.payload.chapterSummary
        && hashWorkflowValue(project.storyState) === artifact.payload.targetStoryStateDigest;
}

function compactCommand(receipt, replayed = false) {
    return receipt ? {
        commandId: receipt.id,
        type: receipt.type,
        expectedRevision: receipt.expectedRevision,
        committedRevision: receipt.committedRevision,
        replayed,
    } : null;
}

function workflowRunSummary(run) {
    return {
        id: run.id,
        projectId: run.projectId,
        definitionId: run.definitionId,
        definitionHash: run.definitionHash,
        chapterId: run.chapterId,
        status: run.status,
        revision: run.revision,
        currentStepId: run.currentStepId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
    };
}

function target(type, chapterId) {
    return {
        type,
        chapterId,
        projectVersion: null,
        chapterRevision: null,
        digest: null,
    };
}

function base(project, chapter) {
    return { projectVersion: project.version, chapterRevision: chapter.revision };
}

function artifactIdentity(value) {
    return hashWorkflowValue({
        projectId: value.projectId,
        runId: value.runId,
        stepId: value.stepId,
        kind: value.kind,
        source: value.source,
        target: value.target,
        base: value.base,
        payload: value.payload,
        evidenceIds: value.evidenceIds,
    });
}

function artifactBindingHash(value) {
    return hashWorkflowValue({
        id: value.id,
        projectId: value.projectId,
        runId: value.runId,
        stepId: value.stepId,
        kind: value.kind,
        source: value.source,
        target: {
            type: value.target.type,
            chapterId: value.target.chapterId,
        },
        base: value.base,
        payload: value.payload,
        evidenceIds: value.evidenceIds,
        createdAt: value.createdAt,
    });
}

function publicArtifact(value) {
    return value ? { ...value, bindingHash: artifactBindingHash(value) } : null;
}

function deterministicArtifactId(prefix, value) {
    const digestLength = Math.max(16, 64 - prefix.length - 1);
    return `${prefix}-${hashWorkflowValue(value).slice(0, digestLength)}`;
}

function generationEvidenceIds(generation) {
    const hits = generation?.request?.diagnostics?.retrieval?.hits ?? [];
    const result = [`generation-${hashWorkflowValue(generation?.id ?? '').slice(0, 48)}`];
    for (const hit of hits.slice(0, 64)) {
        result.push(`retrieval-${hashWorkflowValue(hit?.id ?? hit).slice(0, 48)}`);
    }
    return [...new Set(result)];
}

function allowedGeneration(generation, kind) {
    return generation?.kind === kind
        && ['completed', 'partial', 'adopted'].includes(generation.status)
        && typeof generation.content === 'string'
        && generation.content.length > 0;
}

function workflowV2Json(value) {
    return JSON.parse(JSON.stringify(value));
}

function workflowV2PromptText(prompt) {
    return `${prompt.systemPrompt}\n\n${prompt.userPrompt}`;
}

function workflowV2FinalText(baseText, rewritePayload) {
    const { start, end, after } = rewritePayload.diff;
    return `${baseText.slice(0, start)}${after}${baseText.slice(end)}`;
}

function workflowV2ReviewText(reviewPayload) {
    return JSON.stringify(reviewPayload, null, 2);
}

function workflowV2Notes(lineage) {
    return JSON.stringify({ workflow: WORKFLOW_V2_DEFINITION_ID, lineage }, null, 2);
}

function workflowV2AdoptionDigest(project, chapter) {
    return hashWorkflowValue({
        content: chapter.content,
        card: chapter.card,
        review: chapter.review,
        notes: chapter.notes,
        status: chapter.status,
        storyState: project.storyState,
    });
}

function workflowV2AdoptionMatches(project, chapter, payload, manuscript, reviewText, notes) {
    return chapter.content === manuscript
        && hashWorkflowValue(chapter.card) === hashWorkflowValue(payload.chapterCard)
        && chapter.review === reviewText
        && chapter.notes === notes
        && chapter.status === 'done'
        && workflowContractDigest(project.storyState) === payload.targetStoryStateDigest;
}

function boundedHandoffText(value, maximum, fallback) {
    const source = String(value ?? '').replaceAll('\r\n', '\n').trim() || fallback;
    if (source.length <= maximum) return source;
    if (maximum <= 1) return source.slice(0, maximum);
    return `${source.slice(0, maximum - 1)}…`;
}

function joinedHandoffText(records, field, maximum, fallback) {
    const parts = records.map((record, index) => (
        `${index + 1}. ${boundedHandoffText(record?.[field], 1_000, fallback)}`
    ));
    return boundedHandoffText(parts.join('\n'), maximum, fallback);
}

function copilotEventSeed(event, index, maximum = 2_000) {
    const eventMaximum = Math.min(600, Math.max(80, Math.floor(maximum * 0.3)));
    const detailMaximum = Math.min(450, Math.max(60, Math.floor(maximum * 0.2)));
    return boundedHandoffText([
        `${index + 1}. ${boundedHandoffText(event?.event, eventMaximum, '推进事件')}`,
        `选择：${boundedHandoffText(event?.characterChoice, detailMaximum, '人物作出选择')}`,
        `结果：${boundedHandoffText(event?.directResult, detailMaximum, '选择产生直接结果')}`,
        `代价：${boundedHandoffText(event?.cost, detailMaximum, '选择留下后续代价')}`,
    ].join('；'), maximum, `事件 ${index + 1}`);
}

function copilotEventSeeds(option) {
    const events = Array.isArray(option?.eventChain) ? option.eventChain : [];
    const seeds = events.slice(0, 7).map((event, index) => copilotEventSeed(event, index));
    if (events.length > 7) {
        const remaining = events.slice(7);
        const perEventMaximum = Math.floor((2_000 - Math.max(0, remaining.length - 1)) / remaining.length);
        const folded = remaining.map((event, index) => (
            copilotEventSeed(event, index + 7, perEventMaximum)
        )).join('\n');
        seeds.push(folded);
    }
    while (seeds.length < 3) seeds.push(`补足因果节点 ${seeds.length + 1}`);
    return seeds.slice(0, 8);
}

function copilotDirectionId(artifact, option, index) {
    return `copilot-direction-${index + 1}-${hashWorkflowValue({
        artifactId: artifact.id,
        artifactDigest: artifact.artifactDigest,
        optionId: option.id,
    }).slice(0, 32)}`;
}

function copilotDirectionFromOption(artifact, option, index) {
    const events = Array.isArray(option.eventChain) ? option.eventChain : [];
    const risks = Array.isArray(option.risks) ? option.risks : [];
    return {
        id: copilotDirectionId(artifact, option, index),
        title: boundedHandoffText(option.title, 160, `Copilot 方向 ${index + 1}`),
        forkChoice: boundedHandoffText(option.commitment, 2_000, `采用方向 ${index + 1} 的核心承诺`),
        protagonistAction: joinedHandoffText(events, 'characterChoice', 4_000, '人物推动事件'),
        directResult: joinedHandoffText(events, 'directResult', 4_000, '事件产生结果'),
        delayedCost: boundedHandoffText([
            joinedHandoffText(events, 'cost', 3_200, '事件留下代价'),
            ...risks.map((risk, riskIndex) => `风险 ${riskIndex + 1}：${boundedHandoffText(risk, 600, '待评估风险')}`),
        ].filter(Boolean).join('\n'), 4_000, '事件留下持续代价'),
        chapterPromise: boundedHandoffText([
            boundedHandoffText(option.summary, 3_000, '本章沿该方向完成一次明确推进'),
            `章尾：${boundedHandoffText(option.hook, 900, '以新的未决问题收束')}`,
        ].join('\n'), 4_000, '本章完成方向推进并留下章尾钩子'),
        eventSeeds: copilotEventSeeds(option),
        sourceEventChain: events.map((event, eventIndex) => ({
            order: eventIndex + 1,
            event: event.event,
            characterChoice: event.characterChoice,
            directResult: event.directResult,
            cost: event.cost,
        })),
    };
}

function copilotPairwiseReason(leftOption, rightOption) {
    return boundedHandoffText(
        `${leftOption.title}要求“${leftOption.commitment}”；${rightOption.title}要求“${rightOption.commitment}”。`
        + '两项核心承诺与事件链在同一章节推进中互相排斥。',
        2_000,
        '两个方向采用互相排斥的核心承诺。',
    );
}

function materializeCopilotHandoffSet({
    artifact,
    session,
    projectId,
    chapterId,
    projectVersion,
    chapterRevision,
}) {
    const options = Array.isArray(artifact.plotOptions) ? artifact.plotOptions : [];
    const directions = options.map((option, index) => copilotDirectionFromOption(artifact, option, index));
    const generationId = `copilot-${artifact.artifactDigest.slice(0, 48)}`;
    const payloads = materializeTrustedBrainstormPayloads({
        exclusivityAxis: boundedHandoffText(
            '各方向代表本章只能采用一次的核心承诺与因果事件链，选择其中一项即排除其余推进路径。',
            2_000,
            '本章核心承诺与事件链互相排斥。',
        ),
        directions: directions.map((direction, index) => ({
            direction,
            pairwiseExclusion: options
                .map((other, otherIndex) => ({ other, otherIndex }))
                .filter(item => item.otherIndex !== index)
                .map(item => ({
                    otherDirectionId: directions[item.otherIndex].id,
                    reason: copilotPairwiseReason(options[index], item.other),
                })),
        })),
        generationId,
        diagnosis: {
            source: 'planning-copilot',
            sessionId: session.id,
            artifactId: artifact.id,
            artifactDigest: artifact.artifactDigest,
            evidenceDigest: artifact.evidenceDigest,
        },
        sourceSnapshot: {
            source: 'planning-copilot',
            projectId,
            chapterId,
            projectVersion,
            chapterRevision,
            contextDigest: session.contextDigest,
            base: session.base,
        },
    });
    return { options, payloads, generationId };
}

function normalizeCopilotHandoffReference(value) {
    if (!isObject(value)) {
        throw new ApiError(400, 'invalid_copilot_handoff', 'copilotHandoff must be an object.');
    }
    const unknown = Object.keys(value).filter(field => !COPILOT_HANDOFF_FIELDS.includes(field));
    const missing = COPILOT_HANDOFF_FIELDS.filter(field => !Object.hasOwn(value, field));
    if (unknown.length > 0 || missing.length > 0) {
        throw new ApiError(400, 'invalid_copilot_handoff', 'copilotHandoff fields are invalid.', {
            unknown,
            missing,
        });
    }
    const normalized = {};
    for (const field of COPILOT_HANDOFF_FIELDS) {
        if (typeof value[field] !== 'string' || !ID.test(value[field])) {
            throw new ApiError(400, 'invalid_copilot_handoff', `copilotHandoff.${field} is invalid.`, {
                field,
            });
        }
        normalized[field] = value[field];
    }
    return normalized;
}

export class WorkflowService {
    constructor({
        workflowStore,
        storyStore,
        generationService,
        chapterVersionStore = null,
        retrievalStore = null,
        copilotService = null,
    }) {
        if (!workflowStore || !storyStore || !generationService) {
            throw new TypeError('WorkflowService requires workflowStore, storyStore, and generationService.');
        }
        this.workflowStore = workflowStore;
        this.storyStore = storyStore;
        this.generationService = generationService;
        this.chapterVersionStore = chapterVersionStore;
        this.retrievalStore = retrievalStore;
        this.copilotService = copilotService;
        this.generationStepInflight = new Map();
        this.runOperations = new Map();
    }

    runOperationKey(projectId, chapterId, runId) {
        return `${projectId}:${chapterId}:${runId}`;
    }

    activeWriteRuns(projectId, chapterId) {
        return this.workflowStore.listRuns(projectId).filter(run => (
            run.chapterId === chapterId
            && ACTIVE_RUN_STATUSES.has(run.status)
            && writeCapableDefinition(this.workflowStore.getDefinition(run.definitionId))
        ));
    }

    drainingWriteOperation(projectId, chapterId, excludedRunId = '') {
        return [...this.runOperations.values()].find(operation => (
            operation.projectId === projectId
            && operation.chapterId === chapterId
            && operation.runId !== excludedRunId
            && operation.writeCapable
        )) ?? null;
    }

    assertWriteRunAvailable(projectId, chapterId, { runId = '', starting = false } = {}) {
        const active = this.activeWriteRuns(projectId, chapterId);
        if (starting && active.length > 0) {
            throw new ApiError(409, 'workflow_active_run_exists',
                'The chapter already has an active write-capable workflow run.', {
                    activeRunId: active[0].id,
                });
        }
        const others = active.filter(run => run.id !== runId);
        if (others.length > 0 || (!starting && active.length > 1)) {
            throw new ApiError(409, 'workflow_active_run_conflict',
                'The chapter has more than one active write-capable workflow run.', {
                    activeRunIds: active.map(run => run.id),
                });
        }
        const draining = this.drainingWriteOperation(projectId, chapterId, runId);
        if (draining) {
            throw new ApiError(409, 'workflow_cancellation_in_progress',
                'A cancelled write-capable workflow operation is still stopping.', {
                    runId: draining.runId,
                });
        }
    }

    assertRunWriteLease(run) {
        const definition = this.workflowStore.getDefinition(run.definitionId);
        if (!writeCapableDefinition(definition)) return;
        this.assertWriteRunAvailable(run.projectId, run.chapterId, { runId: run.id });
    }

    listDefinitions() {
        return { definitions: this.workflowStore.listDefinitions() };
    }

    loadAuthority(projectId, chapterId) {
        const project = this.storyStore.getProject(projectId);
        const chapter = this.storyStore.getChapter(projectId, chapterId);
        if (!project.chapters.some(item => item.id === chapter.id)) {
            throw new ApiError(500, 'invalid_storage', 'Workflow chapter is missing from the project index.');
        }
        return { project, chapter };
    }

    loadAuthorityReadOnly(projectId, chapterId) {
        return this.storyStore.getProjectAndChapterReadOnly(projectId, chapterId);
    }

    assertAuthority(project, chapter, expectedProjectVersion, expectedChapterRevision, code = 'workflow_authority_changed') {
        if (project.version !== expectedProjectVersion || chapter.revision !== expectedChapterRevision) {
            throw new ApiError(409, code, 'The authoritative project or chapter changed.', {
                expectedProjectVersion,
                expectedChapterRevision,
                currentProjectVersion: project.version,
                currentChapterRevision: chapter.revision,
            });
        }
    }

    previousChapter(projectId, project, chapter) {
        const ordered = [...project.chapters].sort((left, right) => left.number - right.number);
        const index = ordered.findIndex(item => item.id === chapter.id);
        return index > 0 ? this.storyStore.getChapter(projectId, ordered[index - 1].id) : null;
    }

    diagnosis(projectId, chapterId, { projectVersion, chapterRevision, retrieval = {} } = {}) {
        const { project, chapter } = this.loadAuthority(projectId, chapterId);
        this.assertAuthority(project, chapter, projectVersion, chapterRevision);
        assertObject(retrieval, 'retrieval');
        const query = retrieval.query ?? buildRetrievalQuery({
            chapterTitle: chapter.title,
            chapterSummary: chapter.card?.summary,
            chapterGoal: chapter.card?.goal,
            chapterConflict: chapter.card?.conflict,
        });
        const retrievalDiagnostics = this.retrievalStore
            ? this.retrievalStore.preview(projectId, chapterId, {
                ...retrieval,
                query,
                projectVersion,
                chapterRevision,
                rerank: false,
            })
            : null;
        return diagnosePlanning({
            project,
            chapter,
            chapters: project.chapters,
            volumes: project.volumes,
            previousChapter: this.previousChapter(projectId, project, chapter),
            retrievalDiagnostics,
        });
    }

    previewDiagnosis(projectId, chapterId, body) {
        const input = assertObject(body, 'Copilot diagnosis request');
        assertKnownFields(input, DIRECT_DIAGNOSIS_FIELDS, 'Copilot diagnosis request');
        return this.diagnosis(projectId, chapterId, {
            projectVersion: cleanRevision(input.projectVersion, 'projectVersion'),
            chapterRevision: cleanRevision(input.chapterRevision, 'chapterRevision'),
            retrieval: input.retrieval ?? {},
        });
    }

    createCopilotHandoffSnapshot(projectId, chapterId, reference, projectVersion, chapterRevision) {
        if (!this.copilotService) {
            throw new ApiError(409, 'copilot_handoff_session_not_ready',
                'Copilot handoff is not configured for this Workflow service.');
        }
        const session = this.copilotService.getSession(projectId, reference.sessionId);
        if (session.status !== 'ready') {
            throw new ApiError(409, 'copilot_handoff_session_not_ready',
                'Copilot session must be ready before it can be handed to Workflow.', {
                    sessionId: session.id,
                    status: session.status,
                });
        }
        if (session.stale) {
            throw new ApiError(409, 'copilot_context_changed',
                'Copilot context changed before Workflow handoff.', {
                    sessionId: session.id,
                });
        }
        const artifact = session.artifact;
        if (!artifact || artifact.id !== reference.artifactId
            || artifact.status !== 'candidate'
            || artifact.projectId !== projectId
            || artifact.sessionId !== session.id) {
            throw new ApiError(409, 'copilot_handoff_artifact_mismatch',
                'Copilot artifact no longer matches the selected session.', {
                    sessionId: session.id,
                    artifactId: reference.artifactId,
                });
        }
        const { id: artifactId, artifactDigest, ...artifactCore } = artifact;
        const computedArtifactDigest = hashCopilotValue(artifactCore);
        if (artifactDigest !== computedArtifactDigest
            || artifactId !== `copilot-artifact-${computedArtifactDigest.slice(0, 40)}`
            || artifact.contextDigest !== session.contextDigest
            || artifact.profileHash !== session.profile?.profileHash
            || artifact.providerHash !== session.provider?.configHash
            || artifact.evidenceDigest !== hashCopilotValue(session.evidenceCatalog)
            || hashCopilotValue(artifact.base) !== hashCopilotValue(session.base)) {
            throw new ApiError(409, 'copilot_handoff_artifact_mismatch',
                'Copilot artifact lineage failed validation.', {
                    sessionId: session.id,
                    artifactId: artifact.id,
                });
        }
        if (session.base?.projectId !== projectId
            || session.base?.anchorChapterId !== chapterId
            || session.base?.projectVersion !== projectVersion
            || session.base?.anchorChapterRevision !== chapterRevision
            || artifact.base?.projectId !== projectId
            || artifact.base?.anchorChapterId !== chapterId
            || artifact.base?.projectVersion !== projectVersion
            || artifact.base?.anchorChapterRevision !== chapterRevision) {
            throw new ApiError(409, 'copilot_context_changed',
                'Copilot target authority does not match the Workflow chapter.', {
                    sessionId: session.id,
                    expectedProjectId: projectId,
                    expectedChapterId: chapterId,
                    expectedProjectVersion: projectVersion,
                    expectedChapterRevision: chapterRevision,
                });
        }
        const options = Array.isArray(artifact.plotOptions) ? artifact.plotOptions : [];
        const selectedIndex = options.findIndex(option => option.id === reference.optionId);
        if (selectedIndex < 0) {
            throw new ApiError(400, 'invalid_copilot_option_reference',
                'Copilot handoff refers to an unknown direction.', {
                    optionId: reference.optionId,
                });
        }
        const {
            payloads,
            generationId,
        } = materializeCopilotHandoffSet({
            artifact,
            session,
            projectId,
            chapterId,
            projectVersion,
            chapterRevision,
        });
        return {
            version: COPILOT_HANDOFF_VERSION,
            materializerVersion: COPILOT_HANDOFF_MATERIALIZER_VERSION,
            sessionId: session.id,
            artifactId: artifact.id,
            artifactDigest: artifact.artifactDigest,
            evidenceDigest: artifact.evidenceDigest,
            contextDigest: session.contextDigest,
            optionId: reference.optionId,
            selectedDirectionId: payloads[selectedIndex].direction.id,
            projectId,
            chapterId,
            authority: { projectVersion, chapterRevision },
            generationId,
            setDigest: payloads[0].setDigest,
            diagnosisDigest: payloads[0].diagnosisDigest,
            sourceSnapshotDigest: payloads[0].sourceSnapshotDigest,
            directionCount: payloads.length,
            directions: payloads.map((payload, index) => ({
                directionIndex: payload.directionIndex,
                optionId: options[index].id,
                directionId: payload.direction.id,
                directionDigest: workflowContractDigest(payload.direction),
                sourceEventChainDigest: workflowContractDigest(payload.direction.sourceEventChain),
                evidenceIdsDigest: workflowContractDigest(options[index].evidenceIds),
            })),
        };
    }

    copilotHandoffAuthority(run, snapshot) {
        const authority = isObject(snapshot?.authority)
            ? snapshot.authority
            : snapshot?.version === 1 ? run.input?.authority : null;
        if (!isObject(authority)
            || !Number.isSafeInteger(authority.projectVersion)
            || authority.projectVersion < 1
            || !Number.isSafeInteger(authority.chapterRevision)
            || authority.chapterRevision < 1) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff authority is inconsistent.');
        }
        return {
            projectVersion: authority.projectVersion,
            chapterRevision: authority.chapterRevision,
        };
    }

    copilotHandoffV1Entries(run, snapshot) {
        const directions = Array.isArray(snapshot?.directions) ? snapshot.directions : [];
        let payloads;
        try {
            payloads = normalizeBrainstormDirectionSet(directions.map(item => item?.payload));
        } catch {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff V1 payloads are inconsistent.');
        }
        const payloadByDirection = new Map(payloads.map(payload => [payload.direction.id, payload]));
        if (snapshot.version !== 1
            || snapshot.projectId !== run.projectId
            || snapshot.chapterId !== run.chapterId
            || snapshot.setDigest !== payloads[0].setDigest
            || directions.length !== payloads.length
            || (snapshot.generationId !== undefined && snapshot.generationId !== payloads[0].generationId)
            || !ID.test(snapshot.selectedDirectionId ?? '')) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff snapshot is inconsistent.');
        }
        const entries = directions.map(entry => {
            const directionId = entry?.payload?.direction?.id;
            const payload = payloadByDirection.get(directionId);
            if (!payload || (entry?.optionId !== undefined && !ID.test(entry.optionId))) {
                throw new ApiError(500, 'invalid_workflow_state',
                    'Stored Copilot handoff V1 direction coordinates are inconsistent.');
            }
            return {
                optionId: entry.optionId,
                payload,
                evidenceIds: Array.isArray(entry.evidenceIds) ? [...entry.evidenceIds] : [],
            };
        });
        const selected = entries.find(entry => entry.payload.direction.id === snapshot.selectedDirectionId);
        const optionIds = entries.map(entry => entry.optionId).filter(Boolean);
        if (!selected
            || new Set(optionIds).size !== optionIds.length
            || (snapshot.optionId !== undefined
                && (!ID.test(snapshot.optionId)
                    || (selected.optionId !== undefined && selected.optionId !== snapshot.optionId)))) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff V1 selection coordinates are inconsistent.');
        }
        return entries;
    }

    copilotHandoffV2Coordinates(run, snapshot) {
        const directions = Array.isArray(snapshot?.directions) ? snapshot.directions : [];
        const materializerVersion = snapshot?.materializerVersion;
        const invalid = () => {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff V2 coordinates are inconsistent.');
        };
        if (snapshot?.version !== COPILOT_HANDOFF_VERSION
            || ![1, COPILOT_HANDOFF_MATERIALIZER_VERSION].includes(materializerVersion)
            || snapshot.projectId !== run.projectId
            || snapshot.chapterId !== run.chapterId
            || !ID.test(snapshot.sessionId ?? '')
            || !ID.test(snapshot.artifactId ?? '')
            || !HASH.test(snapshot.artifactDigest ?? '')
            || !HASH.test(snapshot.contextDigest ?? '')
            || !ID.test(snapshot.optionId ?? '')
            || !ID.test(snapshot.selectedDirectionId ?? '')
            || !ID.test(snapshot.generationId ?? '')
            || !HASH.test(snapshot.setDigest ?? '')
            || !Number.isSafeInteger(snapshot.directionCount)
            || snapshot.directionCount < 3
            || snapshot.directionCount > 6
            || directions.length !== snapshot.directionCount
            || !isObject(snapshot.authority)
            || !Number.isSafeInteger(snapshot.authority.projectVersion)
            || snapshot.authority.projectVersion < 1
            || !Number.isSafeInteger(snapshot.authority.chapterRevision)
            || snapshot.authority.chapterRevision < 1) invalid();
        if (materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION) {
            if (!HASH.test(snapshot.evidenceDigest ?? '')
                || !HASH.test(snapshot.diagnosisDigest ?? '')
                || !HASH.test(snapshot.sourceSnapshotDigest ?? '')
                || snapshot.diagnosisDigest !== workflowContractDigest({
                    source: 'planning-copilot',
                    sessionId: snapshot.sessionId,
                    artifactId: snapshot.artifactId,
                    artifactDigest: snapshot.artifactDigest,
                    evidenceDigest: snapshot.evidenceDigest,
                })) invalid();
        }
        const legacyAllowed = [
            'optionId', 'directionId', 'directionDigest', 'sourceEventChainDigest', 'evidenceIdsDigest',
        ];
        const allowed = materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
            ? ['directionIndex', ...legacyAllowed]
            : legacyAllowed;
        const normalized = directions.map((entry, index) => {
            if (!isObject(entry)
                || Object.keys(entry).some(field => !allowed.includes(field))
                || allowed.some(field => !Object.hasOwn(entry, field))
                || (materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
                    && (!Number.isSafeInteger(entry.directionIndex) || entry.directionIndex !== index))
                || !ID.test(entry.optionId ?? '')
                || !ID.test(entry.directionId ?? '')
                || !HASH.test(entry.directionDigest ?? '')
                || !HASH.test(entry.sourceEventChainDigest ?? '')
                || !HASH.test(entry.evidenceIdsDigest ?? '')) invalid();
            return {
                ...entry,
                directionIndex: materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
                    ? entry.directionIndex
                    : index,
            };
        });
        if (new Set(normalized.map(item => item.optionId)).size !== normalized.length
            || new Set(normalized.map(item => item.directionId)).size !== normalized.length
            || !normalized.some(item => item.optionId === snapshot.optionId
                && item.directionId === snapshot.selectedDirectionId)) invalid();
        return normalized;
    }

    storedCopilotHandoffV2Entries(run, snapshot, { allowPartial = false } = {}) {
        const coordinates = this.copilotHandoffV2Coordinates(run, snapshot);
        const coordinateByDirection = new Map(coordinates.map(item => [item.directionId, item]));
        const artifacts = this.workflowStore.listArtifacts(run.projectId, run.id)
            .filter(artifact => artifact.stepId === 'brainstorm' && artifact.kind === 'brainstorm-direction');
        if (artifacts.length > coordinates.length) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff contains extra brainstorm directions.');
        }
        const seen = new Set();
        const byDirection = new Map();
        for (const artifact of artifacts) {
            const payload = normalizeWorkflowV2ArtifactPayload('brainstorm-direction', artifact.payload);
            const coordinate = coordinateByDirection.get(payload.direction.id);
            if (!coordinate
                || seen.has(payload.direction.id)
                || artifact.id !== deterministicArtifactId(artifact.kind, artifactIdentity(artifact))
                || !['candidate', 'approved', 'applied', 'rejected'].includes(artifact.status)
                || artifact.target.type !== 'workflow-run'
                || artifact.base.projectVersion !== snapshot.authority.projectVersion
                || artifact.base.chapterRevision !== snapshot.authority.chapterRevision
                || payload.setDigest !== snapshot.setDigest
                || payload.generationId !== snapshot.generationId
                || payload.directionIndex !== coordinate.directionIndex
                || workflowContractDigest(payload.direction) !== coordinate.directionDigest
                || !payload.direction.sourceEventChain
                || workflowContractDigest(payload.direction.sourceEventChain)
                    !== coordinate.sourceEventChainDigest
                || workflowContractDigest(artifact.evidenceIds) !== coordinate.evidenceIdsDigest
                || (snapshot.materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
                    && (payload.diagnosisDigest !== snapshot.diagnosisDigest
                        || payload.sourceSnapshotDigest !== snapshot.sourceSnapshotDigest))) {
                throw new ApiError(500, 'invalid_workflow_state',
                    'Stored Copilot handoff direction does not match its pinned source coordinates.');
            }
            seen.add(payload.direction.id);
            byDirection.set(payload.direction.id, {
                optionId: coordinate.optionId,
                payload,
                evidenceIds: [...artifact.evidenceIds],
                artifact,
            });
        }
        if (!allowPartial && byDirection.size !== coordinates.length) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff lost its complete brainstorm direction set.');
        }
        return {
            complete: byDirection.size === coordinates.length,
            entries: coordinates.map(item => byDirection.get(item.directionId)).filter(Boolean),
        };
    }

    sourceCopilotHandoffV2Entries(run, snapshot) {
        const coordinates = this.copilotHandoffV2Coordinates(run, snapshot);
        if (!this.copilotService) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff source is unavailable during recovery.');
        }
        const session = this.copilotService.getSession(run.projectId, snapshot.sessionId);
        const artifact = session.artifact;
        if (session.status !== 'ready'
            || session.stale
            || session.id !== snapshot.sessionId
            || session.contextDigest !== snapshot.contextDigest
            || session.base?.projectId !== run.projectId
            || session.base?.anchorChapterId !== run.chapterId
            || session.base?.projectVersion !== snapshot.authority.projectVersion
            || session.base?.anchorChapterRevision !== snapshot.authority.chapterRevision
            || !artifact
            || artifact.id !== snapshot.artifactId
            || artifact.artifactDigest !== snapshot.artifactDigest
            || artifact.status !== 'candidate'
            || artifact.projectId !== run.projectId
            || artifact.sessionId !== session.id
            || artifact.contextDigest !== session.contextDigest
            || artifact.profileHash !== session.profile?.profileHash
            || artifact.providerHash !== session.provider?.configHash
            || artifact.evidenceDigest !== hashCopilotValue(session.evidenceCatalog)
            || hashCopilotValue(artifact.base) !== hashCopilotValue(session.base)) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff source no longer matches the pinned Workflow snapshot.');
        }
        if (snapshot.materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
            && artifact.evidenceDigest !== snapshot.evidenceDigest) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff source evidence no longer matches the pinned Workflow snapshot.');
        }
        const { id: artifactId, artifactDigest, ...artifactCore } = artifact;
        if (artifactDigest !== hashCopilotValue(artifactCore)
            || artifactId !== `copilot-artifact-${artifactDigest.slice(0, 40)}`) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff source failed artifact lineage validation.');
        }
        const {
            options,
            payloads,
            generationId,
        } = materializeCopilotHandoffSet({
            artifact,
            session,
            projectId: run.projectId,
            chapterId: run.chapterId,
            projectVersion: snapshot.authority.projectVersion,
            chapterRevision: snapshot.authority.chapterRevision,
        });
        if (generationId !== snapshot.generationId
            || payloads.length !== coordinates.length
            || payloads[0]?.setDigest !== snapshot.setDigest
            || (snapshot.materializerVersion === COPILOT_HANDOFF_MATERIALIZER_VERSION
                && (payloads[0]?.diagnosisDigest !== snapshot.diagnosisDigest
                    || payloads[0]?.sourceSnapshotDigest !== snapshot.sourceSnapshotDigest))) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff source rebuilt a different direction set.');
        }
        return payloads.map((payload, index) => {
            const coordinate = coordinates[index];
            const evidenceIds = [...options[index].evidenceIds];
            if (coordinate.directionIndex !== payload.directionIndex
                || coordinate.optionId !== options[index].id
                || coordinate.directionId !== payload.direction.id
                || coordinate.directionDigest !== workflowContractDigest(payload.direction)
                || coordinate.sourceEventChainDigest
                    !== workflowContractDigest(payload.direction.sourceEventChain)
                || coordinate.evidenceIdsDigest !== workflowContractDigest(evidenceIds)) {
                throw new ApiError(500, 'invalid_workflow_state',
                    'Copilot handoff source coordinates changed during recovery.');
            }
            return { optionId: coordinate.optionId, payload, evidenceIds };
        });
    }

    copilotHandoffEntries(run, snapshot, { allowSource = false } = {}) {
        if (snapshot?.version === 1) return this.copilotHandoffV1Entries(run, snapshot);
        const stored = this.storedCopilotHandoffV2Entries(run, snapshot, { allowPartial: allowSource });
        if (stored.complete) {
            return stored.entries.map(entry => ({
                optionId: entry.optionId,
                payload: entry.payload,
                evidenceIds: entry.evidenceIds,
            }));
        }
        if (!allowSource) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff cannot recover an incomplete direction set at this step.');
        }
        return this.sourceCopilotHandoffV2Entries(run, snapshot);
    }

    terminateChangedCopilotHandoff(run, cause = null) {
        let current = this.workflowStore.getRun(run.projectId, run.id);
        if (current.status === 'cancelled'
            && current.lastCommand?.type === 'copilot-handoff-context-changed') return current;
        if (!current.currentStepId || ['completed', 'cancelled'].includes(current.status)) return current;
        const commandId = `handoff-${hashWorkflowValue({
            runId: current.id,
            phase: 'context-changed',
            requestDigest: current.input?.requestDigest,
        }).slice(0, 48)}`;
        current = this.workflowStore.transitionStep({
            projectId: current.projectId,
            runId: current.id,
            stepId: current.currentStepId,
            status: 'cancelled',
            artifactIds: [],
            commandId,
            expectedRevision: current.revision,
            type: 'copilot-handoff-context-changed',
            payload: {
                expectedProjectVersion: cause?.details?.expectedProjectVersion
                    ?? current.input?.authority?.projectVersion,
                expectedChapterRevision: cause?.details?.expectedChapterRevision
                    ?? current.input?.authority?.chapterRevision,
                currentProjectVersion: cause?.details?.currentProjectVersion ?? null,
                currentChapterRevision: cause?.details?.currentChapterRevision ?? null,
            },
            response: {
                runId: current.id,
                status: 'cancelled',
                reason: 'copilot_context_changed',
            },
        }).run;
        return current;
    }

    resumeCopilotHandoff(run) {
        const snapshot = run.input?.user?.copilotHandoff;
        if (!snapshot) return run;
        if (run.definitionId !== WORKFLOW_V2_DEFINITION_ID) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Stored Copilot handoff is attached to an unsupported Workflow definition.');
        }
        let current = this.workflowStore.getRun(run.projectId, run.id);
        const handoffAuthority = this.copilotHandoffAuthority(current, snapshot);
        if (current.status === 'cancelled'
            && current.lastCommand?.type === 'copilot-handoff-context-changed') {
            throw new ApiError(409, 'copilot_context_changed',
                'Copilot context changed before Workflow handoff materialization.', {
                    runId: current.id,
                    runStatus: current.status,
                });
        }
        if (['brainstorm', 'select-direction'].includes(current.currentStepId)) {
            const { project, chapter } = this.loadAuthority(current.projectId, current.chapterId);
            try {
                this.assertAuthority(
                    project,
                    chapter,
                    handoffAuthority.projectVersion,
                    handoffAuthority.chapterRevision,
                    'copilot_context_changed',
                );
            } catch (error) {
                if (error?.code !== 'copilot_context_changed') throw error;
                current = this.terminateChangedCopilotHandoff(current, error);
                throw new ApiError(409, 'copilot_context_changed',
                    'Copilot context changed before Workflow handoff materialization.', {
                        ...error.details,
                        runId: current.id,
                        runStatus: current.status,
                });
            }
        }
        const directionEntries = this.copilotHandoffEntries(current, snapshot, {
            allowSource: current.currentStepId === 'brainstorm',
        });
        if (current.currentStepId === 'brainstorm') {
            const artifacts = directionEntries.map(entry => this.ensureArtifact({
                projectId: current.projectId,
                runId: current.id,
                stepId: 'brainstorm',
                kind: 'brainstorm-direction',
                source: 'model',
                target: target('workflow-run', current.chapterId),
                base: clone(handoffAuthority),
                payload: entry.payload,
                evidenceIds: entry.evidenceIds,
            }));
            const commandId = `handoff-${hashWorkflowValue({
                runId: current.id,
                phase: 'brainstorm',
                setDigest: snapshot.setDigest,
            }).slice(0, 48)}`;
            current = this.workflowStore.transitionStep({
                projectId: current.projectId,
                runId: current.id,
                stepId: 'brainstorm',
                status: 'completed',
                artifactIds: artifacts.map(artifact => artifact.id),
                commandId,
                expectedRevision: current.revision,
                type: 'copilot-handoff-brainstorm',
                payload: {
                    sessionId: snapshot.sessionId,
                    artifactId: snapshot.artifactId,
                    setDigest: snapshot.setDigest,
                },
                response: {
                    artifactIds: artifacts.map(artifact => artifact.id),
                    directionCount: artifacts.length,
                    source: 'planning-copilot',
                },
            }).run;
        }

        const brainstormStep = current.steps.find(step => step.id === 'brainstorm');
        const storedArtifacts = this.workflowStore.listArtifacts(current.projectId, current.id);
        const handoffArtifacts = snapshot.version === 1
            ? storedArtifacts.filter(artifact => (
                artifact.stepId === 'brainstorm'
                && artifact.kind === 'brainstorm-direction'
                && artifact.payload?.setDigest === snapshot.setDigest
            ))
            : this.storedCopilotHandoffV2Entries(current, snapshot).entries.map(entry => entry.artifact);
        if (handoffArtifacts.length !== directionEntries.length
            || brainstormStep?.artifactIds.length !== directionEntries.length
            || handoffArtifacts.some(artifact => !brainstormStep.artifactIds.includes(artifact.id))) {
            throw new ApiError(500, 'invalid_workflow_state',
                'Copilot handoff lost its complete brainstorm direction set.');
        }

        if (current.currentStepId === 'select-direction') {
            let selected = handoffArtifacts.find(artifact => (
                artifact.payload?.direction?.id === snapshot.selectedDirectionId
            ));
            if (!selected || !['candidate', 'approved'].includes(selected.status)
                || handoffArtifacts.some(artifact => (
                    artifact.id !== selected.id && !['candidate', 'rejected'].includes(artifact.status)
                ))) {
                throw new ApiError(500, 'invalid_workflow_state',
                    'Copilot handoff selection state is inconsistent.');
            }
            selected = this.approveArtifact(selected);
            const commandId = `handoff-${hashWorkflowValue({
                runId: current.id,
                phase: 'select-direction',
                setDigest: snapshot.setDigest,
                selectedArtifactId: selected.id,
            }).slice(0, 48)}`;
            current = this.workflowStore.transitionStep({
                projectId: current.projectId,
                runId: current.id,
                stepId: 'select-direction',
                status: 'completed',
                artifactIds: [selected.id],
                commandId,
                expectedRevision: current.revision,
                type: 'copilot-handoff-select',
                payload: {
                    sessionId: snapshot.sessionId,
                    artifactId: snapshot.artifactId,
                    optionId: snapshot.optionId,
                    selectedArtifactId: selected.id,
                },
                response: {
                    artifactId: selected.id,
                    optionId: snapshot.optionId,
                    source: 'planning-copilot',
                },
            }).run;
        }

        if (!['brainstorm', 'select-direction'].includes(current.currentStepId)) {
            const selectStep = current.steps.find(step => step.id === 'select-direction');
            const selected = selectStep?.artifactIds.length === 1
                ? this.workflowStore.getArtifact(current.projectId, current.id, selectStep.artifactIds[0])
                : null;
            if (!selected || !['approved', 'applied'].includes(selected.status)
                || selected.payload?.direction?.id !== snapshot.selectedDirectionId) {
                throw new ApiError(500, 'invalid_workflow_state',
                    'Copilot handoff lost its selected direction lineage.');
            }
        }
        return current;
    }

    recoverStoredCopilotHandoff(run, { throwOnContextChange = false } = {}) {
        if (!run?.input?.user?.copilotHandoff
            || ['completed', 'cancelled'].includes(run.status)
            || !['brainstorm', 'select-direction'].includes(run.currentStepId)) return run;
        try {
            return this.resumeCopilotHandoff(run);
        } catch (error) {
            if (throwOnContextChange || error?.code !== 'copilot_context_changed') throw error;
            return this.workflowStore.getRun(run.projectId, run.id);
        }
    }

    startRun(projectId, chapterId, body) {
        const input = assertObject(body, 'Workflow start request');
        assertKnownFields(input, START_FIELDS, 'Workflow start request');
        const commandId = cleanId(input.commandId, 'commandId');
        const projectVersion = cleanRevision(input.projectVersion, 'projectVersion');
        const chapterRevision = cleanRevision(input.chapterRevision, 'chapterRevision');
        const definition = this.workflowStore.getDefinition(cleanId(input.definitionId, 'definitionId'));
        const requestedHash = cleanHash(input.definitionHash, 'definitionHash', { optional: true });
        if (requestedHash && requestedHash !== definition.definitionHash) {
            throw new ApiError(409, 'workflow_definition_changed', 'Workflow definition changed before the run started.');
        }
        const userInput = input.input ?? {};
        assertObject(userInput, 'workflow input');
        const handoffReference = Object.hasOwn(userInput, 'copilotHandoff')
            ? normalizeCopilotHandoffReference(userInput.copilotHandoff)
            : null;
        if (handoffReference && definition.id !== WORKFLOW_V2_DEFINITION_ID) {
            throw new ApiError(400, 'invalid_copilot_handoff',
                'Copilot handoff requires the Workflow V2 chapter cycle.');
        }
        const requestDigest = hashWorkflowValue({
            projectId,
            chapterId,
            commandId,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion,
            chapterRevision,
            input: userInput,
        });
        const runId = `run-${hashWorkflowValue({ projectId, chapterId, commandId }).slice(0, 48)}`;
        try {
            const existing = this.workflowStore.getRun(projectId, runId);
            if (existing.chapterId !== chapterId || existing.definitionHash !== definition.definitionHash
                || existing.input?.requestDigest !== requestDigest) {
                throw new ApiError(409, 'workflow_command_conflict',
                    'commandId was reused for a different workflow run.');
            }
            const resumed = handoffReference ? this.resumeCopilotHandoff(existing) : existing;
            return this.runView(projectId, chapterId, resumed.id);
        } catch (error) {
            if (error?.code !== 'workflow_run_not_found') throw error;
        }
        const { project, chapter } = this.loadAuthority(projectId, chapterId);
        this.assertAuthority(project, chapter, projectVersion, chapterRevision);
        if (writeCapableDefinition(definition)) {
            this.assertWriteRunAvailable(projectId, chapterId, { starting: true });
        }
        const storedUserInput = clone(userInput);
        if (handoffReference) {
            storedUserInput.copilotHandoff = this.createCopilotHandoffSnapshot(
                projectId,
                chapterId,
                handoffReference,
                projectVersion,
                chapterRevision,
            );
        }
        let run;
        try {
            run = this.workflowStore.createRun({
                runId,
                projectId,
                chapterId,
                definitionId: definition.id,
                input: {
                    requestDigest,
                    authority: { projectVersion, chapterRevision },
                    user: storedUserInput,
                },
            });
        } catch (error) {
            if (error?.code !== 'workflow_run_exists') throw error;
            run = this.workflowStore.getRun(projectId, runId);
            if (run.chapterId !== chapterId || run.definitionHash !== definition.definitionHash
                || run.input?.requestDigest !== requestDigest) {
                throw new ApiError(409, 'workflow_command_conflict', 'commandId was reused for a different workflow run.');
            }
        }
        const resumed = handoffReference ? this.resumeCopilotHandoff(run) : run;
        return this.runView(projectId, chapterId, resumed.id);
    }

    listRuns(projectId, chapterId) {
        this.loadAuthorityReadOnly(projectId, chapterId);
        return {
            runs: this.workflowStore.listRuns(projectId)
                .filter(run => run.chapterId === chapterId)
                .map(summary => workflowRunSummary(this.workflowStore.getRun(projectId, summary.id))),
        };
    }

    expectedAuthority(run, artifacts) {
        let expected = run.input?.authority;
        for (const artifact of artifacts) {
            if (artifact.status !== 'applied' || artifact.target.projectVersion === null) continue;
            if (!expected || artifact.target.projectVersion > expected.projectVersion
                || (artifact.target.projectVersion === expected.projectVersion
                    && artifact.target.chapterRevision > expected.chapterRevision)) {
                expected = {
                    projectVersion: artifact.target.projectVersion,
                    chapterRevision: artifact.target.chapterRevision,
                };
            }
        }
        if (!expected) throw new ApiError(500, 'invalid_workflow_state', 'Workflow authority baseline is missing.');
        return expected;
    }

    currentArtifact(run, definition, artifacts) {
        if (!run.currentStepId) return null;
        const declaration = definition.steps.find(step => step.id === run.currentStepId);
        if (!declaration?.artifactKind) return null;
        const producer = PRODUCER_BY_STEP[run.currentStepId] ?? run.currentStepId;
        return [...artifacts].reverse().find(artifact => (
            artifact.stepId === producer && artifact.kind === declaration.artifactKind
        )) ?? null;
    }

    runView(projectId, chapterId, runId, extra = {}, { readOnlyAuthority = false } = {}) {
        const run = this.workflowStore.getRun(projectId, runId);
        if (run.chapterId !== chapterId) throw new ApiError(404, 'workflow_run_not_found', 'Workflow run not found.');
        const definition = this.workflowStore.getDefinition(run.definitionId);
        const storedArtifacts = this.workflowStore.listArtifacts(projectId, runId);
        const artifacts = storedArtifacts.map(publicArtifact);
        const { project, chapter } = readOnlyAuthority
            ? this.loadAuthorityReadOnly(projectId, chapterId)
            : this.loadAuthority(projectId, chapterId);
        const activeOperation = this.runOperations.get(this.runOperationKey(projectId, chapterId, runId));
        const operation = activeOperation ? {
            status: run.status === 'cancelled' ? 'draining' : 'executing',
            stepId: activeOperation.stepId,
            commandId: activeOperation.commandId,
        } : null;
        return {
            run,
            definition,
            artifacts,
            currentArtifact: publicArtifact(this.currentArtifact(run, definition, storedArtifacts)),
            authority: authorityView(project, chapter),
            operation,
            ...extra,
            ...(extra.artifact ? { artifact: publicArtifact(extra.artifact) } : {}),
        };
    }

    getRun(projectId, chapterId, runId) {
        const run = this.workflowStore.getRun(projectId, runId);
        if (run.chapterId !== chapterId) {
            throw new ApiError(404, 'workflow_run_not_found', 'Workflow run not found.');
        }
        return this.runView(projectId, chapterId, runId, {}, { readOnlyAuthority: true });
    }

    existingReceipt(projectId, runId, commandId, expectedRevision, type, payload) {
        let receipt;
        try {
            receipt = this.workflowStore.getReceipt(commandId);
        } catch (error) {
            if (error?.code === 'workflow_receipt_not_found') return null;
            throw error;
        }
        const commandDigest = hashWorkflowValue({
            projectId,
            runId,
            commandId,
            expectedRevision,
            type,
            payload,
        });
        if (receipt.projectId !== projectId || receipt.runId !== runId || receipt.type !== type
            || receipt.expectedRevision !== expectedRevision || receipt.commandDigest !== commandDigest) {
            throw new ApiError(409, 'workflow_command_conflict', 'commandId was already used for another command.');
        }
        return receipt;
    }

    ensureArtifact(input) {
        const artifactId = deterministicArtifactId(input.kind, artifactIdentity(input));
        const create = { ...input, artifactId };
        try {
            return this.workflowStore.createArtifact(create);
        } catch (error) {
            if (error?.code !== 'workflow_artifact_exists') throw error;
            const existing = this.workflowStore.getArtifact(input.projectId, input.runId, artifactId);
            if (artifactIdentity(existing) !== artifactIdentity(create)) {
                throw new ApiError(409, 'workflow_artifact_conflict', 'Workflow artifact id has different content.');
            }
            return existing;
        }
    }

    approveArtifact(artifact) {
        if (artifact.status === 'approved' || artifact.status === 'applied') return artifact;
        if (artifact.status !== 'candidate') {
            throw new ApiError(409, 'workflow_artifact_not_approvable', 'Workflow artifact is not approvable.');
        }
        return this.workflowStore.transitionArtifact(artifact.projectId, artifact.runId, artifact.id, {
            expectedRevision: artifact.revision,
            status: 'approved',
        });
    }

    applyArtifact(artifact, authority, digest) {
        let current = artifact;
        if (current.status === 'candidate') current = this.approveArtifact(current);
        if (current.status === 'applied') return current;
        if (current.status !== 'approved') {
            throw new ApiError(409, 'workflow_artifact_not_applicable', 'Workflow artifact is not applicable.');
        }
        return this.workflowStore.transitionArtifact(current.projectId, current.runId, current.id, {
            expectedRevision: current.revision,
            status: 'applied',
            target: {
                ...current.target,
                projectVersion: authority.projectVersion,
                chapterRevision: authority.chapterRevision,
                digest,
            },
        });
    }

    requireArtifact(run, artifacts, payload, kind, statuses) {
        const producer = PRODUCER_BY_STEP[run.currentStepId] ?? run.currentStepId;
        const candidates = artifacts.filter(artifact => artifact.stepId === producer && artifact.kind === kind);
        const artifact = payload.artifactId
            ? candidates.find(item => item.id === payload.artifactId)
            : candidates.at(-1);
        if (!artifact || !statuses.includes(artifact.status)) {
            throw new ApiError(409, 'workflow_artifact_required', 'The current step requires a matching workflow artifact.');
        }
        if (!payload.artifactId || !payload.artifactHash) {
            throw new ApiError(400, 'workflow_artifact_binding_required', 'artifactId and artifactHash are required.');
        }
        const suppliedHash = cleanHash(payload.artifactHash, 'artifactHash');
        if (suppliedHash !== artifactBindingHash(artifact) && suppliedHash !== artifact.recordHash) {
            throw new ApiError(409, 'workflow_artifact_changed', 'Workflow artifact changed before approval or application.');
        }
        return artifact;
    }

    completeStep(run, command, artifactIds, response = {}) {
        return this.workflowStore.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            status: 'completed',
            artifactIds,
            commandId: command.commandId,
            expectedRevision: command.runRevision,
            type: command.type,
            payload: command.payload,
            response,
        });
    }

    beforeWorkflowCommit() {
        return this.chapterVersionStore
            ? ({ projectVersion, chapter }) => this.chapterVersionStore.appendVersion(
                chapterVersionInput(projectVersion, chapter, 'workflow'),
            )
            : null;
    }

    assertRunAuthority(run, artifacts, project, chapter) {
        const expected = this.expectedAuthority(run, artifacts);
        this.assertAuthority(project, chapter, expected.projectVersion, expected.chapterRevision);
        return expected;
    }

    async executeCommand(projectId, chapterId, runId, body) {
        const input = assertObject(body, 'Workflow command');
        assertKnownFields(input, COMMAND_FIELDS, 'Workflow command');
        const command = {
            commandId: cleanId(input.commandId, 'commandId'),
            runRevision: cleanRevision(input.runRevision, 'runRevision'),
            type: input.type,
            payload: input.payload ?? {},
        };
        if (!COMMAND_TYPES.has(command.type)) {
            throw new ApiError(400, 'invalid_workflow_command', 'Workflow command type is invalid.');
        }
        assertObject(command.payload, 'workflow command payload');
        assertKnownFields(command.payload, COMMAND_PAYLOAD_FIELDS, 'workflow command payload');
        if (command.type === 'cancel') {
            assertKnownFields(command.payload, ['stepId', 'reason'], 'workflow cancel payload');
            command.payload = { ...command.payload, reason: cleanReason(command.payload.reason) };
        } else if (command.payload.reason !== undefined) {
            throw new ApiError(400, 'unknown_fields', 'workflow command payload contains unknown fields.', {
                fields: ['reason'],
            });
        }
        let run = this.workflowStore.getRun(projectId, runId);
        if (run.chapterId !== chapterId) throw new ApiError(404, 'workflow_run_not_found', 'Workflow run not found.');
        run = this.recoverStoredCopilotHandoff(run);
        if (run.definitionId === WORKFLOW_V2_DEFINITION_ID && command.type === 'attach-generation') {
            throw new ApiError(409, 'workflow_v2_attach_forbidden',
                'Workflow V2 model steps only accept their persisted bound generation intent.');
        }
        this.workflowStore.ensureLastCommandReceipt(run);
        const receipt = this.existingReceipt(
            projectId, runId, command.commandId, command.runRevision, command.type, command.payload,
        );
        if (receipt) {
            return this.runView(projectId, chapterId, runId, {
                command: compactCommand(receipt, true),
                artifact: receipt.response?.artifactId
                    ? this.workflowStore.getArtifact(projectId, runId, receipt.response.artifactId)
                    : null,
            });
        }

        if (run.revision !== command.runRevision) {
            throw new ApiError(409, 'workflow_revision_conflict', 'Workflow run revision changed.', {
                actualRevision: run.revision,
            });
        }
        if (command.type === 'cancel') {
            return this.cancelRun(run, command);
        }
        if (!run.currentStepId || ['completed', 'cancelled'].includes(run.status)) {
            if (run.status === 'cancelled') {
                throw new ApiError(409, 'workflow_cancelled', 'Workflow run is cancelled.');
            }
            throw new ApiError(409, 'workflow_completed', 'Workflow run is already complete.');
        }
        if (command.payload.stepId && command.payload.stepId !== run.currentStepId) {
            throw new ApiError(409, 'workflow_step_changed', 'Workflow current step changed.');
        }
        this.assertRunWriteLease(run);
        const operationKey = this.runOperationKey(projectId, chapterId, runId);
        const commandDigest = hashWorkflowValue({
            projectId,
            runId,
            commandId: command.commandId,
            expectedRevision: command.runRevision,
            type: command.type,
            payload: command.payload,
        });
        const active = this.runOperations.get(operationKey);
        if (active) {
            if (active.commandDigest === commandDigest && active.commandId === command.commandId
                && active.runRevision === command.runRevision) {
                return active.promise;
            }
            throw new ApiError(409, 'workflow_command_in_progress',
                'Another command is already executing for this workflow run.', {
                    commandId: active.commandId,
                });
        }
        const controller = new AbortController();
        const promise = Promise.resolve()
            .then(() => this.executeCommandOnce(projectId, chapterId, run, command, controller.signal))
            .catch(error => {
                if (controller.signal.aborted) {
                    const current = this.workflowStore.getRun(projectId, runId);
                    if (current.status === 'cancelled') {
                        throw new ApiError(409, 'workflow_cancelled', 'Workflow run was cancelled.', {
                            actualRevision: current.revision,
                        });
                    }
                }
                throw error;
            })
            .finally(() => {
                const current = this.runOperations.get(operationKey);
                if (current?.promise === promise) this.runOperations.delete(operationKey);
            });
        const definition = this.workflowStore.getDefinition(run.definitionId);
        this.runOperations.set(operationKey, {
            projectId,
            chapterId,
            runId,
            runRevision: command.runRevision,
            commandId: command.commandId,
            commandDigest,
            stepId: run.currentStepId,
            writeCapable: writeCapableDefinition(definition),
            controller,
            promise,
        });
        return promise;
    }

    cancelRun(run, command) {
        if (!run.currentStepId || ['completed', 'cancelled'].includes(run.status)) {
            throw new ApiError(409, run.status === 'cancelled' ? 'workflow_cancelled' : 'workflow_completed',
                run.status === 'cancelled' ? 'Workflow run is cancelled.' : 'Workflow run is already complete.');
        }
        const stepId = cleanId(command.payload.stepId, 'stepId');
        if (stepId !== run.currentStepId) {
            throw new ApiError(409, 'workflow_step_changed', 'Workflow current step changed.');
        }
        const operation = this.runOperations.get(this.runOperationKey(run.projectId, run.chapterId, run.id));
        const committed = this.workflowStore.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: command.commandId,
            expectedRevision: command.runRevision,
            stepId,
            status: 'cancelled',
            artifactIds: [],
            type: 'cancel',
            payload: command.payload,
            response: {
                stepId,
                status: 'cancelled',
                abortedOperation: Boolean(operation),
            },
        });
        operation?.controller.abort(new DOMException('Workflow run cancelled.', 'AbortError'));
        return this.runView(run.projectId, run.chapterId, run.id, {
            command: compactCommand(committed.receipt, committed.replayed),
        });
    }

    async executeCommandOnce(projectId, chapterId, run, command, signal) {
        throwIfAborted(signal);
        const artifacts = this.workflowStore.listArtifacts(projectId, run.id);
        let committed;
        let artifact = null;
        if (run.definitionId === WORKFLOW_V2_DEFINITION_ID) {
            ({ committed, artifact } = await this.executeWorkflowV2Step(run, artifacts, command, signal));
        } else {
            switch (run.currentStepId) {
                case 'diagnose': ({ committed, artifact } = await this.executeDiagnosis(run, artifacts, command)); break;
                case 'propose-card': ({ committed, artifact } = await this.executeCardProposal(run, artifacts, command)); break;
                case 'approve-card': ({ committed, artifact } = await this.executeApproval(run, artifacts, command, 'chapter-card')); break;
                case 'apply-card': ({ committed, artifact } = await this.executeCardApply(run, artifacts, command)); break;
                case 'draft': ({ committed, artifact } = await this.executeGeneration(run, artifacts, command, 'draft', signal)); break;
                case 'distill': ({ committed, artifact } = await this.executeDistillation(run, artifacts, command, signal)); break;
                case 'approve-state': ({ committed, artifact } = await this.executeApproval(run, artifacts, command, 'state-change-set')); break;
                case 'adopt': ({ committed, artifact } = await this.executeAdoption(run, artifacts, command)); break;
                case 'review': ({ committed, artifact } = await this.executeGeneration(run, artifacts, command, 'review', signal)); break;
                case 'apply-review': ({ committed, artifact } = await this.executeReviewApply(run, artifacts, command)); break;
                case 'closeout': ({ committed, artifact } = await this.executeCloseout(run, artifacts, command)); break;
                default: throw new ApiError(409, 'unsupported_workflow_step', 'Workflow step is not executable.');
            }
        }
        throwIfAborted(signal);
        let finalRun = committed.run;
        finalRun = this.advanceFalseConditions(finalRun);
        return this.runView(projectId, chapterId, finalRun.id, {
            artifact,
            command: compactCommand(committed.receipt, committed.replayed),
        });
    }

    advanceFalseConditions(run) {
        let current = run;
        while (current.currentStepId) {
            const definition = this.workflowStore.getDefinition(current.definitionId);
            const declaration = definition.steps.find(step => step.id === current.currentStepId);
            const artifacts = this.workflowStore.listArtifacts(current.projectId, current.id);
            const latest = artifacts.at(-1);
            if (evaluateWorkflowCondition(declaration.condition, {
                input: current.input,
                run: current,
                artifact: latest?.payload ?? {},
            })) break;
            const commandId = `auto-${hashWorkflowValue({
                runId: current.id,
                stepId: current.currentStepId,
                revision: current.revision,
            }).slice(0, 48)}`;
            current = this.workflowStore.transitionStep({
                projectId: current.projectId,
                runId: current.id,
                stepId: current.currentStepId,
                status: 'skipped',
                artifactIds: [],
                commandId,
                expectedRevision: current.revision,
                type: 'condition-skip',
                response: { skipped: true, stepId: current.currentStepId },
            }).run;
        }
        return current;
    }

    workflowV2StepArtifact(run, artifacts, stepId, kind, statuses) {
        const state = run.steps.find(step => step.id === stepId);
        if (!state || state.artifactIds.length !== 1) {
            throw new ApiError(409, 'workflow_v2_lineage_missing',
                `Workflow V2 step ${stepId} must publish exactly one selected artifact.`);
        }
        const artifact = artifacts.find(item => item.id === state.artifactIds[0]);
        if (!artifact || artifact.kind !== kind || !statuses.includes(artifact.status)) {
            throw new ApiError(409, 'workflow_v2_lineage_missing',
                `Workflow V2 step ${stepId} lost its ${kind} artifact.`);
        }
        return artifact;
    }

    workflowV2PlanDirection(run, artifacts, plan) {
        const selectedDirection = this.workflowV2StepArtifact(
            run, artifacts, 'select-direction', 'brainstorm-direction', ['approved', 'applied'],
        );
        let directionPayload;
        let planPayload;
        try {
            directionPayload = normalizeWorkflowV2ArtifactPayload(
                'brainstorm-direction',
                selectedDirection.payload,
            );
            planPayload = normalizeWorkflowV2ArtifactPayload('chapter-plan', plan.payload);
        } catch {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved plan or selected direction failed its persisted contract.');
        }
        if (planPayload.directionArtifactId !== selectedDirection.id
            || planPayload.directionDigest !== workflowContractDigest(directionPayload.direction)) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved plan is not bound to the exact human-selected direction.');
        }
        const sourceEvents = directionPayload.direction.sourceEventChain;
        const sourceCoverage = planPayload.sourceEventCoverage;
        if (Array.isArray(sourceEvents)) {
            if (!Array.isArray(sourceCoverage)
                || sourceCoverage.length !== sourceEvents.length
                || sourceCoverage.some((entry, index) => entry?.sourceOrder !== sourceEvents[index]?.order)) {
                throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                    'Approved plan source-event coverage no longer matches the selected direction.');
            }
        } else if (sourceCoverage !== undefined) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved plan has source-event coverage without a selected source chain.');
        }
        return selectedDirection;
    }

    workflowV2SourceContext(run, command, project, chapter) {
        const diagnosis = this.diagnosis(run.projectId, run.chapterId, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            retrieval: command.payload.retrieval ?? {},
        });
        const context = this.generationService.loadContext(run.projectId, run.chapterId, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
        });
        const sourceSnapshot = workflowV2Json({
            authority: { projectVersion: project.version, chapterRevision: chapter.revision },
            project: {
                id: project.id,
                title: project.title,
                genre: project.genre,
                targetWords: project.targetWords,
                chapterTargetWords: project.chapterTargetWords,
                story: project.story,
                continuity: project.continuity,
                storyState: project.storyState,
                volumes: project.volumes,
                chapters: project.chapters,
            },
            chapter,
            previousChapter: context.previousChapter,
            nextChapter: context.nextChapter,
            activeResources: context.resources,
        });
        return { diagnosis, sourceSnapshot };
    }

    async workflowV2Model(run, command, kind, operation, prompt, signal) {
        const intent = this.generationIntent(run, command, kind);
        const result = await this.generationService.streamWorkflowV2Model(
            run.projectId,
            run.chapterId,
            {
                kind,
                operation,
                projectVersion: run.input.authority.projectVersion,
                chapterRevision: run.input.authority.chapterRevision,
                prompt,
            },
            { workflowIntent: intent, signal },
        );
        throwIfAborted(signal);
        if (result.generation?.status !== 'completed'
            || typeof result.generation.content !== 'string'
            || !result.generation.content.trim()) {
            throw new ApiError(409, 'workflow_v2_generation_incomplete',
                'Workflow V2 only accepts a completed non-empty model generation.');
        }
        return result.generation;
    }

    workflowV2Materialize(run, generation, callback) {
        try {
            return callback();
        } catch (error) {
            if (error?.status === 502
                || ['invalid_workflow_model_output', 'invalid_workflow_artifact_payload']
                    .includes(error?.code)) {
                try {
                    this.generationService.generationStore.finishGeneration(
                        run.projectId,
                        run.chapterId,
                        generation.id,
                        {
                            status: 'failed',
                            finishReason: 'invalid-output',
                            error: String(error?.message ?? 'Workflow V2 model output failed validation.'),
                        },
                    );
                } catch {
                    // Preserve the authoritative model-validation error.
                }
            }
            throw error;
        }
    }

    workflowV2GenerationForArtifact(run, artifact, kind, sourceTextKind = null) {
        const generation = this.generationService.generationStore.getGeneration(
            run.projectId,
            run.chapterId,
            artifact.payload.generationId,
        );
        if (generation.kind !== kind || generation.status !== 'completed' || !generation.content) {
            throw new ApiError(409, 'workflow_v2_generation_incomplete',
                `Workflow V2 ${kind} generation is not a completed bound candidate.`);
        }
        const binding = generation.request?.workflowGeneration;
        if (binding?.slot?.projectId !== run.projectId
            || binding.slot.chapterId !== run.chapterId
            || binding.slot.runId !== run.id
            || binding.slot.stepId !== artifact.stepId
            || binding.slot.kind !== kind
            || generation.request?.workflowV2?.operation !== kind) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                `Workflow V2 ${kind} generation is not bound to this run step.`);
        }
        if (sourceTextKind) {
            normalizeWorkflowV2ArtifactPayload(sourceTextKind, artifact.payload, {
                sourceText: generation.content,
            });
        }
        return generation;
    }

    workflowV2Lineage(run, directionArtifact, adoptionPayload) {
        const lineage = {
            runId: run.id,
            directionArtifactId: adoptionPayload.directionArtifactId,
            directionSetDigest: directionArtifact.payload.setDigest,
            planArtifactId: adoptionPayload.planArtifactId,
            planDigest: adoptionPayload.planDigest,
            reviewArtifactId: adoptionPayload.reviewArtifactId,
            reviewDigest: adoptionPayload.reviewDigest,
            rewriteArtifactId: adoptionPayload.rewriteArtifactId,
            manuscriptArtifactId: adoptionPayload.manuscriptArtifactId,
            manuscriptGenerationId: adoptionPayload.manuscriptGenerationId,
            manuscriptDigest: adoptionPayload.manuscriptDigest,
        };
        return { ...lineage, lineageDigest: workflowContractDigest(lineage) };
    }

    async executeWorkflowV2Step(run, artifacts, command, signal) {
        if (command.type !== 'execute') {
            throw new ApiError(409, 'invalid_workflow_v2_command',
                'Workflow V2 steps only accept execute or cancel commands.');
        }
        switch (run.currentStepId) {
            case 'brainstorm': return this.executeWorkflowV2Brainstorm(run, artifacts, command, signal);
            case 'select-direction': return this.executeApproval(
                run, artifacts, command, 'brainstorm-direction',
            );
            case 'plan': return this.executeWorkflowV2Plan(run, artifacts, command, signal);
            case 'approve-plan': return this.executeApproval(run, artifacts, command, 'chapter-plan');
            case 'draft': return this.executeWorkflowV2Draft(run, artifacts, command, signal);
            case 'review': return this.executeWorkflowV2Review(run, artifacts, command, signal);
            case 'approve-review': return this.executeApproval(run, artifacts, command, 'chapter-review');
            case 'rewrite': return this.executeWorkflowV2Rewrite(run, artifacts, command, signal);
            case 'approve-rewrite': return this.executeApproval(run, artifacts, command, 'rewrite-diff');
            case 'distill': return this.executeWorkflowV2Distill(run, artifacts, command, signal);
            case 'approve-adoption': return this.executeApproval(run, artifacts, command, 'chapter-adoption');
            case 'adopt': return this.executeWorkflowV2Adoption(run, artifacts, command);
            default: throw new ApiError(409, 'unsupported_workflow_step',
                'Workflow V2 step is not executable.');
        }
    }

    async executeWorkflowV2Brainstorm(run, artifacts, command, signal) {
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { diagnosis, sourceSnapshot } = this.workflowV2SourceContext(run, command, project, chapter);
        const prompt = buildWorkflowV2Prompt('brainstorm', {
            diagnosis,
            sourceSnapshot,
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(
            run, command, 'brainstorm', 'brainstorm', prompt, signal,
        );
        const payloads = this.workflowV2Materialize(run, generation, () => materializeBrainstormPayloads({
            modelOutput: generation.content,
            generationId: generation.id,
            diagnosis,
            sourceSnapshot,
        }));
        const evidenceIds = diagnosis.evidenceCatalog.slice(0, 512).map(item => item.evidenceId);
        const candidates = payloads.map(payload => this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'brainstorm-direction',
            source: 'model',
            target: target('workflow-run', run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds,
        }));
        const committed = this.completeStep(run, command, candidates.map(item => item.id), {
            artifactIds: candidates.map(item => item.id),
            generationId: generation.id,
            directionCount: candidates.length,
        });
        return { committed, artifact: candidates[0] };
    }

    async executeWorkflowV2Plan(run, artifacts, command, signal) {
        const direction = this.workflowV2StepArtifact(
            run, artifacts, 'select-direction', 'brainstorm-direction', ['approved', 'applied'],
        );
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { diagnosis, sourceSnapshot } = this.workflowV2SourceContext(run, command, project, chapter);
        const prompt = buildWorkflowV2Prompt('plan', {
            selectedDirection: direction.payload,
            diagnosis,
            sourceSnapshot,
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(run, command, 'plan', 'plan', prompt, signal);
        const payload = this.workflowV2Materialize(run, generation, () => materializePlanPayload({
            modelOutput: generation.content,
            generationId: generation.id,
            directionArtifactId: direction.id,
            directionPayload: direction.payload,
        }));
        const artifact = this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'chapter-plan',
            source: 'model',
            target: target('chapter-card', run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds: [...new Set([
                ...direction.evidenceIds,
                ...generationEvidenceIds(generation),
            ])].slice(0, 512),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
        });
        return { committed, artifact };
    }

    async executeWorkflowV2Draft(run, artifacts, command, signal) {
        const plan = this.workflowV2StepArtifact(
            run, artifacts, 'approve-plan', 'chapter-plan', ['approved', 'applied'],
        );
        const direction = this.workflowV2PlanDirection(run, artifacts, plan);
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { diagnosis, sourceSnapshot } = this.workflowV2SourceContext(run, command, project, chapter);
        const prompt = buildWorkflowV2Prompt('draft', {
            approvedPlan: plan.payload,
            selectedDirection: direction.payload,
            diagnosis,
            sourceSnapshot,
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(run, command, 'draft', 'draft', prompt, signal);
        const retrievalEvidenceIds = diagnosis.evidenceCatalog.slice(0, 256).map(item => item.evidenceId);
        const payload = this.workflowV2Materialize(run, generation, () => materializeDraftPayload({
            generationId: generation.id,
            planArtifactId: plan.id,
            planPayload: plan.payload,
            manuscript: generation.content,
            prompt: workflowV2PromptText(prompt),
            sourceSnapshot,
            retrievalEvidenceIds,
        }));
        const artifact = this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'chapter-draft',
            source: 'model',
            target: target('chapter-content', run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds: [...new Set([
                ...retrievalEvidenceIds,
                ...generationEvidenceIds(generation),
            ])].slice(0, 512),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
        });
        return { committed, artifact };
    }

    async executeWorkflowV2Review(run, artifacts, command, signal) {
        const draft = this.workflowV2StepArtifact(
            run, artifacts, 'draft', 'chapter-draft', ['candidate', 'approved', 'applied'],
        );
        const draftGeneration = this.workflowV2GenerationForArtifact(
            run, draft, 'draft', 'chapter-draft',
        );
        const plan = artifacts.find(item => item.id === draft.payload.planArtifactId);
        if (!plan || plan.kind !== 'chapter-plan') {
            throw new ApiError(409, 'workflow_v2_lineage_missing', 'Draft lost its approved planning lineage.');
        }
        const direction = this.workflowV2PlanDirection(run, artifacts, plan);
        const approvedPlan = this.workflowV2StepArtifact(
            run, artifacts, 'approve-plan', 'chapter-plan', ['approved', 'applied'],
        );
        if (approvedPlan.id !== plan.id) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Draft planning lineage is not the exact human-approved lineage.');
        }
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { diagnosis, sourceSnapshot } = this.workflowV2SourceContext(run, command, project, chapter);
        const prompt = buildWorkflowV2Prompt('review', {
            candidateManuscript: draftGeneration.content,
            approvedPlan: plan.payload,
            selectedDirection: direction.payload,
            diagnosis,
            sourceSnapshot,
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(run, command, 'review', 'review', prompt, signal);
        const { payload, citedEvidence } = this.workflowV2Materialize(run, generation, () => {
            const reviewPayload = materializeReviewPayload({
                modelOutput: generation.content,
                generationId: generation.id,
                manuscriptArtifactId: draft.id,
                manuscriptGenerationId: draftGeneration.id,
                manuscript: draftGeneration.content,
            });
            const allowedEvidence = new Set(diagnosis.evidenceCatalog.map(item => item.evidenceId));
            const evidenceIds = reviewPayload.issues.flatMap(issue => issue.evidenceIds);
            const unknownEvidence = evidenceIds.filter(evidenceId => !allowedEvidence.has(evidenceId));
            if (unknownEvidence.length > 0) {
                throw new ApiError(502, 'invalid_workflow_model_output',
                    'Review cited evidence outside the frozen source snapshot.', {
                        evidenceIds: [...new Set(unknownEvidence)],
                    });
            }
            return { payload: reviewPayload, citedEvidence: evidenceIds };
        });
        const artifact = this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'chapter-review',
            source: 'model',
            target: target('chapter-quality', run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds: [...new Set([
                ...citedEvidence,
                ...generationEvidenceIds(generation),
            ])].slice(0, 512),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
            rewriteRequired: payload.rewriteRequired,
        });
        return { committed, artifact };
    }

    async executeWorkflowV2Rewrite(run, artifacts, command, signal) {
        const review = this.workflowV2StepArtifact(
            run, artifacts, 'approve-review', 'chapter-review', ['approved', 'applied'],
        );
        const draft = artifacts.find(item => item.id === review.payload.manuscriptArtifactId);
        if (!draft || draft.kind !== 'chapter-draft') {
            throw new ApiError(409, 'workflow_v2_lineage_missing', 'Review lost its draft manuscript.');
        }
        const draftGeneration = this.workflowV2GenerationForArtifact(
            run, draft, 'draft', 'chapter-draft',
        );
        const normalizedReview = normalizeWorkflowV2ArtifactPayload(
            'chapter-review', review.payload, { sourceText: draftGeneration.content },
        );
        if (!normalizedReview.rewriteRequired || !normalizedReview.rewriteTarget) {
            throw new ApiError(409, 'workflow_v2_rewrite_not_required',
                'The approved review does not authorize a rewrite.');
        }
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { start, end } = normalizedReview.rewriteTarget;
        const prompt = buildWorkflowV2Prompt('rewrite', {
            approvedReview: normalizedReview,
            approvedRange: normalizedReview.rewriteTarget,
            contextBefore: draftGeneration.content.slice(Math.max(0, start - 8_000), start),
            contextAfter: draftGeneration.content.slice(end, end + 8_000),
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(run, command, 'rewrite', 'rewrite', prompt, signal);
        const rewritten = this.workflowV2Materialize(run, generation, () => materializeRewritePayload({
            modelOutput: generation.content,
            generationId: generation.id,
            reviewArtifactId: review.id,
            reviewPayload: normalizedReview,
            baseManuscript: draftGeneration.content,
        }));
        const issueEvidence = normalizedReview.issues
            .filter(issue => normalizedReview.rewriteTarget.issueIds.includes(issue.id))
            .flatMap(issue => issue.evidenceIds);
        const artifact = this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'rewrite-diff',
            source: 'model',
            target: target('chapter-content', run.chapterId),
            base: base(project, chapter),
            payload: rewritten.payload,
            evidenceIds: [...new Set([
                ...issueEvidence,
                ...generationEvidenceIds(generation),
            ])].slice(0, 512),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
            resultDigest: rewritten.payload.resultDigest,
        });
        return { committed, artifact };
    }

    async executeWorkflowV2Distill(run, artifacts, command, signal) {
        const review = this.workflowV2StepArtifact(
            run, artifacts, 'approve-review', 'chapter-review', ['approved', 'applied'],
        );
        const draft = artifacts.find(item => item.id === review.payload.manuscriptArtifactId);
        if (!draft || draft.kind !== 'chapter-draft') {
            throw new ApiError(409, 'workflow_v2_lineage_missing', 'Approved review lost its draft manuscript.');
        }
        const draftGeneration = this.workflowV2GenerationForArtifact(
            run, draft, 'draft', 'chapter-draft',
        );
        const normalizedReview = normalizeWorkflowV2ArtifactPayload(
            'chapter-review', review.payload, { sourceText: draftGeneration.content },
        );
        let rewrite = null;
        let manuscriptArtifact = draft;
        let manuscriptGenerationId = draftGeneration.id;
        let manuscript = draftGeneration.content;
        if (normalizedReview.rewriteRequired) {
            rewrite = this.workflowV2StepArtifact(
                run, artifacts, 'approve-rewrite', 'rewrite-diff', ['approved', 'applied'],
            );
            this.workflowV2GenerationForArtifact(run, rewrite, 'rewrite');
            const normalizedRewrite = normalizeWorkflowV2ArtifactPayload('rewrite-diff', rewrite.payload, {
                baseText: draftGeneration.content,
            });
            manuscript = workflowV2FinalText(draftGeneration.content, normalizedRewrite);
            normalizeWorkflowV2ArtifactPayload('rewrite-diff', normalizedRewrite, {
                baseText: draftGeneration.content,
                resultText: manuscript,
            });
            manuscriptArtifact = rewrite;
            manuscriptGenerationId = normalizedRewrite.generationId;
        }
        const plan = artifacts.find(item => item.id === draft.payload.planArtifactId);
        const direction = plan ? artifacts.find(item => item.id === plan.payload.directionArtifactId) : null;
        if (!plan || plan.kind !== 'chapter-plan' || !direction || direction.kind !== 'brainstorm-direction') {
            throw new ApiError(409, 'workflow_v2_lineage_missing', 'Final manuscript lost its planning lineage.');
        }
        const approvedPlan = this.workflowV2StepArtifact(
            run, artifacts, 'approve-plan', 'chapter-plan', ['approved', 'applied'],
        );
        const selectedDirection = this.workflowV2StepArtifact(
            run, artifacts, 'select-direction', 'brainstorm-direction', ['approved', 'applied'],
        );
        if (approvedPlan.id !== plan.id || selectedDirection.id !== direction.id) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Final manuscript planning lineage is not the exact human-approved lineage.');
        }
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const { diagnosis, sourceSnapshot } = this.workflowV2SourceContext(run, command, project, chapter);
        const prompt = buildWorkflowV2Prompt('adoption', {
            finalManuscript: manuscript,
            approvedPlan: plan.payload,
            selectedDirection: direction.payload,
            approvedReview: normalizedReview,
            rewriteDiff: rewrite?.payload ?? null,
            diagnosis,
            sourceSnapshot,
            instruction: command.payload.instruction ?? '',
        });
        const generation = await this.workflowV2Model(run, command, 'distill', 'adoption', prompt, signal);
        const materialized = this.workflowV2Materialize(run, generation, () => {
            const modelIntent = parseWorkflowV2ModelJson(generation.content, 'adoptionOutput');
            let targetStoryState;
            try {
                targetStoryState = validateStoryStateChangeSet(
                    project.storyState,
                    modelIntent.storyStateChanges,
                    project.chapters.map(item => item.id),
                ).next;
            } catch (error) {
                throw new ApiError(502, 'invalid_workflow_model_output',
                    'Adoption output contains an invalid Story State ChangeSet.', {
                        causeCode: error?.code ?? null,
                        cause: String(error?.message ?? error),
                    });
            }
            const result = materializeAdoptionPayload({
                modelOutput: generation.content,
                runId: run.id,
                directionArtifactId: direction.id,
                directionPayload: direction.payload,
                planArtifactId: plan.id,
                planPayload: plan.payload,
                reviewArtifactId: review.id,
                reviewPayload: normalizedReview,
                rewriteArtifactId: rewrite?.id ?? null,
                rewritePayload: rewrite?.payload ?? null,
                reviewedManuscript: draftGeneration.content,
                manuscriptArtifactId: manuscriptArtifact.id,
                manuscriptGenerationId,
                manuscript,
                targetStoryState,
                authorityFingerprint: {
                    projectDigest: hashWorkflowValue(project),
                    chapterDigest: hashWorkflowValue(chapter),
                },
            });
            let validated;
            try {
                validated = validateStoryStateChangeSet(
                    project.storyState,
                    result.payload.storyStateChanges,
                    project.chapters.map(item => item.id),
                );
            } catch (error) {
                throw new ApiError(502, 'invalid_workflow_model_output',
                    'Materialized adoption contains an invalid Story State ChangeSet.', {
                        causeCode: error?.code ?? null,
                        cause: String(error?.message ?? error),
                    });
            }
            if (workflowContractDigest(validated.next) !== result.payload.targetStoryStateDigest) {
                throw new ApiError(500, 'invalid_workflow_v2_runtime_input',
                    'Materialized adoption target does not match its Story State ChangeSet.');
            }
            return result;
        });
        const artifact = this.ensureArtifact({
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'chapter-adoption',
            source: 'model',
            target: target('story-state', run.chapterId),
            base: base(project, chapter),
            payload: materialized.payload,
            evidenceIds: [...new Set([
                ...draft.evidenceIds,
                ...review.evidenceIds,
                ...(rewrite?.evidenceIds ?? []),
                ...generationEvidenceIds(generation),
            ])].slice(0, 512),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
            lineageDigest: materialized.lineage.lineageDigest,
        });
        return { committed, artifact };
    }

    async executeWorkflowV2Adoption(run, artifacts, command) {
        let adoption = this.requireArtifact(
            run, artifacts, command.payload, 'chapter-adoption', ['approved', 'applied'],
        );
        const approvedAdoption = this.workflowV2StepArtifact(
            run, artifacts, 'approve-adoption', 'chapter-adoption', ['approved', 'applied'],
        );
        if (approvedAdoption.id !== adoption.id) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Adopt must consume the exact human-approved adoption artifact.');
        }
        const payload = normalizeWorkflowV2ArtifactPayload('chapter-adoption', adoption.payload);
        const direction = artifacts.find(item => item.id === payload.directionArtifactId);
        const plan = artifacts.find(item => item.id === payload.planArtifactId);
        const review = artifacts.find(item => item.id === payload.reviewArtifactId);
        const draft = review
            ? artifacts.find(item => item.id === review.payload.manuscriptArtifactId)
            : null;
        if (!direction || direction.kind !== 'brainstorm-direction'
            || !plan || plan.kind !== 'chapter-plan'
            || !review || review.kind !== 'chapter-review'
            || !draft || draft.kind !== 'chapter-draft') {
            throw new ApiError(409, 'workflow_v2_lineage_missing',
                'Approved adoption lost a required direction, plan, draft, or review artifact.');
        }
        const selectedDirection = this.workflowV2StepArtifact(
            run, artifacts, 'select-direction', 'brainstorm-direction', ['approved', 'applied'],
        );
        const approvedPlan = this.workflowV2StepArtifact(
            run, artifacts, 'approve-plan', 'chapter-plan', ['approved', 'applied'],
        );
        const publishedDraft = this.workflowV2StepArtifact(
            run, artifacts, 'draft', 'chapter-draft', ['candidate', 'approved', 'applied'],
        );
        const approvedReview = this.workflowV2StepArtifact(
            run, artifacts, 'approve-review', 'chapter-review', ['approved', 'applied'],
        );
        if (selectedDirection.id !== direction.id || approvedPlan.id !== plan.id
            || publishedDraft.id !== draft.id || approvedReview.id !== review.id) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved adoption does not descend from every exact human gate.');
        }
        const normalizedDirection = normalizeWorkflowV2ArtifactPayload(
            'brainstorm-direction', direction.payload,
        );
        const normalizedPlan = normalizeWorkflowV2ArtifactPayload('chapter-plan', plan.payload);
        if (normalizedPlan.directionArtifactId !== direction.id
            || normalizedPlan.planDigest !== payload.planDigest) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved adoption plan lineage does not match the selected direction.');
        }
        const draftGeneration = this.workflowV2GenerationForArtifact(
            run, draft, 'draft', 'chapter-draft',
        );
        const normalizedReview = normalizeWorkflowV2ArtifactPayload(
            'chapter-review', review.payload, { sourceText: draftGeneration.content },
        );
        if (normalizedReview.reviewDigest !== payload.reviewDigest) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved adoption review digest changed.');
        }
        let rewrite = null;
        let manuscript = draftGeneration.content;
        if (payload.rewriteArtifactId !== null) {
            rewrite = artifacts.find(item => item.id === payload.rewriteArtifactId);
            if (!rewrite || rewrite.kind !== 'rewrite-diff') {
                throw new ApiError(409, 'workflow_v2_lineage_missing',
                    'Approved adoption lost its rewrite artifact.');
            }
            const approvedRewrite = this.workflowV2StepArtifact(
                run, artifacts, 'approve-rewrite', 'rewrite-diff', ['approved', 'applied'],
            );
            if (approvedRewrite.id !== rewrite.id) {
                throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                    'Approved adoption rewrite is not the exact human-approved Diff.');
            }
            this.workflowV2GenerationForArtifact(run, rewrite, 'rewrite');
            const normalizedRewrite = normalizeWorkflowV2ArtifactPayload('rewrite-diff', rewrite.payload, {
                baseText: draftGeneration.content,
            });
            manuscript = workflowV2FinalText(draftGeneration.content, normalizedRewrite);
            normalizeWorkflowV2ArtifactPayload('rewrite-diff', normalizedRewrite, {
                baseText: draftGeneration.content,
                resultText: manuscript,
            });
        }
        if (payload.manuscriptArtifactId !== (rewrite?.id ?? draft.id)
            || payload.manuscriptDigest !== workflowContractDigest(manuscript)
            || payload.manuscriptGenerationId !== (rewrite?.payload.generationId ?? draftGeneration.id)) {
            throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                'Approved adoption final manuscript lineage changed.');
        }
        const lineage = this.workflowV2Lineage(run, { ...direction, payload: normalizedDirection }, payload);
        const reviewText = workflowV2ReviewText(normalizedReview);
        const notes = workflowV2Notes(lineage);
        let { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        const baseProjectVersion = adoption.base.projectVersion;
        const baseChapterRevision = adoption.base.chapterRevision;
        let history = (chapter.generationHistory ?? [])
            .find(item => item.generationId === payload.manuscriptGenerationId) ?? null;
        const atBase = project.version === baseProjectVersion && chapter.revision === baseChapterRevision;
        if (atBase && (payload.authorityFingerprint.projectDigest !== hashWorkflowValue(project)
            || payload.authorityFingerprint.chapterDigest !== hashWorkflowValue(chapter))) {
            throw new ApiError(409, 'workflow_authority_changed',
                'Workflow V2 adoption base no longer matches its authority fingerprint.');
        }
        if (!history && !atBase) {
            throw new ApiError(409, 'workflow_authority_changed',
                'Workflow V2 adoption authority changed before the atomic commit.');
        }
        if (history && (history.previousRevision !== baseChapterRevision
            || history.resultingRevision !== baseChapterRevision + 1
            || project.version !== baseProjectVersion + 1
            || chapter.revision !== baseChapterRevision + 1
            || !workflowV2AdoptionMatches(project, chapter, payload, manuscript, reviewText, notes))) {
            throw new ApiError(409, 'workflow_authority_changed',
                'Existing Workflow V2 adoption no longer matches its approved artifact.');
        }
        if (!history) {
            const validated = validateStoryStateChangeSet(
                project.storyState,
                payload.storyStateChanges,
                project.chapters.map(item => item.id),
            );
            if (workflowContractDigest(validated.next) !== payload.targetStoryStateDigest) {
                throw new ApiError(409, 'workflow_v2_lineage_mismatch',
                    'Approved adoption Story State target changed.');
            }
            const result = this.storyStore.adoptGeneration(
                run.projectId,
                run.chapterId,
                baseProjectVersion,
                baseChapterRevision,
                {
                    generationId: payload.manuscriptGenerationId,
                    kind: 'workflow-v2',
                    content: { mode: 'replace', text: manuscript },
                    chapterSummary: payload.chapterSummary,
                    chapterCard: payload.chapterCard,
                    storyStateChanges: payload.storyStateChanges,
                    review: reviewText,
                    notes,
                    status: 'done',
                },
                { beforeCommit: this.beforeWorkflowCommit() },
            );
            project = result.project;
            chapter = result.chapter;
            history = (chapter.generationHistory ?? [])
                .find(item => item.generationId === payload.manuscriptGenerationId) ?? null;
        }
        if (!history || history.previousRevision !== baseChapterRevision
            || history.resultingRevision !== baseChapterRevision + 1
            || project.version !== baseProjectVersion + 1
            || chapter.revision !== baseChapterRevision + 1
            || !workflowV2AdoptionMatches(project, chapter, payload, manuscript, reviewText, notes)) {
            throw new ApiError(500, 'workflow_application_mismatch',
                'Atomic Workflow V2 adoption did not match its approved artifact.');
        }
        try {
            this.generationService.generationStore.markAdopted(
                run.projectId, run.chapterId, payload.manuscriptGenerationId,
            );
        } catch (error) {
            console.warn(`Could not mark Workflow V2 generation ${payload.manuscriptGenerationId} adopted:`,
                error.message);
        }
        const digest = workflowV2AdoptionDigest(project, chapter);
        const lineageArtifacts = [direction, plan, draft, review, rewrite, adoption].filter(Boolean);
        for (const source of lineageArtifacts) {
            const current = this.workflowStore.getArtifact(run.projectId, run.id, source.id);
            const applied = this.applyArtifact(current, authorityView(project, chapter), digest);
            if (applied.id === adoption.id) adoption = applied;
        }
        const committed = this.completeStep(run, command, [adoption.id], {
            artifactId: adoption.id,
            authority: authorityView(project, chapter),
            lineageDigest: lineage.lineageDigest,
        });
        return { committed, artifact: adoption };
    }

    async executeDiagnosis(run, artifacts, command) {
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const diagnosis = this.diagnosis(run.projectId, run.chapterId, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            retrieval: command.payload.retrieval ?? {},
        });
        let artifact = this.ensureArtifact({
            artifactId: `diagnosis-${diagnosis.diagnosisDigest.slice(0, 48)}`,
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'diagnosis',
            source: 'system',
            target: target('workflow-run', run.chapterId),
            base: base(project, chapter),
            payload: diagnosis,
            evidenceIds: diagnosis.evidenceCatalog.slice(0, 512).map(item => item.evidenceId),
        });
        artifact = this.approveArtifact(artifact);
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            diagnosisDigest: diagnosis.diagnosisDigest,
        });
        return { committed, artifact };
    }

    diagnosisArtifact(artifacts) {
        const artifact = artifacts.find(item => item.stepId === 'diagnose' && item.kind === 'diagnosis');
        if (!artifact) throw new ApiError(409, 'workflow_diagnosis_required', 'Workflow diagnosis is missing.');
        return artifact;
    }

    async executeCardProposal(run, artifacts, command) {
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const diagnosisArtifact = this.diagnosisArtifact(artifacts);
        let copilotArtifact;
        let noOp = false;
        try {
            copilotArtifact = createSuggestedChapterCardCandidate({
                project,
                chapter,
                diagnosis: diagnosisArtifact.payload,
            });
        } catch (error) {
            if (error?.code !== 'no_missing_card_fields') throw error;
            noOp = true;
            copilotArtifact = {
                artifactId: `artifact_${hashWorkflowValue({
                    chapterId: chapter.id,
                    card: chapter.card,
                    diagnosisDigest: diagnosisArtifact.payload.diagnosisDigest,
                }).slice(0, 40)}`,
                kind: 'chapter-card',
                status: 'candidate',
                target: {
                    type: 'chapter-card',
                    projectId: project.id,
                    chapterId: chapter.id,
                    projectVersion: project.version,
                    chapterRevision: chapter.revision,
                },
                patch: {},
                evidenceIds: diagnosisArtifact.evidenceIds.slice(0, 1),
                diagnosisDigest: diagnosisArtifact.payload.diagnosisDigest,
            };
        }
        const nextCard = { ...chapter.card, ...copilotArtifact.patch };
        let artifact = this.ensureArtifact({
            artifactId: copilotArtifact.artifactId,
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'chapter-card',
            source: 'system',
            target: target('chapter-card', run.chapterId),
            base: base(project, chapter),
            payload: {
                copilotArtifact,
                patch: copilotArtifact.patch,
                noOp,
                baseCardDigest: hashWorkflowValue(chapter.card),
                targetCardDigest: hashWorkflowValue(nextCard),
                authorityFingerprint: createAuthorityRecoveryFingerprint(project, chapter, 'chapter-card'),
            },
            evidenceIds: copilotArtifact.evidenceIds,
        });
        const committed = this.completeStep(run, command, [artifact.id], { artifactId: artifact.id });
        return { committed, artifact };
    }

    async executeApproval(run, artifacts, command, kind) {
        let artifact = this.requireArtifact(run, artifacts, command.payload, kind, ['candidate', 'approved']);
        artifact = this.approveArtifact(artifact);
        const committed = this.completeStep(run, command, [artifact.id], { artifactId: artifact.id });
        return { committed, artifact };
    }

    async executeCardApply(run, artifacts, command) {
        let artifact = this.requireArtifact(run, artifacts, command.payload, 'chapter-card', ['approved', 'applied']);
        let { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        const patch = artifact.payload.noOp
            ? {}
            : validateChapterCardPatch(artifact.payload.patch, this.diagnosisArtifact(artifacts).payload);
        const targetDigest = artifact.payload.targetCardDigest;
        if (artifact.status !== 'applied') {
            const atBase = matchesBaseAuthority(
                project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'chapter-card',
            );
            if (atBase) {
                if (hashWorkflowValue(chapter.card) !== artifact.payload.baseCardDigest) {
                    throw new ApiError(409, 'workflow_authority_changed', 'Chapter card changed before workflow application.');
                }
                if (!artifact.payload.noOp) {
                    const result = this.storyStore.updateChapter(
                        run.projectId,
                        run.chapterId,
                        project.version,
                        chapter.revision,
                        { card: patch },
                        { beforeCommit: this.beforeWorkflowCommit() },
                    );
                    project = result.project;
                    chapter = result.chapter;
                }
            } else if (artifact.payload.noOp
                || !matchesRecoverableAuthority(
                    project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'chapter-card',
                )
                || hashWorkflowValue(chapter.card) !== targetDigest) {
                throw new ApiError(409, 'workflow_authority_changed', 'Chapter card application cannot be recovered.');
            }
            if (hashWorkflowValue(chapter.card) !== targetDigest) {
                throw new ApiError(500, 'workflow_application_mismatch', 'Applied chapter card does not match its candidate.');
            }
            artifact = this.applyArtifact(artifact, authorityView(project, chapter), targetDigest);
        } else if (!matchesAppliedAuthority(project, chapter, artifact.target)
            || hashWorkflowValue(chapter.card) !== artifact.target.digest) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied chapter card was changed outside the workflow.');
        }
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            authority: authorityView(project, chapter),
        });
        return { committed, artifact };
    }

    generationRequest(project, chapter, kind, payload) {
        return {
            kind,
            mode: 'generate',
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            ...(payload.instruction !== undefined ? { instruction: payload.instruction } : {}),
            ...(payload.contextOverrides !== undefined ? { contextOverrides: payload.contextOverrides } : {}),
            ...(payload.retrieval !== undefined ? { retrieval: payload.retrieval } : {}),
        };
    }

    generationIntent(run, command, kind, slotExtension = {}) {
        const slot = {
            projectId: run.projectId,
            chapterId: run.chapterId,
            runId: run.id,
            stepId: run.currentStepId,
            runRevision: command.runRevision,
            ...slotExtension,
            kind,
        };
        return {
            slot,
            slotDigest: hashWorkflowValue(slot),
            commandDigest: hashWorkflowValue({ type: command.type, payload: command.payload }),
            commandId: command.commandId,
        };
    }

    async executeGeneration(run, artifacts, command, kind, signal) {
        const intent = this.generationIntent(run, command, kind);
        const active = this.generationStepInflight.get(intent.slotDigest);
        if (active) {
            if (active.commandDigest !== intent.commandDigest) {
                throw new ApiError(409, 'workflow_generation_conflict',
                    'Workflow generation slot is already bound to another command.');
            }
            if (active.commandId !== command.commandId) {
                throw new ApiError(409, 'workflow_generation_in_progress',
                    'Workflow generation slot is already running under another command id.');
            }
            return active.promise;
        }
        const promise = this.executeGenerationOnce(run, artifacts, command, kind, intent, signal);
        this.generationStepInflight.set(intent.slotDigest, {
            commandDigest: intent.commandDigest,
            commandId: command.commandId,
            promise,
        });
        try {
            return await promise;
        } finally {
            const current = this.generationStepInflight.get(intent.slotDigest);
            if (current?.promise === promise) this.generationStepInflight.delete(intent.slotDigest);
        }
    }

    async executeGenerationOnce(run, artifacts, command, kind, intent = null, signal) {
        throwIfAborted(signal);
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        let generation;
        if (command.type === 'attach-generation') {
            generation = this.generationService.generationStore.getGeneration(
                run.projectId, run.chapterId, cleanId(command.payload.generationId, 'generationId'),
            );
        } else {
            generation = (await this.generationService.streamGeneration(
                run.projectId,
                run.chapterId,
                this.generationRequest(project, chapter, kind, command.payload),
                { workflowIntent: intent ?? this.generationIntent(run, command, kind), signal },
            )).generation;
        }
        throwIfAborted(signal);
        if (!allowedGeneration(generation, kind)
            || generation.request?.projectVersion !== project.version
            || generation.request?.chapterRevision !== chapter.revision) {
            throw new ApiError(409, 'workflow_generation_invalid', 'Generation does not match the workflow authority snapshot.');
        }
        const artifactKind = kind === 'draft' ? 'chapter-draft' : 'chapter-review';
        let payload;
        let evidenceIds = generationEvidenceIds(generation);
        let artifactTarget;
        if (kind === 'draft') {
            payload = {
                generationId: generation.id,
                contentDigest: hashWorkflowValue(generation.content),
                status: generation.status,
            };
            artifactTarget = 'chapter-content';
        } else {
            const diagnosis = this.diagnosis(run.projectId, run.chapterId, {
                projectVersion: project.version,
                chapterRevision: chapter.revision,
                retrieval: command.payload.retrieval ?? {},
            });
            const diagnosisEvidence = diagnosis.evidenceCatalog.slice(0, 64).map(item => item.evidenceId);
            const reviewCandidate = createReviewCandidate({
                diagnosis,
                patch: { review: generation.content },
                evidenceIds: diagnosisEvidence.length > 0 ? diagnosisEvidence : evidenceIds.slice(0, 1),
            });
            evidenceIds = reviewCandidate.evidenceIds;
            payload = {
                generationId: generation.id,
                reviewCandidate,
                patch: reviewCandidate.patch,
                diagnosis,
                authorityFingerprint: createAuthorityRecoveryFingerprint(project, chapter, 'chapter-review'),
                targetReviewDigest: hashWorkflowValue({
                    review: reviewCandidate.patch.review,
                    notes: reviewCandidate.patch.notes ?? chapter.notes,
                }),
            };
            artifactTarget = 'chapter-quality';
        }
        const artifact = this.ensureArtifact({
            artifactId: deterministicArtifactId(artifactKind, { generationId: generation.id, payload }),
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: artifactKind,
            source: 'model',
            target: target(artifactTarget, run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds,
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId: generation.id,
        });
        return { committed, artifact };
    }

    async executeDistillation(run, artifacts, command, signal) {
        const draftArtifact = artifacts.find(item => item.stepId === 'draft' && item.kind === 'chapter-draft');
        if (!draftArtifact) throw new ApiError(409, 'workflow_draft_required', 'Draft artifact is missing.');
        const generationId = draftArtifact.payload.generationId;
        const intent = this.generationIntent(run, command, 'distill', { generationId });
        const active = this.generationStepInflight.get(intent.slotDigest);
        if (active) {
            if (active.commandDigest !== intent.commandDigest || active.commandId !== command.commandId) {
                throw new ApiError(409, 'workflow_generation_conflict',
                    'Workflow distillation slot is already bound to another command.');
            }
            return active.promise;
        }
        const promise = this.executeDistillationOnce(run, artifacts, command, draftArtifact, intent, signal);
        this.generationStepInflight.set(intent.slotDigest, {
            commandDigest: intent.commandDigest,
            commandId: command.commandId,
            promise,
        });
        try {
            return await promise;
        } finally {
            const current = this.generationStepInflight.get(intent.slotDigest);
            if (current?.promise === promise) this.generationStepInflight.delete(intent.slotDigest);
        }
    }

    async executeDistillationOnce(run, artifacts, command, draftArtifact, intent, signal) {
        throwIfAborted(signal);
        const { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        this.assertRunAuthority(run, artifacts, project, chapter);
        const generationId = draftArtifact.payload.generationId;
        const result = await this.generationService.distillGeneration(run.projectId, run.chapterId, generationId, {
            projectVersion: project.version,
            chapterRevision: chapter.revision,
            ...(command.payload.instruction !== undefined ? { instruction: command.payload.instruction } : {}),
            ...(command.payload.contextOverrides !== undefined
                ? { contextOverrides: command.payload.contextOverrides }
                : {}),
        }, { workflowIntent: intent, signal });
        throwIfAborted(signal);
        const generation = result.generation;
        const changes = result.changes;
        const validated = validateStoryStateChangeSet(
            project.storyState,
            changes.storyStateChanges,
            project.chapters.map(item => item.id),
        );
        const payload = {
            generationId,
            draftArtifactId: draftArtifact.id,
            chapterSummary: changes.chapterSummary,
            storyStateChanges: validated.changes,
            targetStoryStateDigest: hashWorkflowValue(validated.next),
            changesDigest: hashWorkflowValue({
                chapterSummary: changes.chapterSummary,
                storyStateChanges: validated.changes,
            }),
        };
        const artifact = this.ensureArtifact({
            artifactId: deterministicArtifactId('state-change-set', payload),
            projectId: run.projectId,
            runId: run.id,
            stepId: run.currentStepId,
            kind: 'state-change-set',
            source: 'model',
            target: target('story-state', run.chapterId),
            base: base(project, chapter),
            payload,
            evidenceIds: generationEvidenceIds(generation),
        });
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            generationId,
        });
        return { committed, artifact };
    }

    async executeAdoption(run, artifacts, command) {
        let artifact = this.requireArtifact(run, artifacts, command.payload, 'state-change-set', ['approved', 'applied']);
        let draftArtifact = artifacts.find(item => item.id === artifact.payload.draftArtifactId);
        if (!draftArtifact || draftArtifact.kind !== 'chapter-draft') {
            throw new ApiError(409, 'workflow_draft_required', 'State candidate lost its draft source.');
        }
        let { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        const baseProjectVersion = artifact.base.projectVersion;
        const baseChapterRevision = artifact.base.chapterRevision;
        let historyEntry = (chapter.generationHistory ?? [])
            .find(item => item.generationId === artifact.payload.generationId) ?? null;
        const atBase = project.version === baseProjectVersion && chapter.revision === baseChapterRevision;
        if (!historyEntry && !atBase) {
            throw new ApiError(409, 'workflow_authority_changed', 'Adoption authority changed before workflow application.');
        }
        if (!historyEntry && (artifact.status === 'applied' || draftArtifact.status === 'applied')) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied adoption is absent from chapter history.');
        }
        if (historyEntry && (historyEntry.previousRevision !== baseChapterRevision
            || historyEntry.resultingRevision !== baseChapterRevision + 1
            || project.version !== baseProjectVersion + 1
            || chapter.revision !== baseChapterRevision + 1
            || !adoptionTargetMatches(project, chapter, artifact, draftArtifact))) {
            throw new ApiError(409, 'workflow_authority_changed', 'Existing adoption no longer matches the workflow candidate.');
        }
        const result = this.generationService.adoptGeneration(
            run.projectId,
            run.chapterId,
            artifact.payload.generationId,
            {
                projectVersion: baseProjectVersion,
                chapterRevision: baseChapterRevision,
                includeContent: true,
                contentMode: 'replace',
                chapterSummary: artifact.payload.chapterSummary,
                storyStateChanges: artifact.payload.storyStateChanges,
            },
        );
        project = result.project;
        chapter = result.chapter;
        historyEntry = (chapter.generationHistory ?? [])
            .find(item => item.generationId === artifact.payload.generationId) ?? null;
        if (!historyEntry
            || historyEntry.previousRevision !== baseChapterRevision
            || historyEntry.resultingRevision !== baseChapterRevision + 1
            || project.version !== baseProjectVersion + 1
            || chapter.revision !== baseChapterRevision + 1
            || !adoptionTargetMatches(project, chapter, artifact, draftArtifact)) {
            throw new ApiError(409, 'workflow_authority_changed', 'Adoption result does not match the workflow candidate.');
        }
        const digest = adoptionDigest(project, chapter);
        if (artifact.status !== 'applied') {
            artifact = this.applyArtifact(artifact, authorityView(project, chapter), digest);
        } else if (!matchesAppliedAuthority(project, chapter, artifact.target)
            || artifact.target.digest !== digest) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied state artifact no longer matches the adoption.');
        }
        if (draftArtifact.status !== 'applied') {
            draftArtifact = this.applyArtifact(draftArtifact, authorityView(project, chapter), digest);
        } else if (!matchesAppliedAuthority(project, chapter, draftArtifact.target)
            || draftArtifact.target.digest !== digest) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied draft artifact no longer matches the adoption.');
        }
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            authority: authorityView(project, chapter),
        });
        return { committed, artifact };
    }

    async executeReviewApply(run, artifacts, command) {
        let artifact = this.requireArtifact(run, artifacts, command.payload, 'chapter-review', ['candidate', 'approved', 'applied']);
        let { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        const patch = validateReviewPatch(artifact.payload.patch);
        const targetDigest = artifact.payload.targetReviewDigest;
        if (artifact.status !== 'applied') {
            artifact = this.approveArtifact(artifact);
            if (matchesBaseAuthority(
                project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'chapter-review',
            )) {
                const result = this.storyStore.updateChapter(
                    run.projectId,
                    run.chapterId,
                    project.version,
                    chapter.revision,
                    patch,
                    { beforeCommit: this.beforeWorkflowCommit() },
                );
                project = result.project;
                chapter = result.chapter;
            } else if (!matchesRecoverableAuthority(
                project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'chapter-review',
            ) || hashWorkflowValue({ review: chapter.review, notes: chapter.notes }) !== targetDigest) {
                throw new ApiError(409, 'workflow_authority_changed', 'Review application cannot be recovered.');
            }
            if (hashWorkflowValue({ review: chapter.review, notes: chapter.notes }) !== targetDigest) {
                throw new ApiError(500, 'workflow_application_mismatch', 'Applied review does not match its candidate.');
            }
            artifact = this.applyArtifact(artifact, authorityView(project, chapter), targetDigest);
        } else if (!matchesAppliedAuthority(project, chapter, artifact.target)
            || hashWorkflowValue({ review: chapter.review, notes: chapter.notes }) !== artifact.target.digest) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied review was changed outside the workflow.');
        }
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            authority: authorityView(project, chapter),
        });
        return { committed, artifact };
    }

    async executeCloseout(run, artifacts, command) {
        let { project, chapter } = this.loadAuthority(run.projectId, run.chapterId);
        if (!chapter.content.trim() || !chapter.review.trim()) {
            throw new ApiError(409, 'workflow_closeout_blocked', 'Chapter content and review are required before closeout.');
        }
        let artifact = artifacts.find(item => item.stepId === 'closeout' && item.kind === 'closeout') ?? null;
        if (!artifact) {
            this.assertRunAuthority(run, artifacts, project, chapter);
            const closeoutPayload = {
                fromStatus: chapter.status,
                toStatus: 'done',
                contentDigest: hashWorkflowValue(chapter.content),
                reviewDigest: hashWorkflowValue(chapter.review),
                cardDigest: hashWorkflowValue(chapter.card),
                authorityFingerprint: createAuthorityRecoveryFingerprint(project, chapter, 'closeout'),
            };
            artifact = this.ensureArtifact({
                artifactId: deterministicArtifactId('closeout', { runId: run.id, closeoutPayload }),
                projectId: run.projectId,
                runId: run.id,
                stepId: run.currentStepId,
                kind: 'closeout',
                source: 'system',
                target: target(APPLIED_STEP_TARGETS.closeout, run.chapterId),
                base: base(project, chapter),
                payload: closeoutPayload,
                evidenceIds: [
                    `content-${closeoutPayload.contentDigest.slice(0, 48)}`,
                    `review-${closeoutPayload.reviewDigest.slice(0, 48)}`,
                ],
            });
        }
        const evidenceStillMatches = artifact.payload.contentDigest === hashWorkflowValue(chapter.content)
            && artifact.payload.reviewDigest === hashWorkflowValue(chapter.review)
            && artifact.payload.cardDigest === hashWorkflowValue(chapter.card);
        if (!evidenceStillMatches) {
            throw new ApiError(409, 'workflow_authority_changed', 'Chapter changed after closeout evidence was captured.');
        }
        if (artifact.status !== 'applied') {
            artifact = this.approveArtifact(artifact);
            if (matchesBaseAuthority(
                project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'closeout',
            )) {
                if (chapter.status !== 'done') {
                    const result = this.storyStore.updateChapter(
                        run.projectId,
                        run.chapterId,
                        project.version,
                        chapter.revision,
                        { status: 'done' },
                        { beforeCommit: this.beforeWorkflowCommit() },
                    );
                    project = result.project;
                    chapter = result.chapter;
                }
            } else if (!matchesRecoverableAuthority(
                project, chapter, artifact.base, artifact.payload.authorityFingerprint, 'closeout',
            ) || chapter.status !== 'done') {
                throw new ApiError(409, 'workflow_authority_changed', 'Chapter closeout cannot be recovered.');
            }
        }
        const digest = hashWorkflowValue({
            status: chapter.status,
            content: chapter.content,
            review: chapter.review,
            card: chapter.card,
        });
        if (chapter.status !== 'done') {
            throw new ApiError(500, 'workflow_application_mismatch', 'Chapter closeout did not reach done status.');
        }
        if (artifact.status !== 'applied') {
            artifact = this.applyArtifact(artifact, authorityView(project, chapter), digest);
        } else if (!matchesAppliedAuthority(project, chapter, artifact.target)
            || artifact.target.digest !== digest) {
            throw new ApiError(409, 'workflow_authority_changed', 'Applied closeout no longer matches the chapter.');
        }
        const committed = this.completeStep(run, command, [artifact.id], {
            artifactId: artifact.id,
            authority: authorityView(project, chapter),
        });
        return { committed, artifact };
    }
}
