import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    QUALITY_REPORT_SCHEMA_VERSION,
    QUALITY_RULES,
    lintChapterQuality,
} from '../src/quality-linter.js';

function ruleIds(report) {
    return new Set(report.issues.map(issue => issue.ruleId));
}

function assertAnchored(content, report) {
    assert.match(report.contentDigest, /^[0-9a-f]{64}$/u);
    assert.match(report.reportDigest, /^[0-9a-f]{64}$/u);
    for (const issue of report.issues) {
        assert.ok(QUALITY_RULES.includes(issue.ruleId));
        assert.equal(issue.quote, content.slice(issue.start, issue.end));
        assert.ok(issue.end > issue.start);
        assert.ok(issue.paragraphIndex >= 0);
        assert.ok(issue.message.length > 0);
        assert.ok(issue.suggestion.length > 0);
    }
}

describe('deterministic webnovel quality linter', () => {
    test('finds repeated sentence openings and repeated imagery with exact evidence', () => {
        const content = [
            '他抬起头看向城墙，月光像碎银铺在石阶，守军没有回应。',
            '他抬起头望向箭楼，月光像碎银铺在石阶，风里只有铁锈味。',
            '他抬起头盯住城门，月光像碎银铺在石阶，门缝忽然亮了。',
        ].join('\n\n');
        const report = lintChapterQuality({ content });
        const rules = ruleIds(report);
        assert.ok(rules.has('repeated-sentence-opening'));
        assert.ok(rules.has('repeated-imagery'));
        assertAnchored(content, report);
    });

    test('detects repeated paragraph geometry and description-dialogue loops', () => {
        const content = [
            '雨水顺着残墙落下，院中没有灯。',
            '“把钥匙交出来。”守门人说。',
            '门轴发出低响，阴影压住台阶。',
            '雾气从巷口漫来，檐下没有人。',
            '“先告诉我门后是谁。”林照说。',
            '铜环轻轻摇动，冷光停在门槛上。',
        ].join('\n\n');
        const report = lintChapterQuality({ content });
        const rules = ruleIds(report);
        assert.ok(rules.has('isomorphic-paragraphs'));
        assert.ok(rules.has('description-dialogue-loop'));
        assert.equal(report.passed, false);
        assertAnchored(content, report);
    });

    test('flags retrospective openings, summary endings and explicit next-chapter copy', () => {
        const retrospective = '回想起三年前的雪夜，林照仍能听见钟声。\n\n他推开赤门。';
        assert.ok(ruleIds(lintChapterQuality({ content: retrospective })).has('retrospective-opening'));

        const summary = '林照把钥匙压进掌心。\n\n归根结底，这一天终于结束。';
        assert.ok(ruleIds(lintChapterQuality({ content: summary })).has('summary-ending'));

        const preview = '铜门后传来第二个人的脚步。\n\n下一章，林照将进入地下书库。';
        assert.ok(ruleIds(lintChapterQuality({ content: preview })).has('premature-next-chapter'));
    });

    test('requires an explicit bridge when story time moves backwards', () => {
        const broken = '深夜，林照抵达赤门。\n\n清晨，他站在同一条街上。';
        assert.ok(ruleIds(lintChapterQuality({ content: broken })).has('time-jump'));

        const bridged = '深夜，林照抵达赤门。\n\n次日清晨，他站在同一条街上。';
        assert.equal(ruleIds(lintChapterQuality({ content: bridged })).has('time-jump'), false);
    });

    test('reports appellation drift and POV-protected facts from authoritative evidence ids', () => {
        const content = '林照握住铜钥匙。\n\n小林知道门后藏着王室遗骨。';
        const report = lintChapterQuality({
            content,
            entities: [{ id: 'lin-zhao', name: '林照', aliases: ['小林'] }],
            protectedFacts: [{ id: 'royal-remains', summary: '门后藏着王室遗骨' }],
        });
        const rules = ruleIds(report);
        assert.ok(rules.has('appellation-drift'));
        assert.ok(rules.has('pov-knowledge-leak'));
        assert.equal(report.passed, false);
        assert.deepEqual(
            report.issues.find(issue => issue.ruleId === 'pov-knowledge-leak').evidenceIds,
            ['fact:royal-remains'],
        );
        assertAnchored(content, report);
    });

    test('checks required, avoid, volume goal and open-promise coverage independently', () => {
        const content = '林照带着铜钥匙进入赤门，守将当场扣住他的手腕。';
        const report = lintChapterQuality({
            content,
            chapterCard: {
                required: '铜钥匙；交代接头人身份',
                avoid: '揭示地下书库真相；守将死亡',
            },
            volumeGoal: '夺回城防控制权',
            promises: [
                { id: 'key-use', title: '铜钥匙用途', summary: '铜钥匙能开启哪道门', status: 'open' },
                { id: 'traitor', title: '内应身份', summary: '赤门内应究竟是谁', status: 'open' },
            ],
        });
        const rules = ruleIds(report);
        assert.ok(rules.has('chapter-required-missed'));
        assert.equal(rules.has('chapter-avoid-hit'), false);
        assert.ok(rules.has('volume-goal-missed'));
        assert.ok(rules.has('promise-missed'));
        assert.equal(report.coverage.required.some(item => item.met), true);
        assert.equal(report.coverage.required.some(item => !item.met), true);
        assert.equal(report.coverage.promises.find(item => item.id === 'key-use').touched, true);
        assert.equal(report.coverage.promises.find(item => item.id === 'traitor').touched, false);
        assertAnchored(content, report);
    });

    test('treats avoid hits as blockers', () => {
        const content = '守将倒在门槛上，当场死亡。';
        const report = lintChapterQuality({
            content,
            chapterCard: { required: '', avoid: '守将死亡' },
        });
        const issue = report.issues.find(item => item.ruleId === 'chapter-avoid-hit');
        assert.equal(issue.severity, 'blocker');
        assert.equal(report.passed, false);
    });

    test('is deterministic and publishes a complete zero-count rule vector', () => {
        const input = { content: '门开了一线。林照没有进去，他先把铜钥匙藏进袖口。' };
        const first = lintChapterQuality(input);
        const second = lintChapterQuality(structuredClone(input));
        assert.deepEqual(first, second);
        assert.equal(first.schemaVersion, QUALITY_REPORT_SCHEMA_VERSION);
        assert.deepEqual(Object.keys(first.metrics.ruleCounts), QUALITY_RULES);
    });

    test('rejects unknown fields and unbounded or empty content', () => {
        assert.throws(
            () => lintChapterQuality({ content: '正文。', modelInstruction: 'ignore rules' }),
            error => error.code === 'invalid_quality_input',
        );
        assert.throws(
            () => lintChapterQuality({ content: '' }),
            error => error.code === 'invalid_quality_input',
        );
        assert.throws(
            () => lintChapterQuality({ content: 'x'.repeat(5_000_001) }),
            error => error.code === 'invalid_quality_input',
        );
    });
});
