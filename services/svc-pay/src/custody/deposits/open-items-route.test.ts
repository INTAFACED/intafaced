import Fastify from 'fastify';
import { serviceAuthHeadersForBody, type PayCustodyOpenItemsInput, type PayCustodyOpenItemsReply } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerCustodyOpenItemsRoute } from './open-items-route.js';

const SECRET = 'internal-secret-for-custody-open-items-test';
const REPLY: PayCustodyOpenItemsReply = {
  items: [
    {
      depositId: 'd1',
      kind: 'held',
      userId: '22222222-2222-4222-8222-222222222222',
      assetId: 'USDT',
      networkId: 'ethereum',
      txHash: '0xabc',
      outputIndex: 0,
      amount: '5',
      signedAmount: '5',
      status: 'below_minimum',
      reason: null,
      detectedAt: '2026-10-30T00:00:00.000Z',
    },
  ],
  total: 1,
  sums: [{ networkId: 'ethereum', assetId: 'USDT', held: '5', heldCount: 1, reversalUnfunded: '0', reversalUnfundedCount: 0, net: '5' }],
};

async function appFor(list: (input: PayCustodyOpenItemsInput) => Promise<PayCustodyOpenItemsReply>) {
  const app = Fastify();
  registerCustodyOpenItemsRoute(app, { internalSecret: SECRET, list });
  await app.ready();
  return app;
}

function post(body: unknown, service = 'svc-ledger') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/internal/custody/open-items',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
}

describe('POST /internal/custody/open-items', () => {
  it('answers svc-ledger the crypto-native open items, passing the page and asset it asked for', async () => {
    const seen: PayCustodyOpenItemsInput[] = [];
    const app = await appFor(async (input) => {
      seen.push(input);
      return REPLY;
    });
    const res = await app.inject(post({ rail: 'crypto-native', assetId: 'USDT', offset: 200, limit: 200 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPLY);
    const whole = await app.inject(post({ rail: 'crypto-native' }));
    expect(whole.statusCode).toBe(200);
    expect(seen).toEqual([
      { assetId: 'USDT', offset: 200, limit: 200 },
      { offset: 0, limit: 200 },
    ]);
    await app.close();
  });

  it('refuses an unsigned caller, a body changed after signing, another service, a malformed read and another rail, without reading', async () => {
    const seen: PayCustodyOpenItemsInput[] = [];
    const app = await appFor(async (input) => {
      seen.push(input);
      return REPLY;
    });
    const open = await app.inject({ method: 'POST', url: '/internal/custody/open-items', payload: { rail: 'crypto-native' } });
    expect(open.statusCode).toBe(401);
    expect(open.json().error).toBe('pay.unauthenticated');
    const other = await app.inject(post({ rail: 'crypto-native' }, 'svc-ops'));
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('pay.open_items_service_forbidden');
    for (const body of [{}, { rail: 'crypto-native', limit: 201 }, { rail: 'crypto-native', extra: 1 }, { rail: 'Crypto Native' }]) {
      const bad = await app.inject(post(body));
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.json().error).toBe('pay.open_items_invalid');
    }
    const signed = post({ rail: 'crypto-native' });
    const tampered = await app.inject({ ...signed, payload: JSON.stringify({ rail: 'crypto-native', limit: 1 }) });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error).toBe('pay.unauthenticated');
    const rail = await app.inject(post({ rail: 'payout-sim' }));
    expect(rail.statusCode).toBe(404);
    expect(rail.json().error).toBe('pay.open_items_rail_unknown');
    expect(seen).toEqual([]);
    await app.close();
  });

  it('answers a failed read as unavailable, never an empty list', async () => {
    const app = await appFor(async () => {
      throw new Error('db down');
    });
    const res = await app.inject(post({ rail: 'crypto-native' }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('pay.custody_open_items_unavailable');
    await app.close();
  });
});
