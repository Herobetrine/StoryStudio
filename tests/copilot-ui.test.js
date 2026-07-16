import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('first-class planning Copilot UI contract', () => {
    test('exposes a top-level Copilot workspace with the complete read-only tool surface', () => {
        assert.match(html, /id="ss_copilot_tab"[^>]*data-ss-view="copilot"/);
        assert.match(html, /id="ss_copilot_view"[^>]*role="tabpanel"[^>]*aria-labelledby="ss_copilot_tab"/);
        for (const id of [
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
            'ss_copilot_evidence_list',
            'ss_copilot_profile',
            'ss_copilot_model_mode',
            'ss_copilot_model',
            'ss_copilot_model_status',
            'ss_copilot_save_model',
            'ss_copilot_test_model',
            'ss_copilot_instruction',
            'ss_copilot_option_count',
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
        ]) assert.match(html, new RegExp(`id="${id}"`));

        assert.match(app, /copilot:\s*elements\.ss_copilot_view/);
        assert.match(app, /\['today', 'write', 'bible', 'ledger', 'copilot', 'workflow', 'resources'\]\.includes\(view\)/);
        assert.match(app, /classList\.toggle\('is-copilot-view', state\.view === 'copilot'\)/);
    });

    test('builds explicit checkbox selections for volumes, chapters, characters, Lorebooks, and evidence', () => {
        assert.match(html, /<legend>卷<\/legend>[\s\S]*id="ss_copilot_volume_options"/);
        assert.match(html, /<legend>章节<\/legend>[\s\S]*id="ss_copilot_chapter_options"/);
        assert.match(html, /<legend>人物<\/legend>[\s\S]*id="ss_copilot_entity_options"/);
        assert.match(html, /<legend>世界书<\/legend>[\s\S]*id="ss_copilot_lorebook_options"/);
        assert.match(app, /function renderCopilotSelectionOptions\(/);
        assert.match(app, /input\.type\s*=\s*'checkbox'/);
        assert.match(app, /entity\.kind === 'character'/);
        for (const field of ['volumeIds', 'chapterIds', 'entityIds', 'lorebookIds']) {
            assert.match(app, new RegExp(`${field}:`));
        }
        assert.match(app, /function renderCopilotEvidence\(/);
        assert.match(app, /input\.dataset\.copilotEvidenceId\s*=\s*record\.evidenceId/);
        assert.match(app, /state\.copilotSelectedEvidenceIds\.(?:add|delete)\(input\.dataset\.copilotEvidenceId\)/);
        assert.match(app, /ss_copilot_evidence_(?:defaults|all|none)/);
    });

    test('previews the exact selected context before creating a 3-6 direction session', () => {
        assert.match(html, /id="ss_copilot_option_count"[^>]*type="number"[^>]*min="3"[^>]*max="6"[^>]*step="1"/);
        assert.match(html, /id="ss_copilot_option_decrease"[\s\S]*?\/icons\/minus\.svg/);
        assert.match(html, /id="ss_copilot_option_increase"[\s\S]*?\/icons\/plus\.svg/);
        assert.match(app, /function copilotPath\(projectId, suffix = ''\)/);
        assert.match(app, /async function previewCopilotContext\(/);
        assert.match(app, /copilotPath\(projectId, '\/context-preview'\)/);
        assert.match(app, /projectVersion:\s*state\.project\.version/);
        assert.match(app, /anchorChapterId:\s*state\.copilotAnchorChapterId\s*\|\|\s*null/);
        assert.match(app, /selection:\s*copilotSelectionValue\(\)/);
        assert.match(app, /retrieval:\s*\{[\s\S]*query:\s*state\.copilotRetrievalQuery[\s\S]*filters:\s*\{\}[\s\S]*limit:\s*state\.copilotRetrievalLimit/);
        assert.match(app, /contextDigest/);
        assert.match(app, /evidenceCatalog/);
        assert.match(app, /state\.copilotOptionCount\s*=\s*Math\.max\(3,\s*Math\.min\(6,\s*Number\(value\)\s*\|\|\s*3\)\)/);
    });

    test('uses an independent Profile and explicit inherit-or-override model settings', () => {
        assert.match(html, /id="ss_copilot_profile"/);
        assert.match(html, /data-copilot-model-mode="inherit"/);
        assert.match(html, /data-copilot-model-mode="override"/);
        assert.match(app, /builtin\.planning-copilot\.v1/);
        assert.match(app, /profileRef/);
        assert.match(app, /apiRequest\('\/api\/copilot\/settings'\)/);
        assert.match(app, /apiMutation\('\/api\/copilot\/settings',\s*\{[\s\S]*method:\s*'PUT'/);
        assert.match(app, /modelMode:\s*state\.copilotSettingsMode/);
        assert.match(app, /state\.copilotSettingsMode === 'override'/);
        assert.match(app, /apiMutation\('\/api\/copilot\/settings\/test',\s*\{[\s\S]*method:\s*'POST'/);
    });

    test('creates, lists, gets, streams, cancels, and retries durable sessions', () => {
        assert.match(app, /async function createCopilotSession\(/);
        assert.match(app, /async function loadCopilotSessions\(/);
        assert.match(app, /async function loadCopilotSession\(/);
        assert.match(app, /copilotPath\(projectId, '\/sessions'\)/);
        assert.match(app, /copilotPath\(projectId, `\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`\)/);
        assert.match(app, /selectedEvidenceIds:\s*\[\.\.\.state\.copilotSelectedEvidenceIds\]\.sort\(\)/);
        assert.match(app, /optionCount:\s*state\.copilotOptionCount/);
        assert.match(app, /instruction:\s*state\.copilotInstruction/);

        assert.match(app, /async function generateCopilotSession\(/);
        assert.match(
            app,
            /streamMutation\(\s*copilotPath\(projectId, `\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/generate`\)/,
        );
        assert.match(app, /Accept:\s*'application\/x-ndjson'/);
        assert.match(app, /response\.body\.getReader\(\)/);
        assert.match(app, /JSON\.parse\(line\)/);
        assert.match(app, /await onEvent\?\.\(event\)/);
        assert.match(app, /event\?\.type === 'delta'/);
        assert.match(app, /event\?\.type === 'done'/);
        assert.match(app, /event\?\.type === 'error'/);
        assert.match(app, /const completed = await streamMutation\(/);
        assert.match(
            app,
            /if \(!completed\) \{\s*throw new ApiError\('策划生成数据流提前结束', 502, \{ error: 'copilot_stream_ended' \}\);\s*\}/,
        );

        assert.match(app, /async function cancelCopilotGeneration\(/);
        assert.match(app, /\/cancel`/);
        assert.match(app, /function retryCopilotGeneration\(/);
        assert.match(app, /new AbortController\(\)/);
        const cancelSource = app.slice(
            app.indexOf('async function cancelCopilotGeneration('),
            app.indexOf('function retryCopilotGeneration('),
        );
        const cancelMutation = cancelSource.indexOf('await apiMutation(');
        const localAbort = cancelSource.indexOf('generationController.abort(');
        assert.ok(cancelMutation >= 0 && localAbort > cancelMutation,
            'The local generation stream must abort only after the cancel API succeeds.');
    });

    test('ignores buffered generation events after the active project, session, or controller changes', () => {
        const identitySource = app.slice(
            app.indexOf('function copilotGenerationIsCurrent('),
            app.indexOf('function resetCopilotWorkspace('),
        );
        assert.match(identitySource, /function copilotGenerationIsCurrent\(projectId, sessionId, controller\)/);
        assert.match(identitySource, /state\.project\?\.id === projectId/);
        assert.match(identitySource, /state\.copilotProjectId === projectId/);
        assert.match(identitySource, /state\.copilotSessionId === sessionId/);
        assert.match(identitySource, /state\.copilotGenerationController === controller/);

        const generationSource = app.slice(
            app.indexOf('async function generateCopilotSession('),
            app.indexOf('async function cancelCopilotGeneration('),
        );
        assert.match(generationSource, /const sessionId = session\.id/);
        assert.match(
            generationSource,
            /onEvent:\s*event\s*=>\s*\{\s*if \(!copilotGenerationIsCurrent\(projectId, sessionId, controller\)\) return;/,
        );
        assert.match(
            generationSource,
            /\);\s*if \(!copilotGenerationIsCurrent\(projectId, sessionId, controller\)\) return;\s*if \(!completed\) \{[\s\S]*copilot_stream_ended[\s\S]*\}\s*state\.copilotStream = '';\s*showToast\('策划候选已生成'\);/,
        );
        assert.match(
            generationSource,
            /\}\s*catch \(error\) \{\s*if \(!copilotGenerationIsCurrent\(projectId, sessionId, controller\)\) return;/,
        );
        assert.match(
            generationSource,
            /\}\s*finally\s*\{\s*if \(copilotGenerationIsCurrent\(projectId, sessionId, controller\)\) \{[\s\S]*state\.copilotGenerationController = null;[\s\S]*state\.copilotGenerating = false;[\s\S]*state\.copilotCancelling = false;[\s\S]*\}\s*\}/,
        );
    });

    test('reconciles interrupted sessions through an explicit CSRF-protected write before read-only GETs', () => {
        const loadSessions = app.slice(
            app.indexOf('async function loadCopilotSessions('),
            app.indexOf('async function loadCopilotWorkspace('),
        );
        const loadWorkspace = app.slice(
            app.indexOf('async function loadCopilotWorkspace('),
            app.indexOf('async function previewCopilotContext('),
        );
        for (const source of [loadSessions, loadWorkspace]) {
            assert.match(
                source,
                /apiMutation\(copilotPath\(projectId, '\/sessions\/reconcile'\),\s*\{[\s\S]*method:\s*'POST'[\s\S]*body:\s*\{\}/,
            );
            assert.doesNotMatch(source, /apiRequest\(copilotPath\(projectId, '\/sessions'\)\)/);
        }
    });

    test('hands one selected direction into a version-bound Workflow V2 run', () => {
        assert.match(app, /startWorkflow\.dataset\.copilotStartWorkflow\s*=\s*option\.id/);
        assert.match(app, /用此方向开始流程/);
        assert.match(app, /async function startWorkflowFromCopilot\(optionId,\s*retryDescriptor\s*=\s*null\)/);
        assert.match(app, /const eligibility = copilotHandoffEligibility\(\{ project, chapter, session, artifact \}\)/);
        assert.match(app, /if \(!eligibility\.eligible\)/);
        assert.match(app, /const savedEligibility = copilotHandoffEligibility\(/);
        assert.match(app, /if \(!savedEligibility\.eligible\)/);
        assert.match(app, /const commandId\s*=\s*retryDescriptor\?\.commandId\s*\|\|\s*copilotCommandId\('workflow'\)/);
        assert.match(app, /body:\s*\{\s*commandId,\s*definitionId:\s*DEFAULT_WORKFLOW_DEFINITION_ID/);
        assert.match(app, /definitionId:\s*DEFAULT_WORKFLOW_DEFINITION_ID/);
        assert.match(app, /projectVersion:\s*state\.project\.version/);
        assert.match(app, /chapterRevision:\s*state\.chapter\.revision/);
        assert.match(app, /input:\s*\{\s*copilotHandoff:\s*binding\s*\}/);
        assert.match(app, /state\.copilotRetry\s*=\s*\{\s*kind:\s*'handoff',\s*optionId:\s*option\.id,\s*commandId,\s*\}/);
        assert.match(app, /retry\?\.kind === 'handoff'[\s\S]*startWorkflowFromCopilot\(retry\.optionId,\s*retry\)/);
        assert.match(app, /bindWorkflowWorkspace\(state\.project, state\.chapter\)/);
        assert.match(app, /state\.workflowRunId\s*=\s*payload\?\.run\?\.id/);
        assert.match(app, /setView\('workflow'\)/);
        assert.match(app, /data-copilot-start-workflow/);
        assert.match(app, /startWorkflowFromCopilot\(startButton\.dataset\.copilotStartWorkflow\)/);

        const handoffSource = app.slice(
            app.indexOf('async function startWorkflowFromCopilot(optionId, retryDescriptor = null)'),
            app.indexOf('function renderQualityRunList('),
        );
        assert.doesNotMatch(handoffSource, /pendingChangeSetDigest\(binding\)|workflow\.copilot\.\$\{digest\}/,
            'A fresh handoff click must not derive its idempotency key from the selected direction.');
        const saveIndex = handoffSource.indexOf('await enqueueSave()');
        const savedEligibilityIndex = handoffSource.indexOf('const savedEligibility = copilotHandoffEligibility(');
        const mutationIndex = handoffSource.indexOf('await apiMutation(workflowRunsPath(');
        assert.ok(saveIndex >= 0 && savedEligibilityIndex > saveIndex && mutationIndex > savedEligibilityIndex,
            'Copilot handoff must save, re-check authority, and only then create the Workflow run.');
    });

    test('renders event-chain options and inert setting and Lorebook diffs without direct Canon writes', () => {
        assert.match(app, /function renderCopilotDirections\(/);
        assert.match(app, /copilotArtifact\(\)\?\.plotOptions/);
        assert.match(app, /option\.eventChain/);
        assert.match(app, /event\.characterChoice/);
        assert.match(app, /event\.directResult/);
        assert.match(app, /event\.cost/);
        assert.match(app, /function renderCopilotDiffs\(/);
        assert.match(app, /changeSet\?\.settingDiffs/);
        assert.match(app, /changeSet\?\.lorebookDiffs/);
        assert.match(app, /navigator\.clipboard\?\.writeText/);
        assert.match(app, /URL\.createObjectURL\(blob\)/);
        assert.match(app, /link\.download\s*=\s*`\$\{safeFileName\(state\.project\?\.title\s*\|\|\s*'story'\)\}-\$\{artifact\.id\}\.copilot\.json`/);
        assert.match(app, /window\.setTimeout\(\(\)\s*=>\s*URL\.revokeObjectURL\(url\),\s*1_000\)/);
        assert.match(app, /showToast\('策划包已导出'\)/);

        const copilotMarkup = html.match(/<section id="ss_copilot_view"[\s\S]*?<section id="ss_workflow_view"/)?.[0] ?? '';
        assert.ok(copilotMarkup, 'Copilot markup should be independently addressable.');
        assert.doesNotMatch(copilotMarkup, /id="ss_copilot_(?:apply|adopt)/i);
        assert.doesNotMatch(copilotMarkup, />\s*(?:应用|采纳)(?:方案|提案|修改|候选)?\s*</);
        assert.doesNotMatch(app, /(?:apply|adopt)Copilot(?:Artifact|Option|Diff|Session)/);
    });

    test('contains all controls and long artifacts at a 375px viewport', () => {
        assert.match(style, /#ss_shell\.is-copilot-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /#ss_shell\.is-copilot-view > \.ss-binder,[\s\S]*#ss_shell\.is-copilot-view > \.ss-inspector\s*\{[^}]*display:\s*none !important/);
        assert.match(style, /\.ss-copilot-view\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/);
        assert.match(style, /\.ss-copilot-workspace\s*\{[^}]*width:\s*min\(100%, 1560px\)[^}]*min-width:\s*0[^}]*grid-template-columns:\s*minmax\(320px, 420px\) minmax\(0, 1fr\)/);
        assert.match(style, /\.ss-copilot-stream\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /\.ss-copilot-event-chain dt,[\s\S]*\.ss-copilot-event-chain dd\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /\.ss-copilot-diff-comparison pre,[\s\S]*\.ss-workflow-diff-comparison pre\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*#ss_shell\.is-copilot-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*\.ss-copilot-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*padding-inline:\s*10px/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-copilot-selection-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-copilot-session-actions\s*\{[^}]*grid-template-columns:/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-copilot-session-actions \.ss-button\s*\{[^}]*width:\s*100%/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-copilot-direction-actions \.ss-button\s*\{[^}]*width:\s*100%/);
    });
});
