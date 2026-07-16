const DASHBOARD_VIEW_ALIASES = Object.freeze({
    today: 'today',
    editor: 'write',
    write: 'write',
    bible: 'bible',
    settings: 'bible',
    ledger: 'ledger',
    copilot: 'copilot',
    workflow: 'workflow',
    quality: 'quality',
    resources: 'resources',
});

const CONTINUITY_VIEWS = new Set([
    'facts',
    'knowledge',
    'timeline',
    'relations',
    'promises',
    'events',
]);

function identifier(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reduces the asynchronous dashboard lifecycle to one renderable state.
 * Keeping this deterministic prevents stale data, loading, and error surfaces
 * from being shown at the same time.
 */
export function dashboardViewMode({
    projectId = '',
    dashboard = null,
    loading = false,
    error = '',
} = {}) {
    if (!identifier(projectId)) return 'no-project';
    if (loading) return 'loading';
    if (identifier(error)) return 'error';
    if (dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard)) return 'ready';
    return 'empty';
}

/**
 * Converts a Dashboard V1 target into one of StoryStudio's real top-level
 * workspaces. Server-side "editor" targets intentionally map to "write".
 */
export function dashboardNavigationTarget(source = {}, overrideView = '') {
    const requestedView = identifier(overrideView || source.view);
    const view = DASHBOARD_VIEW_ALIASES[requestedView];
    if (!view) return null;
    return {
        view,
        chapterId: identifier(source.chapterId),
        volumeId: identifier(source.volumeId),
        promiseId: identifier(source.promiseId),
    };
}

/**
 * Validates the small, non-authoritative browser session used to resume the
 * same workspace after a refresh. Project data and workflow state still come
 * from the server; this record only remembers where the author was looking.
 */
export function normalizeWorkspaceResumeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
    const projectId = identifier(value.projectId);
    const view = DASHBOARD_VIEW_ALIASES[identifier(value.view)];
    if (!projectId || !view) return null;
    const continuityView = CONTINUITY_VIEWS.has(identifier(value.continuityView))
        ? identifier(value.continuityView)
        : 'facts';
    return {
        version: 1,
        projectId,
        chapterId: identifier(value.chapterId),
        view,
        workflowRunId: identifier(value.workflowRunId),
        copilotSessionId: identifier(value.copilotSessionId),
        continuityView,
        continuityRecordId: continuityView === 'promises'
            ? identifier(value.continuityRecordId)
            : '',
    };
}
