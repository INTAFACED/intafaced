import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createLedgerRouter } from '../router.js';
import type { LedgerService } from '../service.js';
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

/** TEST amounts only. */
async function seeded() {
  const ledger = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('7.25'), rail: 'test', railRef: 'txget-1' });
  const tx = await ledger.post(deposit);
  return { ledger, deposit, tx };
}

describe('operatorTxGet', () => {
  it('returns every posting as decimal strings with the business key', async () => {
    const { ledger, deposit, tx } = await seeded();
    const out = await operatorTxGet(ledger, { txId: tx.id });
    expect(out).toMatchObject({ txId: tx.id, businessKey: deposit.idempotencyKey, module: deposit.module, hash: tx.hash });
    expect(out.postings).toHaveLength(tx.entries.length);
    expect(out.postings.map((p) => p.amount)).toContain('7.25');
    for (const p of out.postings) expect(typeof p.balanceAfter).toBe('string');
    expect(out).not.toHaveProperty('meta');
  });

  it('refuses an unknown id with ledger.tx_not_found, never an empty row', async () => {
    const { ledger } = await seeded();
    await expect(operatorTxGet(ledger, { txId: MISSING })).rejects.toMatchObject({ code: LEDGER_TX_NOT_FOUND });
  });

  it('refuses a malformed id', async () => {
    const { ledger } = await seeded();
    await expect(operatorTxGet(ledger, { txId: 'not-a-uuid' })).rejects.toThrow();
  });

  it('surfaces a read failure', async () => {
    await expect(operatorTxGet({ getTx: () => Promise.reject(new Error('db down')) }, { txId: MISSING })).rejects.toThrow('db down');
  });
});

describe('ledger.transactionGet procedure', () => {
  it('serves admin:treasury with a second factor', async () => {
    const { ledger, tx } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.transactionGet({ txId: tx.id })).resolves.toMatchObject({ txId: tx.id });
  });

  it('maps not found to NOT_FOUND with the code', async () => {
    const { ledger } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.transactionGet({ txId: MISSING })).rejects.toMatchObject({ code: 'NOT_FOUND', message: LEDGER_TX_NOT_FOUND });
  });

  it('refuses without a second factor, with only ledger:read, and anonymously', async () => {
    const { ledger, tx } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(router.createCaller(await ctx(['admin:treasury'], false)).transactionGet({ txId: tx.id })).rejects.toThrow();
    await expect(router.createCaller(await ctx(['ledger:read'], true)).transactionGet({ txId: tx.id })).rejects.toThrow();
    const anon: Context = { principal: null, service: 'svc-trade', region: 'DE', requestId: 'r' };
    await expect(router.createCaller(anon).transactionGet({ txId: tx.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
