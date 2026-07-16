function orderedRecords(records) {
    return [...(Array.isArray(records) ? records : [])]
        .sort((left, right) => Number(left?.number || 0) - Number(right?.number || 0));
}

export function volumeForChapter(project, chapter) {
    const volumeId = chapter?.volumeId;
    return (project?.volumes || []).find(volume => volume.id === volumeId) || null;
}

export function isChapterPlanStale(project, chapter) {
    const volume = volumeForChapter(project, chapter);
    if (!volume) return true;
    return Number(chapter?.planBasis?.volumeRevision || 0) < Number(volume.revision || 0);
}

export function buildVolumeTree(project, query = '') {
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
    const chapters = orderedRecords(project?.chapters);
    return orderedRecords(project?.volumes).map(volume => {
        const volumeChapters = chapters.filter(chapter => chapter.volumeId === volume.id);
        const matchingChapters = normalizedQuery
            ? volumeChapters.filter(chapter => (
                `${chapter.number || ''} ${chapter.title || ''} ${chapter.summary || ''}`
                    .toLocaleLowerCase()
                    .includes(normalizedQuery)
            ))
            : volumeChapters;
        return {
            volume,
            chapters: matchingChapters,
            totalChapterCount: volumeChapters.length,
            matchesQuery: !normalizedQuery || matchingChapters.length > 0,
        };
    }).filter(group => group.matchesQuery);
}

export function structureProjection(project) {
    const volumes = orderedRecords(project?.volumes);
    const chapters = orderedRecords(project?.chapters);
    if (volumes.length === 0) throw new Error('作品至少需要一卷');

    const volumeIds = new Set();
    for (const volume of volumes) {
        if (!volume?.id || volumeIds.has(volume.id)) throw new Error('卷目录包含无效或重复 ID');
        volumeIds.add(volume.id);
    }

    const chapterIds = new Set();
    const projection = volumes.map(volume => ({ id: volume.id, chapterIds: [] }));
    const groupByVolumeId = new Map(projection.map(group => [group.id, group]));
    for (const chapter of chapters) {
        if (!chapter?.id || chapterIds.has(chapter.id)) throw new Error('章节目录包含无效或重复 ID');
        const group = groupByVolumeId.get(chapter.volumeId);
        if (!group) throw new Error(`章节 ${chapter.id} 指向不存在的卷`);
        chapterIds.add(chapter.id);
        group.chapterIds.push(chapter.id);
    }
    return projection;
}

function cloneProjection(project) {
    return structureProjection(project).map(group => ({ id: group.id, chapterIds: [...group.chapterIds] }));
}

export function moveVolumeProjection(project, volumeId, direction) {
    if (!['up', 'down'].includes(direction)) return null;
    const projection = cloneProjection(project);
    const index = projection.findIndex(group => group.id === volumeId);
    const targetIndex = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || targetIndex < 0 || targetIndex >= projection.length) return null;
    [projection[index], projection[targetIndex]] = [projection[targetIndex], projection[index]];
    return projection;
}

export function moveChapterProjection(project, chapterId, direction) {
    if (!['up', 'down'].includes(direction)) return null;
    const projection = cloneProjection(project);
    const group = projection.find(item => item.chapterIds.includes(chapterId));
    if (!group) return null;
    const index = group.chapterIds.indexOf(chapterId);
    const targetIndex = index + (direction === 'up' ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= group.chapterIds.length) return null;
    [group.chapterIds[index], group.chapterIds[targetIndex]] = [group.chapterIds[targetIndex], group.chapterIds[index]];
    return projection;
}

export function moveChapterToVolumeProjection(project, chapterId, targetVolumeId) {
    const projection = cloneProjection(project);
    const source = projection.find(group => group.chapterIds.includes(chapterId));
    const target = projection.find(group => group.id === targetVolumeId);
    if (!source || !target || source.id === target.id) return null;
    source.chapterIds = source.chapterIds.filter(id => id !== chapterId);
    target.chapterIds.push(chapterId);
    return projection;
}
