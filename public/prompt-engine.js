import { compilePromptProfile } from './prompt-profile-compiler.js';

const DEFAULT_PROMPT_LIMIT = 64_000;
const MAX_PROMPT_LIMIT = 1_000_000;

const MACRO_NAMES = [
    'user',
    'char',
    'group',
    'groupNotMuted',
    'charIfNotGroup',
    'notChar',
    'persona',
    'description',
    'personality',
    'scenario',
    'system',
    'original',
    'charPrompt',
    'charInstruction',
    'charJailbreak',
    'mesExamples',
    'mesExamplesRaw',
    'charVersion',
    'char_version',
    'charDepthPrompt',
    'creatorNotes',
    'model',
    'wiBefore',
    'wiAfter',
    'loreBefore',
    'loreAfter',
    'anchorBefore',
    'anchorAfter',
    'projectTitle',
    'chapterNumber',
    'chapterTitle',
    'pov',
    'targetWords',
    'chapterPlan',
    'continuityLedger',
];

const MACRO_NAME_LOOKUP = new Map(MACRO_NAMES.map(name => [name.toLocaleLowerCase(), name]));

const SECTION_ORDER = [
    'main',
    'worldBefore',
    'persona',
    'character',
    'scenario',
    'worldAfter',
    'examples',
    'chapter',
    'ledger',
    'task',
    'postInstruction',
];

const SECTION_WEIGHTS = {
    main: 4,
    worldBefore: 2,
    persona: 2,
    character: 3,
    scenario: 3,
    worldAfter: 2,
    examples: 1,
    chapter: 5,
    ledger: 4,
    task: 6,
    postInstruction: 6,
};

const PROFILE_GENERATION_PARAMETERS = new Set([
    'stop',
    'temperature',
    'topP',
    'topK',
    'topA',
    'minP',
    'frequencyPenalty',
    'presencePenalty',
    'repetitionPenalty',
    'seed',
    'assistantPrefill',
    'contextTokens',
    'maxTokens',
]);

const LORE_POSITION = {
    0: 'before',
    1: 'after',
    4: 'atDepth',
    before: 'before',
    before_char: 'before',
    after: 'after',
    after_char: 'after',
    atdepth: 'atDepth',
    at_depth: 'atDepth',
    depth: 'atDepth',
};

function stableJson(value) {
    const seen = new WeakSet();
    const normalize = item => {
        if (item === null || typeof item !== 'object') return item;
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
        if (Array.isArray(item)) return item.map(normalize);
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return JSON.stringify(normalize(value), null, 2);
}

function textValue(value, { joinArrays = false } = {}) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (joinArrays && Array.isArray(value)) return value.map(item => textValue(item)).filter(Boolean).join(', ');
    return stableJson(value);
}

function warning(code, message, details = {}) {
    return { code, message, ...details };
}

