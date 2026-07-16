import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('declarative workflow UI contract', () => {
    test('exposes a first-class chapter-bound workflow view and complete controls', () => {
        assert.match(html, /data-ss-view="workflow"/);
        assert.match(html, /id="ss_workflow_view"/);
        for (const id of [
            'ss_workflow_definition',
            'ss_workflow_run',
            'ss_workflow_new_run',
            'ss_workflow_refresh',
            'ss_workflow_track',
            'ss_workflow_execute',
            'ss_workflow_approve',
            'ss_workflow_apply',
            'ss_workflow_evidence',
            'ss_workflow_artifact_json',
            'ss_workflow_authority',
            'ss_workflow_error',
            'ss_workflow_retry',
        ]) assert.match(html, new RegExp(`id="${id}"`));
        assert.match(html, /id="ss_workflow_new_run"[\s\S]*?\/icons\/plus\.svg/);
        assert.match(html, /id="ss_workflow_refresh"[\s\S]*?\/icons\/refresh-cw\.svg/);
        assert.match(html, /id="ss_workflow_execute"[\s\S]*?\/icons\/play\.svg/);
        assert.match(html, /id="ss_workflow_approve"[\s\S]*?\/icons\/check\.svg/);
        assert.match(html, /id="ss_workflow_apply"[\s\S]*?\/icons\/corner-down-right\.svg/);
    });

    test('uses the strict versioned workflow API and one execute command contract', () => {
        assert.match(app, /const DEFAULT_WORKFLOW_DEFINITION_ID = 'builtin\.chapter-cycle\.v2'/);
        assert.match(app, /state\.workflowDefinitionId = preferredWorkflowDefinitionId\(state\.workflowDefinitions\)/);
        assert.match(app, /apiRequest\(`\$\{API_ROOT\}\/workflows\/definitions`\)/);
        assert.match(app, /workflowRunsPath\(projectId, chapterId\)/);
        assert.match(app, /workflowRunsPath\(projectId, chapterId, runId\)/);
        assert.match(app, /workflowRunsPath\(projectId, chapterId, run\.id, '\/commands'\)/);
        assert.match(app, /commandId:\s*workflowCommandId\(\)/);
        assert.match(app, /definitionHash:\s*definition\?\.definitionHash/);
        assert.match(app, /projectVersion:\s*state\.project\.version/);
        assert.match(app, /chapterRevision:\s*state\.chapter\.revision/);
        assert.match(app, /runRevision:\s*run\.revision/);
        assert.match(app, /sendWorkflowCommand\('execute', \{\}\)/);
        assert.match(app, /artifactId:\s*artifact\.id,\s*artifactHash:\s*artifact\.bindingHash\s*\|\|\s*artifact\.recordHash/);
        assert.match(app, /state\.workflowArtifacts\.find\(candidate => candidate\.id === state\.workflowArtifactId\)/);
        assert.match(app, /relatedArtifactIds\.has\(artifact\.id\) \? artifact : null/);
        assert.doesNotMatch(app, /sendWorkflowCommand\('(?:approve-artifact|apply-artifact|retry-step|execute-step)'/);
    });

    test('fails closed across project and chapter switches and refreshes conflicts in place', () => {
        assert.match(app, /function workflowRequestIsCurrent\(projectId, chapterId, requestSerial\)/);
        assert.match(app, /state\.project\?\.id === projectId[\s\S]*state\.chapter\?\.id === chapterId[\s\S]*workflowBindingMatches/);
        assert.match(app, /bindWorkflowWorkspace\(state\.project, chapter\)/);
        assert.match(app, /bindWorkflowWorkspace\(project, chapter\)/);
        assert.match(app, /const selectedRunId = state\.workflowRunId;[\s\S]*await loadWorkflowRun\(selectedRunId\)/);
        assert.match(app, /error instanceof ApiError && error\.status === 409/);
        assert.match(app, /async function refreshWorkflowAuthority\([\s\S]*acceptServerProject\(project, new Set\(\)\)[\s\S]*acceptServerChapter\(chapter, new Set\(\)\)/);
        assert.match(app, /error instanceof ApiError && error\.status === 409[\s\S]*await refreshWorkflowAuthority\(projectId, chapterId, requestSerial\)[\s\S]*await loadWorkflowRun\(selectedRunId\)/);
        assert.match(app, /state\.workflowRetry = \{ kind: 'command', descriptor \}/);
        assert.match(app, /sendWorkflowCommand\(descriptor\.type, descriptor\.payload, descriptor\)/);
    });

    test('renders authoritative state, diagnostics, artifacts, and the definition-sized status track', () => {
        assert.match(app, /definition\.steps\.forEach\(\(step, index\) =>/);
        assert.match(app, /WORKFLOW_STEP_STATUS_LABELS/);
        assert.match(app, /artifact\.kind === 'diagnosis'/);
        assert.match(app, /artifact\.evidenceIds/);
        assert.match(app, /JSON\.stringify\(selected, null, 2\)/);
        assert.match(app, /authority\.projectVersion/);
        assert.match(app, /authority\.chapterRevision/);
        assert.match(app, /authority\.storyStateDigest/);
        assert.match(app, /authority\.cardDigest/);
        assert.match(app, /authority\.contentDigest/);
        assert.match(app, /authority\.reviewDigest/);
        assert.match(app, /currentWorkflowStep\(\)\?\.status === 'failed'/);
    });

    test('renders the complete Copilot source chain in Workflow and keeps eventSeeds as the ordinary fallback', () => {
        const directionRenderer = app.slice(
            app.indexOf('function renderWorkflowDirectionSummary('),
            app.indexOf('function renderWorkflowPlanSummary('),
        );
        assert.match(directionRenderer, /Array\.isArray\(direction\.sourceEventChain\)/);
        assert.match(directionRenderer, /for \(const event of direction\.sourceEventChain\)/);
        assert.match(directionRenderer, /`事件：\$\{event\.event\}`/);
        assert.match(directionRenderer, /`选择：\$\{event\.characterChoice\}`/);
        assert.match(directionRenderer, /`结果：\$\{event\.directResult\}`/);
        assert.match(directionRenderer, /`代价：\$\{event\.cost\}`/);
        assert.match(directionRenderer, /else\s*\{[\s\S]*for \(const seed of direction\.eventSeeds \|\| \[\]\)/);
    });

    test('keeps the binder, removes the inspector, and contains narrow layouts', () => {
        assert.match(style, /#ss_shell\.is-workflow-view\s*\{[^}]*grid-template-columns:\s*minmax\(210px, 16vw\) minmax\(0, 1fr\)/);
        assert.match(style, /#ss_shell\.is-workflow-view > \.ss-inspector\s*\{[^}]*display:\s*none !important/);
        assert.match(style, /\.ss-workflow-view\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/);
        assert.match(style, /\.ss-workflow-json\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*#ss_shell\.is-workflow-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*\.ss-workflow-track\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*overflow-x:\s*visible/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-header\s*\{[^}]*grid-template-columns:\s*40px minmax\(0, 1fr\) auto/);
    });
});
