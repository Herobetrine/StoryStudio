import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './src/app.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.STORY_STUDIO_DATA_ROOT || path.join(projectRoot, 'data'));
const parsedPort = Number(process.env.PORT || 8123);

if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}

const host = '127.0.0.1';
const app = createApp({ dataRoot, projectRoot });
const server = app.listen(parsedPort, host, () => {
    console.log(`Story Studio is available at http://${host}:${parsedPort}/`);
    console.log(`Data directory: ${dataRoot}`);
});

function shutdown(signal) {
    console.log(`Received ${signal}; stopping Story Studio.`);
    server.close(error => {
        if (error) {
            console.error('Story Studio failed to stop cleanly:', error);
            process.exitCode = 1;
        }
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
