import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Packaged deterministic Provider used by local acceptance and integration tests.
const DEFAULT_PORT = 9_124;
const DEFAULT_CHUNK_DELAY = 1_500;
const STORY_STATE_CATEGORIES = Object.freeze([
    'entities', 'relations', 'events', 'promises', 'memory', 'facts', 'knowledge', 'timeline',
]);

export const LEGACY_STREAM_CHUNKS = Object.freeze([
    '暮色压在赤门上。',
    '林照握紧铜钥匙，踏过门槛。',
    '门后传来守将低沉的询问。',
]);

const WORKFLOW_V2_DRAFT = [
    '暮色压在赤门上，城楼最后一声暮鼓刚刚散尽，林照便沿着阴影走到门洞前。',
    '守将没有让路，只把右手按在刀柄上，问他从哪里得到那枚铜钥匙。林照没有核对暗号，便把铜钥匙交到守将掌心。',
    '钥匙触到甲片的刹那，门轴深处响起一声闷震。林照听见身后追兵踏过石街，只得撞开半掩的侧门，把守将和追兵一起甩在赤门内。',
    '侧门外不是官道，而是一条被雾吞没的旧渠。林照夺回钥匙时，钥匙边缘已经多出一道新刻痕，像是在为下一扇门标记方向。',
].join('\n\n');

