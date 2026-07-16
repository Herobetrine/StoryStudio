import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { writeGenerationEvent } from '../src/generation-router.js';
import { generationWireRequest } from '../src/generation-service.js';

test('NDJSON backpressure wait rejects when the client closes instead of hanging', async () => {
    const response = new EventEmitter();
    response.destroyed = false;
    response.writableEnded = false;
    response.write = () => false;
    const writing = writeGenerationEvent(response, { type: 'delta', delta: 'partial' });
    queueMicrotask(() => response.emit('close'));
    await assert.rejects(writing, error => error.name === 'AbortError');
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('close'), 0);
    assert.equal(response.listenerCount('error'), 0);
});

test('generation wire request preserves ordered messages and extended provider controls', () => {
    const messages = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'User' },
    ];
    const wire = generationWireRequest({
        prompt: 'serialized fallback',
        messages,
        topA: 0.2,
        minP: 0.1,
        frequencyPenalty: 0.3,
        presencePenalty: -0.1,
        repetitionPenalty: 1.05,
        seed: 42,
        assistantPrefill: 'Opening',
        stop: ['END'],
        diagnostics: { mustNotLeak: true },
    });

    assert.deepEqual(wire, {
        prompt: 'serialized fallback',
        messages,
        stop: ['END'],
        topA: 0.2,
        minP: 0.1,
        frequencyPenalty: 0.3,
        presencePenalty: -0.1,
        repetitionPenalty: 1.05,
        seed: 42,
        assistantPrefill: 'Opening',
    });
    assert.equal('diagnostics' in wire, false);
});
