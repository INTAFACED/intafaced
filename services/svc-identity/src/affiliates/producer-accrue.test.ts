import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { BOOT_TIMEOUT_MS, BOOT_INTERNAL_SECRET, bootIdentity } from '../boot.testkit.js';
import { MemoryAccrualStore } from './accrual-store.js';
import { AFFILIATE_PRODUCER_PATH, AFFILIATE_PRODUCER_SOURCE_BY_SERVICE, registerAffiliateProducerAccrue } from './producer-accrue.js';
import { AFFILIATE_PROGRAMME_DEPTH_UNSET } from './programme-depth.js';

const SECRET = 'test-internal-service-secret-32ch!!';
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BENE0 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEE = 'fee-evt-o2-producer';

const publishedLaw = {
  published: true as const,
  tiers: [{ hop: 0, rate: '0.130' }],
};

function payload(over: Record<string, unknown> = {}) {
  return {
    feeEventId: FEE,
    userId: PAYER,
    feeAmount: '100',
    asset: 'USDT',
    sourceModule: 'trade' as const,
    ...over,
  };
}

async function app(opts: { law?: typeof publishedLaw | undefined; depth?: number | undefined } = {}) {
  const parent = new Map<string, string>([[PAYER, BENE0]]);
  const store = new MemoryAccrualStore();
  const active: string[] = [];
  const f = Fastify({ logger: false });
  registerAffiliateProducerAccrue(f, {
    internalSecret: SECRET,
    referral: { loadParentMap: async () => parent },
    freeze: { frozenIds: async () => new Set<string>() },
    accruals: store,
    accrualTierLaw: opts.law,
    programmeDepth: 'depth' in opts ? opts.depth : 5,
    activity: { recordFeeEvent: async (userId: string) => void active.push(userId) },
  });
  await f.ready();
  return { f, store, active };
}

describe('D26-P1-O2 S2S producer accrue', () => {
  it('maps producer services to fee-pool modules (trade/pay only)', () => {
    expect(AFFILIATE_PRODUCER_SOURCE_BY_SERVICE).toEqual({ 'svc-trade': 'trade', 'svc-pay': 'pay' });
  });

  it(
    'the booted service serves this door (not a second copy)',
    async () => {
      // index.ts as it starts, with the programme depth unset: the door answers its own refusals at its own path.
      const { app: booted } = await bootIdentity({ IDENTITY_PARTNER_PROGRAMME_DEPTH: undefined });
      const unsigned = await booted.inject({ method: 'POST', url: AFFILIATE_PRODUCER_PATH, payload: payload() });
      expect(unsigned.statusCode).toBe(401);
      expect(unsigned.json()).toMatchObject({ code: 'identity.unauthenticated' });

      const body = JSON.stringify(payload());
      const notProducer = await booted.inject({
        method: 'POST',
        url: AFFILIATE_PRODUCER_PATH,
        headers: { ...serviceAuthHeadersForBody('svc-academy', BOOT_INTERNAL_SECRET, body), 'content-type': 'application/json' },
        payload: body,
      });
      expect(notProducer.statusCode).toBe(403);
      expect(notProducer.json()).toMatchObject({ code: 'affiliate.accrual.producer_forbidden' });

      const producer = await booted.inject({
        method: 'POST',
        url: AFFILIATE_PRODUCER_PATH,
        headers: { ...serviceAuthHeadersForBody('svc-trade', BOOT_INTERNAL_SECRET, body), 'content-type': 'application/json' },
        payload: body,
      });
      expect(producer.statusCode).toBe(412);
      expect(producer.json()).toMatchObject({ code: AFFILIATE_PROGRAMME_DEPTH_UNSET });
    },
    BOOT_TIMEOUT_MS,
  );

  it('401 without service credentials — store stays empty', async () => {
    const { f, store } = await app({ law: publishedLaw });
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      payload: payload(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'identity.unauthenticated' });
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    await f.close();
  });

  it('403 when the signed service is not a fee producer', async () => {
    const { f, store } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload());
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-academy', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'affiliate.accrual.producer_forbidden' });
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    await f.close();
  });

  it('403 when sourceModule does not match the producer (no identity default)', async () => {
    const { f, store, active } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload({ sourceModule: 'pay' }));
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'affiliate.accrual.producer_module_mismatch' });
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    // A refused caller records no activity.
    expect(active).toEqual([]);
    await f.close();
  });

  it('412 unpublished law — rates_unset, no rows, yet the fee event still counts as activity for the referral lapse', async () => {
    const { f, store, active } = await app({ law: undefined });
    const body = JSON.stringify(payload());
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.accrual.rates_unset' });
    expect(String(res.json().residual)).toMatch(/DIRECTION §8/);
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    expect(active).toEqual([PAYER]);
    await f.close();
  });

  it('412 blank programme depth (RC-campaigns-07) — refused before the rate law, no rows, published rates or not', async () => {
    for (const law of [publishedLaw, undefined]) {
      const { f, store, active } = await app({ law, depth: undefined });
      const body = JSON.stringify(payload());
      const res = await f.inject({
        method: 'POST',
        url: AFFILIATE_PRODUCER_PATH,
        headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, body), 'content-type': 'application/json' },
        payload: body,
      });
      expect(res.statusCode).toBe(412);
      expect(res.json()).toMatchObject({ code: 'affiliate.programme_depth_unset' });
      expect(await store.listByFeeEvent(FEE)).toEqual([]);
      expect(active).toEqual([PAYER]);
      await f.close();
    }
  });

  it('400 extra keys (tiers) — invent path cannot hide on S2S', async () => {
    const { f, store } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload({ tiers: [{ hop: 0, rate: '0.99' }] }));
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'identity.validation_failed' });
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    await f.close();
  });

  it('401 v1 headers under require — body must be bound', async () => {
    const { f, store } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload());
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeaders('svc-trade', SECRET), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(await store.listByFeeEvent(FEE)).toEqual([]);
    await f.close();
  });

  it('200 published law — durable rows, sourceModule trade, no ledger', async () => {
    const { f, store } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload());
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { inserted: number; rows: Array<{ sourceModule: string; rate: string; commissionAmount: string }> };
    expect(json.inserted).toBe(1);
    expect(json.rows).toHaveLength(1);
    expect(json.rows[0]).toMatchObject({ sourceModule: 'trade', rate: '0.130', commissionAmount: '13' });
    expect(await store.listByFeeEvent(FEE)).toHaveLength(1);
    await f.close();
  });

  it('pay producer accrues sourceModule pay', async () => {
    const { f } = await app({ law: publishedLaw });
    const body = JSON.stringify(payload({ sourceModule: 'pay', feeEventId: 'fee-pay-1' }));
    const res = await f.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-pay', SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].sourceModule).toBe('pay');
    await f.close();
  });
});
