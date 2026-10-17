import { describe, expect, it } from 'vitest';
import { postFingerprint } from './client.js';
import { MemoryLedger } from './memory-ledger.js';
import { parseAmount as amt } from './money.js';
import { recipes } from './recipes/index.js';

const USER = '11111111-1111-4111-8111-111111111111';
const deposit = (amount: string, railRef = 'fp-1') =>
  recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef });

describe('postFingerprint', () => {
  it('is pinned: stored digests outlive code changes, so the encoding must never drift', () => {
    // If this fails you changed the encoding. Do not edit the constant: add `ledger-post-body-v2`, keep reading v1.
    const literal = {
      module: 'pin-module',
      reason: 'pin.reason',
      entries: [
        {
          account: { ownerType: 'user', ownerId: 'u-1', assetId: 'USDT', kind: 'hold', purpose: 'order:1' },
          direction: 'debit',
          amount: 123456789n,
        },
        { account: { ownerType: 'house', ownerId: 'fees', assetId: 'USDT', kind: 'available' }, direction: 'credit', amount: 123456789n },
      ],
    } as never;
    expect(postFingerprint(literal)).toBe('11b33de4b1d81d2b3903623a79b6a63d5bc2bbe74a2d93c12a70b4865cfa2a57');
  });

  it('ignores entry order, meta and correlation id; sees amount, account, direction, module and reason', () => {
    const base = deposit('50');
    const same = postFingerprint({ ...base, entries: [...base.entries].reverse() });
    expect(same).toBe(postFingerprint(base));
    expect(postFingerprint(deposit('51'))).not.toBe(postFingerprint(base));
    expect(postFingerprint({ ...base, module: 'other' })).not.toBe(postFingerprint(base));
    expect(postFingerprint({ ...base, reason: 'other' })).not.toBe(postFingerprint(base));
    expect(
      postFingerprint({ ...base, entries: base.entries.map((e) => ({ ...e, direction: e.direction === 'debit' ? 'credit' : 'debit' })) }),
    ).not.toBe(postFingerprint(base));
  });

  it('does not collide when an owner id and a purpose both contain the old delimiter', () => {
    const a = {
      module: 'm',
      reason: 'r',
      entries: [
        { account: { ownerType: 'user', ownerId: 'a:b', assetId: 'X', kind: 'hold', purpose: 'c' }, direction: 'debit', amount: 1n },
      ],
    } as never;
    const b = {
      module: 'm',
      reason: 'r',
      entries: [
        { account: { ownerType: 'user', ownerId: 'a', assetId: 'X', kind: 'hold', purpose: 'b:c' }, direction: 'debit', amount: 1n },
      ],
    } as never;
    expect(postFingerprint(a)).not.toBe(postFingerprint(b));
  });

  it('never throws on an unreadable body, and the digest matches nothing else', () => {
    const broken = { module: 'm', reason: 'r', entries: [{ account: null, direction: 'debit', amount: 1 }] } as never;
    expect(() => postFingerprint(broken)).not.toThrow();
    expect(postFingerprint(broken)).not.toBe(postFingerprint(broken));
  });
});

describe('MemoryLedger idempotency conflict mode', () => {
  it('refuse (default): a different body under a booked key is refused', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(deposit('50'));
    await expect(ledger.post(deposit('500'))).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });
  });

  it('detect: answers with the original and reports the mismatch, once per replay', async () => {
    const seen: unknown[] = [];
    const ledger = new MemoryLedger({ idempotencyConflict: 'detect', onIdempotencyMismatch: (i) => seen.push(i) });
    const first = await ledger.post(deposit('50'));
    expect((await ledger.post(deposit('500'))).id).toBe(first.id);
    expect((await ledger.post(deposit('50'))).id).toBe(first.id);
    expect(seen).toEqual([{ idempotencyKey: first.idempotencyKey, module: 'ledger', reason: expect.any(String) }]);
  });

  it('detect: a throwing reporter cannot change the answer', async () => {
    const ledger = new MemoryLedger({
      idempotencyConflict: 'detect',
      onIdempotencyMismatch: () => {
        throw new Error('log sink down');
      },
    });
    const first = await ledger.post(deposit('50'));
    expect((await ledger.post(deposit('500'))).id).toBe(first.id);
  });
});
