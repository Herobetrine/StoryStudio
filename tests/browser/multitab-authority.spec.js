import { test, expect } from './fixture-server.js';
import {
    absoluteStoryUrl,
    advanceLegacyWorkflowToAdoption,
    openStoryProject,
    readRecoveryDraftRecords,
    seedStoryProject,
    workspaceRecoveryStoragePrefix,
    workspaceRecoveryWriterId,
} from './workflow-helper.js';

test.describe.configure({ mode: 'serial' });

function chapterPatch(response, chapterUrl) {
    return response.url() === chapterUrl && response.request().method() === 'PATCH';
}

async function createStoryContext(browser, baseURL, fixture, options = {}) {
    const context = await browser.newContext({
        baseURL,
        ...options,
    });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([
        openStoryProject(pageA, fixture),
        openStoryProject(pageB, fixture),
    ]);
    return { context, pageA, pageB };
}

async function stretchAutosaveDelay(page) {
    await page.evaluate(() => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (handler, delay = 0, ...args) => nativeSetTimeout(
            handler,
            Number(delay) === 700 ? 60_000 : delay,
            ...args,
        );
    });
}

async function installKeepaliveProbe(page) {
    await page.evaluate(() => {
        const nativeFetch = window.fetch.bind(window);
        window.__storyStudioKeepaliveRequests = [];
        window.fetch = (input, init = {}) => {
            if (init?.keepalive === true) {
                let body = null;
                try {
                    body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
                } catch {
                    body = init.body;
                }
                window.__storyStudioKeepaliveRequests.push({
                    url: typeof input === 'string' ? input : input?.url || String(input),
                    body,
                    keepalive: true,
                });
            }
            return nativeFetch(input, init);
        };
    });
}

async function triggerLifecycleFlush(page, lifecycle) {
    await page.evaluate(trigger => {
        if (trigger === 'pagehide') {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
            return;
        }
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        try {
            document.dispatchEvent(new Event('visibilitychange'));
        } finally {
            delete document.visibilityState;
        }
    }, lifecycle);
}

test('a stale in-flight autosave conflicts after another tab adopts Workflow authority', async ({
    browser,
    request,
    storyStudio,
}) => {
    test.setTimeout(60_000);
    const fixture = await seedStoryProject(request, {
        mockProviderBaseURL: storyStudio.mockProviderBaseURL,
        title: '在途自动保存冲突',
    });
    const chapterUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.chapterPath);
    const authorityUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.authorityPath);
    const localContent = 'A 标签页仍未提交的本地正文。';
    const { context, pageA, pageB } = await createStoryContext(
        browser,
        storyStudio.baseURL,
        fixture,
    );
    let releaseHeldPatch = null;

    try {
        let heldPatchBody = null;
        let notifyPatchHeld;
        const patchHeld = new Promise(resolve => {
            notifyPatchHeld = resolve;
        });
        const patchRelease = new Promise(resolve => {
            releaseHeldPatch = resolve;
        });
        const patchStatuses = [];
        pageA.on('response', response => {
            if (chapterPatch(response, chapterUrl)) patchStatuses.push(response.status());
        });
        await pageA.route(chapterUrl, async route => {
            const routeRequest = route.request();
            const requestBody = routeRequest.method() === 'PATCH'
                ? routeRequest.postDataJSON()
                : null;
            if (!heldPatchBody && requestBody?.changes?.content === localContent) {
                heldPatchBody = requestBody;
                notifyPatchHeld();
                await patchRelease;
                await route.continue();
                return;
            }
            await route.continue();
        });

        await pageA.locator('#ss_manuscript').fill(localContent);
        await patchHeld;
        expect(heldPatchBody).toMatchObject({
            projectVersion: fixture.project.version,
            revision: fixture.chapter.revision,
            changes: { content: localContent },
        });

        const workflow = await advanceLegacyWorkflowToAdoption(pageB, fixture);
        expect(workflow.chapter.content).not.toBe(localContent);
        const authorityRefresh = pageA.waitForResponse(response => (
            response.url() === authorityUrl
            && response.request().method() === 'GET'
            && response.status() === 200
        ));
        await pageA.locator('#ss_workflow_tab').click();
        await authorityRefresh;
        await expect(pageA.locator('#ss_manuscript')).toHaveValue(localContent);

        const conflictDialog = pageA.waitForEvent('dialog');
        releaseHeldPatch();
        releaseHeldPatch = null;
        const dialog = await conflictDialog;
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('当前章节的同一字段已在另一个窗口发生变化');
        await dialog.dismiss();

        await expect(pageA.locator('#ss_save_status')).toHaveText('已保存', { timeout: 10_000 });
        await expect(pageA.locator('#ss_manuscript')).toHaveValue(workflow.chapter.content);
        await expect.poll(() => patchStatuses.some(status => status === 409)).toBe(true);
        const remoteChapter = await responseJson(request, fixture.chapterPath);
        expect(remoteChapter.content).toBe(workflow.chapter.content);
    } finally {
        releaseHeldPatch?.();
        await context.close();
    }
});

