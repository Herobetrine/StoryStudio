const WRITER_STORAGE_KEY = 'story-studio.workspace-recovery-writer.v1';

function apiPath(projectId, chapterId = '', suffix = '') {
    const projectPath = `/api/story-studio/projects/${encodeURIComponent(projectId)}`;
    if (!chapterId) return `${projectPath}${suffix}`;
    return `${projectPath}/chapters/${encodeURIComponent(chapterId)}${suffix}`;
}

async function responseJson(response, label) {
    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (!response.ok()) {
        throw new Error(`${label} failed (${response.status()}): ${JSON.stringify(body)}`);
    }
    return body;
}

export async function seedStoryProject(request, {
    mockProviderBaseURL,
    title = `Browser authority ${Date.now()}`,
} = {}) {
    if (!mockProviderBaseURL) throw new Error('mockProviderBaseURL is required.');
    const bootstrap = await responseJson(
        await request.get('/api/bootstrap'),
        'Bootstrap',
    );
    const writeHeaders = {
        'X-CSRF-Token': bootstrap.csrfToken,
    };
    await responseJson(
        await request.put('/api/provider', {
            headers: writeHeaders,
            data: {
                protocol: 'openai-chat',
                baseUrl: mockProviderBaseURL,
                model: 'mock-writer',
                contextTokens: 32_768,
                maxTokens: 8_192,
                temperature: 0.7,
                topP: 1,
                topK: 0,
                stop: [],
                jsonSchema: true,
            },
        }),
        'Provider configuration',
    );
    const created = await responseJson(
        await request.post('/api/story-studio/projects', {
            headers: writeHeaders,
            data: {
                title,
                genre: '浏览器并发回归',
                story: {
                    logline: '林照必须带着铜钥匙越过赤门。',
                    premise: '每次开门都必须承担可见代价。',
                },
            },
        }),
        'Project creation',
    );
    return {
        csrfToken: bootstrap.csrfToken,
        project: created.project,
        chapter: created.chapter,
        projectPath: apiPath(created.project.id),
        chapterPath: apiPath(created.project.id, created.chapter.id),
        authorityPath: apiPath(created.project.id, created.chapter.id, '/authority'),
        workflowRunsPath: apiPath(created.project.id, created.chapter.id, '/workflow-runs'),
    };
}

export async function openStoryProject(page, fixture, { navigate = true } = {}) {
    if (navigate) await page.goto('/');
    const projectSelect = page.locator('#ss_project_select');
    await projectSelect.waitFor({ state: 'visible' });
    await page.locator('#ss_manuscript').waitFor({ state: 'visible' });
    await page.waitForFunction(projectId => {
        const select = document.querySelector('#ss_project_select');
        return select instanceof HTMLSelectElement
            && !select.disabled
            && [...select.options].some(option => option.value === projectId);
    }, fixture.project.id);
    if (await projectSelect.inputValue() !== fixture.project.id) {
        await projectSelect.selectOption(fixture.project.id);
    }
    await page.waitForFunction(({ projectId, chapterId }) => {
        const select = document.querySelector('#ss_project_select');
        const chapter = document.querySelector(`[data-chapter-id="${CSS.escape(chapterId)}"]`);
        const manuscript = document.querySelector('#ss_manuscript');
        return select?.value === projectId
            && chapter?.getAttribute('aria-current') === 'true'
            && manuscript instanceof HTMLTextAreaElement
            && !manuscript.disabled;
    }, {
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
    });
}

export function absoluteStoryUrl(baseURL, relativePath) {
    return new URL(relativePath, baseURL).href;
}

export function workspaceRecoveryStoragePrefix(projectId, chapterId) {
    return `story-studio:workspace-recovery:v1:${encodeURIComponent(projectId)}:${encodeURIComponent(chapterId)}:`;
}

export async function workspaceRecoveryWriterId(page) {
    return await page.evaluate(key => window.sessionStorage.getItem(key), WRITER_STORAGE_KEY);
}

export async function advanceLegacyWorkflowToAdoption(page, fixture, {
    requestTimeout = 10_000,
} = {}) {
    const request = page.context().request;
    const requestJson = async (path, {
        method = 'GET',
        data,
        label = `${method} ${path}`,
    } = {}) => {
        let response;
        try {
            response = await request.fetch(path, {
                method,
                timeout: requestTimeout,
                headers: {
                    Accept: 'application/json',
                    ...(method === 'GET' ? {} : { 'X-CSRF-Token': fixture.csrfToken }),
                },
                ...(data === undefined ? {} : { data }),
            });
        } catch (error) {
            throw new Error(`${label} did not complete within ${requestTimeout} ms: ${error.message}`, {
                cause: error,
            });
        }
        return await responseJson(response, label);
    };

    const authority = await requestJson(fixture.authorityPath, {
        label: 'Workflow seed authority',
    });
    const definitions = await requestJson('/api/story-studio/workflows/definitions', {
        label: 'Workflow definitions',
    });
    const definition = definitions.definitions.find(item => item.id === 'builtin.chapter-cycle.v1');
    if (!definition) throw new Error('builtin.chapter-cycle.v1 is unavailable.');

    const commandNonce = crypto.randomUUID();
    let view = await requestJson(fixture.workflowRunsPath, {
        method: 'POST',
        label: 'Workflow run creation',
        data: {
            commandId: `browser-start-${commandNonce}`,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: authority.project.version,
            chapterRevision: authority.chapter.revision,
            input: {},
        },
    });
    let commandIndex = 0;
    const execute = async (payload = {}) => {
        commandIndex += 1;
        const stepId = view.run?.currentStepId || 'unknown';
        view = await requestJson(
            `${fixture.workflowRunsPath}/${encodeURIComponent(view.run.id)}/commands`,
            {
                method: 'POST',
                label: `Workflow seed command ${commandIndex} (${stepId})`,
                data: {
                    commandId: `browser-command-${commandNonce}-${commandIndex}`,
                    runRevision: view.run.revision,
                    type: 'execute',
                    payload,
                },
            },
        );
        return view;
    };
    const artifactBinding = () => {
        if (!view.currentArtifact?.id || !view.currentArtifact?.bindingHash) {
            throw new Error(`Workflow step ${view.run?.currentStepId || 'unknown'} has no bindable artifact.`);
        }
        return {
            artifactId: view.currentArtifact.id,
            artifactHash: view.currentArtifact.bindingHash,
        };
    };

    await execute();
    await execute();
    await execute(artifactBinding());
    await execute(artifactBinding());
    await execute();
    await execute();
    await execute(artifactBinding());
    await execute(artifactBinding());

    const latestAuthority = await requestJson(fixture.authorityPath, {
        label: 'Workflow adopted authority',
    });
    return {
        view,
        project: latestAuthority.project,
        chapter: latestAuthority.chapter,
    };
}

export async function readRecoveryDraftRecords(page, prefix) {
    return await page.evaluate(storagePrefix => {
        const records = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const storageKey = window.localStorage.key(index);
            if (!storageKey?.startsWith(storagePrefix)) continue;
            const raw = window.localStorage.getItem(storageKey);
            if (typeof raw !== 'string') continue;
            records.push({
                storageKey,
                draft: JSON.parse(raw),
            });
        }
        return records.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    }, prefix);
}
