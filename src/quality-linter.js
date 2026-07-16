import { createHash } from 'node:crypto';

import { ApiError } from './api-error.js';

export const QUALITY_REPORT_SCHEMA_VERSION = 1;

export const QUALITY_RULES = Object.freeze([
    'repeated-sentence-opening',
    'repeated-imagery',
    'isomorphic-paragraphs',
    'description-dialogue-loop',
    'retrospective-opening',
    'summary-ending',
    'premature-next-chapter',
    'time-jump',
    'appellation-drift',
    'pov-knowledge-leak',
    'chapter-required-missed',
    'chapter-avoid-hit',
    'volume-goal-missed',
    'promise-missed',
]);

const MAX_CONTENT_CHARACTERS = 5_000_000;
const MAX_RECORDS = 2_000;
const MAX_TEXT = 100_000;
const ISSUE_SEVERITIES = new Set(['blocker', 'major', 'minor']);
const ACTION_PATTERN = /(?:冲|扑|抓|握|推|拉|劈|斩|刺|踢|跃|跑|追|退|转身|抬手|拔|撞|砸|按住|闪开|踏|掠|挣)/u;
const DIALOGUE_PATTERN = /[“「『][^”」』]{1,400}[”」』]/u;
const TRANSITION_PATTERN = /(?:次日|翌日|第二天|隔日|数日后|几日后|多年后|后来|回忆|想起|此前|当年|曾经)/u;
const RETROSPECTIVE_PATTERN = /(?:回想起|想起了|还记得|记忆(?:里|中)|此前|当年|那一年|曾经有|往事|回忆)/u;
const SUMMARY_ENDING_PATTERN = /(?:总之|归根结底|他终于明白|她终于明白|这一切(?:都|终究)|这一天(?:终于)?结束|至此|尘埃落定|故事才刚刚开始)[^。！？]{0,80}[。！？]?$/u;
const NEXT_CHAPTER_PATTERN = /(?:下一章|下回|欲知后事|且听下回|接下来的一章|下一回)[^。！？]{0,80}[。！？]?$/u;
const COMMON_NGRAM = /^(?:他的|她的|他们|自己|这个|那个|一个|已经|没有|不是|只是|然后|然而|但是|因为|所以|时候|什么|怎么|仿佛|似乎|看着|说道|问道|声音|目光|心中|脸上)+$/u;
const TIME_MARKERS = Object.freeze([
    ['凌晨', 180], ['黎明', 300], ['清晨', 360], ['早晨', 480], ['上午', 600], ['正午', 720],
    ['中午', 750], ['午后', 840], ['下午', 900], ['傍晚', 1050], ['黄昏', 1080], ['夜晚', 1260],
    ['入夜', 1260], ['深夜', 1380], ['午夜', 1440],
]);

function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new ApiError(400, 'invalid_quality_input', `${label} must be a plain object.`);
    }
    return value;
}

function boundedText(value, label, maximum = MAX_TEXT, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string' || value.length > maximum) {
        throw new ApiError(400, 'invalid_quality_input', `${label} must be a bounded string.`);
    }
    return value;
}

function boundedArray(value, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_RECORDS) {
        throw new ApiError(400, 'invalid_quality_input', `${label} must be a bounded array.`);
    }
    return value;
}

