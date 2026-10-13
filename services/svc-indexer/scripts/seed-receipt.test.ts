import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertSeedReceipt } from './seed-receipt.js';

/**
 * viem resolves a reverted receipt. The deploy script must throw on that
 * receipt before it prints that ETH-USD was seeded.
 */

const SEEDED_LINE = 'seeded market     ETH-USD  (one level, one fill, one position)';
const script = readFileSync(new URL('./deploy-dev-venue.ts', import.meta.url), 'utf8');

function checkBeforeSeededLog(): void {
  const checkAt = script.search(/assertSeedReceipt\(/);
  const logAt = script.indexOf(SEEDED_LINE);
  expect(checkAt).toBeGreaterThanOrEqual(0);
  expect(logAt).toBeGreaterThan(checkAt);
  expect(script).toMatch(
    /const seedReceipt = await clients\.publicClient\.waitForTransactionReceipt\(\{ hash: seed \}\);\nassertSeedReceipt\(seedReceipt\);/,
  );
}

describe('svc-indexer · dev venue seed receipt', () => {
  it('throws on a reverted receipt before the seeded market line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => assertSeedReceipt({ status: 'reverted' })).toThrow(/receipt status reverted/);
      expect(log.mock.calls.flat().join('\n')).not.toContain('seeded market');
      checkBeforeSeededLog();
    } finally {
      log.mockRestore();
    }
  });

  it('a success receipt still allows the existing seeded market line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => assertSeedReceipt({ status: 'success' })).not.toThrow();
      expect(script).toContain(SEEDED_LINE);
      expect(script).toContain("scaled('3000.5')");
      expect(script).toContain("scaled('2.25')");
      checkBeforeSeededLog();
    } finally {
      log.mockRestore();
    }
  });
});
