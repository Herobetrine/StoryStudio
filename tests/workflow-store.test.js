import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { WorkflowStore, hashWorkflowValue } from '../src/workflow-store.js';

describe('persistent declarative workflow state', () => {
    let root;
    let store;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-workflows-'));
        store = new WorkflowStore(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function createRun(changes = {}) {
        return store.createRun({
            runId: 'run-one',
            projectId: 'project-one',
            definitionId: 'builtin.chapter-cycle.v1',
            chapterId: 'chapter-one',
            input: { projectVersion: 3, chapterRevision: 2, purpose: '连载验收' },
            ...changes,
        });
    }

    function artifactFor(stepId, kind, source = 'system', changes = {}) {
        return store.createArtifact({
            projectId: 'project-one',
            runId: 'run-one',
            stepId,
            kind,
            source,
            target: { type: kind === 'diagnosis' ? 'workflow-run' : 'chapter-content', chapterId: 'chapter-one' },
            base: { projectVersion: 3, chapterRevision: 2 },
            payload: { summary: `${stepId} candidate` },
            evidenceIds: ['chapter:chapter-one'],
            ...changes,
        });
    }

    test('persists built-in definitions, runs, artifacts, and receipts below isolated directories', () => {
        const definition = store.getDefinition('builtin.chapter-cycle.v1');
        const run = createRun();
        const artifact = artifactFor('diagnose', 'diagnosis');
        const result = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'complete-diagnose',
            expectedRevision: run.revision,
            stepId: 'diagnose',
            status: 'completed',
            artifactIds: [artifact.id],
        });

        assert.equal(definition.id, 'builtin.chapter-cycle.v1');
        assert.equal(result.run.revision, 2);
        assert.equal(result.run.currentStepId, 'propose-card');
        assert.equal(result.run.steps[0].artifactIds[0], artifact.id);
        assert.equal(result.receipt.committedRevision, 2);
        assert.equal(store.listRuns('project-one')[0].id, run.id);
        assert.equal(store.listArtifacts('project-one', run.id)[0].id, artifact.id);
        for (const relative of [
            'definitions/builtin.chapter-cycle.v1.json',
            'projects/project-one/runs/run-one/run.json',
            `projects/project-one/runs/run-one/artifacts/${artifact.id}.json`,
            'receipts/complete-diagnose.json',
        ]) assert.equal(fs.existsSync(path.join(root, ...relative.split('/'))), true, relative);
    });

    test('isolates artifact files by project and run even when ids collide or another project is corrupt', () => {
        const firstRun = createRun();
        const first = artifactFor('diagnose', 'diagnosis', 'system', { artifactId: 'shared-artifact' });
        const secondRun = store.createRun({
            runId: 'run-two',
            projectId: 'project-two',
            definitionId: 'builtin.chapter-cycle.v1',
            chapterId: 'chapter-two',
            input: { projectVersion: 7, chapterRevision: 4 },
        });
        const second = store.createArtifact({
            artifactId: first.id,
            projectId: secondRun.projectId,
            runId: secondRun.id,
            stepId: 'diagnose',
            kind: 'diagnosis',
            source: 'system',
            target: { type: 'workflow-run', chapterId: secondRun.chapterId },
            base: { projectVersion: 7, chapterRevision: 4 },
            payload: { summary: 'healthy project candidate' },
            evidenceIds: ['chapter:chapter-two'],
        });
        const firstPath = store.artifactPath(firstRun.projectId, firstRun.id, first.id);
        const secondPath = store.artifactPath(secondRun.projectId, secondRun.id, second.id);
        assert.notEqual(firstPath, secondPath);

        const tampered = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
        tampered.recordHash = '0'.repeat(64);
        fs.writeFileSync(firstPath, JSON.stringify(tampered));

        assert.equal(store.listArtifacts(secondRun.projectId, secondRun.id)[0].payload.summary,
            'healthy project candidate');
        assert.equal(store.getArtifact(secondRun.projectId, secondRun.id, second.id).projectId,
            secondRun.projectId);
        assert.throws(
            () => store.listArtifacts(firstRun.projectId, firstRun.id),
            error => error.status === 500 && error.code === 'workflow_storage_tampered',
        );
    });

    test('enforces optimistic run revisions and replays an identical command exactly once', () => {
        const run = createRun();
        const first = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'diagnose-done',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
            response: { accepted: true },
        });
        const replay = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'diagnose-done',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
            response: { accepted: true },
        });

        assert.equal(first.replayed, false);
        assert.equal(replay.replayed, true);
        assert.equal(replay.run.revision, 2);
        assert.deepEqual(replay.receipt.response, { accepted: true });
        assert.throws(
            () => store.transitionStep({
                projectId: run.projectId,
                runId: run.id,
                commandId: 'stale-command',
                expectedRevision: 1,
                stepId: 'propose-card',
                status: 'running',
            }),
            error => error.status === 409 && error.code === 'workflow_revision_conflict',
        );
        assert.throws(
            () => store.transitionStep({
                projectId: run.projectId,
                runId: run.id,
                commandId: 'diagnose-done',
                expectedRevision: 1,
                stepId: 'diagnose',
                status: 'failed',
            }),
            error => error.status === 409 && error.code === 'workflow_command_conflict',
        );
    });

    test('carries the exact ancestor candidate through approval and application steps', () => {
        const run = createRun();
        const diagnosed = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'ancestor-diagnose',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
        });
        const selected = artifactFor('propose-card', 'chapter-card', 'system', {
            artifactId: 'selected-card',
            target: { type: 'chapter-card', chapterId: 'chapter-one' },
        });
        const decoy = artifactFor('propose-card', 'chapter-card', 'system', {
            artifactId: 'decoy-card',
            target: { type: 'chapter-card', chapterId: 'chapter-one' },
        });
        const proposed = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'ancestor-propose',
            expectedRevision: diagnosed.run.revision,
            stepId: 'propose-card',
            status: 'completed',
            artifactIds: [selected.id, decoy.id],
        });
        store.updateArtifact(run.projectId, run.id, selected.id, { expectedRevision: 1, status: 'approved' });
        const approved = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'ancestor-approve',
            expectedRevision: proposed.run.revision,
            stepId: 'approve-card',
            status: 'completed',
            artifactIds: [selected.id],
        });

        store.updateArtifact(run.projectId, run.id, decoy.id, { expectedRevision: 1, status: 'approved' });
        store.updateArtifact(run.projectId, run.id, decoy.id, {
            expectedRevision: 2,
            status: 'applied',
            target: {
                type: 'chapter-card', chapterId: 'chapter-one',
                projectVersion: 4, chapterRevision: 3, digest: 'b'.repeat(64),
            },
        });
        assert.throws(
            () => store.transitionStep({
                projectId: run.projectId,
                runId: run.id,
                commandId: 'ancestor-swap',
                expectedRevision: approved.run.revision,
                stepId: 'apply-card',
                status: 'completed',
                artifactIds: [decoy.id],
            }),
            error => error.code === 'invalid_workflow_artifact',
        );

        store.updateArtifact(run.projectId, run.id, selected.id, {
            expectedRevision: 2,
            status: 'applied',
            target: {
                type: 'chapter-card', chapterId: 'chapter-one',
                projectVersion: 4, chapterRevision: 3, digest: 'a'.repeat(64),
            },
        });
        const applied = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'ancestor-apply',
            expectedRevision: approved.run.revision,
            stepId: 'apply-card',
            status: 'completed',
            artifactIds: [selected.id],
        });
        assert.equal(applied.run.currentStepId, 'draft');
        assert.deepEqual(applied.run.steps.find(step => step.id === 'approve-card').artifactIds, [selected.id]);
        assert.deepEqual(applied.run.steps.find(step => step.id === 'apply-card').artifactIds, [selected.id]);
    });

    test('recovers an idempotency receipt when publication stopped after the atomic run write', () => {
        const run = createRun();
        const first = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'recoverable-command',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
        });
        fs.rmSync(store.receiptPath('recoverable-command'));
        const replay = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'recoverable-command',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
        });

        assert.equal(first.run.revision, 2);
        assert.equal(replay.replayed, true);
        assert.equal(replay.receipt.committedRevision, 2);
        assert.equal(fs.existsSync(store.receiptPath('recoverable-command')), true);
    });

    test('publishes a missing previous receipt before a new command can replace lastCommand', () => {
        const run = createRun();
        const commandA = {
            projectId: run.projectId,
            runId: run.id,
            commandId: 'crash-command-a',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
            response: { accepted: 'command-a' },
        };
        const receiptAPath = store.receiptPath(commandA.commandId);
        const originalWriteJson = store.writeJson.bind(store);
        let injectReceiptFailure = true;
        store.writeJson = (filePath, value) => {
            if (injectReceiptFailure && filePath === receiptAPath) {
                injectReceiptFailure = false;
                throw new Error('simulated receipt publication failure');
            }
            return originalWriteJson(filePath, value);
        };

        assert.throws(
            () => store.transitionStep(commandA),
            /simulated receipt publication failure/u,
        );
        assert.equal(store.getRun(run.projectId, run.id).revision, 2);
        assert.equal(fs.existsSync(receiptAPath), false);

        const commandB = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'command-b',
            expectedRevision: 2,
            stepId: 'propose-card',
            status: 'running',
            response: { accepted: 'command-b' },
        });
        assert.equal(commandB.run.revision, 3);
        assert.equal(fs.existsSync(receiptAPath), true);
        assert.equal(store.getReceipt(commandA.commandId).response.accepted, 'command-a');

        const replayA = store.transitionStep(commandA);
        assert.equal(replayA.replayed, true);
        assert.equal(replayA.run.revision, 3);
        assert.equal(replayA.receipt.committedRevision, 2);
        assert.deepEqual(replayA.receipt.response, { accepted: 'command-a' });
        assert.throws(
            () => store.transitionStep({ ...commandA, status: 'failed' }),
            error => error.status === 409 && error.code === 'workflow_command_conflict',
        );
    });

    test('fails closed before a new command when the lastCommand receipt has conflicting content', () => {
        const run = createRun();
        store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'receipt-mismatch-a',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
            response: { accepted: true },
        });
        const receiptPath = store.receiptPath('receipt-mismatch-a');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        receipt.response = { accepted: false };
        delete receipt.recordHash;
        receipt.recordHash = hashWorkflowValue(receipt);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

        assert.throws(
            () => store.transitionStep({
                projectId: run.projectId,
                runId: run.id,
                commandId: 'receipt-mismatch-b',
                expectedRevision: 2,
                stepId: 'propose-card',
                status: 'running',
            }),
            error => error.status === 500 && error.code === 'workflow_storage_corrupt',
        );
        const unchanged = store.getRun(run.projectId, run.id);
        assert.equal(unchanged.revision, 2);
        assert.equal(unchanged.lastCommand.id, 'receipt-mismatch-a');
        assert.equal(fs.existsSync(store.receiptPath('receipt-mismatch-b')), false);
    });

    test('keeps model output candidate-only and requires approval before application', () => {
        const definition = store.saveDefinition({
            schemaVersion: 1,
            id: 'custom.model-draft.v1',
            name: '模型候选测试',
            description: '',
            revision: 1,
            steps: [{
                id: 'draft', title: '起草', kind: 'draft', actor: 'model',
                dependsOn: [], artifactKind: 'chapter-draft',
            }],
        });
        const run = store.createRun({
            runId: 'run-model',
            projectId: 'project-model',
            definitionId: definition.id,
            definitionHash: definition.definitionHash,
            chapterId: 'chapter-model',
            input: {},
        });
        const artifactInput = {
            artifactId: 'model-card',
            projectId: run.projectId,
            runId: run.id,
            stepId: 'draft',
            kind: 'chapter-draft',
            target: { type: 'chapter-content', chapterId: run.chapterId },
            base: { projectVersion: 3, chapterRevision: 2 },
            payload: { content: '候选正文' },
        };
        assert.throws(
            () => store.createArtifact({ ...artifactInput, source: 'system' }),
            error => error.code === 'unsafe_model_artifact',
        );
        const candidate = store.createArtifact({ ...artifactInput, source: 'model' });

        assert.equal(candidate.status, 'candidate');
        assert.deepEqual(candidate.base, { projectVersion: 3, chapterRevision: 2 });
        assert.deepEqual(candidate.target, {
            type: 'chapter-content',
            chapterId: 'chapter-model',
            projectVersion: null,
            chapterRevision: null,
            digest: null,
        });
        assert.throws(
            () => store.updateArtifact(run.projectId, run.id, candidate.id, {
                expectedRevision: 1, status: 'applied',
            }),
            error => error.status === 409 && error.code === 'invalid_workflow_transition',
        );
        const approved = store.updateArtifact(run.projectId, run.id, candidate.id, {
            expectedRevision: 1, status: 'approved',
        });
        assert.throws(
            () => store.updateArtifact(run.projectId, run.id, candidate.id, {
                expectedRevision: 2, status: 'applied',
            }),
            error => error.code === 'invalid_workflow_artifact_target',
        );
        const applied = store.updateArtifact(run.projectId, run.id, candidate.id, {
            expectedRevision: 2,
            status: 'applied',
            target: {
                type: 'chapter-content',
                chapterId: 'chapter-model',
                projectVersion: 4,
                chapterRevision: 3,
                digest: 'a'.repeat(64),
            },
        });
        assert.equal(approved.status, 'approved');
        assert.ok(approved.approvedAt);
        assert.equal(applied.status, 'applied');
        assert.ok(applied.appliedAt);
        assert.deepEqual(applied.target, {
            type: 'chapter-content',
            chapterId: 'chapter-model',
            projectVersion: 4,
            chapterRevision: 3,
            digest: 'a'.repeat(64),
        });
        assert.throws(
            () => store.updateArtifact(run.projectId, run.id, candidate.id, {
                expectedRevision: 2, status: 'rejected',
            }),
            error => error.status === 409 && error.code === 'workflow_revision_conflict',
        );
    });

    test('validates artifact ownership, targets, base versions, and model actor provenance', () => {
        createRun();
        assert.throws(
            () => artifactFor('diagnose', 'diagnosis', 'model', {
                target: { type: 'workflow-run', chapterId: 'chapter-one' },
            }),
            error => error.code === 'invalid_workflow_artifact',
        );
        assert.throws(
            () => artifactFor('diagnose', 'diagnosis', 'system', {
                target: { type: 'workflow-run', chapterId: 'other-chapter' },
            }),
            error => error.code === 'invalid_workflow_artifact_target',
        );
        assert.throws(
            () => artifactFor('diagnose', 'diagnosis', 'system', {
                base: { projectVersion: 0, chapterRevision: 2 },
            }),
            error => error.code === 'invalid_workflow_artifact_base',
        );
        assert.throws(
            () => artifactFor('diagnose', 'chapter-draft'),
            error => error.code === 'invalid_workflow_artifact_kind',
        );
    });

    test('rejects invalid step and run state transitions', () => {
        const run = createRun();
        assert.throws(
            () => store.transitionStep({
                projectId: run.projectId,
                runId: run.id,
                commandId: 'skip-ahead',
                expectedRevision: 1,
                stepId: 'draft',
                status: 'running',
            }),
            error => error.status === 409 && error.code === 'invalid_workflow_transition',
        );
        const failed = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'diagnose-failed',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'failed',
            error: '缺少章纲',
        });
        assert.equal(failed.run.status, 'failed');
        const retried = store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'diagnose-retry',
            expectedRevision: 2,
            stepId: 'diagnose',
            status: 'ready',
        });
        assert.equal(retried.run.status, 'running');
        assert.equal(retried.run.currentStepId, 'diagnose');
    });

    test('detects semantic tampering in definitions, runs, artifacts, and receipts', () => {
        const run = createRun();
        const artifact = artifactFor('diagnose', 'diagnosis');
        store.transitionStep({
            projectId: run.projectId,
            runId: run.id,
            commandId: 'tamper-receipt',
            expectedRevision: 1,
            stepId: 'diagnose',
            status: 'completed',
        });

        const cases = [
            [store.runPath('project-one', 'run-one'), value => { value.input.purpose = '篡改'; },
                () => store.getRun('project-one', 'run-one')],
            [store.artifactPath(run.projectId, run.id, artifact.id), value => { value.payload.summary = '篡改'; },
                () => store.getArtifact(run.projectId, run.id, artifact.id)],
            [store.receiptPath('tamper-receipt'), value => { value.response = { forged: true }; },
                () => store.getReceipt('tamper-receipt')],
        ];
        for (const [filePath, mutate, read] of cases) {
            const original = fs.readFileSync(filePath, 'utf8');
            const value = JSON.parse(original);
            mutate(value);
            fs.writeFileSync(filePath, JSON.stringify(value));
            assert.throws(read, error => error.status === 500 && error.code === 'workflow_storage_tampered');
            fs.writeFileSync(filePath, original);
        }

        const definitionPath = store.definitionPath('builtin.chapter-cycle.v1');
        const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
        definition.name = '篡改内置流程';
        fs.writeFileSync(definitionPath, JSON.stringify(definition));
        assert.throws(
            () => store.getDefinition('builtin.chapter-cycle.v1'),
            error => error.status === 500 && error.code === 'workflow_definition_tampered',
        );
    });

    test('rejects traversal ids and keeps custom definitions immutable', () => {
        assert.throws(
            () => store.getRun('..', 'run-one'),
            error => error.status === 400 && error.code === 'invalid_workflow_id',
        );
        const custom = {
            schemaVersion: 1,
            id: 'custom.one.v1',
            name: '自定义流程',
            description: '',
            revision: 1,
            steps: [{
                id: 'diagnose', title: '诊断', kind: 'diagnose', actor: 'system',
                dependsOn: [], artifactKind: 'diagnosis',
            }],
        };
        const stored = store.saveDefinition(custom);
        assert.equal(store.saveDefinition(stored).definitionHash, stored.definitionHash);
        assert.throws(
            () => store.saveDefinition({ ...custom, name: '同 ID 的另一流程' }),
            error => error.status === 409 && error.code === 'workflow_definition_exists',
        );
        assert.throws(
            () => store.saveDefinition({ ...custom, id: 'builtin.shadow.v1' }),
            error => error.status === 409 && error.code === 'reserved_workflow_definition',
        );
    });
});
