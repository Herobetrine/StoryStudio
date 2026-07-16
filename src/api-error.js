import fs from 'node:fs';
import path from 'node:path';

export class ApiError extends Error {
    constructor(status, code, message, details = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function lstatIfPresent(filePath) {
    try {
        return fs.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function isContained(rootDirectory, targetPath) {
    const relative = path.relative(rootDirectory, targetPath);
    return relative === ''
        || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function comparableRealPath(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertNoLinkedAncestors(targetPath, fail, label) {
    const resolvedTarget = path.resolve(targetPath);
    const parsed = path.parse(resolvedTarget);
    const relative = path.relative(parsed.root, resolvedTarget);
    const segments = relative ? relative.split(path.sep) : [];
    let current = parsed.root;
    const components = [current];
    for (const segment of segments) {
        current = path.join(current, segment);
        components.push(current);
    }

    for (const component of components) {
        const stat = lstatIfPresent(component);
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
            fail(`${label} root cannot traverse symbolic links or junctions.`, component);
        }
        if (component !== resolvedTarget && !stat.isDirectory()) {
            fail(`${label} root ancestor must be a directory.`, component);
        }
        if (process.platform === 'win32') {
            let realPath;
            try {
                realPath = fs.realpathSync.native(component);
            } catch (error) {
                fail(`${label} root ancestor could not be verified.`, component, {
                    cause: error?.code ?? error?.message,
                });
            }
            if (comparableRealPath(realPath) !== comparableRealPath(component)) {
                fail(`${label} root cannot traverse reparse points.`, component, {
                    realPath,
                });
            }
        }
    }
}

/**
 * Creates a synchronous guard for local JSON sidecar storage.
 *
 * The guard rejects lexical escapes plus every existing symbolic-link,
 * junction, or reparse component in the configured root ancestry and between
 * that root and the target. Callers should resolve or assert again immediately
 * before each filesystem action; descriptor-relative no-follow operations are
 * not available for this whole cross-platform path workflow in Node.js.
 *
 * @param {string} rootDirectory Configured storage root
 * @param {{ label: string, createError: (message: string, details: object) => Error }} options Error policy
 * @returns {{
 *   rootDirectory: string,
 *   assertPath: (targetPath: string) => string,
 *   resolvePath: (...segments: string[]) => string,
 *   ensureDirectory: (targetPath: string) => string,
 * }}
 */
export function createStoragePathGuard(rootDirectory, { label, createError }) {
    if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
        throw new TypeError('Storage root must be a non-empty string.');
    }
    if (typeof label !== 'string' || !label || typeof createError !== 'function') {
        throw new TypeError('Storage path guard options are invalid.');
    }

    const resolvedRoot = path.resolve(rootDirectory);
    let expectedRootIdentity = null;
    let expectedRootRealPath = null;
    const fail = (message, targetPath, details = {}) => {
        throw createError(message, { path: targetPath, ...details });
    };

    assertNoLinkedAncestors(resolvedRoot, fail, label);
    try {
        fs.mkdirSync(resolvedRoot, { recursive: true });
    } catch (error) {
        fail(`${label} root could not be initialized.`, resolvedRoot, { cause: error?.code ?? error?.message });
    }
    assertNoLinkedAncestors(resolvedRoot, fail, label);

    const assertPath = targetPath => {
        const resolvedTarget = path.resolve(targetPath);
        if (!isContained(resolvedRoot, resolvedTarget)) {
            fail(`${label} path escaped its root.`, resolvedTarget);
        }
        assertNoLinkedAncestors(resolvedRoot, fail, label);

        const rootStat = lstatIfPresent(resolvedRoot);
        if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
            fail(`${label} root must be a real directory.`, resolvedRoot);
        }
        let rootIdentity;
        let rootRealPath;
        try {
            rootIdentity = fs.lstatSync(resolvedRoot, { bigint: true });
            rootRealPath = fs.realpathSync.native(resolvedRoot);
        } catch (error) {
            fail(`${label} root identity could not be verified.`, resolvedRoot, {
                cause: error?.code ?? error?.message,
            });
        }
        if (expectedRootIdentity && (
            rootIdentity.dev !== expectedRootIdentity.dev
            || rootIdentity.ino !== expectedRootIdentity.ino
            || rootRealPath !== expectedRootRealPath
        )) {
            fail(`${label} root changed after initialization.`, resolvedRoot);
        }

        const relative = path.relative(resolvedRoot, resolvedTarget);
        let current = resolvedRoot;
        let missingComponent = false;
        if (!relative) return resolvedTarget;

        for (const segment of relative.split(path.sep)) {
            current = path.join(current, segment);
            const stat = lstatIfPresent(current);
            if (!stat) {
                missingComponent = true;
                continue;
            }
            if (missingComponent) {
                fail(`${label} path changed while it was being validated.`, current);
            }
            if (stat.isSymbolicLink()) {
                fail(`${label} cannot traverse symbolic links or junctions.`, current);
            }
            if (current !== resolvedTarget && !stat.isDirectory()) {
                fail(`${label} parent path must be a directory.`, current);
            }
        }
        return resolvedTarget;
    };

    const resolvePath = (...segments) => assertPath(path.resolve(resolvedRoot, ...segments));

    const ensureDirectory = targetPath => {
        const resolvedTarget = assertPath(targetPath);
        try {
            fs.mkdirSync(resolvedTarget, { recursive: true });
        } catch (error) {
            fail(`${label} directory could not be initialized.`, resolvedTarget, {
                cause: error?.code ?? error?.message,
            });
        }
        assertPath(resolvedTarget);
        const stat = lstatIfPresent(resolvedTarget);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
            fail(`${label} directory must be a real directory.`, resolvedTarget);
        }
        return resolvedTarget;
    };

    assertPath(resolvedRoot);
    const initialRootIdentity = fs.lstatSync(resolvedRoot, { bigint: true });
    expectedRootIdentity = Object.freeze({
        dev: initialRootIdentity.dev,
        ino: initialRootIdentity.ino,
    });
    expectedRootRealPath = fs.realpathSync.native(resolvedRoot);
    assertPath(resolvedRoot);
    return Object.freeze({
        rootDirectory: resolvedRoot,
        assertPath,
        resolvePath,
        ensureDirectory,
    });
}
