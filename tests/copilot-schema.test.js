import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCopilotArtifact, hashCopilotValue, validateCopilotModelOutput } from '../src/copilot-schema.js';

const evidenceCatalog = [{
    evidenceId: 'evidence_0123456789abcdef0123456789abcdef01234567',
    source: { type: 'project', id: 'project-one', path: 'project/identity' },
    title: '作品',
    excerpt: '证据',
    visibility: 'author',
    selectedByDefault: true,
}];

const targetSnapshot = {
    project: { id: 'project-one', story: { world: '旧规则' } },
    volumes: [{ id: 'volume-one', revision: 1, goal: '旧目标', outline: '', summary: '' }],
    chapters: [{ id: 'chapter-one', revision: 1, card: { goal: '旧章目标' } }],
    lorebooks: [{
        id: 'lore-one',
        revision: 2,
        entries: [{
            id: 'entry-one', keys: ['旧词'], secondaryKeys: [], comment: '旧条目',
            content: '旧内容', enabled: true, constant: false,
        }],
    }],
};

function option(id, index) {
    return {
        id,
        title: `方向${index}`,
        commitment: `不可逆选择${index}`,
        summary: `完整方向${index}`,
        eventChain: [1, 2, 3].map(order => ({
            order,
            event: `方向${index}事件${order}`,
            characterChoice: `方向${index}选择${order}`,
            directResult: `方向${index}结果${order}`,
            cost: `方向${index}代价${order}`,
        })),
        hook: `方向${index}钩子`,
        risks: [],
        evidenceIds: [evidenceCatalog[0].evidenceId],
    };
}

function validOutput() {
    return {
        schemaVersion: 1,
        plotOptions: [option('option-one', 1), option('option-two', 2), option('option-three', 3)],
        settingEdits: [{
            id: 'setting-one',
            appliesToOptionIds: ['option-one'],
            target: { kind: 'project-story', id: 'project-one', field: 'world' },
            proposedValue: '新规则',
            rationale: '方向一需要新规则。',
            evidenceIds: [evidenceCatalog[0].evidenceId],
        }],
        lorebookEdits: [{
            id: 'lore-edit-one',
            appliesToOptionIds: ['option-one'],
            operation: 'update',
            lorebookId: 'lore-one',
            entryId: 'entry-one',
            patch: {
                keys: ['新词'], secondaryKeys: null, comment: null, content: '新内容',
                enabled: null, constant: null,
            },
            rationale: '更新触发词和内容。',
            evidenceIds: [evidenceCatalog[0].evidenceId],
        }],
    };
}

describe('Copilot strict candidate schema', () => {
    test('normalizes three distinct directions into inert setting and Lorebook diffs', () => {
        const normalized = validateCopilotModelOutput(validOutput(), {
            optionCount: 3,
            evidenceCatalog,
            targetSnapshot,
            identitySeed: 'session-one',
        });
        assert.equal(normalized.plotOptions.length, 3);
        assert.equal(normalized.changeSet.settingDiffs[0].beforeValue, '旧规则');
        assert.equal(normalized.changeSet.settingDiffs[0].afterValue, '新规则');
        assert.equal(normalized.changeSet.lorebookDiffs[0].beforeEntry.content, '旧内容');
        assert.equal(normalized.changeSet.lorebookDiffs[0].afterEntry.content, '新内容');

        const session = {
            id: 'copilot-session-one',
            projectId: 'project-one',
            contextDigest: hashCopilotValue('context'),
            input: { optionCount: 3 },
            evidenceCatalog,
            targetSnapshot,
            base: { projectId: 'project-one', projectVersion: 1 },
            profile: { profileHash: hashCopilotValue('profile') },
            provider: { configHash: hashCopilotValue('provider') },
        };
        const artifact = createCopilotArtifact({ session, output: validOutput(), raw: JSON.stringify(validOutput()) });
        assert.equal(artifact.status, 'candidate');
        assert.match(artifact.id, /^copilot-artifact-[0-9a-f]{40}$/);
        assert.equal(Object.hasOwn(artifact, 'apply'), false);
    });

    test('accepts the upper six-direction boundary', () => {
        const output = validOutput();
        output.plotOptions = Array.from({ length: 6 }, (_, index) => option(`option-${index + 1}`, index + 1));
        output.settingEdits[0].appliesToOptionIds = ['option-1'];
        output.lorebookEdits[0].appliesToOptionIds = ['option-1'];
        const normalized = validateCopilotModelOutput(output, {
            optionCount: 6,
            evidenceCatalog,
            targetSnapshot,
        });
        assert.equal(normalized.plotOptions.length, 6);
    });

    test('rejects wrong option counts, duplicate directions, fabricated evidence and unselected targets', () => {
        const tooFew = validOutput();
        tooFew.plotOptions.pop();
        assert.throws(
            () => validateCopilotModelOutput(tooFew, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_option_count',
        );

        const tooMany = validOutput();
        tooMany.plotOptions = Array.from({ length: 7 }, (_, index) => option(`option-${index + 1}`, index + 1));
        assert.throws(
            () => validateCopilotModelOutput(tooMany, { optionCount: 6, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_option_count',
        );

        const duplicate = validOutput();
        duplicate.plotOptions[1].commitment = duplicate.plotOptions[0].commitment;
        assert.throws(
            () => validateCopilotModelOutput(duplicate, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'duplicate_copilot_option',
        );

        const fabricated = validOutput();
        fabricated.plotOptions[0].evidenceIds = ['evidence_ffffffffffffffffffffffffffffffffffffffff'];
        assert.throws(
            () => validateCopilotModelOutput(fabricated, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_evidence',
        );

        const outside = validOutput();
        outside.settingEdits[0].target.id = 'project-two';
        assert.throws(
            () => validateCopilotModelOutput(outside, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_target',
        );
    });

    test('rejects ambiguous and unsafe Lorebook operations', () => {
        const missing = validOutput();
        missing.lorebookEdits[0].entryId = 'missing-entry';
        assert.throws(
            () => validateCopilotModelOutput(missing, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_target',
        );

        const deletion = validOutput();
        deletion.lorebookEdits[0].operation = 'delete';
        assert.throws(
            () => validateCopilotModelOutput(deletion, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'invalid_copilot_lore_patch',
        );

        const duplicate = validOutput();
        duplicate.lorebookEdits.push({ ...structuredClone(duplicate.lorebookEdits[0]), id: 'lore-edit-two' });
        assert.throws(
            () => validateCopilotModelOutput(duplicate, { optionCount: 3, evidenceCatalog, targetSnapshot }),
            error => error.code === 'duplicate_copilot_target',
        );
    });
});
