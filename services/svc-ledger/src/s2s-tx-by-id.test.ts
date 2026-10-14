import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MemoryLedger, formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { handleS2sTxById, registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'ledger-internal-service-secret-32ch!';

async function seeded() {
  const ledger = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: 'tx-by-id' });
  const tx = await ledger.post(deposit);
  return { service: ledger as unknown as LedgerService, deposit, tx };
}

describe('POST /trpc/txById (s2s)', () => {
  it('answers found:false for a well-formed id that was never booked', async () => {
    const { service } = await seeded();
    await expect(handleS2sTxById(service, { txId: '00000000-0000-4000-8000-000000000000' })).resolves.toEqual({ found: false });
  });

  it('answers the booked transaction and its entries, and not its meta', async () => {
    const { service, deposit, tx } = await seeded();
    const out = await handleS2sTxById(service, { txId: tx.id });
    expect(out).toEqual({
      found: true,
      txId: tx.id,
      idempotencyKey: deposit.idempotencyKey,
      hash: tx.hash,
      postedAt: tx.postedAt.toISOString(),
      module: deposit.module,
      reason: deposit.reason,
      entries: tx.entries.map((e) => ({
        accountId: e.accountId,
        assetId: e.assetId,
        direction: e.direction,
        amount: formatAmount(e.amount),
      })),
    });
    expect(out).not.toHaveProperty('meta');
    expect((out as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  });

  it('refuses a missing, empty or non-uuid id rather than treating it as absent', async () => {
    const { service } = await seeded();
    await expect(handleS2sTxById(service, {})).rejects.toThrow();
    await expect(handleS2sTxById(service, { txId: '' })).rejects.toThrow();
    await expect(handleS2sTxById(service, { txId: 'not-a-uuid' })).rejects.toThrow();
    await expect(handleS2sTxById(service, { txId: 42 })).rejects.toThrow();
  });

  it('is mounted behind the service-credential door', async () => {
    const { service, tx } = await seeded();
    const app = Fastify({ logger: false });
    registerS2sHttp(app, service, SECRET, {});
    await app.ready();
    const payload = JSON.stringify({ txId: tx.id });
    const headers = { 'content-type': 'application/json' };

    const anon = await app.inject({ method: 'POST', url: '/trpc/txById', headers, payload });
    expect(anon.statusCode).toBe(401);

    const bad = JSON.stringify({ txId: 'nope' });
    const refused = await app.inject({
      method: 'POST',
      url: '/trpc/txById',
      headers: { ...headers, ...serviceAuthHeadersForBody('svc-bank', SECRET, bad) },
      payload: bad,
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);

    const signed = await app.inject({
      method: 'POST',
      url: '/trpc/txById',
      headers: { ...headers, ...serviceAuthHeadersForBody('svc-bank', SECRET, payload) },
      payload,
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ found: true, txId: tx.id, module: expect.any(String) });
    await app.close();
  });
});
