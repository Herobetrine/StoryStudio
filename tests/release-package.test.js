import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
const startScript = fs.readFileSync(path.join(projectRoot, 'start-story-studio.ps1'), 'utf8');
const publicSourceManifest = fs.readFileSync(
    path.join(projectRoot, '.public-source-manifest.txt'),
    'utf8',
)
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean);

function removeTemporaryTree(directory) {
    const retries = process.platform === 'win32' ? 30 : 0;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            if (attempt >= retries || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
            Atomics.wait(sleeper, 0, 0, 50);
        }
    }
}

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
        removeTemporaryTree(cacheRoot);
    }
}

function writeLauncherFixture(fixtureRoot, { withLock }) {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.copyFileSync(
        path.join(projectRoot, 'start-story-studio.ps1'),
        path.join(fixtureRoot, 'start-story-studio.ps1'),
    );
    fs.writeFileSync(
        path.join(fixtureRoot, 'package.json'),
        `${JSON.stringify({
            name: 'story-studio-launcher-fixture',
            version: '1.0.0',
            dependencies: { fixture: '1.0.0' },
        }, null, 2)}\n`,
    );
    if (withLock) {
        fs.writeFileSync(
            path.join(fixtureRoot, 'package-lock.json'),
            `${JSON.stringify({
                name: 'story-studio-launcher-fixture',
                version: '1.0.0',
                lockfileVersion: 3,
                packages: {
                    '': {
                        name: 'story-studio-launcher-fixture',
                        version: '1.0.0',
                    },
                },
            }, null, 2)}\n`,
        );
    }
    fs.writeFileSync(
        path.join(fixtureRoot, 'npm.cmd'),
        [
            '@echo off',
            'echo %*>>"%STORY_STUDIO_NPM_LOG%"',
            'if "%1"=="ci" if exist ".fail-install" exit /b 42',
            'if "%1"=="install" if exist ".fail-install" exit /b 42',
            'if "%1"=="ls" if exist ".fail-ls" exit /b 43',
            'if "%1"=="ci" (',
            '  if not exist "node_modules" mkdir "node_modules"',
            '  exit /b 0',
            ')',
            'if "%1"=="install" (',
            '  if not exist "node_modules" mkdir "node_modules"',
            '  exit /b 0',
            ')',
            'if "%1"=="ls" exit /b 0',
            'if "%1"=="start" exit /b 0',
            'exit /b 91',
            '',
        ].join('\r\n'),
    );
}

function invokeLauncherFixture(fixtureRoot) {
    const logPath = path.join(fixtureRoot, 'npm-calls.log');
    fs.writeFileSync(logPath, '');
    const powershell = path.join(
        process.env.SystemRoot || String.raw`C:\Windows`,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
    );
    const result = spawnSync(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(fixtureRoot, 'start-story-studio.ps1'),
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: {
            ...process.env,
            PATH: [
                fixtureRoot,
                path.dirname(process.execPath),
                process.env.PATH || '',
            ].join(path.delimiter),
            STORY_STUDIO_NPM_LOG: logPath,
        },
    });
    const calls = fs.readFileSync(logPath, 'utf8')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
    return { calls, result };
}

