import {
    compareAndRemoveWorkspaceRecoveryDraft,
    combineFieldPaths,
    continuityView,
    buildGenerationRequest,
    countContentUnits,
    isWorkspaceRecoveryDraftIdentity,
    mergeDirtyPaths,
    mergeProjectDirtyPaths,
    normalizeWorkspaceRecoveryDraft,
    parseStructuredResponse,
    pendingChangeSetDraftStorageKey,
    pendingChangeSetNavigationPolicy,
    safeFileName,
    scanWorkspaceRecoveryDrafts,
    selectWorkspaceRecoveryDraft,
    validatePendingChangeSetValue,
    workspaceRecoveryDraftAlreadyApplied,
    workspaceRecoveryDraftCleanupDecision,
    workspaceRecoveryDraftRestorePolicy,
    workspaceRecoveryDraftStorageKey,
    workspaceRecoveryWriterCollisionAction,
    workspaceAuthorityMutationAllowsView,
} from './core.js';
import {
    authorityResponseTokenIsStale,
    beginSaveBatch,
    buildProjectChanges,
    buildRecordChanges,
    classifyConflictPaths,
    mergeChapterAuthoritySnapshot,
    mergeProjectAuthoritySnapshot,
    optimisticTokenFor,
    rollbackSaveBatch,
} from './save-state.js';
import {
    buildVolumeTree,
    isChapterPlanStale,
    moveChapterProjection,
    moveChapterToVolumeProjection,
    moveVolumeProjection,
    volumeForChapter,
} from './volume-ui.js';
import {
    buildCompatibilityReport,
    buildResourceCompatibilityReport,
    buildProfileChanges,
    assembleProfilePreview,
    createProfileEditorDraft,
    isPromptProfileV2,
    profileDraftFingerprint,
    profileTaskNames,
    projectPromptProfileDiagnostics,
} from './prompt-profile-ui.js';
import {
    dashboardNavigationTarget,
    dashboardViewMode,
    normalizeWorkspaceResumeState,
} from './dashboard-ui.js';
import {
    copilotDefaultBinding,
    copilotHandoffEligibility,
    copilotSessionAuthorityStale,
} from './copilot-ui.js';

const API_ROOT = '/api/story-studio';
const AUTOSAVE_DELAY = 700;
const WORKSPACE_RESUME_STORAGE_KEY = 'story-studio.workspace-resume.v1';
const WORKSPACE_RECOVERY_WRITER_STORAGE_KEY = 'story-studio.workspace-recovery-writer.v1';
const WORKSPACE_RECOVERY_WRITER_CHANNEL_NAME = 'story-studio.workspace-recovery-writer.channel.v1';
const WORKSPACE_RECOVERY_WRITER_SIGNAL_KEY = 'story-studio.workspace-recovery-writer.signal.v1';
const WORKSPACE_RECOVERY_WRITER_SETTLE_MS = 80;
const MAX_CONFLICT_RETRIES = 3;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
let workspaceRecoveryWriterChannel = null;
let workspaceRecoveryWriterId = loadWorkspaceRecoveryWriterId();
const workspaceRecoveryWriterInstanceId = createWorkspaceRecoveryIdentity();
const workspaceRecoveryWriterStartedAt = Date.now();
let workspaceRecoveryWriterEstablished = false;
const workspaceRecoveryWriterLeaseReady = initializeWorkspaceRecoveryWriterLease();

const CARD_FIELDS = [
    'summary',
    'goal',
    'conflict',
    'turn',
    'hook',
    'pov',
    'time',
    'location',
    'required',
    'avoid',
];

const STATUS_LABELS = {
    planned: '待写',
    drafting: '初稿',
    revising: '修订',
    done: '定稿',
};

const CATEGORY_LABELS = {
    character: '角色',
    setting: '设定',
    timeline: '时间线',
    foreshadowing: '伏笔',
    item: '物品',
    relationship: '关系',
};

const CONTINUITY_STATUS_LABELS = {
    active: '生效中',
    resolved: '已收束',
    contradiction: '有冲突',
};

const AI_LABELS = {
    plan: '章纲候选',
    draft: '正文候选',
    review: '审校候选',
    continuity: '连续性候选',
    polish: '润色候选',
    rewrite: '重写候选',
    expand: '扩写候选',
    brainstorm: '构思候选',
};

const SELECTION_AI_KINDS = new Set(['polish', 'rewrite', 'expand', 'brainstorm']);

const GENERATION_MODE_LABELS = {
    generate: '新生成',
    regenerate: '重新生成',
    continue: '继续生成',
};

const GENERATION_STATUS_LABELS = {
    streaming: '生成中',
    completed: '已完成',
    partial: '半稿',
    failed: '失败',
    adopted: '已采纳',
};

const VERSION_SOURCE_LABELS = {
    current: '当前版本',
    manual: '手动保存',
    adopt: '采纳候选',
    restore: '版本恢复',
    workflow: '流程应用',
};

const WORKFLOW_RUN_STATUS_LABELS = {
    running: '运行中',
    waiting_approval: '待审批',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
};

const WORKFLOW_STEP_STATUS_LABELS = {
    pending: '等待',
    ready: '就绪',
    running: '执行中',
    candidate_ready: '候选就绪',
    waiting_approval: '待审批',
    completed: '已完成',
    skipped: '已跳过',
    failed: '失败',
    cancelled: '已取消',
};

const WORKFLOW_ACTOR_LABELS = {
    system: '系统',
    model: '模型',
    user: '用户',
};

const WORKFLOW_ARTIFACT_LABELS = {
    diagnosis: '策划诊断',
    'chapter-card': '章卡',
    'chapter-draft': '正文',
    'state-change-set': '连续性变更',
    'chapter-review': '质量审查',
    'review-changes': '审查修订',
    'brainstorm-direction': '创作方向',
    'chapter-plan': '事件链与章卡',
    'rewrite-diff': '定向修复',
    'chapter-adoption': '最终采纳包',
    closeout: '章节收尾',
};

const DEFAULT_WORKFLOW_DEFINITION_ID = 'builtin.chapter-cycle.v2';
const BUILTIN_COPILOT_PROFILE_ID = 'builtin.planning-copilot.v1';

const COPILOT_SESSION_STATUS_LABELS = {
    draft: '待生成',
    generating: '生成中',
    ready: '候选就绪',
    failed: '失败',
    cancelled: '已取消',
};

const COPILOT_SOURCE_LABELS = {
    project: '作品',
    'project-story': '作品设定',
    volume: '卷',
    'chapter-card': '章卡',
    chapter: '正文',
    'story-state-entity': '人物',
    lorebook: '世界书',
    'lorebook-entry': '世界书条目',
};

const QUALITY_TASK_LABELS = {
    brainstorm: '构思',
    plan: '事件链',
    draft: '正文',
    review: '审查',
    rewrite: '定向修复',
    continuity: '连续性',
    copilot: '策划',
};

const QUALITY_SEVERITY_LABELS = {
    blocker: '阻断',
    major: '主要',
    minor: '次要',
};

const QUALITY_GATE_LABELS = {
    casePassRate: '固定用例通过率',
    profileCompileRate: 'Profile 编译通过率',
    blockersPerThousandUnits: '每千字阻断问题',
    majorsPerThousandUnits: '每千字主要问题',
};

const CHANGESET_LABELS = {
    entities: '实体',
    relations: '关系',
    events: '事件',
    promises: '待兑现',
    memory: '记忆',
    facts: '事实',
    knowledge: '人物知识',
    timeline: '时间线',
};

const CONTINUITY_VIEW_LABELS = {
    facts: '事实',
    knowledge: '人物知识',
    timeline: '时间线',
    relations: '关系',
    promises: '伏笔',
    events: '幕后事件',
};

const KNOWLEDGE_STANCE_LABELS = {
    knows: '知晓',
    suspects: '怀疑',
    believes: '相信',
    denies: '否认',
    hides: '隐瞒',
};

const RESOURCE_TYPE_LABELS = {
    character: '角色卡',
    lorebook: '世界书',
    'prompt-profile': 'Prompt Profile',
};

const RESOURCE_GROUPS = [
    { type: 'character', label: '角色卡' },
    { type: 'lorebook', label: '世界书' },
    { type: 'prompt-profile', label: 'Prompt Profile' },
];

const CONTEXT_OVERRIDE_FIELDS = [
    'includeEntityIds',
    'excludeEntityIds',
    'includePromiseIds',
    'excludePromiseIds',
];
const MAX_CONTEXT_OVERRIDE_IDS = 500;
const MAX_RETRIEVAL_OVERRIDE_IDS = 200;
const LORE_SKIP_LABELS = {
    disabled: '已禁用',
    empty_content: '内容为空',
    no_primary_key: '无主关键词',
    primary_miss: '关键词未命中',
    secondary_miss: '次关键词未命中',
    budget: '预算不足',
};

const CONTEXT_REASON_LABELS = {
    'chapter-volume-id': '按所属卷匹配',
};

function emptyContextOverrides() {
    return Object.fromEntries(CONTEXT_OVERRIDE_FIELDS.map(field => [field, []]));
}

function emptyRetrievalOverrides() {
    return { include: [], exclude: [] };
}

const PROVIDER_PLACEHOLDERS = {
    'openai-chat': 'http://127.0.0.1:1234/v1',
    'anthropic-messages': 'https://api.anthropic.com/v1',
    'google-generate-content': 'https://generativelanguage.googleapis.com/v1beta',
    'openai-completions': 'http://127.0.0.1:1234/v1',
    'ollama-generate': 'http://127.0.0.1:11434',
    'llamacpp-completion': 'http://127.0.0.1:8080',
};

const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
});

const state = {
    initialized: false,
    csrfToken: '',
    bootstrapFailed: false,
    provider: null,
    projects: [],
    project: null,
    chapter: null,
    view: 'write',
    dashboardProjectId: '',
    dashboard: null,
    dashboardLoading: false,
    dashboardError: '',
    dashboardRequestSerial: 0,
    dashboardNavigationBusy: false,
    dashboardNavigationSerial: 0,
    workspaceResumeHydrating: false,
    inspector: 'card',
    aiKind: 'plan',
    drawer: null,
    projectDirty: false,
    chapterDirty: false,
    volumeDirty: false,
    candidateEditSerial: 0,
    projectDirtyPaths: new Set(),
    chapterDirtyPaths: new Set(),
    volumeDirtyFields: new Set(),
    volumeDirtyId: '',
    projectSavingPaths: new Set(),
    chapterSavingPaths: new Set(),
    volumeSavingFields: new Set(),
    volumeSavingId: '',
    projectBase: null,
    chapterBase: null,
    volumeBase: null,
    selectedVolumeId: '',
    collapsedVolumeIds: new Set(),
    generating: false,
    saveInFlight: false,
    mutationInFlight: 0,
    navigationBusy: false,
    authorityMutation: null,
    authorityMutationSerial: 0,
    structureBusy: false,
    navigationEpoch: 0,
    generations: [],
    selectedGenerationId: '',
    activeGeneration: null,
    generationDiagnostics: null,
    generationPreview: null,
    contextOverrides: emptyContextOverrides(),
    retrievalOverrides: emptyRetrievalOverrides(),
    selectionBaseline: null,
    generationController: null,
    generationRequestSerial: 0,
    contextPreviewController: null,
    contextPreviewRequestSerial: 0,
    distilling: false,
    adopting: false,
    resources: [],
    selectedResource: null,
    resourceBusy: false,
    resourceRequestSerial: 0,
    profileEditor: null,
    profileEditorBaseline: '',
    profileEditorDirty: false,
    profileEditorTab: 'overview',
    profileCompileResult: null,
    profileCompileError: '',
    profileConflictMessage: '',
    continuityView: 'facts',
    continuityRecordId: '',
    pendingChangeSetDraft: '',
    pendingChangeSetSaved: '',
    pendingChangeSetDirty: false,
    pendingChangeSetError: '',
    pendingChangeSetAdopting: false,
    pendingChangeSetProjectId: '',
    pendingChangeSetChapterId: '',
    versions: [],
    versionsChapterId: '',
    versionsChapterRevision: null,
    versionUnitCounts: new Map(),
    selectedVersionId: '',
    selectedVersion: null,
    versionsLoading: false,
    versionDetailLoading: false,
    versionRestoring: false,
    versionRequestSerial: 0,
    versionsError: '',
    workflowDefinitions: [],
    workflowRuns: [],
    workflowRun: null,
    workflowArtifacts: [],
    workflowAuthority: null,
    workflowCommand: null,
    workflowProjectId: '',
    workflowChapterId: '',
    workflowDefinitionId: '',
    workflowRunId: '',
    workflowArtifactId: '',
    workflowLoading: false,
    workflowBusy: false,
    workflowCancelling: false,
    workflowCommandController: null,
    workflowError: '',
    workflowRetry: null,
    workflowRequestSerial: 0,
    copilotProjectId: '',
    copilotChapterId: '',
    copilotResources: [],
    copilotProfiles: [],
    copilotSettings: null,
    copilotSettingsMode: 'inherit',
    copilotSettingsModel: '',
    copilotSelection: {
        volumeIds: new Set(),
        chapterIds: new Set(),
        entityIds: new Set(),
        lorebookIds: new Set(),
    },
    copilotSelectionCustomized: false,
    copilotAnchorChapterId: '',
    copilotPreview: null,
    copilotContextEpoch: 0,
    copilotSelectedEvidenceIds: new Set(),
    copilotRetrievalQuery: '',
    copilotRetrievalLimit: 20,
    copilotProfileValue: `builtin:${BUILTIN_COPILOT_PROFILE_ID}`,
    copilotInstruction: '',
    copilotOptionCount: 3,
    copilotSessions: [],
    copilotSession: null,
    copilotSessionId: '',
    copilotLoading: false,
    copilotPreviewing: false,
    copilotBusy: false,
    copilotGenerating: false,
    copilotCancelling: false,
    copilotHandoffOptionId: '',
    copilotHandoffSerial: 0,
    copilotGenerationController: null,
    copilotStream: '',
    copilotError: '',
    copilotRetry: null,
    copilotRequestSerial: 0,
    qualityProjectId: '',
    qualityChapterId: '',
    qualityBuiltinRevision: null,
    qualityProfiles: [],
    qualityOverlays: [],
    qualityProfileId: '',
    qualityProfileDetail: null,
    qualityOverlayId: 'none',
    qualityPreview: null,
    qualityReports: [],
    qualityReportCorrupt: [],
    qualityReport: null,
    qualityReportId: '',
    qualitySuite: null,
    qualityBaseline: null,
    qualityRuns: [],
    qualityRunCorrupt: [],
    qualityRun: null,
    qualityRunId: '',
    qualityComparison: null,
    qualityLoading: false,
    qualityBusy: false,
    qualityError: '',
    qualityRetry: null,
    qualityCopyStatus: '',
    qualityRequestSerial: 0,
};

const elements = {};
let autosaveTimer = null;
let saveQueue = Promise.resolve(true);
let toastTimer = null;
let mobileMedia = null;
let providerLastFocus = null;
let providerOpenEpoch = 0;
let recoveryDraftStorageWarningShown = false;
let lifecycleRecoveryFlushSignature = '';
let restoredWorkspaceRecoverySource = null;

class ApiError extends Error {
    constructor(message, status, data = {}) {
        super(message);
        this.name = 'StoryStudioApiError';
        this.status = status;
        this.code = data?.error || '';
        this.data = data;
    }
}

function clone(value) {
    return structuredClone(value);
}

function delay(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function pathForProject(projectId, suffix = '') {
    return `${API_ROOT}/projects/${encodeURIComponent(projectId)}${suffix}`;
}

async function apiRequest(path, options = {}) {
    const hasJsonBody = options.body !== undefined && typeof options.body !== 'string';
    const request = {
        ...options,
        headers: {
            Accept: 'application/json',
            ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
            ...(options.method && options.method !== 'GET' && state.csrfToken
                ? { 'X-CSRF-Token': state.csrfToken }
                : {}),
            ...(options.headers || {}),
        },
    };
    if (hasJsonBody) {
        request.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, request);
    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { message: text };
        }
    }
    if (!response.ok) {
        throw new ApiError(data?.message || `请求失败（${response.status}）`, response.status, data);
    }
    return data;
}

async function apiMutation(path, options) {
    state.mutationInFlight += 1;
    try {
        return await apiRequest(path, options);
    } finally {
        state.mutationInFlight -= 1;
    }
}

function generationPath(projectId, chapterId, suffix = '') {
    return pathForProject(
        projectId,
        `/chapters/${encodeURIComponent(chapterId)}/generations${suffix}`,
    );
}

function chapterPath(projectId, chapterId, suffix = '') {
    return pathForProject(
        projectId,
        `/chapters/${encodeURIComponent(chapterId)}${suffix}`,
    );
}

function workflowRunsPath(projectId, chapterId, runId = '', suffix = '') {
    const runSuffix = runId ? `/${encodeURIComponent(runId)}` : '';
    return chapterPath(projectId, chapterId, `/workflow-runs${runSuffix}${suffix}`);
}

function copilotPath(projectId, suffix = '') {
    return pathForProject(projectId, `/copilot${suffix}`);
}

function dashboardPath(projectId) {
    return pathForProject(projectId, '/dashboard');
}

function readWorkspaceResumeState() {
    try {
        const stored = window.sessionStorage.getItem(WORKSPACE_RESUME_STORAGE_KEY);
        return stored ? normalizeWorkspaceResumeState(JSON.parse(stored)) : null;
    } catch {
        return null;
    }
}

function persistWorkspaceResumeState() {
    try {
        if (state.workspaceResumeHydrating) return;
        if (!state.project?.id) {
            window.sessionStorage.removeItem(WORKSPACE_RESUME_STORAGE_KEY);
            return;
        }
        const resume = normalizeWorkspaceResumeState({
            version: 1,
            projectId: state.project.id,
            chapterId: state.chapter?.id || '',
            view: state.view,
            workflowRunId: state.workflowRunId,
            copilotSessionId: state.copilotSessionId,
            continuityView: state.continuityView,
            continuityRecordId: state.continuityRecordId,
        });
        if (resume) window.sessionStorage.setItem(WORKSPACE_RESUME_STORAGE_KEY, JSON.stringify(resume));
        else window.sessionStorage.removeItem(WORKSPACE_RESUME_STORAGE_KEY);
    } catch {
        // Browser session persistence is best-effort and never authoritative.
    }
}

function restoreWorkspaceResumeState(resume) {
    if (!resume || resume.projectId !== state.project?.id) {
        persistWorkspaceResumeState();
        return false;
    }
    const chapterMatches = !resume.chapterId || resume.chapterId === state.chapter?.id;
    state.continuityView = resume.continuityView;
    state.continuityRecordId = resume.continuityRecordId;
    if (chapterMatches && resume.workflowRunId) {
        bindWorkflowWorkspace(state.project, state.chapter);
        state.workflowRunId = resume.workflowRunId;
    }
    if (resume.view === 'copilot' && resume.copilotSessionId) {
        state.copilotSessionId = resume.copilotSessionId;
    }
    if (resume.view === 'ledger') renderStoryState();
    setView(resume.view);
    if (resume.view === 'ledger' && resume.continuityRecordId) {
        window.requestAnimationFrame(() => {
            if (state.project?.id === resume.projectId
                && state.view === 'ledger'
                && state.continuityView === 'promises') {
                focusContinuityRecord(resume.continuityRecordId, { notify: false });
            }
        });
    }
    return true;
}

function createWorkspaceRecoveryIdentity() {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (isWorkspaceRecoveryDraftIdentity(uuid)) return uuid;
    if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        const randomId = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        if (isWorkspaceRecoveryDraftIdentity(randomId)) return randomId;
    }
    return `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2).padEnd(16, '0')}`;
}

function loadWorkspaceRecoveryWriterId() {
    try {
        const stored = window.sessionStorage.getItem(WORKSPACE_RECOVERY_WRITER_STORAGE_KEY);
        if (isWorkspaceRecoveryDraftIdentity(stored)) return stored;
        const writerId = createWorkspaceRecoveryIdentity();
        window.sessionStorage.setItem(WORKSPACE_RECOVERY_WRITER_STORAGE_KEY, writerId);
        return writerId;
    } catch {
        return createWorkspaceRecoveryIdentity();
    }
}

function persistWorkspaceRecoveryWriterId() {
    try {
        window.sessionStorage.setItem(
            WORKSPACE_RECOVERY_WRITER_STORAGE_KEY,
            workspaceRecoveryWriterId,
        );
    } catch {
        // The in-memory writer identity still isolates this live page.
    }
}

function workspaceRecoveryWriterMessage(type) {
    return {
        type,
        writerId: workspaceRecoveryWriterId,
        instanceId: workspaceRecoveryWriterInstanceId,
        established: workspaceRecoveryWriterEstablished,
        startedAt: workspaceRecoveryWriterStartedAt,
    };
}

function postWorkspaceRecoveryWriterMessage(type) {
    const message = workspaceRecoveryWriterMessage(type);
    if (workspaceRecoveryWriterChannel) {
        workspaceRecoveryWriterChannel.postMessage(message);
        return;
    }
    try {
        window.localStorage.setItem(WORKSPACE_RECOVERY_WRITER_SIGNAL_KEY, JSON.stringify({
            ...message,
            nonce: createWorkspaceRecoveryIdentity(),
        }));
        window.localStorage.removeItem(WORKSPACE_RECOVERY_WRITER_SIGNAL_KEY);
    } catch {
        // Cross-tab collision detection is best-effort when browser messaging is unavailable.
    }
}

function rotateWorkspaceRecoveryWriterId() {
    const previousWriterId = workspaceRecoveryWriterId;
    do {
        workspaceRecoveryWriterId = createWorkspaceRecoveryIdentity();
    } while (workspaceRecoveryWriterId === previousWriterId);
    persistWorkspaceRecoveryWriterId();
    postWorkspaceRecoveryWriterMessage('claim');
    queueMicrotask(() => {
        if (state.projectDirty || state.chapterDirty || state.volumeDirty) {
            persistWorkspaceRecoveryDraft();
        }
    });
}

function handleWorkspaceRecoveryWriterMessage(message) {
    if (!message || !['probe', 'claim'].includes(message.type)) return;
    const action = workspaceRecoveryWriterCollisionAction({
        writerId: workspaceRecoveryWriterId,
        instanceId: workspaceRecoveryWriterInstanceId,
        established: workspaceRecoveryWriterEstablished,
        startedAt: workspaceRecoveryWriterStartedAt,
        remoteWriterId: message.writerId,
        remoteInstanceId: message.instanceId,
        remoteEstablished: message.established,
        remoteStartedAt: message.startedAt,
    });
    if (action === 'rotate') {
        rotateWorkspaceRecoveryWriterId();
    } else if (action === 'keep' && message.type === 'probe') {
        postWorkspaceRecoveryWriterMessage('claim');
    }
}

function initializeWorkspaceRecoveryWriterLease() {
    if (typeof globalThis.BroadcastChannel === 'function') {
        try {
            workspaceRecoveryWriterChannel = new globalThis.BroadcastChannel(
                WORKSPACE_RECOVERY_WRITER_CHANNEL_NAME,
            );
            workspaceRecoveryWriterChannel.addEventListener('message', event => {
                handleWorkspaceRecoveryWriterMessage(event.data);
            });
        } catch {
            workspaceRecoveryWriterChannel = null;
        }
    }
    if (!workspaceRecoveryWriterChannel) {
        window.addEventListener('storage', event => {
            if (event.key !== WORKSPACE_RECOVERY_WRITER_SIGNAL_KEY || !event.newValue) return;
            try {
                handleWorkspaceRecoveryWriterMessage(JSON.parse(event.newValue));
            } catch {
                // Ignore malformed cross-tab coordination messages.
            }
        });
    }
    postWorkspaceRecoveryWriterMessage('probe');
    return new Promise(resolve => {
        window.setTimeout(() => {
            workspaceRecoveryWriterEstablished = true;
            postWorkspaceRecoveryWriterMessage('claim');
            resolve();
        }, WORKSPACE_RECOVERY_WRITER_SETTLE_MS);
    });
}

function currentWorkspaceRecoveryDraft() {
    if (!state.project?.id || !state.chapter?.id) return null;
    const projectDirtyPaths = [...combineFieldPaths(
        state.projectDirtyPaths,
        state.projectSavingPaths,
    )];
    const chapterDirtyPaths = [...combineFieldPaths(
        state.chapterDirtyPaths,
        state.chapterSavingPaths,
    )];
    const volumeDirtyFields = [...combineFieldPaths(
        state.volumeDirtyFields,
        state.volumeSavingFields,
    )];
    if (projectDirtyPaths.length === 0 && chapterDirtyPaths.length === 0 && volumeDirtyFields.length === 0) {
        return null;
    }
    const volumeId = state.volumeDirtyId || state.volumeSavingId;
    const volume = volumeId ? volumeById(state.project, volumeId) : null;
    return normalizeWorkspaceRecoveryDraft({
        version: 1,
        writerId: workspaceRecoveryWriterId,
        draftId: createWorkspaceRecoveryIdentity(),
        projectId: state.project.id,
        projectVersion: state.project.version,
        chapterId: state.chapter.id,
        chapterRevision: state.chapter.revision,
        volumeId: volume?.id || '',
        volumeRevision: volume?.revision ?? null,
        projectDirtyPaths,
        chapterDirtyPaths,
        volumeDirtyFields,
        projectChanges: buildProjectChanges(state.project, projectDirtyPaths),
        chapterChanges: buildRecordChanges(state.chapter, chapterDirtyPaths),
        volumeChanges: volume
            ? Object.fromEntries(volumeDirtyFields.map(field => [field, volume[field]]))
            : {},
        updatedAt: new Date().toISOString(),
    }, {
        projectId: state.project.id,
        chapterId: state.chapter.id,
    });
}

function persistWorkspaceRecoveryDraft() {
    const draft = currentWorkspaceRecoveryDraft();
    if (!draft) return null;
    const storageKey = workspaceRecoveryDraftStorageKey(
        draft.projectId,
        draft.chapterId,
        workspaceRecoveryWriterId,
    );
    const raw = JSON.stringify(draft);
    try {
        window.localStorage.setItem(storageKey, raw);
        recoveryDraftStorageWarningShown = false;
        return { storageKey, raw, draft };
    } catch {
        if (!recoveryDraftStorageWarningShown) {
            recoveryDraftStorageWarningShown = true;
            showToast('浏览器本地恢复草稿写入失败，请立即手动保存', 5000);
        }
        return null;
    }
}

function workspaceRecoveryDraftRecordForWriter(
    projectId = state.project?.id || '',
    chapterId = state.chapter?.id || '',
) {
    const storageKey = workspaceRecoveryDraftStorageKey(
        projectId,
        chapterId,
        workspaceRecoveryWriterId,
    );
    if (!storageKey) return null;
    try {
        const raw = window.localStorage.getItem(storageKey);
        return typeof raw === 'string' ? { storageKey, raw } : null;
    } catch {
        return null;
    }
}

function removeWorkspaceRecoveryDraftRecord(record) {
    if (!record?.storageKey || typeof record.raw !== 'string') return false;
    try {
        return compareAndRemoveWorkspaceRecoveryDraft(
            window.localStorage,
            record.storageKey,
            record.raw,
        );
    } catch {
        return false;
    }
}

function readWorkspaceRecoveryDraft(projectId, chapterId, excludedStorageKeys = null) {
    try {
        const { records, invalid } = scanWorkspaceRecoveryDrafts(
            window.localStorage,
            projectId,
            chapterId,
        );
        for (const record of invalid) removeWorkspaceRecoveryDraftRecord(record);
        const candidates = excludedStorageKeys
            ? records.filter(record => !excludedStorageKeys.has(record.storageKey))
            : records;
        return selectWorkspaceRecoveryDraft(candidates, workspaceRecoveryWriterId);
    } catch {
        // Browser recovery is best-effort and never blocks loading the workspace.
    }
    return null;
}

function restoreWorkspaceRecoveryDraft(project, chapter) {
    if (!project?.id || !chapter?.id) return false;
    const skippedStorageKeys = new Set();
    let record = readWorkspaceRecoveryDraft(project.id, chapter.id, skippedStorageKeys);
    while (record && workspaceRecoveryDraftAlreadyApplied(record.draft, {
        project,
        chapter,
        volume: volumeById(project, record.draft.volumeId),
    })) {
        const removed = removeWorkspaceRecoveryDraftRecord(record);
        const latestRecord = removed
            ? null
            : readWorkspaceRecoveryDraft(project.id, chapter.id);
        const cleanupDecision = workspaceRecoveryDraftCleanupDecision(
            record,
            removed,
            latestRecord,
        );
        if (cleanupDecision === 'updated') {
            record = latestRecord;
            continue;
        }
        if (cleanupDecision === 'skip') skippedStorageKeys.add(record.storageKey);
        record = readWorkspaceRecoveryDraft(project.id, chapter.id, skippedStorageKeys);
    }
    if (!record) return false;
    const { draft } = record;
    const volume = volumeById(project, draft.volumeId);
    const exactAuthority = draft.projectVersion === project.version
        && draft.chapterRevision === chapter.revision
        && (draft.volumeDirtyFields.length === 0 || draft.volumeRevision === volume?.revision);
    const restorePolicy = workspaceRecoveryDraftRestorePolicy(draft, {
        writerId: workspaceRecoveryWriterId,
        exactAuthority,
    });
    const foreignDraft = draft.writerId !== workspaceRecoveryWriterId;
    const confirmationMessage = exactAuthority
        ? '检测到另一个标签页或上次浏览器会话留下的本地恢复草稿。是否把它应用到当前章节？'
        : '检测到未同步的本地恢复草稿，但服务端版本已经变化。是否把本地草稿重新应用到当前版本？';
    if (restorePolicy === 'confirm' && !window.confirm(confirmationMessage)) {
        showToast('本地恢复草稿仍保留，下次打开本章时会再次询问', 5000);
        return false;
    }

    state.project = mergeProjectDirtyPaths(project, draft.projectChanges, draft.projectDirtyPaths);
    state.chapter = mergeDirtyPaths(chapter, draft.chapterChanges, draft.chapterDirtyPaths);
    if (draft.volumeDirtyFields.length > 0 && volume) {
        const restoredVolume = volumeById(state.project, volume.id);
        for (const field of draft.volumeDirtyFields) restoredVolume[field] = draft.volumeChanges[field];
    }
    state.projectDirtyPaths = new Set(draft.projectDirtyPaths);
    state.chapterDirtyPaths = new Set(draft.chapterDirtyPaths);
    state.volumeDirtyFields = new Set(draft.volumeDirtyFields);
    state.projectDirty = state.projectDirtyPaths.size > 0;
    state.chapterDirty = state.chapterDirtyPaths.size > 0;
    state.volumeDirty = state.volumeDirtyFields.size > 0;
    state.volumeDirtyId = state.volumeDirty ? draft.volumeId : '';
    restoredWorkspaceRecoverySource = foreignDraft
        ? {
            projectId: project.id,
            chapterId: chapter.id,
            storageKey: record.storageKey,
            raw: record.raw,
        }
        : null;
    invalidateCopilotPreview({ preserveError: true });
    scheduleAutosave();
    showToast(
        exactAuthority && !foreignDraft
            ? '已恢复本标签页未完成的本地草稿，正在自动保存'
            : exactAuthority
                ? '已应用另一标签页或浏览器会话的本地草稿，正在自动保存'
            : '已重新应用本地恢复草稿，正在保存到当前版本',
        5000,
    );
    return true;
}

function persistLifecycleRecoveryDraft() {
    persistWorkspaceRecoveryDraft();
    if (!state.project?.id || !state.chapter?.id || !state.chapterDirty
        || state.projectDirty || state.volumeDirty || state.saveInFlight
        || state.chapterDirtyPaths.size === 0 || !state.csrfToken) return;
    const dirtyPaths = new Set(state.chapterDirtyPaths);
    const body = {
        projectVersion: optimisticTokenFor(state.projectBase, state.project, 'version'),
        revision: optimisticTokenFor(state.chapterBase, state.chapter, 'revision'),
        changes: buildRecordChanges(state.chapter, dirtyPaths),
    };
    const signature = JSON.stringify([
        state.project.id,
        state.chapter.id,
        body.projectVersion,
        body.revision,
        body.changes,
    ]);
    if (signature === lifecycleRecoveryFlushSignature) return;
    lifecycleRecoveryFlushSignature = signature;
    void fetch(pathForProject(
        state.project.id,
        `/chapters/${encodeURIComponent(state.chapter.id)}`,
    ), {
        method: 'PATCH',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken,
        },
        body: JSON.stringify(body),
        keepalive: true,
    }).catch(() => {
        // The synchronous local recovery draft remains the fallback.
    });
}

function qualityChapterPath(projectId, chapterId, suffix = '') {
    return chapterPath(projectId, chapterId, `/quality${suffix}`);
}

function qualityRegressionPath(suffix = '') {
    return `${API_ROOT}/quality-regression${suffix}`;
}

function volumePath(projectId, volumeId = '') {
    const suffix = volumeId ? `/${encodeURIComponent(volumeId)}` : '';
    return pathForProject(projectId, `/volumes${suffix}`);
}

function versionPath(projectId, chapterId, versionId = '', suffix = '') {
    const versionSuffix = versionId ? `/${encodeURIComponent(versionId)}` : '';
    return chapterPath(projectId, chapterId, `/versions${versionSuffix}${suffix}`);
}

async function responseData(response) {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

async function streamMutation(path, body, { signal, onEvent } = {}) {
    state.mutationInFlight += 1;
    let reader = null;
    let streamEnded = false;
    try {
        const response = await fetch(path, {
            method: 'POST',
            headers: {
                Accept: 'application/x-ndjson',
                'Content-Type': 'application/json',
                ...(state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}),
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok) {
            const data = await responseData(response);
            throw new ApiError(data?.message || `请求失败（${response.status}）`, response.status, data);
        }
        if (!response.body) throw new ApiError('生成服务没有返回数据流', 502, { error: 'invalid_stream' });

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let sawDone = false;
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                streamEnded = true;
                break;
            }
            buffered += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);
                if (!line) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    throw new ApiError('生成服务返回了无效的数据流', 502, { error: 'invalid_stream' });
                }
                await onEvent?.(event);
                if (event?.type === 'done') sawDone = true;
            }
        }
        buffered += decoder.decode();
        if (buffered.trim()) {
            let event;
            try {
                event = JSON.parse(buffered.trim());
            } catch {
                throw new ApiError('生成服务返回了无效的数据流', 502, { error: 'invalid_stream' });
            }
            await onEvent?.(event);
            if (event?.type === 'done') sawDone = true;
        }
        return sawDone;
    } finally {
        if (reader) {
            if (!streamEnded || signal?.aborted) await reader.cancel(signal?.reason).catch(() => {});
            reader.releaseLock();
        }
        state.mutationInFlight -= 1;
    }
}

function byId(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Story Studio element is missing: ${id}`);
    }
    return element;
}

function cacheElements() {
    const ids = [
        'story_studio_workspace',
        'ss_project_select',
        'ss_new_project',
        'ss_create_project_form',
        'ss_create_title',
        'ss_create_genre',
        'ss_cancel_create',
        'ss_save_status',
        'ss_progress',
        'ss_project_metrics',
        'ss_empty_state',
        'ss_empty_create',
        'ss_bootstrap_error',
        'ss_bootstrap_error_message',
        'ss_retry_bootstrap',
        'ss_shell',
        'ss_binder',
        'ss_add_volume',
        'ss_add_chapter',
        'ss_chapter_search',
        'ss_chapter_list',
        'ss_main',
        'ss_today_view',
        'ss_dashboard_status',
        'ss_dashboard_refresh',
        'ss_dashboard_no_project',
        'ss_dashboard_loading',
        'ss_dashboard_empty',
        'ss_dashboard_error',
        'ss_dashboard_error_message',
        'ss_dashboard_retry',
        'ss_dashboard_workspace',
        'ss_dashboard_next_label',
        'ss_dashboard_next_detail',
        'ss_dashboard_next_open',
        'ss_dashboard_next_workflow',
        'ss_dashboard_progress_percent',
        'ss_dashboard_total_words',
        'ss_dashboard_target_words',
        'ss_dashboard_progress',
        'ss_dashboard_chapter_summary',
        'ss_dashboard_chapter_statuses',
        'ss_dashboard_work_list',
        'ss_dashboard_work_empty',
        'ss_dashboard_promise_summary',
        'ss_dashboard_promise_list',
        'ss_dashboard_promise_empty',
        'ss_dashboard_stale_summary',
        'ss_dashboard_stale_list',
        'ss_dashboard_stale_empty',
        'ss_dashboard_story_state_summary',
        'ss_dashboard_recent_list',
        'ss_dashboard_recent_empty',
        'ss_write_view',
        'ss_editor_breadcrumb',
        'ss_chapter_title',
        'ss_chapter_volume',
        'ss_chapter_status',
        'ss_manuscript',
        'ss_chapter_count',
        'ss_chapter_updated',
        'ss_bible_view',
        'ss_volume_outline_select',
        'ss_volume_move_up',
        'ss_volume_move_down',
        'ss_volume_delete',
        'ss_volume_revision',
        'ss_ledger_view',
        'ss_copilot_view',
        'ss_copilot_status',
        'ss_copilot_project_context',
        'ss_copilot_anchor_chapter',
        'ss_copilot_volume_options',
        'ss_copilot_chapter_options',
        'ss_copilot_entity_options',
        'ss_copilot_lorebook_options',
        'ss_copilot_retrieval_query',
        'ss_copilot_retrieval_limit',
        'ss_copilot_preview',
        'ss_copilot_context_digest',
        'ss_copilot_evidence_defaults',
        'ss_copilot_evidence_all',
        'ss_copilot_evidence_none',
        'ss_copilot_evidence_list',
        'ss_copilot_profile',
        'ss_copilot_model_mode',
        'ss_copilot_model',
        'ss_copilot_model_status',
        'ss_copilot_save_model',
        'ss_copilot_test_model',
        'ss_copilot_instruction',
        'ss_copilot_option_count',
        'ss_copilot_option_decrease',
        'ss_copilot_option_increase',
        'ss_copilot_create_session',
        'ss_copilot_session',
        'ss_copilot_refresh',
        'ss_copilot_generate',
        'ss_copilot_cancel',
        'ss_copilot_retry',
        'ss_copilot_session_status',
        'ss_copilot_session_meta',
        'ss_copilot_stream',
        'ss_copilot_copy',
        'ss_copilot_export',
        'ss_copilot_directions',
        'ss_copilot_setting_diffs',
        'ss_copilot_lorebook_diffs',
        'ss_copilot_error',
        'ss_copilot_error_message',
        'ss_quality_view',
        'ss_quality_status',
        'ss_quality_refresh',
        'ss_quality_no_project',
        'ss_quality_workspace',
        'ss_quality_builtin_revision',
        'ss_quality_profile_catalog',
        'ss_quality_profile_detail',
        'ss_quality_overlay_catalog',
        'ss_quality_copy_name',
        'ss_quality_copy_overlay',
        'ss_quality_copy_profile',
        'ss_quality_copy_status',
        'ss_quality_chapter_label',
        'ss_quality_preview',
        'ss_quality_save_report',
        'ss_quality_chapter_summary',
        'ss_quality_issue_list',
        'ss_quality_issue_empty',
        'ss_quality_refresh_reports',
        'ss_quality_report_select',
        'ss_quality_open_report',
        'ss_quality_report_meta',
        'ss_quality_run_regression',
        'ss_quality_suite_meta',
        'ss_quality_baseline_summary',
        'ss_quality_run_select',
        'ss_quality_open_run',
        'ss_quality_run_summary',
        'ss_quality_compare_baseline',
        'ss_quality_gate_status',
        'ss_quality_gate_list',
        'ss_quality_gate_empty',
        'ss_quality_error',
        'ss_quality_error_message',
        'ss_quality_retry',
        'ss_workflow_view',
        'ss_workflow_status',
        'ss_workflow_definition',
        'ss_workflow_run',
        'ss_workflow_new_run',
        'ss_workflow_refresh',
        'ss_workflow_track',
        'ss_workflow_current_status',
        'ss_workflow_current_meta',
        'ss_workflow_execute',
        'ss_workflow_approve',
        'ss_workflow_apply',
        'ss_workflow_cancel',
        'ss_workflow_evidence',
        'ss_workflow_artifact_select',
        'ss_workflow_artifact_summary',
        'ss_workflow_artifact_json',
        'ss_workflow_authority',
        'ss_workflow_error',
        'ss_workflow_error_message',
        'ss_workflow_retry',
        'ss_ledger_list',
        'ss_ledger_empty',
        'ss_story_state_status',
        'ss_story_state_counts',
        'ss_story_state_json',
        'ss_continuity_tabs',
        'ss_continuity_records',
        'ss_continuity_empty',
        'ss_generation_changeset_status',
        'ss_generation_changeset_summary',
        'ss_generation_changeset_counts',
        'ss_generation_changeset_json',
        'ss_pending_changeset_status',
        'ss_pending_changeset_json',
        'ss_adopt_pending_changeset',
        'ss_save_pending_changeset',
        'ss_revert_pending_changeset',
        'ss_clear_pending_changeset',
        'ss_copy_pending_changeset',
        'ss_resources_view',
        'ss_import_resource',
        'ss_resource_status',
        'ss_resource_list',
        'ss_resource_detail',
        'ss_resource_detail_empty',
        'ss_resource_detail_content',
        'ss_resource_detail_type',
        'ss_resource_detail_name',
        'ss_resource_compatibility',
        'ss_resource_compatibility_meta',
        'ss_resource_compatibility_warnings',
        'ss_delete_resource',
        'ss_resource_instruction_row',
        'ss_resource_instruction_enabled',
        'ss_profile_editor',
        'ss_profile_meta',
        'ss_profile_status',
        'ss_profile_revert',
        'ss_profile_save',
        'ss_profile_counts',
        'ss_profile_name',
        'ss_profile_token_budget',
        'ss_profile_character_budget',
        'ss_profile_generation',
        'ss_profile_modules',
        'ss_profile_order',
        'ss_profile_variables',
        'ss_profile_variable_values',
        'ss_profile_generation_policies',
        'ss_profile_task_policies',
        'ss_profile_compatibility_meta',
        'ss_profile_compatibility_warnings',
        'ss_profile_preview_task',
        'ss_profile_preview_tokens',
        'ss_profile_preview_characters',
        'ss_profile_preview_variables',
        'ss_profile_compile',
        'ss_profile_compile_status',
        'ss_profile_compile_issues',
        'ss_profile_compile_modules',
        'ss_profile_compile_messages',
        'ss_profile_compile_generation',
        'ss_profile_legacy',
        'ss_profile_legacy_meta',
        'ss_profile_legacy_warnings',
        'ss_resource_json',
        'ss_inspector',
        'ss_card_panel',
        'ss_card_breadcrumb',
        'ss_plan_review_status',
        'ss_assistant_panel',
        'ss_versions_panel',
        'ss_generate',
        'ss_generation_history',
        'ss_generation_preview',
        'ss_retrieval_preview',
        'ss_generation_regenerate',
        'ss_generation_continue',
        'ss_generation_instruction',
        'ss_generation_status',
        'ss_context_preview',
        'ss_close_context_preview',
        'ss_context_overrides',
        'ss_context_override_count',
        'ss_context_entity_overrides',
        'ss_context_promise_overrides',
        'ss_context_retrieval_overrides',
        'ss_clear_retrieval_overrides',
        'ss_retrieval_rerank',
        'ss_context_metrics',
        'ss_context_volume',
        'ss_context_lore',
        'ss_context_lore_skipped',
        'ss_context_profile',
        'ss_context_profile_modules',
        'ss_context_continuity_preflight',
        'ss_context_retrieval',
        'ss_context_truncation',
        'ss_context_messages',
        'ss_context_system',
        'ss_context_user',
        'ss_candidate_label',
        'ss_candidate_time',
        'ss_candidate',
        'ss_candidate_actions',
        'ss_distillation',
        'ss_distillation_status',
        'ss_distillation_summary',
        'ss_distillation_counts',
        'ss_distillation_details',
        'ss_distillation_json',
        'ss_review_record',
        'ss_chapter_notes',
        'ss_refresh_versions',
        'ss_versions_status',
        'ss_versions_list',
        'ss_versions_empty',
        'ss_version_detail',
        'ss_version_detail_empty',
        'ss_version_detail_content',
        'ss_version_detail_source',
        'ss_version_detail_title',
        'ss_version_detail_time',
        'ss_version_metrics',
        'ss_version_diff',
        'ss_version_content',
        'ss_restore_version',
        'ss_toggle_binder',
        'ss_toggle_inspector',
        'ss_save',
        'ss_export',
        'ss_import',
        'ss_import_file',
        'ss_resource_import_file',
        'ss_open_provider',
        'ss_provider_scrim',
        'ss_provider_drawer',
        'ss_close_provider',
        'ss_provider_form',
        'ss_provider_protocol',
        'ss_provider_base_url',
        'ss_provider_model',
        'ss_provider_api_key',
        'ss_provider_key_state',
        'ss_clear_provider_key',
        'ss_provider_temperature',
        'ss_provider_top_p',
        'ss_provider_top_k',
        'ss_provider_stop',
        'ss_provider_context_tokens',
        'ss_provider_max_tokens',
        'ss_provider_json_schema',
        'ss_test_provider',
        'ss_save_provider',
        'ss_provider_status',
        'ss_drawer_scrim',
        'ss_toast',
    ];
    for (const id of ids) {
        elements[id] = byId(id);
    }
}

function setSaveStatus(text, status = '') {
    elements.ss_save_status.textContent = text;
    if (status) {
        elements.ss_save_status.dataset.state = status;
    } else {
        delete elements.ss_save_status.dataset.state;
    }
}

function showToast(message, duration = 3200) {
    window.clearTimeout(toastTimer);
    elements.ss_toast.textContent = String(message || '');
    elements.ss_toast.hidden = false;
    toastTimer = window.setTimeout(() => {
        elements.ss_toast.hidden = true;
    }, duration);
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

function projectSummary(project) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
    return {
        id: project.id,
        title: project.title,
        genre: project.genre,
        version: project.version,
        chapterCount: chapters.length,
        totalWords: chapters.reduce((total, chapter) => total + Number(chapter.wordCount || 0), 0),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
    };
}

function orderedVolumes(project = state.project) {
    return [...(project?.volumes || [])].sort((left, right) => left.number - right.number);
}

function selectedVolume(project = state.project) {
    const volumes = orderedVolumes(project);
    return volumes.find(volume => volume.id === state.selectedVolumeId) || volumes[0] || null;
}

function volumeById(project, volumeId) {
    return project?.volumes?.find(volume => volume.id === volumeId) || null;
}

function selectVolumeId(project, preferredId = state.selectedVolumeId) {
    const volumes = orderedVolumes(project);
    state.selectedVolumeId = volumes.some(volume => volume.id === preferredId)
        ? preferredId
        : volumes[0]?.id || '';
    return state.selectedVolumeId;
}

function bindSelectedVolume(volumeId, { render = false } = {}) {
    const volume = volumeById(state.project, volumeId);
    if (!volume) return false;
    state.selectedVolumeId = volume.id;
    state.volumeBase = clone(volumeById(state.projectBase, volume.id) || volume);
    if (render) renderBible();
    return true;
}

function upsertProjectSummary(project) {
    const summary = projectSummary(project);
    const index = state.projects.findIndex(item => item.id === summary.id);
    if (index === -1) {
        state.projects.push(summary);
    } else {
        state.projects[index] = summary;
    }
    state.projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function acceptServerProject(
    serverProject,
    preservePaths = state.projectDirtyPaths,
    {
        advanceVolumeBase = false,
        preserveSavingPaths = true,
        advancePreservedBase = false,
    } = {},
) {
    if (!serverProject) return;
    const local = state.project?.id === serverProject.id ? state.project : null;
    const previousBase = state.projectBase?.id === serverProject.id ? state.projectBase : null;
    const previousSelectedId = state.selectedVolumeId;
    const preservedVolumes = new Map();
    for (const [volumeId, fields] of [
        [state.volumeDirtyId, state.volumeDirtyFields],
        [state.volumeSavingId, preserveSavingPaths ? state.volumeSavingFields : new Set()],
    ]) {
        if (!volumeId || fields.size === 0) continue;
        const preservedFields = preservedVolumes.get(volumeId) || new Set();
        for (const field of fields) preservedFields.add(field);
        preservedVolumes.set(volumeId, preservedFields);
    }
    for (const volumeId of preservedVolumes.keys()) {
        if (!volumeById(local, volumeId) || !volumeById(serverProject, volumeId)) {
            throw new ApiError('正在编辑的卷已在另一个窗口被删除；本地卷纲尚未覆盖，请刷新后重新处理', 409, {
                error: 'volume_not_found',
            });
        }
    }
    const selectedId = selectVolumeId(serverProject, previousSelectedId);
    const serverSelectedVolume = volumeById(serverProject, selectedId);
    const authority = mergeProjectAuthoritySnapshot({
        remote: serverProject,
        local,
        baseline: previousBase,
        dirtyPaths: preservePaths,
        savingPaths: state.projectSavingPaths,
        preserveSavingPaths,
        advanceBaseline: advancePreservedBase,
        relatedPending: preservedVolumes.size > 0,
    });
    state.projectBase = authority.baseline;
    state.project = authority.record;
    for (const [volumeId, fields] of preservedVolumes) {
        const localVolume = volumeById(local, volumeId);
        const target = volumeById(state.project, volumeId);
        for (const field of fields) target[field] = localVolume[field];
    }
    if (advanceVolumeBase || preservedVolumes.size === 0) {
        const advancedVolumeId = state.volumeSavingId || state.volumeDirtyId;
        const advancedVolume = volumeById(serverProject, advancedVolumeId);
        const nextBase = advanceVolumeBase && advancedVolume ? advancedVolume : serverSelectedVolume;
        state.volumeBase = nextBase ? clone(nextBase) : null;
    }
    syncCopilotAuthorityState();
    upsertProjectSummary(state.project);
}

function acceptServerChapter(
    serverChapter,
    preservePaths = state.chapterDirtyPaths,
    { preserveSavingPaths = true, advancePreservedBase = false } = {},
) {
    if (!serverChapter) return;
    const local = state.chapter?.id === serverChapter.id ? state.chapter : null;
    const previousBase = state.chapterBase?.id === serverChapter.id ? state.chapterBase : null;
    const previousRevision = local?.revision;
    const previousCandidate = local?.candidate;
    const authority = mergeChapterAuthoritySnapshot({
        remote: serverChapter,
        local,
        baseline: previousBase,
        dirtyPaths: preservePaths,
        savingPaths: state.chapterSavingPaths,
        preserveSavingPaths,
        advanceBaseline: advancePreservedBase,
    });
    state.chapterBase = authority.baseline;
    state.chapter = authority.record;
    if (JSON.stringify(previousCandidate) !== JSON.stringify(state.chapter.candidate)) {
        state.candidateEditSerial += 1;
    }
    if (local && previousRevision !== state.chapter.revision) {
        invalidateVersionCache({ preserveSelection: true });
    }
}

function clearDirtyState({ preserveRecoveryDraft = false } = {}) {
    const recoveryDraft = preserveRecoveryDraft
        ? null
        : workspaceRecoveryDraftRecordForWriter();
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    state.projectDirty = false;
    state.chapterDirty = false;
    state.volumeDirty = false;
    state.projectDirtyPaths.clear();
    state.chapterDirtyPaths.clear();
    state.volumeDirtyFields.clear();
    state.volumeDirtyId = '';
    lifecycleRecoveryFlushSignature = '';
    invalidateContextPreview();
    if (!preserveRecoveryDraft) removeWorkspaceRecoveryDraftRecord(recoveryDraft);
    setSaveStatus('已保存', 'saved');
}

function scheduleAutosave() {
    window.clearTimeout(autosaveTimer);
    lifecycleRecoveryFlushSignature = '';
    persistWorkspaceRecoveryDraft();
    setSaveStatus('待保存', 'saving');
    autosaveTimer = window.setTimeout(() => {
        autosaveTimer = null;
        void enqueueSave();
    }, AUTOSAVE_DELAY);
}

function markProjectDirty(fieldPaths) {
    if (!state.project) return;
    for (const fieldPath of Array.isArray(fieldPaths) ? fieldPaths : [fieldPaths]) {
        if (fieldPath) state.projectDirtyPaths.add(fieldPath);
    }
    state.projectDirty = true;
    invalidateContextPreview();
    invalidateCopilotPreview({ preserveError: true });
    scheduleAutosave();
}

function markChapterDirty(fieldPaths) {
    if (!state.chapter) return;
    for (const fieldPath of Array.isArray(fieldPaths) ? fieldPaths : [fieldPaths]) {
        if (fieldPath) state.chapterDirtyPaths.add(fieldPath);
    }
    state.chapterDirty = true;
    invalidateContextPreview();
    invalidateCopilotPreview({ preserveError: true });
    scheduleAutosave();
}

function markVolumeDirty(field) {
    const volume = selectedVolume();
    if (!volume || !field) return;
    if (state.volumeDirtyId && state.volumeDirtyId !== volume.id) {
        throw new Error('Cannot edit two volume drafts before saving');
    }
    state.volumeDirtyId = volume.id;
    state.volumeDirtyFields.add(field);
    state.volumeDirty = true;
    invalidateContextPreview();
    invalidateCopilotPreview({ preserveError: true });
    scheduleAutosave();
}

function markCandidateDirty() {
    state.candidateEditSerial += 1;
    markChapterDirty('candidate');
}

function conflictMessage(kind) {
    const subject = kind === 'project' ? '作品设定' : '当前章节';
    return `${subject}的同一字段已在另一个窗口发生变化。\n\n选择“确定”将保留本窗口对冲突字段的内容。\n选择“取消”将采用服务端的冲突字段。未冲突的本地改动都会保留。`;
}

function reconcileProjectConflict(remoteProject) {
    const localProject = state.project;
    const remoteView = continuityView(remoteProject);
    const localView = continuityView(localProject);
    const conflict = classifyConflictPaths({
        baseline: continuityView(state.projectBase || remoteProject),
        remote: remoteView,
        local: localView,
        fieldPaths: state.projectDirtyPaths,
    });
    state.projectDirtyPaths.clear();
    for (const fieldPath of conflict.pendingPaths) state.projectDirtyPaths.add(fieldPath);
    const { conflictingPaths } = conflict;
    if (conflictingPaths.length > 0 && !window.confirm(conflictMessage('project'))) {
        for (const fieldPath of conflictingPaths) state.projectDirtyPaths.delete(fieldPath);
    }

    acceptServerProject(remoteProject, state.projectDirtyPaths, {
        advancePreservedBase: true,
    });
    state.projectDirty = state.projectDirtyPaths.size > 0;
    renderProjectData();
    showToast(conflictingPaths.length > 0 ? '冲突字段已处理，正在保存未冲突改动' : '已自动合并服务端更新');
    return state.projectDirty;
}

async function resolveProjectConflict(projectId) {
    setSaveStatus('版本冲突', 'conflict');
    const remoteProject = await apiRequest(pathForProject(projectId));
    if (state.project?.id !== projectId) return false;
    const projectBase = state.projectBase;
    if (state.volumeDirty) {
        reconcileVolumeConflict(remoteProject, { render: false, notify: false });
        state.projectBase = projectBase;
    }
    return reconcileProjectConflict(remoteProject);
}

async function resolveChapterConflict(projectId, chapterId) {
    setSaveStatus('版本冲突', 'conflict');
    const authority = await apiRequest(pathForProject(
        projectId,
        `/chapters/${encodeURIComponent(chapterId)}/authority`,
    ));
    const remoteProject = authority?.project;
    const remoteChapter = authority?.chapter;
    if (!remoteProject || !remoteChapter) {
        throw new Error('服务端没有返回完整的章节权威状态');
    }
    if (state.project?.id !== projectId || state.chapter?.id !== chapterId) return false;

    const projectBase = state.projectBase;
    if (state.volumeDirty) {
        reconcileVolumeConflict(remoteProject, { render: false, notify: false });
        state.projectBase = projectBase;
    }
    if (state.projectDirtyPaths.size > 0) {
        reconcileProjectConflict(remoteProject);
    } else {
        acceptServerProject(remoteProject);
    }
    const localChapter = state.chapter;
    const conflict = classifyConflictPaths({
        baseline: state.chapterBase || remoteChapter,
        remote: remoteChapter,
        local: localChapter,
        fieldPaths: state.chapterDirtyPaths,
    });
    state.chapterDirtyPaths.clear();
    for (const fieldPath of conflict.pendingPaths) state.chapterDirtyPaths.add(fieldPath);
    const { conflictingPaths } = conflict;
    if (conflictingPaths.length > 0 && !window.confirm(conflictMessage('chapter'))) {
        for (const fieldPath of conflictingPaths) state.chapterDirtyPaths.delete(fieldPath);
    }

    acceptServerChapter(remoteChapter, state.chapterDirtyPaths, {
        advancePreservedBase: true,
    });
    state.chapterDirty = state.chapterDirtyPaths.size > 0;
    renderProjectData();
    if (state.inspector === 'versions' && !versionCacheMatchesChapter()) {
        void refreshVersionHistory({ selectId: state.selectedVersionId });
    }
    showToast(conflictingPaths.length > 0 ? '冲突字段已处理，正在保存未冲突改动' : '已自动合并服务端更新');
    return state.chapterDirty;
}

function reconcileVolumeConflict(remoteProject, { render = true, notify = true } = {}) {
    const volumeId = state.volumeDirtyId || state.selectedVolumeId;
    const localVolume = volumeById(state.project, volumeId);
    const remoteVolume = volumeById(remoteProject, volumeId);
    if (!localVolume || !remoteVolume) {
        throw new ApiError('当前卷已不存在，请重新选择卷', 409, { error: 'volume_not_found' });
    }
    const conflict = classifyConflictPaths({
        baseline: state.volumeBase || {},
        remote: remoteVolume,
        local: localVolume,
        fieldPaths: state.volumeDirtyFields,
    });
    state.volumeDirtyFields.clear();
    for (const field of conflict.pendingPaths) state.volumeDirtyFields.add(field);
    const conflicts = conflict.conflictingPaths;
    if (conflicts.length > 0 && !window.confirm('当前卷的同一字段已在另一个窗口变化。\n\n选择“确定”保留本窗口内容，选择“取消”采用服务端内容。')) {
        for (const field of conflicts) state.volumeDirtyFields.delete(field);
    }
    state.volumeDirty = state.volumeDirtyFields.size > 0;
    acceptServerProject(remoteProject, state.projectDirtyPaths, {
        advanceVolumeBase: true,
        advancePreservedBase: true,
    });
    if (!state.volumeDirty) state.volumeDirtyId = '';
    if (render) renderProjectData();
    if (notify) showToast(conflicts.length > 0 ? '卷纲冲突已处理' : '已自动合并卷纲更新');
    return state.volumeDirty;
}

async function resolveVolumeConflict(projectId) {
    setSaveStatus('版本冲突', 'conflict');
    const remoteProject = await apiRequest(pathForProject(projectId));
    if (state.project?.id !== projectId) return false;
    return reconcileVolumeConflict(remoteProject);
}

async function flushDirtyImpl() {
    if (!state.project) {
        setSaveStatus('已保存', 'saved');
        return true;
    }
    if (!state.projectDirty && !state.volumeDirty && !state.chapterDirty) {
        setSaveStatus('已保存', 'saved');
        return true;
    }

    const authorityProjectId = state.project.id;
    const authorityChapterId = state.chapter?.id || '';
    const authorityVersionBeforeSave = state.project.version;
    const recoveryDraftAtSaveStart = workspaceRecoveryDraftRecordForWriter(
        authorityProjectId,
        authorityChapterId,
    );
    const restoredRecoverySourceAtSaveStart = restoredWorkspaceRecoverySource
        && restoredWorkspaceRecoverySource.projectId === authorityProjectId
        && restoredWorkspaceRecoverySource.chapterId === authorityChapterId
        ? { ...restoredWorkspaceRecoverySource }
        : null;
    setSaveStatus('保存中', 'saving');
    let conflictRetries = 0;

    while (state.project && (state.projectDirty || state.volumeDirty || state.chapterDirty)) {
        if (state.projectDirty) {
            const projectId = state.project.id;
            const version = optimisticTokenFor(state.projectBase, state.project, 'version');
            const batch = beginSaveBatch(state.projectDirtyPaths);
            const dirtyPaths = batch.savingPaths;
            if (dirtyPaths.size === 0) {
                state.projectDirty = false;
                continue;
            }
            const changes = buildProjectChanges(state.project, dirtyPaths);
            state.projectSavingPaths = new Set(dirtyPaths);
            state.projectDirtyPaths = batch.dirtyPaths;
            state.projectDirty = state.projectDirtyPaths.size > 0;

            try {
                const serverProject = await apiRequest(pathForProject(projectId), {
                    method: 'PATCH',
                    body: { version, changes },
                });
                if (state.project?.id !== projectId) return true;
                if (authorityResponseTokenIsStale(serverProject, state.project, 'version')) {
                    state.projectSavingPaths.clear();
                    state.projectDirtyPaths = rollbackSaveBatch(state.projectDirtyPaths, dirtyPaths);
                    state.projectDirty = true;
                    const retry = await resolveProjectConflict(projectId);
                    if (retry) continue;
                    conflictRetries = 0;
                    continue;
                }
                state.projectDirty = state.projectDirtyPaths.size > 0;
                acceptServerProject(serverProject, state.projectDirtyPaths, {
                    preserveSavingPaths: false,
                    advancePreservedBase: true,
                });
                conflictRetries = 0;
                renderSaveMetadata();
            } catch (error) {
                state.projectSavingPaths.clear();
                state.projectDirtyPaths = rollbackSaveBatch(state.projectDirtyPaths, dirtyPaths);
                state.projectDirty = true;
                if (error instanceof ApiError && error.code === 'project_busy' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    await delay(Number(error.data?.retryAfterMs || 100));
                    continue;
                }
                if (error instanceof ApiError && error.code === 'project_conflict' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    try {
                        const retry = await resolveProjectConflict(projectId);
                        if (retry) continue;
                        conflictRetries = 0;
                        continue;
                    } catch (conflictError) {
                        setSaveStatus('冲突处理失败', 'error');
                        showToast(conflictError.message || '无法取得服务端最新版', 5000);
                        return false;
                    }
                }
                setSaveStatus('保存失败', 'error');
                showToast(error.message || '作品设定保存失败', 5000);
                return false;
            } finally {
                state.projectSavingPaths.clear();
            }
        }

        if (state.volumeDirty) {
            const projectId = state.project.id;
            const volume = volumeById(state.project, state.volumeDirtyId);
            if (!volume) {
                state.volumeDirty = false;
                state.volumeDirtyFields.clear();
                state.volumeDirtyId = '';
                continue;
            }
            const projectVersion = optimisticTokenFor(state.projectBase, state.project, 'version');
            const revision = optimisticTokenFor(state.volumeBase, volume, 'revision');
            const batch = beginSaveBatch(state.volumeDirtyFields);
            const dirtyFields = batch.savingPaths;
            if (dirtyFields.size === 0) {
                state.volumeDirty = false;
                state.volumeDirtyId = '';
                continue;
            }
            const changes = buildRecordChanges(volume, dirtyFields);
            state.volumeSavingId = volume.id;
            state.volumeSavingFields = new Set(dirtyFields);
            state.volumeDirtyFields = batch.dirtyPaths;
            state.volumeDirty = state.volumeDirtyFields.size > 0;

            try {
                const result = await apiRequest(pathForProject(projectId, `/volumes/${encodeURIComponent(volume.id)}`), {
                    method: 'PATCH',
                    body: { projectVersion, revision, changes },
                });
                if (state.project?.id !== projectId || state.volumeDirtyId !== volume.id) return true;
                const responseVolume = volumeById(result.project, volume.id);
                const currentVolume = volumeById(state.project, volume.id);
                if (authorityResponseTokenIsStale(result.project, state.project, 'version')
                    || authorityResponseTokenIsStale(responseVolume, currentVolume, 'revision')) {
                    state.volumeSavingFields.clear();
                    state.volumeSavingId = '';
                    state.volumeDirtyFields = rollbackSaveBatch(state.volumeDirtyFields, dirtyFields);
                    state.volumeDirty = true;
                    const retry = await resolveVolumeConflict(projectId);
                    if (retry) continue;
                    conflictRetries = 0;
                    continue;
                }
                state.volumeDirty = state.volumeDirtyFields.size > 0;
                acceptServerProject(result.project, state.projectDirtyPaths, {
                    advanceVolumeBase: true,
                    preserveSavingPaths: false,
                    advancePreservedBase: true,
                });
                if (!state.volumeDirty) state.volumeDirtyId = '';
                conflictRetries = 0;
                renderSaveMetadata();
                renderBible();
                renderCard();
            } catch (error) {
                state.volumeSavingFields.clear();
                state.volumeSavingId = '';
                state.volumeDirtyFields = rollbackSaveBatch(state.volumeDirtyFields, dirtyFields);
                state.volumeDirty = true;
                if (error instanceof ApiError && error.code === 'project_busy' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    await delay(Number(error.data?.retryAfterMs || 100));
                    continue;
                }
                if (error instanceof ApiError && error.code === 'project_conflict' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    try {
                        await resolveVolumeConflict(projectId);
                        continue;
                    } catch (conflictError) {
                        setSaveStatus('冲突处理失败', 'error');
                        showToast(conflictError.message || '无法取得卷纲最新版', 5000);
                        return false;
                    }
                }
                if (error instanceof ApiError && error.code === 'volume_conflict' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    try {
                        if (await resolveVolumeConflict(projectId)) continue;
                        conflictRetries = 0;
                        continue;
                    } catch (conflictError) {
                        setSaveStatus('冲突处理失败', 'error');
                        showToast(conflictError.message || '无法取得卷纲最新版', 5000);
                        return false;
                    }
                }
                setSaveStatus('保存失败', 'error');
                showToast(error.message || '卷纲保存失败', 5000);
                return false;
            } finally {
                state.volumeSavingFields.clear();
                state.volumeSavingId = '';
            }
        }

        if (state.chapterDirty && state.chapter) {
            const projectId = state.project.id;
            const chapterId = state.chapter.id;
            const projectVersion = optimisticTokenFor(state.projectBase, state.project, 'version');
            const revision = optimisticTokenFor(state.chapterBase, state.chapter, 'revision');
            const batch = beginSaveBatch(state.chapterDirtyPaths);
            const dirtyPaths = batch.savingPaths;
            if (dirtyPaths.size === 0) {
                state.chapterDirty = false;
                continue;
            }
            const changes = buildRecordChanges(state.chapter, dirtyPaths);
            state.chapterSavingPaths = new Set(dirtyPaths);
            state.chapterDirtyPaths = batch.dirtyPaths;
            state.chapterDirty = state.chapterDirtyPaths.size > 0;

            try {
                const result = await apiRequest(pathForProject(projectId, `/chapters/${encodeURIComponent(chapterId)}`), {
                    method: 'PATCH',
                    body: { projectVersion, revision, changes },
                });
                if (state.project?.id !== projectId || state.chapter?.id !== chapterId) return true;
                if (authorityResponseTokenIsStale(result.project, state.project, 'version')
                    || authorityResponseTokenIsStale(result.chapter, state.chapter, 'revision')) {
                    state.chapterSavingPaths.clear();
                    state.chapterDirtyPaths = rollbackSaveBatch(state.chapterDirtyPaths, dirtyPaths);
                    state.chapterDirty = true;
                    const retry = await resolveChapterConflict(projectId, chapterId);
                    if (retry) continue;
                    conflictRetries = 0;
                    continue;
                }
                state.chapterDirty = state.chapterDirtyPaths.size > 0;
                acceptServerProject(result.project, state.projectDirtyPaths, {
                    preserveSavingPaths: false,
                    advancePreservedBase: true,
                });
                acceptServerChapter(result.chapter, state.chapterDirtyPaths, {
                    preserveSavingPaths: false,
                    advancePreservedBase: true,
                });
                conflictRetries = 0;
                renderSaveMetadata();
                if (state.inspector === 'versions' && !state.navigationBusy && !state.versionRestoring) {
                    void refreshVersionHistory();
                }
            } catch (error) {
                state.chapterSavingPaths.clear();
                state.chapterDirtyPaths = rollbackSaveBatch(state.chapterDirtyPaths, dirtyPaths);
                state.chapterDirty = true;
                if (error instanceof ApiError && error.code === 'project_busy' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    await delay(Number(error.data?.retryAfterMs || 100));
                    continue;
                }
                if (error instanceof ApiError && error.code === 'project_conflict' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    try {
                        const remoteProject = await apiRequest(pathForProject(projectId));
                        if (state.project?.id !== projectId || state.chapter?.id !== chapterId) return true;
                        if (state.projectDirtyPaths.size > 0) {
                            reconcileProjectConflict(remoteProject);
                        } else {
                            acceptServerProject(remoteProject);
                        }
                        renderSaveMetadata();
                        continue;
                    } catch (conflictError) {
                        setSaveStatus('冲突处理失败', 'error');
                        showToast(conflictError.message || '无法取得服务端最新版', 5000);
                        return false;
                    }
                }
                if (error instanceof ApiError && error.code === 'chapter_conflict' && conflictRetries < MAX_CONFLICT_RETRIES) {
                    conflictRetries += 1;
                    try {
                        const retry = await resolveChapterConflict(projectId, chapterId);
                        if (retry) continue;
                        conflictRetries = 0;
                        continue;
                    } catch (conflictError) {
                        setSaveStatus('冲突处理失败', 'error');
                        showToast(conflictError.message || '无法取得服务端最新版', 5000);
                        return false;
                    }
                }
                setSaveStatus('保存失败', 'error');
                showToast(error.message || '章节保存失败', 5000);
                return false;
            } finally {
                state.chapterSavingPaths.clear();
            }
        }
    }

    setSaveStatus('已保存', 'saved');
    removeWorkspaceRecoveryDraftRecord(recoveryDraftAtSaveStart);
    if (restoredRecoverySourceAtSaveStart) {
        removeWorkspaceRecoveryDraftRecord(restoredRecoverySourceAtSaveStart);
        if (restoredWorkspaceRecoverySource?.storageKey === restoredRecoverySourceAtSaveStart.storageKey
            && restoredWorkspaceRecoverySource.raw === restoredRecoverySourceAtSaveStart.raw) {
            restoredWorkspaceRecoverySource = null;
        }
    }
    if (state.project?.id === authorityProjectId
        && state.project.version !== authorityVersionBeforeSave) {
        syncCopilotAuthorityState();
        if (state.view === 'copilot') renderCopilotWorkspace();
        refreshVisibleDashboard(authorityProjectId);
    }
    return true;
}

async function flushDirty() {
    state.saveInFlight = true;
    try {
        return await flushDirtyImpl();
    } finally {
        state.saveInFlight = false;
    }
}

function enqueueSave() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    saveQueue = saveQueue.then(flushDirty, flushDirty);
    return saveQueue;
}

function authorityMutationView() {
    return state.authorityMutation?.view || '';
}

function authorityMutationLocked() {
    return Boolean(authorityMutationView());
}

function syncShellInert() {
    elements.ss_shell.inert = state.navigationBusy || state.pendingChangeSetAdopting || state.adopting;
}

function setProjectControlsDisabled(disabled) {
    for (const element of [
        elements.ss_save,
        elements.ss_export,
        elements.ss_add_volume,
        elements.ss_add_chapter,
        elements.ss_generate,
    ]) {
        element.disabled = disabled;
    }
}

function syncAuthorityMutationUi() {
    const locked = authorityMutationLocked();
    elements.ss_project_select.disabled = locked || state.navigationBusy || state.projects.length === 0;
    elements.ss_new_project.disabled = locked || state.navigationBusy;
    for (const button of elements.viewTabs) button.disabled = locked;
    elements.ss_toggle_binder.disabled = locked
        || ['today', 'resources', 'copilot', 'quality'].includes(state.view);
    elements.ss_toggle_inspector.disabled = locked
        || ['today', 'resources', 'copilot', 'workflow', 'quality'].includes(state.view);
    syncResponsivePanels();
}

function beginAuthorityMutation(view) {
    const token = ++state.authorityMutationSerial;
    state.authorityMutation = { token, view };
    syncAuthorityMutationUi();
    return token;
}

function finishAuthorityMutation(token) {
    if (state.authorityMutation?.token !== token) return;
    state.authorityMutation = null;
    syncAuthorityMutationUi();
}

function setNavigationBusy(busy) {
    state.navigationBusy = busy;
    syncShellInert();
    elements.ss_create_project_form.inert = busy;
    elements.ss_project_select.disabled = busy || authorityMutationLocked() || state.projects.length === 0;
    elements.ss_new_project.disabled = busy || authorityMutationLocked();
    elements.story_studio_workspace.toggleAttribute('aria-busy', busy);
}

function cancelContextPreviewRequest() {
    if (state.contextPreviewController && !state.contextPreviewController.signal.aborted) {
        state.contextPreviewController.abort();
    }
    state.contextPreviewRequestSerial += 1;
    state.contextPreviewController = null;
}

function invalidateContextPreview() {
    cancelContextPreviewRequest();
    state.generationPreview = null;
    if (elements.ss_context_preview) {
        renderContextPreview();
        renderGenerationControls();
    }
}

function beginContextPreviewRequest() {
    cancelContextPreviewRequest();
    const controller = new AbortController();
    state.contextPreviewController = controller;
    return {
        controller,
        requestSerial: state.contextPreviewRequestSerial,
    };
}

function contextPreviewRequestIsCurrent(projectId, chapterId, navigationEpoch, requestSerial, controller) {
    return state.project?.id === projectId
        && state.chapter?.id === chapterId
        && state.navigationEpoch === navigationEpoch
        && state.contextPreviewRequestSerial === requestSerial
        && state.contextPreviewController === controller
        && !controller.signal.aborted;
}

function beginNavigation() {
    if (state.generationController && !state.generationController.signal.aborted) {
        state.generationController.abort();
    }
    cancelContextPreviewRequest();
    state.navigationEpoch += 1;
    setNavigationBusy(true);
    return state.navigationEpoch;
}

function confirmProjectReplacement(action) {
    const pending = [];
    if (state.profileEditorDirty) pending.push('Prompt Profile 草稿');
    if (pending.length === 0) return true;
    return window.confirm(`${pending.join('、')}尚未保存。${action}会放弃这些修改，是否继续？`);
}

function pendingChangeSetChapterLabel() {
    const summary = state.project?.chapters?.find(chapter => chapter.id === state.pendingChangeSetChapterId);
    return summary ? `第${summary.number}章` : '原章节';
}

async function preparePendingChangeSetNavigation(action) {
    const validation = pendingChangeSetValidation();
    const policy = pendingChangeSetNavigationPolicy({
        dirty: state.pendingChangeSetDirty,
        valid: !validation.error,
        adopting: state.pendingChangeSetAdopting,
    });
    if (policy === 'continue') return true;
    if (policy === 'block') {
        showToast('ChangeSet 正在原子采纳，暂时不能切换', 5000);
        return false;
    }
    if (policy === 'save') {
        const saved = savePendingChangeSet({ quiet: true });
        if (saved) showToast(`ChangeSet 已保存到${pendingChangeSetChapterLabel()}`);
        return saved;
    }
    if (!window.confirm(`本地 ChangeSet 格式错误：${validation.error}。${action}会丢弃尚未保存的修改，是否继续？`)) {
        return false;
    }
    setPendingChangeSetDraft(state.pendingChangeSetSaved);
    return true;
}

function isCurrentNavigation(epoch) {
    return epoch === state.navigationEpoch;
}

function finishNavigation(epoch, focusTarget = null) {
    if (!isCurrentNavigation(epoch)) return;
    setNavigationBusy(false);
    focusIfVisible(focusTarget);
}

function renderProjectSelect() {
    const selectedId = state.project?.id || '';
    elements.ss_project_select.replaceChildren();
    if (state.projects.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无作品';
        elements.ss_project_select.append(option);
        elements.ss_project_select.disabled = true;
        return;
    }

    elements.ss_project_select.disabled = state.navigationBusy || authorityMutationLocked();
    for (const project of state.projects) {
        const option = document.createElement('option');
        option.value = project.id;
        const title = project.title || '未命名作品';
        option.textContent = project.genre ? `${title} · ${project.genre}` : title;
        option.selected = project.id === selectedId;
        elements.ss_project_select.append(option);
    }
}

function renderEmptyState() {
    elements.ss_bootstrap_error.hidden = !state.bootstrapFailed;
    if (state.bootstrapFailed) {
        elements.ss_empty_state.hidden = true;
        elements.ss_shell.hidden = true;
        setProjectControlsDisabled(true);
        return;
    }
    const hasProject = Boolean(state.project);
    elements.ss_empty_state.hidden = hasProject;
    elements.ss_shell.hidden = !hasProject;
    setProjectControlsDisabled(!hasProject);
    if (!hasProject) {
        elements.ss_project_metrics.textContent = '0 字 · 0 章';
        elements.ss_progress.max = 1;
        elements.ss_progress.value = 0;
        elements.ss_progress.setAttribute('aria-valuemax', '1');
        elements.ss_progress.setAttribute('aria-valuenow', '0');
        elements.ss_progress.setAttribute('aria-valuetext', '暂无作品');
    }
}

function renderMetrics() {
    if (!state.project) return;
    const chapters = Array.isArray(state.project.chapters) ? state.project.chapters : [];
    const totalWords = chapters.reduce((total, chapter) => total + Number(chapter.wordCount || 0), 0);
    const targetWords = Math.max(1, Number(state.project.targetWords || 0));
    elements.ss_project_metrics.textContent = `${numberFormatter.format(totalWords)} 字 · ${chapters.length} 章`;
    elements.ss_progress.max = targetWords;
    elements.ss_progress.value = Math.min(totalWords, targetWords);
    elements.ss_progress.setAttribute('aria-valuemax', String(targetWords));
    elements.ss_progress.setAttribute('aria-valuenow', String(Math.min(totalWords, targetWords)));
    elements.ss_progress.setAttribute('aria-valuetext', `${numberFormatter.format(totalWords)} / ${numberFormatter.format(targetWords)} 字`);
}

function chapterActionButton(chapter, action, label, icon, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ss-icon-button ss-chapter-action';
    button.dataset.chapterAction = action;
    button.dataset.chapterActionId = chapter.id;
    button.disabled = disabled;
    button.title = label;
    button.setAttribute('aria-label', `${label}：${chapter.title || `第${chapter.number}章`}`);
    const image = document.createElement('img');
    image.className = 'ss-icon';
    image.src = `/icons/${icon}.svg`;
    image.alt = '';
    button.append(image);
    return button;
}

function volumeActionButton(volume, action, label, icon, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ss-icon-button ss-volume-action';
    button.dataset.volumeAction = action;
    button.dataset.volumeActionId = volume.id;
    button.disabled = disabled;
    button.title = label;
    button.setAttribute('aria-label', `${label}：${volume.title || `第${volume.number}卷`}`);
    const image = document.createElement('img');
    image.className = 'ss-icon';
    image.src = `/icons/${icon}.svg`;
    image.alt = '';
    button.append(image);
    return button;
}

function renderChapterList() {
    elements.ss_chapter_list.replaceChildren();
    if (!state.project) return;
    const query = elements.ss_chapter_search.value.trim();
    const tree = buildVolumeTree(state.project, query);
    if (tree.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ss-volume-empty';
        empty.textContent = '没有匹配的章节';
        elements.ss_chapter_list.append(empty);
        return;
    }

    const allVolumes = orderedVolumes();
    for (const group of tree) {
        const { volume, chapters, totalChapterCount } = group;
        const volumeIndex = allVolumes.findIndex(item => item.id === volume.id);
        const collapsed = !query && state.collapsedVolumeIds.has(volume.id);
        const section = document.createElement('section');
        section.className = 'ss-volume-group';
        section.dataset.volumeGroup = volume.id;
        section.setAttribute('role', 'group');
        section.setAttribute('aria-label', volume.title || `第${volume.number}卷`);

        const header = document.createElement('div');
        header.className = 'ss-volume-header';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ss-icon-button ss-volume-toggle';
        toggle.dataset.volumeToggle = volume.id;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}${volume.title || `第${volume.number}卷`}`);
        const toggleIcon = document.createElement('img');
        toggleIcon.className = 'ss-icon';
        toggleIcon.src = '/icons/chevron-down.svg';
        toggleIcon.alt = '';
        toggle.append(toggleIcon);

        const titleButton = document.createElement('button');
        titleButton.type = 'button';
        titleButton.className = 'ss-volume-title-button';
        titleButton.dataset.volumeAction = 'edit';
        titleButton.dataset.volumeActionId = volume.id;
        titleButton.title = '编辑卷纲';
        const title = document.createElement('strong');
        title.textContent = volume.title || `第${volume.number}卷`;
        const count = document.createElement('small');
        count.textContent = `第${volume.number}卷 · ${numberFormatter.format(totalChapterCount)} 章`;
        titleButton.append(title, count);

        const volumeActions = document.createElement('div');
        volumeActions.className = 'ss-volume-actions';
        volumeActions.append(
            volumeActionButton(volume, 'add-chapter', '在本卷新建章节', 'plus'),
            volumeActionButton(volume, 'up', '上移卷', 'arrow-up', Boolean(query) || volumeIndex === 0),
            volumeActionButton(volume, 'down', '下移卷', 'arrow-down', Boolean(query) || volumeIndex === allVolumes.length - 1),
            volumeActionButton(
                volume,
                'delete',
                totalChapterCount > 0 ? '卷内仍有章节' : '删除空卷',
                'trash-2',
                totalChapterCount > 0 || orderedVolumes().length === 1,
            ),
        );
        header.append(toggle, titleButton, volumeActions);

        const list = document.createElement('ol');
        list.className = 'ss-volume-chapters';
        list.hidden = collapsed;
        list.setAttribute('role', 'group');
        if (chapters.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'ss-volume-empty';
            empty.textContent = query ? '没有匹配章节' : '空卷';
            list.append(empty);
        }
        for (const [chapterIndex, chapter] of chapters.entries()) {
            const item = document.createElement('li');
            item.className = 'ss-chapter-row';
            item.dataset.chapterRow = chapter.id;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ss-chapter-button';
            button.dataset.chapterId = chapter.id;
            button.setAttribute('role', 'treeitem');
            button.setAttribute('aria-label', `打开第${chapter.number}章：${chapter.title}`);
            if (chapter.id === state.chapter?.id) {
                button.classList.add('is-active');
                button.setAttribute('aria-current', 'true');
            }

            const number = document.createElement('span');
            number.className = 'ss-chapter-number';
            number.textContent = String(chapter.number).padStart(2, '0');

            const copy = document.createElement('span');
            copy.className = 'ss-chapter-copy';
            const chapterTitle = document.createElement('strong');
            chapterTitle.textContent = chapter.title || `第${chapter.number}章`;
            const status = document.createElement('small');
            const stale = isChapterPlanStale(state.project, chapter);
            status.textContent = `${STATUS_LABELS[chapter.status] || chapter.status || '待写'} · ${numberFormatter.format(Number(chapter.wordCount || 0))} 字${stale ? ' · 待复核' : ''}`;
            if (stale) status.title = '所属卷纲已更新，请复核并保存章纲';
            copy.append(chapterTitle, status);

            button.append(number, copy);
            const actions = document.createElement('div');
            actions.className = 'ss-chapter-actions';
            actions.setAttribute('aria-label', `管理${chapter.title || `第${chapter.number}章`}`);
            actions.append(
                chapterActionButton(chapter, 'up', '在卷内上移章节', 'arrow-up', chapterIndex === 0 || Boolean(query)),
                chapterActionButton(chapter, 'down', '在卷内下移章节', 'arrow-down', chapterIndex === chapters.length - 1 || Boolean(query)),
                chapterActionButton(chapter, 'delete', '删除章节', 'trash-2'),
            );
            item.append(button, actions);
            list.append(item);
        }
        section.append(header, list);
        elements.ss_chapter_list.append(section);
    }
}

function renderEditor() {
    const chapter = state.chapter;
    elements.ss_chapter_title.disabled = !chapter;
    elements.ss_chapter_volume.disabled = !chapter || state.structureBusy;
    elements.ss_chapter_status.disabled = !chapter;
    elements.ss_manuscript.disabled = !chapter;
    elements.ss_chapter_volume.replaceChildren();
    if (!chapter) {
        elements.ss_editor_breadcrumb.textContent = '';
        elements.ss_chapter_title.value = '';
        elements.ss_chapter_volume.value = '';
        elements.ss_chapter_status.value = 'planned';
        elements.ss_manuscript.value = '';
        elements.ss_chapter_count.textContent = '0 字';
        elements.ss_chapter_updated.textContent = '';
        return;
    }
    const volume = volumeForChapter(state.project, chapter);
    elements.ss_editor_breadcrumb.textContent = volume
        ? `${volume.title || `第${volume.number}卷`} / 第${chapter.number}章`
        : `第${chapter.number}章`;
    for (const item of orderedVolumes()) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.number}. ${item.title || `第${item.number}卷`}`;
        elements.ss_chapter_volume.append(option);
    }
    elements.ss_chapter_title.value = chapter.title || '';
    elements.ss_chapter_volume.value = chapter.volumeId || '';
    elements.ss_chapter_status.value = chapter.status || 'planned';
    elements.ss_manuscript.value = chapter.content || '';
    renderChapterCount();
    elements.ss_chapter_updated.textContent = chapter.updatedAt ? `更新于 ${formatDate(chapter.updatedAt)}` : '';
}

function renderChapterCount() {
    const count = countContentUnits(state.chapter?.content || '');
    elements.ss_chapter_count.textContent = `${numberFormatter.format(count)} 字`;
}

function versionIdOf(version) {
    return String(version?.versionId || version?.id || '');
}

function versionCacheMatchesChapter(chapter = state.chapter) {
    return Boolean(chapter)
        && state.versionsChapterId === chapter.id
        && state.versionsChapterRevision === chapter.revision;
}

function clearVersionCacheIdentity() {
    state.versionsChapterId = '';
    state.versionsChapterRevision = null;
    state.versionUnitCounts.clear();
}

function focusedVersionId() {
    const button = document.activeElement?.closest?.('[data-version-id]');
    return button && elements.ss_versions_list.contains(button) ? button.dataset.versionId : '';
}

function focusVersionButton(versionId) {
    if (!versionId) return;
    const button = [...elements.ss_versions_list.querySelectorAll('[data-version-id]')]
        .find(item => item.dataset.versionId === versionId);
    if (!button || button.disabled) return;
    button.focus({ preventScroll: true });
}

function versionSourceLabel(source) {
    return VERSION_SOURCE_LABELS[source] || source || '自动保存';
}

function countContentLines(value) {
    const content = String(value || '');
    return content ? content.split(/\r\n|\r|\n/).length : 0;
}

function versionDifferences(snapshot) {
    const chapter = state.chapter;
    if (!snapshot || !chapter) return [];
    const differences = [];
    if ((snapshot.title || '') !== (chapter.title || '')) differences.push('标题有变化');
    if ((snapshot.status || 'planned') !== (chapter.status || 'planned')) differences.push('状态有变化');
    const snapshotContent = snapshot.content || '';
    const currentContent = chapter.content || '';
    if (snapshotContent !== currentContent) {
        const delta = countContentUnits(currentContent) - countContentUnits(snapshotContent);
        if (delta === 0) {
            differences.push('正文内容不同，字数相同');
        } else {
            differences.push(`当前正文${delta > 0 ? '多' : '少'} ${numberFormatter.format(Math.abs(delta))} 字`);
        }
        const lineDelta = countContentLines(currentContent) - countContentLines(snapshotContent);
        if (lineDelta !== 0) differences.push(`当前正文${lineDelta > 0 ? '多' : '少'} ${Math.abs(lineDelta)} 行`);
    }
    if (JSON.stringify(snapshot.card || {}) !== JSON.stringify(chapter.card || {})) differences.push('章纲有变化');
    if ((snapshot.review || '') !== (chapter.review || '')) differences.push('审校记录有变化');
    if ((snapshot.notes || '') !== (chapter.notes || '')) differences.push('作者备注有变化');
    return differences;
}

function renderVersionHistory({ focusVersionId = '' } = {}) {
    const currentFocusedVersionId = focusedVersionId();
    const versionIdToFocus = focusVersionId || currentFocusedVersionId;
    const shouldRestoreVersionFocus = Boolean(currentFocusedVersionId);
    const hasChapter = Boolean(state.chapter);
    elements.ss_versions_list.replaceChildren();
    for (const version of state.versions) {
        const versionId = versionIdOf(version);
        if (!versionId) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ss-version-row';
        button.dataset.versionId = versionId;
        const active = versionId === state.selectedVersionId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.disabled = state.versionsLoading || state.versionRestoring || !hasChapter;

        const revision = document.createElement('span');
        revision.className = 'ss-version-revision';
        revision.textContent = `r${numberFormatter.format(Number(version.chapterRevision || 0))}`;
        const copy = document.createElement('span');
        copy.className = 'ss-version-copy';
        const title = document.createElement('strong');
        title.textContent = version.title || state.chapter?.title || '未命名章节';
        const meta = document.createElement('small');
        const metadata = [versionSourceLabel(version.source)];
        const contentUnits = state.versionUnitCounts.get(versionId);
        if (Number.isInteger(contentUnits)) metadata.push(`${numberFormatter.format(contentUnits)} 字`);
        metadata.push(formatDate(version.createdAt));
        meta.textContent = metadata.filter(Boolean).join(' · ');
        copy.append(title, meta);
        button.append(revision, copy);
        elements.ss_versions_list.append(button);
    }

    elements.ss_versions_empty.hidden = state.versionsLoading || state.versions.length > 0;
    elements.ss_versions_empty.textContent = hasChapter ? '暂无版本' : '请先选择章节';
    elements.ss_refresh_versions.disabled = !hasChapter || state.versionsLoading || state.versionRestoring;

    const snapshot = state.selectedVersion;
    elements.ss_version_detail_empty.hidden = Boolean(snapshot);
    elements.ss_version_detail_content.hidden = !snapshot;
    if (!snapshot) {
        elements.ss_version_detail_empty.textContent = state.versionDetailLoading ? '正在载入版本快照' : '选择版本查看快照';
    } else {
        elements.ss_version_detail_source.textContent = versionSourceLabel(snapshot.source);
        elements.ss_version_detail_title.textContent = snapshot.title || '未命名章节';
        elements.ss_version_detail_time.textContent = formatDate(snapshot.createdAt);
        elements.ss_version_detail_time.dateTime = snapshot.createdAt || '';
        elements.ss_version_metrics.replaceChildren(
            tag(`章节 r${numberFormatter.format(Number(snapshot.chapterRevision || 0))}`),
            tag(`${numberFormatter.format(countContentUnits(snapshot.content || ''))} 字`),
            tag(`${countContentLines(snapshot.content)} 行`),
            tag(STATUS_LABELS[snapshot.status] || snapshot.status || '待写'),
        );
        const differences = versionDifferences(snapshot);
        elements.ss_version_diff.replaceChildren();
        if (differences.length === 0) {
            const same = document.createElement('span');
            same.className = 'ss-version-same';
            same.textContent = '与当前章节一致';
            elements.ss_version_diff.append(same);
        } else {
            for (const difference of differences) {
                const row = document.createElement('span');
                row.textContent = difference;
                elements.ss_version_diff.append(row);
            }
        }
        elements.ss_version_content.textContent = snapshot.content || '';
    }

    elements.ss_restore_version.disabled = !snapshot || versionIdOf(snapshot) === 'current' || snapshot.isCurrent
        || state.versionRestoring || state.versionDetailLoading || state.navigationBusy;
    elements.ss_versions_status.textContent = state.versionsError
        || (state.versionRestoring ? '正在恢复版本'
            : state.versionsLoading ? '正在载入版本'
                : state.versionDetailLoading ? '正在载入快照'
                    : hasChapter ? `${numberFormatter.format(state.versions.length)} 个版本` : '');
    elements.ss_versions_status.dataset.state = state.versionsError ? 'error' : '';
    if (shouldRestoreVersionFocus) focusVersionButton(versionIdToFocus);
}

function renderBible() {
    if (!state.project) return;
    for (const input of elements.storyFields) {
        input.value = state.project.story?.[input.dataset.storyField] || '';
    }
    for (const input of elements.projectFields) {
        input.value = state.project[input.dataset.projectField] ?? '';
    }
    selectVolumeId(state.project);
    const volumes = orderedVolumes();
    const volume = selectedVolume();
    elements.ss_volume_outline_select.replaceChildren();
    for (const item of volumes) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.number}. ${item.title || `第${item.number}卷`}`;
        elements.ss_volume_outline_select.append(option);
    }
    elements.ss_volume_outline_select.value = volume?.id || '';
    elements.ss_volume_outline_select.disabled = !volume || state.structureBusy;
    for (const input of elements.volumeFields) {
        input.disabled = !volume;
        input.value = volume?.[input.dataset.volumeField] || '';
    }
    const index = volumes.findIndex(item => item.id === volume?.id);
    const chapterCount = state.project.chapters?.filter(chapter => chapter.volumeId === volume?.id).length || 0;
    elements.ss_volume_revision.textContent = volume
        ? `r${volume.revision} · ${numberFormatter.format(chapterCount)} 章`
        : '';
    elements.ss_volume_move_up.disabled = !volume || index <= 0 || state.structureBusy;
    elements.ss_volume_move_down.disabled = !volume || index < 0 || index >= volumes.length - 1 || state.structureBusy;
    elements.ss_volume_delete.disabled = !volume || volumes.length === 1 || chapterCount > 0 || state.structureBusy;
}

function createSelect(options, selectedValue, ariaLabel) {
    const select = document.createElement('select');
    select.className = 'ss-control';
    select.setAttribute('aria-label', ariaLabel);
    const values = { ...options };
    if (selectedValue && !(selectedValue in values)) {
        values[selectedValue] = selectedValue;
    }
    for (const [value, label] of Object.entries(values)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === selectedValue;
        select.append(option);
    }
    return select;
}

function renderLedger() {
    elements.ss_ledger_list.replaceChildren();
    const entries = state.project?.continuity || [];
    elements.ss_ledger_empty.hidden = entries.length > 0;
    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'ss-legacy-continuity-row';
        const heading = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = entry.label || '未命名条目';
        const meta = document.createElement('span');
        meta.textContent = [CATEGORY_LABELS[entry.category] || entry.category, CONTINUITY_STATUS_LABELS[entry.status] || entry.status]
            .filter(Boolean).join(' · ');
        heading.append(label, meta);
        const detail = document.createElement('p');
        detail.textContent = entry.detail || '无详情';
        const chapter = document.createElement('small');
        const first = Number(entry.firstSeenChapter || 0);
        const last = Number(entry.lastTouchedChapter || 0);
        chapter.textContent = first || last ? `章节序号 ${first || '?'} → ${last || '?'}` : '未标记章节';
        row.append(heading, detail, chapter);
        elements.ss_ledger_list.append(row);
    }
}

function emptyStoryState() {
    return Object.fromEntries(Object.keys(CHANGESET_LABELS).map(key => [key, []]));
}

function emptyPendingChangeSet() {
    return {
        chapterSummary: '',
        storyStateChanges: Object.fromEntries(
            Object.keys(CHANGESET_LABELS).map(key => [key, { upsert: [], delete: [] }]),
        ),
    };
}

function legacyPendingChangeSetStorageKey(projectId) {
    return `story-studio:pending-changeset:${projectId}`;
}

function loadPendingChangeSetDraft(project, chapter) {
    const fallback = JSON.stringify(emptyPendingChangeSet(), null, 2);
    const storageKey = pendingChangeSetDraftStorageKey(project?.id, chapter?.id);
    if (!storageKey) return fallback;
    try {
        const stored = window.localStorage.getItem(storageKey);
        if (stored) return stored;
        const legacyKey = legacyPendingChangeSetStorageKey(project.id);
        const legacy = window.localStorage.getItem(legacyKey);
        if (!legacy) return fallback;
        window.localStorage.setItem(storageKey, legacy);
        window.localStorage.removeItem(legacyKey);
        return legacy;
    } catch {
        return fallback;
    }
}

function pendingChangeSetBindingMatches(projectId, chapterId) {
    return state.pendingChangeSetProjectId === projectId
        && state.pendingChangeSetChapterId === chapterId;
}

function bindPendingChangeSetDraft(project, chapter) {
    state.pendingChangeSetProjectId = project?.id || '';
    state.pendingChangeSetChapterId = chapter?.id || '';
    state.pendingChangeSetSaved = loadPendingChangeSetDraft(project, chapter);
    state.pendingChangeSetDraft = state.pendingChangeSetSaved;
    state.pendingChangeSetDirty = false;
    state.pendingChangeSetError = '';
    state.pendingChangeSetAdopting = false;
}

function storyEntityLabel(entityId) {
    if (!entityId) return '未关联';
    const entity = state.project?.storyState?.entities?.find(item => item.id === entityId);
    return entity?.name ? `${entity.name} (${entityId})` : entityId;
}

function storyFactLabel(factId) {
    if (!factId) return '未关联';
    const fact = state.project?.storyState?.facts?.find(item => item.id === factId);
    return fact?.summary || factId;
}

function storyTimelineLabel(timelineId) {
    if (!timelineId) return '未关联';
    const timeline = state.project?.storyState?.timeline?.find(item => item.id === timelineId);
    return timeline?.label ? `${timeline.label} (${timelineId})` : timelineId;
}

function continuityChapterIds(category, record) {
    const values = {
        facts: [record.sourceChapterId],
        knowledge: [record.learnedChapterId],
        timeline: [record.chapterId],
        relations: [record.sinceChapterId],
        promises: [
            record.introducedChapterId,
            record.dueChapterId,
            record.resolvedChapterId,
            ...(Array.isArray(record.evidenceChapterIds) ? record.evidenceChapterIds : []),
        ],
        events: [record.chapterId],
    }[category] || [];
    return [...new Set(values.filter(Boolean))];
}

function chapterReferenceButton(chapterId) {
    const summary = state.project?.chapters?.find(chapter => chapter.id === chapterId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ss-chapter-reference';
    button.setAttribute('data-continuity-chapter-id', chapterId);
    button.textContent = summary
        ? `第${summary.number}章 ${summary.title || ''}`.trim()
        : chapterId;
    button.title = summary ? `打开第${summary.number}章` : `打开章节 ${chapterId}`;
    return button;
}

function continuityRecordFields(category, record) {
    if (category === 'facts') {
        return [
            ['主体', storyEntityLabel(record.subjectEntityId)],
            ['置信度', record.confidence ?? '未标记'],
            ['标签', Array.isArray(record.tags) ? record.tags.join('、') : ''],
            ['取代者', record.supersededById || '无'],
        ];
    }
    if (category === 'knowledge') {
        return [
            ['人物', storyEntityLabel(record.entityId)],
            ['立场', KNOWLEDGE_STANCE_LABELS[record.stance] || record.stance],
            ['关联事实', storyFactLabel(record.factId)],
        ];
    }
    if (category === 'timeline') {
        return [
            ['故事时间', record.storyTime],
            ['序号', record.sequence ?? 0],
            ['地点', storyEntityLabel(record.locationEntityId)],
        ];
    }
    if (category === 'relations') {
        return [
            ['双方', `${storyEntityLabel(record.fromEntityId)} → ${storyEntityLabel(record.toEntityId)}`],
            ['关系', record.kind],
            ['称呼', record.addressing],
            ['公开层', record.publicSummary],
            ['私下层', record.privateSummary],
        ];
    }
    if (category === 'promises') {
        return [
            ['类型', record.kind],
            ['紧急度', `${record.urgency ?? 0} / 5`],
            ['到期章节', record.dueChapterId || '未设定'],
        ];
    }
    return [
        ['类型', record.kind],
        ['进度', `${record.progress ?? 0}%`],
        ['可见范围', record.visibility],
        ['时间线', storyTimelineLabel(record.timelineId)],
        ['地点', storyEntityLabel(record.locationEntityId)],
        ['涉及实体', Array.isArray(record.entityIds) ? record.entityIds.map(storyEntityLabel).join('、') : ''],
    ];
}

function continuityRecordTitle(category, record) {
    if (category === 'facts') return record.summary || record.id;
    if (category === 'knowledge') return `${storyEntityLabel(record.entityId)} · ${KNOWLEDGE_STANCE_LABELS[record.stance] || record.stance || '未标记'}`;
    if (category === 'timeline') return record.label || record.id;
    if (category === 'relations') return `${storyEntityLabel(record.fromEntityId)} → ${storyEntityLabel(record.toEntityId)}`;
    return record.title || record.summary || record.id;
}

function renderContinuityRecords(storyState) {
    const category = state.continuityView;
    const records = Array.isArray(storyState[category]) ? storyState[category] : [];
    elements.ss_continuity_records.replaceChildren();
    elements.ss_continuity_empty.hidden = records.length > 0;
    for (const record of records) {
        const row = document.createElement('article');
        row.className = 'ss-continuity-record';
        row.setAttribute('role', 'listitem');
        row.dataset.continuityRecordId = record.id;
        row.tabIndex = -1;
        if (record.id === state.continuityRecordId) row.setAttribute('aria-current', 'true');

        const header = document.createElement('header');
        const heading = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = continuityRecordTitle(category, record);
        const id = document.createElement('code');
        id.textContent = record.id;
        heading.append(title, id);
        const status = tag(record.status || '未标记', record.status === 'active' || record.status === 'open' ? 'active' : '');
        header.append(heading, status);

        if (record.summary && category !== 'facts') {
            const summary = document.createElement('p');
            summary.textContent = record.summary;
            row.append(header, summary);
        } else {
            row.append(header);
        }

        const fields = document.createElement('dl');
        for (const [label, value] of continuityRecordFields(category, record)) {
            if (value === undefined || value === null || value === '') continue;
            const term = document.createElement('dt');
            term.textContent = label;
            const detail = document.createElement('dd');
            detail.textContent = String(value);
            fields.append(term, detail);
        }
        if (fields.childElementCount > 0) row.append(fields);

        const footer = document.createElement('footer');
        const sources = document.createElement('div');
        sources.className = 'ss-continuity-sources';
        for (const chapterId of continuityChapterIds(category, record)) {
            sources.append(chapterReferenceButton(chapterId));
        }
        if (sources.childElementCount === 0) {
            const noSource = document.createElement('span');
            noSource.textContent = '无来源章节';
            sources.append(noSource);
        }
        const addPending = document.createElement('button');
        addPending.type = 'button';
        addPending.className = 'ss-icon-button';
        addPending.setAttribute('data-pending-upsert-category', category);
        addPending.setAttribute('data-pending-upsert-id', record.id);
        addPending.title = '加入本地 ChangeSet';
        addPending.setAttribute('aria-label', `将 ${record.id} 加入本地 ChangeSet`);
        const icon = document.createElement('img');
        icon.className = 'ss-icon';
        icon.src = '/icons/clipboard-plus.svg';
        icon.alt = '';
        addPending.append(icon);
        footer.append(sources, addPending);
        row.append(footer);
        elements.ss_continuity_records.append(row);
    }
}

function renderGenerationPendingChangeSet() {
    const distillation = state.activeGeneration?.distillation || { status: 'none', changes: null };
    const statusLabels = { none: '当前候选无变更', ready: '待原子采纳', failed: '蒸馏失败' };
    elements.ss_generation_changeset_status.textContent = statusLabels[distillation.status]
        || distillation.status || statusLabels.none;
    elements.ss_generation_changeset_status.dataset.state = distillation.status === 'failed' ? 'error' : '';
    const changes = distillation.changes;
    elements.ss_generation_changeset_summary.textContent = changes?.chapterSummary
        || distillation.error
        || '暂无模型 ChangeSet';
    elements.ss_generation_changeset_counts.replaceChildren();
    for (const [key, label] of Object.entries(CHANGESET_LABELS)) {
        const count = changesetMutationCount(changes?.storyStateChanges?.[key]);
        if (count.total > 0) {
            elements.ss_generation_changeset_counts.append(tag(`${label} +${count.upsert}/-${count.removed}`));
        }
    }
    elements.ss_generation_changeset_json.textContent = changes ? JSON.stringify(changes, null, 2) : '';
}

function pendingChangeSetValidation(text = state.pendingChangeSetDraft) {
    try {
        const parsed = JSON.parse(text);
        const result = validatePendingChangeSetValue(parsed, {
            storyState: state.project?.storyState || {},
            chapterIds: (state.project?.chapters || []).map(chapter => chapter.id),
            boundChapterId: state.pendingChangeSetChapterId,
        });
        return {
            value: parsed,
            error: result.errors[0] || '',
            warnings: result.warnings,
        };
    } catch (error) {
        return { value: null, error: error.message || '无效 JSON', warnings: [] };
    }
}

function pendingChangeSetMutationTotal(value) {
    return Object.keys(CHANGESET_LABELS).reduce((total, key) => {
        const mutation = value?.storyStateChanges?.[key];
        return total + (Array.isArray(mutation?.upsert) ? mutation.upsert.length : 0)
            + (Array.isArray(mutation?.delete) ? mutation.delete.length : 0);
    }, 0);
}

function renderPendingChangeSet() {
    if (elements.ss_pending_changeset_json.value !== state.pendingChangeSetDraft) {
        elements.ss_pending_changeset_json.value = state.pendingChangeSetDraft;
    }
    const validation = pendingChangeSetValidation();
    state.pendingChangeSetError = validation.error;
    elements.ss_pending_changeset_status.textContent = state.pendingChangeSetAdopting
        ? '正在原子采纳'
        : validation.error
            ? `格式错误：${validation.error}`
            : validation.warnings?.length > 0
                ? `校验警告：${validation.warnings[0]}`
                : state.pendingChangeSetDirty ? '尚未保存到本地' : '已保存在此浏览器';
    elements.ss_pending_changeset_status.dataset.state = validation.error
        ? 'error' : validation.warnings?.length > 0 || state.pendingChangeSetDirty ? 'dirty' : 'saved';
    const disabled = !state.project || state.pendingChangeSetAdopting;
    elements.ss_pending_changeset_json.disabled = disabled;
    elements.ss_adopt_pending_changeset.disabled = disabled || !state.chapter || Boolean(validation.error)
        || pendingChangeSetMutationTotal(validation.value) === 0;
    elements.ss_save_pending_changeset.disabled = disabled || !state.pendingChangeSetDirty || Boolean(validation.error);
    elements.ss_revert_pending_changeset.disabled = disabled || !state.pendingChangeSetDirty;
    elements.ss_clear_pending_changeset.disabled = disabled;
    elements.ss_copy_pending_changeset.disabled = disabled || Boolean(validation.error);
}

function resetProjectAuxiliaryState() {
    state.resourceRequestSerial += 1;
    state.resources = [];
    state.selectedResource = null;
    state.resourceBusy = false;
    state.profileEditor = null;
    state.profileEditorBaseline = '';
    state.profileEditorDirty = false;
    state.profileEditorTab = 'overview';
    state.profileCompileResult = null;
    state.profileCompileError = '';
    state.profileConflictMessage = '';
    state.continuityView = 'facts';
    state.continuityRecordId = '';
}

function renderStoryState() {
    const storyState = { ...emptyStoryState(), ...(state.project?.storyState || {}) };
    elements.ss_story_state_counts.replaceChildren();
    for (const [key, label] of Object.entries(CHANGESET_LABELS)) {
        elements.ss_story_state_counts.append(tag(`${label} ${(storyState[key] || []).length}`));
    }
    const storyStateJson = JSON.stringify(storyState, null, 2);
    if (elements.ss_story_state_json.value !== storyStateJson) {
        elements.ss_story_state_json.value = storyStateJson;
    }
    elements.ss_story_state_json.disabled = !state.project;
    elements.ss_story_state_status.textContent = state.project ? '权威状态只读' : '';
    elements.ss_story_state_status.dataset.state = state.project ? 'saved' : '';
    for (const button of elements.ss_continuity_tabs.querySelectorAll('[data-continuity-view]')) {
        const active = button.dataset.continuityView === state.continuityView;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    }
    renderContinuityRecords(storyState);
    renderGenerationPendingChangeSet();
    renderPendingChangeSet();
}

function focusContinuityRecord(recordId, { notify = true } = {}) {
    if (!recordId) return false;
    const row = [...elements.ss_continuity_records.querySelectorAll('[data-continuity-record-id]')]
        .find(candidate => candidate.dataset.continuityRecordId === recordId);
    if (!row) {
        if (notify) showToast('对应伏笔已变化，请刷新今日工作台', 5000);
        return false;
    }
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
    return true;
}

function resourceControl(label, input) {
    const wrapper = document.createElement('label');
    wrapper.className = 'ss-resource-control';
    const text = document.createElement('span');
    text.textContent = label;
    wrapper.append(input, text);
    return wrapper;
}

function resourceRadio(name, value, checked, datasetField) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.disabled = state.resourceBusy;
    input.dataset[datasetField] = value;
    return input;
}

function initializeProfileEditor(resource) {
    if (!isPromptProfileV2(resource)) {
        state.profileEditor = null;
        state.profileEditorBaseline = '';
        state.profileEditorDirty = false;
        state.profileCompileResult = null;
        state.profileCompileError = '';
        state.profileConflictMessage = '';
        return;
    }
    state.profileEditor = createProfileEditorDraft(resource);
    state.profileEditorBaseline = profileDraftFingerprint(state.profileEditor);
    state.profileEditorDirty = false;
    state.profileEditorTab = 'overview';
    state.profileCompileResult = null;
    state.profileCompileError = '';
    state.profileConflictMessage = '';
}

function profileReportRow(code, message, tone = '') {
    const row = document.createElement('div');
    row.className = 'ss-profile-report-row';
    if (tone) row.dataset.tone = tone;
    const key = document.createElement('strong');
    key.textContent = code;
    const value = document.createElement('span');
    value.textContent = message;
    row.append(key, value);
    return row;
}

function renderProfileCompatibility(report, metaContainer, warningsContainer) {
    const meta = [
        tag(report.mode === 'v2' ? 'Profile V2' : 'Legacy', report.mode === 'v2' ? 'active' : 'warning'),
        tag(report.sourceFormat),
    ];
    if (report.promptOrderMode) meta.push(tag(`order:${report.promptOrderMode}`));
    if (report.selectedCharacterId) meta.push(tag(`character:${report.selectedCharacterId}`));
    for (const value of report.unsupportedFeatures) meta.push(tag(`unsupported:${value}`, 'warning'));
    for (const field of report.removedSensitiveFields) meta.push(tag(`removed:${field}`, 'active'));
    metaContainer.replaceChildren(...meta);
    const rows = report.warnings.map(item => profileReportRow(
        String(item?.code || 'warning'),
        [item?.message, item?.moduleId ? `模块 ${item.moduleId}` : ''].filter(Boolean).join(' · '),
        'warning',
    ));
    warningsContainer.replaceChildren(...(rows.length > 0 ? rows : [profileReportRow('ok', '无兼容警告')]));
}

function renderResourceCompatibility(resource) {
    const hidden = !resource || resource.type === 'prompt-profile';
    elements.ss_resource_compatibility.hidden = hidden;
    if (hidden) {
        elements.ss_resource_compatibility_meta.replaceChildren();
        elements.ss_resource_compatibility_warnings.replaceChildren();
        return;
    }
    const report = buildResourceCompatibilityReport(resource);
    const hasEvidence = report.sourceFormat !== 'native'
        || report.warnings.length > 0
        || report.unsupportedFeatures.length > 0
        || report.removedSensitiveFields.length > 0;
    elements.ss_resource_compatibility.hidden = !hasEvidence;
    if (!hasEvidence) {
        elements.ss_resource_compatibility_meta.replaceChildren();
        elements.ss_resource_compatibility_warnings.replaceChildren();
        return;
    }
    const meta = [tag(report.sourceFormat)];
    for (const value of report.unsupportedFeatures) meta.push(tag(`unsupported:${value}`, 'warning'));
    for (const field of report.removedSensitiveFields) meta.push(tag(`removed:${field}`, 'active'));
    elements.ss_resource_compatibility_meta.replaceChildren(...meta);
    const rows = report.warnings.map(item => profileReportRow(
        String(item?.code || 'warning'),
        String(item?.message || item?.code || '存在兼容差异'),
        'warning',
    ));
    elements.ss_resource_compatibility_warnings.replaceChildren(...(
        rows.length > 0
            ? rows
            : [profileReportRow('ok', '已识别来源格式，当前没有已知兼容告警')]
    ));
}

function setProfileEditorTab(tab) {
    if (!elements.profileTabs?.some(button => button.dataset.profileTab === tab)) return;
    state.profileEditorTab = tab;
    for (const button of elements.profileTabs) {
        const active = button.dataset.profileTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    }
    for (const panel of elements.profilePanels) panel.hidden = panel.dataset.profilePanel !== tab;
}

function renderProfileTaskOptions() {
    const selected = elements.ss_profile_preview_task.value;
    elements.ss_profile_preview_task.replaceChildren();
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = '默认';
    elements.ss_profile_preview_task.append(fallback);
    for (const task of profileTaskNames(state.profileEditor)) {
        const option = document.createElement('option');
        option.value = task;
        option.textContent = task;
        elements.ss_profile_preview_task.append(option);
    }
    elements.ss_profile_preview_task.value = [...elements.ss_profile_preview_task.options]
        .some(option => option.value === selected) ? selected : '';
}

function profileModuleRow(module, compiled = null) {
    const row = document.createElement('div');
    row.className = 'ss-profile-module-row';
    const included = compiled?.included !== false;
    if (!included || compiled?.truncated) row.dataset.tone = 'warning';
    const identity = document.createElement('strong');
    identity.textContent = module?.id || compiled?.id || 'unknown';
    const role = document.createElement('span');
    role.textContent = module?.role || compiled?.role || '-';
    const slot = document.createElement('span');
    slot.textContent = module?.slot || compiled?.slot || '-';
    const metrics = document.createElement('span');
    const original = Number(compiled?.originalCharacters ?? module?.originalCharacters ?? 0);
    const current = Number(compiled?.compiledCharacters ?? module?.characters ?? 0);
    metrics.textContent = [
        `${numberFormatter.format(current)}/${numberFormatter.format(original)} 字符`,
        Number(module?.tokens ?? compiled?.tokens ?? 0) ? `${numberFormatter.format(Number(module?.tokens ?? compiled?.tokens))} tokens` : '',
        compiled?.truncated ? '已裁剪' : '',
        included ? '' : String(compiled?.reason || '未注入'),
    ].filter(Boolean).join(' · ');
    row.append(identity, role, slot, metrics);
    return row;
}

function renderProfileCompileResult() {
    const result = state.profileCompileResult;
    const error = state.profileCompileError;
    elements.ss_profile_compile_issues.replaceChildren();
    elements.ss_profile_compile_modules.replaceChildren();
    elements.ss_profile_compile_messages.textContent = '';
    elements.ss_profile_compile_generation.textContent = '';
    if (error) {
        elements.ss_profile_compile_status.textContent = error;
        elements.ss_profile_compile_status.dataset.state = 'error';
        return;
    }
    if (!result) {
        elements.ss_profile_compile_status.textContent = '';
        delete elements.ss_profile_compile_status.dataset.state;
        return;
    }
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    elements.ss_profile_compile_status.textContent = errors.length > 0
        ? `${errors.length} 项错误 · ${warnings.length} 项警告`
        : `${result.modules.length} 个模块 · ${result.profileHash.slice(0, 12)}`;
    elements.ss_profile_compile_status.dataset.state = errors.length > 0 ? 'error' : 'saved';
    elements.ss_profile_compile_issues.replaceChildren(...[
        ...errors.map(item => tag(String(item?.code || item?.message || 'error'), 'warning')),
        ...warnings.map(item => tag(String(item?.code || item?.message || 'warning'), 'warning')),
    ]);
    const publicModules = new Map(result.modules.map(module => [module.id, module]));
    try {
        for (const module of buildProfileChanges(state.profileEditor).modules) {
            if (!publicModules.has(module.id)) publicModules.set(module.id, module);
        }
    } catch {
        // The compiler error list is already visible above.
    }
    const diagnostics = Array.isArray(result.diagnostics?.modules) ? result.diagnostics.modules : [];
    elements.ss_profile_compile_modules.replaceChildren(...diagnostics.map(module => (
        profileModuleRow(publicModules.get(module.id), module)
    )));
    elements.ss_profile_compile_messages.textContent = JSON.stringify(result.messages, null, 2);
    elements.ss_profile_compile_generation.textContent = JSON.stringify(result.generation, null, 2);
}

function renderProfileEditor(resource) {
    const v2 = isPromptProfileV2(resource);
    const legacy = resource?.type === 'prompt-profile' && !v2;
    elements.ss_profile_editor.hidden = !v2;
    elements.ss_profile_legacy.hidden = !legacy;
    if (legacy) {
        renderProfileCompatibility(
            buildCompatibilityReport(resource),
            elements.ss_profile_legacy_meta,
            elements.ss_profile_legacy_warnings,
        );
        return;
    }
    if (!v2) return;
    if (!state.profileEditor || state.profileEditor.resourceId !== resource.id) initializeProfileEditor(resource);
    const draft = state.profileEditor;
    elements.ss_profile_name.value = draft.name;
    elements.ss_profile_token_budget.value = draft.tokenBudget;
    elements.ss_profile_character_budget.value = draft.characterBudget;
    elements.ss_profile_generation.value = draft.generationText;
    elements.ss_profile_modules.value = draft.modulesText;
    elements.ss_profile_order.value = draft.orderText;
    elements.ss_profile_variables.value = draft.variablesText;
    elements.ss_profile_variable_values.value = draft.variableValuesText;
    elements.ss_profile_generation_policies.value = draft.generationPoliciesText;
    elements.ss_profile_task_policies.value = draft.taskPoliciesText;
    const disabled = state.resourceBusy;
    for (const input of elements.profileFields) input.disabled = disabled;
    elements.ss_profile_revert.disabled = disabled || !state.profileEditorDirty;
    elements.ss_profile_save.disabled = disabled || !state.profileEditorDirty;
    elements.ss_profile_compile.disabled = disabled;
    elements.ss_profile_status.textContent = disabled
        ? '保存中'
        : state.profileConflictMessage || (state.profileEditorDirty ? '未保存' : `r${resource.revision}`);
    elements.ss_profile_status.dataset.state = state.profileConflictMessage
        ? 'error'
        : state.profileEditorDirty ? 'dirty' : 'saved';
    elements.ss_profile_meta.replaceChildren(
        tag('Profile V2', 'active'),
        tag(resource.active ? '已激活' : '未激活', resource.active ? 'active' : ''),
    );
    let counts = { modules: 0, variables: 0, tasks: 0, policies: 0 };
    try {
        const changes = buildProfileChanges(draft);
        counts = {
            modules: changes.modules.length,
            variables: changes.variables.length,
            tasks: Object.keys(changes.taskPolicies).length,
            policies: Object.keys(changes.generationPolicies).length,
        };
    } catch {
        // The active editor field reports the precise parse error on compile or save.
    }
    elements.ss_profile_counts.replaceChildren(
        Object.assign(document.createElement('span'), { textContent: `${counts.modules} 模块` }),
        Object.assign(document.createElement('span'), { textContent: `${counts.variables} 变量` }),
        Object.assign(document.createElement('span'), { textContent: `${counts.tasks} 任务 · ${counts.policies} 策略` }),
    );
    renderProfileTaskOptions();
    renderProfileCompatibility(
        buildCompatibilityReport(resource),
        elements.ss_profile_compatibility_meta,
        elements.ss_profile_compatibility_warnings,
    );
    setProfileEditorTab(state.profileEditorTab);
    renderProfileCompileResult();
}

function renderResources() {
    elements.ss_resource_list.replaceChildren();
    const projectResources = state.project?.resources || {};
    for (const group of RESOURCE_GROUPS) {
        const section = document.createElement('section');
        section.className = 'ss-resource-group';
        const heading = document.createElement('header');
        const title = document.createElement('h2');
        const items = state.resources.filter(resource => resource.type === group.type);
        title.textContent = `${group.label} · ${items.length}`;
        heading.append(title);
        if (group.type === 'character') {
            heading.append(resourceControl('无 Persona', resourceRadio(
                'ss-resource-persona',
                '',
                !projectResources.activePersonaId,
                'resourcePersona',
            )));
        }
        if (group.type === 'prompt-profile') {
            heading.append(resourceControl('不启用', resourceRadio(
                'ss-resource-prompt',
                '',
                !projectResources.activePromptProfileId,
                'resourcePrompt',
            )));
        }
        section.append(heading);

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ss-resource-group-empty';
            empty.textContent = '暂无资源';
            section.append(empty);
        }
        for (const resource of items) {
            const row = document.createElement('div');
            row.className = 'ss-resource-row';
            if (state.selectedResource?.id === resource.id && state.selectedResource?.type === resource.type) {
                row.classList.add('is-active');
            }
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'ss-resource-open';
            open.dataset.resourceId = resource.id;
            open.dataset.resourceType = resource.type;
            const name = document.createElement('strong');
            name.textContent = resource.name || '未命名资源';
            const meta = document.createElement('small');
            meta.textContent = resource.type === 'lorebook'
                ? `${numberFormatter.format(resource.entryCount || 0)} 条 · r${resource.revision}`
                : `r${resource.revision}`;
            open.append(name, meta);
            const controls = document.createElement('div');
            controls.className = 'ss-resource-row-controls';
            if (resource.type === 'character') {
                const active = document.createElement('input');
                active.type = 'checkbox';
                active.checked = Boolean(resource.active);
                active.disabled = state.resourceBusy;
                active.dataset.resourceContext = resource.id;
                controls.append(
                    resourceControl('上下文', active),
                    resourceControl('Persona', resourceRadio(
                        'ss-resource-persona', resource.id, Boolean(resource.persona), 'resourcePersona',
                    )),
                );
            } else if (resource.type === 'lorebook') {
                const active = document.createElement('input');
                active.type = 'checkbox';
                active.checked = Boolean(resource.active);
                active.disabled = state.resourceBusy;
                active.dataset.resourceLore = resource.id;
                controls.append(resourceControl('激活', active));
            } else {
                controls.append(resourceControl('激活', resourceRadio(
                    'ss-resource-prompt', resource.id, Boolean(resource.active), 'resourcePrompt',
                )));
            }
            row.append(open, controls);
            section.append(row);
        }
        elements.ss_resource_list.append(section);
    }
    elements.ss_import_resource.disabled = !state.project || state.resourceBusy;
    elements.ss_resource_status.textContent = state.resourceBusy ? '正在更新资源' : '';
    renderResourceDetail();
}

function renderResourceDetail() {
    const resource = state.selectedResource;
    elements.ss_resource_detail_empty.hidden = Boolean(resource);
    elements.ss_resource_detail_content.hidden = !resource;
    if (!resource) {
        renderResourceCompatibility(null);
        elements.ss_profile_editor.hidden = true;
        elements.ss_profile_legacy.hidden = true;
        return;
    }
    elements.ss_resource_detail_type.textContent = RESOURCE_TYPE_LABELS[resource.type] || resource.type;
    elements.ss_resource_detail_name.textContent = resource.name || '未命名资源';
    elements.ss_resource_json.textContent = JSON.stringify(resource, null, 2);
    elements.ss_resource_instruction_row.hidden = resource.type !== 'character';
    elements.ss_resource_instruction_enabled.checked = Boolean(resource.instructionEnabled);
    elements.ss_resource_instruction_enabled.disabled = state.resourceBusy;
    elements.ss_delete_resource.disabled = state.resourceBusy;
    renderResourceCompatibility(resource);
    renderProfileEditor(resource);
}

function renderCard() {
    const chapter = state.chapter;
    const volume = volumeForChapter(state.project, chapter);
    elements.ss_card_breadcrumb.textContent = chapter
        ? `${volume?.title || '未知卷'} / 第${chapter.number}章`
        : '未选择章节';
    const planStale = Boolean(chapter && isChapterPlanStale(state.project, chapter));
    elements.ss_plan_review_status.hidden = !planStale;
    elements.ss_plan_review_status.title = planStale
        ? `当前章纲基于卷纲 r${chapter?.planBasis?.volumeRevision || 0}，当前卷纲为 r${volume?.revision || 0}`
        : '';
    for (const input of elements.cardFields) {
        input.disabled = !chapter;
        input.value = chapter?.card?.[input.dataset.cardField] || '';
    }
    elements.ss_chapter_notes.disabled = !chapter;
    elements.ss_chapter_notes.value = chapter?.notes || '';
}

function createActionButton(label, action, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'ss-button ss-button-primary' : 'ss-button';
    button.dataset.candidateAction = action;
    button.textContent = label;
    button.setAttribute('aria-label', label);
    return button;
}

function generationCanBranch(generation) {
    return Boolean(generation && ['completed', 'partial', 'adopted'].includes(generation.status));
}

function selectionBaselineIsCurrent(generation = state.activeGeneration) {
    const baseline = state.selectionBaseline;
    return Boolean(generation?.id && baseline?.generationId === generation.id
        && baseline.chapterId === state.chapter?.id
        && baseline.chapterContent === state.chapter?.content
        && state.chapter.content.slice(baseline.start, baseline.end) === baseline.text);
}

function currentCandidate() {
    if (state.activeGeneration) {
        return {
            kind: state.activeGeneration.kind,
            content: state.activeGeneration.content || '',
            createdAt: state.activeGeneration.createdAt,
            generationId: state.activeGeneration.id,
            status: state.activeGeneration.status,
            distillation: state.activeGeneration.distillation,
        };
    }
    return state.chapter?.candidate || { kind: '', content: '', createdAt: null };
}

function renderGenerationHistory() {
    elements.ss_generation_history.replaceChildren();
    const manual = document.createElement('option');
    manual.value = '';
    manual.textContent = state.chapter?.candidate?.content ? '手动候选' : '选择历史候选';
    manual.selected = !state.selectedGenerationId;
    elements.ss_generation_history.append(manual);

    for (const generation of state.generations) {
        const option = document.createElement('option');
        option.value = generation.id;
        const kind = AI_LABELS[generation.kind] || generation.kind;
        const mode = GENERATION_MODE_LABELS[generation.mode] || generation.mode;
        const status = GENERATION_STATUS_LABELS[generation.status] || generation.status;
        option.textContent = `${kind} · ${mode} · ${status} · ${formatDate(generation.createdAt)}`;
        option.selected = generation.id === state.selectedGenerationId;
        elements.ss_generation_history.append(option);
    }
}

function tag(text, tone = '') {
    const item = document.createElement('span');
    item.className = 'ss-diagnostic-tag';
    if (tone) item.dataset.tone = tone;
    item.textContent = text;
    return item;
}

function contextOverrideFields(type) {
    return type === 'entity'
        ? { include: 'includeEntityIds', exclude: 'excludeEntityIds' }
        : { include: 'includePromiseIds', exclude: 'excludePromiseIds' };
}

function pruneContextOverrides() {
    const storyState = state.project?.storyState || {};
    const validEntityIds = new Set((storyState.entities || []).map(item => item?.id).filter(Boolean));
    const validPromiseIds = new Set((storyState.promises || []).map(item => item?.id).filter(Boolean));
    const next = emptyContextOverrides();
    for (const field of CONTEXT_OVERRIDE_FIELDS) {
        const validIds = field.includes('Entity') ? validEntityIds : validPromiseIds;
        next[field] = [...new Set(state.contextOverrides?.[field] || [])]
            .filter(id => validIds.has(id))
            .slice(0, MAX_CONTEXT_OVERRIDE_IDS);
    }
    const excludedEntities = new Set(next.excludeEntityIds);
    const excludedPromises = new Set(next.excludePromiseIds);
    next.includeEntityIds = next.includeEntityIds.filter(id => !excludedEntities.has(id));
    next.includePromiseIds = next.includePromiseIds.filter(id => !excludedPromises.has(id));
    state.contextOverrides = next;
    return next;
}

function contextOverridesForRequest() {
    const current = pruneContextOverrides();
    return Object.fromEntries(CONTEXT_OVERRIDE_FIELDS.map(field => [field, [...current[field]]]));
}

function contextOverrideMode(type, id) {
    const fields = contextOverrideFields(type);
    if (state.contextOverrides[fields.exclude].includes(id)) return 'exclude';
    if (state.contextOverrides[fields.include].includes(id)) return 'include';
    return 'auto';
}

function setContextOverride(type, id, mode) {
    const fields = contextOverrideFields(type);
    const next = {
        ...state.contextOverrides,
        [fields.include]: state.contextOverrides[fields.include].filter(value => value !== id),
        [fields.exclude]: state.contextOverrides[fields.exclude].filter(value => value !== id),
    };
    if (mode === 'include' || mode === 'exclude') {
        const field = fields[mode];
        if (next[field].length >= MAX_CONTEXT_OVERRIDE_IDS) {
            showToast(`单类手工上下文最多选择 ${MAX_CONTEXT_OVERRIDE_IDS} 项`, 5000);
            return false;
        }
        next[field] = [...next[field], id];
    }
    state.contextOverrides = next;
    return true;
}

function renderContextOverrideList(container, records, type) {
    container.replaceChildren();
    if (records.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ss-context-override-empty';
        empty.textContent = '暂无项目';
        container.append(empty);
        return;
    }
    for (const record of records) {
        const row = document.createElement('label');
        row.className = 'ss-context-override-row';
        const name = document.createElement('span');
        const primary = type === 'entity' ? record.name : record.title;
        name.textContent = primary || record.id;
        name.title = [record.id, record.summary].filter(Boolean).join('\n');
        const select = document.createElement('select');
        select.className = 'ss-control';
        select.dataset.contextOverrideType = type;
        select.dataset.contextOverrideId = record.id;
        select.setAttribute('aria-label', `${primary || record.id}的上下文模式`);
        for (const [value, label] of [['auto', '自动'], ['include', '强制包含'], ['exclude', '排除']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
        select.value = contextOverrideMode(type, record.id);
        select.disabled = !state.chapter || state.navigationBusy || state.generating || state.distilling || state.adopting;
        row.append(name, select);
        container.append(row);
    }
}

function pruneRetrievalOverrides() {
    const next = emptyRetrievalOverrides();
    for (const field of ['include', 'exclude']) {
        next[field] = [...new Set((state.retrievalOverrides?.[field] || [])
            .filter(value => typeof value === 'string' && value.length > 0))]
            .slice(0, MAX_RETRIEVAL_OVERRIDE_IDS);
    }
    const excluded = new Set(next.exclude);
    next.include = next.include.filter(id => !excluded.has(id));
    state.retrievalOverrides = next;
    return next;
}

function retrievalOverrideMode(id) {
    const current = pruneRetrievalOverrides();
    if (current.exclude.includes(id)) return 'exclude';
    if (current.include.includes(id)) return 'include';
    return 'auto';
}

function setRetrievalOverride(id, mode) {
    const current = pruneRetrievalOverrides();
    const next = {
        include: current.include.filter(value => value !== id),
        exclude: current.exclude.filter(value => value !== id),
    };
    if (mode === 'include' || mode === 'exclude') {
        if (next[mode].length >= MAX_RETRIEVAL_OVERRIDE_IDS) {
            showToast(`检索覆盖最多选择 ${MAX_RETRIEVAL_OVERRIDE_IDS} 项`, 5000);
            return false;
        }
        next[mode].push(id);
    }
    state.retrievalOverrides = next;
    invalidateContextPreview();
    renderContextOverrides();
    return true;
}

function retrievalOverridesForRequest({ includeRerank = false } = {}) {
    const current = pruneRetrievalOverrides();
    return {
        include: [...current.include],
        exclude: [...current.exclude],
        limit: 20,
        ...(includeRerank ? { rerank: elements.ss_retrieval_rerank.checked } : {}),
    };
}

function renderRetrievalOverrides() {
    const current = pruneRetrievalOverrides();
    const ids = [...new Set([...current.include, ...current.exclude])];
    elements.ss_context_retrieval_overrides.replaceChildren();
    elements.ss_clear_retrieval_overrides.disabled = ids.length === 0;
    if (ids.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ss-context-override-empty';
        empty.textContent = '暂无覆盖';
        elements.ss_context_retrieval_overrides.append(empty);
        return;
    }
    for (const id of ids) {
        const row = document.createElement('label');
        row.className = 'ss-context-override-row';
        const name = document.createElement('span');
        name.textContent = id;
        name.title = id;
        const select = document.createElement('select');
        select.className = 'ss-control';
        select.dataset.retrievalOverrideId = id;
        select.setAttribute('aria-label', `${id}的检索模式`);
        for (const [value, label] of [['auto', '自动'], ['include', '强制包含'], ['exclude', '排除']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
        select.value = retrievalOverrideMode(id);
        row.append(name, select);
        elements.ss_context_retrieval_overrides.append(row);
    }
}

function renderContextOverrides() {
    const overrides = pruneContextOverrides();
    const storyState = state.project?.storyState || {};
    renderContextOverrideList(elements.ss_context_entity_overrides, storyState.entities || [], 'entity');
    renderContextOverrideList(elements.ss_context_promise_overrides, storyState.promises || [], 'promise');
    renderRetrievalOverrides();
    const retrievalOverrides = pruneRetrievalOverrides();
    const selectedCount = CONTEXT_OVERRIDE_FIELDS.reduce((sum, field) => sum + overrides[field].length, 0)
        + retrievalOverrides.include.length + retrievalOverrides.exclude.length;
    elements.ss_context_override_count.textContent = numberFormatter.format(selectedCount);
}

function renderContextPreview() {
    const preview = state.generationPreview;
    elements.ss_context_preview.hidden = !preview;
    if (!preview) return;
    const diagnostics = preview.diagnostics || {};
    const metrics = [
        `Prompt ${numberFormatter.format(Number(diagnostics.promptTokens || 0))}`,
        `Context ${numberFormatter.format(Number(diagnostics.contextTokens || 0))}`,
        `Output ${numberFormatter.format(Number(diagnostics.responseTokens || preview.responseLength || 0))}`,
        `${numberFormatter.format(Number(diagnostics.totalCharacters || 0))} 字符`,
    ];
    elements.ss_context_metrics.replaceChildren(...metrics.map(value => tag(value)));

    const currentVolume = diagnostics.currentVolume || diagnostics.blocks?.currentVolume || null;
    const volumeTags = currentVolume
        ? [
            tag(currentVolume.included ? '已注入' : '未注入', currentVolume.included ? 'active' : 'warning'),
            tag(`${numberFormatter.format(Number(currentVolume.characters || 0))} 字符`),
            tag(`${numberFormatter.format(Number(currentVolume.tokens || 0))} tokens`),
            ...(currentVolume.truncated ? [tag('已裁剪', 'warning')] : []),
            ...(currentVolume.reason ? [tag(
                CONTEXT_REASON_LABELS[currentVolume.reason] || String(currentVolume.reason),
                currentVolume.included ? '' : 'warning',
            )] : []),
        ]
        : [tag('无', 'warning')];
    elements.ss_context_volume.replaceChildren(...volumeTags);

    const lore = Array.isArray(diagnostics.activatedLore) ? diagnostics.activatedLore : [];
    const lorebookIds = Array.isArray(diagnostics.activeLorebookIds) ? diagnostics.activeLorebookIds : [];
    const loreTags = [
        ...lore.map(entry => tag(String(entry.id || '未命名条目'), 'active')),
        ...lorebookIds.map(id => tag(`书:${id}`)),
    ];
    elements.ss_context_lore.replaceChildren(...(loreTags.length > 0 ? loreTags : [tag('无')]));
    const skippedLore = Array.isArray(diagnostics.skippedLore) ? diagnostics.skippedLore : [];
    const skippedLoreTags = skippedLore.map(entry => tag(
        `${entry?.id || '未命名条目'} · ${LORE_SKIP_LABELS[entry?.reason] || entry?.reason || '未注入'}`,
        entry?.reason === 'budget' ? 'warning' : '',
    ));
    elements.ss_context_lore_skipped.replaceChildren(...(
        skippedLoreTags.length > 0 ? skippedLoreTags : [tag('无', 'active')]
    ));

    const profile = projectPromptProfileDiagnostics(diagnostics);
    const profileTags = [];
    if (profile.activeProfileId) profileTags.push(tag(`id:${profile.activeProfileId}`, 'active'));
    if (profile.profileHash) profileTags.push(tag(`hash:${String(profile.profileHash).slice(0, 12)}`));
    if (profile.task) profileTags.push(tag(`task:${profile.task}`));
    for (const [field, value] of Object.entries(profile.generation || {})) {
        profileTags.push(tag(`${field}:${Array.isArray(value) ? value.join(',') : String(value)}`));
    }
    for (const error of profile.errors) profileTags.push(tag(String(error?.code || error?.message || 'error'), 'warning'));
    for (const warning of profile.warnings) profileTags.push(tag(String(warning?.code || warning?.message || 'warning'), 'warning'));
    elements.ss_context_profile.replaceChildren(...(
        profileTags.length > 0 ? profileTags : [tag('未启用')]
    ));
    elements.ss_context_profile_modules.replaceChildren(...(
        profile.modules.length > 0
            ? profile.modules.map(module => tag(
                `${module.id} ${module.compiledCharacters}/${module.originalCharacters}${module.reason ? ` · ${module.reason}` : ''}`,
                !module.included || module.truncated ? 'warning' : 'active',
            ))
            : [tag('无')]
    ));
    const preflight = diagnostics.continuityPreflight || diagnostics.preflight
        || diagnostics.storyContext?.preflight || null;
    const preflightTags = [];
    if (preflight && typeof preflight === 'object') {
        if (preflight.status) {
            const tone = ['ok', 'pass', 'ready', 'clean'].includes(String(preflight.status).toLowerCase())
                ? 'active' : 'warning';
            preflightTags.push(tag(`状态 ${preflight.status}`, tone));
        }
        for (const [name, value] of Object.entries(preflight.counts || preflight.totals || {})) {
            const count = typeof value === 'object' ? value?.count ?? value?.total ?? JSON.stringify(value) : value;
            preflightTags.push(tag(`${name} ${count}`));
        }
        if (preflight.pov) {
            const pov = preflight.pov;
            preflightTags.push(tag(
                `视角 ${pov.name || pov.entityId || pov.requested || '未解析'} · ${pov.resolution || 'unknown'}`,
                pov.unresolved ? 'warning' : 'active',
            ));
            for (const [stance, items] of Object.entries(pov.knowledge || {})) {
                if (Array.isArray(items) && items.length > 0) {
                    preflightTags.push(tag(`${KNOWLEDGE_STANCE_LABELS[stance] || stance} ${items.length}`));
                }
            }
        }
        if (preflight.time?.current) {
            const current = preflight.time.current;
            preflightTags.push(tag(`时间 ${current.storyTime || current.label || current.timelineId || '未标记'}`, 'active'));
        }
        if (preflight.movement) {
            const movement = preflight.movement;
            const route = [movement.fromLocationEntityId, movement.targetLocationEntityId].filter(Boolean).join(' → ');
            preflightTags.push(tag(
                `移动 ${route || movement.requestedLocation || '未解析'}`,
                movement.requiresTransition || movement.targetResolution === 'unresolved' ? 'warning' : '',
            ));
        }
        for (const [name, tone] of [['conflicts', 'warning'], ['warnings', 'warning'], ['requirements', 'active'], ['items', '']]) {
            for (const item of Array.isArray(preflight[name]) ? preflight[name] : []) {
                const value = typeof item === 'string'
                    ? item
                    : [item?.code, item?.category, item?.id, item?.summary || item?.message || item?.reason]
                        .filter(Boolean).join(' · ');
                if (value) preflightTags.push(tag(`${name} · ${value}`, tone));
            }
        }
        if (preflightTags.length === 0) preflightTags.push(tag(JSON.stringify(preflight)));
    }
    elements.ss_context_continuity_preflight.replaceChildren(...(
        preflightTags.length > 0 ? preflightTags : [tag('无预检结果')]
    ));
    const retrieval = diagnostics.retrieval && typeof diagnostics.retrieval === 'object'
        ? diagnostics.retrieval
        : null;
    const retrievalHits = Array.isArray(retrieval?.hits) ? retrieval.hits : [];
    const retrievalNodes = retrievalHits.map((hit, index) => {
        const wrapper = document.createElement('span');
        wrapper.className = 'ss-retrieval-result';
        const node = document.createElement(hit.chapterId ? 'button' : 'span');
        if (hit.chapterId) {
            node.type = 'button';
            node.setAttribute('data-retrieval-chapter-id', hit.chapterId);
            node.title = '打开来源章节';
        }
        node.className = 'ss-diagnostic-tag ss-retrieval-hit';
        if (hit.reasons?.includes('manual-include')) node.dataset.tone = 'active';
        const score = Number.isFinite(Number(hit.score)) ? Number(hit.score).toFixed(2) : '0.00';
        const source = hit.sourceType || hit.source?.sourceType || 'source';
        const sourceId = hit.sourceId || hit.source?.sourceId || hit.id || index + 1;
        node.textContent = `${index + 1}. ${source}:${sourceId} · ${score} · ${(hit.reasons || [hit.reason || 'bm25']).join('/')}`;
        wrapper.append(node);
        if (hit.id) {
            const select = document.createElement('select');
            select.className = 'ss-control ss-retrieval-mode';
            select.dataset.retrievalOverrideId = hit.id;
            select.setAttribute('aria-label', `${source}:${sourceId}的检索模式`);
            for (const [value, label] of [['auto', '自动'], ['include', '强制包含'], ['exclude', '排除']]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                select.append(option);
            }
            select.value = retrievalOverrideMode(hit.id);
            wrapper.append(select);
        }
        return wrapper;
    });
    const rerankMode = retrieval?.diagnostics?.rerank;
    if (rerankMode) {
        const labels = {
            provider: '排序：模型重排',
            'provider-ignored': '排序：本地回退（模型结果无效）',
            'deterministic-fallback': '排序：本地回退',
            'skipped-insufficient-hits': '排序：本地（命中不足）',
        };
        retrievalNodes.unshift(tag(labels[rerankMode] || `排序：${rerankMode}`, rerankMode === 'provider' ? 'active' : 'warning'));
    }
    elements.ss_context_retrieval.replaceChildren(...(
        retrievalNodes.length > 0
            ? retrievalNodes
            : [tag(retrieval ? '无命中' : '未启用')]
    ));
    const previewMessages = profile.messages.length > 0
        ? profile.messages
        : Array.isArray(preview.messages) ? preview.messages : [];
    elements.ss_context_messages.textContent = previewMessages.length > 0
        ? JSON.stringify(previewMessages, null, 2)
        : '';

    const blocks = diagnostics.blocks && typeof diagnostics.blocks === 'object' ? diagnostics.blocks : {};
    const truncated = Object.entries(blocks)
        .filter(([, value]) => value?.truncated)
        .map(([name, value]) => tag(`${name} ${value.characters}/${value.originalCharacters}`, 'warning'));
    if (diagnostics.outputLimited) truncated.push(tag('输出预算已收紧', 'warning'));
    const loreBudget = diagnostics.loreBudget;
    if (loreBudget) truncated.push(tag(`世界书 ${loreBudget.characters}/${loreBudget.limit}`));
    const storyContext = diagnostics.storyContext;
    if (storyContext && typeof storyContext === 'object') {
        for (const [name, total] of Object.entries(storyContext.totals || {})) {
            const selected = Number(total?.selected || 0);
            const available = Number(total?.available || 0);
            truncated.push(tag(`状态 ${name} ${selected}/${available}`));
        }
        for (const item of Array.isArray(storyContext.items) ? storyContext.items : []) {
            const identity = [item?.category, item?.id].filter(Boolean).join(':') || 'unknown';
            const reasons = Array.isArray(item?.reasons) ? item.reasons.join('/') : '';
            const characters = Number(item?.characters || 0);
            truncated.push(tag(`注入 ${identity}${reasons ? ` · ${reasons}` : ''} · ${characters}字`, 'active'));
        }
        const reasons = Array.isArray(storyContext.reasons)
            ? storyContext.reasons
            : Object.entries(storyContext.reasons || {}).map(([name, value]) => `${name}:${value}`);
        for (const reason of reasons) {
            const text = typeof reason === 'string' ? reason : reason?.reason || reason?.code || JSON.stringify(reason);
            if (text) truncated.push(tag(`状态 ${text}`, 'warning'));
        }
    }
    for (const warning of diagnostics.warnings || []) {
        const value = typeof warning === 'string' ? warning : warning?.code || warning?.message || 'warning';
        truncated.push(tag(String(value), 'warning'));
    }
    const adapter = diagnostics.providerAdapter;
    if (adapter && typeof adapter === 'object') {
        for (const field of adapter.sentParameters || []) truncated.push(tag(`发送 ${field}`, 'active'));
        for (const item of adapter.droppedParameters || []) {
            truncated.push(tag(`丢弃 ${item?.field || 'unknown'} · ${item?.reason || ''}`, 'warning'));
        }
    }
    elements.ss_context_truncation.replaceChildren(...(truncated.length > 0 ? truncated : [tag('无截断', 'active')]));
    elements.ss_context_system.textContent = preview.systemPrompt || '';
    elements.ss_context_user.textContent = preview.prompt || '';
}

function changesetMutationCount(value) {
    const upsert = Array.isArray(value?.upsert) ? value.upsert.length : 0;
    const removed = Array.isArray(value?.delete) ? value.delete.length : 0;
    return { upsert, removed, total: upsert + removed };
}

function renderDistillation() {
    const generation = state.activeGeneration;
    const isDraft = generation?.kind === 'draft' && Boolean(generation.content);
    elements.ss_distillation.hidden = !isDraft;
    if (!isDraft) return;

    const distillation = generation.distillation || { status: 'none', changes: null };
    const statusLabels = { none: '未蒸馏', ready: '待采纳', failed: '蒸馏失败' };
    elements.ss_distillation_status.textContent = statusLabels[distillation.status] || distillation.status || '未蒸馏';
    const changes = distillation.changes;
    elements.ss_distillation_summary.textContent = changes?.chapterSummary
        || distillation.error
        || '尚无章节状态变更';
    elements.ss_distillation_counts.replaceChildren();
    const storyChanges = changes?.storyStateChanges;
    if (storyChanges && typeof storyChanges === 'object') {
        for (const [key, label] of Object.entries(CHANGESET_LABELS)) {
            const count = changesetMutationCount(storyChanges[key]);
            elements.ss_distillation_counts.append(tag(`${label} ${count.total} (+${count.upsert}/-${count.removed})`));
        }
    }
    elements.ss_distillation_details.hidden = !changes;
    elements.ss_distillation_json.textContent = changes ? JSON.stringify(changes, null, 2) : '';
}

function renderGenerationControls() {
    const generation = state.activeGeneration;
    const busy = state.navigationBusy || state.distilling || state.adopting;
    const stopping = state.generating && state.generationController?.signal.aborted;
    elements.ss_generation_history.disabled = busy || state.generating || !state.chapter;
    elements.ss_generation_preview.disabled = busy || state.generating || !state.chapter;
    elements.ss_retrieval_preview.disabled = busy || state.generating || !state.chapter;
    elements.ss_generation_regenerate.disabled = busy || state.generating || !generationCanBranch(generation);
    elements.ss_generation_continue.disabled = busy || state.generating
        || generation?.kind !== 'draft' || !generationCanBranch(generation);
    elements.ss_generation_instruction.disabled = busy || state.generating || !state.chapter;
    for (const button of elements.aiTabs || []) button.disabled = busy || state.generating || !state.chapter;
    elements.ss_generate.disabled = !state.chapter || busy || stopping;
    elements.ss_generate.toggleAttribute('aria-busy', state.generating);
    const generateIcon = elements.ss_generate.querySelector('img');
    const generateLabel = elements.ss_generate.querySelector('span');
    if (state.generating) {
        generateIcon.src = '/icons/square.svg';
        generateLabel.textContent = stopping ? '停止中' : '停止生成';
        elements.ss_generate.setAttribute('aria-label', stopping ? '正在停止生成' : '停止生成');
    } else {
        generateIcon.src = '/icons/sparkles.svg';
        generateLabel.textContent = '生成候选';
        elements.ss_generate.setAttribute('aria-label', '生成 AI 候选');
    }

    let status = '';
    if (state.generating) {
        status = `${stopping ? '正在停止' : '正在生成'} · ${numberFormatter.format(currentCandidate().content.length)} 字符`;
    } else if (generation) {
        const stateLabel = GENERATION_STATUS_LABELS[generation.status] || generation.status;
        status = [stateLabel, generation.model, `${numberFormatter.format(generation.content?.length || 0)} 字符`]
            .filter(Boolean).join(' · ');
    }
    elements.ss_generation_status.textContent = status;
    renderGenerationHistory();
}

function renderCandidateActions() {
    elements.ss_candidate_actions.replaceChildren();
    const candidate = currentCandidate();
    if (!candidate?.content) return;

    const generation = state.activeGeneration;
    const canUseGeneration = generationCanBranch(generation);

    if (candidate.kind === 'plan') {
        elements.ss_candidate_actions.append(createActionButton('应用到章纲', 'apply-plan', true));
    } else if (candidate.kind === 'draft') {
        if (generation && canUseGeneration && generation.status !== 'adopted') {
            const hasChanges = generation.distillation?.status === 'ready';
            elements.ss_candidate_actions.append(
                createActionButton(hasChanges ? '采纳正文与变更' : '采纳并替换', 'adopt-replace', true),
                createActionButton('插入光标处', 'adopt-insert'),
                createActionButton('追加正文', 'adopt-append'),
            );
            if (['completed', 'partial'].includes(generation.status)) {
                elements.ss_candidate_actions.append(createActionButton(
                    hasChanges ? '重新蒸馏' : '蒸馏变更',
                    'distill',
                ));
            }
        } else if (!generation) {
            elements.ss_candidate_actions.append(
                createActionButton('插入光标处', 'insert-draft', true),
                createActionButton('替换正文', 'replace-draft', true),
                createActionButton('追加正文', 'append-draft'),
            );
        }
    } else if (candidate.kind === 'review') {
        elements.ss_candidate_actions.append(createActionButton('写入审校记录', 'apply-review', true));
    } else if (SELECTION_AI_KINDS.has(candidate.kind) && candidate.kind !== 'brainstorm'
        && generation && canUseGeneration && selectionBaselineIsCurrent(generation)) {
        elements.ss_candidate_actions.append(createActionButton('替换原选区', 'replace-selection', true));
    }
    elements.ss_candidate_actions.append(createActionButton('复制', 'copy'));
    if (!generation) elements.ss_candidate_actions.append(createActionButton('清空', 'clear'));
    for (const button of elements.ss_candidate_actions.querySelectorAll('button')) {
        button.disabled = state.generating || state.distilling || state.adopting;
    }
}

function renderCandidate() {
    const candidate = currentCandidate();
    elements.ss_candidate.disabled = !state.chapter || state.generating || state.distilling || state.adopting;
    elements.ss_candidate.value = candidate.content || '';
    const status = candidate.status ? GENERATION_STATUS_LABELS[candidate.status] : '';
    elements.ss_candidate_label.textContent = [AI_LABELS[candidate.kind] || '候选稿', status].filter(Boolean).join(' · ');
    elements.ss_candidate_time.textContent = formatDate(candidate.createdAt);
    elements.ss_candidate_time.dateTime = candidate.createdAt || '';
    elements.ss_review_record.disabled = !state.chapter;
    elements.ss_review_record.value = state.chapter?.review || '';
    renderContextOverrides();
    renderCandidateActions();
    renderGenerationControls();
    renderDistillation();
    renderGenerationPendingChangeSet();
    renderContextPreview();
}

function emptyCopilotSelection() {
    return {
        volumeIds: new Set(),
        chapterIds: new Set(),
        entityIds: new Set(),
        lorebookIds: new Set(),
    };
}

function applyCopilotDefaultBinding(project = state.project, chapter = state.chapter) {
    const binding = copilotDefaultBinding(project, chapter);
    state.copilotSelection = {
        ...emptyCopilotSelection(),
        volumeIds: new Set(binding.volumeIds),
        chapterIds: new Set(binding.chapterIds),
    };
    state.copilotAnchorChapterId = binding.anchorChapterId;
}

function copilotCommandId(kind) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `copilot.${kind}.${random}`;
}

function copilotRequestIsCurrent(projectId, requestSerial) {
    return state.project?.id === projectId
        && state.copilotProjectId === projectId
        && state.copilotRequestSerial === requestSerial;
}

function copilotGenerationIsCurrent(projectId, sessionId, controller) {
    return state.project?.id === projectId
        && state.copilotProjectId === projectId
        && state.copilotSessionId === sessionId
        && state.copilotGenerationController === controller;
}

function resetCopilotWorkspace() {
    state.copilotGenerationController?.abort();
    state.copilotRequestSerial += 1;
    state.copilotHandoffSerial += 1;
    state.copilotChapterId = '';
    state.copilotResources = [];
    state.copilotProfiles = [];
    state.copilotSettings = null;
    state.copilotSettingsMode = 'inherit';
    state.copilotSettingsModel = '';
    state.copilotSelection = emptyCopilotSelection();
    state.copilotSelectionCustomized = false;
    state.copilotAnchorChapterId = '';
    state.copilotPreview = null;
    state.copilotSelectedEvidenceIds = new Set();
    state.copilotRetrievalQuery = '';
    state.copilotRetrievalLimit = 20;
    state.copilotProfileValue = `builtin:${BUILTIN_COPILOT_PROFILE_ID}`;
    state.copilotInstruction = '';
    state.copilotOptionCount = 3;
    state.copilotSessions = [];
    state.copilotSession = null;
    state.copilotSessionId = '';
    state.copilotLoading = false;
    state.copilotPreviewing = false;
    state.copilotBusy = false;
    state.copilotGenerating = false;
    state.copilotCancelling = false;
    state.copilotHandoffOptionId = '';
    state.copilotGenerationController = null;
    state.copilotStream = '';
    state.copilotError = '';
    state.copilotRetry = null;
}

function bindCopilotWorkspace(project = state.project, chapter = state.chapter) {
    const projectId = project?.id || '';
    const chapterId = chapter?.id || '';
    const projectChanged = state.copilotProjectId !== projectId;
    const chapterChanged = state.copilotChapterId !== chapterId;
    if (!projectChanged && !chapterChanged) return false;
    if (projectChanged) {
        resetCopilotWorkspace();
        state.copilotProjectId = projectId;
        state.copilotChapterId = chapterId;
        if (projectId) applyCopilotDefaultBinding(project, chapter);
        return true;
    }
    state.copilotChapterId = chapterId;
    if (!state.copilotPreview
        && !state.copilotSession
        && !state.copilotSessionId
        && !state.copilotSelectionCustomized) {
        applyCopilotDefaultBinding(project, chapter);
    }
    return true;
}

function invalidateCopilotPreview({ preserveError = false } = {}) {
    state.copilotContextEpoch += 1;
    state.copilotPreview = null;
    state.copilotSelectedEvidenceIds = new Set();
    if (!preserveError) {
        state.copilotError = '';
        state.copilotRetry = null;
    }
}

function copilotPreviewMatchesAuthority(preview = state.copilotPreview) {
    return Boolean(preview
        && state.project
        && preview.base?.projectId === state.project.id
        && preview.base?.projectVersion === state.project.version);
}

function syncCopilotAuthorityState() {
    if (state.copilotPreview && !copilotPreviewMatchesAuthority()) {
        invalidateCopilotPreview({ preserveError: true });
    }
    if (state.copilotSession
        && copilotSessionAuthorityStale(state.copilotSession, state.project)
        && !state.copilotSession.stale) {
        state.copilotSession = { ...state.copilotSession, stale: true };
    }
}

function copilotSelectionValue() {
    return Object.fromEntries(Object.entries(state.copilotSelection).map(([field, values]) => (
        [field, [...values].sort()]
    )));
}

function copilotPreviewRequest() {
    return {
        projectVersion: state.project.version,
        anchorChapterId: state.copilotAnchorChapterId || null,
        selection: copilotSelectionValue(),
        retrieval: {
            query: state.copilotRetrievalQuery,
            filters: {},
            limit: state.copilotRetrievalLimit,
        },
    };
}

function copilotProfileRef() {
    const [source, id] = state.copilotProfileValue.split(':', 2);
    if (source === 'project') {
        const profile = state.copilotProfiles.find(item => item.id === id);
        return profile ? { source, id, revision: profile.revision } : null;
    }
    return { source: 'builtin', id: BUILTIN_COPILOT_PROFILE_ID };
}

function appendCopilotEmpty(container, text) {
    const empty = document.createElement('div');
    empty.className = 'ss-inline-empty ss-copilot-inline-empty';
    empty.textContent = text;
    container.replaceChildren(empty);
}

function renderCopilotSelectionOptions(container, records, selectedIds, kind, labelFor) {
    container.replaceChildren();
    if (records.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'ss-muted-copy';
        empty.textContent = '暂无';
        container.append(empty);
        return;
    }
    for (const record of records) {
        const label = document.createElement('label');
        label.className = 'ss-copilot-check-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selectedIds.has(record.id);
        input.disabled = state.copilotBusy || state.copilotPreviewing || state.copilotGenerating;
        input.dataset.copilotSelectionKind = kind;
        input.dataset.copilotSelectionId = record.id;
        const text = document.createElement('span');
        text.textContent = labelFor(record);
        label.append(input, text);
        container.append(label);
    }
}

function copilotEvidenceSourceLabel(sourceType) {
    if (String(sourceType).startsWith('retrieval:')) return `检索 · ${String(sourceType).slice(10) || '命中'}`;
    return COPILOT_SOURCE_LABELS[sourceType] || sourceType || '证据';
}

function renderCopilotEvidence() {
    const records = state.copilotPreview?.evidenceCatalog || [];
    elements.ss_copilot_evidence_list.replaceChildren();
    if (records.length === 0) {
        appendCopilotEmpty(elements.ss_copilot_evidence_list, state.copilotPreviewing ? '正在汇编上下文' : '尚未预览上下文');
        return;
    }
    for (const record of records) {
        const label = document.createElement('label');
        label.className = 'ss-copilot-evidence-row';
        if (String(record.source?.type).startsWith('retrieval:')) label.classList.add('is-retrieval');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = state.copilotSelectedEvidenceIds.has(record.evidenceId);
        input.disabled = state.copilotBusy || state.copilotGenerating;
        input.dataset.copilotEvidenceId = record.evidenceId;
        const body = document.createElement('span');
        body.className = 'ss-copilot-evidence-copy';
        const meta = document.createElement('span');
        meta.className = 'ss-copilot-evidence-meta';
        const source = document.createElement('small');
        source.textContent = copilotEvidenceSourceLabel(record.source?.type);
        const visibility = document.createElement('small');
        visibility.textContent = record.visibility === 'pov-safe' ? 'POV 可见' : '作者材料';
        meta.append(source, visibility);
        const title = document.createElement('strong');
        title.textContent = record.title || record.source?.path || record.evidenceId;
        const excerpt = document.createElement('span');
        excerpt.className = 'ss-copilot-evidence-excerpt';
        excerpt.textContent = record.excerpt || '';
        body.append(meta, title, excerpt);
        label.append(input, body);
        elements.ss_copilot_evidence_list.append(label);
    }
}

function renderCopilotControls() {
    const project = state.project;
    elements.ss_copilot_project_context.value = project?.title || '';
    elements.ss_copilot_anchor_chapter.replaceChildren();
    const noAnchor = document.createElement('option');
    noAnchor.value = '';
    noAnchor.textContent = '不设锚点';
    elements.ss_copilot_anchor_chapter.append(noAnchor);
    for (const chapter of project?.chapters || []) {
        const option = document.createElement('option');
        option.value = chapter.id;
        option.textContent = `第${chapter.number}章 · ${chapter.title}`;
        elements.ss_copilot_anchor_chapter.append(option);
    }
    elements.ss_copilot_anchor_chapter.value = (project?.chapters || []).some(item => item.id === state.copilotAnchorChapterId)
        ? state.copilotAnchorChapterId : '';
    elements.ss_copilot_anchor_chapter.disabled = !project || state.copilotBusy
        || state.copilotPreviewing || state.copilotGenerating;

    renderCopilotSelectionOptions(
        elements.ss_copilot_volume_options,
        project?.volumes || [],
        state.copilotSelection.volumeIds,
        'volumeIds',
        volume => volume.title,
    );
    renderCopilotSelectionOptions(
        elements.ss_copilot_chapter_options,
        project?.chapters || [],
        state.copilotSelection.chapterIds,
        'chapterIds',
        chapter => `第${chapter.number}章 · ${chapter.title}`,
    );
    renderCopilotSelectionOptions(
        elements.ss_copilot_entity_options,
        (project?.storyState?.entities || []).filter(entity => entity.kind === 'character'),
        state.copilotSelection.entityIds,
        'entityIds',
        entity => entity.name || entity.id,
    );
    renderCopilotSelectionOptions(
        elements.ss_copilot_lorebook_options,
        state.copilotResources.filter(resource => resource.type === 'lorebook'),
        state.copilotSelection.lorebookIds,
        'lorebookIds',
        resource => `${resource.name} · ${resource.entryCount || 0} 条`,
    );

    elements.ss_copilot_retrieval_query.value = state.copilotRetrievalQuery;
    elements.ss_copilot_retrieval_limit.value = String(state.copilotRetrievalLimit);
    elements.ss_copilot_retrieval_query.disabled = !project || state.copilotBusy
        || state.copilotPreviewing || state.copilotGenerating;
    elements.ss_copilot_retrieval_limit.disabled = elements.ss_copilot_retrieval_query.disabled;
    const digest = state.copilotPreview?.contextDigest;
    const diagnostics = state.copilotPreview?.diagnostics;
    elements.ss_copilot_context_digest.textContent = digest
        ? `${diagnostics?.evidenceCount || 0} 条证据 · ${diagnostics?.retrievalHitCount || 0} 条检索 · ${digest.slice(0, 12)}`
        : '';
    renderCopilotEvidence();

    elements.ss_copilot_profile.replaceChildren();
    const builtin = document.createElement('option');
    builtin.value = `builtin:${BUILTIN_COPILOT_PROFILE_ID}`;
    builtin.textContent = '内置 · 网文策划 Copilot';
    elements.ss_copilot_profile.append(builtin);
    for (const profile of state.copilotProfiles) {
        const option = document.createElement('option');
        option.value = `project:${profile.id}`;
        option.textContent = `项目 · ${profile.name} · r${profile.revision}`;
        elements.ss_copilot_profile.append(option);
    }
    if (![...elements.ss_copilot_profile.options].some(option => option.value === state.copilotProfileValue)) {
        state.copilotProfileValue = builtin.value;
    }
    elements.ss_copilot_profile.value = state.copilotProfileValue;
    for (const button of elements.ss_copilot_model_mode.querySelectorAll('[data-copilot-model-mode]')) {
        const active = button.dataset.copilotModelMode === state.copilotSettingsMode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    }
    elements.ss_copilot_model.value = state.copilotSettingsModel;
    elements.ss_copilot_model.disabled = state.copilotSettingsMode === 'inherit' || state.copilotBusy;
    const effective = state.copilotSettings?.effective;
    elements.ss_copilot_model_status.textContent = effective?.model
        ? `生效：${effective.model} · ${effective.protocol}` : state.copilotLoading ? '正在读取模型' : '模型未配置';
    elements.ss_copilot_instruction.value = state.copilotInstruction;
    elements.ss_copilot_option_count.value = String(state.copilotOptionCount);
    elements.ss_copilot_instruction.disabled = !project || state.copilotBusy || state.copilotGenerating;
    elements.ss_copilot_option_count.disabled = !project || state.copilotBusy || state.copilotGenerating;
}

function currentCopilotSession() {
    return state.copilotSession?.id === state.copilotSessionId ? state.copilotSession : null;
}

function copilotArtifact() {
    return currentCopilotSession()?.artifact || null;
}

function appendCopilotMeta(parent, value, tone = '') {
    const item = document.createElement('span');
    item.className = `ss-diagnostic-tag${tone ? ` is-${tone}` : ''}`;
    item.textContent = value;
    parent.append(item);
}

function renderCopilotSessions() {
    elements.ss_copilot_session.replaceChildren();
    if (state.copilotSessions.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无会话';
        elements.ss_copilot_session.append(option);
    } else {
        for (const session of state.copilotSessions) {
            const option = document.createElement('option');
            option.value = session.id;
            option.textContent = `${COPILOT_SESSION_STATUS_LABELS[session.status] || session.status} · ${session.optionCount} 方向 · ${formatDate(session.updatedAt)}`;
            elements.ss_copilot_session.append(option);
        }
    }
    elements.ss_copilot_session.value = state.copilotSessions.some(item => item.id === state.copilotSessionId)
        ? state.copilotSessionId : '';
}

function renderCopilotSessionSummary() {
    const session = currentCopilotSession();
    elements.ss_copilot_session_meta.replaceChildren();
    elements.ss_copilot_session_status.textContent = session
        ? `${COPILOT_SESSION_STATUS_LABELS[session.status] || session.status} · r${session.revision}` : '';
    if (!session) {
        appendCopilotMeta(elements.ss_copilot_session_meta, '尚未选择会话');
    } else {
        const sessionStale = copilotSessionAuthorityStale(session, state.project);
        appendCopilotMeta(elements.ss_copilot_session_meta, `${session.input?.optionCount || 0} 个方向`);
        appendCopilotMeta(elements.ss_copilot_session_meta, session.profile?.name || session.profile?.id || 'Profile');
        appendCopilotMeta(elements.ss_copilot_session_meta, session.provider?.model || '未配置模型');
        appendCopilotMeta(elements.ss_copilot_session_meta, sessionStale ? '上下文已过期' : '上下文已锁定', sessionStale ? 'warning' : 'active');
        const anchorId = session.base?.anchorChapterId || '';
        const anchor = state.project?.chapters?.find(chapter => chapter.id === anchorId);
        if (!anchorId) {
            appendCopilotMeta(elements.ss_copilot_session_meta, '项目级策划 · 无章节锚点', 'warning');
        } else {
            const anchorLabel = anchor ? `第${anchor.number}章 · ${anchor.title}` : anchorId;
            const current = state.chapter?.id === anchorId;
            appendCopilotMeta(
                elements.ss_copilot_session_meta,
                `锚点：${anchorLabel}${current ? '' : ' · 当前打开章节不同'}`,
                current ? 'active' : 'warning',
            );
        }
        const attempt = session.attempts?.at(-1);
        if (attempt) appendCopilotMeta(elements.ss_copilot_session_meta, `第 ${attempt.number} 次 · ${attempt.status}`);
    }
    elements.ss_copilot_stream.textContent = state.copilotStream;
    elements.ss_copilot_stream.hidden = !state.copilotStream;
}

function copilotDirectionCopyText(option) {
    return [
        option.title,
        `取舍：${option.commitment}`,
        option.summary,
        ...option.eventChain.map(event => `${event.order}. ${event.event}\n选择：${event.characterChoice}\n结果：${event.directResult}\n代价：${event.cost}`),
        `章尾：${option.hook}`,
        ...(option.risks || []).map(risk => `风险：${risk}`),
    ].join('\n\n');
}

function renderCopilotDirections() {
    const options = copilotArtifact()?.plotOptions || [];
    const handoffEligibility = copilotHandoffEligibility({
        project: state.project,
        chapter: state.chapter,
        session: currentCopilotSession(),
        artifact: copilotArtifact(),
    });
    elements.ss_copilot_directions.replaceChildren();
    if (options.length === 0) {
        appendCopilotEmpty(elements.ss_copilot_directions, state.copilotGenerating ? '正在生成互斥方向' : '暂无方向候选');
        return;
    }
    options.forEach((option, index) => {
        const article = document.createElement('article');
        article.className = 'ss-copilot-direction';
        const header = document.createElement('header');
        const heading = document.createElement('div');
        const ordinal = document.createElement('span');
        ordinal.className = 'ss-copilot-direction-number';
        ordinal.textContent = String(index + 1).padStart(2, '0');
        const title = document.createElement('h3');
        title.textContent = option.title;
        heading.append(ordinal, title);
        const copy = document.createElement('button');
        copy.className = 'ss-icon-button';
        copy.type = 'button';
        copy.title = '复制此方向';
        copy.setAttribute('aria-label', `复制方向：${option.title}`);
        copy.dataset.copilotCopyDirection = option.id;
        const icon = document.createElement('img');
        icon.className = 'ss-icon';
        icon.src = '/icons/copy.svg';
        icon.alt = '';
        copy.append(icon);
        header.append(heading, copy);

        const commitment = document.createElement('p');
        commitment.className = 'ss-copilot-commitment';
        commitment.textContent = option.commitment;
        const summary = document.createElement('p');
        summary.className = 'ss-copilot-direction-summary';
        summary.textContent = option.summary;
        const chain = document.createElement('ol');
        chain.className = 'ss-copilot-event-chain';
        for (const event of option.eventChain || []) {
            const item = document.createElement('li');
            const eventTitle = document.createElement('strong');
            eventTitle.textContent = event.event;
            const fields = document.createElement('dl');
            for (const [label, value] of [
                ['人物选择', event.characterChoice], ['直接结果', event.directResult], ['代价', event.cost],
            ]) {
                const term = document.createElement('dt');
                term.textContent = label;
                const detail = document.createElement('dd');
                detail.textContent = value;
                fields.append(term, detail);
            }
            item.append(eventTitle, fields);
            chain.append(item);
        }
        const footer = document.createElement('footer');
        const hook = document.createElement('p');
        const hookLabel = document.createElement('strong');
        hookLabel.textContent = '章尾';
        hook.append(hookLabel);
        hook.append(document.createTextNode(` ${option.hook}`));
        const risks = document.createElement('div');
        risks.className = 'ss-copilot-option-tags';
        for (const risk of option.risks || []) appendCopilotMeta(risks, risk, 'warning');
        for (const evidenceId of option.evidenceIds || []) appendCopilotMeta(risks, evidenceId);
        const actions = document.createElement('div');
        actions.className = 'ss-copilot-direction-actions';
        const startWorkflow = document.createElement('button');
        startWorkflow.className = 'ss-button ss-button-primary';
        startWorkflow.type = 'button';
        startWorkflow.dataset.copilotStartWorkflow = option.id;
        startWorkflow.disabled = state.copilotBusy
            || state.copilotGenerating
            || !handoffEligibility.eligible;
        startWorkflow.title = handoffEligibility.eligible
            ? '把该方向交接到当前章节的 Workflow V2'
            : handoffEligibility.reason;
        const startIcon = document.createElement('img');
        startIcon.className = 'ss-icon';
        startIcon.src = '/icons/workflow.svg';
        startIcon.alt = '';
        const startLabel = document.createElement('span');
        startLabel.textContent = state.copilotHandoffOptionId === option.id
            ? '正在交接到流程'
            : '用此方向开始流程';
        startWorkflow.append(startIcon, startLabel);
        actions.append(startWorkflow);
        footer.append(hook, risks, actions);
        article.append(header, commitment, summary, chain, footer);
        elements.ss_copilot_directions.append(article);
    });
}

function appendCopilotDiff(container, diff, kind) {
    const article = document.createElement('article');
    article.className = 'ss-copilot-diff';
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = kind === 'setting'
        ? `${diff.target?.kind || 'setting'} · ${diff.target?.field || diff.id}`
        : `${diff.operation || 'update'} · ${diff.lorebookId || ''} · ${diff.entryId || ''}`;
    const scope = document.createElement('span');
    scope.textContent = (diff.appliesToOptionIds || []).length > 0
        ? `方向 ${(diff.appliesToOptionIds || []).join('、')}` : '全部方向';
    header.append(title, scope);
    const comparison = document.createElement('div');
    comparison.className = 'ss-copilot-diff-comparison';
    for (const [label, value, tone] of [
        ['原值', kind === 'setting' ? diff.beforeValue : diff.beforeEntry, 'before'],
        ['提案', kind === 'setting' ? diff.afterValue : diff.afterEntry, 'after'],
    ]) {
        const side = document.createElement('div');
        side.className = `is-${tone}`;
        const sideLabel = document.createElement('small');
        sideLabel.textContent = label;
        const content = document.createElement('pre');
        content.textContent = typeof value === 'string' ? value : value === null ? 'null' : JSON.stringify(value, null, 2);
        side.append(sideLabel, content);
        comparison.append(side);
    }
    const rationale = document.createElement('p');
    rationale.textContent = diff.rationale || '';
    const evidence = document.createElement('div');
    evidence.className = 'ss-copilot-option-tags';
    for (const evidenceId of diff.evidenceIds || []) appendCopilotMeta(evidence, evidenceId);
    article.append(header, comparison, rationale, evidence);
    container.append(article);
}

function renderCopilotDiffs() {
    const changeSet = copilotArtifact()?.changeSet;
    const settingDiffs = changeSet?.settingDiffs || [];
    const lorebookDiffs = changeSet?.lorebookDiffs || [];
    elements.ss_copilot_setting_diffs.replaceChildren();
    elements.ss_copilot_lorebook_diffs.replaceChildren();
    if (settingDiffs.length === 0) appendCopilotEmpty(elements.ss_copilot_setting_diffs, '无设定提案');
    else for (const diff of settingDiffs) appendCopilotDiff(elements.ss_copilot_setting_diffs, diff, 'setting');
    if (lorebookDiffs.length === 0) appendCopilotEmpty(elements.ss_copilot_lorebook_diffs, '无世界书提案');
    else for (const diff of lorebookDiffs) appendCopilotDiff(elements.ss_copilot_lorebook_diffs, diff, 'lorebook');
}

function renderCopilotError() {
    elements.ss_copilot_error.hidden = !state.copilotError;
    elements.ss_copilot_error_message.textContent = state.copilotError;
}

function renderCopilotActionState() {
    const available = Boolean(state.project && state.copilotProjectId === state.project.id);
    const session = currentCopilotSession();
    const sessionStale = copilotSessionAuthorityStale(session, state.project);
    const selectedEvidenceCount = state.copilotSelectedEvidenceIds.size;
    const settingsChanged = state.copilotSettings
        && (state.copilotSettingsMode !== state.copilotSettings.modelMode
            || state.copilotSettingsModel !== state.copilotSettings.model);
    elements.ss_copilot_preview.disabled = !available || state.copilotLoading || state.copilotPreviewing || state.copilotBusy;
    elements.ss_copilot_evidence_defaults.disabled = !state.copilotPreview || state.copilotBusy;
    elements.ss_copilot_evidence_all.disabled = !state.copilotPreview || state.copilotBusy;
    elements.ss_copilot_evidence_none.disabled = !state.copilotPreview || state.copilotBusy;
    elements.ss_copilot_profile.disabled = !available || state.copilotBusy;
    elements.ss_copilot_save_model.disabled = !settingsChanged || state.copilotBusy
        || (state.copilotSettingsMode === 'override' && !state.copilotSettingsModel.trim());
    elements.ss_copilot_test_model.disabled = !state.copilotSettings || state.copilotBusy;
    elements.ss_copilot_option_decrease.disabled = state.copilotOptionCount <= 3 || state.copilotBusy;
    elements.ss_copilot_option_increase.disabled = state.copilotOptionCount >= 6 || state.copilotBusy;
    elements.ss_copilot_create_session.disabled = !copilotPreviewMatchesAuthority() || selectedEvidenceCount === 0
        || state.copilotBusy || state.copilotGenerating;
    elements.ss_copilot_session.disabled = state.copilotLoading || state.copilotGenerating || state.copilotSessions.length === 0;
    elements.ss_copilot_refresh.disabled = !available || state.copilotLoading || state.copilotGenerating || state.copilotBusy;
    elements.ss_copilot_generate.disabled = !session || sessionStale || state.copilotGenerating || state.copilotBusy
        || session.status === 'ready';
    elements.ss_copilot_cancel.disabled = !state.copilotGenerating || state.copilotCancelling;
    elements.ss_copilot_retry.disabled = state.copilotGenerating || state.copilotBusy
        || (!state.copilotRetry && !['failed', 'cancelled'].includes(session?.status));
    elements.ss_copilot_copy.disabled = !copilotArtifact();
    elements.ss_copilot_export.disabled = !copilotArtifact();
    elements.ss_copilot_status.textContent = state.copilotLoading ? '正在载入'
        : state.copilotPreviewing ? '正在汇编上下文'
            : state.copilotCancelling ? '正在取消'
                : state.copilotGenerating ? '正在生成'
                    : state.copilotBusy ? '正在提交'
                        : state.copilotError ? '需要处理'
                            : session ? COPILOT_SESSION_STATUS_LABELS[session.status] || session.status : '就绪';
}

function renderCopilotWorkspace() {
    renderCopilotControls();
    renderCopilotSessions();
    renderCopilotSessionSummary();
    renderCopilotDirections();
    renderCopilotDiffs();
    renderCopilotError();
    renderCopilotActionState();
}

async function loadCopilotProfiles(projectId, resources) {
    const summaries = resources.filter(resource => resource.type === 'prompt-profile');
    const profiles = await Promise.all(summaries.map(async summary => {
        try {
            const detail = await apiRequest(pathForProject(
                projectId,
                `/resources/prompt-profile/${encodeURIComponent(summary.id)}`,
            ));
            return detail.profileVersion === 2 ? detail : null;
        } catch {
            return null;
        }
    }));
    return profiles.filter(Boolean);
}

async function loadCopilotSession(sessionId) {
    const projectId = state.project?.id;
    if (!projectId || !sessionId || state.copilotProjectId !== projectId) return;
    if (state.copilotSessionId !== sessionId) {
        state.copilotSessionId = sessionId;
        state.copilotSession = null;
        state.copilotStream = '';
        persistWorkspaceResumeState();
    }
    const requestSerial = ++state.copilotRequestSerial;
    state.copilotLoading = true;
    state.copilotError = '';
    renderCopilotWorkspace();
    try {
        const session = await apiRequest(copilotPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`));
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotSession = session;
        state.copilotSessionId = session.id;
        state.copilotStream = '';
    } catch (error) {
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotError = error.message || '无法读取策划会话';
        state.copilotRetry = { kind: 'load-session', sessionId };
    } finally {
        if (copilotRequestIsCurrent(projectId, requestSerial)) {
            state.copilotLoading = false;
            renderCopilotWorkspace();
        }
    }
}

async function loadCopilotSessions({ preferredSessionId = state.copilotSessionId } = {}) {
    const projectId = state.project?.id;
    if (!projectId || state.copilotProjectId !== projectId) return;
    const requestSerial = ++state.copilotRequestSerial;
    state.copilotLoading = true;
    state.copilotError = '';
    renderCopilotWorkspace();
    let selectedId = '';
    try {
        const payload = await apiMutation(copilotPath(projectId, '/sessions/reconcile'), {
            method: 'POST',
            body: {},
        });
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
        selectedId = state.copilotSessions.find(item => item.id === preferredSessionId)?.id
            || state.copilotSessions[0]?.id || '';
        state.copilotSessionId = selectedId;
        if (state.copilotSession?.id !== selectedId) {
            state.copilotSession = null;
            state.copilotStream = '';
        }
    } catch (error) {
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotError = error.message || '无法读取策划会话列表';
        state.copilotRetry = { kind: 'load-sessions' };
    } finally {
        if (copilotRequestIsCurrent(projectId, requestSerial)) {
            state.copilotLoading = false;
            renderCopilotWorkspace();
        }
    }
    if (selectedId && state.copilotProjectId === projectId) await loadCopilotSession(selectedId);
    else if (state.copilotProjectId === projectId) persistWorkspaceResumeState();
}

async function loadCopilotWorkspace() {
    const projectId = state.project?.id;
    bindCopilotWorkspace(state.project, state.chapter);
    if (!projectId || state.copilotProjectId !== projectId) {
        renderCopilotWorkspace();
        return;
    }
    const requestSerial = ++state.copilotRequestSerial;
    state.copilotLoading = true;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotWorkspace();
    let selectedId = '';
    try {
        const [settings, resources, sessionsPayload] = await Promise.all([
            apiRequest('/api/copilot/settings'),
            apiRequest(pathForProject(projectId, '/resources')),
            apiMutation(copilotPath(projectId, '/sessions/reconcile'), {
                method: 'POST',
                body: {},
            }),
        ]);
        const profiles = await loadCopilotProfiles(projectId, Array.isArray(resources) ? resources : []);
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotSettings = settings;
        state.copilotSettingsMode = settings.modelMode;
        state.copilotSettingsModel = settings.model;
        state.copilotResources = Array.isArray(resources) ? resources : [];
        state.copilotProfiles = profiles;
        state.copilotSessions = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
        selectedId = state.copilotSessions.find(item => item.id === state.copilotSessionId)?.id
            || state.copilotSessions[0]?.id || '';
        state.copilotSessionId = selectedId;
        if (state.copilotSession?.id !== selectedId) {
            state.copilotSession = null;
            state.copilotStream = '';
        }
    } catch (error) {
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotError = error.message || '无法载入策划工作台';
        state.copilotRetry = { kind: 'workspace' };
    } finally {
        if (copilotRequestIsCurrent(projectId, requestSerial)) {
            state.copilotLoading = false;
            renderCopilotWorkspace();
        }
    }
    if (selectedId && state.copilotProjectId === projectId) await loadCopilotSession(selectedId);
    else if (state.copilotProjectId === projectId) persistWorkspaceResumeState();
}

async function previewCopilotContext() {
    if (!state.project || state.copilotPreviewing || state.copilotBusy) return;
    if (!(await enqueueSave())) return;
    const projectId = state.project.id;
    const body = copilotPreviewRequest();
    const contextEpoch = state.copilotContextEpoch;
    const requestSerial = ++state.copilotRequestSerial;
    state.copilotPreviewing = true;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotWorkspace();
    try {
        const preview = await apiMutation(copilotPath(projectId, '/context-preview'), {
            method: 'POST',
            body,
        });
        if (!copilotRequestIsCurrent(projectId, requestSerial)
            || state.copilotContextEpoch !== contextEpoch) return;
        state.copilotPreview = preview;
        state.copilotSelectedEvidenceIds = new Set((preview.evidenceCatalog || [])
            .filter(record => record.selectedByDefault)
            .map(record => record.evidenceId));
        if (state.copilotSelectedEvidenceIds.size === 0 && preview.evidenceCatalog?.[0]) {
            state.copilotSelectedEvidenceIds.add(preview.evidenceCatalog[0].evidenceId);
        }
    } catch (error) {
        if (!copilotRequestIsCurrent(projectId, requestSerial)
            || state.copilotContextEpoch !== contextEpoch) return;
        state.copilotError = error.message || '无法预览策划上下文';
        state.copilotRetry = { kind: 'preview' };
    } finally {
        if (copilotRequestIsCurrent(projectId, requestSerial)) {
            state.copilotPreviewing = false;
            renderCopilotWorkspace();
        }
    }
}

async function createCopilotSession(retryBody = null) {
    if (!state.project || !state.copilotPreview || state.copilotBusy || state.copilotGenerating) return;
    const projectId = state.project.id;
    const previewDigest = state.copilotPreview.contextDigest;
    let body = retryBody;
    let requestSerial = 0;
    let createdSessionId = '';
    state.copilotBusy = true;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotWorkspace();
    try {
        if (!(await enqueueSave())
            || state.project?.id !== projectId
            || state.copilotProjectId !== projectId) return;
        if (!copilotPreviewMatchesAuthority()
            || state.copilotPreview.contextDigest !== previewDigest
            || (retryBody && (retryBody.projectVersion !== state.project.version
                || retryBody.contextDigest !== state.copilotPreview.contextDigest))) {
            invalidateCopilotPreview({ preserveError: true });
            state.copilotError = '作品或章节已变化，请重新预览上下文后再创建策划会话';
            return;
        }
        const profileRef = copilotProfileRef();
        if (!profileRef || state.copilotSelectedEvidenceIds.size === 0) return;
        body ||= {
            commandId: copilotCommandId('create'),
            projectVersion: state.project.version,
            anchorChapterId: state.copilotPreview.base?.anchorChapterId || null,
            selection: state.copilotPreview.selection,
            retrieval: state.copilotPreview.retrieval,
            contextDigest: state.copilotPreview.contextDigest,
            selectedEvidenceIds: [...state.copilotSelectedEvidenceIds].sort(),
            profileRef,
            optionCount: state.copilotOptionCount,
            instruction: state.copilotInstruction,
        };
        requestSerial = ++state.copilotRequestSerial;
        const session = await apiMutation(copilotPath(projectId, '/sessions'), { method: 'POST', body });
        if (!copilotRequestIsCurrent(projectId, requestSerial)) return;
        state.copilotSession = session;
        state.copilotSessionId = session.id;
        state.copilotStream = '';
        syncCopilotAuthorityState();
        persistWorkspaceResumeState();
        createdSessionId = session.id;
        showToast('策划会话已创建');
    } catch (error) {
        if (state.project?.id !== projectId || state.copilotProjectId !== projectId
            || (requestSerial && !copilotRequestIsCurrent(projectId, requestSerial))) return;
        state.copilotError = error.message || '无法创建策划会话';
        if (body) state.copilotRetry = { kind: 'create', body };
    } finally {
        if (state.project?.id === projectId && state.copilotProjectId === projectId) {
            state.copilotBusy = false;
            renderCopilotWorkspace();
        }
    }
    if (createdSessionId && state.copilotProjectId === projectId) {
        await loadCopilotSessions({ preferredSessionId: createdSessionId });
    }
}

async function saveCopilotSettings(retryBody = null) {
    if (!state.copilotSettings || state.copilotBusy) return;
    const body = retryBody || {
        revision: state.copilotSettings.revision,
        modelMode: state.copilotSettingsMode,
        model: state.copilotSettingsMode === 'override' ? state.copilotSettingsModel.trim() : '',
    };
    state.copilotBusy = true;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotWorkspace();
    try {
        const settings = await apiMutation('/api/copilot/settings', { method: 'PUT', body });
        state.copilotSettings = settings;
        state.copilotSettingsMode = settings.modelMode;
        state.copilotSettingsModel = settings.model;
        showToast('策划模型已保存');
    } catch (error) {
        state.copilotError = error.message || '无法保存策划模型';
        state.copilotRetry = { kind: 'settings', body };
        if (error instanceof ApiError && error.status === 409) {
            try {
                const settings = await apiRequest('/api/copilot/settings');
                state.copilotSettings = settings;
            } catch {
                // Preserve the conflict as the primary error.
            }
        }
    } finally {
        state.copilotBusy = false;
        renderCopilotWorkspace();
    }
}

async function testCopilotSettings() {
    if (!state.copilotSettings || state.copilotBusy) return;
    state.copilotBusy = true;
    state.copilotError = '';
    renderCopilotWorkspace();
    try {
        const payload = await apiMutation('/api/copilot/settings/test', { method: 'POST', body: {} });
        showToast(payload?.result?.ok === false ? '策划模型测试失败' : '策划模型连接正常', 5000);
    } catch (error) {
        state.copilotError = error.message || '策划模型测试失败';
    } finally {
        state.copilotBusy = false;
        renderCopilotWorkspace();
    }
}

async function generateCopilotSession(retryBody = null) {
    const projectId = state.project?.id;
    const session = currentCopilotSession();
    if (!projectId || !session || state.copilotGenerating || state.copilotBusy
        || copilotSessionAuthorityStale(session, state.project)) return;
    const sessionId = session.id;
    const body = retryBody || {
        commandId: copilotCommandId('generate'),
        sessionRevision: session.revision,
    };
    const controller = new AbortController();
    state.copilotGenerationController = controller;
    state.copilotGenerating = true;
    state.copilotCancelling = false;
    state.copilotError = '';
    state.copilotRetry = null;
    state.copilotStream = '';
    renderCopilotWorkspace();
    try {
        const completed = await streamMutation(
            copilotPath(projectId, `/sessions/${encodeURIComponent(session.id)}/generate`),
            body,
            {
                signal: controller.signal,
                onEvent: event => {
                    if (!copilotGenerationIsCurrent(projectId, sessionId, controller)) return;
                    if (event?.type === 'delta') {
                        state.copilotStream += String(event.delta || '');
                        elements.ss_copilot_stream.textContent = state.copilotStream;
                        elements.ss_copilot_stream.hidden = false;
                    } else if (event?.type === 'done') {
                        if (event.session) state.copilotSession = event.session;
                        if (event.artifact && state.copilotSession) state.copilotSession.artifact = event.artifact;
                    } else if (event?.type === 'error') {
                        throw new ApiError(event.message || '策划生成失败', 502, event);
                    }
                    renderCopilotSessionSummary();
                    renderCopilotActionState();
                },
            },
        );
        if (!copilotGenerationIsCurrent(projectId, sessionId, controller)) return;
        if (!completed) {
            throw new ApiError('策划生成数据流提前结束', 502, { error: 'copilot_stream_ended' });
        }
        state.copilotStream = '';
        showToast('策划候选已生成');
    } catch (error) {
        if (!copilotGenerationIsCurrent(projectId, sessionId, controller)) return;
        if (!controller.signal.aborted && !state.copilotCancelling) {
            state.copilotError = error.message || '策划生成失败';
            state.copilotRetry = error instanceof ApiError
                ? { kind: 'generate-new' }
                : { kind: 'generate-receipt', body };
        }
    } finally {
        if (copilotGenerationIsCurrent(projectId, sessionId, controller)) {
            state.copilotGenerationController = null;
            state.copilotGenerating = false;
            state.copilotCancelling = false;
            renderCopilotWorkspace();
        }
    }
    if (state.copilotProjectId === projectId && state.copilotSessionId === sessionId) {
        await loadCopilotSessions({ preferredSessionId: sessionId });
    }
}

async function cancelCopilotGeneration(retryDescriptor = null) {
    const projectId = state.project?.id;
    const sessionId = state.copilotSessionId;
    const generationController = state.copilotGenerationController;
    if (!projectId || !sessionId || !generationController || state.copilotCancelling) return;
    state.copilotCancelling = true;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotActionState();
    let descriptor = retryDescriptor;
    try {
        const latest = await apiRequest(copilotPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`));
        descriptor ||= {
            commandId: copilotCommandId('cancel'),
            sessionRevision: latest.revision,
        };
        await apiMutation(copilotPath(projectId, `/sessions/${encodeURIComponent(sessionId)}/cancel`), {
            method: 'POST',
            body: descriptor,
        });
        generationController.abort(new DOMException('Copilot generation cancelled.', 'AbortError'));
        showToast('策划生成已取消');
    } catch (error) {
        state.copilotCancelling = false;
        state.copilotError = error.message || '无法取消策划生成';
        state.copilotRetry = { kind: 'cancel', descriptor };
        renderCopilotWorkspace();
    }
}

function retryCopilotGeneration() {
    const retry = state.copilotRetry;
    if (retry?.kind === 'create') {
        void createCopilotSession(retry.body);
        return;
    }
    if (retry?.kind === 'generate-receipt') {
        void generateCopilotSession(retry.body);
        return;
    }
    if (retry?.kind === 'generate-new') {
        void generateCopilotSession();
        return;
    }
    if (retry?.kind === 'cancel') {
        void cancelCopilotGeneration(retry.descriptor);
        return;
    }
    if (retry?.kind === 'settings') {
        void saveCopilotSettings(retry.body);
        return;
    }
    if (retry?.kind === 'preview') {
        void previewCopilotContext();
        return;
    }
    if (retry?.kind === 'load-session') {
        void loadCopilotSession(retry.sessionId);
        return;
    }
    if (retry?.kind === 'load-sessions') {
        void loadCopilotSessions();
        return;
    }
    if (retry?.kind === 'workspace') {
        void loadCopilotWorkspace();
        return;
    }
    if (retry?.kind === 'handoff') {
        void startWorkflowFromCopilot(retry.optionId, retry);
        return;
    }
    if (['failed', 'cancelled'].includes(currentCopilotSession()?.status)) {
        void generateCopilotSession();
    }
}

async function copyText(text, successMessage) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.className = 'ss-visually-hidden';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }
    showToast(successMessage);
}

function copyCopilotArtifact() {
    const artifact = copilotArtifact();
    if (artifact) void copyText(JSON.stringify(artifact, null, 2), '策划包已复制');
}

function exportCopilotArtifact() {
    const artifact = copilotArtifact();
    if (!artifact) return;
    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFileName(state.project?.title || 'story')}-${artifact.id}.copilot.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showToast('策划包已导出');
}

function copilotHandoffIsCurrent({
    projectId,
    chapterId,
    sessionId,
    artifactId,
    handoffSerial,
}) {
    return state.copilotHandoffSerial === handoffSerial
        && state.copilotProjectId === projectId
        && state.project?.id === projectId
        && state.chapter?.id === chapterId
        && currentCopilotSession()?.id === sessionId
        && copilotArtifact()?.id === artifactId;
}

async function startWorkflowFromCopilot(optionId, retryDescriptor = null) {
    const project = state.project;
    const chapter = state.chapter;
    const session = currentCopilotSession();
    const artifact = copilotArtifact();
    const option = artifact?.plotOptions?.find(item => item.id === optionId);
    if (state.copilotBusy || !project || !chapter || !session || !artifact || !option) return;
    const eligibility = copilotHandoffEligibility({ project, chapter, session, artifact });
    if (!eligibility.eligible) {
        state.copilotError = eligibility.reason;
        renderCopilotWorkspace();
        return;
    }
    const projectId = project.id;
    const chapterId = chapter.id;
    const binding = {
        sessionId: session.id,
        artifactId: artifact.id,
        optionId: option.id,
    };
    const commandId = retryDescriptor?.commandId || copilotCommandId('workflow');
    const handoffSerial = ++state.copilotHandoffSerial;
    state.copilotBusy = true;
    state.copilotHandoffOptionId = option.id;
    state.copilotError = '';
    state.copilotRetry = null;
    renderCopilotWorkspace();
    try {
        if (!(await enqueueSave()) || !copilotHandoffIsCurrent({
            projectId,
            chapterId,
            sessionId: session.id,
            artifactId: artifact.id,
            handoffSerial,
        })) return;
        const savedEligibility = copilotHandoffEligibility({
            project: state.project,
            chapter: state.chapter,
            session: currentCopilotSession(),
            artifact: copilotArtifact(),
        });
        if (!savedEligibility.eligible) {
            state.copilotError = savedEligibility.reason;
            return;
        }
        if (!copilotHandoffIsCurrent({
            projectId,
            chapterId,
            sessionId: session.id,
            artifactId: artifact.id,
            handoffSerial,
        })) return;
        const payload = await apiMutation(workflowRunsPath(projectId, chapterId), {
            method: 'POST',
            body: {
                commandId,
                definitionId: DEFAULT_WORKFLOW_DEFINITION_ID,
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                input: { copilotHandoff: binding },
            },
        });
        if (!copilotHandoffIsCurrent({
            projectId,
            chapterId,
            sessionId: session.id,
            artifactId: artifact.id,
            handoffSerial,
        })) return;
        bindWorkflowWorkspace(state.project, state.chapter);
        state.workflowRunId = payload?.run?.id || '';
        showToast(`已用“${option.title}”创建章节流程`);
        setView('workflow');
    } catch (error) {
        if (copilotHandoffIsCurrent({
            projectId,
            chapterId,
            sessionId: session.id,
            artifactId: artifact.id,
            handoffSerial,
        })) {
            if (error instanceof ApiError && error.code === 'workflow_active_run_exists'
                && error.data?.activeRunId) {
                bindWorkflowWorkspace(state.project, state.chapter);
                state.workflowRunId = error.data.activeRunId;
                showToast('当前章节已有进行中的流程，已为你打开');
                setView('workflow');
                return;
            }
            state.copilotError = error.message || '方向交接到章节流程失败';
            if (error instanceof ApiError && error.code === 'workflow_active_run_exists') {
                state.copilotError = '当前章节已有进行中的流程，请先进入“流程”继续或结束它';
            } else if (error instanceof ApiError && error.code === 'copilot_context_changed') {
                state.copilotError = error.data?.runId
                    ? '策划上下文已变化，未完成的交接流程已自动终止；请刷新上下文并重新生成方向'
                    : '策划上下文已变化，请刷新上下文并重新生成方向';
            } else if (!(error instanceof ApiError) || error.status >= 500) {
                state.copilotRetry = {
                    kind: 'handoff',
                    optionId: option.id,
                    commandId,
                };
            }
        }
    } finally {
        if (state.copilotHandoffSerial === handoffSerial) {
            state.copilotBusy = false;
            state.copilotHandoffOptionId = '';
            renderCopilotWorkspace();
        }
    }
}

function qualityBindingMatches(projectId, chapterId) {
    return state.qualityProjectId === (projectId || '')
        && state.qualityChapterId === (chapterId || '');
}

function qualityRequestIsCurrent(projectId, chapterId, requestSerial) {
    return state.project?.id === projectId
        && (state.chapter?.id || '') === (chapterId || '')
        && qualityBindingMatches(projectId, chapterId)
        && state.qualityRequestSerial === requestSerial;
}

function resetQualityWorkspace() {
    state.qualityRequestSerial += 1;
    state.qualityBuiltinRevision = null;
    state.qualityProfiles = [];
    state.qualityOverlays = [];
    state.qualityProfileId = '';
    state.qualityProfileDetail = null;
    state.qualityOverlayId = 'none';
    state.qualityPreview = null;
    state.qualityReports = [];
    state.qualityReportCorrupt = [];
    state.qualityReport = null;
    state.qualityReportId = '';
    state.qualitySuite = null;
    state.qualityBaseline = null;
    state.qualityRuns = [];
    state.qualityRunCorrupt = [];
    state.qualityRun = null;
    state.qualityRunId = '';
    state.qualityComparison = null;
    state.qualityLoading = false;
    state.qualityBusy = false;
    state.qualityError = '';
    state.qualityRetry = null;
    state.qualityCopyStatus = '';
}

function bindQualityWorkspace(project = state.project, chapter = state.chapter) {
    const projectId = project?.id || '';
    const chapterId = chapter?.id || '';
    if (qualityBindingMatches(projectId, chapterId)) return false;
    resetQualityWorkspace();
    state.qualityProjectId = projectId;
    state.qualityChapterId = chapterId;
    return true;
}

function setQualityError(error, retry) {
    state.qualityError = error?.message || '质量工作台操作失败';
    state.qualityRetry = retry;
}

function qualityTag(text, tone = '') {
    const span = document.createElement('span');
    span.className = 'ss-quality-tag';
    if (tone) span.dataset.tone = tone;
    span.textContent = text;
    return span;
}

function qualityMetricValue(metric, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (['casePassRate', 'profileCompileRate'].includes(metric)) {
        return `${(number * 100).toFixed(number === 1 || number === 0 ? 0 : 1)}%`;
    }
    if (Number.isInteger(number)) return numberFormatter.format(number);
    return number.toFixed(3);
}

function qualityReportSummary(record) {
    return {
        id: record.id,
        projectId: record.projectId,
        chapterId: record.chapterId,
        source: record.source,
        authority: record.authority,
        passed: record.report?.passed === true,
        severityCounts: record.report?.metrics?.severityCounts || {},
        reportDigest: record.report?.reportDigest || '',
        createdAt: record.createdAt,
    };
}

function qualityRunSummary(record) {
    return {
        id: record.id,
        suiteId: record.suiteId,
        reportDigest: record.report?.reportDigest || '',
        generatedAt: record.report?.generatedAt || null,
        metrics: record.report?.metrics || {},
        createdAt: record.createdAt,
    };
}

function renderQualityProfileCatalog() {
    elements.ss_quality_builtin_revision.textContent = state.qualityBuiltinRevision
        ? `内置修订 ${state.qualityBuiltinRevision} · ${state.qualityProfiles.length} 套`
        : '';
    elements.ss_quality_profile_catalog.replaceChildren();
    if (state.qualityProfiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ss-inline-empty';
        empty.textContent = state.qualityLoading ? '正在载入内置 Profile' : '暂无内置 Profile';
        elements.ss_quality_profile_catalog.append(empty);
    } else {
        for (const profile of state.qualityProfiles) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ss-quality-profile-card';
            button.dataset.qualityProfileId = profile.id;
            button.dataset.selected = String(profile.id === state.qualityProfileId);
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(profile.id === state.qualityProfileId));

            const heading = document.createElement('span');
            heading.className = 'ss-quality-profile-name';
            heading.textContent = profile.name;
            const task = document.createElement('span');
            task.className = 'ss-quality-profile-task';
            task.textContent = QUALITY_TASK_LABELS[profile.task] || profile.task;
            const meta = document.createElement('span');
            meta.className = 'ss-quality-profile-meta';
            meta.textContent = `${numberFormatter.format(profile.generation?.maxTokens || 0)} 输出 tokens · ${numberFormatter.format(profile.tokenBudget || 0)} prompt tokens`;
            button.append(heading, task, meta);
            elements.ss_quality_profile_catalog.append(button);
        }
    }

    elements.ss_quality_profile_detail.replaceChildren();
    const detail = state.qualityProfileDetail?.id === state.qualityProfileId
        ? state.qualityProfileDetail
        : null;
    if (detail) {
        const heading = document.createElement('div');
        heading.className = 'ss-quality-profile-detail-heading';
        const title = document.createElement('strong');
        title.textContent = detail.name;
        heading.append(
            title,
            qualityTag(QUALITY_TASK_LABELS[detail.compatibility?.task] || detail.compatibility?.task || 'Profile'),
            qualityTag('只读内置', 'neutral'),
        );
        const contract = detail.modules?.find(module => module.id?.startsWith('contract-'))?.template || '';
        const copy = document.createElement('pre');
        copy.textContent = contract;
        const generation = document.createElement('p');
        generation.textContent = `temperature ${detail.generation?.temperature ?? '—'} · topP ${detail.generation?.topP ?? '—'} · maxTokens ${numberFormatter.format(detail.generation?.maxTokens || 0)}`;
        elements.ss_quality_profile_detail.append(heading, generation, copy);
    } else {
        const empty = document.createElement('div');
        empty.className = 'ss-inline-empty';
        empty.textContent = state.qualityProfileId ? '正在读取 Profile 合同' : '选择 Profile 查看合同';
        elements.ss_quality_profile_detail.append(empty);
    }

    const selectedOverlay = state.qualityOverlayId;
    elements.ss_quality_copy_overlay.replaceChildren();
    const none = document.createElement('option');
    none.value = 'none';
    none.textContent = '不叠加';
    elements.ss_quality_copy_overlay.append(none);
    elements.ss_quality_overlay_catalog.replaceChildren();
    for (const overlay of state.qualityOverlays) {
        const option = document.createElement('option');
        option.value = overlay.id;
        option.textContent = overlay.name;
        elements.ss_quality_copy_overlay.append(option);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ss-quality-overlay-card';
        button.dataset.qualityOverlayId = overlay.id;
        button.classList.toggle('is-selected', overlay.id === selectedOverlay);
        button.setAttribute('aria-pressed', String(overlay.id === selectedOverlay));
        const name = document.createElement('strong');
        name.textContent = overlay.name;
        const guidance = document.createElement('span');
        guidance.textContent = overlay.guidance;
        button.append(name, guidance);
        elements.ss_quality_overlay_catalog.append(button);
    }
    elements.ss_quality_copy_overlay.value = state.qualityOverlays.some(item => item.id === selectedOverlay)
        ? selectedOverlay
        : 'none';
    elements.ss_quality_copy_status.textContent = state.qualityCopyStatus;
    elements.ss_quality_copy_status.dataset.state = state.qualityCopyStatus ? 'saved' : '';
}

function activeQualityReport() {
    if (state.qualityReport?.report) {
        return { report: state.qualityReport.report, record: state.qualityReport, kind: 'persisted' };
    }
    if (state.qualityPreview?.report) {
        return { report: state.qualityPreview.report, record: state.qualityPreview, kind: 'preview' };
    }
    return null;
}

function renderQualityReportSummary() {
    const active = activeQualityReport();
    elements.ss_quality_chapter_label.textContent = state.chapter
        ? `第${state.chapter.number}章 · ${state.chapter.title || '未命名章节'}${state.chapterDirty ? ' · 当前稿未保存' : ''}`
        : '当前作品没有可检查章节';
    elements.ss_quality_chapter_summary.replaceChildren();
    elements.ss_quality_issue_list.replaceChildren();

    if (!active) {
        elements.ss_quality_issue_empty.hidden = false;
        elements.ss_quality_issue_empty.textContent = state.chapter
            ? '运行预览或打开历史报告后显示问题'
            : '当前作品没有可检查章节';
    } else {
        const { report, kind } = active;
        const counts = report.metrics?.severityCounts || {};
        elements.ss_quality_chapter_summary.append(
            qualityTag(report.passed ? '通过' : '需处理', report.passed ? 'success' : 'danger'),
            qualityTag(kind === 'preview' ? '临时预览' : '持久报告', 'neutral'),
            qualityTag(`${numberFormatter.format(report.contentUnits || 0)} 字`),
            qualityTag(`${numberFormatter.format(report.metrics?.paragraphs || 0)} 段`),
            qualityTag(`阻断 ${counts.blocker || 0}`, counts.blocker ? 'danger' : ''),
            qualityTag(`主要 ${counts.major || 0}`, counts.major ? 'warning' : ''),
            qualityTag(`次要 ${counts.minor || 0}`),
        );
        const issues = Array.isArray(report.issues) ? report.issues : [];
        elements.ss_quality_issue_empty.hidden = issues.length > 0;
        elements.ss_quality_issue_empty.textContent = '本次检查没有发现质量问题';
        for (const issue of issues) {
            const article = document.createElement('article');
            article.className = 'ss-quality-issue';
            article.dataset.severity = issue.severity;
            article.setAttribute('role', 'listitem');

            const header = document.createElement('header');
            const identity = document.createElement('div');
            identity.append(
                qualityTag(QUALITY_SEVERITY_LABELS[issue.severity] || issue.severity, issue.severity),
                qualityTag(issue.ruleId, 'neutral'),
                qualityTag(`第${Number(issue.paragraphIndex || 0) + 1}段`),
            );
            const offset = document.createElement('code');
            offset.textContent = `UTF-16 ${issue.start}–${issue.end}`;
            header.append(identity, offset);

            const quote = document.createElement('blockquote');
            quote.textContent = issue.quote;
            const message = document.createElement('p');
            message.className = 'ss-quality-issue-message';
            message.textContent = issue.message;
            const suggestion = document.createElement('p');
            suggestion.className = 'ss-quality-issue-suggestion';
            const suggestionLabel = document.createElement('strong');
            suggestionLabel.textContent = '建议：';
            suggestion.append(suggestionLabel, document.createTextNode(issue.suggestion || ''));
            const evidence = document.createElement('div');
            evidence.className = 'ss-quality-evidence-ids';
            const evidenceIds = Array.isArray(issue.evidenceIds) ? issue.evidenceIds : [];
            evidence.append(qualityTag(`evidenceIds ${evidenceIds.length}`, 'neutral'));
            for (const evidenceId of evidenceIds) {
                const code = document.createElement('code');
                code.textContent = evidenceId;
                evidence.append(code);
            }
            article.append(header, quote, message, suggestion, evidence);
            elements.ss_quality_issue_list.append(article);
        }
    }

    const selectedId = state.qualityReportId;
    elements.ss_quality_report_select.replaceChildren();
    if (state.qualityReports.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无持久报告';
        elements.ss_quality_report_select.append(option);
    } else {
        for (const report of state.qualityReports) {
            const option = document.createElement('option');
            option.value = report.id;
            const counts = report.severityCounts || {};
            option.textContent = `${formatDate(report.createdAt)} · ${report.passed ? '通过' : `阻断 ${counts.blocker || 0} / 主要 ${counts.major || 0}`}`;
            option.selected = report.id === selectedId;
            elements.ss_quality_report_select.append(option);
        }
    }
    if (state.qualityReports.some(report => report.id === selectedId)) {
        elements.ss_quality_report_select.value = selectedId;
    }
    elements.ss_quality_report_meta.replaceChildren();
    if (state.qualityReport) {
        elements.ss_quality_report_meta.append(
            qualityTag(`保存于 ${formatDate(state.qualityReport.createdAt)}`, 'neutral'),
            qualityTag(state.qualityReport.source?.type === 'generation' ? '候选稿来源' : '章节权威正文'),
            qualityTag(`项目 v${state.qualityReport.authority?.projectVersion || '—'}`),
            qualityTag(`章节 r${state.qualityReport.authority?.chapterRevision || '—'}`),
        );
    } else if (state.qualityPreview) {
        elements.ss_quality_report_meta.append(qualityTag('临时预览未写入报告存储', 'neutral'));
    }
    if (state.qualityReportCorrupt.length > 0) {
        elements.ss_quality_report_meta.append(qualityTag(`${state.qualityReportCorrupt.length} 份损坏记录已隔离`, 'danger'));
    }
}

function renderQualityRegressionSummary(container, report) {
    container.replaceChildren();
    if (!report) {
        const empty = document.createElement('div');
        empty.className = 'ss-inline-empty';
        empty.textContent = state.qualityLoading ? '正在读取' : '暂无数据';
        container.append(empty);
        return;
    }
    const metrics = report.metrics || {};
    container.append(
        qualityTag(`用例 ${qualityMetricValue('cases', metrics.passedCases)} / ${qualityMetricValue('cases', metrics.cases)}`),
        qualityTag(`用例通过率 ${qualityMetricValue('casePassRate', metrics.casePassRate)}`, metrics.casePassRate === 1 ? 'success' : 'warning'),
        qualityTag(`编译 ${qualityMetricValue('profileCompileRate', metrics.profileCompileRate)}`, metrics.profileCompileRate === 1 ? 'success' : 'danger'),
        qualityTag(`阻断密度 ${qualityMetricValue('blockersPerThousandUnits', metrics.blockersPerThousandUnits)}`),
        qualityTag(`主要密度 ${qualityMetricValue('majorsPerThousandUnits', metrics.majorsPerThousandUnits)}`),
    );
}

function renderQualityRegression() {
    elements.ss_quality_suite_meta.replaceChildren();
    if (state.qualitySuite) {
        elements.ss_quality_suite_meta.append(
            qualityTag(state.qualitySuite.name),
            qualityTag(`固定修订 ${state.qualitySuite.revision}`, 'neutral'),
            qualityTag(`${state.qualitySuite.cases?.length || 0} 个公开样例`),
        );
    }
    renderQualityRegressionSummary(elements.ss_quality_baseline_summary, state.qualityBaseline);

    const selectedId = state.qualityRunId;
    elements.ss_quality_run_select.replaceChildren();
    if (state.qualityRuns.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '尚未运行固定集';
        elements.ss_quality_run_select.append(option);
    } else {
        for (const run of state.qualityRuns) {
            const option = document.createElement('option');
            option.value = run.id;
            option.textContent = `${formatDate(run.createdAt)} · 用例 ${qualityMetricValue('casePassRate', run.metrics?.casePassRate)} · 编译 ${qualityMetricValue('profileCompileRate', run.metrics?.profileCompileRate)}`;
            option.selected = run.id === selectedId;
            elements.ss_quality_run_select.append(option);
        }
    }
    if (state.qualityRuns.some(run => run.id === selectedId)) {
        elements.ss_quality_run_select.value = selectedId;
    }
    const selectedSummary = state.qualityRuns.find(run => run.id === state.qualityRunId);
    renderQualityRegressionSummary(
        elements.ss_quality_run_summary,
        state.qualityRun?.report || (selectedSummary ? { metrics: selectedSummary.metrics } : null),
    );
    if (state.qualityRunCorrupt.length > 0) {
        elements.ss_quality_run_summary.append(qualityTag(`${state.qualityRunCorrupt.length} 次损坏运行已隔离`, 'danger'));
    }

    const comparison = state.qualityComparison?.comparison || null;
    elements.ss_quality_gate_list.replaceChildren();
    elements.ss_quality_gate_empty.hidden = Boolean(comparison);
    elements.ss_quality_gate_status.textContent = comparison
        ? comparison.passed ? '门禁通过' : '门禁阻断'
        : '';
    elements.ss_quality_gate_status.dataset.state = comparison
        ? comparison.passed ? 'saved' : 'error'
        : '';
    if (comparison) {
        for (const gate of comparison.gates || []) {
            const row = document.createElement('div');
            row.className = 'ss-quality-gate';
            row.dataset.passed = String(gate.passed);
            const name = document.createElement('strong');
            name.textContent = QUALITY_GATE_LABELS[gate.metric] || gate.metric;
            const values = document.createElement('span');
            values.textContent = `${qualityMetricValue(gate.metric, gate.baseline)} → ${qualityMetricValue(gate.metric, gate.candidate)}`;
            const delta = document.createElement('code');
            const sign = Number(gate.delta) > 0 ? '+' : '';
            delta.textContent = `Δ ${sign}${qualityMetricValue(gate.metric, gate.delta)}`;
            const result = document.createElement('span');
            result.className = 'ss-quality-gate-result';
            result.textContent = gate.passed ? '通过' : '阻断';
            row.append(name, values, delta, result);
            elements.ss_quality_gate_list.append(row);
        }
        const profileChanges = (comparison.profileDiffs || []).filter(diff => diff.changed).length;
        const profileFailures = (comparison.profileDiffs || []).filter(diff => !diff.passed).length;
        const row = document.createElement('div');
        row.className = 'ss-quality-gate ss-quality-profile-gate';
        row.dataset.passed = String(profileFailures === 0);
        const name = document.createElement('strong');
        name.textContent = 'Profile hash / 编译';
        const values = document.createElement('span');
        values.textContent = `${profileChanges} 个 hash 变化 · ${profileFailures} 个编译失败`;
        const result = document.createElement('span');
        result.className = 'ss-quality-gate-result';
        result.textContent = profileFailures === 0 ? '通过' : '阻断';
        row.append(name, values, result);
        elements.ss_quality_gate_list.append(row);
    }
}

function renderQualityActionState() {
    const hasProject = Boolean(state.project);
    const hasChapter = Boolean(state.chapter);
    const locked = state.qualityLoading || state.qualityBusy;
    const hasContent = Boolean(state.chapter?.content?.trim());
    elements.ss_quality_workspace.toggleAttribute('aria-busy', locked);
    elements.ss_quality_status.textContent = state.qualityLoading
        ? '正在载入'
        : state.qualityBusy
            ? '正在处理'
            : state.qualityError
                ? '操作失败'
                : hasProject ? '已就绪' : '等待作品';
    elements.ss_quality_status.dataset.state = state.qualityError
        ? 'error'
        : locked ? 'saving' : hasProject ? 'saved' : '';
    elements.ss_quality_refresh.disabled = locked || !hasProject;
    elements.ss_quality_copy_profile.disabled = locked || !hasProject || !state.qualityProfileId;
    elements.ss_quality_copy_name.disabled = locked || !hasProject;
    elements.ss_quality_copy_overlay.disabled = locked || !hasProject;
    elements.ss_quality_preview.disabled = locked || !hasChapter || !hasContent;
    elements.ss_quality_save_report.disabled = locked || !hasChapter || !hasContent;
    elements.ss_quality_refresh_reports.disabled = locked || !hasChapter;
    elements.ss_quality_report_select.disabled = locked || state.qualityReports.length === 0;
    elements.ss_quality_open_report.disabled = locked || !state.qualityReportId;
    elements.ss_quality_run_regression.disabled = locked || !hasProject;
    elements.ss_quality_run_select.disabled = locked || state.qualityRuns.length === 0;
    elements.ss_quality_open_run.disabled = locked || !state.qualityRunId;
    elements.ss_quality_compare_baseline.disabled = locked || !state.qualityRunId || !state.qualityBaseline;
    elements.ss_quality_error.hidden = !state.qualityError;
    elements.ss_quality_error_message.textContent = state.qualityError;
    elements.ss_quality_retry.disabled = locked || !state.qualityRetry;
}

function renderQualityWorkspace() {
    const hasProject = Boolean(state.project);
    elements.ss_quality_no_project.hidden = hasProject;
    elements.ss_quality_workspace.hidden = !hasProject;
    renderQualityProfileCatalog();
    renderQualityReportSummary();
    renderQualityRegression();
    renderQualityActionState();
}

async function loadQualityProfileDetail(profileId = state.qualityProfileId) {
    if (!profileId || !state.project) return;
    const projectId = state.project.id;
    const chapterId = state.chapter?.id || '';
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityProfileId = profileId;
    state.qualityProfileDetail = null;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const payload = await apiRequest(`${API_ROOT}/prompt-profiles/builtins/${encodeURIComponent(profileId)}`);
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)
            || state.qualityProfileId !== profileId) return;
        state.qualityProfileDetail = payload.profile;
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'profile', profileId });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) renderQualityWorkspace();
    }
}

async function loadQualityWorkspace() {
    bindQualityWorkspace(state.project, state.chapter);
    const projectId = state.project?.id || '';
    const chapterId = state.chapter?.id || '';
    if (!projectId) {
        renderQualityWorkspace();
        return;
    }
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityLoading = true;
    state.qualityError = '';
    state.qualityRetry = null;
    state.qualityCopyStatus = '';
    renderQualityWorkspace();
    try {
        const reportRequest = chapterId
            ? apiRequest(qualityChapterPath(projectId, chapterId, '-reports'))
            : Promise.resolve({ reports: [], corrupt: [] });
        const [builtins, suite, baseline, runs, reportList] = await Promise.all([
            apiRequest(`${API_ROOT}/prompt-profiles/builtins`),
            apiRequest(qualityRegressionPath('/suite')),
            apiRequest(qualityRegressionPath('/baseline')),
            apiRequest(qualityRegressionPath('/runs')),
            reportRequest,
        ]);
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityBuiltinRevision = builtins.builtinRevision;
        state.qualityProfiles = Array.isArray(builtins.profiles) ? builtins.profiles : [];
        state.qualityOverlays = Array.isArray(builtins.genreOverlays) ? builtins.genreOverlays : [];
        if (!state.qualityProfiles.some(profile => profile.id === state.qualityProfileId)) {
            state.qualityProfileId = state.qualityProfiles[0]?.id || '';
        }
        state.qualitySuite = suite.suite || null;
        state.qualityBaseline = baseline || null;
        state.qualityRuns = Array.isArray(runs.runs) ? runs.runs : [];
        state.qualityRunCorrupt = Array.isArray(runs.corrupt) ? runs.corrupt : [];
        if (!state.qualityRuns.some(run => run.id === state.qualityRunId)) {
            state.qualityRunId = state.qualityRuns[0]?.id || '';
            state.qualityRun = null;
        }
        state.qualityReports = Array.isArray(reportList.reports) ? reportList.reports : [];
        state.qualityReportCorrupt = Array.isArray(reportList.corrupt) ? reportList.corrupt : [];
        if (!state.qualityReports.some(report => report.id === state.qualityReportId)) {
            state.qualityReportId = state.qualityReports[0]?.id || '';
            state.qualityReport = null;
        }
        state.qualityComparison = null;
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'workspace' });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityLoading = false;
            renderQualityWorkspace();
            if (state.qualityProfileId) void loadQualityProfileDetail(state.qualityProfileId);
        }
    }
}

async function copyQualityProfile() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id || '';
    const profileId = state.qualityProfileId;
    if (!projectId || !profileId || state.qualityBusy) return;
    state.qualityBusy = true;
    const authorityMutationToken = beginAuthorityMutation('quality');
    state.qualityError = '';
    state.qualityRetry = null;
    state.qualityCopyStatus = '';
    renderQualityWorkspace();
    try {
        if (!(await enqueueSave()) || state.project?.id !== projectId) return;
        const result = await apiMutation(
            pathForProject(
                projectId,
                `/prompt-profiles/builtins/${encodeURIComponent(profileId)}/copies`,
            ),
            {
                method: 'POST',
                body: {
                    projectVersion: state.project.version,
                    name: elements.ss_quality_copy_name.value.trim(),
                    genreOverlay: state.qualityOverlayId,
                },
            },
        );
        if (!qualityBindingMatches(projectId, chapterId)) return;
        acceptServerProject(result.project);
        renderSaveMetadata();
        state.qualityCopyStatus = `已复制“${result.resource?.name || 'Profile 副本'}”，可在资源工作区继续编辑`;
        elements.ss_quality_copy_name.value = '';
        showToast('内置 Profile 已复制到当前项目');
    } catch (error) {
        if (qualityBindingMatches(projectId, chapterId)) {
            setQualityError(error, { kind: 'copy-profile' });
        }
    } finally {
        if (qualityBindingMatches(projectId, chapterId)) {
            state.qualityBusy = false;
        }
        finishAuthorityMutation(authorityMutationToken);
        if (qualityBindingMatches(projectId, chapterId)) renderQualityWorkspace();
    }
}

async function previewCurrentChapterQuality() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    if (!projectId || !chapterId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const preview = await apiMutation(qualityChapterPath(projectId, chapterId, '-preview'), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                content: state.chapter.content,
            },
        });
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityPreview = preview;
        state.qualityReport = null;
        showToast('当前稿质量预览已完成');
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'preview' });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function saveCurrentChapterQualityReport() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    if (!projectId || !chapterId || state.qualityBusy) return;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        if (!(await enqueueSave()) || state.project?.id !== projectId || state.chapter?.id !== chapterId) return;
        const record = await apiMutation(qualityChapterPath(projectId, chapterId, '-reports'), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                source: { type: 'chapter' },
            },
        });
        if (!qualityBindingMatches(projectId, chapterId)) return;
        const summary = qualityReportSummary(record);
        state.qualityReports = [
            summary,
            ...state.qualityReports.filter(item => item.id !== summary.id),
        ];
        state.qualityReportId = record.id;
        state.qualityReport = record;
        state.qualityPreview = null;
        showToast('章节质量报告已持久保存');
    } catch (error) {
        if (qualityBindingMatches(projectId, chapterId)) {
            setQualityError(error, { kind: 'save-report' });
        }
    } finally {
        if (qualityBindingMatches(projectId, chapterId)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function loadQualityReports() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    if (!projectId || !chapterId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const payload = await apiRequest(qualityChapterPath(projectId, chapterId, '-reports'));
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityReports = Array.isArray(payload.reports) ? payload.reports : [];
        state.qualityReportCorrupt = Array.isArray(payload.corrupt) ? payload.corrupt : [];
        if (!state.qualityReports.some(report => report.id === state.qualityReportId)) {
            state.qualityReportId = state.qualityReports[0]?.id || '';
            state.qualityReport = null;
        }
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'reports' });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function openQualityReport(reportId = state.qualityReportId) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    if (!projectId || !chapterId || !reportId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const record = await apiRequest(qualityChapterPath(
            projectId,
            chapterId,
            `-reports/${encodeURIComponent(reportId)}`,
        ));
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityReportId = reportId;
        state.qualityReport = record;
        state.qualityPreview = null;
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'report', reportId });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function runFixedQualityRegression() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id || '';
    if (!projectId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    state.qualityComparison = null;
    renderQualityWorkspace();
    try {
        const record = await apiMutation(qualityRegressionPath('/runs'), {
            method: 'POST',
            body: {},
        });
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        const summary = qualityRunSummary(record);
        state.qualityRuns = [summary, ...state.qualityRuns.filter(item => item.id !== summary.id)];
        state.qualityRunId = record.id;
        state.qualityRun = record;
        showToast('固定质量回归已完成');
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'run-regression' });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function openQualityRun(runId = state.qualityRunId) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id || '';
    if (!projectId || !runId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const record = await apiRequest(qualityRegressionPath(`/runs/${encodeURIComponent(runId)}`));
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityRunId = runId;
        state.qualityRun = record;
        state.qualityComparison = null;
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'run', runId });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

async function compareQualityRunToBaseline() {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id || '';
    const runId = state.qualityRunId;
    if (!projectId || !runId || state.qualityBusy) return;
    const requestSerial = ++state.qualityRequestSerial;
    state.qualityBusy = true;
    state.qualityError = '';
    state.qualityRetry = null;
    renderQualityWorkspace();
    try {
        const comparison = await apiMutation(qualityRegressionPath('/comparisons'), {
            method: 'POST',
            body: { candidateRunId: runId },
        });
        if (!qualityRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.qualityComparison = comparison;
        showToast(comparison.comparison?.passed ? '质量回归门禁通过' : '质量回归门禁已阻断');
    } catch (error) {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            setQualityError(error, { kind: 'compare' });
        }
    } finally {
        if (qualityRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.qualityBusy = false;
            renderQualityWorkspace();
        }
    }
}

function retryQualityAction() {
    const retry = state.qualityRetry;
    if (!retry) return;
    if (retry.kind === 'profile') void loadQualityProfileDetail(retry.profileId);
    else if (retry.kind === 'copy-profile') void copyQualityProfile();
    else if (retry.kind === 'preview') void previewCurrentChapterQuality();
    else if (retry.kind === 'save-report') void saveCurrentChapterQualityReport();
    else if (retry.kind === 'reports') void loadQualityReports();
    else if (retry.kind === 'report') void openQualityReport(retry.reportId);
    else if (retry.kind === 'run-regression') void runFixedQualityRegression();
    else if (retry.kind === 'run') void openQualityRun(retry.runId);
    else if (retry.kind === 'compare') void compareQualityRunToBaseline();
    else void loadQualityWorkspace();
}

function workflowDefinitionList(payload) {
    const definitions = Array.isArray(payload) ? payload : payload?.definitions;
    return Array.isArray(definitions) ? definitions : [];
}

function workflowRunList(payload) {
    const runs = Array.isArray(payload) ? payload : payload?.runs;
    return Array.isArray(runs) ? runs : [];
}

function workflowBindingMatches(projectId, chapterId) {
    return state.workflowProjectId === (projectId || '')
        && state.workflowChapterId === (chapterId || '');
}

function workflowRequestIsCurrent(projectId, chapterId, requestSerial) {
    return state.project?.id === projectId
        && state.chapter?.id === chapterId
        && workflowBindingMatches(projectId, chapterId)
        && state.workflowRequestSerial === requestSerial;
}

function resetWorkflowWorkspace({ preserveDefinitions = true } = {}) {
    state.workflowCommandController?.abort();
    state.workflowRequestSerial += 1;
    if (!preserveDefinitions) state.workflowDefinitions = [];
    state.workflowRuns = [];
    state.workflowRun = null;
    state.workflowArtifacts = [];
    state.workflowAuthority = null;
    state.workflowCommand = null;
    state.workflowRunId = '';
    state.workflowArtifactId = '';
    state.workflowLoading = false;
    state.workflowBusy = false;
    state.workflowCancelling = false;
    state.workflowCommandController = null;
    state.workflowError = '';
    state.workflowRetry = null;
}

function preferredWorkflowDefinitionId(definitions = state.workflowDefinitions) {
    return definitions.find(definition => definition.id === DEFAULT_WORKFLOW_DEFINITION_ID)?.id
        || definitions[0]?.id
        || '';
}

function bindWorkflowWorkspace(project = state.project, chapter = state.chapter) {
    const projectId = project?.id || '';
    const chapterId = chapter?.id || '';
    if (workflowBindingMatches(projectId, chapterId)) return false;
    resetWorkflowWorkspace();
    state.workflowProjectId = projectId;
    state.workflowChapterId = chapterId;
    if (!state.workflowDefinitions.some(definition => definition.id === state.workflowDefinitionId)) {
        state.workflowDefinitionId = preferredWorkflowDefinitionId();
    }
    return true;
}

function selectedWorkflowDefinition() {
    return state.workflowDefinitions.find(definition => definition.id === state.workflowDefinitionId)
        || state.workflowDefinitions.find(definition => definition.id === state.workflowRun?.definitionId)
        || null;
}

function activeWorkflowDefinition() {
    return state.workflowDefinitions.find(definition => definition.id === state.workflowRun?.definitionId)
        || selectedWorkflowDefinition();
}

function currentWorkflowStep() {
    const run = state.workflowRun;
    const definitionStep = activeWorkflowDefinition()?.steps?.find(step => step.id === run?.currentStepId) || null;
    const runStep = run?.steps?.find(step => step.id === run.currentStepId) || null;
    return definitionStep || runStep ? { ...(definitionStep || {}), ...(runStep || {}) } : null;
}

function mergeWorkflowArtifacts(current, payload) {
    const incoming = [
        ...(Array.isArray(payload?.artifacts) ? payload.artifacts : []),
        ...(payload?.artifact ? [payload.artifact] : []),
    ];
    if (incoming.length === 0) return current;
    const merged = new Map(current.map(artifact => [artifact.id, artifact]));
    for (const artifact of incoming) {
        if (artifact?.id) merged.set(artifact.id, artifact);
    }
    return [...merged.values()].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function applyWorkflowPayload(payload, { replaceArtifacts = false } = {}) {
    const run = payload?.run || (payload?.id && payload?.steps ? payload : null);
    if (!run) throw new Error('服务端没有返回流程运行状态');
    if (run.projectId !== state.workflowProjectId || run.chapterId !== state.workflowChapterId) {
        throw new Error('服务端返回了不属于当前章节的流程运行');
    }
    if (payload?.definition?.id) {
        const definitionIndex = state.workflowDefinitions.findIndex(item => item.id === payload.definition.id);
        if (definitionIndex >= 0) state.workflowDefinitions.splice(definitionIndex, 1, payload.definition);
        else state.workflowDefinitions.push(payload.definition);
    }
    state.workflowRun = run;
    state.workflowRunId = run.id;
    persistWorkspaceResumeState();
    const existingIndex = state.workflowRuns.findIndex(item => item.id === run.id);
    if (existingIndex >= 0) state.workflowRuns.splice(existingIndex, 1, run);
    else state.workflowRuns.unshift(run);
    if (replaceArtifacts) state.workflowArtifacts = [];
    state.workflowArtifacts = mergeWorkflowArtifacts(state.workflowArtifacts, payload);
    state.workflowAuthority = payload?.authority || state.workflowAuthority;
    state.workflowCommand = payload?.command || state.workflowCommand;
    if (payload?.artifact?.id) state.workflowArtifactId = payload.artifact.id;
    const artifactExists = state.workflowArtifacts.some(artifact => artifact.id === state.workflowArtifactId);
    if (!artifactExists) {
        const currentId = run.currentStepId;
        const preferred = [...state.workflowArtifacts].reverse().find(artifact => (
            artifact.stepId === currentId && ['candidate', 'approved'].includes(artifact.status)
        )) || [...state.workflowArtifacts].reverse().find(artifact => ['candidate', 'approved'].includes(artifact.status))
            || state.workflowArtifacts.at(-1);
        state.workflowArtifactId = preferred?.id || '';
    }
}

function renderWorkflowSelects() {
    const definitionSelection = state.workflowDefinitionId;
    elements.ss_workflow_definition.replaceChildren();
    if (state.workflowDefinitions.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无定义';
        elements.ss_workflow_definition.append(option);
    } else {
        for (const definition of state.workflowDefinitions) {
            const option = document.createElement('option');
            option.value = definition.id;
            option.textContent = `${definition.name} · r${definition.revision}`;
            elements.ss_workflow_definition.append(option);
        }
    }
    elements.ss_workflow_definition.value = state.workflowDefinitions.some(item => item.id === definitionSelection)
        ? definitionSelection
        : preferredWorkflowDefinitionId();
    state.workflowDefinitionId = elements.ss_workflow_definition.value;

    elements.ss_workflow_run.replaceChildren();
    if (state.workflowRuns.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无运行';
        elements.ss_workflow_run.append(option);
    } else {
        for (const run of state.workflowRuns) {
            const option = document.createElement('option');
            option.value = run.id;
            const stamp = formatDate(run.updatedAt || run.createdAt);
            option.textContent = `${WORKFLOW_RUN_STATUS_LABELS[run.status] || run.status || '未知'} · r${run.revision}${stamp ? ` · ${stamp}` : ''}`;
            elements.ss_workflow_run.append(option);
        }
    }
    elements.ss_workflow_run.value = state.workflowRuns.some(item => item.id === state.workflowRunId)
        ? state.workflowRunId
        : '';
}

function renderWorkflowTrack() {
    const definition = activeWorkflowDefinition();
    const runSteps = new Map((state.workflowRun?.steps || []).map(step => [step.id, step]));
    elements.ss_workflow_track.replaceChildren();
    elements.ss_workflow_track.style.setProperty('--ss-workflow-step-count', String(definition?.steps?.length || 1));
    if (!definition?.steps?.length) {
        const empty = document.createElement('div');
        empty.className = 'ss-inline-empty';
        empty.textContent = '暂无流程步骤';
        elements.ss_workflow_track.append(empty);
        return;
    }
    definition.steps.forEach((step, index) => {
        const runtime = runSteps.get(step.id);
        const status = runtime?.status || 'pending';
        const item = document.createElement('div');
        item.className = `ss-workflow-step is-${status}`;
        item.classList.toggle('is-current', step.id === state.workflowRun?.currentStepId);
        item.setAttribute('role', 'listitem');
        item.dataset.workflowStepId = step.id;

        const ordinal = document.createElement('span');
        ordinal.className = 'ss-workflow-step-number';
        ordinal.textContent = String(index + 1).padStart(2, '0');
        const copy = document.createElement('span');
        copy.className = 'ss-workflow-step-copy';
        const title = document.createElement('strong');
        title.textContent = step.title;
        const meta = document.createElement('small');
        meta.textContent = `${WORKFLOW_STEP_STATUS_LABELS[status] || status} · ${WORKFLOW_ACTOR_LABELS[step.actor] || step.actor}`;
        copy.append(title, meta);
        item.append(ordinal, copy);
        elements.ss_workflow_track.append(item);
    });
}

function workflowActionArtifact(statuses) {
    const step = currentWorkflowStep();
    const artifact = state.workflowArtifacts.find(candidate => candidate.id === state.workflowArtifactId) || null;
    if (!step || !artifact || !statuses.includes(artifact.status)) return null;
    if (step.artifactKind && artifact.kind !== step.artifactKind) return null;
    const relatedStepIds = new Set([step?.id, ...(step?.dependsOn || [])].filter(Boolean));
    const runSteps = state.workflowRun?.steps || [];
    const relatedArtifactIds = new Set(runSteps
        .filter(runtime => relatedStepIds.has(runtime.id))
        .flatMap(runtime => runtime.artifactIds || []));
    return relatedArtifactIds.has(artifact.id) ? artifact : null;
}

function appendWorkflowTag(parent, value, tone = '') {
    const tag = document.createElement('span');
    tag.className = `ss-diagnostic-tag${tone ? ` is-${tone}` : ''}`;
    tag.textContent = value;
    parent.append(tag);
}

function renderWorkflowCurrent() {
    const run = state.workflowRun;
    const step = currentWorkflowStep();
    elements.ss_workflow_current_meta.replaceChildren();
    if (!run || !step) {
        elements.ss_workflow_current_status.textContent = '';
        const empty = document.createElement('span');
        empty.className = 'ss-muted-copy';
        empty.textContent = '暂无运行';
        elements.ss_workflow_current_meta.append(empty);
    } else {
        elements.ss_workflow_current_status.textContent = WORKFLOW_STEP_STATUS_LABELS[step.status] || step.status || '';
        appendWorkflowTag(elements.ss_workflow_current_meta, step.title || step.id);
        appendWorkflowTag(elements.ss_workflow_current_meta, WORKFLOW_ACTOR_LABELS[step.actor] || step.actor || '未知执行方');
        appendWorkflowTag(elements.ss_workflow_current_meta, `尝试 ${Number(step.attempt || 0)}`);
        appendWorkflowTag(elements.ss_workflow_current_meta, `运行 r${run.revision}`);
    }
    const blocked = state.workflowLoading || state.workflowBusy || state.workflowCancelling || !run || !step
        || ['completed', 'cancelled'].includes(run?.status);
    const approvalArtifact = workflowActionArtifact(['candidate']);
    const applyArtifact = workflowActionArtifact(['approved', 'candidate']);
    elements.ss_workflow_execute.disabled = blocked
        || step?.actor === 'user'
        || ['approve', 'human_gate', 'apply', 'adopt'].includes(step?.kind)
        || step?.status === 'failed';
    elements.ss_workflow_approve.disabled = blocked
        || !['approve', 'human_gate'].includes(step?.kind)
        || !approvalArtifact;
    elements.ss_workflow_apply.disabled = blocked
        || !['apply', 'adopt'].includes(step?.kind)
        || !applyArtifact;
    elements.ss_workflow_cancel.disabled = state.workflowLoading || state.workflowCancelling || !run || !step
        || (state.workflowBusy && !state.workflowCommandController)
        || ['completed', 'cancelled'].includes(run?.status);
}

function workflowEvidenceItems() {
    const diagnosisArtifacts = state.workflowArtifacts.filter(artifact => artifact.kind === 'diagnosis');
    const selected = state.workflowArtifacts.find(artifact => artifact.id === state.workflowArtifactId) || null;
    const items = [];
    const seen = new Set();
    const push = value => {
        const text = typeof value === 'string'
            ? value
            : value?.summary || value?.message || value?.label || value?.id || JSON.stringify(value);
        if (!text || seen.has(text)) return;
        seen.add(text);
        items.push(text);
    };
    for (const artifact of diagnosisArtifacts) {
        for (const evidenceId of artifact.evidenceIds || []) push(evidenceId);
        const evidence = artifact.payload?.evidence || artifact.payload?.findings || artifact.payload?.diagnostics || [];
        for (const item of Array.isArray(evidence) ? evidence : [evidence]) push(item);
    }
    for (const evidenceId of selected?.evidenceIds || []) push(evidenceId);
    for (const issue of selected?.payload?.issues || []) {
        for (const evidenceId of issue.evidenceIds || []) push(evidenceId);
    }
    return items;
}

function renderWorkflowEvidence() {
    elements.ss_workflow_evidence.replaceChildren();
    const evidence = workflowEvidenceItems();
    if (evidence.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'ss-muted-copy';
        empty.textContent = '暂无诊断证据';
        elements.ss_workflow_evidence.append(empty);
        return;
    }
    for (const item of evidence) appendWorkflowTag(elements.ss_workflow_evidence, item);
}

function workflowSummaryText(parent, label, value) {
    if (value === undefined || value === null || value === '') return;
    const row = document.createElement('div');
    row.className = 'ss-workflow-summary-row';
    const term = document.createElement('strong');
    term.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = String(value);
    row.append(term, detail);
    parent.append(row);
}

function renderWorkflowDirectionSummary(parent, artifact) {
    const setDigest = artifact.payload?.setDigest;
    const siblings = state.workflowArtifacts
        .filter(candidate => candidate.kind === 'brainstorm-direction' && candidate.payload?.setDigest === setDigest)
        .sort((left, right) => Number(left.payload?.directionIndex) - Number(right.payload?.directionIndex));
    const axis = document.createElement('p');
    axis.className = 'ss-workflow-summary-lead';
    axis.textContent = artifact.payload?.exclusivityAxis || '';
    parent.append(axis);
    const grid = document.createElement('div');
    grid.className = 'ss-workflow-direction-grid';
    for (const candidate of siblings) {
        const direction = candidate.payload?.direction || {};
        const article = document.createElement('article');
        article.className = 'ss-workflow-direction';
        article.classList.toggle('is-selected', candidate.id === artifact.id);
        const heading = document.createElement('header');
        const index = document.createElement('span');
        index.textContent = String(Number(candidate.payload?.directionIndex || 0) + 1).padStart(2, '0');
        const title = document.createElement('h3');
        title.textContent = direction.title || direction.id || '创作方向';
        heading.append(index, title);
        const choice = document.createElement('p');
        choice.className = 'ss-workflow-summary-lead';
        choice.textContent = direction.forkChoice || '';
        article.append(heading, choice);
        workflowSummaryText(article, '主角行动', direction.protagonistAction);
        workflowSummaryText(article, '直接结果', direction.directResult);
        workflowSummaryText(article, '延迟代价', direction.delayedCost);
        workflowSummaryText(article, '本章承诺', direction.chapterPromise);
        const seeds = document.createElement('ol');
        seeds.className = 'ss-workflow-seed-list';
        if (Array.isArray(direction.sourceEventChain) && direction.sourceEventChain.length > 0) {
            for (const event of direction.sourceEventChain) {
                const item = document.createElement('li');
                item.textContent = [
                    `事件：${event.event}`,
                    `选择：${event.characterChoice}`,
                    `结果：${event.directResult}`,
                    `代价：${event.cost}`,
                ].join('；');
                seeds.append(item);
            }
        } else {
            for (const seed of direction.eventSeeds || []) {
                const item = document.createElement('li');
                item.textContent = seed;
                seeds.append(item);
            }
        }
        article.append(seeds);
        grid.append(article);
    }
    parent.append(grid);
}

function renderWorkflowPlanSummary(parent, payload) {
    const chain = document.createElement('ol');
    chain.className = 'ss-workflow-event-chain';
    for (const beat of payload.eventChain || []) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = beat.trigger;
        item.append(title);
        for (const [label, value] of [
            ['选择', beat.choice], ['行动', beat.action], ['结果', beat.result], ['代价', beat.cost],
            ['价值转折', beat.valueShift], ['释放信息', beat.information],
        ]) workflowSummaryText(item, label, value);
        chain.append(item);
    }
    parent.append(chain);
    const card = document.createElement('div');
    card.className = 'ss-workflow-card-summary';
    for (const [field, label] of [
        ['summary', '章节摘要'], ['goal', '目标'], ['conflict', '冲突'], ['turn', '转折'], ['hook', '章尾钩子'],
        ['pov', 'POV'], ['time', '时间'], ['location', '地点'], ['required', '必须兑现'], ['avoid', '禁写项'],
    ]) workflowSummaryText(card, label, payload.chapterCard?.[field]);
    parent.append(card);
}

function renderWorkflowReviewSummary(parent, payload) {
    const verdict = document.createElement('p');
    verdict.className = `ss-workflow-review-verdict is-${payload.rewriteRequired ? 'rewrite' : 'pass'}`;
    verdict.textContent = `${payload.rewriteRequired ? '需要定向修复' : '审查通过'} · ${payload.summary || ''}`;
    parent.append(verdict);
    const list = document.createElement('div');
    list.className = 'ss-workflow-issue-list';
    for (const issue of payload.issues || []) {
        const article = document.createElement('article');
        article.className = `ss-workflow-issue is-${issue.severity}`;
        const header = document.createElement('header');
        const title = document.createElement('strong');
        title.textContent = `${issue.severity} · ${issue.category}`;
        const location = document.createElement('span');
        location.textContent = `第 ${Number(issue.paragraphIndex || 0) + 1} 段 · ${issue.start}-${issue.end}`;
        header.append(title, location);
        const quote = document.createElement('blockquote');
        quote.textContent = issue.quote;
        article.append(header, quote);
        workflowSummaryText(article, '原因', issue.reason);
        workflowSummaryText(article, '建议', issue.suggestion);
        const evidence = document.createElement('div');
        evidence.className = 'ss-workflow-evidence';
        for (const evidenceId of issue.evidenceIds || []) appendWorkflowTag(evidence, evidenceId);
        article.append(evidence);
        list.append(article);
    }
    if (list.childElementCount > 0) parent.append(list);
    if (payload.rewriteTarget) {
        const target = document.createElement('div');
        target.className = 'ss-workflow-rewrite-target';
        workflowSummaryText(target, '修复范围', `${payload.rewriteTarget.start}-${payload.rewriteTarget.end}`);
        workflowSummaryText(target, '原文', payload.rewriteTarget.quote);
        workflowSummaryText(target, '指令', payload.rewriteTarget.instruction);
        parent.append(target);
    }
}

function renderWorkflowRewriteSummary(parent, payload) {
    const comparison = document.createElement('div');
    comparison.className = 'ss-workflow-diff-comparison';
    for (const [label, value, tone] of [
        ['修复前', payload.diff?.before, 'before'], ['修复后', payload.diff?.after, 'after'],
    ]) {
        const side = document.createElement('div');
        side.className = `is-${tone}`;
        const heading = document.createElement('small');
        heading.textContent = label;
        const text = document.createElement('pre');
        text.textContent = value || '';
        side.append(heading, text);
        comparison.append(side);
    }
    parent.append(comparison);
    workflowSummaryText(parent, '替换范围', `${payload.diff?.start ?? 0}-${payload.diff?.end ?? 0}`);
    workflowSummaryText(parent, '对应问题', (payload.diff?.issueIds || []).join('、'));
}

function renderWorkflowAdoptionSummary(parent, payload) {
    workflowSummaryText(parent, '章节摘要', payload.chapterSummary);
    workflowSummaryText(parent, '正文指纹', payload.manuscriptDigest);
    workflowSummaryText(parent, '计划指纹', payload.planDigest);
    workflowSummaryText(parent, '审查指纹', payload.reviewDigest);
    const counts = document.createElement('div');
    counts.className = 'ss-workflow-evidence';
    for (const [category, operation] of Object.entries(payload.storyStateChanges || {})) {
        const total = (operation?.upsert?.length || 0) + (operation?.delete?.length || 0);
        if (total > 0) appendWorkflowTag(counts, `${CHANGESET_LABELS[category] || category} ${total}`);
    }
    if (counts.childElementCount === 0) appendWorkflowTag(counts, 'Story State 无变更');
    parent.append(counts);
}

function renderWorkflowArtifactSummary(artifact) {
    elements.ss_workflow_artifact_summary.replaceChildren();
    if (!artifact) return;
    const payload = artifact.payload || {};
    if (artifact.kind === 'brainstorm-direction') renderWorkflowDirectionSummary(elements.ss_workflow_artifact_summary, artifact);
    else if (artifact.kind === 'chapter-plan') renderWorkflowPlanSummary(elements.ss_workflow_artifact_summary, payload);
    else if (artifact.kind === 'chapter-review') renderWorkflowReviewSummary(elements.ss_workflow_artifact_summary, payload);
    else if (artifact.kind === 'rewrite-diff') renderWorkflowRewriteSummary(elements.ss_workflow_artifact_summary, payload);
    else if (artifact.kind === 'chapter-adoption') renderWorkflowAdoptionSummary(elements.ss_workflow_artifact_summary, payload);
}

function renderWorkflowArtifacts() {
    elements.ss_workflow_artifact_select.replaceChildren();
    if (state.workflowArtifacts.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无候选';
        elements.ss_workflow_artifact_select.append(option);
        elements.ss_workflow_artifact_summary.replaceChildren();
        elements.ss_workflow_artifact_json.textContent = '';
        return;
    }
    for (const artifact of [...state.workflowArtifacts].reverse()) {
        const option = document.createElement('option');
        option.value = artifact.id;
        const label = WORKFLOW_ARTIFACT_LABELS[artifact.kind] || artifact.kind || 'Artifact';
        option.textContent = `${label} · ${artifact.status || '未知'} · r${artifact.revision || 0}`;
        elements.ss_workflow_artifact_select.append(option);
    }
    const selectedId = state.workflowArtifacts.some(artifact => artifact.id === state.workflowArtifactId)
        ? state.workflowArtifactId
        : state.workflowArtifacts.at(-1)?.id || '';
    state.workflowArtifactId = selectedId;
    elements.ss_workflow_artifact_select.value = selectedId;
    const selected = state.workflowArtifacts.find(artifact => artifact.id === selectedId);
    renderWorkflowArtifactSummary(selected);
    elements.ss_workflow_artifact_json.textContent = selected ? JSON.stringify(selected, null, 2) : '';
}

function renderWorkflowAuthority() {
    const authority = state.workflowAuthority || {};
    const shortDigest = value => typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value || '—';
    const values = [
        ['作品版本', authority.projectVersion ?? authority.project?.version ?? state.project?.version ?? '—'],
        ['章节修订', authority.chapterRevision ?? authority.chapter?.revision ?? state.chapter?.revision ?? '—'],
        ['Story State', shortDigest(authority.storyStateDigest)],
        ['章卡指纹', shortDigest(authority.cardDigest)],
        ['正文指纹', shortDigest(authority.contentDigest)],
        ['审校指纹', shortDigest(authority.reviewDigest)],
    ];
    elements.ss_workflow_authority.replaceChildren();
    for (const [label, value] of values) {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = String(value);
        elements.ss_workflow_authority.append(term, detail);
    }
}

function renderWorkflowError() {
    const stepError = currentWorkflowStep()?.status === 'failed' ? currentWorkflowStep()?.error : '';
    const message = state.workflowError || stepError || '';
    elements.ss_workflow_error.hidden = !message;
    elements.ss_workflow_error_message.textContent = message;
    elements.ss_workflow_retry.disabled = state.workflowLoading || !message
        || (state.workflowBusy && state.workflowRetry?.kind !== 'cancel');
}

function renderWorkflowWorkspace() {
    const bound = workflowBindingMatches(state.project?.id || '', state.chapter?.id || '');
    const available = Boolean(state.project && state.chapter && bound);
    renderWorkflowSelects();
    renderWorkflowTrack();
    renderWorkflowCurrent();
    renderWorkflowEvidence();
    renderWorkflowArtifacts();
    renderWorkflowAuthority();
    renderWorkflowError();
    const runStatus = state.workflowRun
        ? `${WORKFLOW_RUN_STATUS_LABELS[state.workflowRun.status] || state.workflowRun.status} · r${state.workflowRun.revision}`
        : '暂无运行';
    elements.ss_workflow_status.textContent = state.workflowLoading
        ? '正在载入'
        : state.workflowCancelling ? '正在取消'
            : state.workflowBusy ? '正在提交' : state.workflowError ? '需要处理' : runStatus;
    elements.ss_workflow_definition.disabled = state.workflowLoading || state.workflowBusy || !available;
    elements.ss_workflow_run.disabled = state.workflowLoading || state.workflowBusy || !available || state.workflowRuns.length === 0;
    elements.ss_workflow_new_run.disabled = state.workflowLoading || state.workflowBusy || !available || !state.workflowDefinitionId;
    elements.ss_workflow_refresh.disabled = state.workflowLoading || state.workflowBusy || !available;
    elements.ss_workflow_artifact_select.disabled = state.workflowBusy || state.workflowArtifacts.length === 0;
}

async function loadWorkflowRun(runId, { preserveError = false } = {}) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    if (!projectId || !chapterId || !runId || !workflowBindingMatches(projectId, chapterId)) return;
    const requestSerial = ++state.workflowRequestSerial;
    const previousError = state.workflowError;
    if (runId !== state.workflowRunId) {
        state.workflowRunId = runId;
        state.workflowRun = null;
        state.workflowArtifacts = [];
        state.workflowAuthority = null;
        state.workflowArtifactId = '';
    }
    state.workflowLoading = true;
    if (!preserveError) state.workflowError = '';
    renderWorkflowWorkspace();
    try {
        const payload = await apiRequest(workflowRunsPath(projectId, chapterId, runId));
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        applyWorkflowPayload(payload, { replaceArtifacts: true });
        if (workflowAuthorityRequiresRefresh()) {
            await refreshWorkflowAuthority(projectId, chapterId, requestSerial);
        }
        if (preserveError) state.workflowError = previousError;
    } catch (error) {
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.workflowError = error.message || '无法载入流程运行';
        state.workflowRetry = { kind: 'refresh' };
    } finally {
        if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.workflowLoading = false;
            renderWorkflowWorkspace();
        }
    }
}

async function loadWorkflowWorkspace({ preferredRunId = state.workflowRunId } = {}) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    bindWorkflowWorkspace(state.project, state.chapter);
    if (!projectId || !chapterId || !workflowBindingMatches(projectId, chapterId)) {
        renderWorkflowWorkspace();
        return;
    }
    const requestSerial = ++state.workflowRequestSerial;
    state.workflowLoading = true;
    state.workflowError = '';
    state.workflowRetry = null;
    renderWorkflowWorkspace();
    try {
        const [definitionsPayload, runsPayload] = await Promise.all([
            apiRequest(`${API_ROOT}/workflows/definitions`),
            apiRequest(workflowRunsPath(projectId, chapterId)),
        ]);
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.workflowDefinitions = workflowDefinitionList(definitionsPayload);
        state.workflowRuns = workflowRunList(runsPayload);
        if (!state.workflowDefinitions.some(item => item.id === state.workflowDefinitionId)) {
            state.workflowDefinitionId = preferredWorkflowDefinitionId(state.workflowDefinitions);
        }
        const selectedRun = state.workflowRuns.find(run => run.id === preferredRunId)
            || state.workflowRuns.find(run => ['running', 'waiting_approval', 'failed'].includes(run.status))
            || state.workflowRuns[0]
            || null;
        state.workflowRunId = selectedRun?.id || '';
        state.workflowRun = null;
        state.workflowArtifacts = [];
        state.workflowAuthority = null;
    } catch (error) {
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        state.workflowError = error.message || '无法载入章节流程';
        state.workflowRetry = { kind: 'refresh' };
    } finally {
        if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.workflowLoading = false;
            renderWorkflowWorkspace();
        }
    }
    if (workflowRequestIsCurrent(projectId, chapterId, requestSerial) && state.workflowRunId) {
        await loadWorkflowRun(state.workflowRunId);
    }
}

async function createWorkflowRun(retryBody = null) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    const definitionId = state.workflowDefinitionId;
    if (state.workflowBusy || !projectId || !chapterId || !definitionId
        || !workflowBindingMatches(projectId, chapterId)) return;
    state.workflowBusy = true;
    const authorityMutationToken = beginAuthorityMutation('workflow');
    state.workflowError = '';
    state.workflowRetry = null;
    renderWorkflowWorkspace();
    let body = retryBody;
    let requestSerial = 0;
    try {
        if (!(await enqueueSave())) return;
        if (!workflowBindingMatches(projectId, chapterId)
            || state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.workflowDefinitionId !== definitionId) return;
        const definition = selectedWorkflowDefinition();
        body = retryBody || {
            commandId: workflowCommandId(),
            definitionId,
            definitionHash: definition?.definitionHash,
            projectVersion: state.project.version,
            chapterRevision: state.chapter.revision,
            input: {},
        };
        requestSerial = ++state.workflowRequestSerial;
        const payload = await apiMutation(workflowRunsPath(projectId, chapterId), {
            method: 'POST',
            body,
        });
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        applyWorkflowPayload(payload, { replaceArtifacts: true });
        showToast('流程运行已创建');
    } catch (error) {
        if ((requestSerial && !workflowRequestIsCurrent(projectId, chapterId, requestSerial))
            || !workflowBindingMatches(projectId, chapterId)) return;
        state.workflowError = error.message || '无法创建流程运行';
        state.workflowRetry = body ? { kind: 'create', body } : null;
    } finally {
        finishAuthorityMutation(authorityMutationToken);
        if (workflowBindingMatches(projectId, chapterId)) {
            state.workflowBusy = false;
            renderWorkflowWorkspace();
        }
    }
}

function workflowCommandId() {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `workflow.${random}`;
}

function workflowAuthorityRequiresRefresh(authority = state.workflowAuthority) {
    return Boolean(authority
        && (authority.projectVersion !== state.project?.version
            || authority.chapterRevision !== state.chapter?.revision));
}

async function refreshWorkflowAuthority(projectId, chapterId, requestSerial) {
    const { project, chapter } = await apiRequest(pathForProject(
        projectId,
        `/chapters/${encodeURIComponent(chapterId)}/authority`,
    ));
    if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return false;
    acceptServerProject(project);
    acceptServerChapter(chapter);
    const hasDirtyEdits = state.projectDirty || state.chapterDirty || state.volumeDirty
        || state.projectDirtyPaths.size > 0 || state.chapterDirtyPaths.size > 0
        || state.volumeDirtyFields.size > 0;
    const hasSavingEdits = state.saveInFlight
        || state.projectSavingPaths.size > 0 || state.chapterSavingPaths.size > 0
        || state.volumeSavingFields.size > 0;
    if (hasDirtyEdits) {
        scheduleAutosave();
    } else if (hasSavingEdits) {
        setSaveStatus('保存中', 'saving');
    } else {
        clearDirtyState();
    }
    renderProjectData();
    return true;
}

async function sendWorkflowCommand(type, payload = {}, retryDescriptor = null) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    const run = state.workflowRun;
    if (state.workflowBusy || !projectId || !chapterId || !run || !workflowBindingMatches(projectId, chapterId)) return;
    state.workflowBusy = true;
    const authorityMutationToken = beginAuthorityMutation('workflow');
    state.workflowError = '';
    state.workflowRetry = null;
    renderWorkflowWorkspace();
    let saved = false;
    try {
        saved = await enqueueSave();
    } finally {
        if (!saved) {
            state.workflowBusy = false;
            finishAuthorityMutation(authorityMutationToken);
            renderWorkflowWorkspace();
        }
    }
    if (!saved) return;
    const descriptor = retryDescriptor || {
        commandId: workflowCommandId(),
        runRevision: run.revision,
        type,
        payload,
    };
    const requestSerial = ++state.workflowRequestSerial;
    const commandController = new AbortController();
    state.workflowCommandController = commandController;
    renderWorkflowWorkspace();
    try {
        const response = await apiMutation(workflowRunsPath(projectId, chapterId, run.id, '/commands'), {
            method: 'POST',
            body: descriptor,
            signal: commandController.signal,
        });
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        applyWorkflowPayload(response);
        if (workflowAuthorityRequiresRefresh(response?.authority)) {
            await refreshWorkflowAuthority(projectId, chapterId, requestSerial);
        }
    } catch (error) {
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        const message = error.message || '流程命令执行失败';
        state.workflowError = message;
        if (error instanceof ApiError && error.status === 409) {
            const selectedRunId = state.workflowRunId;
            state.workflowRetry = null;
            state.workflowBusy = false;
            renderWorkflowWorkspace();
            try {
                await refreshWorkflowAuthority(projectId, chapterId, requestSerial);
            } catch (refreshError) {
                if (workflowBindingMatches(projectId, chapterId)) {
                    state.workflowError = `${message}；刷新权威状态失败：${refreshError.message || '未知错误'}`;
                    renderWorkflowWorkspace();
                }
                return;
            }
            await loadWorkflowRun(selectedRunId);
            if (workflowBindingMatches(projectId, chapterId) && state.workflowRunId === selectedRunId) {
                state.workflowError = message;
                renderWorkflowWorkspace();
            }
            return;
        }
        state.workflowRetry = { kind: 'command', descriptor };
    } finally {
        if (state.workflowCommandController === commandController) state.workflowCommandController = null;
        if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.workflowBusy = false;
        }
        finishAuthorityMutation(authorityMutationToken);
        if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) renderWorkflowWorkspace();
    }
}

async function cancelWorkflowRun(retryDescriptor = null) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    const run = state.workflowRun;
    if (!projectId || !chapterId || !run || !run.currentStepId || state.workflowCancelling
        || (state.workflowBusy && !state.workflowCommandController)
        || ['completed', 'cancelled'].includes(run.status)
        || !workflowBindingMatches(projectId, chapterId)) return;
    const descriptor = retryDescriptor || {
        commandId: workflowCommandId(),
        runRevision: run.revision,
        type: 'cancel',
        payload: {
            stepId: run.currentStepId,
            reason: 'user_cancelled',
        },
    };
    const requestSerial = ++state.workflowRequestSerial;
    const executingController = state.workflowCommandController;
    state.workflowCancelling = true;
    state.workflowError = '';
    state.workflowRetry = null;
    renderWorkflowWorkspace();
    try {
        const response = await apiMutation(workflowRunsPath(projectId, chapterId, run.id, '/commands'), {
            method: 'POST',
            body: descriptor,
        });
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        applyWorkflowPayload(response);
        executingController?.abort(new DOMException('Workflow run cancelled.', 'AbortError'));
        if (state.workflowCommandController === executingController) state.workflowCommandController = null;
        state.workflowBusy = false;
        showToast(response?.command?.replayed ? '取消回执已对账' : '流程运行已取消');
        try {
            if (workflowAuthorityRequiresRefresh(response?.authority)) {
                await refreshWorkflowAuthority(projectId, chapterId, requestSerial);
            }
        } catch (refreshError) {
            if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) {
                state.workflowError = `流程已取消；刷新权威状态失败：${refreshError.message || '未知错误'}`;
                state.workflowRetry = { kind: 'refresh' };
                renderWorkflowWorkspace();
            }
        }
    } catch (error) {
        if (!workflowRequestIsCurrent(projectId, chapterId, requestSerial)) return;
        const message = error.message || '无法取消流程运行';
        executingController?.abort(new DOMException('Workflow cancellation request failed.', 'AbortError'));
        if (state.workflowCommandController === executingController) state.workflowCommandController = null;
        state.workflowBusy = false;
        state.workflowCancelling = false;
        state.workflowError = message;
        state.workflowRetry = { kind: 'cancel', descriptor };
        renderWorkflowWorkspace();
        await loadWorkflowRun(run.id, { preserveError: true });
        if (workflowBindingMatches(projectId, chapterId) && state.workflowRunId === run.id) {
            const reconciliationError = state.workflowError && state.workflowError !== message
                ? state.workflowError
                : '';
            state.workflowError = reconciliationError
                ? `${message}；状态对账失败：${reconciliationError}`
                : message;
            state.workflowRetry = { kind: 'cancel', descriptor };
            renderWorkflowWorkspace();
        }
    } finally {
        if (workflowRequestIsCurrent(projectId, chapterId, requestSerial)) {
            state.workflowCancelling = false;
            renderWorkflowWorkspace();
        }
    }
}

function executeCurrentWorkflowStep() {
    const step = currentWorkflowStep();
    if (!step) return;
    void sendWorkflowCommand('execute', {});
}

function approveCurrentWorkflowArtifact() {
    const step = currentWorkflowStep();
    const artifact = workflowActionArtifact(['candidate']);
    if (!step || !artifact) return;
    void sendWorkflowCommand('execute', {
        artifactId: artifact.id,
        artifactHash: artifact.bindingHash || artifact.recordHash,
    });
}

function applyCurrentWorkflowArtifact() {
    const step = currentWorkflowStep();
    const artifact = workflowActionArtifact(['approved', 'candidate']);
    if (!step || !artifact) return;
    void sendWorkflowCommand('execute', {
        artifactId: artifact.id,
        artifactHash: artifact.bindingHash || artifact.recordHash,
    });
}

function retryWorkflowAction() {
    if (state.workflowRetry?.kind === 'cancel') {
        void cancelWorkflowRun(state.workflowRetry.descriptor);
        return;
    }
    if (state.workflowRetry?.kind === 'command') {
        const descriptor = state.workflowRetry.descriptor;
        void sendWorkflowCommand(descriptor.type, descriptor.payload, descriptor);
        return;
    }
    if (state.workflowRetry?.kind === 'create') {
        void createWorkflowRun(state.workflowRetry.body);
        return;
    }
    const step = currentWorkflowStep();
    if (step?.status === 'failed') {
        void sendWorkflowCommand('execute', {});
        return;
    }
    void loadWorkflowWorkspace();
}

function dashboardBindingMatches(projectId) {
    return state.dashboardProjectId === (projectId || '');
}

function refreshVisibleDashboard(projectId) {
    if (state.view !== 'today' || !dashboardBindingMatches(projectId)) return;
    void loadDashboardWorkspace();
}

function resetDashboardWorkspace(projectId = '') {
    state.dashboardRequestSerial += 1;
    state.dashboardNavigationSerial += 1;
    state.dashboardProjectId = projectId;
    state.dashboard = null;
    state.dashboardLoading = false;
    state.dashboardNavigationBusy = false;
    state.dashboardError = '';
}

function bindDashboardWorkspace(project = state.project) {
    const projectId = project?.id || '';
    if (dashboardBindingMatches(projectId)) return false;
    resetDashboardWorkspace(projectId);
    return true;
}

function invalidateDashboardWorkspace() {
    state.dashboardRequestSerial += 1;
    state.dashboard = null;
    state.dashboardLoading = false;
    state.dashboardError = '';
}

function dashboardRequestIsCurrent(projectId, requestSerial) {
    return state.project?.id === projectId
        && dashboardBindingMatches(projectId)
        && state.dashboardRequestSerial === requestSerial;
}

function dashboardNavigationIsCurrent(projectId, navigationSerial) {
    return state.project?.id === projectId
        && dashboardBindingMatches(projectId)
        && state.dashboardNavigationSerial === navigationSerial;
}

function dashboardArray(value) {
    return Array.isArray(value) ? value : [];
}

function dashboardNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function clearDashboardTarget(button) {
    for (const key of ['dashboardView', 'dashboardChapterId', 'dashboardVolumeId', 'dashboardPromiseId']) {
        delete button.dataset[key];
    }
}

function setDashboardTarget(button, source, overrideView = '') {
    clearDashboardTarget(button);
    const target = dashboardNavigationTarget(source, overrideView);
    if (!target) return null;
    button.dataset.dashboardView = target.view;
    if (target.chapterId) button.dataset.dashboardChapterId = target.chapterId;
    if (target.volumeId) button.dataset.dashboardVolumeId = target.volumeId;
    if (target.promiseId) button.dataset.dashboardPromiseId = target.promiseId;
    return target;
}

function dashboardActionLabel(action) {
    if (action?.kind === 'add-chapter') return '前往卷章目录';
    if (action?.view === 'bible') return '打开作品设定';
    if (action?.view === 'workflow') return '进入章节流程';
    if (action?.kind === 'review-plan') return '复核章纲';
    return action?.chapterId ? '打开对应章节' : '去处理';
}

function dashboardArrow() {
    const icon = document.createElement('img');
    icon.className = 'ss-icon';
    icon.src = '/icons/arrow-right.svg';
    icon.alt = '';
    return icon;
}

function dashboardTaskButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ss-dashboard-task';
    button.disabled = !setDashboardTarget(button, item);

    const priority = document.createElement('span');
    priority.className = 'ss-dashboard-priority';
    priority.dataset.priority = item.priority || 'normal';
    priority.textContent = {
        primary: '首要',
        urgent: '逾期',
        high: '重要',
    }[item.priority] || '待办';

    const copy = document.createElement('span');
    copy.className = 'ss-dashboard-task-copy';
    const title = document.createElement('strong');
    title.textContent = item.label || '未命名工作项';
    const detail = document.createElement('p');
    detail.textContent = item.detail || '打开对应工作区继续处理。';
    copy.append(title, detail);
    button.append(priority, copy, dashboardArrow());
    return button;
}

function dashboardCompactButton(source, titleText, detailText, metaText, {
    view = '',
    urgent = false,
} = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ss-dashboard-compact-row';
    button.disabled = !setDashboardTarget(button, source, view);

    const copy = document.createElement('span');
    copy.className = 'ss-dashboard-compact-copy';
    const title = document.createElement('strong');
    title.textContent = titleText;
    const detail = document.createElement('small');
    detail.textContent = detailText;
    copy.append(title, detail);

    const meta = document.createElement('span');
    meta.className = 'ss-dashboard-row-meta';
    if (urgent) meta.dataset.tone = 'urgent';
    meta.textContent = metaText;
    button.append(copy, meta, dashboardArrow());
    return button;
}

function renderDashboardNextAction(dashboard) {
    const action = dashboard.nextAction || {};
    elements.ss_dashboard_next_label.textContent = action.label || '今天从这里开始';
    elements.ss_dashboard_next_detail.textContent = action.detail || '当前权威状态没有提供下一步说明。';
    const openTarget = setDashboardTarget(elements.ss_dashboard_next_open, action);
    elements.ss_dashboard_next_open.disabled = !openTarget;
    elements.ss_dashboard_next_open.querySelector('span').textContent = dashboardActionLabel(action);

    const workflowTarget = action.chapterId
        ? setDashboardTarget(elements.ss_dashboard_next_workflow, action, 'workflow')
        : null;
    elements.ss_dashboard_next_workflow.hidden = !workflowTarget;
    elements.ss_dashboard_next_workflow.disabled = !workflowTarget;
}

function renderDashboardProgress(dashboard) {
    const progress = dashboard.progress || {};
    const totalWords = Math.max(0, dashboardNumber(progress.totalWords));
    const targetWords = Math.max(0, dashboardNumber(progress.targetWords));
    const percent = Math.max(0, Math.min(100, dashboardNumber(progress.percent)));
    const chapterCount = Math.max(0, dashboardNumber(progress.chapterCount));
    const chapterTargetWords = Math.max(0, dashboardNumber(progress.chapterTargetWords));
    elements.ss_dashboard_progress_percent.textContent = `${numberFormatter.format(percent)}%`;
    elements.ss_dashboard_total_words.textContent = numberFormatter.format(totalWords);
    elements.ss_dashboard_target_words.textContent = numberFormatter.format(targetWords);
    elements.ss_dashboard_progress.max = 100;
    elements.ss_dashboard_progress.value = percent;
    elements.ss_dashboard_progress.setAttribute('aria-valuenow', String(percent));
    elements.ss_dashboard_progress.setAttribute(
        'aria-valuetext',
        `${numberFormatter.format(totalWords)} / ${numberFormatter.format(targetWords)} 字，${percent}%`,
    );
    elements.ss_dashboard_chapter_summary.textContent = chapterTargetWords > 0
        ? `${numberFormatter.format(chapterCount)} 章 · 单章目标 ${numberFormatter.format(chapterTargetWords)} 字`
        : `${numberFormatter.format(chapterCount)} 章`;

    elements.ss_dashboard_chapter_statuses.replaceChildren();
    const counts = progress.chapterStatuses || {};
    for (const status of ['planned', 'drafting', 'revising', 'done']) {
        const metric = document.createElement('span');
        metric.className = 'ss-dashboard-status';
        const value = document.createElement('strong');
        value.textContent = numberFormatter.format(Math.max(0, dashboardNumber(counts[status])));
        const label = document.createElement('span');
        label.textContent = STATUS_LABELS[status] || status;
        metric.append(value, label);
        elements.ss_dashboard_chapter_statuses.append(metric);
    }
}

function renderDashboardWorkItems(dashboard) {
    const items = dashboardArray(dashboard.workItems);
    elements.ss_dashboard_work_list.replaceChildren(...items.map(dashboardTaskButton));
    elements.ss_dashboard_work_empty.hidden = items.length > 0;
}

function renderDashboardPromiseDebts(dashboard) {
    const debts = dashboard.debts || {};
    const promises = dashboardArray(debts.openPromises);
    const overdueCount = promises.filter(item => item.overdue).length;
    const urgentCount = Math.max(0, dashboardNumber(debts.urgentPromiseCount));
    const totalCount = Math.max(promises.length, dashboardNumber(debts.openPromiseCount));
    elements.ss_dashboard_promise_summary.textContent = overdueCount > 0
        ? `${totalCount} 项 · ${overdueCount} 项逾期`
        : urgentCount > 0 ? `${totalCount} 项 · ${urgentCount} 项优先` : `${totalCount} 项`;
    elements.ss_dashboard_promise_list.replaceChildren(...promises.slice(0, 5).map(promise => {
        const due = promise.dueChapterNumber === null || promise.dueChapterNumber === undefined
            ? '未定兑现章'
            : `第 ${promise.dueChapterNumber} 章兑现`;
        return dashboardCompactButton(
            {
                ...promise,
                promiseId: promise.id,
                view: 'ledger',
                chapterId: promise.dueChapterId || '',
            },
            promise.title || '未命名伏笔',
            promise.summary || due,
            promise.overdue ? '已逾期' : `紧急 ${Math.max(0, dashboardNumber(promise.urgency))}/5`,
            { urgent: Boolean(promise.overdue) },
        );
    }));
    elements.ss_dashboard_promise_empty.hidden = promises.length > 0;
}

function renderDashboardStalePlans(dashboard) {
    const debts = dashboard.debts || {};
    const plans = dashboardArray(debts.stalePlans);
    const totalCount = Math.max(plans.length, dashboardNumber(debts.stalePlanCount));
    elements.ss_dashboard_stale_summary.textContent = `${totalCount} 章`;
    elements.ss_dashboard_stale_list.replaceChildren(...plans.slice(0, 5).map(chapter => {
        const revision = chapter.currentVolumeRevision === null || chapter.currentVolumeRevision === undefined
            ? '卷已缺失'
            : `卷纲 ${chapter.planRevision || 0} → ${chapter.currentVolumeRevision}`;
        return dashboardCompactButton(
            { ...chapter, chapterId: chapter.id, view: 'editor' },
            `第${chapter.number}章 ${chapter.title || '未命名章节'}`,
            revision,
            '待复核',
            { urgent: true },
        );
    }));
    elements.ss_dashboard_stale_empty.hidden = plans.length > 0;
}

function renderDashboardStoryState(dashboard) {
    const storyState = dashboard.storyState || {};
    const debts = dashboard.debts || {};
    const metrics = [
        ['人物与实体', storyState.activeEntityCount],
        ['关系', storyState.relationCount],
        ['事件', storyState.eventCount],
        ['事实', storyState.factCount],
        ['记忆', storyState.memoryCount],
        ['连续性', debts.activeContinuityCount],
    ];
    elements.ss_dashboard_story_state_summary.replaceChildren(...metrics.map(([labelText, valueText]) => {
        const metric = document.createElement('span');
        metric.className = 'ss-dashboard-state-metric';
        const value = document.createElement('strong');
        value.textContent = numberFormatter.format(Math.max(0, dashboardNumber(valueText)));
        const label = document.createElement('span');
        label.textContent = labelText;
        metric.append(value, label);
        return metric;
    }));
}

function renderDashboardRecentChapters(dashboard) {
    const chapters = dashboardArray(dashboard.recentChapters);
    elements.ss_dashboard_recent_list.replaceChildren(...chapters.map(chapter => dashboardCompactButton(
        { ...chapter, chapterId: chapter.id, view: 'editor' },
        `第${chapter.number}章 ${chapter.title || '未命名章节'}`,
        `${STATUS_LABELS[chapter.status] || chapter.status || '未知状态'} · ${numberFormatter.format(
            Math.max(0, dashboardNumber(chapter.wordCount)),
        )} 字`,
        formatDate(chapter.updatedAt) || '暂无时间',
    )));
    elements.ss_dashboard_recent_empty.hidden = chapters.length > 0;
}

function renderDashboardWorkspace() {
    const mode = dashboardViewMode({
        projectId: state.dashboardProjectId,
        dashboard: state.dashboard,
        loading: state.dashboardLoading,
        error: state.dashboardError,
    });
    elements.ss_dashboard_no_project.hidden = mode !== 'no-project';
    elements.ss_dashboard_loading.hidden = mode !== 'loading';
    elements.ss_dashboard_empty.hidden = mode !== 'empty';
    elements.ss_dashboard_error.hidden = mode !== 'error';
    elements.ss_dashboard_workspace.hidden = mode !== 'ready';
    elements.ss_dashboard_workspace.toggleAttribute(
        'aria-busy',
        state.dashboardLoading || state.dashboardNavigationBusy,
    );
    elements.ss_dashboard_workspace.inert = state.dashboardNavigationBusy;
    elements.ss_dashboard_refresh.disabled = state.dashboardLoading || state.dashboardNavigationBusy || !state.project;
    elements.ss_dashboard_retry.disabled = state.dashboardLoading || state.dashboardNavigationBusy || !state.project;
    elements.ss_dashboard_error_message.textContent = state.dashboardError;
    elements.ss_dashboard_status.textContent = state.dashboardNavigationBusy ? '正在打开'
        : {
        'no-project': '',
        loading: '计算中',
        empty: '待刷新',
        error: '载入失败',
        ready: state.dashboard?.project?.updatedAt
            ? `权威状态 ${formatDate(state.dashboard.project.updatedAt)}`
            : '权威状态已载入',
        }[mode];
    elements.ss_dashboard_status.dataset.state = mode === 'error'
        ? 'error' : mode === 'ready' ? 'saved' : mode === 'loading' ? 'dirty' : '';
    if (mode !== 'ready') return;

    renderDashboardNextAction(state.dashboard);
    renderDashboardProgress(state.dashboard);
    renderDashboardWorkItems(state.dashboard);
    renderDashboardPromiseDebts(state.dashboard);
    renderDashboardStalePlans(state.dashboard);
    renderDashboardStoryState(state.dashboard);
    renderDashboardRecentChapters(state.dashboard);
}

async function loadDashboardWorkspace() {
    bindDashboardWorkspace(state.project);
    const projectId = state.project?.id || '';
    if (!projectId) {
        renderDashboardWorkspace();
        return;
    }
    const requestSerial = ++state.dashboardRequestSerial;
    state.dashboardLoading = true;
    state.dashboardError = '';
    state.dashboard = null;
    renderDashboardWorkspace();
    try {
        const payload = await apiRequest(dashboardPath(projectId));
        if (!dashboardRequestIsCurrent(projectId, requestSerial)) return;
        if (!payload || payload.dashboardVersion !== 1) {
            throw new Error('服务端返回了未知的今日工作台版本');
        }
        state.dashboard = payload;
    } catch (error) {
        if (dashboardRequestIsCurrent(projectId, requestSerial)) {
            state.dashboardError = error.message || '今日工作台载入失败';
        }
    } finally {
        if (dashboardRequestIsCurrent(projectId, requestSerial)) {
            state.dashboardLoading = false;
            renderDashboardWorkspace();
        }
    }
}

async function navigateDashboardTarget(source, overrideView = '') {
    const target = dashboardNavigationTarget(source, overrideView);
    const projectId = state.project?.id || '';
    if (!target || !projectId || state.dashboardNavigationBusy) return;
    const navigationSerial = ++state.dashboardNavigationSerial;
    state.dashboardNavigationBusy = true;
    renderDashboardWorkspace();
    try {
        if (target.chapterId) {
            const exists = state.project.chapters?.some(chapter => chapter.id === target.chapterId);
            if (!exists) {
                showToast('工作项引用的章节已不存在，请刷新今日工作台', 5000);
                return;
            }
            if (target.chapterId !== state.chapter?.id) {
                if (!(await preparePendingChangeSetNavigation('打开今日工作项'))
                    || !dashboardNavigationIsCurrent(projectId, navigationSerial)) return;
                await loadChapter(target.chapterId, { pendingPrepared: true });
                if (!dashboardNavigationIsCurrent(projectId, navigationSerial)
                    || state.chapter?.id !== target.chapterId) return;
            }
        }
        if (!dashboardNavigationIsCurrent(projectId, navigationSerial)) return;
        if (target.volumeId) {
            if (!state.project.volumes?.some(volume => volume.id === target.volumeId)) {
                showToast('工作项引用的卷已不存在，请刷新今日工作台', 5000);
                return;
            }
            if (target.volumeId !== state.selectedVolumeId) {
                if (!(await enqueueSave()) || !dashboardNavigationIsCurrent(projectId, navigationSerial)) return;
                if (!bindSelectedVolume(target.volumeId, { render: target.view === 'bible' })) return;
            } else if (target.view === 'bible') {
                renderBible();
            }
        } else if (target.view === 'bible') {
            renderBible();
        }
        state.continuityRecordId = target.view === 'ledger' ? target.promiseId : '';
        if (target.view === 'ledger' && target.promiseId) state.continuityView = 'promises';
        if (target.view === 'ledger') renderStoryState();
        setView(target.view);
        if (target.view === 'ledger' && target.promiseId) focusContinuityRecord(target.promiseId);
    } finally {
        if (state.dashboardNavigationSerial === navigationSerial) {
            state.dashboardNavigationBusy = false;
            renderDashboardWorkspace();
        }
    }
}

function renderViewState() {
    const views = {
        today: elements.ss_today_view,
        write: elements.ss_write_view,
        bible: elements.ss_bible_view,
        ledger: elements.ss_ledger_view,
        copilot: elements.ss_copilot_view,
        workflow: elements.ss_workflow_view,
        quality: elements.ss_quality_view,
        resources: elements.ss_resources_view,
    };
    for (const [name, view] of Object.entries(views)) {
        view.hidden = name !== state.view;
    }
    for (const button of elements.viewTabs) {
        const active = button.dataset.ssView === state.view;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        button.disabled = authorityMutationLocked();
    }
    elements.ss_shell.classList.toggle('is-dashboard-view', state.view === 'today');
    elements.ss_shell.classList.toggle('is-resource-view', state.view === 'resources');
    elements.ss_shell.classList.toggle('is-copilot-view', state.view === 'copilot');
    elements.ss_shell.classList.toggle('is-workflow-view', state.view === 'workflow');
    elements.ss_shell.classList.toggle('is-quality-view', state.view === 'quality');
    elements.ss_toggle_binder.disabled = authorityMutationLocked()
        || ['today', 'resources', 'copilot', 'quality'].includes(state.view);
    elements.ss_toggle_inspector.disabled = authorityMutationLocked()
        || ['today', 'resources', 'copilot', 'workflow', 'quality'].includes(state.view);
    elements.ss_toggle_inspector.hidden = ['today', 'copilot', 'workflow', 'quality'].includes(state.view);
    if (state.project) persistWorkspaceResumeState();
}

function renderInspectorState() {
    elements.ss_card_panel.hidden = state.inspector !== 'card';
    elements.ss_assistant_panel.hidden = state.inspector !== 'assistant';
    elements.ss_versions_panel.hidden = state.inspector !== 'versions';
    for (const button of elements.inspectorTabs) {
        const active = button.dataset.ssInspector === state.inspector;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    }
    for (const button of elements.aiTabs) {
        const active = button.dataset.ssAi === state.aiKind;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    }
}

function renderSaveMetadata() {
    renderProjectSelect();
    renderMetrics();
    renderChapterList();
    renderCard();
    if (state.chapter) {
        elements.ss_chapter_updated.textContent = state.chapter.updatedAt ? `更新于 ${formatDate(state.chapter.updatedAt)}` : '';
    }
}

function renderProjectData() {
    renderProjectSelect();
    renderEmptyState();
    renderMetrics();
    renderChapterList();
    renderEditor();
    renderBible();
    renderLedger();
    renderStoryState();
    renderResources();
    renderCard();
    renderCandidate();
    renderVersionHistory();
    renderDashboardWorkspace();
    renderCopilotWorkspace();
    renderWorkflowWorkspace();
    renderQualityWorkspace();
    renderViewState();
    renderInspectorState();
    syncResponsivePanels();
}

function invalidateVersionCache({ preserveSelection = false } = {}) {
    state.versionRequestSerial += 1;
    state.versions = [];
    clearVersionCacheIdentity();
    if (!preserveSelection) state.selectedVersionId = '';
    state.selectedVersion = null;
    state.versionsLoading = false;
    state.versionDetailLoading = false;
    state.versionsError = '';
}

function resetVersionWorkspace() {
    invalidateVersionCache();
    state.versionRestoring = false;
}

async function loadVersionSelection(versionId, {
    projectId = state.project?.id,
    chapterId = state.chapter?.id,
    chapterRevision = state.chapter?.revision,
    navigationEpoch = state.navigationEpoch,
    requestSerial = ++state.versionRequestSerial,
    focusVersionId = '',
} = {}) {
    if (!projectId || !chapterId || !versionId) return null;
    state.selectedVersionId = versionId;
    state.selectedVersion = null;
    state.versionDetailLoading = true;
    state.versionsError = '';
    renderVersionHistory({ focusVersionId });
    try {
        const snapshot = await apiRequest(versionPath(projectId, chapterId, versionId));
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.chapter?.revision !== chapterRevision
            || state.navigationEpoch !== navigationEpoch || state.versionRequestSerial !== requestSerial) {
            return null;
        }
        if (versionId === 'current' && snapshot.chapterRevision !== chapterRevision) {
            clearVersionCacheIdentity();
            throw new Error('章节已在其他窗口更新，请保存当前编辑或重新载入后再查看版本');
        }
        state.selectedVersion = snapshot;
        state.versionUnitCounts.set(versionId, countContentUnits(snapshot.content || ''));
        return snapshot;
    } catch (error) {
        if (state.project?.id === projectId && state.chapter?.id === chapterId
            && state.chapter?.revision === chapterRevision
            && state.versionRequestSerial === requestSerial) {
            state.versionsError = error.message || '无法载入版本快照';
        }
        return null;
    } finally {
        if (state.project?.id === projectId && state.chapter?.id === chapterId
            && state.chapter?.revision === chapterRevision
            && state.versionRequestSerial === requestSerial) {
            state.versionDetailLoading = false;
            renderVersionHistory({ focusVersionId });
        }
    }
}

async function refreshVersionHistory({ selectId = '', focusVersionId = focusedVersionId() } = {}) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    const chapterRevision = state.chapter?.revision;
    const navigationEpoch = state.navigationEpoch;
    if (!projectId || !chapterId) {
        resetVersionWorkspace();
        renderVersionHistory();
        return;
    }
    const requestSerial = ++state.versionRequestSerial;
    state.versionsLoading = true;
    state.versionDetailLoading = false;
    state.versionsError = '';
    renderVersionHistory({ focusVersionId });
    try {
        const payload = await apiRequest(versionPath(projectId, chapterId));
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.chapter?.revision !== chapterRevision
            || state.navigationEpoch !== navigationEpoch || state.versionRequestSerial !== requestSerial) {
            return;
        }
        const versions = Array.isArray(payload) ? payload : Array.isArray(payload?.versions) ? payload.versions : [];
        const currentVersion = versions.find(version => versionIdOf(version) === 'current');
        if (!currentVersion || currentVersion.chapterRevision !== chapterRevision) {
            throw new Error('章节已在其他窗口更新，请保存当前编辑或重新载入后再查看版本');
        }
        state.versions = versions;
        state.versionsChapterId = chapterId;
        state.versionsChapterRevision = chapterRevision;
        const preferredId = selectId || state.selectedVersionId;
        state.selectedVersionId = state.versions.some(version => versionIdOf(version) === preferredId)
            ? preferredId
            : versionIdOf(state.versions[0]);
        state.selectedVersion = null;
        state.versionsLoading = false;
        renderVersionHistory({ focusVersionId });
        if (state.selectedVersionId) {
            await loadVersionSelection(state.selectedVersionId, {
                projectId,
                chapterId,
                chapterRevision,
                navigationEpoch,
                requestSerial,
                focusVersionId,
            });
        }
    } catch (error) {
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.chapter?.revision !== chapterRevision
            || state.versionRequestSerial !== requestSerial) return;
        state.versions = [];
        state.selectedVersionId = '';
        state.selectedVersion = null;
        clearVersionCacheIdentity();
        state.versionsError = error.message || '无法载入章节版本';
    } finally {
        if (state.project?.id === projectId && state.chapter?.id === chapterId
            && state.chapter?.revision === chapterRevision
            && state.versionRequestSerial === requestSerial) {
            state.versionsLoading = false;
            renderVersionHistory({ focusVersionId });
        }
    }
}

function resetGenerationWorkspace({ clearInstruction = true } = {}) {
    if (state.generationController && !state.generationController.signal.aborted) {
        state.generationController.abort();
    }
    cancelContextPreviewRequest();
    state.generationRequestSerial += 1;
    state.generating = false;
    state.generationController = null;
    state.generations = [];
    state.selectedGenerationId = '';
    state.activeGeneration = null;
    state.generationDiagnostics = null;
    state.generationPreview = null;
    state.contextOverrides = emptyContextOverrides();
    state.retrievalOverrides = emptyRetrievalOverrides();
    state.selectionBaseline = null;
    state.distilling = false;
    state.adopting = false;
    if (clearInstruction && elements.ss_generation_instruction) {
        elements.ss_generation_instruction.value = '';
    }
}

async function loadGenerationSelection(generationId, {
    projectId = state.project?.id,
    chapterId = state.chapter?.id,
    navigationEpoch = state.navigationEpoch,
    requestSerial = state.generationRequestSerial,
} = {}) {
    if (!projectId || !chapterId || !generationId) return null;
    const generation = await apiRequest(generationPath(
        projectId,
        chapterId,
        `/${encodeURIComponent(generationId)}`,
    ));
    if (state.project?.id !== projectId || state.chapter?.id !== chapterId
        || state.navigationEpoch !== navigationEpoch || state.generationRequestSerial !== requestSerial) {
        return null;
    }
    state.selectedGenerationId = generation.id;
    state.activeGeneration = generation;
    state.generationDiagnostics = generation.request?.diagnostics || null;
    if (generation.kind && generation.kind !== 'distill') state.aiKind = generation.kind;
    renderCandidate();
    renderInspectorState();
    return generation;
}

async function refreshGenerationHistory({ selectId = '', loadSelected = true } = {}) {
    const projectId = state.project?.id;
    const chapterId = state.chapter?.id;
    const navigationEpoch = state.navigationEpoch;
    if (!projectId || !chapterId) return;
    const requestSerial = ++state.generationRequestSerial;
    try {
        const generations = await apiRequest(generationPath(projectId, chapterId));
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch || state.generationRequestSerial !== requestSerial) {
            return;
        }
        state.generations = Array.isArray(generations) ? generations : [];
        const preferredId = selectId || state.selectedGenerationId;
        state.selectedGenerationId = state.generations.some(item => item.id === preferredId)
            ? preferredId
            : state.generations[0]?.id || '';
        renderGenerationControls();
        if (loadSelected && state.selectedGenerationId) {
            await loadGenerationSelection(state.selectedGenerationId, {
                projectId,
                chapterId,
                navigationEpoch,
                requestSerial,
            });
        } else if (!state.selectedGenerationId) {
            state.activeGeneration = null;
            renderCandidate();
        }
    } catch (error) {
        if (state.project?.id === projectId && state.chapter?.id === chapterId) {
            showToast(error.message || '无法载入候选历史', 5000);
        }
    }
}

function setLoadedProject(project, chapter) {
    const projectChanged = state.project?.id !== project?.id;
    const dashboardBindingChanged = !dashboardBindingMatches(project?.id || '');
    const bindingChanged = !pendingChangeSetBindingMatches(project?.id || '', chapter?.id || '');
    const workflowBindingChanged = !workflowBindingMatches(project?.id || '', chapter?.id || '');
    const copilotBindingChanged = state.copilotProjectId !== (project?.id || '')
        || state.copilotChapterId !== (chapter?.id || '');
    const qualityBindingChanged = !qualityBindingMatches(project?.id || '', chapter?.id || '');
    if (bindingChanged && state.pendingChangeSetDirty) {
        throw new Error('切换作品或章节前必须先处理本地 ChangeSet 草稿');
    }
    const preservedVersionId = !projectChanged && state.chapter?.id === chapter?.id
        ? state.selectedVersionId
        : '';
    resetGenerationWorkspace();
    resetVersionWorkspace();
    if (projectChanged) resetProjectAuxiliaryState();
    if (projectChanged) state.collapsedVolumeIds.clear();
    state.project = project;
    state.chapter = chapter;
    if (dashboardBindingChanged) bindDashboardWorkspace(project);
    else invalidateDashboardWorkspace();
    if (bindingChanged) bindPendingChangeSetDraft(project, chapter);
    if (copilotBindingChanged) bindCopilotWorkspace(project, chapter);
    if (workflowBindingChanged) bindWorkflowWorkspace(project, chapter);
    if (qualityBindingChanged) bindQualityWorkspace(project, chapter);
    selectVolumeId(project, projectChanged ? chapter?.volumeId : state.selectedVolumeId);
    state.projectBase = clone(project);
    state.chapterBase = chapter ? clone(chapter) : null;
    state.volumeBase = selectedVolume(project) ? clone(selectedVolume(project)) : null;
    syncCopilotAuthorityState();
    state.candidateEditSerial += 1;
    restoredWorkspaceRecoverySource = null;
    clearDirtyState({ preserveRecoveryDraft: true });
    restoreWorkspaceRecoveryDraft(project, chapter);
    upsertProjectSummary(state.project);
    renderProjectData();
    persistWorkspaceResumeState();
    if (chapter) void refreshGenerationHistory();
    if (chapter && state.inspector === 'versions') void refreshVersionHistory({ selectId: preservedVersionId });
    if (state.view === 'today') void loadDashboardWorkspace();
    if (state.view === 'copilot') void loadCopilotWorkspace();
    if (chapter && state.view === 'workflow') void loadWorkflowWorkspace();
    if (state.view === 'quality') void loadQualityWorkspace();
}

async function loadProject(projectId, preferredChapterId = '', navigationEpoch = state.navigationEpoch) {
    const project = await apiRequest(pathForProject(projectId));
    if (!isCurrentNavigation(navigationEpoch)) return false;
    const summaries = [...(project.chapters || [])].sort((left, right) => left.number - right.number);
    const selected = summaries.find(chapter => chapter.id === preferredChapterId) || summaries[0];
    const chapter = selected
        ? await apiRequest(pathForProject(projectId, `/chapters/${encodeURIComponent(selected.id)}`))
        : null;
    if (!isCurrentNavigation(navigationEpoch)) return false;
    setLoadedProject(project, chapter);
    return true;
}

async function loadProjects(preferredProjectId = '', preferredChapterId = '') {
    const navigationEpoch = beginNavigation();
    setSaveStatus('载入中', 'saving');
    try {
        const projects = await apiRequest(`${API_ROOT}/projects`);
        if (!isCurrentNavigation(navigationEpoch)) return false;
        state.projects = Array.isArray(projects) ? projects : [];
        if (state.projects.length === 0) {
            resetGenerationWorkspace();
            resetVersionWorkspace();
            resetProjectAuxiliaryState();
            bindPendingChangeSetDraft(null, null);
            state.project = null;
            state.chapter = null;
            bindDashboardWorkspace(null);
            bindCopilotWorkspace(null, null);
            bindWorkflowWorkspace(null, null);
            bindQualityWorkspace(null, null);
            state.projectBase = null;
            state.chapterBase = null;
            state.volumeBase = null;
            state.selectedVolumeId = '';
            state.collapsedVolumeIds.clear();
            state.candidateEditSerial += 1;
            clearDirtyState();
            renderProjectData();
            return true;
        }
        const selected = state.projects.find(project => project.id === preferredProjectId)
            || state.projects.find(project => project.id === state.project?.id)
            || state.projects[0];
        return await loadProject(
            selected.id,
            preferredChapterId || state.chapter?.id || '',
            navigationEpoch,
        );
    } finally {
        finishNavigation(navigationEpoch);
    }
}

function showCreateForm(show) {
    elements.ss_create_project_form.hidden = !show;
    elements.ss_new_project.setAttribute('aria-expanded', String(show));
    if (show) {
        elements.ss_create_title.focus();
    } else {
        elements.ss_create_project_form.reset();
    }
}

async function createProject(event) {
    event.preventDefault();
    if (state.navigationBusy) return;
    if (!elements.ss_create_project_form.reportValidity()) return;
    if (!(await preparePendingChangeSetNavigation('新建作品'))) return;
    if (!confirmProjectReplacement('新建作品')) return;
    const navigationEpoch = beginNavigation();
    const submitButton = elements.ss_create_project_form.querySelector('[type="submit"]');
    let focusTarget = null;
    submitButton.disabled = true;
    try {
        if (!(await enqueueSave())) return;
        const result = await apiMutation(`${API_ROOT}/projects`, {
            method: 'POST',
            body: {
                title: elements.ss_create_title.value.trim() || '未命名作品',
                genre: elements.ss_create_genre.value.trim(),
            },
        });
        if (!isCurrentNavigation(navigationEpoch)) return;
        setLoadedProject(result.project, result.chapter);
        showCreateForm(false);
        showToast('作品已创建');
        focusTarget = elements.ss_chapter_title;
    } catch (error) {
        showToast(error.message || '无法创建作品', 5000);
    } finally {
        submitButton.disabled = false;
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function switchProject(projectId) {
    if (state.navigationBusy || !projectId || projectId === state.project?.id) return;
    const previousId = state.project?.id || '';
    if (!(await preparePendingChangeSetNavigation('切换作品'))) {
        elements.ss_project_select.value = previousId;
        return;
    }
    if (!confirmProjectReplacement('切换作品')) {
        elements.ss_project_select.value = previousId;
        return;
    }
    const navigationEpoch = beginNavigation();
    try {
        if (!(await enqueueSave())) {
            elements.ss_project_select.value = previousId;
            return;
        }
        setSaveStatus('载入中', 'saving');
        await loadProject(projectId, '', navigationEpoch);
        closeDrawers();
    } catch (error) {
        if (!isCurrentNavigation(navigationEpoch)) return;
        elements.ss_project_select.value = previousId;
        setSaveStatus('载入失败', 'error');
        showToast(error.message || '无法载入作品', 5000);
    } finally {
        finishNavigation(navigationEpoch);
    }
}

async function createChapter(volumeId = '') {
    if (state.navigationBusy || !state.project) return;
    if (!(await preparePendingChangeSetNavigation('新建章节'))) return;
    const requestedVolumeId = volumeId
        || (state.view === 'bible' ? state.selectedVolumeId : state.chapter?.volumeId)
        || state.selectedVolumeId
        || orderedVolumes().at(-1)?.id;
    const navigationEpoch = beginNavigation();
    elements.ss_add_chapter.disabled = true;
    let focusTarget = null;
    try {
        if (!(await enqueueSave())) return;
        let attempts = 0;
        while (attempts < 2) {
            try {
                const result = await apiMutation(pathForProject(state.project.id, '/chapters'), {
                    method: 'POST',
                    body: { projectVersion: state.project.version, chapter: { volumeId: requestedVolumeId } },
                });
                if (!isCurrentNavigation(navigationEpoch)) return;
                setLoadedProject(result.project, result.chapter);
                state.view = 'write';
                renderViewState();
                closeDrawers();
                focusTarget = elements.ss_chapter_title;
                showToast(`第${result.chapter.number}章已创建`);
                return;
            } catch (error) {
                if (!(error instanceof ApiError) || error.status !== 409 || attempts > 0) throw error;
                attempts += 1;
                const remoteProject = await apiRequest(pathForProject(state.project.id));
                if (!isCurrentNavigation(navigationEpoch)) return;
                acceptServerProject(remoteProject, false);
                renderSaveMetadata();
            }
        }
    } catch (error) {
        showToast(error.message || '无法创建章节', 5000);
    } finally {
        elements.ss_add_chapter.disabled = false;
        finishNavigation(navigationEpoch, focusTarget);
    }
}

function chapterActionFocus(chapterId, action = '') {
    return [...elements.ss_chapter_list.querySelectorAll('button')].find(button => (
        action
            ? button.dataset.chapterActionId === chapterId && button.dataset.chapterAction === action
            : button.dataset.chapterId === chapterId
    )) || null;
}

function volumeActionFocus(volumeId, action = '') {
    return [...elements.ss_chapter_list.querySelectorAll('button')].find(button => (
        action
            ? button.dataset.volumeActionId === volumeId && button.dataset.volumeAction === action
            : button.dataset.volumeToggle === volumeId
    )) || null;
}

async function mutateStructure(projectionFactory, {
    activeChapterId = state.chapter?.id || '',
    focus = null,
    fallbackFocus = null,
    message = '目录已更新',
} = {}) {
    if (state.navigationBusy || state.structureBusy || !state.project) return false;
    const navigationEpoch = beginNavigation();
    state.structureBusy = true;
    let focusTarget = fallbackFocus?.() || null;
    try {
        if (!(await enqueueSave())) return false;
        const projection = projectionFactory(state.project);
        if (!projection) return false;
        try {
            const result = await apiMutation(pathForProject(state.project.id, '/structure'), {
                method: 'POST',
                body: { projectVersion: state.project.version, volumes: projection },
            });
            if (!isCurrentNavigation(navigationEpoch)) return false;
            state.structureBusy = false;
            const chapters = Array.isArray(result.chapters) ? result.chapters : [];
            const activeChapter = chapters.find(chapter => chapter.id === activeChapterId) || chapters[0] || null;
            setLoadedProject(result.project, activeChapter);
            focusTarget = focus?.() || (activeChapter ? chapterActionFocus(activeChapter.id) : elements.ss_add_chapter);
            showToast(message);
            return true;
        } catch (error) {
            if (!(error instanceof ApiError) || error.code !== 'project_conflict') throw error;
            const remoteProject = await apiRequest(pathForProject(state.project.id));
            if (!isCurrentNavigation(navigationEpoch)) return false;
            const remoteActiveSummary = remoteProject.chapters?.find(chapter => chapter.id === activeChapterId);
            const remoteActiveChapter = remoteActiveSummary
                ? await apiRequest(chapterPath(remoteProject.id, remoteActiveSummary.id))
                : null;
            if (!isCurrentNavigation(navigationEpoch)) return false;
            setLoadedProject(remoteProject, remoteActiveChapter);
            focusTarget = fallbackFocus?.() || focusTarget;
            showToast('卷章目录已变化，本次操作未执行；请检查后重试', 5000);
            return false;
        }
    } catch (error) {
        showToast(error.message || '无法更新卷章目录', 5000);
        return false;
    } finally {
        state.structureBusy = false;
        renderEditor();
        renderBible();
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function reorderChapter(chapterId, direction) {
    if (!['up', 'down'].includes(direction)) return;
    await mutateStructure(
        project => moveChapterProjection(project, chapterId, direction),
        {
            fallbackFocus: () => chapterActionFocus(chapterId),
            focus: () => {
                const action = chapterActionFocus(chapterId, direction);
                return action?.disabled ? chapterActionFocus(chapterId) : action;
            },
            message: direction === 'up' ? '章节已在卷内上移' : '章节已在卷内下移',
        },
    );
}

async function reorderVolume(volumeId, direction, focusOrigin = 'binder') {
    if (!['up', 'down'].includes(direction)) return;
    const bibleFocus = () => {
        const button = direction === 'up' ? elements.ss_volume_move_up : elements.ss_volume_move_down;
        return button.disabled ? elements.ss_volume_outline_select : button;
    };
    await mutateStructure(
        project => moveVolumeProjection(project, volumeId, direction),
        {
            fallbackFocus: () => focusOrigin === 'bible' ? elements.ss_volume_outline_select : volumeActionFocus(volumeId),
            focus: () => {
                if (focusOrigin === 'bible') return bibleFocus();
                const action = volumeActionFocus(volumeId, direction);
                return action?.disabled ? volumeActionFocus(volumeId) : action;
            },
            message: direction === 'up' ? '卷已上移' : '卷已下移',
        },
    );
}

async function moveChapterToVolume(chapterId, volumeId) {
    const moved = await mutateStructure(
        project => moveChapterToVolumeProjection(project, chapterId, volumeId),
        {
            activeChapterId: chapterId,
            focus: () => elements.ss_chapter_volume,
            message: '章节已移入目标卷，原章纲已标记待复核',
        },
    );
    if (!moved) renderEditor();
}

function selectedVolumeTitleField() {
    return elements.volumeFields.find(input => input.dataset.volumeField === 'title') || null;
}

async function createVolume() {
    if (state.navigationBusy || state.structureBusy || !state.project) return;
    const navigationEpoch = beginNavigation();
    elements.ss_add_volume.disabled = true;
    let focusTarget = null;
    try {
        if (!(await enqueueSave())) return;
        let attempts = 0;
        while (attempts < 2) {
            try {
                const result = await apiMutation(volumePath(state.project.id), {
                    method: 'POST',
                    body: { projectVersion: state.project.version, volume: {} },
                });
                if (!isCurrentNavigation(navigationEpoch)) return;
                const currentChapter = state.chapter ? clone(state.chapter) : null;
                state.selectedVolumeId = result.volume.id;
                setLoadedProject(result.project, currentChapter);
                state.view = 'bible';
                renderViewState();
                closeDrawers();
                focusTarget = selectedVolumeTitleField();
                showToast(`${result.volume.title}已创建`);
                return;
            } catch (error) {
                if (!(error instanceof ApiError) || error.code !== 'project_conflict' || attempts > 0) throw error;
                attempts += 1;
                const remoteProject = await apiRequest(pathForProject(state.project.id));
                if (!isCurrentNavigation(navigationEpoch)) return;
                acceptServerProject(remoteProject, new Set());
                renderSaveMetadata();
            }
        }
    } catch (error) {
        showToast(error.message || '无法创建卷', 5000);
    } finally {
        elements.ss_add_volume.disabled = false;
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function editVolume(volumeId) {
    if (state.navigationBusy || !state.project || !volumeId) return;
    if (volumeId === state.selectedVolumeId && state.view === 'bible') {
        closeDrawers();
        selectedVolumeTitleField()?.focus();
        return;
    }
    const navigationEpoch = beginNavigation();
    let focusTarget = null;
    let switched = false;
    try {
        if (!(await enqueueSave())) return;
        if (!state.project.volumes?.some(volume => volume.id === volumeId)) return;
        if (!bindSelectedVolume(volumeId, { render: true })) return;
        state.view = 'bible';
        renderViewState();
        closeDrawers();
        focusTarget = selectedVolumeTitleField();
        switched = true;
    } finally {
        if (!switched) renderBible();
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function deleteVolume(volumeId, focusOrigin = 'binder') {
    if (state.navigationBusy || state.structureBusy || !state.project || !volumeId) return;
    const volume = state.project.volumes?.find(item => item.id === volumeId);
    if (!volume) return;
    const chapterCount = state.project.chapters?.filter(chapter => chapter.volumeId === volumeId).length || 0;
    if (chapterCount > 0) {
        showToast('只能删除空卷', 5000);
        return;
    }
    if (state.project.volumes.length === 1) {
        showToast('作品必须保留至少一卷', 5000);
        return;
    }
    if (!window.confirm(`删除空卷“${volume.title}”？此操作不可撤销。`)) return;

    const navigationEpoch = beginNavigation();
    let focusTarget = focusOrigin === 'bible' ? elements.ss_volume_outline_select : volumeActionFocus(volumeId, 'delete');
    try {
        if (!(await enqueueSave())) return;
        const current = state.project.volumes.find(item => item.id === volumeId);
        if (!current) return;
        const result = await apiMutation(volumePath(state.project.id, volumeId), {
            method: 'DELETE',
            body: { projectVersion: state.project.version, revision: current.revision },
        });
        if (!isCurrentNavigation(navigationEpoch)) return;
        const currentChapter = state.chapter ? clone(state.chapter) : null;
        const remaining = [...result.project.volumes].sort((left, right) => left.number - right.number);
        state.selectedVolumeId = remaining[Math.min(current.number - 1, remaining.length - 1)]?.id || remaining[0]?.id || '';
        setLoadedProject(result.project, currentChapter);
        focusTarget = focusOrigin === 'bible'
            ? elements.ss_volume_outline_select
            : volumeActionFocus(state.selectedVolumeId) || elements.ss_add_volume;
        showToast('空卷已删除');
    } catch (error) {
        if (error instanceof ApiError && error.code === 'volume_not_empty') {
            showToast('卷内已有章节，无法删除', 5000);
        } else if (error instanceof ApiError && ['project_conflict', 'volume_conflict'].includes(error.code)) {
            await loadProject(state.project.id, state.chapter?.id || '', navigationEpoch);
            showToast('卷目录已变化，本次未删除；请检查后重试', 5000);
        } else {
            showToast(error.message || '无法删除卷', 5000);
        }
    } finally {
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function deleteChapter(chapterId) {
    if (state.navigationBusy || !state.project || !chapterId) return;
    if (chapterId === state.chapter?.id && !(await preparePendingChangeSetNavigation('删除当前章节'))) return;
    const summary = state.project.chapters?.find(chapter => chapter.id === chapterId);
    const navigationEpoch = beginNavigation();
    let focusTarget = chapterActionFocus(chapterId, 'delete') || chapterActionFocus(chapterId);
    try {
        if (!(await enqueueSave())) return;
        const projectId = state.project.id;
        const preferredActiveId = state.chapter?.id || '';
        const targetChapter = await apiRequest(chapterPath(projectId, chapterId));
        if (!isCurrentNavigation(navigationEpoch)) return;
        const title = targetChapter.title || summary?.title || `第${targetChapter.number || summary?.number || '?'}章`;
        if (!window.confirm(`删除“${title}”（修订 r${targetChapter.revision}）？此操作不可撤销。`)) return;
        try {
            const result = await apiMutation(chapterPath(projectId, chapterId), {
                method: 'DELETE',
                body: {
                    projectVersion: state.project.version,
                    chapterRevision: targetChapter.revision,
                    activeChapterId: preferredActiveId,
                },
            });
            if (!isCurrentNavigation(navigationEpoch)) return;
            setLoadedProject(result.project, result.activeChapter || null);
            focusTarget = result.activeChapter
                ? chapterActionFocus(result.activeChapter.id) || elements.ss_chapter_search
                : elements.ss_add_chapter;
            showToast(`第${result.deleted?.number || summary?.number || ''}章已删除`);
            return;
        } catch (error) {
            if (error instanceof ApiError && error.code === 'last_chapter_required') {
                showToast(error.message || '作品必须保留至少一章', 5000);
                return;
            }
            if (error instanceof ApiError && ['project_conflict', 'chapter_conflict'].includes(error.code)) {
                await loadProject(projectId, preferredActiveId, navigationEpoch);
                showToast('目录或章节已变化，本次未删除；请检查最新内容后重新确认', 5000);
                return;
            }
            throw error;
        }
    } catch (error) {
        showToast(error.message || '无法删除章节', 5000);
    } finally {
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function loadChapter(chapterId, { pendingPrepared = false } = {}) {
    if (state.navigationBusy || !state.project || !chapterId || chapterId === state.chapter?.id) {
        closeDrawers();
        return;
    }
    if (!pendingPrepared && !(await preparePendingChangeSetNavigation('切换章节'))) return;
    const navigationEpoch = beginNavigation();
    let focusTarget = null;
    try {
        if (!(await enqueueSave())) return;
        setSaveStatus('载入中', 'saving');
        const chapter = await apiRequest(pathForProject(state.project.id, `/chapters/${encodeURIComponent(chapterId)}`));
        if (!isCurrentNavigation(navigationEpoch)) return;
        resetGenerationWorkspace();
        resetVersionWorkspace();
        state.chapter = chapter;
        invalidateDashboardWorkspace();
        bindPendingChangeSetDraft(state.project, chapter);
        bindCopilotWorkspace(state.project, chapter);
        bindWorkflowWorkspace(state.project, chapter);
        bindQualityWorkspace(state.project, chapter);
        state.chapterBase = clone(chapter);
        state.candidateEditSerial += 1;
        restoredWorkspaceRecoverySource = null;
        state.chapterDirty = false;
        state.chapterDirtyPaths.clear();
        setSaveStatus('已保存', 'saved');
        restoreWorkspaceRecoveryDraft(state.project, chapter);
        renderChapterList();
        renderEditor();
        renderCard();
        renderStoryState();
        renderCandidate();
        renderVersionHistory();
        renderCopilotWorkspace();
        renderWorkflowWorkspace();
        renderQualityWorkspace();
        void refreshGenerationHistory();
        if (state.inspector === 'versions') void refreshVersionHistory();
        if (state.view === 'copilot') void loadCopilotWorkspace();
        if (state.view === 'workflow') void loadWorkflowWorkspace();
        if (state.view === 'quality') void loadQualityWorkspace();
        persistWorkspaceResumeState();
        closeDrawers();
        focusTarget = elements.ss_manuscript;
    } catch (error) {
        if (!isCurrentNavigation(navigationEpoch)) return;
        setSaveStatus('载入失败', 'error');
        showToast(error.message || '无法载入章节', 5000);
    } finally {
        finishNavigation(navigationEpoch, focusTarget);
    }
}

async function exportProject() {
    if (state.navigationBusy || !state.project || elements.ss_export.disabled) return;
    const projectId = state.project.id;
    elements.ss_export.disabled = true;
    try {
        if (!(await enqueueSave())) return;
        const payload = await apiRequest(pathForProject(projectId, '/export'));
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${safeFileName(payload.project?.title)}.story-studio.json`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        showToast('作品已导出');
    } catch (error) {
        showToast(error.message || '无法导出作品', 5000);
    } finally {
        elements.ss_export.disabled = false;
    }
}

async function importProject(file) {
    if (state.navigationBusy || !file) return;
    if (!(await preparePendingChangeSetNavigation('导入作品'))) {
        elements.ss_import_file.value = '';
        return;
    }
    if (!confirmProjectReplacement('导入作品')) {
        elements.ss_import_file.value = '';
        return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
        showToast('导入文件超过 100 MB 上限', 5000);
        elements.ss_import_file.value = '';
        return;
    }
    const navigationEpoch = beginNavigation();
    elements.ss_import.disabled = true;
    try {
        if (!(await enqueueSave())) return;
        const payload = JSON.parse(await file.text());
        const result = await apiMutation(`${API_ROOT}/projects/import`, {
            method: 'POST',
            body: payload,
        });
        if (!isCurrentNavigation(navigationEpoch)) return;
        setLoadedProject(result.project, result.chapter);
        showToast('作品已导入');
    } catch (error) {
        const message = error instanceof SyntaxError ? '导入文件不是有效的 JSON' : error.message;
        showToast(message || '无法导入作品', 5000);
    } finally {
        elements.ss_import.disabled = false;
        elements.ss_import_file.value = '';
        finishNavigation(navigationEpoch);
    }
}

function setView(view) {
    if (!['today', 'write', 'bible', 'ledger', 'copilot', 'workflow', 'resources'].includes(view)
        && view !== 'quality') return;
    if (!workspaceAuthorityMutationAllowsView(authorityMutationView(), view)) return;
    state.view = view;
    renderViewState();
    if (view === 'today') {
        bindDashboardWorkspace(state.project);
        void loadDashboardWorkspace();
    }
    if (view === 'ledger') {
        renderLedger();
        renderStoryState();
    }
    if (view === 'resources') void loadResources();
    if (view === 'copilot') {
        bindCopilotWorkspace(state.project, state.chapter);
        void loadCopilotWorkspace();
    }
    if (view === 'workflow') {
        bindWorkflowWorkspace(state.project, state.chapter);
        void loadWorkflowWorkspace();
    }
    if (view === 'quality') {
        bindQualityWorkspace(state.project, state.chapter);
        void loadQualityWorkspace();
    }
    persistWorkspaceResumeState();
    closeDrawers();
}

async function loadResourceDetail(type, resourceId) {
    if (!state.project || !type || !resourceId) return;
    if (state.profileEditorDirty && !state.resourceBusy
        && !window.confirm('Prompt Profile 有未保存修改。放弃修改并切换资源？')) return;
    const projectId = state.project.id;
    const navigationEpoch = state.navigationEpoch;
    const requestSerial = ++state.resourceRequestSerial;
    try {
        const resource = await apiRequest(pathForProject(
            projectId,
            `/resources/${encodeURIComponent(type)}/${encodeURIComponent(resourceId)}`,
        ));
        if (state.project?.id !== projectId || state.navigationEpoch !== navigationEpoch
            || state.resourceRequestSerial !== requestSerial) return;
        state.selectedResource = resource;
        initializeProfileEditor(resource);
        renderResources();
    } catch (error) {
        if (state.project?.id === projectId) showToast(error.message || '无法读取资源', 5000);
    }
}

async function loadResources({ selectType = '', selectId = '' } = {}) {
    if (!state.project) return;
    const projectId = state.project.id;
    const navigationEpoch = state.navigationEpoch;
    const requestSerial = ++state.resourceRequestSerial;
    try {
        const resources = await apiRequest(pathForProject(projectId, '/resources'));
        if (state.project?.id !== projectId || state.navigationEpoch !== navigationEpoch
            || state.resourceRequestSerial !== requestSerial) return;
        state.resources = Array.isArray(resources) ? resources : [];
        const targetType = selectType || state.selectedResource?.type || '';
        const targetId = selectId || state.selectedResource?.id || '';
        if (!state.resources.some(resource => resource.type === targetType && resource.id === targetId)) {
            state.selectedResource = null;
        }
        renderResources();
        if (targetType && targetId && state.resources.some(resource => resource.type === targetType && resource.id === targetId)) {
            await loadResourceDetail(targetType, targetId);
        }
    } catch (error) {
        if (state.project?.id === projectId) showToast(error.message || '无法载入资源', 5000);
    }
}

async function refreshAfterResourceConflict(projectId, { preserveProfileDraft = false } = {}) {
    try {
        const project = await apiRequest(pathForProject(projectId));
        if (state.project?.id !== projectId) return;
        acceptServerProject(project);
        renderSaveMetadata();
        if (!preserveProfileDraft || !state.profileEditorDirty) {
            await loadResources();
            return;
        }
        const resources = await apiRequest(pathForProject(projectId, '/resources'));
        if (state.project?.id !== projectId) return;
        state.resources = Array.isArray(resources) ? resources : [];
        const selected = state.selectedResource;
        const stillExists = selected && state.resources.some(resource => (
            resource.type === selected.type && resource.id === selected.id
        ));
        if (stillExists) {
            state.selectedResource = await apiRequest(pathForProject(
                projectId,
                `/resources/${encodeURIComponent(selected.type)}/${encodeURIComponent(selected.id)}`,
            ));
            state.profileConflictMessage = `远端已更新至 r${state.selectedResource.revision}；本地草稿已保留`;
        } else {
            state.profileConflictMessage = '远端资源已删除；本地草稿已保留';
        }
        renderResources();
    } catch {
        if (preserveProfileDraft && state.profileEditorDirty) {
            state.profileConflictMessage = '资源冲突；远端刷新失败，本地草稿仍保留';
            renderResources();
        }
    }
}

async function mutateResource(operation, {
    selectType = '',
    selectId = '',
    successMessage = '',
    allowProfileDirty = false,
} = {}) {
    if (!state.project || state.resourceBusy) return null;
    if (state.profileEditorDirty && !allowProfileDirty
        && !window.confirm('Prompt Profile 有未保存修改。放弃修改并继续资源操作？')) {
        renderResources();
        return null;
    }
    const projectId = state.project.id;
    const navigationEpoch = state.navigationEpoch;
    state.resourceBusy = true;
    const authorityMutationToken = beginAuthorityMutation('resources');
    renderResources();
    try {
        if (!(await enqueueSave())) return null;
        if (state.project?.id !== projectId || state.navigationEpoch !== navigationEpoch) return null;
        const result = await operation();
        if (state.project?.id !== projectId || state.navigationEpoch !== navigationEpoch) return result;
        if (result?.project) acceptServerProject(result.project);
        else if (result?.id === projectId) acceptServerProject(result);
        renderSaveMetadata();
        await loadResources({ selectType, selectId });
        if (successMessage) showToast(successMessage);
        return result;
    } catch (error) {
        if (error instanceof ApiError && error.status === 409 && state.project?.id === projectId) {
            if (state.profileEditorDirty) {
                await refreshAfterResourceConflict(projectId, { preserveProfileDraft: true });
            } else {
                await refreshAfterResourceConflict(projectId);
            }
        }
        showToast(error.message || '资源操作失败', 5000);
        return null;
    } finally {
        state.resourceBusy = false;
        finishAuthorityMutation(authorityMutationToken);
        renderResources();
    }
}

async function updateResourceActivation(changes) {
    const projectId = state.project?.id;
    if (!projectId) return;
    await mutateResource(() => apiMutation(pathForProject(projectId, '/resources/activation'), {
        method: 'PATCH',
        body: { projectVersion: state.project.version, changes },
    }), { successMessage: '资源上下文已更新' });
}

async function handleResourceActivation(target) {
    if (!state.project || state.resourceBusy) return;
    const references = state.project.resources || {};
    if (target.dataset.resourceContext !== undefined) {
        const id = target.dataset.resourceContext;
        const active = new Set(references.activeCharacterIds || []);
        if (target.checked) active.add(id); else active.delete(id);
        await updateResourceActivation({ activeCharacterIds: [...active] });
    } else if (target.dataset.resourcePersona !== undefined && target.checked) {
        await updateResourceActivation({ activePersonaId: target.dataset.resourcePersona || null });
    } else if (target.dataset.resourceLore !== undefined) {
        const id = target.dataset.resourceLore;
        const active = new Set(references.activeLorebookIds || []);
        if (target.checked) active.add(id); else active.delete(id);
        await updateResourceActivation({ activeLorebookIds: [...active] });
    } else if (target.dataset.resourcePrompt !== undefined && target.checked) {
        await updateResourceActivation({ activePromptProfileId: target.dataset.resourcePrompt || null });
    }
}

function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function importResourceFile(file) {
    if (!file || !state.project || state.resourceBusy) return;
    const isPng = file.type === 'image/png' || file.name.toLocaleLowerCase().endsWith('.png');
    if (file.size > (isPng ? 20 : 5) * 1024 * 1024) {
        showToast(isPng ? 'PNG 超过 20 MiB' : 'JSON 超过 5 MiB', 5000);
        return;
    }
    let resourceImport;
    try {
        resourceImport = isPng
            ? {
                fileName: file.name,
                mediaType: 'image/png',
                encoding: 'base64',
                data: bytesToBase64(await file.arrayBuffer()),
            }
            : {
                fileName: file.name,
                mediaType: 'application/json',
                encoding: 'json',
                data: JSON.parse(await file.text()),
            };
    } catch (error) {
        showToast(error instanceof SyntaxError ? '资源文件不是有效的 JSON' : error.message || '无法读取资源文件', 5000);
        return;
    }
    const projectId = state.project.id;
    const result = await mutateResource(() => apiMutation(pathForProject(projectId, '/resources/import'), {
        method: 'POST',
        body: { projectVersion: state.project.version, import: resourceImport },
    }), { successMessage: '资源已导入' });
    if (result?.resource) {
        await loadResources({ selectType: result.resource.type, selectId: result.resource.id });
    }
}

async function toggleCharacterInstruction() {
    const resource = state.selectedResource;
    if (!resource || resource.type !== 'character') return;
    const projectId = state.project.id;
    const enabled = elements.ss_resource_instruction_enabled.checked;
    await mutateResource(() => apiMutation(pathForProject(
        projectId,
        `/resources/character/${encodeURIComponent(resource.id)}`,
    ), {
        method: 'PATCH',
        body: {
            projectVersion: state.project.version,
            revision: resource.revision,
            changes: { instructionEnabled: enabled },
        },
    }), { selectType: 'character', selectId: resource.id, successMessage: '角色指令设置已更新' });
}

function profilePreviewSlotValues() {
    const story = state.project?.story || {};
    return {
        main: [story.premise, story.styleGuide].filter(Boolean).join('\n\n'),
        worldBefore: story.world ?? '',
        persona: state.project?.author ?? '',
        character: '',
        scenario: story.premise ?? '',
        worldAfter: '',
        examples: '',
        chapter: state.chapter ? JSON.stringify({
            number: state.chapter.number,
            title: state.chapter.title,
            card: state.chapter.card,
        }, null, 2) : '',
        ledger: JSON.stringify(state.project?.continuity ?? [], null, 2),
        retrieval: '',
        task: `${AI_LABELS[state.aiKind] || state.aiKind || '任务'}`,
        postInstruction: '',
        custom: {},
    };
}

function profilePreviewAssemblyOptions(task = '') {
    const supportedKinds = new Set(['plan', 'draft', 'review', 'continuity']);
    const kind = supportedKinds.has(task)
        ? task
        : supportedKinds.has(state.aiKind) ? state.aiKind : 'draft';
    const promptLimit = 64_000;
    const base = buildGenerationRequest(kind, state.project || {}, state.chapter || {}, null, {
        promptCharacterLimit: promptLimit,
    });
    const protocol = state.provider?.protocol || 'openai-chat';
    return {
        task,
        baseSystemPrompt: base.systemPrompt,
        taskText: base.prompt,
        taskKind: kind,
        project: state.project || {},
        chapter: state.chapter || {},
        resources: {
            taskKind: kind,
            continuityLedger: state.project?.continuity ?? [],
        },
        provider: {
            ...(state.provider || {}),
            transport: ['openai-completions', 'llamacpp-completion'].includes(protocol) ? 'text' : 'chat',
        },
        promptLimit,
        slotValues: profilePreviewSlotValues(),
    };
}

function updateProfileDirtyState() {
    if (!state.profileEditor) return;
    try {
        state.profileEditorDirty = profileDraftFingerprint(state.profileEditor) !== state.profileEditorBaseline;
    } catch {
        state.profileEditorDirty = true;
    }
    elements.ss_profile_revert.disabled = state.resourceBusy || !state.profileEditorDirty;
    elements.ss_profile_save.disabled = state.resourceBusy || !state.profileEditorDirty;
    elements.ss_profile_status.textContent = state.profileConflictMessage || (state.profileEditorDirty
        ? '未保存'
        : `r${state.selectedResource?.revision ?? state.profileEditor.revision}`);
    elements.ss_profile_status.dataset.state = state.profileConflictMessage
        ? 'error'
        : state.profileEditorDirty ? 'dirty' : 'saved';
}

function updateProfileEditorField(target) {
    if (!state.profileEditor) return;
    const fields = {
        ss_profile_name: 'name',
        ss_profile_token_budget: 'tokenBudget',
        ss_profile_character_budget: 'characterBudget',
        ss_profile_generation: 'generationText',
        ss_profile_modules: 'modulesText',
        ss_profile_order: 'orderText',
        ss_profile_variables: 'variablesText',
        ss_profile_variable_values: 'variableValuesText',
        ss_profile_generation_policies: 'generationPoliciesText',
        ss_profile_task_policies: 'taskPoliciesText',
    };
    const field = fields[target.id];
    if (!field) return;
    state.profileEditor[field] = target.value;
    state.profileCompileResult = null;
    state.profileCompileError = '';
    updateProfileDirtyState();
    if (field === 'taskPoliciesText') renderProfileTaskOptions();
    renderProfileCompileResult();
}

function compileCurrentProfile() {
    if (!state.profileEditor) return;
    try {
        const task = elements.ss_profile_preview_task.value;
        state.profileCompileResult = assembleProfilePreview(state.profileEditor, {
            ...profilePreviewAssemblyOptions(task),
            variablesText: elements.ss_profile_preview_variables.value,
            tokenBudget: elements.ss_profile_preview_tokens.value,
            characterBudget: elements.ss_profile_preview_characters.value,
        });
        state.profileCompileError = '';
    } catch (error) {
        state.profileCompileResult = null;
        state.profileCompileError = error.message || 'Profile 编译失败';
    }
    renderProfileCompileResult();
}

function revertProfileEditor() {
    const resource = state.selectedResource;
    if (!isPromptProfileV2(resource)) return;
    initializeProfileEditor(resource);
    renderResourceDetail();
}

async function saveProfileEditor() {
    const resource = state.selectedResource;
    if (!state.project || !isPromptProfileV2(resource) || !state.profileEditor || state.resourceBusy) return;
    let changes;
    try {
        changes = buildProfileChanges(state.profileEditor);
        const tasks = ['', ...profileTaskNames(state.profileEditor)];
        const validationErrors = [];
        for (const task of tasks) {
            const compiled = assembleProfilePreview(state.profileEditor, {
                ...profilePreviewAssemblyOptions(task),
            });
            validationErrors.push(...compiled.errors.map(item => ({ ...item, task: task || 'default' })));
        }
        if (validationErrors.length > 0) {
            const first = validationErrors[0];
            throw new Error(`${first.code || 'invalid_profile'} · ${first.task}`);
        }
    } catch (error) {
        state.profileCompileError = error.message || 'Profile 校验失败';
        state.profileCompileResult = null;
        renderProfileCompileResult();
        showToast(state.profileCompileError, 5000);
        return;
    }
    const projectId = state.project.id;
    await mutateResource(() => apiMutation(pathForProject(
        projectId,
        `/resources/prompt-profile/${encodeURIComponent(resource.id)}`,
    ), {
        method: 'PATCH',
        body: {
            projectVersion: state.project.version,
            revision: resource.revision,
            changes,
        },
    }), {
        selectType: 'prompt-profile',
        selectId: resource.id,
        successMessage: 'Prompt Profile 已保存',
        allowProfileDirty: true,
    });
}

async function deleteSelectedResource() {
    const resource = state.selectedResource;
    if (!state.project || !resource || !window.confirm(`删除资源“${resource.name || '未命名资源'}”？`)) return;
    const projectId = state.project.id;
    const deleted = await mutateResource(() => apiMutation(pathForProject(
        projectId,
        `/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.id)}`,
    ), {
        method: 'DELETE',
        body: { projectVersion: state.project.version, revision: resource.revision },
    }), { successMessage: '资源已删除', allowProfileDirty: true });
    if (deleted) {
        state.selectedResource = null;
        renderResources();
    }
}

function setPendingChangeSetDraft(value) {
    state.pendingChangeSetDraft = value;
    state.pendingChangeSetDirty = value !== state.pendingChangeSetSaved;
    state.pendingChangeSetError = '';
    renderPendingChangeSet();
}

function savePendingChangeSet({ quiet = false } = {}) {
    if (!state.pendingChangeSetDirty) return true;
    if (!state.project || !state.chapter
        || !pendingChangeSetBindingMatches(state.project.id, state.chapter.id)) {
        if (!quiet) showToast('ChangeSet 没有有效的作品与章节绑定', 5000);
        return false;
    }
    const validation = pendingChangeSetValidation();
    if (validation.error) {
        if (!quiet) showToast(`ChangeSet 格式错误：${validation.error}`, 5000);
        renderPendingChangeSet();
        return false;
    }
    const normalized = JSON.stringify(validation.value, null, 2);
    const storageKey = pendingChangeSetDraftStorageKey(
        state.pendingChangeSetProjectId,
        state.pendingChangeSetChapterId,
    );
    try {
        window.localStorage.setItem(storageKey, normalized);
    } catch {
        showToast('浏览器无法保存本地 ChangeSet', 5000);
        return false;
    }
    state.pendingChangeSetSaved = normalized;
    state.pendingChangeSetDraft = normalized;
    state.pendingChangeSetDirty = false;
    renderPendingChangeSet();
    if (!quiet) showToast('ChangeSet 已保存在本地');
    return true;
}

function revertPendingChangeSet() {
    if (!state.project || !state.pendingChangeSetDirty) return;
    setPendingChangeSetDraft(state.pendingChangeSetSaved);
}

function clearPendingChangeSet() {
    if (!state.project) return;
    setPendingChangeSetDraft(JSON.stringify(emptyPendingChangeSet(), null, 2));
}

async function copyPendingChangeSet() {
    const validation = pendingChangeSetValidation();
    if (validation.error) {
        showToast(`ChangeSet 格式错误：${validation.error}`, 5000);
        return;
    }
    const text = JSON.stringify(validation.value, null, 2);
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
    } else {
        elements.ss_pending_changeset_json.focus();
        elements.ss_pending_changeset_json.select();
        document.execCommand('copy');
    }
    showToast('ChangeSet 已复制');
}

function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonicalJsonValue(value[key])]),
    );
}

async function pendingChangeSetDigest(value) {
    const canonical = JSON.stringify(canonicalJsonValue(value));
    const bytes = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function adoptPendingChangeSet() {
    if (!state.project || !state.chapter || state.pendingChangeSetAdopting) return;
    if (!pendingChangeSetBindingMatches(state.project.id, state.chapter.id)) {
        showToast('ChangeSet 的章节绑定已变化，请重新载入草稿', 5000);
        return;
    }
    const validation = pendingChangeSetValidation();
    const mutationTotal = pendingChangeSetMutationTotal(validation.value);
    if (validation.error || mutationTotal === 0) {
        showToast(validation.error ? `ChangeSet 格式错误：${validation.error}` : 'ChangeSet 没有待采纳变更', 5000);
        return;
    }
    const warningText = validation.warnings?.length > 0
        ? `\n\n校验警告：${validation.warnings[0]}\n服务端仍会执行最终校验。`
        : '';
    if (!window.confirm(`原子采纳当前 ChangeSet 的 ${mutationTotal} 项变更？${warningText}`)) return;

    const projectId = state.pendingChangeSetProjectId;
    const chapterId = state.pendingChangeSetChapterId;
    const navigationEpoch = state.navigationEpoch;
    const draftText = state.pendingChangeSetDraft;
    const storageKey = pendingChangeSetDraftStorageKey(projectId, chapterId);
    let storedBefore = null;
    let storageReadable = false;
    try {
        storedBefore = window.localStorage.getItem(storageKey);
        storageReadable = true;
    } catch {
        // Adoption may proceed; an inaccessible browser draft cannot be removed afterward.
    }
    state.pendingChangeSetAdopting = true;
    syncShellInert();
    renderPendingChangeSet();
    try {
        if (!(await enqueueSave())) return;
        if (!pendingChangeSetBindingMatches(projectId, chapterId)
            || state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch) return;
        const digest = await pendingChangeSetDigest(validation.value);
        if (!pendingChangeSetBindingMatches(projectId, chapterId)
            || state.pendingChangeSetDraft !== draftText
            || state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch) return;
        const chapterSummary = String(validation.value.chapterSummary ?? '').trim();
        const payload = {
            generationId: `manual-state-${digest}`,
            kind: 'manual-state',
            ...(chapterSummary ? { chapterSummary } : {}),
            storyStateChanges: validation.value.storyStateChanges,
        };
        const result = await apiMutation(chapterPath(projectId, chapterId, '/adopt'), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                revision: state.chapter.revision,
                payload,
            },
        });
        if (!pendingChangeSetBindingMatches(projectId, chapterId)
            || state.pendingChangeSetDraft !== draftText
            || state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch) return;
        acceptServerProject(result.project, new Set());
        acceptServerChapter(result.chapter, new Set());
        clearDirtyState();
        const emptyDraft = JSON.stringify(emptyPendingChangeSet(), null, 2);
        try {
            if (storageReadable && window.localStorage.getItem(storageKey) === storedBefore) {
                window.localStorage.removeItem(storageKey);
            }
        } catch {
            // The authoritative adoption already succeeded; an old browser draft is harmless.
        }
        state.pendingChangeSetSaved = emptyDraft;
        state.pendingChangeSetDraft = emptyDraft;
        state.pendingChangeSetDirty = false;
        state.pendingChangeSetError = '';
        state.pendingChangeSetAdopting = false;
        renderProjectData();
        if (state.inspector === 'versions') void refreshVersionHistory();
        showToast('ChangeSet 已原子采纳');
    } catch (error) {
        showToast(`${error.message || 'ChangeSet 采纳失败'}；草稿已保留`, 5000);
    } finally {
        state.pendingChangeSetAdopting = false;
        syncShellInert();
        renderPendingChangeSet();
    }
}

function addRecordToPendingChangeSet(category, recordId) {
    if (!state.project || !(category in CHANGESET_LABELS)) return;
    const record = state.project.storyState?.[category]?.find(item => item.id === recordId);
    if (!record) return;
    const validation = pendingChangeSetValidation();
    if (validation.error) {
        showToast(`请先修复本地 ChangeSet：${validation.error}`, 5000);
        return;
    }
    const mutation = validation.value.storyStateChanges[category];
    mutation.upsert = [...mutation.upsert.filter(item => item.id !== record.id), clone(record)];
    mutation.delete = mutation.delete.filter(id => id !== record.id);
    setPendingChangeSetDraft(JSON.stringify(validation.value, null, 2));
    elements.ss_pending_changeset_json.focus();
    showToast('记录已加入本地 ChangeSet');
}

async function jumpToContinuityChapter(chapterId) {
    if (!chapterId || !state.project?.chapters?.some(chapter => chapter.id === chapterId)) {
        showToast('来源章节已不存在', 5000);
        return;
    }
    if (!(await preparePendingChangeSetNavigation('打开来源章节'))) return;
    state.view = 'write';
    renderViewState();
    await loadChapter(chapterId, { pendingPrepared: true });
}

async function restoreSelectedVersion() {
    const snapshot = state.selectedVersion;
    if (state.navigationBusy || state.versionRestoring || !state.project || !state.chapter || !snapshot) return;
    const versionId = versionIdOf(snapshot);
    if (!versionId) return;
    const label = formatDate(snapshot.createdAt) || `r${snapshot.chapterRevision || '?'}`;
    if (!window.confirm(`恢复到 ${label} 的章节版本？当前未保存内容会先保存，恢复后仍可从版本历史找回。`)) return;

    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const navigationEpoch = beginNavigation();
    state.versionRestoring = true;
    renderVersionHistory();
    let focusVersionId = '';
    try {
        if (!(await enqueueSave())) return;
        const result = await apiMutation(versionPath(projectId, chapterId, versionId, '/restore'), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
            },
        });
        if (!isCurrentNavigation(navigationEpoch)) return;
        const preferredVersionId = versionIdOf(result.version) || versionId;
        setLoadedProject(result.project, result.chapter);
        state.inspector = 'versions';
        renderInspectorState();
        await refreshVersionHistory({ selectId: preferredVersionId });
        if (!isCurrentNavigation(navigationEpoch)) return;
        focusVersionId = 'current';
        showToast('章节版本已恢复');
    } catch (error) {
        const message = error instanceof ApiError
            && ['project_conflict', 'chapter_conflict'].includes(error.code)
            ? '章节已在其他窗口更新，请刷新版本后重试'
            : error.message || '无法恢复章节版本';
        state.versionsError = message;
        showToast(message, 5000);
    } finally {
        state.versionRestoring = false;
        finishNavigation(navigationEpoch);
        renderVersionHistory();
        if (isCurrentNavigation(navigationEpoch)) {
            if (focusVersionId) focusVersionButton(focusVersionId);
            else elements.ss_refresh_versions.focus();
        }
    }
}

function setInspector(panel, focusTab = false) {
    if (!['card', 'assistant', 'versions'].includes(panel)) return;
    state.inspector = panel;
    renderInspectorState();
    elements.ss_inspector.scrollTop = 0;
    if (panel === 'versions' && state.chapter
        && !versionCacheMatchesChapter() && !state.versionsLoading) {
        void refreshVersionHistory();
    }
    if (focusTab) {
        elements.inspectorTabs.find(button => button.dataset.ssInspector === panel)?.focus();
    }
}

function manuscriptSelection() {
    const content = state.chapter?.content || '';
    const start = Number(elements.ss_manuscript.selectionStart ?? 0);
    const end = Number(elements.ss_manuscript.selectionEnd ?? start);
    const text = content.slice(start, end);
    if (!text.trim()) return null;
    return {
        text,
        before: content.slice(Math.max(0, start - 2_000), start),
        after: content.slice(end, end + 2_000),
        start,
        end,
    };
}

function generationEnvelope(kind, mode = 'generate', parentId = null, selection = null) {
    const instruction = elements.ss_generation_instruction.value.trim();
    return {
        kind,
        mode,
        ...(parentId ? { parentId } : {}),
        ...(selection ? { selection } : {}),
        instruction,
        contextOverrides: contextOverridesForRequest(),
        retrieval: retrievalOverridesForRequest(),
        projectVersion: state.project.version,
        chapterRevision: state.chapter.revision,
    };
}

async function recoverGenerationRecord(projectId, chapterId, generationId) {
    let latest = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            latest = await apiRequest(generationPath(
                projectId,
                chapterId,
                `/${encodeURIComponent(generationId)}`,
            ));
            if (latest.status !== 'streaming') return latest;
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
        await delay(120 + attempt * 40);
    }
    return latest;
}

function streamCandidateDelta(delta, generationId) {
    if (!state.activeGeneration || state.activeGeneration.id !== generationId) return;
    const followTail = elements.ss_candidate.scrollHeight - elements.ss_candidate.scrollTop
        - elements.ss_candidate.clientHeight < 48;
    state.activeGeneration.content += delta;
    elements.ss_candidate.value = state.activeGeneration.content;
    if (followTail) elements.ss_candidate.scrollTop = elements.ss_candidate.scrollHeight;
    elements.ss_generation_status.textContent = `正在生成 · ${numberFormatter.format(state.activeGeneration.content.length)} 字符`;
}

async function startGeneration(mode = 'generate', parent = null) {
    if (state.navigationBusy || !state.project || !state.chapter || state.generating) return;
    const kind = parent?.kind || state.aiKind;
    if (mode === 'continue' && kind !== 'draft') return;
    const selection = SELECTION_AI_KINDS.has(kind) ? manuscriptSelection() : null;
    if (SELECTION_AI_KINDS.has(kind) && !selection) {
        showToast('请先在正文中选择非空文本', 5000);
        elements.ss_manuscript.focus();
        return;
    }
    const selectionSnapshot = selection ? { ...selection, chapterContent: state.chapter.content } : null;
    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const navigationEpoch = state.navigationEpoch;
    const requestSerial = ++state.generationRequestSerial;
    const controller = new AbortController();
    let generationId = '';
    let completed = false;

    state.generating = true;
    state.generationController = controller;
    state.selectionBaseline = null;
    renderCandidate();
    try {
        if (!(await enqueueSave())) return;
        if (controller.signal.aborted) throw controller.signal.reason;
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch || state.generationRequestSerial !== requestSerial) {
            return;
        }
        if (selectionSnapshot && state.chapter.content !== selectionSnapshot.chapterContent) {
            throw new Error('正文已变化，请重新选择文本后再生成');
        }

        const envelope = generationEnvelope(kind, mode, parent?.id || null, selection);
        completed = await streamMutation(generationPath(projectId, chapterId, '/stream'), envelope, {
            signal: controller.signal,
            onEvent(event) {
                if (state.project?.id !== projectId || state.chapter?.id !== chapterId
                    || state.navigationEpoch !== navigationEpoch || state.generationRequestSerial !== requestSerial) {
                    controller.abort();
                    return;
                }
                if (event?.type === 'meta') {
                    generationId = event.generationId;
                    if (selectionSnapshot) {
                        state.selectionBaseline = {
                            ...selectionSnapshot,
                            generationId,
                            chapterId,
                            chapterRevision: state.chapter.revision,
                        };
                    }
                    state.selectedGenerationId = generationId;
                    state.generationDiagnostics = event.diagnostics || null;
                    state.activeGeneration = {
                        id: generationId,
                        kind: event.kind || kind,
                        mode: event.mode || mode,
                        parentId: event.parentId || null,
                        status: 'streaming',
                        content: event.baseContent || '',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        model: '',
                        distillation: { status: 'none', changes: null },
                    };
                    state.generations = [state.activeGeneration, ...state.generations.filter(item => item.id !== generationId)];
                    renderCandidate();
                    return;
                }
                if (event?.type === 'delta') {
                    streamCandidateDelta(String(event.delta || ''), generationId);
                    return;
                }
                if (event?.type === 'done') {
                    completed = true;
                    state.activeGeneration = event.generation;
                    state.selectedGenerationId = event.generation?.id || generationId;
                    state.generationDiagnostics = event.diagnostics || state.generationDiagnostics;
                    renderCandidate();
                    return;
                }
                if (event?.type === 'error') {
                    generationId = event.generationId || generationId;
                    throw new ApiError(event.message || '生成失败', 502, event);
                }
            },
        });
        if (!completed) throw new ApiError('生成数据流提前结束', 502, { error: 'generation_stream_ended' });
        showToast('候选已生成，尚未采纳');
    } catch (error) {
        const stopped = controller.signal.aborted || error?.name === 'AbortError';
        if (generationId && state.project?.id === projectId && state.chapter?.id === chapterId) {
            try {
                const recovered = await recoverGenerationRecord(projectId, chapterId, generationId);
                if (recovered && state.navigationEpoch === navigationEpoch) {
                    state.activeGeneration = recovered;
                    state.selectedGenerationId = recovered.id;
                    renderCandidate();
                }
            } catch {
                // The history refresh below remains the authoritative recovery path.
            }
        }
        if (state.project?.id === projectId && state.chapter?.id === chapterId
            && state.navigationEpoch === navigationEpoch) {
            showToast(stopped
                ? generationId ? '已停止，生成结果已恢复到候选历史' : '生成已停止'
                : error.message || '生成失败', 5000);
        }
    } finally {
        if (state.generationController === controller) {
            state.generating = false;
            state.generationController = null;
            if (state.project?.id === projectId && state.chapter?.id === chapterId
                && state.navigationEpoch === navigationEpoch) {
                if (generationId) await refreshGenerationHistory({ selectId: generationId, loadSelected: true });
                renderCandidate();
            }
        }
    }
}

function stopGeneration() {
    if (!state.generationController || state.generationController.signal.aborted) return;
    state.generationController.abort();
    renderGenerationControls();
}

async function generateCandidate() {
    if (state.generating) {
        stopGeneration();
        return;
    }
    await startGeneration('generate');
}

async function previewGeneration() {
    if (state.navigationBusy || state.generating || !state.project || !state.chapter) return;
    const selection = SELECTION_AI_KINDS.has(state.aiKind) ? manuscriptSelection() : null;
    if (SELECTION_AI_KINDS.has(state.aiKind) && !selection) {
        showToast('请先在正文中选择非空文本', 5000);
        elements.ss_manuscript.focus();
        return;
    }
    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const navigationEpoch = state.navigationEpoch;
    const { controller, requestSerial } = beginContextPreviewRequest();
    elements.ss_generation_preview.disabled = true;
    try {
        if (!(await enqueueSave())
            || !contextPreviewRequestIsCurrent(
                projectId,
                chapterId,
                navigationEpoch,
                requestSerial,
                controller,
            )) return;
        const preview = await apiMutation(
            generationPath(projectId, chapterId).replace(/\/generations$/, '/generation-preview'),
            {
                method: 'POST',
                body: generationEnvelope(state.aiKind, 'generate', null, selection),
                signal: controller.signal,
            },
        );
        if (!contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) return;
        state.generationPreview = preview;
        renderContextPreview();
        elements.ss_context_preview.scrollIntoView({ block: 'nearest' });
    } catch (error) {
        if (!contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) return;
        showToast(error.message || '无法预览生成上下文', 5000);
    } finally {
        if (contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) {
            state.contextPreviewController = null;
            renderGenerationControls();
        }
    }
}

async function previewRetrieval() {
    if (state.navigationBusy || state.generating || !state.project || !state.chapter) return;
    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const navigationEpoch = state.navigationEpoch;
    const { controller, requestSerial } = beginContextPreviewRequest();
    elements.ss_retrieval_preview.disabled = true;
    try {
        if (!(await enqueueSave())
            || !contextPreviewRequestIsCurrent(
                projectId,
                chapterId,
                navigationEpoch,
                requestSerial,
                controller,
            )) return;
        const retrieval = retrievalOverridesForRequest({ includeRerank: true });
        const preview = await apiMutation(chapterPath(projectId, chapterId, '/retrieval/preview'), {
            method: 'POST',
            signal: controller.signal,
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                query: elements.ss_generation_instruction.value.trim() || undefined,
                limit: retrieval.limit,
                manualInclude: retrieval.include,
                manualExclude: retrieval.exclude,
                rerank: retrieval.rerank,
            },
        });
        if (!contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) return;
        state.generationPreview = {
            systemPrompt: '',
            prompt: '',
            messages: [],
            responseLength: 0,
            diagnostics: { retrieval: preview },
        };
        renderContextPreview();
        elements.ss_context_preview.scrollIntoView({ block: 'nearest' });
    } catch (error) {
        if (!contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) return;
        showToast(error.message || '无法预览检索结果', 5000);
    } finally {
        if (contextPreviewRequestIsCurrent(
            projectId,
            chapterId,
            navigationEpoch,
            requestSerial,
            controller,
        )) {
            state.contextPreviewController = null;
            renderGenerationControls();
        }
    }
}

function applyPlanCandidate(content) {
    const parsed = parseStructuredResponse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('章纲候选不是有效的 JSON 对象');
    }
    const fields = CARD_FIELDS.filter(field => typeof parsed[field] === 'string');
    if (fields.length === 0) throw new Error('章纲候选没有可应用字段');
    const overwritesExisting = fields.some(field => state.chapter.card[field]?.trim() && state.chapter.card[field] !== parsed[field]);
    if (overwritesExisting && !window.confirm('章纲已有内容。应用候选会替换同名字段，是否继续？')) {
        return;
    }

    const dirtyPaths = [];
    for (const field of fields) {
        state.chapter.card[field] = parsed[field];
        dirtyPaths.push(`card.${field}`);
    }
    markChapterDirty(dirtyPaths);
    renderCard();
    setInspector('card', true);
    showToast('候选已应用到章纲');
}

function applyDraftCandidate(content, append) {
    if (!append && state.chapter.content.trim() && !window.confirm('替换当前章节正文？原正文会在下次保存时被覆盖。')) {
        return;
    }
    state.chapter.content = append && state.chapter.content.trim()
        ? `${state.chapter.content.trimEnd()}\n\n${content}`
        : content;
    const changedStatus = state.chapter.status === 'planned';
    if (changedStatus) state.chapter.status = 'drafting';
    markChapterDirty(changedStatus ? ['content', 'status'] : 'content');
    state.view = 'write';
    renderEditor();
    renderViewState();
    closeDrawers();
    elements.ss_manuscript.focus();
    showToast(append ? '候选已追加到正文' : '候选已替换正文');
}

function insertDraftCandidate(content) {
    const manuscript = state.chapter.content || '';
    const start = Number(elements.ss_manuscript.selectionStart ?? manuscript.length);
    const end = Number(elements.ss_manuscript.selectionEnd ?? start);
    const before = manuscript.slice(0, start);
    const after = manuscript.slice(end);
    const leadingBreak = before && !before.endsWith('\n') ? '\n\n' : '';
    const trailingBreak = after && !after.startsWith('\n') ? '\n\n' : '';
    const insertion = `${leadingBreak}${content}${trailingBreak}`;
    state.chapter.content = `${before}${insertion}${after}`;
    const changedStatus = state.chapter.status === 'planned';
    if (changedStatus) state.chapter.status = 'drafting';
    markChapterDirty(changedStatus ? ['content', 'status'] : 'content');
    state.view = 'write';
    renderEditor();
    renderViewState();
    const caret = before.length + insertion.length;
    closeDrawers();
    elements.ss_manuscript.focus();
    elements.ss_manuscript.setSelectionRange(caret, caret);
    showToast('候选已插入正文');
}

function applyReviewCandidate(content) {
    if (state.chapter.review.trim() && state.chapter.review !== content
        && !window.confirm('审校记录已有内容。是否用当前候选替换？')) {
        return;
    }
    state.chapter.review = content;
    markChapterDirty('review');
    elements.ss_review_record.value = content;
    showToast('候选已写入审校记录');
}

function replaceSelectionCandidate(content) {
    if (!selectionBaselineIsCurrent()) {
        throw new Error('正文或原选区已变化，不能自动替换；候选仍可复制');
    }
    const baseline = state.selectionBaseline;
    state.chapter.content = `${state.chapter.content.slice(0, baseline.start)}${content}${state.chapter.content.slice(baseline.end)}`;
    const changedStatus = state.chapter.status === 'planned';
    if (changedStatus) state.chapter.status = 'drafting';
    markChapterDirty(changedStatus ? ['content', 'status'] : 'content');
    state.selectionBaseline = null;
    state.view = 'write';
    renderEditor();
    renderViewState();
    renderCandidateActions();
    closeDrawers();
    const caret = baseline.start + content.length;
    elements.ss_manuscript.focus();
    elements.ss_manuscript.setSelectionRange(caret, caret);
    showToast('候选已替换原选区');
}

async function copyCandidate(content) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
    } else {
        elements.ss_candidate.focus();
        elements.ss_candidate.select();
        document.execCommand('copy');
    }
    showToast('候选已复制');
}

async function distillActiveGeneration() {
    const generation = state.activeGeneration;
    if (!state.project || !state.chapter || generation?.kind !== 'draft'
        || !['completed', 'partial'].includes(generation.status) || state.distilling) return;
    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const generationId = generation.id;
    const navigationEpoch = state.navigationEpoch;
    state.distilling = true;
    renderCandidate();
    try {
        if (!(await enqueueSave())) return;
        const result = await apiMutation(generationPath(
            projectId,
            chapterId,
            `/${encodeURIComponent(generationId)}/distill`,
        ), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                instruction: elements.ss_generation_instruction.value.trim(),
                contextOverrides: contextOverridesForRequest(),
            },
        });
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch) return;
        state.activeGeneration = result.generation;
        state.selectedGenerationId = generationId;
        renderCandidate();
        await refreshGenerationHistory({ selectId: generationId, loadSelected: false });
        showToast('ChangeSet 已生成，尚未采纳');
    } catch (error) {
        if (state.project?.id === projectId && state.chapter?.id === chapterId) {
            try {
                await loadGenerationSelection(generationId, {
                    projectId,
                    chapterId,
                    navigationEpoch,
                    requestSerial: state.generationRequestSerial,
                });
            } catch {
                // Keep the source draft visible when the failed status cannot be refreshed.
            }
            showToast(error.message || '蒸馏失败', 5000);
        }
    } finally {
        state.distilling = false;
        renderCandidate();
    }
}

async function adoptActiveGeneration(contentMode) {
    const generation = state.activeGeneration;
    if (!state.project || !state.chapter || generation?.kind !== 'draft'
        || !generationCanBranch(generation) || state.adopting) return;
    if (contentMode === 'replace' && state.chapter.content.trim()
        && !window.confirm('原子采纳会替换当前章节正文，并同时写入已蒸馏的状态变更。是否继续？')) {
        return;
    }
    const projectId = state.project.id;
    const chapterId = state.chapter.id;
    const generationId = generation.id;
    const navigationEpoch = state.navigationEpoch;
    const contentOffset = Number(elements.ss_manuscript.selectionStart ?? state.chapter.content.length);
    state.adopting = true;
    syncShellInert();
    renderCandidate();
    try {
        if (!(await enqueueSave())) return;
        const result = await apiMutation(generationPath(
            projectId,
            chapterId,
            `/${encodeURIComponent(generationId)}/adopt`,
        ), {
            method: 'POST',
            body: {
                projectVersion: state.project.version,
                chapterRevision: state.chapter.revision,
                contentMode,
                ...(contentMode === 'insert' ? { contentOffset } : {}),
                includeContent: true,
            },
        });
        if (state.project?.id !== projectId || state.chapter?.id !== chapterId
            || state.navigationEpoch !== navigationEpoch) return;
        acceptServerProject(result.project, new Set());
        acceptServerChapter(result.chapter, new Set());
        state.activeGeneration = result.generation;
        state.selectedGenerationId = generationId;
        clearDirtyState();
        renderProjectData();
        if (state.inspector === 'versions' && !versionCacheMatchesChapter()) {
            void refreshVersionHistory({ selectId: state.selectedVersionId });
        }
        await refreshGenerationHistory({ selectId: generationId, loadSelected: false });
        showToast(generation.distillation?.status === 'ready' ? '正文与 ChangeSet 已原子采纳' : '正文已原子采纳');
    } catch (error) {
        showToast(error.message || '无法采纳候选', 5000);
    } finally {
        state.adopting = false;
        syncShellInert();
        renderCandidate();
    }
}

async function handleCandidateAction(action) {
    const content = currentCandidate().content || '';
    if (!state.project || !state.chapter || !content) return;
    try {
        if (action === 'distill') await distillActiveGeneration();
        if (action === 'adopt-replace') await adoptActiveGeneration('replace');
        if (action === 'adopt-insert') await adoptActiveGeneration('insert');
        if (action === 'adopt-append') await adoptActiveGeneration('append');
        if (action === 'apply-plan') applyPlanCandidate(content);
        if (action === 'insert-draft') insertDraftCandidate(content);
        if (action === 'replace-draft') applyDraftCandidate(content, false);
        if (action === 'append-draft') applyDraftCandidate(content, true);
        if (action === 'apply-review') applyReviewCandidate(content);
        if (action === 'replace-selection') replaceSelectionCandidate(content);
        if (action === 'copy') await copyCandidate(content);
        if (action === 'clear') {
            if (!window.confirm('清空当前 AI 候选？')) return;
            state.chapter.candidate = { kind: '', content: '', createdAt: null };
            markCandidateDirty();
            renderCandidate();
        }
    } catch (error) {
        showToast(error.message || '无法应用候选', 5000);
    }
}

function setProviderStatus(message = '', stateName = '') {
    elements.ss_provider_status.textContent = message;
    if (stateName) {
        elements.ss_provider_status.dataset.state = stateName;
    } else {
        delete elements.ss_provider_status.dataset.state;
    }
}

function providerPayload({ includeApiKey = true } = {}) {
    const payload = {
        protocol: elements.ss_provider_protocol.value,
        baseUrl: elements.ss_provider_base_url.value.trim(),
        model: elements.ss_provider_model.value.trim(),
        temperature: Number(elements.ss_provider_temperature.value),
        topP: Number(elements.ss_provider_top_p.value),
        topK: Number(elements.ss_provider_top_k.value),
        stop: elements.ss_provider_stop.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        contextTokens: Number(elements.ss_provider_context_tokens.value),
        maxTokens: Number(elements.ss_provider_max_tokens.value),
        jsonSchema: elements.ss_provider_json_schema.checked,
    };
    const apiKey = elements.ss_provider_api_key.value;
    if (includeApiKey && apiKey) payload.apiKey = apiKey;
    return payload;
}

function renderProviderProtocolHint() {
    const protocol = elements.ss_provider_protocol.value || 'openai-chat';
    elements.ss_provider_base_url.placeholder = PROVIDER_PLACEHOLDERS[protocol] || PROVIDER_PLACEHOLDERS['openai-chat'];
}

function renderProvider(provider) {
    state.provider = clone(provider || {});
    elements.ss_provider_protocol.value = provider?.protocol || 'openai-chat';
    renderProviderProtocolHint();
    elements.ss_provider_base_url.value = provider?.baseUrl || '';
    elements.ss_provider_model.value = provider?.model || '';
    elements.ss_provider_api_key.value = '';
    elements.ss_provider_temperature.value = Number.isFinite(Number(provider?.temperature))
        ? String(provider.temperature)
        : '0.7';
    elements.ss_provider_top_p.value = Number.isFinite(Number(provider?.topP))
        ? String(provider.topP)
        : '1';
    elements.ss_provider_top_k.value = Number.isFinite(Number(provider?.topK))
        ? String(provider.topK)
        : '0';
    elements.ss_provider_stop.value = Array.isArray(provider?.stop) ? provider.stop.join('\n') : '';
    elements.ss_provider_context_tokens.value = Number.isFinite(Number(provider?.contextTokens))
        ? String(provider.contextTokens)
        : '32768';
    elements.ss_provider_max_tokens.value = Number.isFinite(Number(provider?.maxTokens))
        ? String(provider.maxTokens)
        : '4096';
    elements.ss_provider_json_schema.checked = provider?.jsonSchema !== false;
    const masked = provider?.maskedApiKey ? `（${provider.maskedApiKey}）` : '';
    elements.ss_provider_key_state.textContent = provider?.hasApiKey ? `已保存${masked}` : '未保存';
}

async function loadProvider(openEpoch) {
    setProviderStatus('正在读取设置');
    const provider = await apiRequest('/api/provider');
    if (openEpoch !== providerOpenEpoch || elements.ss_provider_drawer.hidden) return null;
    renderProvider(provider);
    setProviderStatus('');
    return provider;
}

async function openProvider() {
    if (!elements.ss_provider_drawer.hidden) return;
    const openEpoch = ++providerOpenEpoch;
    providerLastFocus = document.activeElement;
    elements.ss_provider_scrim.hidden = false;
    elements.ss_provider_drawer.hidden = false;
    elements.story_studio_workspace.inert = true;
    elements.ss_open_provider.setAttribute('aria-expanded', 'true');
    elements.ss_close_provider.focus();
    try {
        const provider = await loadProvider(openEpoch);
        if (!provider || openEpoch !== providerOpenEpoch || elements.ss_provider_drawer.hidden) return;
        elements.ss_provider_base_url.focus();
    } catch (error) {
        if (openEpoch !== providerOpenEpoch || elements.ss_provider_drawer.hidden) return;
        setProviderStatus(error.message || '无法读取模型设置', 'error');
    }
}

function closeProvider() {
    if (elements.ss_provider_drawer.hidden) return;
    providerOpenEpoch += 1;
    elements.ss_provider_drawer.hidden = true;
    elements.ss_provider_scrim.hidden = true;
    elements.story_studio_workspace.inert = false;
    elements.ss_open_provider.setAttribute('aria-expanded', 'false');
    const focusTarget = providerLastFocus instanceof HTMLElement && providerLastFocus.isConnected
        ? providerLastFocus
        : elements.ss_open_provider;
    providerLastFocus = null;
    focusTarget.focus();
}

function providerFocusableElements() {
    return [...elements.ss_provider_drawer.querySelectorAll('button, input, select, textarea, [tabindex]')]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0);
}

function trapProviderFocus(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeProvider();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = providerFocusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

async function saveProvider(event) {
    event.preventDefault();
    if (!elements.ss_provider_form.reportValidity()) return;
    elements.ss_save_provider.disabled = true;
    elements.ss_test_provider.disabled = true;
    setProviderStatus('正在保存');
    try {
        const provider = await apiMutation('/api/provider', {
            method: 'PUT',
            body: providerPayload(),
        });
        renderProvider(provider);
        setProviderStatus('设置已保存', 'success');
    } catch (error) {
        setProviderStatus(error.message || '无法保存模型设置', 'error');
    } finally {
        elements.ss_save_provider.disabled = false;
        elements.ss_test_provider.disabled = false;
    }
}

async function testProvider() {
    if (!elements.ss_provider_form.reportValidity()) return;
    elements.ss_test_provider.disabled = true;
    elements.ss_save_provider.disabled = true;
    setProviderStatus('正在测试连接');
    try {
        const result = await apiMutation('/api/provider/test', {
            method: 'POST',
            body: providerPayload(),
        });
        setProviderStatus(result?.message || '模型连接正常', 'success');
    } catch (error) {
        setProviderStatus(error.message || '模型连接失败', 'error');
    } finally {
        elements.ss_test_provider.disabled = false;
        elements.ss_save_provider.disabled = false;
    }
}

async function clearProviderKey() {
    if (!window.confirm('清除服务端保存的 API 密钥？')) return;
    elements.ss_clear_provider_key.disabled = true;
    setProviderStatus('正在清除密钥');
    try {
        const provider = await apiMutation('/api/provider', {
            method: 'PUT',
            body: { apiKey: null },
        });
        renderProvider(provider);
        setProviderStatus('API 密钥已清除', 'success');
    } catch (error) {
        setProviderStatus(error.message || '无法清除 API 密钥', 'error');
    } finally {
        elements.ss_clear_provider_key.disabled = false;
    }
}

function closeDrawers(returnFocus = false) {
    const previous = state.drawer;
    state.drawer = null;
    elements.ss_binder.classList.remove('is-open');
    elements.ss_inspector.classList.remove('is-open');
    elements.ss_drawer_scrim.hidden = true;
    elements.ss_toggle_binder.setAttribute('aria-expanded', 'false');
    elements.ss_toggle_inspector.setAttribute('aria-expanded', 'false');
    syncResponsivePanels();
    if (returnFocus && previous === 'binder') elements.ss_toggle_binder.focus();
    if (returnFocus && previous === 'inspector') elements.ss_toggle_inspector.focus();
}

function toggleDrawer(drawer) {
    if (authorityMutationLocked()) return;
    if (!mobileMedia?.matches) return;
    if (state.drawer === drawer) {
        closeDrawers(true);
        return;
    }
    state.drawer = drawer;
    elements.ss_binder.classList.toggle('is-open', drawer === 'binder');
    elements.ss_inspector.classList.toggle('is-open', drawer === 'inspector');
    elements.ss_drawer_scrim.hidden = false;
    elements.ss_toggle_binder.setAttribute('aria-expanded', String(drawer === 'binder'));
    elements.ss_toggle_inspector.setAttribute('aria-expanded', String(drawer === 'inspector'));
    syncResponsivePanels();
    const panel = drawer === 'binder' ? elements.ss_binder : elements.ss_inspector;
    window.setTimeout(() => panel.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')?.focus(), 0);
}

function syncResponsivePanels() {
    if (!mobileMedia) return;
    const mobile = mobileMedia.matches;
    const authorityLocked = authorityMutationLocked();
    const inspectorUnavailable = ['today', 'resources', 'workflow', 'quality'].includes(state.view);
    if (!mobile && state.drawer) closeDrawers();
    elements.ss_binder.inert = authorityLocked || mobile && state.drawer !== 'binder';
    elements.ss_inspector.inert = authorityLocked || inspectorUnavailable || mobile && state.drawer !== 'inspector';
    if (mobile && state.drawer !== 'binder') {
        elements.ss_binder.setAttribute('aria-hidden', 'true');
    } else {
        elements.ss_binder.removeAttribute('aria-hidden');
    }
    if (inspectorUnavailable || mobile && state.drawer !== 'inspector') {
        elements.ss_inspector.setAttribute('aria-hidden', 'true');
    } else {
        elements.ss_inspector.removeAttribute('aria-hidden');
    }
}

function visibleFocusableElements() {
    const scope = state.drawer === 'binder'
        ? elements.ss_binder
        : state.drawer === 'inspector'
            ? elements.ss_inspector
            : elements.story_studio_workspace;
    return [...scope.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
        .filter(element => !element.disabled
            && element.tabIndex >= 0
            && !element.closest('[hidden], [inert]')
            && element.getClientRects().length > 0);
}

function focusIfVisible(element) {
    if (!(element instanceof HTMLElement)
        || !element.isConnected
        || element.closest('[hidden], [inert]')
        || element.getClientRects().length === 0) {
        return false;
    }
    element.focus();
    return document.activeElement === element;
}

function handleTablistKeydown(event, tabs, activate) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex === -1) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
            ? tabs.length - 1
            : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    activate(next);
    next.focus();
}

function trapWorkspaceFocus(event) {
    if (event.key === 'Escape') {
        if (state.drawer) {
            event.preventDefault();
            closeDrawers(true);
        }
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = visibleFocusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function bindDataInputs() {
    for (const input of elements.projectFields) {
        input.addEventListener('input', () => {
            if (!state.project) return;
            const field = input.dataset.projectField;
            if (input.type === 'number') {
                if (!input.value || !input.validity.valid) return;
                state.project[field] = Number(input.value);
            } else {
                state.project[field] = input.value;
            }
            markProjectDirty(field);
            if (field === 'title' || field === 'genre') {
                upsertProjectSummary(state.project);
                renderProjectSelect();
            }
            if (field === 'targetWords') renderMetrics();
        });
        if (input.type === 'number') {
            input.addEventListener('blur', () => {
                if (!input.value || !input.validity.valid) {
                    input.value = state.project?.[input.dataset.projectField] ?? '';
                }
            });
        }
    }

    for (const input of elements.storyFields) {
        input.addEventListener('input', () => {
            if (!state.project) return;
            state.project.story[input.dataset.storyField] = input.value;
            markProjectDirty(`story.${input.dataset.storyField}`);
        });
    }

    for (const input of elements.cardFields) {
        input.addEventListener('input', () => {
            if (!state.chapter) return;
            state.chapter.card[input.dataset.cardField] = input.value;
            markChapterDirty(`card.${input.dataset.cardField}`);
        });
    }

    for (const input of elements.volumeFields) {
        input.addEventListener('input', () => {
            const volume = selectedVolume();
            if (!volume) return;
            const field = input.dataset.volumeField;
            volume[field] = input.value;
            markVolumeDirty(field);
            if (field === 'title') {
                for (const select of [elements.ss_volume_outline_select, elements.ss_chapter_volume]) {
                    const option = [...select.options].find(item => item.value === volume.id);
                    if (option) option.textContent = `${volume.number}. ${volume.title || `第${volume.number}卷`}`;
                }
                renderChapterList();
                renderCard();
                const currentVolume = volumeForChapter(state.project, state.chapter);
                if (currentVolume?.id === volume.id && state.chapter) {
                    elements.ss_editor_breadcrumb.textContent = `${volume.title || `第${volume.number}卷`} / 第${state.chapter.number}章`;
                }
            }
        });
    }
}

function bindEvents() {
    elements.ss_dashboard_refresh.addEventListener('click', () => void loadDashboardWorkspace());
    elements.ss_dashboard_retry.addEventListener('click', () => void loadDashboardWorkspace());
    elements.ss_today_view.addEventListener('click', event => {
        const button = event.target.closest('[data-dashboard-view]');
        if (!button || button.disabled) return;
        void navigateDashboardTarget({
            view: button.dataset.dashboardView,
            chapterId: button.dataset.dashboardChapterId,
            volumeId: button.dataset.dashboardVolumeId,
            promiseId: button.dataset.dashboardPromiseId,
        });
    });
    elements.ss_new_project.addEventListener('click', () => showCreateForm(elements.ss_create_project_form.hidden));
    elements.ss_empty_create.addEventListener('click', () => showCreateForm(true));
    elements.ss_cancel_create.addEventListener('click', () => showCreateForm(false));
    elements.ss_create_project_form.addEventListener('submit', createProject);
    elements.ss_project_select.addEventListener('change', event => void switchProject(event.target.value));
    elements.ss_add_volume.addEventListener('click', () => void createVolume());
    elements.ss_add_chapter.addEventListener('click', () => void createChapter());
    elements.ss_chapter_search.addEventListener('input', renderChapterList);
    elements.ss_chapter_list.addEventListener('click', event => {
        const toggle = event.target.closest('[data-volume-toggle]');
        if (toggle) {
            const volumeId = toggle.dataset.volumeToggle;
            if (state.collapsedVolumeIds.has(volumeId)) {
                state.collapsedVolumeIds.delete(volumeId);
            } else {
                state.collapsedVolumeIds.add(volumeId);
            }
            renderChapterList();
            volumeActionFocus(volumeId)?.focus();
            return;
        }
        const volumeAction = event.target.closest('[data-volume-action]');
        if (volumeAction) {
            const volumeId = volumeAction.dataset.volumeActionId;
            const action = volumeAction.dataset.volumeAction;
            if (action === 'add-chapter') {
                void createChapter(volumeId);
            } else if (action === 'edit') {
                void editVolume(volumeId);
            } else if (action === 'delete') {
                void deleteVolume(volumeId);
            } else {
                void reorderVolume(volumeId, action);
            }
            return;
        }
        const action = event.target.closest('[data-chapter-action]');
        if (action) {
            const chapterId = action.dataset.chapterActionId;
            if (action.dataset.chapterAction === 'delete') {
                void deleteChapter(chapterId);
            } else {
                void reorderChapter(chapterId, action.dataset.chapterAction);
            }
            return;
        }
        const button = event.target.closest('[data-chapter-id]');
        if (button) void loadChapter(button.dataset.chapterId);
    });

    elements.ss_chapter_title.addEventListener('input', () => {
        if (!state.chapter) return;
        state.chapter.title = elements.ss_chapter_title.value;
        const summary = state.project?.chapters?.find(chapter => chapter.id === state.chapter.id);
        if (summary) summary.title = state.chapter.title;
        markChapterDirty('title');
        renderChapterList();
    });
    elements.ss_chapter_volume.addEventListener('change', () => {
        if (!state.chapter) return;
        const targetVolumeId = elements.ss_chapter_volume.value;
        if (!targetVolumeId || targetVolumeId === state.chapter.volumeId) return;
        void moveChapterToVolume(state.chapter.id, targetVolumeId);
    });
    elements.ss_chapter_status.addEventListener('change', () => {
        if (!state.chapter) return;
        state.chapter.status = elements.ss_chapter_status.value;
        const summary = state.project?.chapters?.find(chapter => chapter.id === state.chapter.id);
        if (summary) summary.status = state.chapter.status;
        markChapterDirty('status');
        renderChapterList();
    });
    elements.ss_manuscript.addEventListener('input', () => {
        if (!state.chapter) return;
        state.chapter.content = elements.ss_manuscript.value;
        const wordCount = countContentUnits(state.chapter.content);
        const summary = state.project?.chapters?.find(chapter => chapter.id === state.chapter.id);
        if (summary) summary.wordCount = wordCount;
        markChapterDirty('content');
        renderChapterCount();
        renderMetrics();
        if (state.qualityPreview) {
            state.qualityPreview = null;
            if (state.view === 'quality') renderQualityWorkspace();
        }
        if (state.selectionBaseline) renderCandidateActions();
    });
    elements.ss_volume_outline_select.addEventListener('change', () => {
        void editVolume(elements.ss_volume_outline_select.value);
    });
    elements.ss_volume_move_up.addEventListener('click', () => {
        if (state.selectedVolumeId) void reorderVolume(state.selectedVolumeId, 'up', 'bible');
    });
    elements.ss_volume_move_down.addEventListener('click', () => {
        if (state.selectedVolumeId) void reorderVolume(state.selectedVolumeId, 'down', 'bible');
    });
    elements.ss_volume_delete.addEventListener('click', () => {
        if (state.selectedVolumeId) void deleteVolume(state.selectedVolumeId, 'bible');
    });
    elements.ss_chapter_notes.addEventListener('input', () => {
        if (!state.chapter) return;
        state.chapter.notes = elements.ss_chapter_notes.value;
        markChapterDirty('notes');
    });
    elements.ss_review_record.addEventListener('input', () => {
        if (!state.chapter) return;
        state.chapter.review = elements.ss_review_record.value;
        markChapterDirty('review');
    });
    elements.ss_candidate.addEventListener('input', () => {
        if (!state.chapter) return;
        state.generationRequestSerial += 1;
        const displayed = currentCandidate();
        if (state.activeGeneration) {
            state.activeGeneration = null;
            state.selectedGenerationId = '';
            state.selectionBaseline = null;
        }
        const previous = state.chapter.candidate || displayed || {};
        state.chapter.candidate = {
            kind: displayed.kind || previous.kind || state.aiKind,
            content: elements.ss_candidate.value,
            createdAt: displayed.createdAt || previous.createdAt || new Date().toISOString(),
        };
        markCandidateDirty();
        elements.ss_candidate_label.textContent = AI_LABELS[state.chapter.candidate.kind] || '候选稿';
        elements.ss_candidate_time.textContent = formatDate(state.chapter.candidate.createdAt);
        renderCandidateActions();
        renderGenerationControls();
    });

    for (const button of elements.viewTabs) {
        button.addEventListener('click', () => setView(button.dataset.ssView));
        button.addEventListener('keydown', event => handleTablistKeydown(
            event,
            elements.viewTabs,
            next => setView(next.dataset.ssView),
        ));
    }
    const copilotSelectionChanged = event => {
        const input = event.target.closest('input[data-copilot-selection-kind][data-copilot-selection-id]');
        if (!input) return;
        const selected = state.copilotSelection[input.dataset.copilotSelectionKind];
        if (!(selected instanceof Set)) return;
        if (input.checked) selected.add(input.dataset.copilotSelectionId);
        else selected.delete(input.dataset.copilotSelectionId);
        state.copilotSelectionCustomized = true;
        invalidateCopilotPreview();
        elements.ss_copilot_context_digest.textContent = '';
        renderCopilotEvidence();
        renderCopilotActionState();
    };
    for (const container of [
        elements.ss_copilot_volume_options,
        elements.ss_copilot_chapter_options,
        elements.ss_copilot_entity_options,
        elements.ss_copilot_lorebook_options,
    ]) container.addEventListener('change', copilotSelectionChanged);
    elements.ss_copilot_anchor_chapter.addEventListener('change', () => {
        state.copilotAnchorChapterId = elements.ss_copilot_anchor_chapter.value;
        state.copilotSelectionCustomized = true;
        invalidateCopilotPreview();
        elements.ss_copilot_context_digest.textContent = '';
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_retrieval_query.addEventListener('input', () => {
        state.copilotRetrievalQuery = elements.ss_copilot_retrieval_query.value;
        invalidateCopilotPreview();
        elements.ss_copilot_context_digest.textContent = '';
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_retrieval_limit.addEventListener('change', () => {
        state.copilotRetrievalLimit = Math.max(1, Math.min(100, Number(elements.ss_copilot_retrieval_limit.value) || 20));
        elements.ss_copilot_retrieval_limit.value = String(state.copilotRetrievalLimit);
        invalidateCopilotPreview();
        elements.ss_copilot_context_digest.textContent = '';
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_preview.addEventListener('click', () => void previewCopilotContext());
    elements.ss_copilot_evidence_list.addEventListener('change', event => {
        const input = event.target.closest('input[data-copilot-evidence-id]');
        if (!input) return;
        if (input.checked) state.copilotSelectedEvidenceIds.add(input.dataset.copilotEvidenceId);
        else state.copilotSelectedEvidenceIds.delete(input.dataset.copilotEvidenceId);
        renderCopilotActionState();
    });
    elements.ss_copilot_evidence_defaults.addEventListener('click', () => {
        state.copilotSelectedEvidenceIds = new Set((state.copilotPreview?.evidenceCatalog || [])
            .filter(record => record.selectedByDefault)
            .map(record => record.evidenceId));
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_evidence_all.addEventListener('click', () => {
        state.copilotSelectedEvidenceIds = new Set((state.copilotPreview?.evidenceCatalog || [])
            .map(record => record.evidenceId));
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_evidence_none.addEventListener('click', () => {
        state.copilotSelectedEvidenceIds = new Set();
        renderCopilotEvidence();
        renderCopilotActionState();
    });
    elements.ss_copilot_profile.addEventListener('change', () => {
        state.copilotProfileValue = elements.ss_copilot_profile.value;
    });
    elements.ss_copilot_model_mode.addEventListener('click', event => {
        const button = event.target.closest('[data-copilot-model-mode]');
        if (!button) return;
        state.copilotSettingsMode = button.dataset.copilotModelMode;
        renderCopilotControls();
        renderCopilotActionState();
    });
    elements.ss_copilot_model.addEventListener('input', () => {
        state.copilotSettingsModel = elements.ss_copilot_model.value;
        renderCopilotActionState();
    });
    elements.ss_copilot_save_model.addEventListener('click', () => void saveCopilotSettings());
    elements.ss_copilot_test_model.addEventListener('click', () => void testCopilotSettings());
    elements.ss_copilot_instruction.addEventListener('input', () => {
        state.copilotInstruction = elements.ss_copilot_instruction.value;
    });
    const setCopilotOptionCount = value => {
        state.copilotOptionCount = Math.max(3, Math.min(6, Number(value) || 3));
        elements.ss_copilot_option_count.value = String(state.copilotOptionCount);
        renderCopilotActionState();
    };
    elements.ss_copilot_option_count.addEventListener('change', () => setCopilotOptionCount(elements.ss_copilot_option_count.value));
    elements.ss_copilot_option_decrease.addEventListener('click', () => setCopilotOptionCount(state.copilotOptionCount - 1));
    elements.ss_copilot_option_increase.addEventListener('click', () => setCopilotOptionCount(state.copilotOptionCount + 1));
    elements.ss_copilot_create_session.addEventListener('click', () => void createCopilotSession());
    elements.ss_copilot_session.addEventListener('change', () => {
        const sessionId = elements.ss_copilot_session.value;
        if (sessionId && sessionId !== state.copilotSessionId) void loadCopilotSession(sessionId);
    });
    elements.ss_copilot_refresh.addEventListener('click', () => void loadCopilotWorkspace());
    elements.ss_copilot_generate.addEventListener('click', () => void generateCopilotSession());
    elements.ss_copilot_cancel.addEventListener('click', () => void cancelCopilotGeneration());
    elements.ss_copilot_retry.addEventListener('click', retryCopilotGeneration);
    elements.ss_copilot_copy.addEventListener('click', copyCopilotArtifact);
    elements.ss_copilot_export.addEventListener('click', exportCopilotArtifact);
    elements.ss_copilot_directions.addEventListener('click', event => {
        const startButton = event.target.closest('[data-copilot-start-workflow]');
        if (startButton && !startButton.disabled) {
            void startWorkflowFromCopilot(startButton.dataset.copilotStartWorkflow);
            return;
        }
        const copyButton = event.target.closest('[data-copilot-copy-direction]');
        if (!copyButton) return;
        const option = copilotArtifact()?.plotOptions?.find(item => item.id === copyButton.dataset.copilotCopyDirection);
        if (option) void copyText(copilotDirectionCopyText(option), '方向已复制');
    });
    elements.ss_quality_profile_catalog.addEventListener('click', event => {
        const button = event.target.closest('[data-quality-profile-id]');
        if (!button || button.dataset.qualityProfileId === state.qualityProfileId) return;
        void loadQualityProfileDetail(button.dataset.qualityProfileId);
    });
    elements.ss_quality_overlay_catalog.addEventListener('click', event => {
        const button = event.target.closest('[data-quality-overlay-id]');
        if (!button) return;
        state.qualityOverlayId = button.dataset.qualityOverlayId;
        renderQualityWorkspace();
    });
    elements.ss_quality_copy_overlay.addEventListener('change', () => {
        state.qualityOverlayId = elements.ss_quality_copy_overlay.value || 'none';
        renderQualityWorkspace();
    });
    elements.ss_quality_copy_profile.addEventListener('click', () => void copyQualityProfile());
    elements.ss_quality_preview.addEventListener('click', () => void previewCurrentChapterQuality());
    elements.ss_quality_save_report.addEventListener('click', () => void saveCurrentChapterQualityReport());
    elements.ss_quality_refresh_reports.addEventListener('click', () => void loadQualityReports());
    elements.ss_quality_report_select.addEventListener('change', () => {
        state.qualityReportId = elements.ss_quality_report_select.value;
        state.qualityReport = null;
        renderQualityWorkspace();
    });
    elements.ss_quality_open_report.addEventListener('click', () => void openQualityReport());
    elements.ss_quality_run_regression.addEventListener('click', () => void runFixedQualityRegression());
    elements.ss_quality_run_select.addEventListener('change', () => {
        state.qualityRunId = elements.ss_quality_run_select.value;
        state.qualityRun = null;
        state.qualityComparison = null;
        renderQualityWorkspace();
    });
    elements.ss_quality_open_run.addEventListener('click', () => void openQualityRun());
    elements.ss_quality_compare_baseline.addEventListener('click', () => void compareQualityRunToBaseline());
    elements.ss_quality_refresh.addEventListener('click', () => void loadQualityWorkspace());
    elements.ss_quality_retry.addEventListener('click', retryQualityAction);
    elements.ss_workflow_definition.addEventListener('change', () => {
        state.workflowDefinitionId = elements.ss_workflow_definition.value;
        renderWorkflowWorkspace();
    });
    elements.ss_workflow_run.addEventListener('change', () => {
        const runId = elements.ss_workflow_run.value;
        if (runId && runId !== state.workflowRunId) void loadWorkflowRun(runId);
    });
    elements.ss_workflow_artifact_select.addEventListener('change', () => {
        state.workflowArtifactId = elements.ss_workflow_artifact_select.value;
        renderWorkflowCurrent();
        renderWorkflowEvidence();
        renderWorkflowArtifacts();
    });
    elements.ss_workflow_new_run.addEventListener('click', () => void createWorkflowRun());
    elements.ss_workflow_refresh.addEventListener('click', () => void loadWorkflowWorkspace());
    elements.ss_workflow_execute.addEventListener('click', executeCurrentWorkflowStep);
    elements.ss_workflow_approve.addEventListener('click', approveCurrentWorkflowArtifact);
    elements.ss_workflow_apply.addEventListener('click', applyCurrentWorkflowArtifact);
    elements.ss_workflow_cancel.addEventListener('click', () => void cancelWorkflowRun());
    elements.ss_workflow_retry.addEventListener('click', retryWorkflowAction);
    for (const button of elements.inspectorTabs) {
        button.addEventListener('click', () => setInspector(button.dataset.ssInspector));
        button.addEventListener('keydown', event => handleTablistKeydown(
            event,
            elements.inspectorTabs,
            next => setInspector(next.dataset.ssInspector),
        ));
    }
    elements.ss_refresh_versions.addEventListener('click', () => void refreshVersionHistory({
        selectId: state.selectedVersionId,
    }));
    elements.ss_versions_list.addEventListener('click', event => {
        const button = event.target.closest('[data-version-id]');
        if (!button || button.dataset.versionId === state.selectedVersionId && state.selectedVersion) return;
        void loadVersionSelection(button.dataset.versionId, { focusVersionId: button.dataset.versionId });
    });
    elements.ss_restore_version.addEventListener('click', () => void restoreSelectedVersion());
    for (const button of elements.aiTabs) {
        button.addEventListener('click', () => {
            state.aiKind = button.dataset.ssAi;
            state.generationPreview = null;
            renderInspectorState();
            renderContextPreview();
        });
    }

    elements.ss_continuity_tabs.addEventListener('click', event => {
        const button = event.target.closest('[data-continuity-view]');
        if (!button || !(button.dataset.continuityView in CONTINUITY_VIEW_LABELS)) return;
        state.continuityView = button.dataset.continuityView;
        state.continuityRecordId = '';
        persistWorkspaceResumeState();
        renderStoryState();
    });
    elements.ss_continuity_records.addEventListener('click', event => {
        const chapterButton = event.target.closest('[data-continuity-chapter-id]');
        if (chapterButton) {
            void jumpToContinuityChapter(chapterButton.dataset.continuityChapterId);
            return;
        }
        const pendingButton = event.target.closest('[data-pending-upsert-category][data-pending-upsert-id]');
        if (pendingButton) {
            addRecordToPendingChangeSet(
                pendingButton.dataset.pendingUpsertCategory,
                pendingButton.dataset.pendingUpsertId,
            );
        }
    });
    elements.ss_pending_changeset_json.addEventListener('input', () => {
        state.pendingChangeSetDraft = elements.ss_pending_changeset_json.value;
        state.pendingChangeSetDirty = state.pendingChangeSetDraft !== state.pendingChangeSetSaved;
        state.pendingChangeSetError = '';
        renderPendingChangeSet();
    });
    elements.ss_adopt_pending_changeset.addEventListener('click', () => void adoptPendingChangeSet());
    elements.ss_save_pending_changeset.addEventListener('click', savePendingChangeSet);
    elements.ss_revert_pending_changeset.addEventListener('click', revertPendingChangeSet);
    elements.ss_clear_pending_changeset.addEventListener('click', clearPendingChangeSet);
    elements.ss_copy_pending_changeset.addEventListener('click', () => void copyPendingChangeSet());
    elements.ss_resource_list.addEventListener('click', event => {
        const button = event.target.closest('[data-resource-id]');
        if (button) void loadResourceDetail(button.dataset.resourceType, button.dataset.resourceId);
    });
    elements.ss_resource_list.addEventListener('change', event => void handleResourceActivation(event.target));
    elements.ss_import_resource.addEventListener('click', () => elements.ss_resource_import_file.click());
    elements.ss_resource_import_file.addEventListener('change', () => {
        const file = elements.ss_resource_import_file.files?.[0];
        elements.ss_resource_import_file.value = '';
        void importResourceFile(file);
    });
    elements.ss_resource_instruction_enabled.addEventListener('change', () => void toggleCharacterInstruction());
    for (const button of elements.profileTabs) {
        button.addEventListener('click', () => setProfileEditorTab(button.dataset.profileTab));
        button.addEventListener('keydown', event => handleTablistKeydown(
            event,
            elements.profileTabs,
            next => setProfileEditorTab(next.dataset.profileTab),
        ));
    }
    elements.ss_profile_editor.addEventListener('input', event => updateProfileEditorField(event.target));
    for (const input of [
        elements.ss_profile_preview_task,
        elements.ss_profile_preview_tokens,
        elements.ss_profile_preview_characters,
        elements.ss_profile_preview_variables,
    ]) {
        input.addEventListener('input', () => {
            state.profileCompileResult = null;
            state.profileCompileError = '';
            renderProfileCompileResult();
        });
    }
    elements.ss_profile_revert.addEventListener('click', revertProfileEditor);
    elements.ss_profile_save.addEventListener('click', () => void saveProfileEditor());
    elements.ss_profile_compile.addEventListener('click', compileCurrentProfile);
    elements.ss_delete_resource.addEventListener('click', () => void deleteSelectedResource());

    elements.ss_generate.addEventListener('click', () => void generateCandidate());
    elements.ss_generation_history.addEventListener('change', () => {
        const generationId = elements.ss_generation_history.value;
        const requestSerial = ++state.generationRequestSerial;
        state.selectedGenerationId = generationId;
        state.activeGeneration = null;
        state.generationDiagnostics = null;
        state.selectionBaseline = null;
        renderCandidate();
        if (!generationId) {
            return;
        }
        void loadGenerationSelection(generationId, { requestSerial }).catch(error => {
            showToast(error.message || '无法载入候选', 5000);
        });
    });
    elements.ss_generation_instruction.addEventListener('input', () => {
        invalidateContextPreview();
    });
    elements.ss_context_overrides.addEventListener('change', event => {
        const retrievalSelect = event.target.closest('select[data-retrieval-override-id]');
        if (retrievalSelect) {
            setRetrievalOverride(retrievalSelect.dataset.retrievalOverrideId, retrievalSelect.value);
            return;
        }
        const select = event.target.closest('select[data-context-override-type]');
        if (!select) return;
        if (!setContextOverride(select.dataset.contextOverrideType, select.dataset.contextOverrideId, select.value)) {
            renderContextOverrides();
            return;
        }
        invalidateContextPreview();
        renderContextOverrides();
    });
    elements.ss_clear_retrieval_overrides.addEventListener('click', () => {
        state.retrievalOverrides = emptyRetrievalOverrides();
        invalidateContextPreview();
        renderContextOverrides();
    });
    elements.ss_retrieval_rerank.addEventListener('change', () => {
        invalidateContextPreview();
    });
    elements.ss_generation_preview.addEventListener('click', () => void previewGeneration());
    elements.ss_retrieval_preview.addEventListener('click', () => void previewRetrieval());
    elements.ss_close_context_preview.addEventListener('click', () => {
        invalidateContextPreview();
        elements.ss_inspector.scrollTop = 0;
        elements.ss_generation_preview.focus();
    });
    elements.ss_context_retrieval.addEventListener('click', event => {
        const chapterButton = event.target.closest('[data-retrieval-chapter-id]');
        if (chapterButton) void jumpToContinuityChapter(chapterButton.dataset.retrievalChapterId);
    });
    elements.ss_context_retrieval.addEventListener('change', event => {
        const select = event.target.closest('select[data-retrieval-override-id]');
        if (select) setRetrievalOverride(select.dataset.retrievalOverrideId, select.value);
    });
    elements.ss_generation_regenerate.addEventListener('click', () => {
        if (state.activeGeneration) void startGeneration('regenerate', clone(state.activeGeneration));
    });
    elements.ss_generation_continue.addEventListener('click', () => {
        if (state.activeGeneration?.kind === 'draft') void startGeneration('continue', clone(state.activeGeneration));
    });
    elements.ss_candidate_actions.addEventListener('click', event => {
        const button = event.target.closest('[data-candidate-action]');
        if (button) void handleCandidateAction(button.dataset.candidateAction);
    });

    elements.ss_save.addEventListener('click', async () => {
        const saved = await enqueueSave();
        if (saved) showToast('已保存');
    });
    elements.ss_export.addEventListener('click', () => void exportProject());
    elements.ss_import.addEventListener('click', () => elements.ss_import_file.click());
    elements.ss_import_file.addEventListener('change', () => void importProject(elements.ss_import_file.files?.[0]));
    elements.ss_open_provider.addEventListener('click', () => void openProvider());
    elements.ss_close_provider.addEventListener('click', closeProvider);
    elements.ss_provider_scrim.addEventListener('click', closeProvider);
    elements.ss_provider_drawer.addEventListener('keydown', trapProviderFocus);
    elements.ss_provider_form.addEventListener('submit', saveProvider);
    elements.ss_provider_protocol.addEventListener('change', renderProviderProtocolHint);
    elements.ss_test_provider.addEventListener('click', () => void testProvider());
    elements.ss_clear_provider_key.addEventListener('click', () => void clearProviderKey());
    elements.ss_retry_bootstrap.addEventListener('click', () => void bootstrapApplication());
    elements.ss_toggle_binder.addEventListener('click', () => toggleDrawer('binder'));
    elements.ss_toggle_inspector.addEventListener('click', () => toggleDrawer('inspector'));
    elements.ss_drawer_scrim.addEventListener('click', () => closeDrawers(true));
    elements.story_studio_workspace.addEventListener('keydown', trapWorkspaceFocus);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persistLifecycleRecoveryDraft();
    });
    window.addEventListener('pagehide', persistLifecycleRecoveryDraft);
    window.addEventListener('beforeunload', event => {
        if (!state.projectDirty && !state.volumeDirty && !state.chapterDirty && !state.pendingChangeSetDirty
            && !state.profileEditorDirty
            && !state.saveInFlight && !state.structureBusy && !state.resourceBusy && !state.versionRestoring
            && !state.copilotBusy && !state.copilotGenerating && !state.copilotCancelling
            && !state.qualityBusy
            && state.mutationInFlight === 0) return;
        event.preventDefault();
        event.returnValue = '';
    });

    bindDataInputs();
}

function mountWorkspace() {
    cacheElements();
    const workspace = elements.story_studio_workspace;
    elements.projectFields = [...workspace.querySelectorAll('[data-project-field]')];
    elements.storyFields = [...workspace.querySelectorAll('[data-story-field]')];
    elements.volumeFields = [...workspace.querySelectorAll('[data-volume-field]')];
    elements.cardFields = [...workspace.querySelectorAll('[data-card-field]')];
    elements.viewTabs = [...workspace.querySelectorAll('[data-ss-view]')];
    elements.inspectorTabs = [...workspace.querySelectorAll('[data-ss-inspector]')];
    elements.aiTabs = [...workspace.querySelectorAll('[data-ss-ai]')];
    elements.profileTabs = [...workspace.querySelectorAll('[data-profile-tab]')];
    elements.profilePanels = [...workspace.querySelectorAll('[data-profile-panel]')];
    elements.profileFields = [
        elements.ss_profile_name,
        elements.ss_profile_token_budget,
        elements.ss_profile_character_budget,
        elements.ss_profile_generation,
        elements.ss_profile_modules,
        elements.ss_profile_order,
        elements.ss_profile_variables,
        elements.ss_profile_variable_values,
        elements.ss_profile_generation_policies,
        elements.ss_profile_task_policies,
        elements.ss_profile_preview_task,
        elements.ss_profile_preview_tokens,
        elements.ss_profile_preview_characters,
        elements.ss_profile_preview_variables,
    ];

    mobileMedia = window.matchMedia('(max-width: 820px)');
    mobileMedia.addEventListener('change', syncResponsivePanels);
    bindEvents();
    renderProjectData();
}

async function bootstrapApplication() {
    elements.ss_retry_bootstrap.disabled = true;
    state.bootstrapFailed = false;
    setSaveStatus('正在连接', 'saving');
    try {
        const resume = readWorkspaceResumeState();
        state.workspaceResumeHydrating = true;
        const bootstrap = await apiRequest('/api/bootstrap');
        if (!bootstrap?.csrfToken || typeof bootstrap.csrfToken !== 'string') {
            throw new Error('服务端没有返回有效的 CSRF token');
        }
        state.csrfToken = bootstrap.csrfToken;
        try {
            renderProvider(await apiRequest('/api/provider'));
        } catch {
            state.provider = null;
        }
        await loadProjects(resume?.projectId || state.project?.id || '', resume?.chapterId || '');
        state.workspaceResumeHydrating = false;
        restoreWorkspaceResumeState(resume);
        state.bootstrapFailed = false;
        renderEmptyState();
    } catch (error) {
        state.workspaceResumeHydrating = false;
        state.bootstrapFailed = true;
        state.project = null;
        state.chapter = null;
        bindCopilotWorkspace(null, null);
        bindWorkflowWorkspace(null, null);
        bindQualityWorkspace(null, null);
        state.projectBase = null;
        state.chapterBase = null;
        state.volumeBase = null;
        state.selectedVolumeId = '';
        state.collapsedVolumeIds.clear();
        elements.ss_bootstrap_error_message.textContent = error.message || '本地服务暂时不可用。';
        setSaveStatus('连接失败', 'error');
        renderProjectData();
    } finally {
        elements.ss_retry_bootstrap.disabled = false;
    }
}

export async function init() {
    if (state.initialized) return;
    state.initialized = true;
    try {
        mountWorkspace();
        await workspaceRecoveryWriterLeaseReady;
        await bootstrapApplication();
    } catch (error) {
        state.initialized = false;
        console.error('Story Studio failed to initialize:', error);
    }
}

void init();
