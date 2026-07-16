import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import {
    dashboardNavigationTarget,
    dashboardViewMode,
    normalizeWorkspaceResumeState,
} from '../public/dashboard-ui.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('today dashboard UI contract', () => {
    test('reduces loading, empty, error, ready, and no-project states deterministically', () => {
        assert.equal(dashboardViewMode({}), 'no-project');
        assert.equal(dashboardViewMode({ projectId: 'project-one', loading: true }), 'loading');
        assert.equal(dashboardViewMode({
            projectId: 'project-one',
            loading: true,
            error: 'late error',
            dashboard: {},
        }), 'loading');
        assert.equal(dashboardViewMode({ projectId: 'project-one', error: 'broken' }), 'error');
        assert.equal(dashboardViewMode({ projectId: 'project-one', dashboard: {} }), 'ready');
        assert.equal(dashboardViewMode({ projectId: 'project-one' }), 'empty');
    });

    test('maps server targets onto real StoryStudio workspaces and rejects unknown views', () => {
        assert.deepEqual(dashboardNavigationTarget({
            view: 'editor',
            chapterId: 'chapter-one',
            volumeId: 'volume-one',
        }), {
            view: 'write',
            chapterId: 'chapter-one',
            volumeId: 'volume-one',
            promiseId: '',
        });
        assert.deepEqual(dashboardNavigationTarget({
            view: 'ledger',
            promiseId: 'promise-one',
        }), {
            view: 'ledger',
            chapterId: '',
            volumeId: '',
            promiseId: 'promise-one',
        });
        assert.deepEqual(dashboardNavigationTarget({ view: 'bible' }, 'workflow'), {
            view: 'workflow',
            chapterId: '',
            volumeId: '',
            promiseId: '',
        });
        assert.equal(dashboardNavigationTarget({ view: 'missing' }), null);
    });

    test('normalizes refresh resume state without accepting arbitrary views or ledger targets', () => {
        assert.deepEqual(normalizeWorkspaceResumeState({
            version: 1,
            projectId: ' project-one ',
            chapterId: ' chapter-two ',
            view: 'today',
            workflowRunId: ' run-one ',
            copilotSessionId: ' copilot-session-two ',
            continuityView: 'promises',
            continuityRecordId: ' promise-one ',
        }), {
            version: 1,
            projectId: 'project-one',
            chapterId: 'chapter-two',
            view: 'today',
            workflowRunId: 'run-one',
            copilotSessionId: 'copilot-session-two',
            continuityView: 'promises',
            continuityRecordId: 'promise-one',
        });
        assert.equal(normalizeWorkspaceResumeState({
            version: 1,
            projectId: 'project-one',
            view: 'unknown',
        }), null);
        assert.equal(normalizeWorkspaceResumeState({
            version: 2,
            projectId: 'project-one',
            view: 'write',
        }), null);
        assert.equal(normalizeWorkspaceResumeState(null), null);
        assert.equal(normalizeWorkspaceResumeState([]), null);
        assert.equal(normalizeWorkspaceResumeState({
            version: 1,
            projectId: '',
            view: 'write',
        }), null);
        assert.deepEqual(normalizeWorkspaceResumeState({
            version: 1,
            projectId: 'project-one',
            view: 'ledger',
            continuityView: 'facts',
            continuityRecordId: 'promise-one',
        }), {
            version: 1,
            projectId: 'project-one',
            chapterId: '',
            view: 'ledger',
            workflowRunId: '',
            copilotSessionId: '',
            continuityView: 'facts',
            continuityRecordId: '',
        });
    });

    test('exposes a top-level today workspace and all Dashboard V1 surfaces', () => {
        assert.match(html, /id="ss_today_tab"[^>]*data-ss-view="today"/);
        assert.match(html, /id="ss_today_view"[^>]*role="tabpanel"[^>]*aria-labelledby="ss_today_tab"/);
        for (const id of [
            'ss_dashboard_status',
            'ss_dashboard_refresh',
            'ss_dashboard_no_project',
            'ss_dashboard_loading',
            'ss_dashboard_empty',
            'ss_dashboard_error',
            'ss_dashboard_retry',
            'ss_dashboard_workspace',
            'ss_dashboard_next_label',
            'ss_dashboard_next_open',
            'ss_dashboard_next_workflow',
            'ss_dashboard_progress',
            'ss_dashboard_chapter_statuses',
            'ss_dashboard_work_list',
            'ss_dashboard_promise_list',
            'ss_dashboard_stale_list',
            'ss_dashboard_story_state_summary',
            'ss_dashboard_recent_list',
        ]) assert.match(html, new RegExp(`id="${id}"`));

        assert.match(app, /dashboardViewMode/);
        assert.match(app, /today:\s*elements\.ss_today_view/);
        assert.match(app, /classList\.toggle\('is-dashboard-view', state\.view === 'today'\)/);
        assert.match(app, /if \(view === 'today'\)[\s\S]*loadDashboardWorkspace\(\)/);
    });

    test('loads the versioned read-only projection with stale-response, empty, and error handling', () => {
        assert.match(app, /function dashboardPath\(projectId\)[\s\S]*'\/dashboard'/);
        assert.match(app, /async function loadDashboardWorkspace\(\)/);
        assert.match(app, /const requestSerial = \+\+state\.dashboardRequestSerial/);
        assert.match(app, /apiRequest\(dashboardPath\(projectId\)\)/);
        assert.match(app, /dashboardRequestIsCurrent\(projectId, requestSerial\)/);
        assert.match(app, /payload\.dashboardVersion !== 1/);
        assert.match(app, /state\.dashboardError = error\.message \|\| '今日工作台载入失败'/);
        assert.match(app, /elements\.ss_dashboard_refresh\.addEventListener\('click', \(\) => void loadDashboardWorkspace\(\)\)/);
        assert.match(app, /elements\.ss_dashboard_retry\.addEventListener\('click', \(\) => void loadDashboardWorkspace\(\)\)/);
        assert.match(app, /const resume = readWorkspaceResumeState\(\)/);
        assert.match(app, /loadProjects\(resume\?\.projectId[\s\S]*resume\?\.chapterId/);
        assert.match(app, /restoreWorkspaceResumeState\(resume\)/);
        assert.match(app, /persistWorkspaceResumeState\(\)/);
        assert.match(app, /if \(resume\.view === 'ledger'\) renderStoryState\(\)/);
        assert.match(app, /const authorityVersionBeforeSave = state\.project\.version/);
        assert.match(app, /state\.project\.version !== authorityVersionBeforeSave[\s\S]*refreshVisibleDashboard\(authorityProjectId\)/);
        assert.match(app, /function refreshVisibleDashboard\(projectId\)[\s\S]*state\.view !== 'today'[\s\S]*loadDashboardWorkspace\(\)/);
    });

    test('uses real chapter, volume, ledger, and Workflow navigation instead of inert cards', () => {
        assert.match(app, /button\.disabled = !setDashboardTarget\(button, item\)/);
        assert.match(app, /button\.disabled = !setDashboardTarget\(button, source, view\)/);
        assert.match(app, /elements\.ss_today_view\.addEventListener\('click'/);
        assert.match(app, /data-dashboard-view/);
        assert.match(app, /await loadChapter\(target\.chapterId, \{ pendingPrepared: true \}\)/);
        assert.match(app, /bindSelectedVolume\(target\.volumeId, \{ render: target\.view === 'bible' \}\)/);
        assert.match(app, /target\.view === 'ledger' && target\.promiseId\) state\.continuityView = 'promises'/);
        assert.match(app, /if \(target\.view === 'ledger'\) renderStoryState\(\)/);
        assert.match(app, /setView\(target\.view\)/);
        assert.match(app, /promiseId:\s*promise\.id,[\s\S]*view:\s*'ledger',[\s\S]*chapterId:\s*promise\.dueChapterId \|\| ''/);

        const navigationSource = app.slice(
            app.indexOf('async function navigateDashboardTarget('),
            app.indexOf('function renderViewState('),
        );
        const saveIndex = navigationSource.indexOf('await enqueueSave()');
        const bindIndex = navigationSource.indexOf(
            "bindSelectedVolume(target.volumeId, { render: target.view === 'bible' })",
        );
        assert.ok(saveIndex >= 0 && bindIndex > saveIndex,
            'Dashboard volume navigation must drain the previous volume save before rebinding.');
        assert.doesNotMatch(navigationSource, /state\.selectedVolumeId\s*=\s*target\.volumeId/,
            'Dashboard navigation must not bypass the selected-volume baseline helper.');
    });

    test('contains the dashboard at desktop and 375px without horizontal layout assumptions', () => {
        assert.match(style, /#ss_shell\.is-dashboard-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /#ss_shell\.is-dashboard-view > \.ss-binder,/);
        assert.match(style, /#ss_shell\.is-dashboard-view > \.ss-inspector,/);
        assert.match(style, /#ss_shell\.is-resource-view > \.ss-binder,[\s\S]*display:\s*none !important/);
        assert.match(style, /\.ss-dashboard-view\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/);
        assert.match(style, /\.ss-dashboard-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)[^}]*overflow:\s*hidden/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*\.ss-dashboard-lead,[\s\S]*\.ss-dashboard-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-dashboard-statuses,[\s\S]*\.ss-dashboard-state-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    });
});
