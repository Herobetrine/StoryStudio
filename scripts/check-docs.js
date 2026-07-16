import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

function npmPackManifest() {
    const bundledNpm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmExecPath = process.env.npm_execpath || (fs.existsSync(bundledNpm) ? bundledNpm : '');
    const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
    const command = npmExecPath
        ? process.execPath
        : process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = npmExecPath
        ? [npmExecPath, ...packArgs]
        : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...packArgs] : packArgs;
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`npm pack manifest failed:\n${result.error?.message || result.stderr || result.stdout}`);
    }
    const manifest = JSON.parse(result.stdout);
    if (!Array.isArray(manifest) || !Array.isArray(manifest[0]?.files)) {
        throw new Error('npm pack returned an unexpected manifest.');
    }
    return manifest[0].files.map(entry => entry.path.replaceAll('\\', '/'));
}

function markdownTargets(text) {
    const targets = [];
    const pattern = /!?\[[^\]]*\]\(([^)\n]+)\)/gu;
    for (const match of text.matchAll(pattern)) {
        const raw = match[1].trim();
        const target = raw.startsWith('<')
            ? raw.slice(1, raw.indexOf('>'))
            : raw.replace(/\s+["'][^"']*["']$/u, '');
        targets.push(target);
    }
    return targets;
}

function isExternalTarget(target) {
    return /^(?:https?:|mailto:|tel:|data:|#)/iu.test(target);
}

function normalizedRelativePath(documentPath, target) {
    const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) return null;
    const decoded = decodeURIComponent(withoutFragment);
    const absolute = path.resolve(projectRoot, path.dirname(documentPath), decoded);
    const relative = path.relative(projectRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${documentPath}: relative link leaves the repository: ${target}`);
    }
    return relative.replaceAll('\\', '/');
}

const packedPaths = npmPackManifest();
const packedPathSet = new Set(packedPaths);
const packedMarkdown = packedPaths.filter(file => file.toLowerCase().endsWith('.md'));
const errors = [];
let checkedLinks = 0;

for (const documentPath of packedMarkdown) {
    const absoluteDocumentPath = path.join(projectRoot, documentPath);
    const text = fs.readFileSync(absoluteDocumentPath, 'utf8');
    const drivePath = text.match(/(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)/u);
    const userPath = text.match(/\\\\(?:\?\\)?(?:Users|home)\\/iu);
    if (drivePath || userPath) {
        errors.push(`${documentPath}: contains a machine-local absolute path.`);
    }

    for (const target of markdownTargets(text)) {
        if (isExternalTarget(target)) continue;
        checkedLinks += 1;
        let relativeTarget;
        try {
            relativeTarget = normalizedRelativePath(documentPath, target);
        } catch (error) {
            errors.push(error.message);
            continue;
        }
        if (!relativeTarget) continue;
        const absoluteTarget = path.join(projectRoot, relativeTarget);
        if (!fs.existsSync(absoluteTarget)) {
            errors.push(`${documentPath}: missing relative link target: ${target}`);
            continue;
        }
        const targetStat = fs.statSync(absoluteTarget);
        const packed = targetStat.isDirectory()
            ? packedPaths.some(file => file.startsWith(`${relativeTarget.replace(/\/$/u, '')}/`))
            : packedPathSet.has(relativeTarget);
        if (!packed) {
            errors.push(`${documentPath}: link target is absent from the npm package: ${target}`);
        }
    }
}

if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
} else {
    console.log(
        `Checked ${packedMarkdown.length} published Markdown files and ${checkedLinks} relative links `
        + `from ${packageJson.name}@${packageJson.version}.`,
    );
}
