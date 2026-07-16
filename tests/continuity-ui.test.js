import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
    pendingChangeSetDraftStorageKey,
    pendingChangeSetNavigationPolicy,
    validatePendingChangeSetValue,
} from '../public/core.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

const categories = ['entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline'];

function emptyChangeSet() {
    return {
        chapterSummary: '',
        storyStateChanges: Object.fromEntries(categories.map(category => [category, { upsert: [], delete: [] }])),
    };
}

function linkedChangeSet() {
    const value = emptyChangeSet();
    value.storyStateChanges.entities.upsert = [
        {
            id: 'location-gate', kind: 'location', name: '城门', summary: '', aliases: [], status: 'active',
            locationEntityId: null, currentGoal: '', currentAction: '', updatedChapterId: 'chapter-one',
        },
        {
            id: 'hero', kind: 'character', name: '林照', summary: '', aliases: [], status: 'active',
            locationEntityId: 'location-gate', currentGoal: '入城', currentAction: '等候', updatedChapterId: 'chapter-one',
        },
    ];
    value.storyStateChanges.relations.upsert = [{
        id: 'relation-one', fromEntityId: 'hero', toEntityId: 'location-gate', kind: 'present-at', summary: '',
        status: 'active', addressing: '', publicSummary: '', privateSummary: '', sinceChapterId: 'chapter-one',
    }];
    value.storyStateChanges.timeline.upsert = [{
        id: 'time-one', label: '抵达城门', storyTime: '黄昏', sequence: 1, chapterId: 'chapter-one',
        locationEntityId: 'location-gate', status: 'active',
    }];
    value.storyStateChanges.facts.upsert = [{
        id: 'fact-one', summary: '林照抵达城门', subjectEntityId: 'hero', sourceChapterId: 'chapter-one',
        status: 'active', supersededById: null, confidence: 1, tags: [],
    }];
    value.storyStateChanges.knowledge.upsert = [{
        id: 'knowledge-one', entityId: 'hero', factId: 'fact-one', stance: 'knows',
        learnedChapterId: 'chapter-one', status: 'active',
    }];
    value.storyStateChanges.events.upsert = [{
        id: 'event-one', kind: 'story', title: '抵达', summary: '', chapterId: 'chapter-one', entityIds: ['hero'],
        status: 'occurred', order: 1, timelineId: 'time-one', locationEntityId: 'location-gate',
        progress: 100, visibility: 'public',
    }];
    value.storyStateChanges.promises.upsert = [{
        id: 'promise-one', title: '入城', summary: '', introducedChapterId: 'chapter-one', dueChapterId: null,
        resolvedChapterId: null, status: 'open', kind: 'goal', urgency: 2, evidenceChapterIds: ['chapter-one'],
    }];
    value.storyStateChanges.memory.upsert = [{
        id: 'memory-one', kind: 'chapter', summary: '抵达城门', chapterId: 'chapter-one', importance: 3,
        tags: [], status: 'active', supersededById: null, confidence: 1, sourceChapterIds: ['chapter-one'],
    }];
    return value;
}

function validate(value, storyState = {}, chapterIds = ['chapter-one']) {
    return validatePendingChangeSetValue(value, {
        storyState,
        chapterIds,
        boundChapterId: 'chapter-one',
    });
}