function runLauncherFixture(fixtureRoot) {
    const outcome = invokeLauncherFixture(fixtureRoot);
    assert.equal(
        outcome.result.status,
        0,
        outcome.result.error?.message || outcome.result.stderr || outcome.result.stdout,
    );
    return outcome.calls;
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
            'playwright-report/',
            'test-results/',
            'blob-report/',
            '.playwright/',
            'ms-playwright/',
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
            'playwright.config.js',
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
        assert.doesNotMatch(startScript, /Get-FileHash/);
        assert.match(startScript, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
        assert.match(startScript, /\[System\.BitConverter\]::ToString/);
        assert.match(startScript, /\.story-studio-dependencies\.sha256/);
        assert.match(startScript, /npm\.cmd ls --omit=dev --all/);
        assert.match(startScript, /npm\.cmd ci --omit=dev/);
        assert.match(startScript, /npm\.cmd install --omit=dev --no-audit --no-fund --package-lock=false/);
    });

    test('reinstalls launcher dependencies when the effective lockfile changes', {
        skip: process.platform !== 'win32',
    }, () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-launcher-lock-'));
        try {
            writeLauncherFixture(tempRoot, { withLock: true });
            fs.mkdirSync(path.join(tempRoot, 'node_modules'));

            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ci --omit=dev',
                'start',
            ]);
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ls --omit=dev --all',
                'start',
            ]);

            fs.appendFileSync(
                path.join(tempRoot, 'package-lock.json'),
                '\n',
            );
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ci --omit=dev',
                'start',
            ]);
        } finally {
            removeTemporaryTree(tempRoot);
        }
    });

    test('uses npm shrinkwrap ahead of package-lock when both are present', {
        skip: process.platform !== 'win32',
    }, () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-launcher-shrinkwrap-'));
        try {
            writeLauncherFixture(tempRoot, { withLock: true });
            fs.copyFileSync(
                path.join(tempRoot, 'package-lock.json'),
                path.join(tempRoot, 'npm-shrinkwrap.json'),
            );

            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ci --omit=dev',
                'start',
            ]);

            fs.appendFileSync(path.join(tempRoot, 'package-lock.json'), '\n');
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ls --omit=dev --all',
                'start',
            ]);

            fs.appendFileSync(path.join(tempRoot, 'npm-shrinkwrap.json'), '\n');
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ci --omit=dev',
                'start',
            ]);
        } finally {
            removeTemporaryTree(tempRoot);
        }
    });

    test('uses npm install when the launcher has no publishable lockfile', {
        skip: process.platform !== 'win32',
    }, () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-launcher-unlocked-'));
        try {
            writeLauncherFixture(tempRoot, { withLock: false });
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'install --omit=dev --no-audit --no-fund --package-lock=false',
                'start',
            ]);
            assert.equal(fs.existsSync(path.join(tempRoot, 'package-lock.json')), false);
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ls --omit=dev --all',
                'start',
            ]);

            fs.appendFileSync(path.join(tempRoot, 'package.json'), '\n');
            assert.deepEqual(runLauncherFixture(tempRoot), [
                'install --omit=dev --no-audit --no-fund --package-lock=false',
                'start',
            ]);
            assert.equal(fs.existsSync(path.join(tempRoot, 'package-lock.json')), false);
        } finally {
            removeTemporaryTree(tempRoot);
        }
    });

    test('reinstalls when npm reports an incomplete production dependency tree', {
        skip: process.platform !== 'win32',
    }, () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-launcher-ls-'));
        try {
            writeLauncherFixture(tempRoot, { withLock: true });
            runLauncherFixture(tempRoot);
            fs.writeFileSync(path.join(tempRoot, '.fail-ls'), '');

            assert.deepEqual(runLauncherFixture(tempRoot), [
                'ls --omit=dev --all',
                'ci --omit=dev',
                'start',
            ]);
        } finally {
            removeTemporaryTree(tempRoot);
        }
    });

    test('does not publish a dependency fingerprint after a failed install', {
        skip: process.platform !== 'win32',
    }, () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-launcher-failure-'));
        try {
            writeLauncherFixture(tempRoot, { withLock: true });
            fs.writeFileSync(path.join(tempRoot, '.fail-install'), '');

            const outcome = invokeLauncherFixture(tempRoot);
            assert.notEqual(outcome.result.status, 0);
            assert.deepEqual(outcome.calls, ['ci --omit=dev']);
            assert.match(
                `${outcome.result.stderr}\n${outcome.result.stdout}`,
                /npm ci --omit=dev failed with exit code 42/u,
            );
            assert.equal(
                fs.existsSync(path.join(
                    tempRoot,
                    'node_modules',
                    '.story-studio-dependencies.sha256',
                )),
                false,
            );
        } finally {
            removeTemporaryTree(tempRoot);
        }
    });

    test('documents separate dependency commands for source checkouts and npm tarballs', () => {
        assert.match(readme, /源码仓库[\s\S]*?npm ci/u);
        assert.match(readme, /npm (?:打包产物|tarball)[\s\S]*?npm install --omit=dev --no-audit --no-fund/u);
    });

    test('declares GitHub source distribution while retaining registry publication protection', () => {
        assert.equal(packageJson.private, true);
        assert.equal(packageJson.repository?.url, 'git+https://github.com/Herobetrine/StoryStudio.git');
        assert.equal(packageJson.homepage, 'https://github.com/Herobetrine/StoryStudio#readme');
        assert.equal(packageJson.bugs?.url, 'https://github.com/Herobetrine/StoryStudio/issues');
    });
});