function uniqueWarnings(warnings) {
    const seen = new Set();
    return warnings.filter(item => {
        const key = stableJson(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Expands a deliberately small, deterministic subset of SillyTavern macros.
 * Macro values are inserted once and are never recursively evaluated.
 *
 * @param {unknown} template Trusted prompt/card template text.
 * @param {Record<string, unknown>} [context] Values available to the whitelist.
 * @returns {{text: string, warnings: Array<object>}}
 */
export function expandTavernMacros(template, context = {}) {
    const source = String(template ?? '');
    const warnings = [];
    const warned = new Set();
    const values = {};

    for (const name of MACRO_NAMES) {
        const exactValue = context?.[name];
        const caseInsensitiveKey = Object.keys(context || {}).find(key => key.toLocaleLowerCase() === name.toLocaleLowerCase());
        values[name] = exactValue ?? (caseInsensitiveKey ? context[caseInsensitiveKey] : '');
    }

    const text = source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expression) => {
        const token = String(expression).trim();
        const canonicalName = MACRO_NAME_LOOKUP.get(token.toLocaleLowerCase());
        if (!canonicalName) {
            const warningKey = token.toLocaleLowerCase();
            if (!warned.has(warningKey)) {
                warnings.push(warning(
                    'unknown_macro',
                    `Unsupported macro was preserved: {{${token}}}`,
                    { macro: token },
                ));
                warned.add(warningKey);
            }
            return whole;
        }

        const joinArrays = ['group', 'groupNotMuted', 'charIfNotGroup', 'notChar'].includes(canonicalName);
        return textValue(values[canonicalName], { joinArrays });
    });

    return { text, warnings };
}

function normalizeLoreEntries(entries) {
    if (Array.isArray(entries)) return entries;
    if (entries && typeof entries === 'object') {
        if (Array.isArray(entries.entries)) return entries.entries;
        if (entries.entries && typeof entries.entries === 'object') return Object.values(entries.entries);
        return Object.values(entries);
    }
    return [];
}

function normalizeLorePosition(position) {
    const key = typeof position === 'string' ? position.trim().toLocaleLowerCase() : Number(position);
    return LORE_POSITION[key] || 'before';
}

function normalizeScanMessages(scanText, order) {
    const values = Array.isArray(scanText) ? scanText : [scanText];
    const messages = values.map(value => {
        if (value && typeof value === 'object') {
            return String(value.content ?? value.mes ?? value.text ?? '');
        }
        return String(value ?? '');
    });
    return order === 'oldest-first' ? messages.reverse() : messages;
}

function normalizeKeys(entry, primary) {
    const value = primary
        ? (entry?.key ?? entry?.keys)
        : (entry?.keysecondary ?? entry?.secondary_keys ?? entry?.secondaryKeys);
    if (Array.isArray(value)) return value.map(key => String(key).trim()).filter(Boolean);
    if (value === null || value === undefined || value === '') return [];
    return [String(value).trim()].filter(Boolean);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKey(haystack, key, { caseSensitive, matchWholeWords }) {
    let source = String(haystack ?? '');
    let needle = String(key ?? '');
    if (!caseSensitive) {
        source = source.toLocaleLowerCase();
        needle = needle.toLocaleLowerCase();
    }
    if (!needle) return false;
    if (!matchWholeWords) return source.includes(needle);
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(source);
}

function selectiveMatch(logic, secondaryMatches) {
    if (secondaryMatches.length === 0) return true;
    const any = secondaryMatches.some(Boolean);
    const all = secondaryMatches.every(Boolean);
    switch (Number(logic ?? 0)) {
        case 0: return any;
        case 1: return !all;
        case 2: return !any;
        case 3: return all;
        default: return any;
    }
}

function loreIdentity(entry, index) {
    return entry?.id ?? entry?.uid ?? entry?.identifier ?? `entry-${index}`;
}

/**
 * Activates lore entries deterministically. A probability of zero is honored;
 * stochastic 1-99 sampling, recursion, and mutable timed state are not run.
 * Scan message arrays are newest-first unless options.scanTextOrder is oldest-first.
 * Higher order entries win budget first; returned entries are in prompt order.
 *
 * @param {unknown[]|Record<string, unknown>} entries Lore entries or a Tavern lorebook.
 * @param {unknown|string|unknown[]} scanText Text/messages to scan.
 * @param {object} [options]
 * @returns {{activated: Array<object>, skipped: Array<object>, usedCharacters: number, characterBudget: number, byPosition: object}}
 */
export function activateLoreEntries(entries, scanText, options = {}) {
    const sourceEntries = normalizeLoreEntries(entries);
    const messages = normalizeScanMessages(scanText, options.scanTextOrder);
    const rawBudget = options.characterBudget ?? options.charBudget ?? options.budget ?? Number.POSITIVE_INFINITY;
    const characterBudget = Number.isFinite(Number(rawBudget))
        ? Math.max(0, Math.floor(Number(rawBudget)))
        : Number.POSITIVE_INFINITY;
    const defaultDepthValue = Number(options.scanDepth ?? options.defaultScanDepth);
    const defaultDepth = Number.isFinite(defaultDepthValue) && defaultDepthValue >= 0
        ? Math.floor(defaultDepthValue)
        : messages.length;
    const candidates = [];
    const skipped = [];

    sourceEntries.forEach((rawEntry, index) => {
        const entry = rawEntry && typeof rawEntry === 'object' ? structuredClone(rawEntry) : {};
        const id = loreIdentity(entry, index);
        if (entry.disable === true || entry.disabled === true || entry.enabled === false) {
            skipped.push({ id, entry, reason: 'disabled' });
            return;
        }
        const useProbability = entry.useProbability ?? entry.use_probability ?? true;
        const probability = Number(entry.probability ?? 100);
        if (useProbability && Number.isFinite(probability) && probability <= 0) {
            skipped.push({ id, entry, reason: 'probability_zero' });
            return;
        }

        const content = String(entry.content ?? '');
        if (!content) {
            skipped.push({ id, entry, reason: 'empty_content' });
            return;
        }

        const entryDepthValue = Number(entry.scanDepth ?? entry.scan_depth);
        const scanDepth = Number.isFinite(entryDepthValue) && entryDepthValue >= 0
            ? Math.floor(entryDepthValue)
            : defaultDepth;
        const haystack = messages.slice(0, scanDepth).join('\n');
        const caseSensitive = entry.caseSensitive ?? entry.case_sensitive ?? options.caseSensitive ?? false;
        const matchWholeWords = entry.matchWholeWords ?? entry.match_whole_words ?? options.matchWholeWords ?? false;
        const primaryKeys = normalizeKeys(entry, true);
        const secondaryKeys = normalizeKeys(entry, false);
        const primaryMatches = primaryKeys.map(key => matchesKey(haystack, key, { caseSensitive, matchWholeWords }));
        const secondaryMatches = secondaryKeys.map(key => matchesKey(haystack, key, { caseSensitive, matchWholeWords }));
        const isConstant = entry.constant === true;

        if (!isConstant && primaryKeys.length === 0) {
            skipped.push({ id, entry, reason: 'no_primary_key' });
            return;
        }
        if (!isConstant && !primaryMatches.some(Boolean)) {
            skipped.push({ id, entry, reason: 'primary_miss' });
            return;
        }
        if (!isConstant && !selectiveMatch(entry.selectiveLogic ?? entry.selective_logic, secondaryMatches)) {
            skipped.push({ id, entry, reason: 'secondary_miss' });
            return;
        }

        candidates.push({
            ...entry,
            id,
            content,
            position: normalizeLorePosition(entry.position),
            depth: Math.max(0, Math.floor(Number(entry.depth) || 0)),
            role: entry.role ?? 'system',
            order: Number.isFinite(Number(entry.order ?? entry.insertion_order)) ? Number(entry.order ?? entry.insertion_order) : 100,
            matchedPrimaryKeys: primaryKeys.filter((_, keyIndex) => primaryMatches[keyIndex]),
            matchedSecondaryKeys: secondaryKeys.filter((_, keyIndex) => secondaryMatches[keyIndex]),
            sourceIndex: index,
        });
    });

    candidates.sort((left, right) => right.order - left.order || left.sourceIndex - right.sourceIndex);
    const selected = [];
    let usedCharacters = 0;
    for (const candidate of candidates) {
        const separatorCost = selected.length > 0 ? 1 : 0;
        const characterCost = candidate.content.length + separatorCost;
        const ignoresBudget = candidate.ignoreBudget === true || candidate.ignore_budget === true;
        if (!ignoresBudget && usedCharacters + characterCost > characterBudget) {
            skipped.push({
                id: candidate.id,
                entry: structuredClone(sourceEntries[candidate.sourceIndex]),
                reason: 'budget',
                requiredCharacters: characterCost,
            });
            continue;
        }
        selected.push({ ...candidate, characterCost: ignoresBudget ? 0 : characterCost });
        if (!ignoresBudget) usedCharacters += characterCost;
    }

    const activated = selected.sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex);
    const byPosition = {
        before: activated.filter(entry => entry.position === 'before'),
        after: activated.filter(entry => entry.position === 'after'),
        atDepth: activated.filter(entry => entry.position === 'atDepth'),
    };

    return { activated, skipped, usedCharacters, characterBudget, byPosition };
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null);
}

function cardField(character, key) {
    return firstDefined(character?.[key], character?.data?.[key], '');
}

function primaryCharacter(resources) {
    const characters = Array.isArray(resources?.characters)
        ? resources.characters
        : [resources?.character ?? resources?.characters].filter(Boolean);
    return { character: characters[0] || {}, characters };
}

function formatNamedData(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value.trim();
    return stableJson(value);
}

function formatPersona(persona) {
    if (!persona) return '';
    if (typeof persona === 'string') return persona.trim();
    return [
        persona.name ? `姓名：${persona.name}` : '',
        persona.title ? `身份：${persona.title}` : '',
        persona.description ? `描述：${persona.description}` : '',
    ].filter(Boolean).join('\n');
}

function formatCharacters(characters) {
    return characters.map(character => {
        if (typeof character === 'string') return character.trim();
        const name = cardField(character, 'name');
        const description = cardField(character, 'description');
        const personality = cardField(character, 'personality');
        const creatorNotes = cardField(character, 'creator_notes');
        return [
            name ? `人物：${name}` : '人物：未命名',
            description ? `描述：${description}` : '',
            personality ? `性格：${personality}` : '',
            creatorNotes ? `创作备注：${creatorNotes}` : '',
        ].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

function formatCharacterDescriptions(characters) {
    return characters.map(character => {
        if (typeof character === 'string') return character.trim();
        const name = cardField(character, 'name');
        const description = cardField(character, 'description');
        if (!name && !description) return '';
        return [name ? `人物：${name}` : '', description ? `描述：${description}` : ''].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

function formatCharacterPersonalities(characters) {
    return characters.map(character => {
        if (typeof character === 'string') return '';
        const name = cardField(character, 'name');
        const personality = cardField(character, 'personality');
        if (!personality) return '';
        return [name ? `人物：${name}` : '', `性格：${personality}`].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

function formatCharacterNotes(characters) {
    return characters.map(character => {
        if (typeof character === 'string') return '';
        const name = cardField(character, 'name');
        const creatorNotes = cardField(character, 'creator_notes');
        if (!creatorNotes) return '';
        return [name ? `人物：${name}` : '', `创作备注：${creatorNotes}`].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

function formatScenario(project, scenario) {
    const story = project?.story && typeof project.story === 'object' ? project.story : null;
    return [
        scenario ? `角色场景：${scenario}` : '',
        project?.genre ? `作品类型：${project.genre}` : '',
        story ? `作品设定：\n${stableJson(story)}` : '',
    ].filter(Boolean).join('\n');
}

function formatExamples(resources, characters) {
    const values = [];
    const configured = resources?.examples;
    if (Array.isArray(configured)) values.push(...configured);
    else if (configured) values.push(configured);
    for (const character of characters) {
        const examples = cardField(character, 'mes_example');
        if (examples) values.push(examples);
    }
    return values.map(value => formatNamedData(value)).filter(Boolean).join('\n\n');
}

function formatChapter(project, chapter, previousChapter) {
    const metadata = [
        `作品：${project?.title || '未命名作品'}`,
        `章节：第${chapter?.number ?? 0}章${chapter?.title ? ` ${chapter.title}` : ''}`,
        chapter?.status ? `状态：${chapter.status}` : '',
    ].filter(Boolean).join('\n');
    const previous = previousChapter ? [
        `上章：第${previousChapter.number ?? 0}章${previousChapter.title ? ` ${previousChapter.title}` : ''}`,
        previousChapter.card ? `上章章纲：\n${stableJson(previousChapter.card)}` : '',
        previousChapter.content ? `上章正文：\n${String(previousChapter.content)}` : '',
    ].filter(Boolean).join('\n') : '';
    const current = [
        chapter?.card ? `本章章纲：\n${stableJson(chapter.card)}` : '',
        chapter?.content ? `已有正文：\n${String(chapter.content)}` : '',
    ].filter(Boolean).join('\n');
    return [metadata, previous, current].filter(Boolean).join('\n\n');
}

function normalizeBaseSections(baseSections) {
    const result = {};
    if (Array.isArray(baseSections)) {
        for (const item of baseSections) {
            const key = item?.id ?? item?.identifier ?? item?.name;
            if (key) result[key] = item;
        }
        return result;
    }
    return baseSections && typeof baseSections === 'object' ? baseSections : {};
}

function baseSectionConfig(baseSections, name) {
    const value = baseSections[name];
    if (typeof value === 'string') return { template: value, includeData: true };
    if (value && typeof value === 'object') {
        return {
            template: String(value.template ?? value.content ?? value.text ?? ''),
            includeData: value.includeData !== false && value.replace !== true,
        };
    }
    return { template: '', includeData: true };
}

function loreEntriesFrom(resources, project) {
    const result = [];
    const add = entries => result.push(...normalizeLoreEntries(entries));
    add(resources?.loreEntries);
    add(resources?.worldInfo);
    add(project?.loreEntries);
    for (const book of resources?.lorebooks || []) add(book?.entries ?? book);
    return result;
}

function normalizePromptLimit(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_PROMPT_LIMIT;
    return Math.min(MAX_PROMPT_LIMIT, number);
}

function allocateCharacters(blocks, budget) {
    const allocations = blocks.map(() => 0);
    const schedule = blocks.flatMap((block, index) => Array.from({ length: SECTION_WEIGHTS[block.id] || 1 }, () => index));
    let remaining = Math.max(0, budget);
    while (remaining > 0) {
        let changed = false;
        for (const index of schedule) {
            if (remaining <= 0) break;
            if (allocations[index] >= blocks[index].text.length) continue;
            allocations[index] += 1;
            remaining -= 1;
            changed = true;
        }
        if (!changed) break;
    }
    return allocations;
}

function allocateTaskSectionCharacters(sections, budget) {
    const allocations = sections.map(() => 0);
    const schedule = sections.flatMap((section, index) => Array.from({
        length: Math.min(100, Math.max(1, Math.floor(Number(section.weight) || 1))),
    }, () => index));
    let remaining = Math.max(0, budget);
    while (remaining > 0) {
        let changed = false;
        for (const index of schedule) {
            if (remaining <= 0) break;
            if (allocations[index] >= sections[index].text.length) continue;
            allocations[index] += 1;
            remaining -= 1;
            changed = true;
        }
        if (!changed) break;
    }
    return allocations;
}

function clipTaskSection(section, maximum) {
    if (section.text.length <= maximum) return section.text;
    if (maximum <= 0) return '';
    const marker = '\n[内容因提示词预算省略]\n';
    const mode = ['start', 'end', 'middle'].includes(section.clip) ? section.clip : 'middle';
    if (maximum <= marker.length) {
        if (mode === 'end') return section.text.slice(-maximum);
        if (mode === 'middle') {
            const start = Math.ceil(maximum / 2);
            const end = maximum - start;
            return `${section.text.slice(0, start)}${end > 0 ? section.text.slice(-end) : ''}`;
        }
        return section.text.slice(0, maximum);
    }
    const available = maximum - marker.length;
    if (mode === 'end') return `${marker}${section.text.slice(-available)}`;
    if (mode === 'middle') {
        const start = Math.ceil(available / 2);
        const end = available - start;
        return `${section.text.slice(0, start)}${marker}${end > 0 ? section.text.slice(-end) : ''}`;
    }
    return `${section.text.slice(0, available)}${marker}`;
}

function clipTaskSections(sections, maximum) {
    const nonEmpty = sections.filter(section => section.text);
    const separatorCharacters = Math.max(0, nonEmpty.length - 1) * 2;
    const allocations = allocateTaskSectionCharacters(nonEmpty, Math.max(0, maximum - separatorCharacters));
    return nonEmpty
        .map((section, index) => clipTaskSection(section, allocations[index]))
        .filter(Boolean)
        .join('\n\n');
}

function clipBlock(block, maximum) {
    if (block.text.length <= maximum) return block.text;
    if (maximum <= 0) return '';
    if (block.id === 'task' && Array.isArray(block.taskSections)) {
        return clipTaskSections(block.taskSections, maximum);
    }
    const marker = '\n[内容因提示词预算省略]\n';
    if (block.id === 'chapter' && maximum > marker.length) {
        const available = maximum - marker.length;
        const start = Math.ceil(available / 2);
        return `${block.text.slice(0, start)}${marker}${block.text.slice(-(available - start))}`;
    }
    if (maximum <= marker.length) return block.text.slice(0, maximum);
    return `${block.text.slice(0, maximum - marker.length)}${marker}`;
}

function fitBlocks(blocks, promptLimit) {
    const nonEmptyPromptBlocks = blocks.filter(block => block.id !== 'main' && block.text);
    const separatorCharacters = Math.max(0, nonEmptyPromptBlocks.length - 1) * 2;
    const rawCharacters = blocks.reduce((sum, block) => sum + block.text.length, 0) + separatorCharacters;
    if (rawCharacters <= promptLimit) return blocks.map(block => ({ ...block, fittedText: block.text, truncated: false }));
    const allocations = allocateCharacters(blocks, Math.max(0, promptLimit - separatorCharacters));
    return blocks.map((block, index) => ({
        ...block,
        fittedText: clipBlock(block, allocations[index]),
        truncated: allocations[index] < block.text.length,
    }));
}

function expandTrusted(value, macroContext, warnings, section) {
    const expanded = expandTavernMacros(value, macroContext);
    warnings.push(...expanded.warnings.map(item => ({ ...item, section })));
    return expanded.text.trim();
}

function joinSection(template, data, includeData) {
    return [template, includeData ? data : ''].filter(value => String(value ?? '').trim()).join('\n').trim();
}

function serializeTextPrompt(systemPrompt, prompt, instruct, macroContext, warnings) {
    const settings = instruct && typeof instruct === 'object' ? instruct : {};
    const wrap = settings.wrap !== false;
    const separator = wrap ? '\n' : '';
    const expandSequence = (value, field) => expandTrusted(value, macroContext, warnings, `instruct.${field}`);
    const inputSequence = expandSequence(settings.input_sequence, 'input_sequence');
    const inputSuffix = expandSequence(settings.input_suffix, 'input_suffix') || (wrap ? '\n' : '');
    const outputSequence = expandSequence(settings.last_output_sequence || settings.output_sequence, 'output_sequence');
    const systemSequence = expandSequence(
        settings.system_same_as_user ? settings.input_sequence : settings.system_sequence,
        'system_sequence',
    );
    const systemSuffix = expandSequence(
        settings.system_same_as_user ? settings.input_suffix : settings.system_suffix,
        'system_suffix',
    ) || (wrap ? '\n' : '');
    const systemPart = systemPrompt
        ? [systemSequence, systemPrompt].filter(Boolean).join(separator) + systemSuffix
        : '';
    const inputPart = [inputSequence, prompt].filter(Boolean).join(separator) + inputSuffix;
    return `${systemPart}${inputPart}${outputSequence}`;
}

function serializeOrderedMessages(messages, instruct, macroContext, warnings) {
    const settings = instruct && typeof instruct === 'object' ? instruct : {};
    const wrap = settings.wrap !== false;
    const separator = wrap ? '\n' : '';
    const expandSequence = (value, field) => expandTrusted(value, macroContext, warnings, `instruct.${field}`);
    const systemSameAsUser = settings.system_same_as_user === true;
    const sequences = {
        system: {
            prefix: expandSequence(
                systemSameAsUser ? settings.input_sequence : settings.system_sequence,
                systemSameAsUser ? 'input_sequence' : 'system_sequence',
            ),
            suffix: expandSequence(
                systemSameAsUser ? settings.input_suffix : settings.system_suffix,
                systemSameAsUser ? 'input_suffix' : 'system_suffix',
            ) || (wrap ? '\n' : ''),
        },
        user: {
            prefix: expandSequence(settings.input_sequence, 'input_sequence'),
            suffix: expandSequence(settings.input_suffix, 'input_suffix') || (wrap ? '\n' : ''),
        },
        assistant: {
            prefix: expandSequence(settings.output_sequence, 'output_sequence'),
            suffix: expandSequence(settings.output_suffix, 'output_suffix') || (wrap ? '\n' : ''),
        },
    };
    const serialized = messages.map(message => {
        const sequence = sequences[message.role] ?? sequences.user;
        return [sequence.prefix, message.content].filter(Boolean).join(separator) + sequence.suffix;
    }).join('');
    const outputPrefix = expandSequence(settings.last_output_sequence || settings.output_sequence, 'last_output_sequence');
    return `${serialized}${messages.at(-1)?.role === 'assistant' ? '' : outputPrefix}`;
}

function requiredProfile(profile, runtimeText, taskText, {
    profileSystemText = '',
    characterInstructionText = '',
    managedContextText = '',
    continuityPreflightText = '',
} = {}) {
    const reservedIds = new Set([
        '__story_studio_runtime',
        '__story_studio_profile_system',
        '__story_studio_character_instruction',
        '__story_studio_context',
        '__story_studio_continuity_preflight',
        '__story_studio_task',
    ]);
    const originalModules = Array.isArray(profile.modules) ? profile.modules : [];
    const sourceModules = originalModules
        .filter(module => !reservedIds.has(module?.id))
        .map(module => ({ ...module }));
    const sourceOrder = Array.isArray(profile.order) ? profile.order : sourceModules.map(module => module?.id).filter(Boolean);
    const runtimeId = '__story_studio_runtime';
    const taskId = '__story_studio_task';
    const profileSystemId = '__story_studio_profile_system';
    const characterInstructionId = '__story_studio_character_instruction';
    const managedContextId = '__story_studio_context';
    const continuityPreflightId = '__story_studio_continuity_preflight';
    const warnings = [];
    if (sourceModules.length !== originalModules.length) {
        warnings.push(warning(
            'reserved_module_id_ignored',
            'A profile module used a StoryStudio-reserved identifier and was ignored.',
        ));
    }
    const taskMarkers = sourceModules.filter(module => module?.enabled !== false
        && module?.slot === 'task' && (module?.marker === true || module?.includeData === true));
    const orderedTaskMarker = sourceOrder.map(id => taskMarkers.find(module => module?.id === id)).find(Boolean);
    const taskMarker = orderedTaskMarker ?? taskMarkers[0] ?? null;
    if (taskMarkers.length > 1) {
        warnings.push(warning(
            'multiple_task_markers',
            `Only the first enabled task marker receives StoryStudio task data: ${taskMarker.id}.`,
            { moduleId: taskMarker.id },
        ));
    }
    const preparedModules = sourceModules.map(module => {
        if (module.id === taskMarker?.id) {
            return {
                ...module,
                slot: 'task',
                role: 'user',
                marker: true,
                includeData: true,
                enabled: true,
                priority: 1_000_000,
                tokenBudget: null,
                clipPolicy: 'middle',
                requires: [],
                conflicts: [],
                exclusiveGroup: null,
                when: null,
            };
        }
        if (module.slot === 'runtime' || (module.slot === 'task' && (module.marker === true || module.includeData === true))) {
            return { ...module, marker: false, includeData: false };
        }
        return module;
    });
    const modules = [
        {
            id: runtimeId,
            name: 'StoryStudio Runtime Contract',
            slot: 'runtime',
            role: 'system',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 1_000_000,
            clipPolicy: 'error',
            sourceRef: { source: 'story-studio', kind: 'runtime' },
        },
    ];
    const order = [runtimeId];
    if (profileSystemText) {
        modules.push({
            id: profileSystemId,
            name: 'Profile System Prompt',
            slot: 'profileSystem',
            role: 'system',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 900_000,
            clipPolicy: 'tail',
            sourceRef: { source: 'story-studio', kind: 'profile-system' },
        });
        order.push(profileSystemId);
    }
    if (characterInstructionText) {
        modules.push({
            id: characterInstructionId,
            name: 'Active Character Instruction',
            slot: 'characterInstruction',
            role: 'system',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 900_000,
            clipPolicy: 'tail',
            sourceRef: { source: 'story-studio', kind: 'character-instruction' },
        });
        order.push(characterInstructionId);
    }
    modules.push(...preparedModules);
    order.push(...sourceOrder.filter(id => preparedModules.some(module => module.id === id)));
    for (const module of preparedModules) {
        if (!order.includes(module.id)) order.push(module.id);
    }
    if (managedContextText) {
        modules.push({
            id: managedContextId,
            name: 'StoryStudio Managed Context',
            slot: 'managedContext',
            role: 'user',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 950_000,
            clipPolicy: 'middle',
            sourceRef: { source: 'story-studio', kind: 'managed-context' },
        });
        const taskIndex = taskMarker ? order.indexOf(taskMarker.id) : -1;
        if (taskIndex >= 0) order.splice(taskIndex, 0, managedContextId);
        else order.push(managedContextId);
    }
    if (continuityPreflightText) {
        modules.push({
            id: continuityPreflightId,
            name: 'StoryStudio Continuity Preflight',
            slot: 'continuityPreflight',
            role: 'system',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 1_000_001,
            clipPolicy: 'error',
            sourceRef: { source: 'story-studio', kind: 'continuity-preflight' },
        });
        const taskIndex = taskMarker ? order.indexOf(taskMarker.id) : -1;
        if (taskIndex >= 0) order.splice(taskIndex, 0, continuityPreflightId);
        else order.push(continuityPreflightId);
    }
    if (!taskMarker) {
        modules.push({
            id: taskId,
            name: 'StoryStudio Current Task',
            slot: 'task',
            role: 'user',
            template: '',
            marker: true,
            includeData: true,
            enabled: true,
            priority: 1_000_000,
            clipPolicy: 'middle',
            sourceRef: { source: 'story-studio', kind: 'task' },
        });
        order.push(taskId);
    }
    const wrapTaskOrder = taskOrder => {
        const wrapped = [runtimeId];
        if (profileSystemText) wrapped.push(profileSystemId);
        if (characterInstructionText) wrapped.push(characterInstructionId);
        wrapped.push(...taskOrder.filter(id => preparedModules.some(module => module.id === id)));
        for (const module of preparedModules) {
            if (!wrapped.includes(module.id)) wrapped.push(module.id);
        }
        if (managedContextText) {
            const taskIndex = taskMarker ? wrapped.indexOf(taskMarker.id) : -1;
            if (taskIndex >= 0) wrapped.splice(taskIndex, 0, managedContextId);
            else wrapped.push(managedContextId);
        }
        if (continuityPreflightText) {
            const taskIndex = taskMarker ? wrapped.indexOf(taskMarker.id) : -1;
            if (taskIndex >= 0) wrapped.splice(taskIndex, 0, continuityPreflightId);
            else wrapped.push(continuityPreflightId);
        }
        if (!taskMarker) wrapped.push(taskId);
        return wrapped;
    };
    const taskPolicies = profile.taskPolicies && typeof profile.taskPolicies === 'object'
        ? Object.fromEntries(Object.entries(profile.taskPolicies).map(([id, policy]) => [
            id,
            policy && typeof policy === 'object' && !Array.isArray(policy) && Array.isArray(policy.order)
                ? { ...policy, order: wrapTaskOrder(policy.order) }
                : policy,
        ]))
        : profile.taskPolicies;
    return {
        ...profile,
        profileVersion: 2,
        modules,
        order,
        taskPolicies,
        _requiredSlotValues: {
            runtime: runtimeText,
            profileSystem: profileSystemText,
            characterInstruction: characterInstructionText,
            managedContext: managedContextText,
            continuityPreflight: continuityPreflightText,
            task: taskText,
        },
        _requiredWarnings: warnings,
        _requiredTaskModuleId: taskMarker?.id ?? taskId,
        _requiredContinuityPreflightModuleId: continuityPreflightText ? continuityPreflightId : null,
    };
}

function profileCharacterBudget(profile, task, promptLimit) {
    const policy = task && profile?.taskPolicies && typeof profile.taskPolicies[task] === 'object'
        ? profile.taskPolicies[task]
        : null;
    const configuredValue = policy?.characterBudget ?? profile?.characterBudget;
    if (configuredValue === undefined || configuredValue === null) return promptLimit;
    const configured = Number(configuredValue);
    return Number.isInteger(configured) && configured >= 0 ? Math.min(promptLimit, configured) : promptLimit;
}

function managedProfileContext(profile, dataBySection) {
    const representedSlots = new Set((Array.isArray(profile?.modules) ? profile.modules : [])
        .filter(module => module && (module.marker === true || module.includeData === true))
        .map(module => module.slot));
    const sections = [
        ['worldBefore', '触发世界设定（前置）'],
        ['persona', '作者人格'],
        ['scenario', '故事与场景'],
        ['worldAfter', '触发世界设定（后置）'],
        ['examples', '写作示例'],
        ['chapter', '章节上下文'],
        ['ledger', '连续性账本'],
        ['retrieval', '可追溯检索命中'],
        ['postInstruction', '后置约束'],
    ];
    if (!representedSlots.has('character')) {
        sections.splice(2, 0,
            ['characterDescription', '角色描述'],
            ['characterPersonality', '角色性格'],
            ['characterNotes', '角色创作备注']);
    }
    return sections
        .filter(([slot]) => !representedSlots.has(slot) && String(dataBySection[slot] ?? '').trim())
        .map(([slot, title]) => `# ${title}\n${dataBySection[slot]}`)
        .join('\n\n');
}

/**
 * Builds a novel-writing prompt without requiring the SillyTavern runtime.
 * Only trusted templates are expanded. Manuscript and lore content remain data.
 *
 * @param {object} input
 * @returns {{systemPrompt: string, prompt: string, serializedPrompt: string|null, transport: 'chat'|'text', diagnostics: object}}
 */
export function assembleNovelPrompt({
    baseSystemPrompt = '',
    baseSections = {},
    project = {},
    chapter = {},
    previousChapter = null,
    resources = {},
    provider = {},
    promptLimit = DEFAULT_PROMPT_LIMIT,
} = {}) {
    const warnings = [];
    const normalizedSections = normalizeBaseSections(baseSections);
    const { character, characters } = primaryCharacter(resources);
    const persona = resources.persona ?? project.persona ?? null;
    const ledger = resources.continuityLedger ?? resources.ledger ?? project.continuity ?? [];
    const chapterPlan = resources.chapterPlan ?? chapter.card ?? {};
    const pov = firstDefined(chapter?.card?.pov, resources.pov, cardField(character, 'name'), '');
    const macroContext = {
        ...(resources.macroContext || {}),
        user: firstDefined(resources.user?.name, resources.userName, persona?.name, project.author, ''),
        char: cardField(character, 'name'),
        group: characters.map(item => cardField(item, 'name')).filter(Boolean),
        groupNotMuted: characters.filter(item => item?.muted !== true).map(item => cardField(item, 'name')).filter(Boolean),
        charIfNotGroup: characters.length > 1 ? characters.map(item => cardField(item, 'name')).filter(Boolean) : cardField(character, 'name'),
        notChar: firstDefined(resources.user?.name, resources.userName, persona?.name, project.author, ''),
        persona: formatPersona(persona),
        description: cardField(character, 'description'),
        personality: cardField(character, 'personality'),
        scenario: cardField(character, 'scenario'),
        system: firstDefined(resources.systemPrompt, ''),
        original: firstDefined(resources.originalPrompt, ''),
        charPrompt: cardField(character, 'system_prompt'),
        charInstruction: cardField(character, 'post_history_instructions'),
        charJailbreak: cardField(character, 'post_history_instructions'),
        mesExamples: formatExamples(resources, characters),
        mesExamplesRaw: formatExamples(resources, characters),
        charVersion: cardField(character, 'character_version'),
        char_version: cardField(character, 'character_version'),
        charDepthPrompt: firstDefined(character?.extensions?.depth_prompt?.prompt, character?.data?.extensions?.depth_prompt?.prompt, ''),
        creatorNotes: cardField(character, 'creator_notes'),
        model: firstDefined(provider.model, provider.modelId, ''),
        projectTitle: project.title ?? '',
        chapterNumber: chapter.number ?? '',
        chapterTitle: chapter.title ?? '',
        pov,
        targetWords: firstDefined(chapter.targetWords, project.chapterTargetWords, project.targetWords, ''),
        chapterPlan: formatNamedData(chapterPlan),
        continuityLedger: formatNamedData(ledger),
    };

    for (const name of ['persona', 'description', 'personality', 'scenario', 'mesExamples', 'mesExamplesRaw', 'charDepthPrompt', 'creatorNotes']) {
        macroContext[name] = expandTrusted(macroContext[name], macroContext, warnings, `macroContext.${name}`);
    }

    const entries = loreEntriesFrom(resources, project);
    const scanText = resources.scanText ?? [
        chapter?.content ?? '',
        formatNamedData(chapterPlan),
        previousChapter?.content ?? '',
    ];
    const limit = normalizePromptLimit(promptLimit);
    const loreCharacterBudget = firstDefined(resources.loreCharacterBudget, Math.floor(limit * 0.2));
    const lore = activateLoreEntries(entries, scanText, {
        characterBudget: loreCharacterBudget,
        scanDepth: resources.loreScanDepth,
        caseSensitive: resources.loreCaseSensitive,
        matchWholeWords: resources.loreMatchWholeWords,
        scanTextOrder: resources.scanTextOrder,
    });
    const loreBefore = lore.byPosition.before.map(entry => entry.content).join('\n');
    const loreAfter = lore.byPosition.after.map(entry => entry.content).join('\n');
    const loreAtDepth = lore.byPosition.atDepth
        .map(entry => `深度 ${entry.depth} / ${entry.role}\n${entry.content}`)
        .join('\n\n');
    Object.assign(macroContext, {
        wiBefore: loreBefore,
        loreBefore,
        wiAfter: loreAfter,
        loreAfter,
        anchorBefore: firstDefined(resources.anchorBefore, ''),
        anchorAfter: firstDefined(resources.anchorAfter, ''),
    });

    const mainConfig = baseSectionConfig(normalizedSections, 'main');
    const expandedBaseMain = expandTrusted(baseSystemPrompt, macroContext, warnings, 'main');
    const expandedMainSection = expandTrusted(mainConfig.template, macroContext, warnings, 'main');
    let main = [expandedBaseMain, expandedMainSection].filter(Boolean).join('\n').trim();
    const characterSystemPrompt = cardField(character, 'system_prompt');
    if (characterSystemPrompt && resources.preferCharacterPrompt !== false) {
        main = expandTrusted(characterSystemPrompt, { ...macroContext, original: main, system: main }, warnings, 'main.characterOverride');
    }

    const postBase = expandTrusted(
        firstDefined(resources.postInstruction, resources.post_history_instructions, ''),
        macroContext,
        warnings,
        'postInstruction',
    );
    const characterPost = cardField(character, 'post_history_instructions');
    const postInstruction = characterPost && resources.preferCharacterPostInstruction !== false
        ? expandTrusted(characterPost, { ...macroContext, original: postBase }, warnings, 'postInstruction.characterOverride')
        : String(postBase ?? '').trim();
    const taskSections = Array.isArray(resources.taskSections)
        ? resources.taskSections.map((section, index) => {
            const value = section && typeof section === 'object' && !Array.isArray(section)
                ? section
                : { text: section };
            return {
                id: String(value.id ?? index),
                text: expandTrusted(formatNamedData(value.text ?? value.content), macroContext, warnings, `task.${value.id ?? index}`),
                weight: value.weight,
                clip: value.clip,
            };
        }).filter(section => section.text)
        : null;
    const continuityPreflightSection = taskSections
        ?.find(section => section.id === 'continuityPreflight') ?? null;
    const dataBySection = {
        main,
        worldBefore: loreBefore,
        persona: expandTrusted(formatPersona(persona), macroContext, warnings, 'persona.data'),
        character: expandTrusted(formatCharacters(characters), macroContext, warnings, 'character.data'),
        characterDescription: expandTrusted(formatCharacterDescriptions(characters), macroContext, warnings, 'characterDescription.data'),
        characterPersonality: expandTrusted(formatCharacterPersonalities(characters), macroContext, warnings, 'characterPersonality.data'),
        characterNotes: expandTrusted(formatCharacterNotes(characters), macroContext, warnings, 'characterNotes.data'),
        scenario: formatScenario(project, macroContext.scenario),
        worldAfter: [loreAfter, loreAtDepth].filter(Boolean).join('\n\n'),
        examples: expandTrusted(formatExamples(resources, characters), macroContext, warnings, 'examples.data'),
        chapter: formatChapter(project, chapter, previousChapter),
        ledger: formatNamedData(ledger),
        retrieval: formatNamedData(resources.retrievalContext ?? resources.retrieval ?? ''),
        task: taskSections
            ? taskSections.map(section => section.text).join('\n\n')
            : expandTrusted(formatNamedData(resources.task), macroContext, warnings, 'task.data'),
        postInstruction,
    };

    const profile = resources.promptProfile;
    if (profile?.profileVersion === 2) {
        const transportValue = String(provider.transportMode ?? provider.transport ?? provider.mode ?? 'chat').toLocaleLowerCase();
        const transport = ['text', 'completion', 'text-completion'].includes(transportValue) ? 'text' : 'chat';
        const profileSystemText = profile?.systemPrompt?.enabled === false
            ? ''
            : expandTrusted(profile?.systemPrompt?.content ?? '', macroContext, warnings, 'profile.systemPrompt');
        const characterInstructionText = characterSystemPrompt && resources.preferCharacterPrompt !== false
            ? expandTrusted(
                characterSystemPrompt,
                { ...macroContext, original: profileSystemText, system: profileSystemText },
                warnings,
                'characterInstruction',
            )
            : '';
        const requestedTask = String(resources.promptTask ?? resources.taskKind ?? '').trim();
        const selectedTask = resources.promptTask !== undefined
            ? requestedTask || null
            : (requestedTask && profile.taskPolicies && Object.hasOwn(profile.taskPolicies, requestedTask) ? requestedTask : null);
        const profileTaskText = taskSections
            ? taskSections
                .filter(section => !['continuityPreflight', 'retrieval'].includes(section.id))
                .map(section => section.text)
                .join('\n\n')
            : dataBySection.task;
        const continuityPreflightText = continuityPreflightSection?.text ?? '';
        const preparedProfile = requiredProfile(profile, expandedBaseMain, profileTaskText, {
            profileSystemText,
            characterInstructionText,
            managedContextText: managedProfileContext(profile, dataBySection),
            continuityPreflightText,
        });
        const slotValues = {
            ...dataBySection,
            canon: resources.canon ?? project?.story ?? '',
            retrieval: resources.retrievalContext ?? resources.retrieval ?? '',
            manuscript: resources.manuscript ?? chapter?.content ?? '',
            ...(resources.promptSlotValues && typeof resources.promptSlotValues === 'object'
                ? resources.promptSlotValues
                : {}),
            ...preparedProfile._requiredSlotValues,
        };
        const compiled = compilePromptProfile(preparedProfile, {
            ...(selectedTask ? { task: selectedTask } : {}),
            variables: resources.promptVariables,
            generation: resources.generationOverrides,
            characterBudget: profileCharacterBudget(profile, selectedTask, limit),
            context: {
                ...macroContext,
                taskKind: resources.taskKind ?? null,
                project: {
                    id: project?.id ?? null,
                    title: project?.title ?? '',
                    genre: project?.genre ?? '',
                },
                chapter: {
                    id: chapter?.id ?? null,
                    number: chapter?.number ?? null,
                    title: chapter?.title ?? '',
                    status: chapter?.status ?? '',
                    pov,
                },
                provider: {
                    protocol: provider?.protocol ?? '',
                    model: provider?.model ?? provider?.modelId ?? '',
                    transport,
                },
            },
            slotValues,
        });
        for (const field of Object.keys(compiled.generation)) {
            if (!PROFILE_GENERATION_PARAMETERS.has(field)) {
                compiled.errors.push(warning(
                    'unsupported_generation_parameter',
                    `Prompt Profile generation parameter is not supported: ${field}.`,
                    { field },
                ));
            }
        }
        const requiredTaskDiagnostic = compiled.diagnostics.modules
            .find(module => module.id === preparedProfile._requiredTaskModuleId);
        if (!requiredTaskDiagnostic?.included) {
            compiled.errors.push(warning(
                'required_task_missing',
                'StoryStudio could not retain the current task inside the Profile budget.',
                { moduleId: preparedProfile._requiredTaskModuleId },
            ));
        }
        const requiredPreflightId = preparedProfile._requiredContinuityPreflightModuleId;
        if (requiredPreflightId) {
            const requiredPreflightDiagnostic = compiled.diagnostics.modules
                .find(module => module.id === requiredPreflightId);
            const requiredPreflightModule = compiled.modules
                .find(module => module.id === requiredPreflightId);
            if (!requiredPreflightDiagnostic?.included
                || requiredPreflightDiagnostic.truncated
                || requiredPreflightModule?.content !== continuityPreflightText) {
                compiled.errors.push(warning(
                    'required_continuity_preflight_missing',
                    'StoryStudio could not retain the complete continuity preflight inside the Profile budget.',
                    { moduleId: requiredPreflightId },
                ));
            }
        }
        const profileWarnings = [...preparedProfile._requiredWarnings, ...compiled.warnings];
        const messages = compiled.messages;
        let leadingSystemCount = 0;
        while (messages[leadingSystemCount]?.role === 'system') leadingSystemCount += 1;
        const fittedMain = messages.slice(0, leadingSystemCount).map(message => message.content).join('\n\n');
        const promptMessages = messages.slice(leadingSystemCount);
        const prompt = promptMessages.map(message => message.content).join('\n\n');
        const instruct = provider.instructPreset ?? provider.instruct;
        let serializedPrompt = null;
        if (transport === 'text') {
            serializedPrompt = serializeOrderedMessages(messages, instruct, macroContext, warnings);
            if (serializedPrompt.length > limit) {
                warnings.push(warning(
                    'serialized_prompt_over_limit',
                    'Text transport sequences caused the serialized prompt to exceed the character limit.',
                    { characters: serializedPrompt.length, promptLimit: limit },
                ));
            }
        } else if (instruct && (instruct.enabled !== false || Object.keys(instruct).length > 1)) {
            warnings.push(warning(
                'instruct_ignored_for_chat',
                'Instruct sequences apply only to text transport and were not added to chat prompts.',
            ));
        }
        const moduleById = new Map(compiled.modules.map(module => [module.id, module]));
        const blocks = Object.fromEntries(compiled.diagnostics.modules.map(module => {
            const compiledModule = moduleById.get(module.id);
            return [module.id, {
                characters: module.compiledCharacters,
                originalCharacters: module.originalCharacters,
                included: module.included,
                truncated: module.truncated,
                reason: module.reason,
                role: compiledModule?.role ?? null,
                slot: compiledModule?.slot ?? null,
                tokens: compiledModule?.tokens ?? 0,
            }];
        }));
        const diagnostics = {
            sectionOrder: compiled.modules.map(module => module.id),
            activatedLore: lore.activated.map(entry => ({
                id: entry.id,
                position: entry.position,
                depth: entry.depth,
                role: entry.role,
                order: entry.order,
                matchedPrimaryKeys: [...entry.matchedPrimaryKeys],
                matchedSecondaryKeys: [...entry.matchedSecondaryKeys],
            })),
            skippedLore: lore.skipped.map(item => ({ id: item.id, reason: item.reason })),
            loreBudget: { characters: lore.usedCharacters, limit: lore.characterBudget },
            blocks,
            blockCharacters: Object.fromEntries(Object.entries(blocks).map(([id, block]) => [id, block.characters])),
            promptLimit: limit,
            totalCharacters: messages.reduce((sum, message) => sum + message.content.length, 0),
            profile: {
                profileVersion: 2,
                profileHash: compiled.profileHash,
                taskPolicy: compiled.task,
                variables: compiled.variables,
                generation: compiled.generation,
                budgets: compiled.diagnostics.budgets,
                modules: compiled.diagnostics.modules,
                warnings: profileWarnings,
                errors: compiled.errors,
                compatibility: profile.compatibility ?? null,
            },
            warnings: uniqueWarnings([...warnings, ...profileWarnings]),
        };
        return {
            systemPrompt: fittedMain,
            prompt,
            messages,
            serializedPrompt,
            transport,
            generation: compiled.generation,
            profileHash: compiled.profileHash,
            diagnostics,
        };
    }

    const blocks = SECTION_ORDER.map(id => {
        if (id === 'main') return { id, text: main };
        const config = baseSectionConfig(normalizedSections, id);
        const template = expandTrusted(config.template, macroContext, warnings, id);
        if (id === 'task' && taskSections && config.includeData) {
            const structuredSections = [
                ...(template ? [{ id: 'template', text: template, weight: 4, clip: 'middle' }] : []),
                ...taskSections,
            ];
            return {
                id,
                text: structuredSections.map(section => section.text).join('\n\n'),
                taskSections: structuredSections,
            };
        }
        return { id, text: joinSection(template, dataBySection[id], config.includeData) };
    });
    const fitted = fitBlocks(blocks, limit);
    const fittedMain = fitted.find(block => block.id === 'main')?.fittedText ?? '';
    const fittedPromptBlocks = fitted.filter(block => block.id !== 'main' && block.fittedText);
    const prompt = fittedPromptBlocks.map(block => block.fittedText).join('\n\n');
    const transportValue = String(provider.transportMode ?? provider.transport ?? provider.mode ?? 'chat').toLocaleLowerCase();
    const transport = ['text', 'completion', 'text-completion'].includes(transportValue) ? 'text' : 'chat';
    const instruct = provider.instructPreset ?? provider.instruct;
    let serializedPrompt = null;

    if (transport === 'text') {
        serializedPrompt = serializeTextPrompt(fittedMain, prompt, instruct, macroContext, warnings);
        if (serializedPrompt.length > limit) {
            warnings.push(warning(
                'serialized_prompt_over_limit',
                'Text transport sequences caused the serialized prompt to exceed the character limit.',
                { characters: serializedPrompt.length, promptLimit: limit },
            ));
        }
    } else if (instruct && (instruct.enabled !== false || Object.keys(instruct).length > 1)) {
        warnings.push(warning(
            'instruct_ignored_for_chat',
            'Instruct sequences apply only to text transport and were not added to chat prompts.',
        ));
    }

    for (const block of fitted.filter(item => item.truncated)) {
        warnings.push(warning(
            'section_truncated',
            `Section was truncated to fit the prompt limit: ${block.id}`,
            { section: block.id, originalCharacters: block.text.length, characters: block.fittedText.length },
        ));
    }

    const blockCharacters = Object.fromEntries(fitted.map(block => [block.id, block.fittedText.length]));
    const blockDiagnostics = Object.fromEntries(fitted.map(block => [block.id, {
        characters: block.fittedText.length,
        originalCharacters: block.text.length,
        included: block.fittedText.length > 0,
        truncated: block.truncated,
    }]));
    const diagnostics = {
        sectionOrder: [...SECTION_ORDER],
        activatedLore: lore.activated.map(entry => ({
            id: entry.id,
            position: entry.position,
            depth: entry.depth,
            role: entry.role,
            order: entry.order,
            matchedPrimaryKeys: [...entry.matchedPrimaryKeys],
            matchedSecondaryKeys: [...entry.matchedSecondaryKeys],
        })),
        skippedLore: lore.skipped.map(item => ({ id: item.id, reason: item.reason })),
        loreBudget: { characters: lore.usedCharacters, limit: lore.characterBudget },
        blocks: blockDiagnostics,
        blockCharacters,
        promptLimit: limit,
        totalCharacters: fittedMain.length + prompt.length,
        warnings: uniqueWarnings(warnings),
    };

    return {
        systemPrompt: fittedMain,
        prompt,
        serializedPrompt,
        transport,
        diagnostics,
    };
}