function stable(value) {
    if (value === null || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    if (Array.isArray(value)) return value.map(stable);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
    const source = typeof value === 'string' ? value : JSON.stringify(stable(value));
    return createHash('sha256').update(source, 'utf8').digest('hex');
}

function paragraphs(content) {
    const result = [];
    const pattern = /[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/gu;
    for (const match of content.matchAll(pattern)) {
        const raw = match[0];
        const leading = raw.search(/\S/u);
        const text = raw.trim();
        if (!text) continue;
        const start = match.index + Math.max(0, leading);
        result.push({ index: result.length, start, end: start + text.length, text });
    }
    return result;
}

function sentences(content, paragraphRows) {
    const result = [];
    for (const paragraph of paragraphRows) {
        const pattern = /[^。！？!?\r\n]+[。！？!?]?/gu;
        for (const match of paragraph.text.matchAll(pattern)) {
            const text = match[0].trim();
            if (!text) continue;
            const localLeading = match[0].search(/\S/u);
            const start = paragraph.start + match.index + Math.max(0, localLeading);
            result.push({
                index: result.length,
                paragraphIndex: paragraph.index,
                start,
                end: start + text.length,
                text,
            });
        }
    }
    return result;
}

function countContentUnits(value) {
    const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const nonHanWords = value.match(/[\p{L}\p{N}]+/gu)?.filter(token => !/[\p{Script=Han}]/u.test(token)).length ?? 0;
    return han + nonHanWords;
}

function issueId(ruleId, start, end, quote) {
    return `quality-${digest({ ruleId, start, end, quote }).slice(0, 48)}`;
}

function makeIssue(content, paragraphRows, {
    ruleId,
    severity = 'minor',
    category,
    start,
    end,
    message,
    suggestion,
    evidenceIds = [],
}) {
    if (!QUALITY_RULES.includes(ruleId) || !ISSUE_SEVERITIES.has(severity)
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || end > content.length) {
        throw new TypeError('Quality issue coordinates are invalid.');
    }
    const quote = content.slice(start, end);
    const paragraphIndex = Math.max(0, paragraphRows.findIndex(row => start >= row.start && start < row.end));
    return {
        id: issueId(ruleId, start, end, quote),
        ruleId,
        severity,
        category,
        start,
        end,
        paragraphIndex,
        quote,
        message,
        suggestion,
        evidenceIds: [...new Set(evidenceIds)].slice(0, 64),
    };
}

function normalizedOpening(sentence) {
    return sentence.text
        .replace(/^[\s“”「」『』\-—,，。！？!?：:；;]+/u, '')
        .replace(/[\p{P}\p{S}\s]/gu, '')
        .slice(0, 4)
        .toLocaleLowerCase('zh-CN');
}

function repeatedOpenings(content, paragraphRows, sentenceRows) {
    const byOpening = new Map();
    for (const sentence of sentenceRows) {
        const opening = normalizedOpening(sentence);
        if (opening.length < 3) continue;
        const list = byOpening.get(opening) ?? [];
        list.push(sentence);
        byOpening.set(opening, list);
    }
    const issues = [];
    for (const [opening, rows] of byOpening) {
        const distinctParagraphs = new Set(rows.map(row => row.paragraphIndex));
        if (rows.length < 3 || distinctParagraphs.size < 2) continue;
        for (const row of rows.slice(2, 5)) {
            issues.push(makeIssue(content, paragraphRows, {
                ruleId: 'repeated-sentence-opening',
                severity: 'minor',
                category: 'style',
                start: row.start,
                end: Math.min(row.end, row.start + Math.max(3, opening.length)),
                message: `句子连续复用“${opening}”式起笔，节奏趋于同构。`,
                suggestion: '改用动作结果、环境变化或人物选择切入，避免只替换主语。',
            }));
        }
    }
    return issues;
}

function imageryNgrams(paragraph, entityLabels) {
    const compact = paragraph.text.replace(/[^\p{Script=Han}]/gu, '');
    const values = new Set();
    for (const size of [6, 5, 4]) {
        for (let index = 0; index + size <= compact.length; index += 1) {
            const value = compact.slice(index, index + size);
            if (COMMON_NGRAM.test(value) || entityLabels.some(label => value.includes(label))) continue;
            values.add(value);
        }
    }
    return values;
}

function repeatedImagery(content, paragraphRows, entities) {
    const labels = entities.flatMap(entity => [entity.name, ...(entity.aliases ?? [])])
        .filter(value => typeof value === 'string' && value.length >= 2);
    const occurrences = new Map();
    for (const paragraph of paragraphRows) {
        for (const phrase of imageryNgrams(paragraph, labels)) {
            const list = occurrences.get(phrase) ?? [];
            list.push(paragraph);
            occurrences.set(phrase, list);
        }
    }
    const candidates = [...occurrences.entries()]
        .filter(([, rows]) => new Set(rows.map(row => row.index)).size >= 3)
        .sort((left, right) => right[0].length - left[0].length || right[1].length - left[1].length);
    const covered = new Set();
    const issues = [];
    for (const [phrase, rows] of candidates) {
        if ([...covered].some(existing => existing.includes(phrase))) continue;
        covered.add(phrase);
        const row = rows[2];
        const local = row.text.indexOf(phrase);
        if (local < 0) continue;
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'repeated-imagery',
            severity: 'minor',
            category: 'style',
            start: row.start + local,
            end: row.start + local + phrase.length,
            message: `意象“${phrase}”至少跨三个段落重复出现。`,
            suggestion: '保留最有力度的一次，其余位置改写为新的感官信息或动作后果。',
        }));
        if (issues.length >= 8) break;
    }
    return issues;
}

