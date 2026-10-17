import { InsufficientFundsError, InvalidEntryError, LedgerError, recipes } from '@intafaced/ledger-client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyHoldPostError, orderHoldIdempotencyKey } from './hold-outcome.js';

describe('order hold unknown outcome', () => {
  it('reads the same idempotency key orderHold posts', () => {
    const orderId = '11111111-1111-4111-8111-111111111111';
    expect(orderHoldIdempotencyKey(orderId)).toBe(`order.hold:${orderId}`);
    expect(recipes.orderHold({ orderId, userId: orderId, assetId: 'USDT', amount: 1n }).idempotencyKey).toBe(
      orderHoldIdempotencyKey(orderId),
    );
  });

  it('treats a named ledger refusal as definite and a lost connection as unknown', () => {
    expect(
      classifyHoldPostError(new InsufficientFundsError('acct', 'USDT', '2', '1')),
    ).toBe('refused');
    expect(classifyHoldPostError(new InvalidEntryError('bad'))).toBe('refused');
    expect(classifyHoldPostError(new LedgerError('book is frozen', 'ledger.frozen'))).toBe('refused');
    const lost = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyHoldPostError(lost)).toBe('unknown');
    expect(classifyHoldPostError(new Error('timeout'))).toBe('unknown');
    expect(classifyHoldPostError(new LedgerError('ledger 500', 'ledger.internal'))).toBe('unknown');
  });

  it('adds hold_unknown without dropping an enum value in the same statement', () => {
    const file = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0051_order_hold_unknown.sql'),
      'utf8',
    );
    expect(file).toContain("ADD VALUE IF NOT EXISTS 'hold_unknown'");
    expect(file).not.toMatch(/UPDATE[\s\S]*hold_unknown/);
  });
});
