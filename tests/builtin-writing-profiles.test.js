import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compilePromptProfile } from '../public/prompt-profile-compiler.js';
import {
    BUILTIN_WRITING_PROFILE_REVISION,
    BUILTIN_WRITING_PROFILES,
    GENRE_OVERLAYS,
    copyBuiltinWritingProfile,
    getBuiltinWritingProfile,
    listBuiltinWritingProfiles,
} from '../src/builtin-writing-profiles.js';

const EXPECTED_TASKS = [
    'brainstorm', 'plan', 'draft', 'draft', 'review', 'rewrite', 'continuity', 'copilot',
];

describe('built-in webnovel Prompt Profile V2 catalog', () => {
    test('ships eight immutable task profiles without author-name shortcuts', () => {
        assert.equal(BUILTIN_WRITING_PROFILES.length, 8);
        assert.deepEqual(BUILTIN_WRITING_PROFILES.map(profile => profile.compatibility.task), EXPECTED_TASKS);
        assert.equal(new Set(BUILTIN_WRITING_PROFILES.map(profile => profile.id)).size, 8);
        assert.equal(Object.isFrozen(BUILTIN_WRITING_PROFILES), true);
        for (const profile of BUILTIN_WRITING_PROFILES) {
            assert.equal(profile.profileVersion, 2);
            assert.equal(profile.compatibility.immutable, true);
            assert.equal(profile.compatibility.builtinRevision, BUILTIN_WRITING_PROFILE_REVISION);
            assert.equal(Object.isFrozen(profile), true);
            assert.equal(Object.isFrozen(profile.modules), true);
            assert.doesNotMatch(
                JSON.stringify(profile),
                /辰东|唐家三少|番茄作者|起点大神|模仿.{0,8}(?:作者|作家)/u,
            );
        }
    });

    test('compiles every profile with every genre overlay and exactly one overlay module', () => {
        for (const profile of BUILTIN_WRITING_PROFILES) {
            const task = profile.compatibility.task;
            for (const overlay of GENRE_OVERLAYS) {
                const result = compilePromptProfile(profile, {
                    task,
                    variables: { genreOverlay: overlay.id },
                });
                assert.deepEqual(result.errors, [], `${profile.id}/${overlay.id}: ${JSON.stringify(result.errors)}`);
                assert.match(result.profileHash, /^[0-9a-f]{64}$/u);
                assert.equal(result.modules[0].id, `contract-${task}`);
                assert.deepEqual(
                    result.modules.filter(module => module.id.startsWith('genre-')).map(module => module.id),
                    [`genre-${overlay.id}`],
                );
                assert.match(result.messages.map(message => message.content).join('\n'), new RegExp(overlay.guidance));
            }
        }
    });

    test('keeps the neutral mode free of genre modules', () => {
        for (const profile of BUILTIN_WRITING_PROFILES) {
            const result = compilePromptProfile(profile, {
                task: profile.compatibility.task,
                variables: { genreOverlay: 'none' },
            });
            assert.deepEqual(result.errors, []);
            assert.equal(result.modules.filter(module => module.id.startsWith('genre-')).length, 0);
            assert.equal(result.modules.length, 1);
        }
    });

    test('returns detached catalog values while retaining immutable authoritative definitions', () => {
        const listed = listBuiltinWritingProfiles();
        listed[0].name = '被客户端修改';
        listed[0].modules[0].template = '覆盖合同';
        assert.notEqual(BUILTIN_WRITING_PROFILES[0].name, listed[0].name);
        assert.notEqual(BUILTIN_WRITING_PROFILES[0].modules[0].template, listed[0].modules[0].template);

        const fetched = getBuiltinWritingProfile(BUILTIN_WRITING_PROFILES[0].id);
        assert.deepEqual(fetched, BUILTIN_WRITING_PROFILES[0]);
        assert.notEqual(fetched, BUILTIN_WRITING_PROFILES[0]);
    });

    test('creates an editable copy with explicit provenance and selected overlay', () => {
        const source = BUILTIN_WRITING_PROFILES[2];
        const copy = copyBuiltinWritingProfile(source.id, {
            name: '我的正文配方',
            genreOverlay: 'suspense-mystery',
        });
        assert.equal(Object.hasOwn(copy, 'id'), false);
        assert.equal(copy.name, '我的正文配方');
        assert.equal(copy.variableValues.genreOverlay, 'suspense-mystery');
        assert.equal(copy.compatibility.immutable, false);
        assert.equal(copy.compatibility.copiedFrom, source.id);
        assert.equal(copy.source.sourceProfileId, source.id);
        const compiled = compilePromptProfile({ ...copy, id: 'copied-profile' }, { task: 'draft' });
        assert.deepEqual(compiled.errors, []);
        assert.deepEqual(source.variableValues, {});
    });

    test('rejects unknown profiles and overlays without returning a partial copy', () => {
        assert.throws(
            () => getBuiltinWritingProfile('builtin.unknown'),
            error => error.code === 'builtin_profile_not_found',
        );
        assert.throws(
            () => copyBuiltinWritingProfile(BUILTIN_WRITING_PROFILES[0].id, { genreOverlay: 'fan-fiction' }),
            error => error.code === 'invalid_genre_overlay',
        );
        assert.throws(
            () => copyBuiltinWritingProfile(BUILTIN_WRITING_PROFILES[0].id, { name: 'x'.repeat(161) }),
            error => error.code === 'invalid_builtin_profile_copy',
        );
    });
});