function paragraphKind(value) {
    const dialogueCharacters = [...value.matchAll(/[“「『]([^”」』]+)[”」』]/gu)]
        .reduce((sum, match) => sum + match[1].length, 0);
    if (dialogueCharacters >= Math.max(4, value.length * 0.35) || /^[“「『]/u.test(value.trim())) return 'dialogue';
    if (ACTION_PATTERN.test(value)) return 'action';
    return 'description';
}

function structureIssues(content, paragraphRows) {
    if (paragraphRows.length < 6) return [];
    const kinds = paragraphRows.map(row => paragraphKind(row.text));
    const issues = [];
    for (let index = 0; index + 5 < kinds.length; index += 1) {
        const first = kinds.slice(index, index + 3).join(':');
        const second = kinds.slice(index + 3, index + 6).join(':');
        if (first !== second) continue;
        const row = paragraphRows[index + 3];
        const endRow = paragraphRows[index + 5];
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'isomorphic-paragraphs',
            severity: 'minor',
            category: 'pacing',
            start: row.start,
            end: endRow.end,
            message: `连续两组段落复用了 ${first.replaceAll(':', ' / ')} 结构。`,
            suggestion: '让第二组承担不同功能，例如改变信息量、冲突强度或叙述距离。',
        }));
        if (first === 'description:dialogue:description') {
            issues.push(makeIssue(content, paragraphRows, {
                ruleId: 'description-dialogue-loop',
                severity: 'major',
                category: 'pacing',
                start: row.start,
                end: endRow.end,
                message: '描写、对白、描写的循环连续复现，场景推进呈机械节拍。',
                suggestion: '用人物决定、不可逆结果或新阻力打断第二轮循环。',
            }));
        }
        index += 5;
    }
    return issues;
}

function boundaryIssues(content, paragraphRows) {
    if (!content.trim()) return [];
    const issues = [];
    const opening = content.slice(0, Math.min(160, content.length));
    const retrospective = RETROSPECTIVE_PATTERN.exec(opening);
    if (retrospective) {
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'retrospective-opening',
            severity: 'minor',
            category: 'opening',
            start: retrospective.index,
            end: retrospective.index + retrospective[0].length,
            message: '章节开头先进入回顾信息，当前危机和行动被延后。',
            suggestion: '先给出当下的异常、选择或压力，再把必要回忆嵌入行动。',
        }));
    }
    const endingStart = Math.max(0, content.length - 240);
    const ending = content.slice(endingStart).trimEnd();
    const summary = SUMMARY_ENDING_PATTERN.exec(ending);
    if (summary) {
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'summary-ending',
            severity: 'major',
            category: 'ending',
            start: endingStart + summary.index,
            end: endingStart + summary.index + summary[0].length,
            message: '章尾用总结判断代替了可感知的结果或悬念。',
            suggestion: '收在新事实、未完成动作、代价落地或迫近选择上。',
        }));
    }
    const next = NEXT_CHAPTER_PATTERN.exec(ending);
    if (next) {
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'premature-next-chapter',
            severity: 'major',
            category: 'ending',
            start: endingStart + next.index,
            end: endingStart + next.index + next[0].length,
            message: '正文显式预告下一章，破坏沉浸并提前消费后续内容。',
            suggestion: '删除章节预告，让当前事件产生的悬念自然牵引下一章。',
        }));
    }
    return issues;
}

