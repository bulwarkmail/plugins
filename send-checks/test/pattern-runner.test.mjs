// The admin's patterns run in a Worker that is stopped at the time budget:
// one exec() of a catastrophic pattern can't be interrupted from the same
// thread, and the old chunked scan only looked at the clock between chunks.
import { describe, expect, it } from 'vitest';
import { runPatterns } from '../src/lib/pattern-runner.js';
import { nodeWorker } from './node-worker.mjs';

const rule = (name, source, flags = 'ig') => ({ name, source, flags });

describe('runPatterns', () => {
  it('finds the first match of each rule in each text', async () => {
    const result = await runPatterns(
      ['see kd-123456 and KD-654321', 'nothing', 'PRJ-ABC'],
      [rule('Customer', 'KD-\\d{6}'), rule('Project', 'PRJ-[A-Z]{3}', 'g')],
      { createWorker: nodeWorker, budgetMs: 5000 },
    );
    expect(result).toEqual({
      complete: true,
      found: [{ text: 0, name: 'Customer', match: 'kd-123456' }, { text: 2, name: 'Project', match: 'PRJ-ABC' }],
    });
  });

  it('stops a catastrophic pattern at the budget instead of hanging', async () => {
    let made;
    const started = Date.now();
    const result = await runPatterns(
      [`${'a'.repeat(40)}!`],
      // A pattern that slipped past the refusals would take minutes here.
      [rule('Evil', '(a+)+$')],
      { createWorker: () => (made = nodeWorker()), budgetMs: 250 },
    );
    expect(result).toEqual({ found: [], complete: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(made.terminated).toBe(true);
  });

  it("counts as not checked when no Worker can be made, and never runs the patterns here", async () => {
    expect(await runPatterns(['KD-123456'], [rule('Customer', 'KD-\\d{6}')], { createWorker: () => null }))
      .toEqual({ found: [], complete: false, reason: 'no-worker' });
    expect(await runPatterns(['KD-123456'], [rule('Customer', 'KD-\\d{6}')], { createWorker: () => { throw new Error('CSP'); } }))
      .toEqual({ found: [], complete: false, reason: 'no-worker' });
  });

  it('counts a Worker that fails as not checked', async () => {
    const broken = { postMessage() { setTimeout(() => this.onerror?.(new Error('boom')), 0); }, terminate() {} };
    expect(await runPatterns(['x'], [rule('X', 'x')], { createWorker: () => broken })).toEqual({ found: [], complete: false, reason: 'error' });
  });

  it('needs no Worker when there is nothing to scan', async () => {
    expect(await runPatterns(['', ''], [rule('X', 'x')], { createWorker: () => null })).toEqual({ found: [], complete: true });
    expect(await runPatterns(['text'], [], { createWorker: () => null })).toEqual({ found: [], complete: true });
  });
});
