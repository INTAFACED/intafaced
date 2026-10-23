import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createLedgerRouter } from '../router.js';
import type { LedgerService } from '../service.js';
import { LookupUnrecordedError } from './operator-lookup.js';
import type { OperatorAccessEntry } from './operator-owner-balances.js';
import { LEDGER_TX_NOT_FOUND, operatorTxGet } from './operator-tx-get.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const authConfig = {
  secret: 'a-ledger-txget-test-secret-long-enough',
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

/** TEST amounts only. A memory book that also keeps the access rows a lookup writes. */
async function seeded() {
  const book = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('7.25'), rail: 'test', railRef: 'txget-1' });
  const tx = await book.post(deposit);
  const access: OperatorAccessEntry[] = [];
  const ledger = Object.assign(book, { recordOperatorAccess: async (entry: OperatorAccessEntry) => void access.push(entry) });
  return { ledger, deposit, tx, access };
}

describe('operatorTxGet', () => {
  it('returns every posting as decimal strings with the business key, after recording the lookup', async () => {
    const { ledger, deposit, tx, access } = await seeded();
    const out = await operatorTxGet(ledger, ACTOR, { txId: tx.id });
    expect(out).toMatchObject({ txId: tx.id, businessKey: deposit.idempotencyKey, module: deposit.module, hash: tx.hash });
    expect(out.postings).toHaveLength(tx.entries.length);
    expect(out.postings.map((p) => p.amount)).toContain('7.25');
    for (const p of out.postings) expect(typeof p.balanceAfter).toBe('string');
    expect(out).not.toHaveProperty('meta');
    expect(access).toEqual([{ actorId: USER, requestId: 'req-1', ownerType: 'transaction', ownerId: tx.id, action: 'transaction.read' }]);
  });

  it('refuses when the lookup cannot be recorded, and never reads the book', async () => {
    const { tx } = await seeded();
    let read = false;
    const reader = {
      recordOperatorAccess: () => Promise.reject(new Error('access log down')),
      getTx: async () => {
        read = true;
        return null;
      },
    };
    await expect(operatorTxGet(reader, ACTOR, { txId: tx.id })).rejects.toBeInstanceOf(LookupUnrecordedError);
    expect(read).toBe(false);
  });

  it('refuses an unknown id with ledger.tx_not_found, never an empty row', async () => {
    const { ledger } = await seeded();
    await expect(operatorTxGet(ledger, ACTOR, { txId: MISSING })).rejects.toMatchObject({ code: LEDGER_TX_NOT_FOUND });
  });

  it('refuses a malformed id', async () => {
    const { ledger } = await seeded();
    await expect(operatorTxGet(ledger, ACTOR, { txId: 'not-a-uuid' })).rejects.toThrow();
  });

  it('surfaces a read failure', async () => {
    const reader = { recordOperatorAccess: async () => {}, getTx: () => Promise.reject(new Error('db down')) };
    await expect(operatorTxGet(reader, ACTOR, { txId: MISSING })).rejects.toThrow('db down');
  });
});

describe('ledger.transactionGet procedure', () => {
  it('serves admin:treasury with a second factor, recording the operator and request', async () => {
    const { ledger, tx, access } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.transactionGet({ txId: tx.id })).resolves.toMatchObject({ txId: tx.id });
    expect(access).toMatchObject([{ actorId: USER, requestId: 'req-1', ownerId: tx.id, action: 'transaction.read' }]);
  });

  it('serves a founder sign-in with admin:read and a second factor, recorded under that founder (owner decision 2026-10-23)', async () => {
    const { ledger, tx, access } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(router.createCaller(await ctx(['admin:read'], true)).transactionGet({ txId: tx.id })).resolves.toMatchObject({
      txId: tx.id,
    });
    expect(access).toMatchObject([{ actorId: USER, ownerId: tx.id, action: 'transaction.read' }]);
    await expect(router.createCaller(await ctx(['admin:read'], false)).transactionGet({ txId: tx.id })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(access).toHaveLength(1);
  });

  it('maps an unrecorded lookup to a typed internal error', async () => {
    const { tx } = await seeded();
    const failing = { recordOperatorAccess: () => Promise.reject(new Error('down')), getTx: async () => tx } as unknown as LedgerService;
    const caller = createLedgerRouter(failing).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.transactionGet({ txId: tx.id })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'ledger.lookup_unrecorded',
    });
  });

  it('maps not found to NOT_FOUND with the code', async () => {
    const { ledger } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.transactionGet({ txId: MISSING })).rejects.toMatchObject({ code: 'NOT_FOUND', message: LEDGER_TX_NOT_FOUND });
  });

  it('refuses without a second factor, with only ledger:read, and anonymously, recording nothing', async () => {
    const { ledger, tx, access } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(router.createCaller(await ctx(['admin:treasury'], false)).transactionGet({ txId: tx.id })).rejects.toThrow();
    await expect(router.createCaller(await ctx(['ledger:read'], true)).transactionGet({ txId: tx.id })).rejects.toThrow();
    const anon: Context = { principal: null, service: 'svc-trade', region: 'DE', requestId: 'r' };
    await expect(router.createCaller(anon).transactionGet({ txId: tx.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(access).toHaveLength(0);
  });
});
