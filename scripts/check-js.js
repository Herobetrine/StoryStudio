import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [path.join(projectRoot, 'server.js')];

function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(target);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
}

for (const name of ['src', 'public', 'scripts']) collect(path.join(projectRoot, name));
files.sort((left, right) => left.localeCompare(right));

for (const filePath of files) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
