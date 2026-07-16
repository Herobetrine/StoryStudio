import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const startScript = fs.readFileSync(path.join(projectRoot, 'start-story-studio.ps1'), 'utf8');
const publicSourceManifest = fs.readFileSync(
    path.join(projectRoot, '.public-source-manifest.txt'),
    'utf8',
)
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean);

function runGit(args) {
    const result = spawnSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
}

function trackedFiles() {
    return runGit(['ls-files', '-z'])
        .split('\0')
        .filter(Boolean)
        .map(file => file.replaceAll('\\', '/'));
}

function packFiles() {
    const bundledNpm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmExecPath = process.env.npm_execpath || (fs.existsSync(bundledNpm) ? bundledNpm : '');
    const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
    const command = npmExecPath
        ? process.execPath
        : process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = npmExecPath
        ? [npmExecPath, ...packArgs]
        : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...packArgs] : packArgs;
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-npm-cache-'));
    try {
        const result = spawnSync(command, args, {
            cwd: projectRoot,
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, npm_config_cache: cacheRoot },
        });
        assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
        const manifest = JSON.parse(result.stdout);
        assert.ok(Array.isArray(manifest) && Array.isArray(manifest[0]?.files));
        return manifest[0].files.map(entry => entry.path.replaceAll('\\', '/'));
    } finally {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
}