function readJson(request) {
    return new Promise((resolve, reject) => {
        let value = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { value += chunk; });
        request.on('end', () => {
            try {
                resolve(JSON.parse(value || '{}'));
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function requestPrompt(body) {
    if (Array.isArray(body?.messages)) {
        return body.messages.map(message => String(message?.content ?? '')).join('\n');
    }
    return String(body?.prompt ?? '');
}

function parseInertJson(prompt) {
    const beginMarker = 'BEGIN_INERT_JSON_DATA';
    const endMarker = 'END_INERT_JSON_DATA';
    const begin = prompt.indexOf(beginMarker);
    if (begin < 0) return {};
    const valueStart = begin + beginMarker.length;
    const end = prompt.indexOf(endMarker, valueStart);
    if (end < 0) return {};
    try {
        return JSON.parse(prompt.slice(valueStart, end).trim());
    } catch {
        return {};
    }
}

function paragraphIndexAt(source, offset) {
    return source.slice(0, offset).split(/\r?\n[\t ]*\r?\n/u).length - 1;
}

function uniqueMatches(source, pattern) {
    return [...new Set([...source.matchAll(pattern)].map(match => match[1] ?? match[0]))];
}

function storyStateChanges(chapterId) {
    return {
        entities: {
            upsert: [
                {
                    id: 'char-linzhao',
                    kind: 'character',
                    name: '林照',
                    summary: '已越过赤门并进入旧渠。',
                    aliases: [],
                    status: 'active',
                    locationEntityId: 'location-old-canal',
                    currentGoal: '弄清铜钥匙新增刻痕的用途。',
                    currentAction: '沿旧渠撤离追兵视线。',
                    updatedChapterId: chapterId,
                },
                {
                    id: 'location-old-canal',
                    kind: 'location',
                    name: '赤门旧渠',
                    summary: '赤门侧门外被雾覆盖的废弃水渠。',
                    aliases: ['旧渠'],
                    status: 'active',
                    locationEntityId: null,
                    currentGoal: '',
                    currentAction: '',
                    updatedChapterId: chapterId,
                },
            ],
            delete: [],
        },
        relations: { upsert: [], delete: [] },
        events: {
            upsert: [{
                id: 'event-enter-old-canal',
                kind: 'story',
                title: '越过赤门',
                summary: '林照从赤门侧门进入旧渠并暂时摆脱追兵。',
                chapterId,
                entityIds: ['char-linzhao'],
                status: 'occurred',
                order: 1,
                timelineId: 'timeline-enter-old-canal',
                locationEntityId: 'location-old-canal',
                progress: 100,
                visibility: 'reader-and-linzhao',
            }],
            delete: [],
        },
        promises: {
            upsert: [{
                id: 'promise-copper-key-mark',
                title: '铜钥匙的新刻痕',
                summary: '铜钥匙在开启赤门侧门后出现了指向未知门扉的新刻痕。',
                introducedChapterId: chapterId,
                dueChapterId: null,
                resolvedChapterId: null,
                status: 'open',
                kind: 'mystery',
                urgency: 3,
                evidenceChapterIds: chapterId ? [chapterId] : [],
            }],
            delete: [],
        },
        memory: {
            upsert: [{
                id: 'memory-red-gate-chapter',
                kind: 'chapter',
                summary: '林照携带铜钥匙越过赤门，并发现钥匙出现新刻痕。',
                chapterId,
                importance: 4,
                tags: ['赤门', '铜钥匙', '旧渠'],
                status: 'active',
                supersededById: null,
                confidence: 1,
                sourceChapterIds: chapterId ? [chapterId] : [],
            }],
            delete: [],
        },
        facts: {
            upsert: [{
                id: 'fact-linzhao-keeps-key',
                summary: '林照仍持有出现新刻痕的铜钥匙。',
                subjectEntityId: 'char-linzhao',
                sourceChapterId: chapterId,
                status: 'active',
                supersededById: null,
                confidence: 1,
                tags: ['铜钥匙'],
            }],
            delete: [],
        },
        knowledge: {
            upsert: [{
                id: 'knowledge-linzhao-key-mark',
                entityId: 'char-linzhao',
                factId: 'fact-linzhao-keeps-key',
                stance: 'knows',
                learnedChapterId: chapterId,
                status: 'active',
            }],
            delete: [],
        },
        timeline: {
            upsert: [{
                id: 'timeline-enter-old-canal',
                label: '林照越过赤门进入旧渠',
                storyTime: '暮色时分',
                sequence: 1,
                chapterId,
                locationEntityId: 'location-old-canal',
                status: 'occurred',
            }],
            delete: [],
        },
    };
}

function chapterIdFromPrompt(prompt, materials = {}) {
    return materials?.sourceSnapshot?.chapter?.id
        ?? prompt.match(/本章 ID 是 ([a-zA-Z0-9._-]+)/u)?.[1]
        ?? null;
}

function distillation(prompt, materials = {}) {
    const chapterId = chapterIdFromPrompt(prompt, materials);
    return {
        chapterSummary: '林照越过赤门进入旧渠，保住铜钥匙并发现一道新刻痕。',
        storyStateChanges: storyStateChanges(chapterId),
    };
}

function brainstormOutput() {
    const directions = [
        {
            id: 'route-side-gate',
            title: '借侧门反锁追兵',
            forkChoice: '林照相信守将的临时暗号，利用赤门侧门撤离。',
            protagonistAction: '林照以铜钥匙启动侧门机关，并在穿门后反锁门轴。',
            directResult: '追兵被暂时隔在赤门内，林照进入城外旧渠。',
            delayedCost: '铜钥匙留下新刻痕，也暴露它能驱动城门机关。',
            chapterPromise: '兑现赤门危机，同时抛出铜钥匙对应下一扇门的谜题。',
            eventSeeds: ['守将索要铜钥匙', '侧门机关被触发', '追兵冲入门洞', '钥匙出现新刻痕'],
        },
        {
            id: 'route-drain',
            title: '潜入暗渠绕过封锁',
            forkChoice: '林照拒绝接触守将，转而从排水暗渠离城。',
            protagonistAction: '林照用铜钥匙撬开暗渠检修栅，独自潜入涨水的地下水道。',
            directResult: '林照避开正门追兵，却被水流带离预定路线。',
            delayedCost: '他失去与接应者会合的时间窗口，并在水下留下血迹。',
            chapterPromise: '把逃离封锁转化为暗渠生存危机与失联代价。',
            eventSeeds: ['拒绝守将盘问', '撬开暗渠栅栏', '水位突然上涨', '被冲向未知出口'],
        },
        {
            id: 'route-bell-tower',
            title: '登城楼制造换防',
            forkChoice: '林照放弃立即离城，登上钟楼伪造紧急换防信号。',
            protagonistAction: '林照挟持传令兵并敲响禁用钟序，迫使守军重排门岗。',
            directResult: '赤门短暂失去统一指挥，林照获得公开穿门的空档。',
            delayedCost: '禁钟暴露城内有内应，整座城区随后进入更严厉的搜捕。',
            chapterPromise: '用主动骗局换取爽点，并把局部追捕升级为全城戒严。',
            eventSeeds: ['发现钟楼传令兵', '伪造换防钟序', '守军调离门洞', '全城戒严升级'],
        },
    ];
    return {
        exclusivityAxis: '林照只能在侧门合作、暗渠潜逃和钟楼欺骗三种离城承诺中选择一种。',
        directions: directions.map(direction => ({
            ...direction,
            pairwiseExclusion: directions
                .filter(other => other.id !== direction.id)
                .map(other => ({
                    otherDirectionId: other.id,
                    reason: `${direction.id} 已消耗本章唯一的离城窗口，无法同时执行 ${other.id}。`,
                })),
        })),
    };
}

function planOutput(materials) {
    const selected = materials?.selectedDirection?.direction ?? {};
    const routeTitle = String(selected.title || '侧门撤离');
    const chapterCard = {
        summary: `林照执行“${routeTitle}”，越过赤门后保住铜钥匙，却发现钥匙出现新刻痕。`,
        goal: '在追兵封死赤门前越过城门，并保住铜钥匙。',
        conflict: '守将索要钥匙、追兵逼近，侧门机关只提供一次开启机会。',
        turn: '铜钥匙触发侧门后出现新刻痕，说明这次开门也激活了更远的目标。',
        hook: '旧渠雾中亮起与钥匙刻痕完全相同的门形微光。',
        pov: '林照限知第三人称。',
        time: '暮色鼓声结束后的片刻。',
        location: '赤门门洞至城外旧渠。',
        required: '必须写清林照的主动选择、侧门开启的直接结果和保住钥匙所付出的代价。',
        avoid: '不得提前揭示新刻痕对应门扉的主人与最终用途。',
    };
    const sourceEvents = Array.isArray(selected.sourceEventChain) ? selected.sourceEventChain : [];
    const eventChain = [
        {
            id: 'beat-1',
            causedBy: null,
            trigger: '追兵脚步逼近赤门',
            choice: '留下核验守将而非立刻逃入死角',
            action: '林照逼问守将暗号并观察甲片印记',
            result: '确认守将知道侧门机关',
            cost: '追兵距离缩短',
            valueShift: '孤立无援转为获得一条高风险通路',
            information: '铜钥匙能够驱动赤门侧门',
        },
        {
            id: 'beat-2',
            causedBy: 'beat-1',
            trigger: '守将要求亲手接过铜钥匙',
            choice: '只展示纹路而不交出钥匙',
            action: '林照把钥匙压入门轴凹槽',
            result: '侧门开始开启',
            cost: '机关声暴露当前位置',
            valueShift: '受阻转为打开离城窗口',
            information: '侧门只能维持数息',
        },
        {
            id: 'beat-3',
            causedBy: 'beat-2',
            trigger: '追兵冲入门洞',
            choice: '先越门再破坏回转齿',
            action: '林照撞过侧门并反锁门轴',
            result: '追兵与守将被隔在门内',
            cost: '退路同时被封死',
            valueShift: '被包围转为暂时脱身',
            information: '城外出口通向废弃旧渠',
        },
        {
            id: 'beat-4',
            causedBy: 'beat-3',
            trigger: '铜钥匙在掌中发热',
            choice: '保留钥匙并沿刻痕指向前进',
            action: '林照擦去钥匙表面的血与泥',
            result: '发现一道新刻痕',
            cost: '必须进入未知雾渠',
            valueShift: '逃出城门转为踏入更深谜局',
            information: '刻痕指向旧渠深处的另一扇门',
        },
    ];
    for (let index = eventChain.length; index < sourceEvents.length; index += 1) {
        eventChain.push({
            id: `beat-${index + 1}`,
            causedBy: `beat-${index}`,
            trigger: `源事件 ${index + 1} 触发新的局势`,
            choice: `林照针对源事件 ${index + 1} 作出独立选择`,
            action: `林照执行源事件 ${index + 1} 的独立行动`,
            result: `源事件 ${index + 1} 产生独立直接结果`,
            cost: `源事件 ${index + 1} 留下独立代价`,
            valueShift: `源事件 ${index + 1} 完成一次独立价值转折`,
            information: `源事件 ${index + 1} 释放独立信息`,
        });
    }
    const sourceEventCoverage = sourceEvents.map((event, index) => ({
        sourceOrder: event.order,
        beatIds: [`beat-${index + 1}`],
    }));
    return {
        eventChain,
        chapterCard,
        coverage: {
            required: [{ item: chapterCard.required, beatIds: ['beat-1', 'beat-2', 'beat-3', 'beat-4'] }],
            avoid: [{ item: chapterCard.avoid, guard: '只呈现门形微光，不解释其主人和用途。' }],
            volumeGoal: { summary: '主角突破赤门封锁并把铜钥匙线索推进一层。', beatIds: ['beat-3', 'beat-4'] },
            promises: [],
        },
        ...(sourceEventCoverage.length > 0 ? { sourceEventCoverage } : {}),
    };
}

function reviewOutput(materials, { rewriteRequired = true } = {}) {
    const manuscript = String(materials?.candidateManuscript ?? '');
    const card = materials?.approvedPlan?.chapterCard ?? {};
    if (!rewriteRequired) {
        return {
            verdict: 'pass',
            rewriteRequired: false,
            summary: '正文通过证据定位审查，不需要定向修复。',
            issues: [],
            rewriteTarget: null,
            coverage: {
                goal: { status: 'met', evidenceIssueIds: [] },
                required: card.required
                    ? [{ item: card.required, status: 'met', evidenceIssueIds: [] }]
                    : [],
                avoid: card.avoid
                    ? [{ item: card.avoid, status: 'met', evidenceIssueIds: [] }]
                    : [],
                volumeGoal: { status: 'met', evidenceIssueIds: [] },
                promises: [],
            },
        };
    }
    const preferredQuote = '林照没有核对暗号，便把铜钥匙交到守将掌心。';
    const fallback = manuscript.match(/\S.{0,47}/u)?.[0] ?? manuscript;
    const quote = manuscript.includes(preferredQuote) ? preferredQuote : fallback;
    const start = Math.max(0, manuscript.indexOf(quote));
    const end = start + quote.length;
    const issueId = 'issue-unearned-trust';
    return {
        verdict: 'rewrite',
        rewriteRequired: true,
        summary: '正文推进有效，但交出关键道具的动作缺少核验与风险控制，削弱了主角能动性。',
        issues: [{
            id: issueId,
            severity: 'major',
            category: 'motivation',
            start,
            end,
            paragraphIndex: paragraphIndexAt(manuscript, start),
            quote,
            reason: '主角在追兵逼近时直接交出核心道具，和章卡要求的主动选择不一致。',
            suggestion: '先核验暗号，只展示钥匙纹路并保持控制权。',
            evidenceIds: [],
        }],
        rewriteTarget: {
            start,
            end,
            quote,
            issueIds: [issueId],
            instruction: '保留守将盘问和侧门触发结果，补足暗号核验，并让林照始终掌握铜钥匙。',
        },
        coverage: {
            goal: { status: 'partial', evidenceIssueIds: [issueId] },
            required: card.required
                ? [{ item: card.required, status: 'partial', evidenceIssueIds: [issueId] }]
                : [],
            avoid: card.avoid
                ? [{ item: card.avoid, status: 'met', evidenceIssueIds: [] }]
                : [],
            volumeGoal: { status: 'met', evidenceIssueIds: [] },
            promises: [],
        },
    };
}

function rewriteOutput(materials) {
    const issueIds = Array.isArray(materials?.approvedRange?.issueIds)
        ? materials.approvedRange.issueIds
        : ['issue-unearned-trust'];
    return {
        replacement: '林照先逼问暗号，又盯住守将甲片上的旧印，确认两处都对得上，才让他看清铜钥匙的纹路；钥匙始终扣在林照自己掌中。',
        issueIds,
    };
}

function adoptionOutput(prompt, materials) {
    const chapterSummary = String(
        materials?.approvedPlan?.chapterCard?.summary
        ?? '林照越过赤门进入旧渠，保住铜钥匙并发现一道新刻痕。',
    );
    return {
        chapterSummary,
        storyStateChanges: storyStateChanges(chapterIdFromPrompt(prompt, materials)),
    };
}

function copilotOutput(prompt) {
    const optionCountMatch = prompt.match(/必须输出恰好\s*([3-6])\s*个/u);
    const optionCount = Number(optionCountMatch?.[1] ?? 3);
    const evidenceIds = uniqueMatches(prompt, /(evidence_[0-9a-f]{40})/gu);
    const evidenceId = evidenceIds[0] ?? 'evidence_0000000000000000000000000000000000000000';
    const projectId = prompt.match(/\bprojectId=([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})/u)?.[1] ?? 'project-mock';
    const lorebookId = prompt.match(/\bsource=lorebook:([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\b/u)?.[1] ?? null;
    const routeNames = ['守门合作', '暗渠潜逃', '钟楼欺骗', '商队替身', '城墙索降', '公开审判'];
    const plotOptions = Array.from({ length: optionCount }, (_, index) => {
        const number = index + 1;
        const route = routeNames[index];
        return {
            id: `option-${number}`,
            title: `${route}方向`,
            commitment: `选择${route}，并放弃其余离城路线 ${number}`,
            summary: `林照把本章唯一行动窗口押在${route}上，以明确选择换取直接结果，同时承担不可逆代价。`,
            eventChain: [
                {
                    order: 1,
                    event: `${route}的机会在追兵逼近时出现`,
                    characterChoice: `林照决定执行${route}`,
                    directResult: `获得路线 ${number} 的第一段通路`,
                    cost: `失去准备时间 ${number}`,
                },
                {
                    order: 2,
                    event: `${route}遭遇守军阻断`,
                    characterChoice: `林照牺牲一项资源继续推进 ${number}`,
                    directResult: `突破当前阻断 ${number}`,
                    cost: `暴露铜钥匙的一部分能力 ${number}`,
                },
                {
                    order: 3,
                    event: `${route}抵达不可回头的分叉点`,
                    characterChoice: `林照封死退路完成选择 ${number}`,
                    directResult: `越过赤门并进入新场景 ${number}`,
                    cost: `引来下一阶段追索者 ${number}`,
                },
            ],
            hook: `${route}结束时，铜钥匙显出只属于方向 ${number} 的新刻痕。`,
            risks: [`方向 ${number} 会抬高后续追捕压力`, `方向 ${number} 需要下一章兑现新刻痕`],
            evidenceIds: [evidenceId],
        };
    });
    return {
        schemaVersion: 1,
        plotOptions,
        settingEdits: [{
            id: 'setting-red-gate-window',
            appliesToOptionIds: ['option-1'],
            target: { kind: 'project-story', id: projectId, field: 'world' },
            proposedValue: `候选规则：赤门侧门只在三次暮鼓后的短暂窗口开启（证据 ${evidenceId.slice(-8)}）。`,
            rationale: '把方向一的通行机会固化为可追踪、可付代价的世界规则候选。',
            evidenceIds: [evidenceId],
        }],
        lorebookEdits: lorebookId ? [{
            id: 'lorebook-red-gate-candidate',
            appliesToOptionIds: ['option-1'],
            operation: 'create',
            lorebookId,
            entryId: 'red-gate-window-candidate',
            patch: {
                keys: ['赤门', '侧门', '暮鼓'],
                secondaryKeys: ['铜钥匙'],
                comment: 'Copilot 候选：赤门侧门窗口',
                content: '赤门侧门只在三次暮鼓后的短暂窗口响应铜钥匙；开启后必须等待下一次暮色才能复位。',
                enabled: true,
                constant: false,
            },
            rationale: '为方向一提供可见的 Lorebook Diff，仍保持只读候选状态。',
            evidenceIds: [evidenceId],
        }] : [],
    };
}

export function classifyMockProviderRequest(body) {
    const prompt = requestPrompt(body);
    const operation = prompt.match(/(?:^|\n)TASK_KIND:\s*(brainstorm|plan|draft|review|rewrite|adoption)(?:\n|$)/u)?.[1];
    if (operation) return { kind: 'workflow-v2', operation, prompt, materials: parseInertJson(prompt) };
    const schemaName = body?.response_format?.json_schema?.name;
    if (schemaName === 'story_studio_planning_copilot'
        || prompt.includes('StoryStudio Copilot is read-only')
        || prompt.includes('策划 Copilot')) {
        return { kind: 'copilot', operation: 'copilot', prompt, materials: {} };
    }
    if (prompt.includes('状态蒸馏器')) {
        return { kind: 'legacy-distillation', operation: 'distill', prompt, materials: {} };
    }
    return {
        kind: body?.stream === true ? 'legacy-stream' : 'legacy-response',
        operation: body?.stream === true ? 'draft' : 'response',
        prompt,
        materials: {},
    };
}

export function mockCompletionForRequest(body) {
    const route = classifyMockProviderRequest(body);
    let value;
    if (route.kind === 'workflow-v2') {
        switch (route.operation) {
            case 'brainstorm': value = brainstormOutput(); break;
            case 'plan': value = planOutput(route.materials); break;
            case 'draft': value = WORKFLOW_V2_DRAFT; break;
            case 'review': value = reviewOutput(route.materials, {
                rewriteRequired: String(body?.model ?? '') !== 'mock-writer-no-rewrite',
            }); break;
            case 'rewrite': value = rewriteOutput(route.materials); break;
            case 'adoption': value = adoptionOutput(route.prompt, route.materials); break;
            default: value = 'OK';
        }
    } else if (route.kind === 'copilot') {
        value = copilotOutput(route.prompt);
    } else if (route.kind === 'legacy-distillation') {
        value = distillation(route.prompt);
    } else if (route.kind === 'legacy-stream') {
        value = LEGACY_STREAM_CHUNKS.join('');
    } else {
        value = 'OK';
    }
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    const chunks = route.kind === 'legacy-stream'
        ? [...LEGACY_STREAM_CHUNKS]
        : splitCompletion(content);
    return { ...route, content, chunks };
}

function splitCompletion(content) {
    if (content.length < 3) return [content];
    const chunkSize = Math.max(1, Math.ceil(content.length / 3));
    const chunks = [];
    for (let offset = 0; offset < content.length; offset += chunkSize) {
        chunks.push(content.slice(offset, offset + chunkSize));
    }
    return chunks;
}

function streamCompletion(request, response, model, chunks, chunkDelay) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    let index = 0;
    let timer = null;
    let closed = false;
    const stop = () => {
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const writeNext = () => {
        if (closed || request.aborted || response.destroyed) {
            stop();
            return;
        }
        const content = chunks[index] ?? '';
        const finishReason = index === chunks.length - 1 ? 'stop' : null;
        response.write(`data: ${JSON.stringify({
            model,
            choices: [{ delta: { content }, finish_reason: finishReason }],
            ...(finishReason ? { usage: { prompt_tokens: 120, completion_tokens: 32, total_tokens: 152 } } : {}),
        })}\n\n`);
        index += 1;
        if (index === chunks.length) {
            stop();
            response.end('data: [DONE]\n\n');
            return;
        }
        timer = setTimeout(writeNext, chunkDelay);
    };
    request.once('aborted', stop);
    response.once('close', stop);
    timer = setTimeout(writeNext, chunkDelay);
}

export function createMockProviderServer({
    chunkDelay = Number(process.env.MOCK_PROVIDER_CHUNK_DELAY || DEFAULT_CHUNK_DELAY),
} = {}) {
    return http.createServer(async (request, response) => {
        if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Not found' } }));
            return;
        }
        try {
            const body = await readJson(request);
            const model = String(body.model || 'mock-writer');
            const completion = mockCompletionForRequest(body);
            if (body.stream === true) {
                streamCompletion(request, response, model, completion.chunks, Math.max(0, Number(chunkDelay) || 0));
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({
                model,
                choices: [{ message: { content: completion.content } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        } catch {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Invalid request' } }));
        }
    });
}

function runStandalone() {
    const port = Number(process.env.MOCK_PROVIDER_PORT || DEFAULT_PORT);
    const server = createMockProviderServer();
    server.listen(port, '127.0.0.1', () => {
        console.log(`Mock provider listening at http://127.0.0.1:${port}/v1`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => server.close());
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runStandalone();
}
