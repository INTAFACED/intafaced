import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createLedgerRouter } from '../router.js';
import type { LedgerService } from '../service.js';
import { LookupUnrecordedError } from './operator-lookup.js';
import type { OperatorAccessEntry } from './operator-owner-balances.js';
import { TraceInconsistentError, traceBusinessKey } from './operator-trace.js';
import { BookingRecordMissingError } from './operator-tx-get.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const authConfig = {
  secret: 'a-ledger-trace-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function ctx(scopes: string[], mfa: boolean): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

const ACTOR = { actorId: USER, requestId: 'req-1' };
const BOOKING = {
  seq: '7',
  bookedAt: '2026-10-24T12:00:00.000Z',
  reference: 'corr-TEST-1',
  event: {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    subject: 'intafaced.ledger.tx.posted' as const,
    recordedAt: '2026-10-24T12:00:00.000Z',
    publishedAt: null,
  },
};
const record = { recordOperatorAccess: async () => {}, readBookingRecord: async () => BOOKING };

/** TEST amounts only. A memory book that also keeps the access rows a lookup writes. */
async function seeded() {
  const book = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10.5'), rail: 'test', railRef: 'trace-1' });
  const tx = await book.post(deposit);
  const access: OperatorAccessEntry[] = [];
  const ledger = Object.assign(book, {
    recordOperatorAccess: async (entry: OperatorAccessEntry) => void access.push(entry),
    readBookingRecord: async (id: string) => (id === tx.id ? BOOKING : null),
  });
  return { ledger, deposit, tx, access };
}

describe('traceBusinessKey', () => {
  it('traces a booked key to its transaction, every posting as decimal strings, after recording the lookup', async () => {
    const { ledger, deposit, tx, access } = await seeded();
    const out = await traceBusinessKey(ledger, ACTOR, { businessKey: deposit.idempotencyKey });
    expect(out).toMatchObject({ found: true, txId: tx.id, module: deposit.module, reason: deposit.reason, hash: tx.hash });
    if (!out.found) throw new Error('expected found');
    expect(out.postings).toHaveLength(tx.entries.length);
    for (const p of out.postings) {
      expect(typeof p.amount).toBe('string');
      expect(typeof p.balanceAfter).toBe('string');
    }
    expect(out.postings.map((p) => p.amount)).toContain('10.5');
    // Its place in the log and its audit entry: the sequence and the tx.posted record written in the same commit.
    expect(out.booking).toEqual(BOOKING);
    expect(out.postings.map((p) => p.side).sort()).toEqual(['destination', 'source']);
    expect(access).toEqual([
      { actorId: USER, requestId: 'req-1', ownerType: 'business_key', ownerId: deposit.idempotencyKey, action: 'trace.read' },
    ]);
  });

  it('refuses when the lookup cannot be recorded, and never reads the book', async () => {
    let read = false;
    const reader = {
      recordOperatorAccess: () => Promise.reject(new Error('access log down')),
      getTxByKey: async () => {
        read = true;
        return null;
      },
      readBookingRecord: async () => BOOKING,
    };
    await expect(traceBusinessKey(reader, ACTOR, { businessKey: 'k' })).rejects.toBeInstanceOf(LookupUnrecordedError);
    expect(read).toBe(false);
  });

  it('answers an honest no-record for a key that never booked', async () => {
    const { ledger } = await seeded();
    await expect(traceBusinessKey(ledger, ACTOR, { businessKey: 'never:booked:1' })).resolves.toEqual({
      found: false,
      businessKey: 'never:booked:1',
    });
  });

  it('refuses a blank key instead of treating it as absent', async () => {
    const { ledger } = await seeded();
    await expect(traceBusinessKey(ledger, ACTOR, { businessKey: '   ' })).rejects.toThrow();
  });

  it('refuses to show a transaction the book says was booked under another key', async () => {
    const { tx } = await seeded();
    const lying = { ...record, getTxByKey: async () => tx };
    await expect(traceBusinessKey(lying, ACTOR, { businessKey: 'other:key' })).rejects.toBeInstanceOf(TraceInconsistentError);
  });

  it('refuses a transaction with no row in the log rather than showing it without one', async () => {
    const { ledger, deposit } = await seeded();
    const lost = { ...record, getTxByKey: (k: string) => ledger.getTxByKey(k), readBookingRecord: async () => null };
    await expect(traceBusinessKey(lost, ACTOR, { businessKey: deposit.idempotencyKey })).rejects.toBeInstanceOf(BookingRecordMissingError);
  });

  it('surfaces a ledger read failure rather than a partial answer', async () => {
    const failing = { ...record, getTxByKey: async () => Promise.reject(new Error('db down')) };
    await expect(traceBusinessKey(failing, ACTOR, { businessKey: 'k' })).rejects.toThrow('db down');
  });
});

describe('ledger.trace procedure', () => {
  it('serves an admin:treasury session with a second factor', async () => {
    const { ledger, deposit } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: deposit.idempotencyKey })).resolves.toMatchObject({ found: true });
  });

  it('serves a founder sign-in with admin:read and a second factor, and refuses it without one', async () => {
    const { ledger, deposit } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(
      router.createCaller(await ctx(['admin:read'], true)).trace({ businessKey: deposit.idempotencyKey }),
    ).resolves.toMatchObject({
      found: true,
    });
    await expect(
      router.createCaller(await ctx(['admin:read'], false)).trace({ businessKey: deposit.idempotencyKey }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses treasury scope without a second factor, a plain ledger reader, and an anonymous caller', async () => {
    const { ledger, deposit } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(
      router.createCaller(await ctx(['admin:treasury'], false)).trace({ businessKey: deposit.idempotencyKey }),
    ).rejects.toThrow();
    await expect(router.createCaller(await ctx(['ledger:read'], true)).trace({ businessKey: deposit.idempotencyKey })).rejects.toThrow();
    const anon: Context = { principal: null, service: 'svc-trade', region: 'DE', requestId: 'r' };
    await expect(router.createCaller(anon).trace({ businessKey: deposit.idempotencyKey })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('maps an inconsistent book to a typed internal error', async () => {
    const { tx } = await seeded();
    const lying = { ...record, getTxByKey: async () => tx } as unknown as LedgerService;
    const caller = createLedgerRouter(lying).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: 'other:key' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'ledger.trace_inconsistent',
    });
  });

  it('still reads while the posting freeze is on', async () => {
    const { ledger, deposit } = await seeded();
    const frozen = {
      ...record,
      getTxByKey: (k: string) => ledger.getTxByKey(k),
      status: async () => ({ postingEnabled: false, frozenReason: 'TEST', frozenBy: 'op' }),
    };
    const caller = createLedgerRouter(frozen as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: deposit.idempotencyKey })).resolves.toMatchObject({ found: true });
  });
});