function timeIssues(content, paragraphRows) {
    const occurrences = [];
    for (const [label, minutes] of TIME_MARKERS) {
        for (const match of content.matchAll(new RegExp(label, 'gu'))) {
            occurrences.push({ label, minutes, start: match.index, end: match.index + label.length });
        }
    }
    occurrences.sort((left, right) => left.start - right.start);
    const issues = [];
    for (let index = 1; index < occurrences.length; index += 1) {
        const previous = occurrences[index - 1];
        const current = occurrences[index];
        if (current.minutes + 180 >= previous.minutes) continue;
        const bridge = content.slice(previous.end, current.start);
        if (TRANSITION_PATTERN.test(bridge)) continue;
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'time-jump',
            severity: 'major',
            category: 'continuity',
            start: current.start,
            end: current.end,
            message: `时间从“${previous.label}”跳回“${current.label}”，正文没有明确转场。`,
            suggestion: '补足跨日、回忆或倒叙标记，或修正时间词。',
        }));
    }
    return issues;
}

function normalizeEntity(value, index) {
    const entity = plain(value, `entities[${index}]`);
    const id = boundedText(entity.id, `entities[${index}].id`, 128);
    const name = boundedText(entity.name, `entities[${index}].name`, 160);
    const aliases = boundedArray(entity.aliases, `entities[${index}].aliases`)
        .map((alias, aliasIndex) => boundedText(alias, `entities[${index}].aliases[${aliasIndex}]`, 160))
        .filter(Boolean);
    return { id, name, aliases };
}

function appellationIssues(content, paragraphRows, entities) {
    const issues = [];
    for (const entity of entities) {
        const labels = [entity.name, ...entity.aliases].filter(label => label.length >= 2);
        const used = labels.filter(label => content.includes(label));
        if (used.length < 2) continue;
        const secondary = used.find(label => label !== entity.name) ?? used[1];
        const start = content.indexOf(secondary);
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'appellation-drift',
            severity: 'minor',
            category: 'continuity',
            start,
            end: start + secondary.length,
            message: `同一人物在本章使用了多个称呼：${used.join('、')}。`,
            suggestion: '确认称呼变化是否由视角、关系或场景触发；无依据时统一称呼。',
            evidenceIds: [`entity:${entity.id}`],
        }));
    }
    return issues;
}

function salientTerms(value) {
    const text = boundedText(value, 'coverage text', MAX_TEXT).trim();
    if (!text) return [];
    const explicit = text.split(/[\r\n,，、;；|]+/u).map(item => item.trim()).filter(Boolean);
    return explicit.map(item => {
        const tokens = item.match(/[\p{Script=Han}]{2,8}|[\p{L}\p{N}]{3,}/gu) ?? [];
        const meaningful = tokens.filter(token => !COMMON_NGRAM.test(token));
        const variants = meaningful.flatMap(token => {
            if (!/^[\p{Script=Han}]+$/u.test(token) || token.length < 4) return [token];
            const edge = token.length >= 6 ? 3 : 2;
            return [token, token.slice(0, edge), token.slice(-edge)];
        });
        return { item, terms: [...new Set(variants)].slice(0, 12) };
    });
}

function termHit(content, terms) {
    if (terms.length === 0) return false;
    return terms.some(term => content.toLocaleLowerCase('zh-CN').includes(term.toLocaleLowerCase('zh-CN')));
}

function firstTermSpan(content, terms) {
    for (const term of terms) {
        const start = content.toLocaleLowerCase('zh-CN').indexOf(term.toLocaleLowerCase('zh-CN'));
        if (start >= 0) return { start, end: start + term.length };
    }
    return null;
}