test('a late successful autosave response cannot roll back newer Workflow authority', async ({
    browser,
    request,
    storyStudio,
}) => {
    test.setTimeout(60_000);
    const fixture = await seedStoryProject(request, {
        mockProviderBaseURL: storyStudio.mockProviderBaseURL,
        title: '迟到成功响应权威保护',
    });
    const chapterUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.chapterPath);
    const authorityUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.authorityPath);
    const localContent = 'A 标签页已经提交、但响应仍在网络途中。';
    const { context, pageA, pageB } = await createStoryContext(
        browser,
        storyStudio.baseURL,
        fixture,
    );
    let releaseDelayedResponse = null;

    try {
        let delayedPatchBody = null;
        let delayedPatchStatus = null;
        let notifyPatchCommitted;
        const patchCommitted = new Promise(resolve => {
            notifyPatchCommitted = resolve;
        });
        const responseRelease = new Promise(resolve => {
            releaseDelayedResponse = resolve;
        });
        const patchStatuses = [];
        pageA.on('response', response => {
            if (chapterPatch(response, chapterUrl)) patchStatuses.push(response.status());
        });
        await pageA.route(chapterUrl, async route => {
            const routeRequest = route.request();
            const requestBody = routeRequest.method() === 'PATCH'
                ? routeRequest.postDataJSON()
                : null;
            if (!delayedPatchBody && requestBody?.changes?.content === localContent) {
                delayedPatchBody = requestBody;
                const committedResponse = await route.fetch();
                delayedPatchStatus = committedResponse.status();
                notifyPatchCommitted();
                await responseRelease;
                await route.fulfill({ response: committedResponse });
                return;
            }
            await route.continue();
        });

        await pageA.locator('#ss_manuscript').fill(localContent);
        await patchCommitted;
        expect(delayedPatchStatus).toBe(200);
        expect(delayedPatchBody).toMatchObject({
            projectVersion: fixture.project.version,
            revision: fixture.chapter.revision,
            changes: { content: localContent },
        });

        const committedChapter = await responseJson(request, fixture.chapterPath);
        expect(committedChapter.content).toBe(localContent);
        const workflow = await advanceLegacyWorkflowToAdoption(pageB, fixture);
        expect(workflow.chapter.content).not.toBe(localContent);

        const authorityRefresh = pageA.waitForResponse(response => (
            response.url() === authorityUrl
            && response.request().method() === 'GET'
            && response.status() === 200
        ));
        await pageA.locator('#ss_workflow_tab').click();
        await authorityRefresh;
        await expect(pageA.locator('#ss_manuscript')).toHaveValue(localContent);

        const conflictDialog = pageA.waitForEvent('dialog');
        releaseDelayedResponse();
        releaseDelayedResponse = null;
        const dialog = await conflictDialog;
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('当前章节的同一字段已在另一个窗口发生变化');
        await dialog.dismiss();

        await expect(pageA.locator('#ss_save_status')).toHaveText('已保存', { timeout: 10_000 });
        await expect(pageA.locator('#ss_manuscript')).toHaveValue(workflow.chapter.content);
        await expect.poll(() => patchStatuses.some(status => status === 200)).toBe(true);
        const remoteChapter = await responseJson(request, fixture.chapterPath);
        expect(remoteChapter.content).toBe(workflow.chapter.content);
    } finally {
        releaseDelayedResponse?.();
        await context.close();
    }
});

for (const lifecycle of ['visibilitychange', 'pagehide']) {
    test(`mobile ${lifecycle} keepalive retains the stale chapter base after authority refresh`, async ({
        browser,
        request,
        storyStudio,
    }) => {
        test.setTimeout(60_000);
        const fixture = await seedStoryProject(request, {
            mockProviderBaseURL: storyStudio.mockProviderBaseURL,
            title: `移动生命周期 ${lifecycle}`,
        });
        const chapterUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.chapterPath);
        const authorityUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.authorityPath);
        const localContent = `A 标签页 ${lifecycle} 本地正文。`;
        const { context, pageA, pageB } = await createStoryContext(
            browser,
            storyStudio.baseURL,
            fixture,
            {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
            },
        );

        try {
            const workflow = await advanceLegacyWorkflowToAdoption(pageB, fixture);
            await stretchAutosaveDelay(pageA);
            await pageA.locator('#ss_manuscript').fill(localContent);
            const authorityRefresh = pageA.waitForResponse(response => (
                response.url() === authorityUrl
                && response.request().method() === 'GET'
                && response.status() === 200
            ));
            await pageA.locator('#ss_workflow_tab').click();
            await authorityRefresh;
            await expect(pageA.locator('#ss_manuscript')).toHaveValue(localContent);

            await installKeepaliveProbe(pageA);
            const keepaliveResponse = pageA.waitForResponse(response => chapterPatch(response, chapterUrl));
            await triggerLifecycleFlush(pageA, lifecycle);
            const response = await keepaliveResponse;
            expect(response.status()).toBe(409);
            const captures = await pageA.evaluate(() => window.__storyStudioKeepaliveRequests);
            expect(captures).toHaveLength(1);
            expect(captures[0]).toMatchObject({
                keepalive: true,
                body: {
                    projectVersion: workflow.project.version,
                    revision: fixture.chapter.revision,
                    changes: { content: localContent },
                },
            });
            expect(captures[0].body.revision).toBeLessThan(workflow.chapter.revision);
            const remoteChapter = await responseJson(request, fixture.chapterPath);
            expect(remoteChapter.content).toBe(workflow.chapter.content);
        } finally {
            await context.close();
        }
    });
}

