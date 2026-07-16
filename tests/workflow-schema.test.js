import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    BUILTIN_CHAPTER_CYCLE_DEFINITION,
    BUILTIN_CHAPTER_CYCLE_V2_DEFINITION,
    BUILTIN_WORKFLOW_DEFINITIONS,
    MAX_WORKFLOW_STEPS,
    evaluateWorkflowCondition,
    normalizeWorkflowDefinition,
} from '../src/workflow-schema.js';

function definition(changes = {}) {
    return {
        schemaVersion: 1,
        id: 'custom.serial.v1',
        name: '连载工作流',
        description: '严格的声明式流程',
        revision: 1,
        steps: [
            {
                id: 'inspect',
                title: '检查',
                kind: 'diagnose',
                actor: 'system',
                dependsOn: [],
                artifactKind: 'diagnosis',
            },
            {
                id: 'draft',
                title: '起草',
                kind: 'draft',
                actor: 'model',
                dependsOn: ['inspect'],
                artifactKind: 'chapter-draft',
                condition: {
                    op: 'all',
                    conditions: [
                        { op: 'exists', source: 'input', path: ['chapterId'] },
                        { op: 'neq', source: 'run', path: ['status'], value: 'cancelled' },
                    ],
                },
            },
        ],
        ...changes,
    };
}