function avoidHit(content, entry) {
    const normalized = content.toLocaleLowerCase('zh-CN');
    if (normalized.includes(entry.item.toLocaleLowerCase('zh-CN'))) return true;
    const fragments = entry.terms.filter(term => term !== entry.item && term.length >= 2);
    return fragments.length >= 2 && fragments.every(term => normalized.includes(term.toLocaleLowerCase('zh-CN')));
}

function coverageIssues(content, paragraphRows, chapterCard, volumeGoal, promises) {
    const issues = [];
    const required = salientTerms(chapterCard.required);
    const avoid = salientTerms(chapterCard.avoid);
    const requiredResults = required.map(entry => ({ ...entry, met: termHit(content, entry.terms) }));
    const avoidResults = avoid.map(entry => ({ ...entry, hit: avoidHit(content, entry) }));
    for (const entry of requiredResults.filter(item => !item.met)) {
        const anchor = paragraphRows.at(-1) ?? { start: 0, end: content.length };
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'chapter-required-missed',
            severity: 'major',
            category: 'plan',
            start: anchor.start,
            end: Math.max(anchor.start + 1, anchor.end),
            message: `章纲 required 未获得可核验覆盖：${entry.item}`, suggestion: '补入对应行动、信息或结果，并在章纲中使用可检索的关键表达。',
        }));
    }
    for (const entry of avoidResults.filter(item => item.hit)) {
        const span = firstTermSpan(content, entry.terms);
        if (!span) continue;
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'chapter-avoid-hit', severity: 'blocker', category: 'plan', ...span,
            message: `正文命中了章纲 avoid：${entry.item}`, suggestion: '删除或延后被禁止的信息、事件或结果。',
        }));
    }
    const volumeEntry = salientTerms(volumeGoal)[0] ?? null;
    const volumeGoalResult = volumeEntry
        ? { ...volumeEntry, met: termHit(content, volumeEntry.terms) }
        : { item: '', terms: [], met: true, applicable: false };
    if (volumeEntry && !volumeGoalResult.met) {
        const anchor = paragraphRows.at(-1) ?? { start: 0, end: content.length };
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'volume-goal-missed', severity: 'minor', category: 'plan', start: anchor.start,
            end: Math.max(anchor.start + 1, anchor.end), message: `本章没有显示推进卷目标：${volumeEntry.item}`,
            suggestion: '加入能改变卷级局势、资源、关系或信息状态的具体结果。',
        }));
    }
    const promiseResults = promises.filter(item => ['open', 'active', 'introduced'].includes(item.status ?? 'open'))
        .map(item => {
            const source = [item.title, item.summary].filter(Boolean).join('，');
            const terms = salientTerms(source).flatMap(entry => entry.terms);
            return { id: item.id, title: item.title, terms, touched: termHit(content, terms) };
        });
    for (const item of promiseResults.filter(entry => !entry.touched)) {
        const anchor = paragraphRows.at(-1) ?? { start: 0, end: content.length };
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'promise-missed', severity: 'minor', category: 'promise', start: anchor.start,
            end: Math.max(anchor.start + 1, anchor.end), message: `待兑现事项没有获得触碰：${item.title || item.id}`,
            suggestion: '用提醒、阻碍、线索或代价推进该事项，不必在本章直接解决。', evidenceIds: [`promise:${item.id}`],
        }));
    }
    return {
        issues,
        coverage: {
            required: requiredResults,
            avoid: avoidResults,
            volumeGoal: volumeGoalResult,
            promises: promiseResults,
        },
    };
}

function protectedFactIssues(content, paragraphRows, protectedFacts) {
    const issues = [];
    for (const [index, value] of protectedFacts.entries()) {
        const fact = plain(value, `protectedFacts[${index}]`);
        const id = boundedText(fact.id, `protectedFacts[${index}].id`, 128);
        const summary = boundedText(fact.summary, `protectedFacts[${index}].summary`, 4_000);
        const fragments = salientTerms(summary).flatMap(entry => entry.terms).filter(term => term.length >= 3);
        const span = firstTermSpan(content, fragments);
        if (!span) continue;
        issues.push(makeIssue(content, paragraphRows, {
            ruleId: 'pov-knowledge-leak', severity: 'blocker', category: 'pov', ...span,
            message: '正文出现了当前 POV 尚未获得的事实。', suggestion: '删除确定性叙述，或先在场景中建立人物获得该信息的证据。',
            evidenceIds: [`fact:${id}`],
        }));
    }
    return issues;
}