test('a duplicated tab rotates its writer identity and restores only its own draft', async ({
    browser,
    request,
    storyStudio,
}) => {
    test.setTimeout(60_000);
    const fixture = await seedStoryProject(request, {
        mockProviderBaseURL: storyStudio.mockProviderBaseURL,
        title: '复制标签页恢复隔离',
    });
    const chapterUrl = absoluteStoryUrl(storyStudio.baseURL, fixture.chapterPath);
    const context = await browser.newContext({ baseURL: storyStudio.baseURL });
    const pageA = await context.newPage();
    try {
        await openStoryProject(pageA, fixture);
        const originalWriterId = await workspaceRecoveryWriterId(pageA);
        expect(originalWriterId).toBeTruthy();
        const pageB = await context.newPage();
        await pageB.addInitScript(({ writerStorageKey, writerId, seedMarker }) => {
            if (window.sessionStorage.getItem(seedMarker) === 'true') return;
            window.sessionStorage.setItem(seedMarker, 'true');
            window.sessionStorage.setItem(writerStorageKey, writerId);
        }, {
            writerStorageKey: 'story-studio.workspace-recovery-writer.v1',
            writerId: originalWriterId,
            seedMarker: 'story-studio.e2e-duplicated-writer-seeded.v1',
        });
        await openStoryProject(pageB, fixture);

        await expect.poll(() => workspaceRecoveryWriterId(pageB)).not.toBe(originalWriterId);
        const writerA = await workspaceRecoveryWriterId(pageA);
        const writerB = await workspaceRecoveryWriterId(pageB);
        expect(writerA).toBe(originalWriterId);
        expect(writerB).toBeTruthy();
        expect(writerB).not.toBe(writerA);

        for (const page of [pageA, pageB]) {
            await page.route(chapterUrl, async route => {
                if (route.request().method() === 'PATCH') {
                    await route.abort('connectionfailed');
                    return;
                }
                await route.continue();
            });
        }
        const draftA = '只属于复制前标签页 A 的恢复正文。';
        const draftB = '只属于复制后标签页 B 的恢复正文。';
        await pageA.locator('#ss_manuscript').fill(draftA);
        await pageB.locator('#ss_manuscript').fill(draftB);

        const prefix = workspaceRecoveryStoragePrefix(fixture.project.id, fixture.chapter.id);
        await expect.poll(async () => (await readRecoveryDraftRecords(pageA, prefix)).length).toBe(2);
        const records = await readRecoveryDraftRecords(pageA, prefix);
        const byWriter = new Map(records.map(record => [record.draft.writerId, record.draft]));
        expect(byWriter.get(writerA)?.chapterChanges?.content).toBe(draftA);
        expect(byWriter.get(writerB)?.chapterChanges?.content).toBe(draftB);

        const unexpectedDialogs = [];
        const acceptOnlyBeforeUnload = page => {
            page.on('dialog', async dialog => {
                if (dialog.type() === 'beforeunload') {
                    await dialog.accept();
                    return;
                }
                unexpectedDialogs.push({
                    type: dialog.type(),
                    message: dialog.message(),
                });
                await dialog.dismiss();
            });
        };
        acceptOnlyBeforeUnload(pageA);
        acceptOnlyBeforeUnload(pageB);

        await pageA.reload();
        await openStoryProject(pageA, fixture, { navigate: false });
        await expect(pageA.locator('#ss_manuscript')).toHaveValue(draftA);
        await expect(pageA.locator('#ss_toast')).toContainText('已恢复本标签页未完成的本地草稿');

        await pageB.reload();
        await openStoryProject(pageB, fixture, { navigate: false });
        await expect(pageB.locator('#ss_manuscript')).toHaveValue(draftB);
        await expect(pageB.locator('#ss_toast')).toContainText('已恢复本标签页未完成的本地草稿');
        expect(unexpectedDialogs).toEqual([]);

        const remoteChapter = await responseJson(request, fixture.chapterPath);
        expect(remoteChapter.content).toBe('');
    } finally {
        await context.close();
    }
});

async function responseJson(request, path) {
    const response = await request.get(path);
    const body = await response.json();
    expect(response.ok(), `${path} returned ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
    return body;
}