describe('declarative workflow definition schema', () => {
    test('ships the complete chapter-cycle DAG in its authoritative order', () => {
        assert.equal(BUILTIN_CHAPTER_CYCLE_DEFINITION.schemaVersion, 1);
        assert.deepEqual(
            BUILTIN_CHAPTER_CYCLE_DEFINITION.steps.map(step => step.id),
            [
                'diagnose', 'propose-card', 'approve-card', 'apply-card', 'draft', 'distill',
                'approve-state', 'adopt', 'review', 'apply-review', 'closeout',
            ],
        );
        assert.match(BUILTIN_CHAPTER_CYCLE_DEFINITION.definitionHash, /^[0-9a-f]{64}$/u);
        assert.equal(BUILTIN_CHAPTER_CYCLE_DEFINITION.steps.find(step => step.id === 'propose-card').actor, 'system');
        assert.equal(BUILTIN_CHAPTER_CYCLE_DEFINITION.steps.find(step => step.id === 'draft').actor, 'model');
        assert.equal(BUILTIN_CHAPTER_CYCLE_DEFINITION.steps.find(step => step.id === 'adopt').actor, 'system');
        assert.equal(BUILTIN_CHAPTER_CYCLE_DEFINITION.steps.find(step => step.id === 'apply-review').artifactKind,
            'chapter-review');
        assert.equal(
            BUILTIN_CHAPTER_CYCLE_DEFINITION.definitionHash,
            '85fc89f8a80c400be20066748f3a3bf9e9f0eb12980a08c29369512516ad9d8b',
        );
    });

    test('ships the candidate-only V2 production cycle while retaining V1', () => {
        assert.deepEqual(BUILTIN_WORKFLOW_DEFINITIONS.map(item => item.id), [
            'builtin.chapter-cycle.v1',
            'builtin.chapter-cycle.v2',
        ]);
        assert.deepEqual(BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps.map(step => step.id), [
            'brainstorm', 'select-direction', 'plan', 'approve-plan', 'draft', 'review',
            'approve-review', 'rewrite', 'approve-rewrite', 'distill', 'approve-adoption', 'adopt',
        ]);
        const rewrite = BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps.find(step => step.id === 'rewrite');
        const approveRewrite = BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps.find(
            step => step.id === 'approve-rewrite',
        );
        assert.deepEqual(rewrite.condition, {
            op: 'eq', source: 'artifact', path: ['rewriteRequired'], value: true,
        });
        assert.deepEqual(approveRewrite.condition, rewrite.condition);
        assert.equal(BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps.find(
            step => step.id === 'approve-adoption',
        ).actor, 'user');
        assert.equal(BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps.at(-1).actor, 'system');
        assert.equal(Object.isFrozen(BUILTIN_CHAPTER_CYCLE_V2_DEFINITION), true);
        assert.equal(Object.isFrozen(BUILTIN_CHAPTER_CYCLE_V2_DEFINITION.steps), true);
    });

    test('canonicalizes a strict definition and produces a stable content hash', () => {
        const first = normalizeWorkflowDefinition(definition());
        const second = normalizeWorkflowDefinition(JSON.parse(JSON.stringify(first)));
        assert.deepEqual(second, first);
        assert.equal(first.steps[0].condition.op, 'always');
        assert.equal(first.steps[1].condition.op, 'all');
    });

    test('rejects unknown fields, missing dependencies, duplicate ids, cycles, and oversized DAGs', () => {
        assert.throws(
            () => normalizeWorkflowDefinition({ ...definition(), script: 'return true' }),
            error => error.code === 'unknown_workflow_fields',
        );
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [{ ...definition().steps[0], dependsOn: ['missing'] }],
            })),
            error => error.code === 'invalid_workflow_dag',
        );
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [definition().steps[0], { ...definition().steps[0] }],
            })),
            error => error.code === 'invalid_workflow_dag',
        );
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [
                    { ...definition().steps[0], dependsOn: ['draft'] },
                    { ...definition().steps[1], dependsOn: ['inspect'] },
                ],
            })),
            error => error.code === 'invalid_workflow_dag',
        );
        const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, index) => ({
            id: `step-${index}`,
            title: `Step ${index}`,
            kind: 'diagnose',
            actor: 'system',
            dependsOn: index === 0 ? [] : [`step-${index - 1}`],
            artifactKind: 'diagnosis',
        }));
        assert.throws(
            () => normalizeWorkflowDefinition(definition({ steps })),
            error => error.code === 'invalid_workflow_definition',
        );
    });

    test('does not expose script, EJS, template, or string-expression execution paths', () => {
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [{ ...definition().steps[0], condition: 'input.approved === true' }],
            })),
            error => error.code === 'executable_workflow_definition',
        );
        for (const title of ['<%= process.env.SECRET %>', '${globalThis.process}', '{{constructor}}']) {
            assert.throws(
                () => normalizeWorkflowDefinition(definition({
                    steps: [{ ...definition().steps[0], title }],
                })),
                error => error.code === 'executable_workflow_definition',
            );
        }
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [{
                    ...definition().steps[0], kind: 'apply', actor: 'model', artifactKind: 'state-change-set',
                }],
            })),
            error => error.code === 'unsafe_model_workflow_step',
        );
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [{
                    ...definition().steps[0], kind: 'human_gate', actor: 'system', artifactKind: 'diagnosis',
                }],
            })),
            error => error.code === 'unsafe_workflow_step',
        );
        assert.throws(
            () => normalizeWorkflowDefinition(definition({
                steps: [{
                    ...definition().steps[0], kind: 'human_gate', actor: 'user', artifactKind: null,
                }],
            })),
            error => error.code === 'unsafe_workflow_step',
        );
    });

    test('evaluates only the finite condition AST against own properties', () => {
        const context = {
            input: { approved: true, genre: 'xuanhuan' },
            run: { status: 'running' },
        };
        assert.equal(evaluateWorkflowCondition({
            op: 'all',
            conditions: [
                { op: 'eq', source: 'input', path: ['approved'], value: true },
                { op: 'in', source: 'input', path: ['genre'], values: ['xuanhuan', 'science-fiction'] },
                { op: 'not', condition: { op: 'eq', source: 'run', path: ['status'], value: 'failed' } },
            ],
        }, context), true);
        assert.equal(evaluateWorkflowCondition({
            op: 'exists', source: 'input', path: ['missing'],
        }, context), false);
        assert.throws(
            () => evaluateWorkflowCondition({ op: 'exists', source: 'input', path: ['__proto__'] }, context),
            error => error.code === 'invalid_workflow_condition',
        );
    });

    test('canonicalizes negative zero before hashing and evaluating conditions', () => {
        const source = definition({
            steps: [{
                ...definition().steps[0],
                condition: { op: 'eq', source: 'input', path: ['count'], value: -0 },
            }],
        });
        const normalized = normalizeWorkflowDefinition(source);
        assert.equal(Object.is(normalized.steps[0].condition.value, -0), false);
        assert.equal(evaluateWorkflowCondition(normalized.steps[0].condition, { input: { count: 0 } }), true);

        normalized.steps[0].condition.value = -0;
        const reloaded = normalizeWorkflowDefinition(normalized, { requireHash: true });
        assert.equal(Object.is(reloaded.steps[0].condition.value, -0), false);
        assert.equal(evaluateWorkflowCondition(reloaded.steps[0].condition, { input: { count: 0 } }), true);
    });

    test('fails closed when a persisted definition no longer matches its hash', () => {
        const stored = normalizeWorkflowDefinition(definition());
        stored.name = '被改写的流程';
        assert.throws(
            () => normalizeWorkflowDefinition(stored, { requireHash: true }),
            error => error.status === 500 && error.code === 'workflow_definition_tampered',
        );
    });
});
