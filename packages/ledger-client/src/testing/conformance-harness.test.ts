import { afterAll, expect } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { runLedgerConformance, type LedgerHarness } from './conformance.js';

/**
 * `LedgerHarness.teardown` is once, when the suite finishes. `reset` stays
 * between tests. A harness that omits teardown still finishes.
 *
 * The book is the in-memory reference. The harness only records lifecycle
 * calls. Nothing here opens a database or a process.
 */

type Mark = 'reset' | 'teardown';

function recordingHarness(marks: Mark[], withTeardown: boolean): () => Promise<LedgerHarness> {
  let book = new MemoryLedger();
  return async () => {
    const harness: LedgerHarness = {
      get ledger() {
        return book;
      },
      reset: async () => {
        marks.push('reset');
        book = new MemoryLedger();
      },
    };
    if (withTeardown) {
      harness.teardown = async () => {
        marks.push('teardown');
      };
    }
    return harness;
  };
}

const withTeardown: Mark[] = [];
const withoutTeardown: Mark[] = [];

runLedgerConformance('recording teardown', recordingHarness(withTeardown, true));
runLedgerConformance('omitted teardown', recordingHarness(withoutTeardown, false));

afterAll(() => {
  const teardowns = withTeardown.filter((mark) => mark === 'teardown');
  const resets = withTeardown.filter((mark) => mark === 'reset');
  expect(teardowns).toEqual(['teardown']);
  expect(withTeardown.at(-1)).toBe('teardown');
  expect(resets.length).toBeGreaterThan(1);
  expect(withTeardown.slice(0, -1).every((mark) => mark === 'reset')).toBe(true);

  expect(withoutTeardown.some((mark) => mark === 'teardown')).toBe(false);
  expect(withoutTeardown.filter((mark) => mark === 'reset').length).toBeGreaterThan(1);
});
