import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

describe('first-class quality workspace UI contract', () => {
    test('mounts a top-level quality workspace and binds it to navigation lifecycle', () => {
        assert.match(html, /id="ss_quality_tab"[^>]*data-ss-view="quality"[^>]*aria-controls="ss_quality_view"/);
        assert.match(html, /id="ss_quality_view"[^>]*role="tabpanel"[^>]*aria-labelledby="ss_quality_tab"/);
        for (const id of [
            'ss_quality_status',
            'ss_quality_refresh',
            'ss_quality_no_project',
            'ss_quality_workspace',
            'ss_quality_profile_catalog',
            'ss_quality_overlay_catalog',
            'ss_quality_copy_name',
            'ss_quality_copy_overlay',
            'ss_quality_copy_profile',
            'ss_quality_preview',
            'ss_quality_save_report',
            'ss_quality_issue_list',
            'ss_quality_report_select',
            'ss_quality_open_report',
            'ss_quality_run_regression',
            'ss_quality_run_select',
            'ss_quality_open_run',
            'ss_quality_compare_baseline',
            'ss_quality_gate_list',
            'ss_quality_error',
            'ss_quality_retry',
        ]) assert.match(html, new RegExp(`id="${id}"`));

        assert.match(app, /quality:\s*elements\.ss_quality_view/);
        assert.match(app, /\['today', 'write', 'bible', 'ledger', 'copilot', 'workflow', 'resources'\]\.includes\(view\)[\s\S]*view !== 'quality'/);
        assert.match(app, /classList\.toggle\('is-quality-view', state\.view === 'quality'\)/);
        assert.match(app, /if \(view === 'quality'\)\s*\{\s*bindQualityWorkspace\(state\.project, state\.chapter\);\s*void loadQualityWorkspace\(\);/);
        assert.match(app, /renderProjectData\(\)[\s\S]*renderQualityWorkspace\(\);[\s\S]*renderViewState\(\);/);
        assert.match(app, /setLoadedProject\(project, chapter\)[\s\S]*bindQualityWorkspace\(project, chapter\)/);
        assert.match(app, /loadChapter\(chapterId,[\s\S]*bindQualityWorkspace\(state\.project, chapter\)/);
        assert.match(app, /bindQualityWorkspace\(null, null\)/);
    });

    test('browses eight immutable Profiles and five overlays and copies a named overlay variant', () => {
        assert.match(html, /8 套不可覆盖的写作 Profile/);
        assert.match(html, /5 种类型约束/);
        assert.match(app, /apiRequest\(`\$\{API_ROOT\}\/prompt-profiles\/builtins`\)/);
        assert.match(app, /apiRequest\(`\$\{API_ROOT\}\/prompt-profiles\/builtins\/\$\{encodeURIComponent\(profileId\)\}`\)/);
        assert.match(app, /function renderQualityProfileCatalog\(/);
        assert.match(app, /state\.qualityProfiles/);
        assert.match(app, /state\.qualityOverlays/);
        assert.match(app, /detail\.modules\?\.find\(module => module\.id\?\.startsWith\('contract-'\)\)/);
        assert.match(app, /dataset\.qualityProfileId\s*=\s*profile\.id/);
        assert.match(app, /dataset\.qualityOverlayId\s*=\s*overlay\.id/);

        const copySource = app.slice(
            app.indexOf('async function copyQualityProfile('),
            app.indexOf('async function previewCurrentChapterQuality('),
        );
        assert.match(copySource, /\/prompt-profiles\/builtins\/\$\{encodeURIComponent\(profileId\)\}\/copies/);
        assert.match(copySource, /apiMutation\(/);
        assert.match(copySource, /projectVersion:\s*state\.project\.version/);
        assert.match(copySource, /name:\s*elements\.ss_quality_copy_name\.value\.trim\(\)/);
        assert.match(copySource, /genreOverlay:\s*state\.qualityOverlayId/);
        assert.match(copySource, /acceptServerProject\(result\.project\);/);
        assert.doesNotMatch(copySource, /acceptServerProject\([^)]*new Set\(\)/);
        assert.match(copySource, /result\.resource\?\.name/);

        assert.match(app, /ss_quality_profile_catalog\.addEventListener\('click'/);
        assert.match(app, /ss_quality_overlay_catalog\.addEventListener\('click'/);
        assert.match(app, /ss_quality_copy_overlay\.addEventListener\('change'/);
        assert.match(app, /ss_quality_copy_profile\.addEventListener\('click',\s*\(\) => void copyQualityProfile\(\)\)/);
    });

    test('previews current text and persists, lists, and opens authority-bound chapter reports', () => {
        assert.match(app, /function qualityChapterPath\(projectId, chapterId, suffix = ''\)/);
        const previewSource = app.slice(
            app.indexOf('async function previewCurrentChapterQuality('),
            app.indexOf('async function saveCurrentChapterQualityReport('),
        );
        assert.match(previewSource, /qualityChapterPath\(projectId, chapterId, '-preview'\)/);
        assert.match(previewSource, /method:\s*'POST'/);
        assert.match(previewSource, /projectVersion:\s*state\.project\.version/);
        assert.match(previewSource, /chapterRevision:\s*state\.chapter\.revision/);
        assert.match(previewSource, /content:\s*state\.chapter\.content/);
        assert.match(previewSource, /state\.qualityPreview\s*=\s*preview/);
        assert.match(previewSource, /state\.qualityReport\s*=\s*null/);

        const reportSource = app.slice(
            app.indexOf('async function saveCurrentChapterQualityReport('),
            app.indexOf('async function runFixedQualityRegression('),
        );
        assert.match(reportSource, /await enqueueSave\(\)/);
        assert.match(reportSource, /qualityChapterPath\(projectId, chapterId, '-reports'\)/);
        assert.match(reportSource, /source:\s*\{\s*type:\s*'chapter'\s*\}/);
        assert.match(reportSource, /qualityReportSummary\(record\)/);
        assert.match(reportSource, /`-reports\/\$\{encodeURIComponent\(reportId\)\}`/);
        assert.match(reportSource, /state\.qualityReport\s*=\s*record/);

        assert.match(app, /issue\.severity/);
        assert.match(app, /issue\.ruleId/);
        assert.match(app, /Number\(issue\.paragraphIndex \|\| 0\) \+ 1/);
        assert.match(app, /issue\.quote/);
        assert.match(app, /issue\.suggestion/);
        assert.match(app, /issue\.evidenceIds/);
        assert.match(app, /UTF-16 \$\{issue\.start\}–\$\{issue\.end\}/);
        assert.match(app, /ss_quality_refresh_reports\.addEventListener\('click'/);
        assert.match(app, /ss_quality_report_select\.addEventListener\('change'/);
        assert.match(app, /ss_quality_open_report\.addEventListener\('click'/);
    });

    test('loads the fixed baseline, runs the public suite, opens runs, and displays every comparison gate', () => {
        const loadSource = app.slice(
            app.indexOf('async function loadQualityWorkspace('),
            app.indexOf('async function copyQualityProfile('),
        );
        assert.match(loadSource, /qualityRegressionPath\('\/suite'\)/);
        assert.match(loadSource, /qualityRegressionPath\('\/baseline'\)/);
        assert.match(loadSource, /qualityRegressionPath\('\/runs'\)/);

        const regressionSource = app.slice(
            app.indexOf('async function runFixedQualityRegression('),
            app.indexOf('function retryQualityAction('),
        );
        assert.match(regressionSource, /apiMutation\(qualityRegressionPath\('\/runs'\)/);
        assert.match(regressionSource, /body:\s*\{\}/);
        assert.match(regressionSource, /apiRequest\(qualityRegressionPath\(`\/runs\/\$\{encodeURIComponent\(runId\)\}`\)\)/);
        assert.match(regressionSource, /apiMutation\(qualityRegressionPath\('\/comparisons'\)/);
        assert.match(regressionSource, /body:\s*\{\s*candidateRunId:\s*runId\s*\}/);

        assert.match(app, /function renderQualityRegression\(/);
        assert.match(app, /comparison\.gates/);
        assert.match(app, /gate\.baseline/);
        assert.match(app, /gate\.candidate/);
        assert.match(app, /gate\.delta/);
        assert.match(app, /comparison\.profileDiffs/);
        assert.match(app, /comparison\.passed \? '门禁通过' : '门禁阻断'/);
        assert.match(app, /ss_quality_run_regression\.addEventListener\('click'/);
        assert.match(app, /ss_quality_run_select\.addEventListener\('change'/);
        assert.match(app, /ss_quality_open_run\.addEventListener\('click'/);
        assert.match(app, /ss_quality_compare_baseline\.addEventListener\('click'/);
    });

    test('guards stale bindings and exposes busy, error, no-project, and retry states', () => {
        assert.match(app, /function qualityBindingMatches\(projectId, chapterId\)/);
        assert.match(app, /function qualityRequestIsCurrent\(projectId, chapterId, requestSerial\)/);
        assert.match(app, /state\.qualityRequestSerial === requestSerial/);
        assert.match(app, /function resetQualityWorkspace\(/);
        assert.match(app, /state\.qualityLoading = false/);
        assert.match(app, /state\.qualityBusy = false/);
        assert.match(app, /function setQualityError\(error, retry\)/);
        assert.match(app, /function retryQualityAction\(/);
        for (const kind of [
            'profile',
            'copy-profile',
            'preview',
            'save-report',
            'reports',
            'report',
            'run-regression',
            'run',
            'compare',
        ]) assert.match(app, new RegExp(`retry\\.kind === '${kind}'`));
        assert.match(app, /ss_quality_workspace\.toggleAttribute\('aria-busy', locked\)/);
        assert.match(app, /ss_quality_error\.hidden = !state\.qualityError/);
        assert.match(app, /ss_quality_no_project\.hidden = hasProject/);
        assert.match(app, /ss_quality_workspace\.hidden = !hasProject/);
        assert.match(app, /ss_quality_retry\.addEventListener\('click', retryQualityAction\)/);
        assert.match(app, /beforeunload[\s\S]*!state\.qualityBusy/);
    });

    test('contains long quality artifacts without horizontal overflow at 375x812', () => {
        assert.match(style, /#ss_shell\.is-quality-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /#ss_shell\.is-quality-view > \.ss-binder,[\s\S]*#ss_shell\.is-quality-view > \.ss-inspector\s*\{[^}]*display:\s*none !important/);
        assert.match(style, /\.ss-quality-view\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/);
        assert.match(style, /\.ss-quality-workspace\s*\{[^}]*width:\s*min\(100%, 1500px\)[^}]*min-width:\s*0[^}]*grid-template-columns:\s*minmax\(320px, 5fr\) minmax\(420px, 7fr\)/);
        assert.match(style, /\.ss-quality-profile-detail pre\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /\.ss-quality-issue blockquote\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*#ss_shell\.is-quality-view\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*820px\)[\s\S]*\.ss-quality-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*padding-inline:\s*10px/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-quality-profile-catalog,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
        assert.match(style, /@media\s*\(max-width:\s*480px\)[\s\S]*\.ss-quality-gate,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    });
});
