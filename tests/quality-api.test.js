import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

const LOCAL_HOST = '127.0.0.1:8123';
const FIXED_SUITE_ID = 'story-studio-public-webnovel-v1';

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

async function bootstrap(target) {
    return (await request(target)
        .get('/api/bootstrap')
        .set('Host', LOCAL_HOST)
        .expect(200)).body.csrfToken;
}

function digest(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('quality and built-in writing Profile HTTP API', () => {
    let dataRoot;
    let app;
    let csrfToken;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-quality-api-'));
        app = createApp({ dataRoot });
        csrfToken = await bootstrap(app);
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('lists and gets immutable built-ins, then persists an editable copy without activating it', async () => {
        const listed = await request(app)
            .get('/api/story-studio/prompt-profiles/builtins')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(listed.body.schemaVersion, 1);
        assert.equal(listed.body.profiles.length, 8);
        assert.equal(listed.body.genreOverlays.length, 5);
        assert.equal(listed.body.profiles.every(profile => profile.immutable === true), true);

        const sourceId = 'builtin.webnovel.draft.v1';
        const detail = await request(app)
            .get(`/api/story-studio/prompt-profiles/builtins/${sourceId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(detail.body.profile.id, sourceId);
        assert.equal(detail.body.profile.profileVersion, 2);
        assert.equal(detail.body.profile.compatibility.immutable, true);
        assert.equal(detail.body.profile.compatibility.builtinRevision, listed.body.builtinRevision);

        const created = await write(
            request(app).post('/api/story-studio/projects'),
            csrfToken,
        ).send({ title: '内置配方复制样本' }).expect(201);
        const copied = await write(
            request(app).post(
                `/api/story-studio/projects/${created.body.project.id}`
                + `/prompt-profiles/builtins/${sourceId}/copies`,
            ),
            csrfToken,
        ).send({
            projectVersion: created.body.project.version,
            name: '悬疑正文配方',
            genreOverlay: 'suspense-mystery',
        }).expect(201);

        const copiedProfile = copied.body.resource;
        assert.equal(copiedProfile.profileVersion, 2);
        assert.equal(copiedProfile.name, '悬疑正文配方');
        assert.equal(copiedProfile.variableValues.genreOverlay, 'suspense-mystery');
        assert.equal(copiedProfile.compatibility.immutable, false);
        assert.equal(copiedProfile.compatibility.copiedFrom, sourceId);
        assert.equal(copiedProfile.source.sourceProfileId, sourceId);
        assert.ok(copied.body.project.resources.promptProfileIds.includes(copiedProfile.id));
        assert.equal(copied.body.project.resources.activePromptProfileId, null);

        app = createApp({ dataRoot });
        csrfToken = await bootstrap(app);
        const persistedProject = await request(app)
            .get(`/api/story-studio/projects/${created.body.project.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        const persistedProfile = await request(app)
            .get(
                `/api/story-studio/projects/${created.body.project.id}`
                + `/resources/prompt-profile/${copiedProfile.id}`,
            )
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(persistedProject.body.resources.activePromptProfileId, null);
        assert.ok(persistedProject.body.resources.promptProfileIds.includes(copiedProfile.id));
        assert.equal(persistedProfile.body.id, copiedProfile.id);
        assert.equal(persistedProfile.body.compatibility.copiedFrom, sourceId);
        assert.equal(persistedProfile.body.variableValues.genreOverlay, 'suspense-mystery');

        const builtinAfterCopy = await request(app)
            .get(`/api/story-studio/prompt-profiles/builtins/${sourceId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(builtinAfterCopy.body.profile.compatibility.immutable, true);
        assert.deepEqual(builtinAfterCopy.body.profile.variableValues, {});
    });

    test('previews alternate chapter content without changing authority or writing a report', async () => {
        const created = await write(
            request(app).post('/api/story-studio/projects'),
            csrfToken,
        ).send({ title: '质量预览样本' }).expect(201);
        const projectId = created.body.project.id;
        const chapterId = created.body.chapter.id;
        const originalContent = '林照把铜钥匙藏进袖口，站在赤门外等待守军换岗。';
        const saved = await write(
            request(app).patch(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`),
            csrfToken,
        ).send({
            projectVersion: created.body.project.version,
            revision: created.body.chapter.revision,
            changes: { content: originalContent },
        }).expect(200);
        const previewContent = '下一章，林照将直接闯入赤门。';

        const preview = await write(
            request(app).post(
                `/api/story-studio/projects/${projectId}/chapters/${chapterId}/quality-preview`,
            ),
            csrfToken,
        ).send({
            projectVersion: saved.body.project.version,
            chapterRevision: saved.body.chapter.revision,
            content: previewContent,
        }).expect(200);
        assert.equal(preview.body.kind, 'chapter-quality-preview');
        assert.equal(preview.body.authority.contentDigest, digest(previewContent));
        assert.equal(preview.body.report.contentDigest, digest(previewContent));
        assert.ok(preview.body.report.issues.some(issue => issue.ruleId === 'premature-next-chapter'));

        const chapterAfterPreview = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(chapterAfterPreview.body.content, originalContent);
        assert.equal(chapterAfterPreview.body.revision, saved.body.chapter.revision);

        const listed = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/quality-reports`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(listed.body, { reports: [], corrupt: [] });
        const reportDirectory = path.join(
            dataRoot,
            'quality',
            'projects',
            projectId,
            'chapters',
            chapterId,
            'reports',
        );
        assert.equal(fs.existsSync(reportDirectory), false);

        app = createApp({ dataRoot });
        csrfToken = await bootstrap(app);
        const afterRestart = await request(app)
            .get(`/api/story-studio/projects/${projectId}/chapters/${chapterId}/quality-reports`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(afterRestart.body, { reports: [], corrupt: [] });
    });

    test('persists chapter reports and rejects stale project or chapter authority versions', async () => {
        const created = await write(
            request(app).post('/api/story-studio/projects'),
            csrfToken,
        ).send({ title: '章节质量报告样本', genre: '都市异能' }).expect(201);
        const projectId = created.body.project.id;
        const chapterId = created.body.chapter.id;
        const content = '许砚推开档案室的门，把公开卷宗逐页拍下，没有替未知事实补结论。';
        const saved = await write(
            request(app).patch(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`),
            csrfToken,
        ).send({
            projectVersion: created.body.project.version,
            revision: created.body.chapter.revision,
            changes: { title: '档案室', content },
        }).expect(200);
        const authority = {
            projectVersion: saved.body.project.version,
            chapterRevision: saved.body.chapter.revision,
        };
        const reportPath = `/api/story-studio/projects/${projectId}/chapters/${chapterId}/quality-reports`;

        const createdReport = await write(request(app).post(reportPath), csrfToken).send({
            ...authority,
            source: { type: 'chapter' },
        }).expect(201);
        assert.equal(createdReport.body.kind, 'chapter-quality');
        assert.deepEqual(createdReport.body.source, { type: 'chapter', generationId: null });
        assert.equal(createdReport.body.input.content, content);
        assert.equal(createdReport.body.authority.contentDigest, digest(content));
        assert.match(createdReport.body.recordHash, /^[0-9a-f]{64}$/u);

        const reportFile = path.join(
            dataRoot,
            'quality',
            'projects',
            projectId,
            'chapters',
            chapterId,
            'reports',
            `${createdReport.body.id}.json`,
        );
        assert.equal(fs.existsSync(reportFile), true);
        const listed = await request(app).get(reportPath).set('Host', LOCAL_HOST).expect(200);
        assert.equal(listed.body.reports.length, 1);
        assert.equal(listed.body.reports[0].id, createdReport.body.id);
        assert.equal(listed.body.reports[0].reportDigest, createdReport.body.report.reportDigest);

        const fetched = await request(app)
            .get(`${reportPath}/${createdReport.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(fetched.body, createdReport.body);

        app = createApp({ dataRoot });
        csrfToken = await bootstrap(app);
        const afterRestart = await request(app)
            .get(`${reportPath}/${createdReport.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(afterRestart.body, createdReport.body);

        const changedProject = await write(
            request(app).patch(`/api/story-studio/projects/${projectId}`),
            csrfToken,
        ).send({
            version: authority.projectVersion,
            changes: { genre: '悬疑探秘' },
        }).expect(200);
        const staleProject = await write(request(app).post(reportPath), csrfToken).send({
            ...authority,
            source: { type: 'chapter' },
        }).expect(409);
        assert.equal(staleProject.body.error, 'project_conflict');
        assert.equal(staleProject.body.currentVersion, changedProject.body.version);

        const changedChapter = await write(
            request(app).patch(`/api/story-studio/projects/${projectId}/chapters/${chapterId}`),
            csrfToken,
        ).send({
            projectVersion: changedProject.body.version,
            revision: authority.chapterRevision,
            changes: { notes: '权威版本已推进。' },
        }).expect(200);
        const staleChapter = await write(request(app).post(reportPath), csrfToken).send({
            projectVersion: changedChapter.body.project.version,
            chapterRevision: authority.chapterRevision,
            source: { type: 'chapter' },
        }).expect(409);
        assert.equal(staleChapter.body.error, 'chapter_conflict');
        assert.equal(staleChapter.body.currentRevision, changedChapter.body.chapter.revision);

        const historical = await request(app)
            .get(`${reportPath}/${createdReport.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(historical.body, createdReport.body);
    });

    test('exposes the fixed regression suite and baseline, then persists a run and comparison', async () => {
        const suite = await request(app)
            .get('/api/story-studio/quality-regression/suite')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(suite.body.schemaVersion, 1);
        assert.equal(suite.body.suite.id, FIXED_SUITE_ID);
        assert.equal(suite.body.suite.revision, 2);
        assert.equal(suite.body.suite.cases.length, 10);
        assert.equal(suite.body.suite.cases.every(item => (
            Object.keys(item).sort().join(',') === 'genreOverlay,id,title'
        )), true);

        const baseline = await request(app)
            .get('/api/story-studio/quality-regression/baseline')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(baseline.body.suite.id, FIXED_SUITE_ID);
        assert.equal(baseline.body.metrics.cases, suite.body.suite.cases.length);
        assert.equal(baseline.body.metrics.casePassRate, 1);
        assert.equal(baseline.body.metrics.profileCompilations, 48);
        assert.equal(baseline.body.metrics.profileCompileRate, 1);
        assert.equal(Object.hasOwn(baseline.body, 'generatedAt'), false);
        assert.match(baseline.body.reportDigest, /^[0-9a-f]{64}$/u);

        const inheritedRun = await write(
            request(app).post('/api/story-studio/quality-regression/runs'),
            csrfToken,
        ).send({}).expect(201);
        assert.equal(inheritedRun.body.report.modelBinding.providerProtocol, 'openai-chat');
        assert.equal(inheritedRun.body.report.modelBinding.model, 'none');
        assert.deepEqual(Object.keys(inheritedRun.body.report.modelBinding.parameters).sort(), [
            'contextWindow', 'outputLimit', 'structuredOutput', 'temperature', 'topK', 'topP',
        ]);

        const run = await write(
            request(app).post('/api/story-studio/quality-regression/runs'),
            csrfToken,
        ).send({
            modelBinding: {
                providerProtocol: 'deterministic',
                model: 'quality-api-fixture',
                parameters: {
                    temperature: 0,
                    seed: 7,
                    headers: { accept: 'application/json' },
                },
            },
        }).expect(201);
        assert.equal(run.body.kind, 'quality-regression');
        assert.equal(run.body.suiteId, FIXED_SUITE_ID);
        assert.equal(run.body.report.suite.digest, baseline.body.suite.digest);
        assert.equal(run.body.report.modelBinding.model, 'quality-api-fixture');
        assert.equal(run.body.report.metrics.casePassRate, 1);
        assert.equal(run.body.report.metrics.profileCompileRate, 1);
        assert.ok(Number.isFinite(Date.parse(run.body.report.generatedAt)));
        assert.match(run.body.recordHash, /^[0-9a-f]{64}$/u);

        const runList = await request(app)
            .get('/api/story-studio/quality-regression/runs')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(runList.body.runs.length, 2);
        assert.deepEqual(
            new Set(runList.body.runs.map(item => item.id)),
            new Set([inheritedRun.body.id, run.body.id]),
        );

        app = createApp({ dataRoot });
        csrfToken = await bootstrap(app);
        const persistedRun = await request(app)
            .get(`/api/story-studio/quality-regression/runs/${run.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(persistedRun.body, run.body);

        const comparison = await write(
            request(app).post('/api/story-studio/quality-regression/comparisons'),
            csrfToken,
        ).send({ candidateRunId: run.body.id }).expect(201);
        assert.equal(comparison.body.kind, 'quality-regression-comparison');
        assert.equal(comparison.body.suiteId, FIXED_SUITE_ID);
        assert.equal(comparison.body.candidateRunId, run.body.id);
        assert.deepEqual(comparison.body.baseline, {
            type: 'fixture',
            id: FIXED_SUITE_ID,
            reportDigest: baseline.body.reportDigest,
        });
        assert.equal(comparison.body.comparison.passed, true);
        assert.equal(comparison.body.comparison.gates.every(gate => gate.passed), true);
        assert.match(comparison.body.comparison.comparisonDigest, /^[0-9a-f]{64}$/u);

        const comparisonList = await request(app)
            .get('/api/story-studio/quality-regression/comparisons')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(comparisonList.body.comparisons.length, 1);
        assert.equal(comparisonList.body.comparisons[0].id, comparison.body.id);
        const persistedComparison = await request(app)
            .get(`/api/story-studio/quality-regression/comparisons/${comparison.body.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(persistedComparison.body, comparison.body);
    });

    test('rejects regression suite, profile, timestamp, and nested-secret injection without saving a run', async () => {
        for (const [field, value] of [
            ['suite', { id: 'attacker-suite', cases: [] }],
            ['profiles', [{ id: 'attacker-profile' }]],
            ['generatedAt', '2000-01-01T00:00:00.000Z'],
        ]) {
            const response = await write(
                request(app).post('/api/story-studio/quality-regression/runs'),
                csrfToken,
            ).send({ [field]: value }).expect(400);
            assert.equal(response.body.error, 'unknown_quality_fields');
            assert.deepEqual(response.body.fields, [field]);
        }

        for (const parameters of [
            { transport: { headers: { authorization: 'Bearer TOKEN' } } },
            { nested: [{ credentials: { apiKey: 'TOKEN' } }] },
            { nested: { deeper: { secret: 'TOKEN' } } },
        ]) {
            const response = await write(
                request(app).post('/api/story-studio/quality-regression/runs'),
                csrfToken,
            ).send({
                modelBinding: {
                    providerProtocol: 'deterministic',
                    model: 'injected-model',
                    parameters,
                },
            }).expect(400);
            assert.equal(response.body.error, 'invalid_quality_regression');
            assert.match(response.body.message, /secret field/iu);
        }

        const runs = await request(app)
            .get('/api/story-studio/quality-regression/runs')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(runs.body, { runs: [], corrupt: [] });
        const suiteAfterInjection = await request(app)
            .get('/api/story-studio/quality-regression/suite')
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(suiteAfterInjection.body.suite.id, FIXED_SUITE_ID);
        assert.equal(suiteAfterInjection.body.suite.revision, 2);
    });
});
