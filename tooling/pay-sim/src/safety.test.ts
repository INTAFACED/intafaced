import { describe, expect, it, vi } from 'vitest';
import { Deadline, parseOptions, assertLedgerBalanced, assertOutbound } from './safety.js';

const env = { APP_ENV: 'test', TEST_DATABASE_URL: 'postgres://test:test@localhost:5433/intafaced_test' };

describe('sandbox boundary and finite work', () => {
  it('accepts only an explicit test environment and a local dedicated test database', () => {
    expect(parseOptions(['--iterations', '2', '--timeout-ms', '10000'], env)).toMatchObject({ iterations: 2, timeoutMs: 10000 });
    for (const APP_ENV of [undefined, 'development', 'production', 'staging']) {
      expect(() => parseOptions([], { ...env, APP_ENV })).toThrow(/APP_ENV=test/);
    }
    for (const TEST_DATABASE_URL of [
      undefined,
      'postgres://test:test@localhost:5433/live',
      'postgres://test:test@vendor.example/finance_test',
    ]) {
      expect(() => parseOptions([], { ...env, TEST_DATABASE_URL })).toThrow(/local.*_test/);
    }
  });

  it('rejects unknown, repeated, malformed and excessive iteration/deadline options', () => {
    for (const args of [
      ['--iterations', '0'],
      ['--iterations', '101'],
      ['--iterations', '1.5'],
      ['--iterations', 'Infinity'],
      ['--iterations', '2x'],
      ['--iterations'],
      ['--iterations', '1', '--iterations', '2'],
      ['--timeout-ms', '0'],
      ['--timeout-ms', '120001'],
      ['--forever'],
    ])
      expect(() => parseOptions(args, env)).toThrow();
  });

  it('closes active clients at the deadline and prevents another effect', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => undefined);
      const deadline = new Deadline(10, close);
      const effect = vi.fn(async () => 'done');
      await expect(deadline.step(effect)).resolves.toBe('done');
      await vi.advanceTimersByTimeAsync(10);
      expect(close).toHaveBeenCalledOnce();
      await expect(deadline.step(effect)).rejects.toThrow(/deadline/);
      expect(effect).toHaveBeenCalledOnce();
      deadline.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('independent money assertions', () => {
  it('checks each transaction per asset so opposite currency errors cannot cancel', () => {
    const entry = (assetId: string, direction: 'debit' | 'credit', amount: bigint) => ({ assetId, direction, amount });
    expect(() => assertLedgerBalanced([{ entries: [entry('USD', 'debit', 5n), entry('USDT', 'credit', 5n)] }])).toThrow(/unbalanced/);
    expect(() => assertLedgerBalanced([{ entries: [entry('USD', 'debit', 5n), entry('USD', 'credit', 5n)] }])).not.toThrow();
  });

  it('detects missing, duplicate, extra or changed outbound transfers from intended obligations', () => {
    const transfer = { idempotencyKey: 'payout:1', assetId: 'USDT', amount: 11n, to: 'TEST-destination' };
    expect(() => assertOutbound([transfer], [transfer])).not.toThrow();
    for (const actual of [[], [transfer, transfer], [{ ...transfer, amount: 12n }], [{ ...transfer, to: 'other' }]]) {
      expect(() => assertOutbound(actual, [transfer])).toThrow(/outbound/);
    }
  });
});