function normalizePromise(value, index) {
    const item = plain(value, `promises[${index}]`);
    return {
        id: boundedText(item.id, `promises[${index}].id`, 128),
        title: boundedText(item.title, `promises[${index}].title`, 500),
        summary: boundedText(item.summary, `promises[${index}].summary`, 4_000),
        status: boundedText(item.status, `promises[${index}].status`, 64, 'open'),
    };
}

function dedupeIssues(issues) {
    const unique = new Map();
    for (const issue of issues) {
        const key = `${issue.ruleId}:${issue.start}:${issue.end}`;
        if (!unique.has(key)) unique.set(key, issue);
    }
    return [...unique.values()].sort((left, right) => (
        left.start - right.start || left.end - right.end || left.ruleId.localeCompare(right.ruleId)
    ));
}

export function lintChapterQuality(value) {
    const input = plain(value, 'quality input');
    const allowed = new Set(['content', 'chapterCard', 'volumeGoal', 'promises', 'entities', 'protectedFacts']);
    const unknown = Object.keys(input).filter(field => !allowed.has(field));
    if (unknown.length > 0) {
        throw new ApiError(400, 'invalid_quality_input', 'Quality input contains unknown fields.', { fields: unknown });
    }
    const content = boundedText(input.content, 'content', MAX_CONTENT_CHARACTERS);
    if (!content.trim()) throw new ApiError(400, 'invalid_quality_input', 'content must not be empty.');
    const cardSource = input.chapterCard === undefined ? {} : plain(input.chapterCard, 'chapterCard');
    const chapterCard = {
        required: boundedText(cardSource.required, 'chapterCard.required'),
        avoid: boundedText(cardSource.avoid, 'chapterCard.avoid'),
    };
    const volumeGoal = boundedText(input.volumeGoal, 'volumeGoal');
    const entities = boundedArray(input.entities, 'entities').map(normalizeEntity);
    const promises = boundedArray(input.promises, 'promises').map(normalizePromise);
    const protectedFacts = boundedArray(input.protectedFacts, 'protectedFacts');
    const paragraphRows = paragraphs(content);
    const sentenceRows = sentences(content, paragraphRows);
    const coverage = coverageIssues(content, paragraphRows, chapterCard, volumeGoal, promises);
    const issues = dedupeIssues([
        ...repeatedOpenings(content, paragraphRows, sentenceRows),
        ...repeatedImagery(content, paragraphRows, entities),
        ...structureIssues(content, paragraphRows),
        ...boundaryIssues(content, paragraphRows),
        ...timeIssues(content, paragraphRows),
        ...appellationIssues(content, paragraphRows, entities),
        ...protectedFactIssues(content, paragraphRows, protectedFacts),
        ...coverage.issues,
    ]);
    const severityCounts = Object.fromEntries([...ISSUE_SEVERITIES].map(severity => [
        severity,
        issues.filter(issue => issue.severity === severity).length,
    ]));
    const ruleCounts = Object.fromEntries(QUALITY_RULES.map(ruleId => [
        ruleId,
        issues.filter(issue => issue.ruleId === ruleId).length,
    ]));
    const report = {
        schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
        contentDigest: digest(content),
        contentUnits: countContentUnits(content),
        passed: severityCounts.blocker === 0 && severityCounts.major === 0,
        metrics: {
            characters: content.length,
            paragraphs: paragraphRows.length,
            sentences: sentenceRows.length,
            dialogueParagraphs: paragraphRows.filter(row => paragraphKind(row.text) === 'dialogue').length,
            severityCounts,
            ruleCounts,
        },
        coverage: coverage.coverage,
        issues,
    };
    return { ...report, reportDigest: digest(report) };
}