describe('continuity workspace UI contract', () => {
    test('exposes six authoritative read-only views', () => {
        for (const view of ['facts', 'knowledge', 'timeline', 'relations', 'promises', 'events']) {
            assert.match(html, new RegExp(`data-continuity-view="${view}"`));
        }
        assert.match(html, /id="ss_story_state_json"[^>]*readonly/);
        assert.doesNotMatch(html, /id="ss_save_story_state"/);
        assert.doesNotMatch(app, /async function saveStoryState\(/);
    });

    test('keeps manual edits in a local pending ChangeSet', () => {
        assert.match(html, /id="ss_pending_changeset_json"/);
        assert.match(html, /id="ss_adopt_pending_changeset"/);
        assert.match(html, /id="ss_save_pending_changeset"/);
        assert.match(html, /id="ss_revert_pending_changeset"/);
        assert.match(html, /id="ss_clear_pending_changeset"/);
        assert.match(html, /id="ss_copy_pending_changeset"/);
        assert.match(app, /story-studio:pending-changeset:/);
        assert.match(app, /manual-state-\$\{digest\}/);
        assert.match(app, /chapterPath\(projectId, chapterId, '\/adopt'\)/);
        assert.doesNotMatch(app, /changes:\s*\{\s*storyState:/);
    });

    test('supports chapter-source navigation and structured preflight diagnostics', () => {
        assert.match(app, /data-continuity-chapter-id/);
        assert.match(app, /loadChapter\(chapterId, \{ pendingPrepared: true \}\)/);
        assert.match(html, /id="ss_context_continuity_preflight"/);
        assert.match(app, /diagnostics\.(?:continuityPreflight|preflight)/);
    });

    test('keeps long continuity values inside the mobile viewport', () => {
        const recordRule = style.match(/\.ss-continuity-record\s*\{([^}]*)\}/)?.[1] ?? '';
        assert.match(recordRule, /min-width:\s*0/);
        assert.match(recordRule, /overflow-wrap:\s*anywhere/);
        assert.match(style, /@media\s*\(max-width:\s*700px\)[\s\S]*\.ss-continuity-record/);
    });

    test('executes the complete V5 validator against a same-batch final projection', () => {
        const result = validate(linkedChangeSet());
        assert.equal(result.valid, true, result.errors.join('\n'));
        assert.equal(result.projected.entities.length, 2);
        assert.equal(result.projected.facts[0].subjectEntityId, 'hero');
        assert.equal(result.projected.events[0].timelineId, 'time-one');

        const patch = emptyChangeSet();
        patch.storyStateChanges.entities.upsert.push({ id: 'hero', currentAction: '穿过城门' });
        const patched = validate(patch, result.projected);
        assert.equal(patched.valid, true, patched.errors.join('\n'));
        assert.equal(patched.projected.entities.find(item => item.id === 'hero').currentAction, '穿过城门');

        const incomplete = emptyChangeSet();
        incomplete.storyStateChanges.entities.upsert.push({ id: 'new-hero', name: '新人' });
        assert.match(validate(incomplete).errors.join('\n'), /合并后缺少/);
    });

    test('rejects unknown keys, malformed ids, duplicate mutations, and invalid field values', () => {
        const unknownRoot = linkedChangeSet();
        unknownRoot.extra = true;
        assert.match(validate(unknownRoot).errors.join('\n'), /未知字段/);

        const unknownMutation = linkedChangeSet();
        unknownMutation.storyStateChanges.facts.replace = [];
        assert.match(validate(unknownMutation).errors.join('\n'), /facts 包含未知字段/);

        const unknownRecord = linkedChangeSet();
        unknownRecord.storyStateChanges.facts.upsert[0].bogus = true;
        assert.match(validate(unknownRecord).errors.join('\n'), /upsert\[0\] 包含未知字段/);

        const invalid = linkedChangeSet();
        invalid.storyStateChanges.facts.upsert[0].id = 'bad id';
        invalid.storyStateChanges.facts.upsert[0].confidence = 2;
        invalid.storyStateChanges.knowledge.upsert[0].stance = 'guesses';
        invalid.storyStateChanges.events.upsert[0].progress = 101;
        invalid.storyStateChanges.promises.upsert[0].urgency = 6;
        invalid.storyStateChanges.timeline.upsert[0].sequence = -1;
        assert.match(validate(invalid).errors.join('\n'), /不是有效 ID/);
        assert.match(validate(invalid).errors.join('\n'), /confidence 不能大于 1/);
        assert.match(validate(invalid).errors.join('\n'), /stance 必须是/);
        assert.match(validate(invalid).errors.join('\n'), /progress 不能大于 100/);
        assert.match(validate(invalid).errors.join('\n'), /urgency 不能大于 5/);
        assert.match(validate(invalid).errors.join('\n'), /sequence 不能小于 0/);

        const duplicates = emptyChangeSet();
        duplicates.storyStateChanges.facts.upsert = [
            { id: 'same-id' },
            { id: 'same-id' },
        ];
        duplicates.storyStateChanges.facts.delete = ['same-id', 'same-id'];
        const duplicateErrors = validate(duplicates).errors.join('\n');
        assert.match(duplicateErrors, /upsert 包含重复 ID/);
        assert.match(duplicateErrors, /delete 包含重复 ID/);
        assert.match(duplicateErrors, /不能同时 upsert 和 delete/);
    });

    test('validates references after deletes and warns before server audit adjudication', () => {
        const authority = validate(linkedChangeSet()).projected;
        const removeHero = emptyChangeSet();
        removeHero.storyStateChanges.entities.delete.push('hero');
        assert.match(validate(removeHero, authority).errors.join('\n'), /引用了不存在的 ID：hero/);

        const badChapter = emptyChangeSet();
        badChapter.storyStateChanges.facts.upsert.push({ id: 'fact-one', sourceChapterId: 'missing-chapter' });
        assert.match(validate(badChapter, authority).errors.join('\n'), /missing-chapter/);

        const replacement = structuredClone(authority);
        replacement.facts.push({
            ...replacement.facts[0], id: 'fact-two', summary: '新事实', supersededById: null,
        });
        replacement.facts[0] = { ...replacement.facts[0], status: 'retired', supersededById: 'fact-two' };
        const breakAudit = emptyChangeSet();
        breakAudit.storyStateChanges.facts.upsert.push({ id: 'fact-one', supersededById: null });
        const auditResult = validate(breakAudit, replacement);
        assert.equal(auditResult.valid, true);
        assert.match(auditResult.warnings.join('\n'), /审计链发生变化/);
    });

    test('binds browser drafts to chapters and exposes executable navigation policy', () => {
        const first = pendingChangeSetDraftStorageKey('project-one', 'chapter-one');
        const second = pendingChangeSetDraftStorageKey('project-one', 'chapter-two');
        assert.notEqual(first, second);
        assert.match(first, /^story-studio:pending-changeset:/);
        assert.equal(pendingChangeSetNavigationPolicy({ dirty: false, valid: false }), 'continue');
        assert.equal(pendingChangeSetNavigationPolicy({ dirty: true, valid: true }), 'save');
        assert.equal(pendingChangeSetNavigationPolicy({ dirty: true, valid: false }), 'confirm-discard');
        assert.equal(pendingChangeSetNavigationPolicy({ dirty: true, valid: true, adopting: true }), 'block');
    });
});
