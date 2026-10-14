import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { handleS2sTxByKey, registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'ledger-internal-service-secret-32ch!';

async function seeded() {
  const ledger = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: 'tx-by-key' });
  const tx = await ledger.post(deposit);
  return { service: ledger as unknown as LedgerService, deposit, tx };
}

describe('POST /trpc/txByKey (s2s)', () => {
  it('answers found:false for a key that was never booked', async () => {
    const { service } = await seeded();
    await expect(handleS2sTxByKey(service, { idempotencyKey: 'order.release:never-booked:0' })).resolves.toEqual({ found: false });
  });

  it('answers the identifying fields of a booked key, and not its entries', async () => {
    const { service, deposit, tx } = await seeded();
    const out = await handleS2sTxByKey(service, { idempotencyKey: deposit.idempotencyKey });
    expect(out).toEqual({
      found: true,
      txId: tx.id,
      hash: tx.hash,
      postedAt: tx.postedAt.toISOString(),
      module: deposit.module,
      reason: deposit.reason,
    });
  });

  it('refuses a missing or empty key rather than treating it as absent', async () => {
    const { service } = await seeded();
    await expect(handleS2sTxByKey(service, {})).rejects.toThrow();
    await expect(handleS2sTxByKey(service, { idempotencyKey: '' })).rejects.toThrow();
  });

  it('is mounted behind the service-credential door', async () => {
    const { service, deposit } = await seeded();
    const app = Fastify({ logger: false });
    registerS2sHttp(app, service, SECRET, {});
    await app.ready();
    const payload = JSON.stringify({ idempotencyKey: deposit.idempotencyKey });
    const headers = { 'content-type': 'application/json' };

    const anon = await app.inject({ method: 'POST', url: '/trpc/txByKey', headers, payload });
    expect(anon.statusCode).toBe(401);

    const signed = await app.inject({
      method: 'POST',
      url: '/trpc/txByKey',
      headers: { ...headers, ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
      payload,
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ found: true, module: deposit.module });
    await app.close();
  });
});