describe('release package contract', () => {
    test('matches the reviewed public-source manifest exactly', () => {
        assert.equal(
            new Set(publicSourceManifest).size,
            publicSourceManifest.length,
            'public-source manifest must not contain duplicate paths',
        );
        assert.deepEqual(
            trackedFiles(),
            publicSourceManifest,
            'Git index changed without an explicit public-source manifest review',
        );
    });

    test('ships only the public runtime and stable documentation surface', () => {
        const files = packFiles();
        for (const required of [
            'server.js',
            'start-story-studio.ps1',
            'public/app.js',
            'src/story-studio-store.js',
            'scripts/check-docs.js',
            'README.md',
            'ARCHITECTURE.md',
            'ROADMAP.md',
            'SECURITY.md',
            'CONTRIBUTING.md',
        ]) assert.ok(files.includes(required), `missing package file: ${required}`);

        for (const forbiddenPrefix of [
            '.research/',
            '.private/',
            '.audit/',
            '.acceptance/',
            '.evidence/',
            'internal/',
            'research/',
            'research-notes/',
            'reverse/',
            'reverse-engineering/',
            'reverse-notes/',
            'reversing/',
            'audit/',
            'audits/',
            'checkpoint/',
            'checkpoints/',
            'acceptance/',
            'acceptance-evidence/',
            'acceptance-logs/',
            'evidence/',
            'evidence-logs/',
            'data/',
            'logs/',
            'tests/',
            'node_modules/',
        ]) {
            assert.equal(
                files.some(file => file.toLowerCase().startsWith(forbiddenPrefix)),
                false,
                `package leaked ${forbiddenPrefix}`,
            );
        }
        assert.equal(
            files.some(file => /(?:secret|credential|acceptance-log)/iu.test(file)),
            false,
            'package leaked a sensitive or machine-local artifact',
        );
        for (const forbiddenFile of [
            'REFERENCE_ANALYSIS.md',
            'ECOSYSTEM_RESEARCH.md',
            'UPGRADE_CHECKPOINT.md',
        ]) {
            assert.equal(files.includes(forbiddenFile), false, `package leaked ${forbiddenFile}`);
        }

        for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
            const directNodeEntry = String(command).match(
                /^\s*node(?:\.exe)?\s+([^\s"';&|]+\.js)(?:\s|$)/u,
            )?.[1];
            if (!directNodeEntry) continue;
            const packagePath = directNodeEntry.replace(/^\.\//u, '').replaceAll('\\', '/');
            assert.ok(
                files.includes(packagePath),
                `npm script "${scriptName}" references an entry point missing from the package: ${packagePath}`,
            );
        }
    });

    test('keeps local research and internal acceptance material outside the Git index', () => {
        const files = trackedFiles();
        const forbiddenPrefixes = [
            '.research/',
            '.private/',
            '.audit/',
            '.acceptance/',
            '.evidence/',
            'internal/',
            'research/',
            'research-notes/',
            'reverse/',
            'reverse-engineering/',
            'reverse-notes/',
            'reversing/',
            'audit/',
            'audits/',
            'checkpoint/',
            'checkpoints/',
            'acceptance/',
            'acceptance-evidence/',
            'acceptance-logs/',
            'evidence/',
            'evidence-logs/',
        ];
        const forbiddenExact = new Set([
            'reference_analysis.md',
            'ecosystem_research.md',
            'upgrade_checkpoint.md',
        ]);
        for (const file of files) {
            const normalizedFile = file.toLowerCase();
            assert.equal(
                forbiddenPrefixes.some(prefix => normalizedFile.startsWith(prefix)),
                false,
                `Git index leaked local-only path: ${file}`,
            );
            assert.equal(
                forbiddenExact.has(normalizedFile),
                false,
                `Git index leaked local-only file: ${file}`,
            );
            assert.equal(
                /(?:^|\/)[^/]*(?:audit|checkpoint|acceptance|evidence|release[_-]smoke)[^/]*\.(?:md|json|txt)$/iu.test(file),
                false,
                `Git index leaked an internal report or evidence file: ${file}`,
            );
        }
        for (const file of files.filter(file => file.toLowerCase().endsWith('.md'))) {
            const content = fs.readFileSync(path.join(projectRoot, file), 'utf8');
            assert.doesNotMatch(
                content,
                /(?:^|[\s"'(<])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\/\/|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/mu,
                `public Markdown leaked a developer-machine absolute path: ${file}`,
            );
        }

        for (const probe of [
            '.research/report.md',
            '.Research/report.md',
            '.RESEARCH/report.md',
            '.research/reverse/raw.js',
            '.private/notes.md',
            '.PRIVATE/notes.md',
            'internal/acceptance.md',
            'INTERNAL/acceptance.md',
            'research/tool-comparison.md',
            'Research/tool-comparison.md',
            'RESEARCH/tool-comparison.md',
            'research-notes/session.md',
            'reverse/notes.md',
            'Reverse/notes.md',
            'reverse-engineering/report.md',
            'REVERSE-ENGINEERING/report.md',
            'reverse-notes/report.md',
            'reversing/report.md',
            'audit/report.md',
            'audits/report.md',
            '.audit/report.md',
            'checkpoint/session.json',
            'checkpoints/session.json',
            'acceptance/report.md',
            'acceptance-evidence/run.json',
            'acceptance-logs/run.json',
            '.acceptance/run.json',
            'evidence/session.json',
            'evidence-logs/session.json',
            '.evidence/session.json',
            'REFERENCE_ANALYSIS.md',
            'Reference_Analysis.md',
            'ECOSYSTEM_RESEARCH.md',
            'Ecosystem_Research.md',
            'AUDIT_2099-01-01.md',
            'LOCAL_AUDIT.md',
            'UPGRADE_GAP_AUDIT_2099-01-01.md',
            'UPGRADE_CHECKPOINT.md',
            'P1_CHECKPOINT_2099.md',
            'FINAL_ACCEPTANCE_2099.md',
            'RELEASE_SMOKE_2099.md',
            'EVIDENCE.md',
            'RESEARCH_NOTES.md',
            'REVERSE_REPORT.md',
            'PRIVATE_NOTES.md',
            'INTERNAL_NOTES.md',
        ]) {
            runGit(['check-ignore', '--no-index', '--quiet', '--', probe]);
        }
    });

    test('keeps the PowerShell launcher usable with and without a publishable lockfile', () => {
        assert.match(startScript, /package-lock\.json/);
        assert.match(startScript, /npm-shrinkwrap\.json/);
        assert.match(startScript, /npm\.cmd ci --omit=dev/);
        assert.match(startScript, /npm\.cmd install --omit=dev --no-audit --no-fund/);
    });

    test('declares GitHub source distribution while retaining registry publication protection', () => {
        assert.equal(packageJson.private, true);
        assert.equal(packageJson.repository?.url, 'git+https://github.com/Herobetrine/StoryStudio.git');
        assert.equal(packageJson.homepage, 'https://github.com/Herobetrine/StoryStudio#readme');
        assert.equal(packageJson.bugs?.url, 'https://github.com/Herobetrine/StoryStudio/issues');
    });
});
