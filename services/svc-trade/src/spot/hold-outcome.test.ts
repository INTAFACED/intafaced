import { InsufficientFundsError, InvalidEntryError, LedgerError, recipes } from '@intafaced/ledger-client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyHoldPostError, HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS, orderHoldIdempotencyKey } from './hold-outcome.js';

describe('order hold unknown outcome', () => {
  it('reads the same idempotency key orderHold posts', () => {
    const orderId = '11111111-1111-4111-8111-111111111111';
    expect(orderHoldIdempotencyKey(orderId)).toBe(`order.hold:${orderId}`);
    expect(recipes.orderHold({ orderId, userId: orderId, assetId: 'USDT', amount: 1n }).idempotencyKey).toBe(
      orderHoldIdempotencyKey(orderId),
    );
  });

  it('treats a named ledger refusal as definite and a lost connection as unknown', () => {
    expect(classifyHoldPostError(new InsufficientFundsError('acct', 'USDT', '2', '1'))).toBe('refused');
    expect(classifyHoldPostError(new InvalidEntryError('bad'))).toBe('refused');
    expect(classifyHoldPostError(new LedgerError('book is frozen', 'ledger.frozen'))).toBe('refused');
    expect(classifyHoldPostError(new LedgerError('key required', 'ledger.caller_unbound'))).toBe('refused');
    expect(classifyHoldPostError(new LedgerError('not granted', 'ledger.caller_forbidden'))).toBe('refused');
    const lost = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyHoldPostError(lost)).toBe('unknown');
    expect(classifyHoldPostError(new Error('timeout'))).toBe('unknown');
    expect(classifyHoldPostError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('unknown');
    expect(classifyHoldPostError(new LedgerError('ledger 500', 'ledger.internal'))).toBe('unknown');
    expect(classifyHoldPostError(Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' }))).toBe('unknown');
  });

  it('treats a connect failure on cause as never sent, and a reset as unknown', () => {
    const wrap = (code: string, depth: number) => {
      let err: Error = Object.assign(new Error(code), { code });
      for (let i = 0; i < depth; i++) err = Object.assign(new Error('fetch failed'), { cause: err });
      return err;
    };
    expect(classifyHoldPostError(wrap('ECONNREFUSED', 1))).toBe('unsent');
    expect(classifyHoldPostError(wrap('ENOTFOUND', 1))).toBe('unsent');
    expect(classifyHoldPostError(wrap('EAI_AGAIN', 2))).toBe('unsent');
    expect(classifyHoldPostError(wrap('ECONNREFUSED', 3))).toBe('unsent');
    expect(classifyHoldPostError(wrap('ECONNREFUSED', 4))).toBe('unknown');
    expect(classifyHoldPostError(wrap('ECONNRESET', 1))).toBe('unknown');
    expect(classifyHoldPostError(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }))).toBe('unknown');
    expect(HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS).toBe(7 * 60);
  });

  it('adds hold_unknown without dropping an enum value in the same statement', () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0051_order_hold_unknown.sql'), 'utf8');
    expect(file).toContain("ADD VALUE IF NOT EXISTS 'hold_unknown'");
    expect(file).not.toMatch(/UPDATE[\s\S]*hold_unknown/);
  });
});
