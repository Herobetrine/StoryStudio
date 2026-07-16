function identifier(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function unavailable(code, reason) {
    return { eligible: false, code, reason };
}

/**
 * Returns the chapter-scoped material that a fresh Copilot workspace should
 * select automatically. The caller owns any Set conversion and UI state.
 */
export function copilotDefaultBinding(project, chapter) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
    const requestedId = identifier(chapter?.id);
    const selectedChapter = chapters.find(item => item.id === requestedId) || chapters[0] || null;
    const chapterId = identifier(selectedChapter?.id);
    const volumeId = identifier(selectedChapter?.volumeId);
    return {
        anchorChapterId: chapterId,
        volumeIds: volumeId ? [volumeId] : [],
        chapterIds: chapterId ? [chapterId] : [],
    };
}

/**
 * A session is stale as soon as its immutable project snapshot no longer
 * matches the current authoritative project version.
 */
export function copilotSessionAuthorityStale(session, project) {
    if (!session || !project) return Boolean(session);
    return Boolean(session.stale)
        || identifier(session.projectId) !== identifier(project.id)
        || identifier(session.base?.projectId) !== identifier(project.id)
        || session.base?.projectVersion !== project.version;
}

/**
 * Reduces all client-visible handoff invariants to one result. Workflow V2
 * performs the same checks again on the server; this helper prevents presenting
 * a button that the authoritative endpoint must reject.
 */
export function copilotHandoffEligibility({
    project = null,
    chapter = null,
    session = null,
    artifact = null,
} = {}) {
    if (!identifier(project?.id)) return unavailable('missing-project', '请先打开作品');
    if (!identifier(chapter?.id)) return unavailable('missing-chapter', '请先打开目标章节');
    if (!session) return unavailable('missing-session', '请先选择策划会话');
    if (session.status !== 'ready') return unavailable('session-not-ready', '策划会话尚未生成可交接方向');
    if (copilotSessionAuthorityStale(session, project)) {
        return unavailable('session-stale', '作品内容已变化，请重新预览并生成策划方向');
    }
    if (!artifact) return unavailable('missing-artifact', '策划会话缺少候选包');

    const projectId = identifier(project.id);
    const chapterId = identifier(chapter.id);
    const base = session.base || {};
    const artifactBase = artifact.base || {};
    if (identifier(session.projectId) !== projectId || identifier(base.projectId) !== projectId) {
        return unavailable('project-mismatch', '策划会话不属于当前作品');
    }
    if (base.projectVersion !== project.version) {
        return unavailable('project-version-mismatch', '策划会话基于旧作品版本');
    }
    if (!identifier(base.anchorChapterId)) {
        return unavailable('missing-anchor', '这是项目级策划，没有章节锚点，只能复制或导出');
    }
    if (identifier(base.anchorChapterId) !== chapterId) {
        return unavailable('chapter-mismatch', '该方向锚定了另一章节，请先打开锚点章节');
    }
    if (base.anchorChapterRevision !== chapter.revision) {
        return unavailable('chapter-revision-mismatch', '锚点章节已变化，请重新预览并生成策划方向');
    }

    const artifactMatches = identifier(artifact.projectId) === projectId
        && identifier(artifact.sessionId) === identifier(session.id)
        && artifact.contextDigest === session.contextDigest
        && identifier(artifactBase.projectId) === projectId
        && artifactBase.projectVersion === project.version
        && identifier(artifactBase.anchorChapterId) === chapterId
        && artifactBase.anchorChapterRevision === chapter.revision;
    if (!artifactMatches) {
        return unavailable('artifact-mismatch', '策划候选包与当前会话或章节不一致');
    }
    return { eligible: true, code: 'eligible', reason: '' };
}
