import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test as base } from '@playwright/test';

import { createMockProviderServer } from '../../scripts/mock-provider-server.js';
import { createApp } from '../../src/app.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function listenOnLoopback(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser fixture server did not expose a TCP address.');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
        server.close(error => {
            if (error) reject(error);
            else resolve();
        });
        server.closeAllConnections?.();
    });
}

export const test = base.extend({
    storyStudio: async ({}, use) => {
        const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-browser-'));
        const mockProviderServer = createMockProviderServer({ chunkDelay: 0 });
        let appServer = null;
        try {
            const mockProviderOrigin = await listenOnLoopback(mockProviderServer);
            appServer = createApp({ dataRoot, projectRoot }).listen(0, '127.0.0.1');
            await once(appServer, 'listening');
            const address = appServer.address();
            if (!address || typeof address === 'string') {
                throw new Error('Story Studio browser fixture did not expose a TCP address.');
            }
            await use({
                baseURL: `http://127.0.0.1:${address.port}`,
                dataRoot,
                mockProviderBaseURL: `${mockProviderOrigin}/v1`,
            });
        } finally {
            const cleanupResults = await Promise.allSettled([
                closeServer(appServer),
                closeServer(mockProviderServer),
            ]);
            await fs.rm(dataRoot, {
                recursive: true,
                force: true,
                maxRetries: process.platform === 'win32' ? 20 : 0,
                retryDelay: 50,
            });
            const cleanupErrors = cleanupResults
                .filter(result => result.status === 'rejected')
                .map(result => result.reason);
            if (cleanupErrors.length > 0) {
                throw new AggregateError(cleanupErrors, 'Browser fixture server cleanup failed.');
            }
        }
    },
    baseURL: async ({ storyStudio }, use) => {
        await use(storyStudio.baseURL);
    },
});

export { expect };
