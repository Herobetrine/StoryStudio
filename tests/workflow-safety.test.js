import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { StoryStudioStore } from '../src/story-studio-store.js';
import { WorkflowService } from '../src/workflow-service.js';
import { WorkflowStore } from '../src/workflow-store.js';

const LOCAL_HOST = '127.0.0.1:8123';

function write(builder, csrfToken) {
    return builder.set('Host', LOCAL_HOST).set('X-CSRF-Token', csrfToken);
}

describe('declarative workflow safety boundaries', () => {
    let app;
    let csrfToken;
    let dataRoot;
    let definition;
    let sequence;

    beforeEach(async () => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-workflow-safety-'));
        app = createApp({
            dataRoot,
            fetchImplementation: async () => {
                throw new Error('Safety tests must not call a model provider.');
            },
        });
        csrfToken = (await request(app)
            .get('/api/bootstrap')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.csrfToken;
        definition = (await request(app)
            .get('/api/story-studio/workflows/definitions')
            .set('Host', LOCAL_HOST)
            .expect(200)).body.definitions.find(item => item.id === 'builtin.chapter-cycle.v1');
        sequence = 0;
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    async function createProject(title = '工作流安全测试') {
        const response = await write(request(app).post('/api/story-studio/projects'), csrfToken)
            .send({
                title,
                genre: '玄幻',
                story: {
                    logline: '林照必须在赤门关闭前进入地下书库。',
                    premise: '每次开门都要承担可见代价。',
                },
            })
            .expect(201);
        return {
            project: response.body.project,
            chapter: response.body.chapter,
            projectPath: `/api/story-studio/projects/${response.body.project.id}`,
            chapterPath: `/api/story-studio/projects/${response.body.project.id}/chapters/${response.body.chapter.id}`,
        };
    }

    async function startRun(fixture, commandId = `start-${++sequence}`) {
        const response = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs`),
            csrfToken,
        ).send({
            commandId,
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: fixture.project.version,
            chapterRevision: fixture.chapter.revision,
            input: {},
        }).expect(201);
        return response.body;
    }

    async function execute(fixture, view, payload = {}, options = {}) {
        const body = {
            commandId: options.commandId ?? `command-${++sequence}`,
            runRevision: options.runRevision ?? view.run.revision,
            type: options.type ?? 'execute',
            payload,
        };
        const response = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(body);
        return { response, body };
    }

    async function advanceToCardApproval(fixture, view) {
        let result = await execute(fixture, view);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'propose-card');

        result = await execute(fixture, view);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'approve-card');
        assert.equal(view.currentArtifact.status, 'candidate');
        return view;
    }

    function artifactBinding(view) {
        return {
            artifactId: view.currentArtifact.id,
            artifactHash: view.currentArtifact.bindingHash,
        };
    }

    async function readAuthority(fixture) {
        const [project, chapter] = await Promise.all([
            request(app).get(fixture.projectPath).set('Host', LOCAL_HOST).expect(200),
            request(app).get(fixture.chapterPath).set('Host', LOCAL_HOST).expect(200),
        ]);
        return { project: project.body, chapter: chapter.body };
    }

    test('cannot skip approval and apply a candidate artifact', async () => {
        const fixture = await createProject('未审批应用');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);
        const baseline = await readAuthority(fixture);

        const attemptedApply = await execute(fixture, view, {
            stepId: 'apply-card',
            ...artifactBinding(view),
        });

        assert.equal(attemptedApply.response.status, 409);
        assert.equal(attemptedApply.response.body.error, 'workflow_step_changed');
        const after = await readAuthority(fixture);
        assert.equal(after.project.version, baseline.project.version);
        assert.equal(after.chapter.revision, baseline.chapter.revision);
        assert.deepEqual(after.chapter.card, baseline.chapter.card);

        const unchangedRun = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(unchangedRun.body.run.currentStepId, 'approve-card');
        assert.equal(unchangedRun.body.currentArtifact.status, 'candidate');
    });

    test('rejects forged or malformed artifact hashes without approving the candidate', async () => {
        const fixture = await createProject('Artifact Hash 绑定');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);
        const baseline = await readAuthority(fixture);

        const forged = await execute(fixture, view, {
            artifactId: view.currentArtifact.id,
            artifactHash: 'f'.repeat(64),
        });
        assert.equal(forged.response.status, 409);
        assert.equal(forged.response.body.error, 'workflow_artifact_changed');

        const malformed = await execute(fixture, view, {
            artifactId: view.currentArtifact.id,
            artifactHash: 'not-a-sha256',
        });
        assert.equal(malformed.response.status, 400);
        assert.equal(malformed.response.body.error, 'invalid_workflow_hash');

        const after = await readAuthority(fixture);
        assert.equal(after.project.version, baseline.project.version);
        assert.equal(after.chapter.revision, baseline.chapter.revision);
        const unchangedRun = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(unchangedRun.body.currentArtifact.status, 'candidate');
        assert.equal(unchangedRun.body.run.revision, view.run.revision);
    });

    test('does not expose or execute a run through another project or chapter route', async () => {
        const fixture = await createProject('归属项目');
        const view = await startRun(fixture);

        const secondChapterResponse = await write(
            request(app).post(`${fixture.projectPath}/chapters`),
            csrfToken,
        ).send({
            projectVersion: fixture.project.version,
            chapter: { title: '第二章' },
        }).expect(201);
        const secondChapterPath = `${fixture.projectPath}/chapters/${secondChapterResponse.body.chapter.id}`;
        const other = await createProject('其他项目');

        await request(app)
            .get(`${secondChapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(404);
        await request(app)
            .get(`${other.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(404);

        const crossChapterCommand = await write(
            request(app).post(`${secondChapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            commandId: 'cross-chapter-command',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {},
        });
        assert.equal(crossChapterCommand.status, 404);

        const crossProjectCommand = await write(
            request(app).post(`${other.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            commandId: 'cross-project-command',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {},
        });
        assert.equal(crossProjectCommand.status, 404);

        const otherRuns = await request(app)
            .get(`${other.chapterPath}/workflow-runs`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.deepEqual(otherRuns.body.runs, []);
    });

    test('scopes deterministic artifacts to sequential runs on the same authority snapshot', async () => {
        const fixture = await createProject('顺序运行 Artifact 隔离');
        let first = await startRun(fixture, 'same-snapshot-run-one');
        const blockedSecond = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs`),
            csrfToken,
        ).send({
            commandId: 'same-snapshot-run-two-before-cancel',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            projectVersion: fixture.project.version,
            chapterRevision: fixture.chapter.revision,
            input: {},
        });
        assert.equal(blockedSecond.status, 409);
        assert.equal(blockedSecond.body.error, 'workflow_active_run_exists');

        let result = await execute(fixture, first);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        first = result.response.body;
        const firstDiagnosisArtifact = first.artifact;

        result = await execute(fixture, first);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        first = result.response.body;
        const firstCardArtifact = first.currentArtifact;
        assert.equal(first.run.currentStepId, 'approve-card');

        const cancelled = await execute(fixture, first, {
            stepId: first.run.currentStepId,
            reason: '首个运行完成 Artifact 隔离取样后释放章节写锁。',
        }, {
            commandId: 'cancel-same-snapshot-run-one',
            type: 'cancel',
        });
        assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.response.body));
        assert.equal(cancelled.response.body.run.status, 'cancelled');

        let second = await startRun(fixture, 'same-snapshot-run-two');
        result = await execute(fixture, second);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        second = result.response.body;
        const secondDiagnosisArtifact = second.artifact;
        result = await execute(fixture, second);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        second = result.response.body;
        const secondCardArtifact = second.currentArtifact;

        assert.equal(first.authority.projectVersion, second.authority.projectVersion);
        assert.equal(first.authority.chapterRevision, second.authority.chapterRevision);
        assert.notEqual(firstDiagnosisArtifact.id, secondDiagnosisArtifact.id);
        assert.equal(firstDiagnosisArtifact.runId, first.run.id);
        assert.equal(secondDiagnosisArtifact.runId, second.run.id);
        assert.equal(first.run.currentStepId, 'approve-card');
        assert.equal(second.run.currentStepId, 'approve-card');
        assert.notEqual(firstCardArtifact.id, secondCardArtifact.id);
        assert.equal(firstCardArtifact.runId, first.run.id);
        assert.equal(secondCardArtifact.runId, second.run.id);
    });

    test('binds commandId to the exact payload while allowing an identical replay', async () => {
        const fixture = await createProject('命令幂等边界');
        const view = await startRun(fixture);
        const command = {
            commandId: 'same-command-id',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {},
        };

        const first = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        const replay = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        assert.equal(replay.body.command.replayed, true);
        assert.equal(replay.body.run.revision, first.body.run.revision);

        const changed = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            ...command,
            payload: { instruction: 'reuse the id with different bytes' },
        });
        assert.equal(changed.status, 409);
        assert.equal(changed.body.error, 'workflow_command_conflict');

        const after = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(after.body.run.revision, first.body.run.revision);
        assert.equal(after.body.run.currentStepId, 'propose-card');
    });

    test('blocks a stale workflow from applying after an external chapter PATCH', async () => {
        const fixture = await createProject('外部编辑冲突');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);
        const binding = artifactBinding(view);

        const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: fixture.project.version,
            revision: fixture.chapter.revision,
            changes: { card: { goal: '外部编辑后的新目标' } },
        }).expect(200);

        const approved = await execute(fixture, view, binding);
        assert.equal(approved.response.status, 200, JSON.stringify(approved.response.body));
        view = approved.response.body;
        assert.equal(view.run.currentStepId, 'apply-card');
        assert.equal(view.currentArtifact.status, 'approved');

        const staleApply = await execute(fixture, view, artifactBinding(view));
        assert.equal(staleApply.response.status, 409);
        assert.equal(staleApply.response.body.error, 'workflow_authority_changed');

        const after = await readAuthority(fixture);
        assert.equal(after.project.version, external.body.project.version);
        assert.equal(after.chapter.revision, external.body.chapter.revision);
        assert.equal(after.chapter.card.goal, '外部编辑后的新目标');
        const blockedRun = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(blockedRun.body.run.currentStepId, 'apply-card');
        assert.equal(blockedRun.body.currentArtifact.status, 'approved');
    });

    test('does not absorb unrelated edits when an external PATCH happens to match the card target', async () => {
        const fixture = await createProject('目标相同但无关字段变化');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);
        let result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'apply-card');
        const baseline = await readAuthority(fixture);
        const targetCard = { ...baseline.chapter.card, ...view.currentArtifact.payload.patch };

        const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: baseline.project.version,
            revision: baseline.chapter.revision,
            changes: {
                card: targetCard,
                notes: '这是与流程无关的并发备注。',
            },
        }).expect(200);

        result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 409);
        assert.equal(result.response.body.error, 'workflow_authority_changed');
        const after = await readAuthority(fixture);
        assert.equal(after.project.version, external.body.project.version);
        assert.equal(after.chapter.revision, external.body.chapter.revision);
        assert.deepEqual(after.chapter.card, targetCard);
        assert.equal(after.chapter.notes, '这是与流程无关的并发备注。');
        const blocked = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(blocked.body.run.currentStepId, 'apply-card');
        assert.equal(blocked.body.currentArtifact.status, 'approved');
    });

    test('recovers an applied artifact crash with the original bindingHash and exact command', async () => {
        const fixture = await createProject('Binding Hash 故障恢复');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);

        let approval = await execute(fixture, view, artifactBinding(view));
        assert.equal(approval.response.status, 200, JSON.stringify(approval.response.body));
        view = approval.response.body;
        assert.equal(view.run.currentStepId, 'apply-card');
        assert.equal(view.currentArtifact.status, 'approved');
        assert.equal(view.currentArtifact.payload.noOp, false);

        const originalBindingHash = view.currentArtifact.bindingHash;
        const approvedRecordHash = view.currentArtifact.recordHash;
        const command = {
            commandId: 'recover-applied-artifact-crash',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {
                stepId: 'apply-card',
                artifactId: view.currentArtifact.id,
                artifactHash: originalBindingHash,
            },
        };
        const authorityBeforeCrash = await readAuthority(fixture);
        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story-studio'), {
            migrationBackupsDirectory: path.join(dataRoot, 'migration-backups'),
        });
        const crashingService = new WorkflowService({
            workflowStore,
            storyStore,
            generationService: {},
        });
        const simulatedCrash = new Error('simulated crash before workflow run receipt commit');
        crashingService.completeStep = () => {
            throw simulatedCrash;
        };

        await assert.rejects(
            () => crashingService.executeCommand(
                fixture.project.id,
                fixture.chapter.id,
                view.run.id,
                command,
            ),
            error => error === simulatedCrash,
        );

        const persistedArtifact = workflowStore.getArtifact(
            fixture.project.id, view.run.id, view.currentArtifact.id,
        );
        const uncommittedRun = workflowStore.getRun(fixture.project.id, view.run.id);
        const receiptPath = workflowStore.receiptPath(command.commandId);
        const authorityAfterCrash = await readAuthority(fixture);
        assert.equal(persistedArtifact.status, 'applied');
        assert.notEqual(persistedArtifact.recordHash, approvedRecordHash);
        assert.equal(uncommittedRun.currentStepId, 'apply-card');
        assert.equal(uncommittedRun.revision, command.runRevision);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(authorityAfterCrash.project.version, authorityBeforeCrash.project.version + 1);
        assert.equal(authorityAfterCrash.chapter.revision, authorityBeforeCrash.chapter.revision + 1);
        assert.deepEqual(authorityAfterCrash.chapter.card, {
            ...authorityBeforeCrash.chapter.card,
            ...persistedArtifact.payload.patch,
        });

        const recovered = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        assert.equal(recovered.body.run.currentStepId, 'draft');
        assert.equal(recovered.body.command.replayed, false);
        assert.equal(recovered.body.artifact.status, 'applied');
        assert.equal(recovered.body.artifact.bindingHash, originalBindingHash);
        assert.notEqual(recovered.body.artifact.recordHash, approvedRecordHash);
        assert.equal(fs.existsSync(receiptPath), true);

        const replay = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command).expect(200);
        assert.equal(replay.body.command.replayed, true);
        assert.equal(replay.body.run.revision, recovered.body.run.revision);

        const changedBinding = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            ...command,
            payload: { ...command.payload, artifactHash: 'f'.repeat(64) },
        });
        assert.equal(changedBinding.status, 409);
        assert.equal(changedBinding.body.error, 'workflow_command_conflict');

        const changedPayload = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send({
            ...command,
            payload: { ...command.payload, instruction: 'different retry payload' },
        });
        assert.equal(changedPayload.status, 409);
        assert.equal(changedPayload.body.error, 'workflow_command_conflict');

        const authorityAfterRecovery = await readAuthority(fixture);
        assert.equal(authorityAfterRecovery.project.version, authorityAfterCrash.project.version);
        assert.equal(authorityAfterRecovery.chapter.revision, authorityAfterCrash.chapter.revision);
        assert.deepEqual(authorityAfterRecovery.chapter.card, authorityAfterCrash.chapter.card);
    });

    test('rejects recovery after an applied artifact authority advances again', async () => {
        const fixture = await createProject('Applied Artifact 外部漂移');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);

        const approval = await execute(fixture, view, artifactBinding(view));
        assert.equal(approval.response.status, 200, JSON.stringify(approval.response.body));
        view = approval.response.body;
        assert.equal(view.run.currentStepId, 'apply-card');

        const command = {
            commandId: 'applied-artifact-then-authority-drift',
            runRevision: view.run.revision,
            type: 'execute',
            payload: {
                stepId: 'apply-card',
                ...artifactBinding(view),
            },
        };
        const workflowStore = new WorkflowStore(path.join(dataRoot, 'workflows'));
        const storyStore = new StoryStudioStore(path.join(dataRoot, 'story-studio'), {
            migrationBackupsDirectory: path.join(dataRoot, 'migration-backups'),
        });
        const crashingService = new WorkflowService({
            workflowStore,
            storyStore,
            generationService: {},
        });
        const simulatedCrash = new Error('simulated crash after artifact application');
        crashingService.completeStep = () => {
            throw simulatedCrash;
        };
        await assert.rejects(
            () => crashingService.executeCommand(
                fixture.project.id,
                fixture.chapter.id,
                view.run.id,
                command,
            ),
            error => error === simulatedCrash,
        );

        const authorityAfterCrash = await readAuthority(fixture);
        const appliedArtifact = workflowStore.getArtifact(
            fixture.project.id, view.run.id, view.currentArtifact.id,
        );
        assert.equal(appliedArtifact.status, 'applied');
        assert.equal(appliedArtifact.target.projectVersion, authorityAfterCrash.project.version);
        assert.equal(appliedArtifact.target.chapterRevision, authorityAfterCrash.chapter.revision);
        assert.equal(fs.existsSync(workflowStore.receiptPath(command.commandId)), false);

        const external = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: authorityAfterCrash.project.version,
            revision: authorityAfterCrash.chapter.revision,
            changes: { notes: 'Artifact applied 后追加的外部备注。' },
        }).expect(200);
        assert.equal(external.body.project.version, appliedArtifact.target.projectVersion + 1);
        assert.equal(external.body.chapter.revision, appliedArtifact.target.chapterRevision + 1);

        const rejected = await write(
            request(app).post(`${fixture.chapterPath}/workflow-runs/${view.run.id}/commands`),
            csrfToken,
        ).send(command);
        assert.equal(rejected.status, 409);
        assert.equal(rejected.body.error, 'workflow_authority_changed');
        assert.equal(fs.existsSync(workflowStore.receiptPath(command.commandId)), false);

        const after = await readAuthority(fixture);
        assert.equal(after.project.version, external.body.project.version);
        assert.equal(after.chapter.revision, external.body.chapter.revision);
        assert.equal(after.chapter.notes, 'Artifact applied 后追加的外部备注。');
        const blocked = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST)
            .expect(200);
        assert.equal(blocked.body.run.currentStepId, 'apply-card');
        assert.equal(blocked.body.currentArtifact.status, 'applied');
        assert.equal(blocked.body.currentArtifact.target.projectVersion, appliedArtifact.target.projectVersion);
        assert.equal(blocked.body.currentArtifact.target.chapterRevision, appliedArtifact.target.chapterRevision);
    });

    test('applies an already-complete card as a no-op without incrementing authority', async () => {
        const fixture = await createProject('完整章卡 no-op');
        const completeCard = {
            summary: '林照抵达赤门。',
            goal: '在赤门关闭前进城。',
            conflict: '守将要求检查铜钥匙。',
            turn: '守将也在寻找同样的钥匙。',
            hook: '门内传来第二把钥匙落地的声音。',
            pov: 'lin-zhao',
            time: '黄昏',
            location: 'red-gate',
            required: '交代钥匙与入城目标。',
            avoid: '不提前揭示地下书库真相。',
        };
        const patched = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: fixture.project.version,
            revision: fixture.chapter.revision,
            changes: { card: completeCard },
        }).expect(200);
        fixture.project = patched.body.project;
        fixture.chapter = patched.body.chapter;

        let view = await startRun(fixture, 'start-complete-card');
        view = await advanceToCardApproval(fixture, view);
        assert.equal(view.currentArtifact.payload.noOp, true);
        assert.deepEqual(view.currentArtifact.payload.patch, {});
        const baseline = await readAuthority(fixture);
        const binding = artifactBinding(view);

        let result = await execute(fixture, view, binding);
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'apply-card');
        result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;
        assert.equal(view.run.currentStepId, 'draft');

        const after = await readAuthority(fixture);
        assert.equal(after.project.version, baseline.project.version);
        assert.equal(after.chapter.revision, baseline.chapter.revision);
        assert.deepEqual(after.chapter.card, completeCard);
        assert.equal(view.authority.projectVersion, baseline.project.version);
        assert.equal(view.authority.chapterRevision, baseline.chapter.revision);
        assert.equal(view.currentArtifact, null);
    });

    test('rejects a no-op card application after project-only authority drift', async () => {
        const fixture = await createProject('no-op 版本漂移');
        const completeCard = Object.fromEntries([
            ['summary', '林照抵达赤门。'],
            ['goal', '在赤门关闭前进城。'],
            ['conflict', '守将要求检查铜钥匙。'],
            ['turn', '守将也在寻找同样的钥匙。'],
            ['hook', '门内传来第二把钥匙落地的声音。'],
            ['pov', 'lin-zhao'],
            ['time', '黄昏'],
            ['location', 'red-gate'],
            ['required', '交代钥匙与入城目标。'],
            ['avoid', '不提前揭示地下书库真相。'],
        ]);
        const patched = await write(request(app).patch(fixture.chapterPath), csrfToken).send({
            projectVersion: fixture.project.version,
            revision: fixture.chapter.revision,
            changes: { card: completeCard },
        }).expect(200);
        fixture.project = patched.body.project;
        fixture.chapter = patched.body.chapter;
        let view = await startRun(fixture, 'start-no-op-drift');
        view = await advanceToCardApproval(fixture, view);
        assert.equal(view.currentArtifact.payload.noOp, true);
        let result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 200, JSON.stringify(result.response.body));
        view = result.response.body;

        const external = await write(request(app).patch(fixture.projectPath), csrfToken).send({
            version: fixture.project.version,
            changes: { genre: '仙侠' },
        }).expect(200);
        result = await execute(fixture, view, artifactBinding(view));
        assert.equal(result.response.status, 409);
        assert.equal(result.response.body.error, 'workflow_authority_changed');
        const after = await readAuthority(fixture);
        assert.equal(after.project.version, external.body.version);
        assert.equal(after.project.genre, '仙侠');
        assert.equal(after.chapter.revision, fixture.chapter.revision);
    });

    test('fails closed when a persisted artifact record digest is tampered', async () => {
        const fixture = await createProject('持久化篡改');
        let view = await startRun(fixture);
        view = await advanceToCardApproval(fixture, view);
        const baseline = await readAuthority(fixture);
        const artifactPath = path.join(
            dataRoot,
            'workflows',
            'projects',
            fixture.project.id,
            'runs',
            view.run.id,
            'artifacts',
            `${view.currentArtifact.id}.json`,
        );
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        artifact.recordHash = '0'.repeat(64);
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const read = await request(app)
            .get(`${fixture.chapterPath}/workflow-runs/${view.run.id}`)
            .set('Host', LOCAL_HOST);
        assert.equal(read.status, 500);
        assert.equal(read.body.error, 'workflow_storage_tampered');

        const command = await execute(fixture, view, artifactBinding(view));
        assert.equal(command.response.status, 500);
        assert.equal(command.response.body.error, 'workflow_storage_tampered');

        const after = await readAuthority(fixture);
        assert.equal(after.project.version, baseline.project.version);
        assert.equal(after.chapter.revision, baseline.chapter.revision);
        assert.deepEqual(after.chapter.card, baseline.chapter.card);
    });
});
