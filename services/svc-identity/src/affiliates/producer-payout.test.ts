import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { MemoryAccrualStore } from './accrual-store.js';
import type { AccrualTierLaw } from './commission-rate-law.js';
import type { CommissionRow } from './commission.js';
import { AFFILIATE_PRODUCER_PAYOUT_PATH, registerAffiliateProducerPayout } from './producer-payout.js';

const SECRET = 'test-internal-service-secret-32ch!!';
const PAYER = '00000000-0000-4000-8000-00000000000a';
const BENE = '00000000-0000-4000-8000-00000000000b';
const FEE = 'fee-evt-producer-payout';
const ASSET = 'USDT';

const PUBLISHED: AccrualTierLaw = { published: true, tiers: [{ hop: 0, rate: '0.10' }] };

const here = dirname(fileURLToPath(import.meta.url));

function row(over: Partial<CommissionRow> = {}): CommissionRow {
  return {
    feeEventId: FEE,
    beneficiaryId: BENE,
    payerId: PAYER,
    hop: 0,
    rate: '0.10',
    feeAmount: '100',
    commissionAmount: '10',
    asset: ASSET,
    accruedAt: new Date('2026-08-16T00:00:00.000Z'),
    sourceModule: 'trade',
    ...over,
  };
}

async function fundedLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({ userId: PAYER, assetId: ASSET, amount: parseAmount('1000'), rail: 'crypto-native', railRef: 'seed-payout' }),
  );
  await ledger.post(
    recipes.feeCharge({
      mode: 'asset',
      chargeId: FEE,
      userId: PAYER,
      module: 'trade',
      assetId: ASSET,
      amount: parseAmount('100'),
    }),
  );
  return ledger;
}

async function bal(ledger: MemoryLedger, ref: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(ref)).amount);
}

async function app(opts: {
  law?: AccrualTierLaw;
  ledger?: MemoryLedger | undefined;
  frozen?: ReadonlySet<string>;
  seed?: boolean;
} = {}) {
  const store = new MemoryAccrualStore();
  if (opts.seed !== false) await store.saveRows([row()]);
  const ledger = 'ledger' in opts ? opts.ledger : await fundedLedger();
  const f = Fastify({ logger: false });
  registerAffiliateProducerPayout(f, {
    internalSecret: SECRET,
    freeze: { frozenIds: async () => opts.frozen ?? new Set<string>() },
    accruals: store,
    accrualTierLaw: opts.law,
    ledger,
  });
  await f.ready();
  return { f, store, ledger };
}

function post(body: unknown, service = 'svc-trade') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: AFFILIATE_PRODUCER_PAYOUT_PATH,
    headers: { ...serviceAuthHeadersForBody(service, SECRET, payload), 'content-type': 'application/json' },
    payload,
  };
}

describe('S2S producer payout — accrued commission through ledger-client', () => {
  it('index.ts registers this door (not a second copy)', () => {
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(src).toMatch(/registerAffiliateProducerPayout/);
    expect(src).toMatch(/producer-payout/);
  });

  it('401 without service credentials — nothing posted', async () => {
    const { f, ledger } = await app({ law: PUBLISHED });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject({ method: 'POST', url: AFFILIATE_PRODUCER_PAYOUT_PATH, payload: { feeEventId: FEE } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'identity.unauthenticated' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('403 when the signed service is not a fee producer', async () => {
    const { f, ledger } = await app({ law: PUBLISHED });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }, 'svc-academy'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.producer_forbidden' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('412 rates unset — nothing posted', async () => {
    const { f, ledger } = await app({ law: undefined });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.rates_unset' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('412 unpublished hop — nothing posted', async () => {
    const law: AccrualTierLaw = { published: true, tiers: [{ hop: 1, rate: '0.05' }] };
    const { f, ledger } = await app({ law });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.rate_unpublished' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('412 beneficiary frozen — nothing posted', async () => {
    const { f, ledger } = await app({ law: PUBLISHED, frozen: new Set([BENE]) });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.beneficiary_frozen' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('412 nothing accrued — refuse rather than a paid zero', async () => {
    const { f, ledger } = await app({ law: PUBLISHED, seed: false });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.nothing_accrued' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('503 ledger unwired — plan never pretends it paid', async () => {
    const { f } = await app({ law: PUBLISHED, ledger: undefined });
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.ledger_unwired' });
    await f.close();
  });

  it('pays accrued commission through ledger-client', async () => {
    const { f, ledger } = await app({ law: PUBLISHED });
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { posted: boolean; totalCommission: string; idempotencyKeys: string[] };
    expect(body.posted).toBe(true);
    expect(body.totalCommission).toBe('10');
    expect(body.idempotencyKeys.some((k) => k.includes(FEE))).toBe(true);
    expect(await bal(ledger!, houseFees('trade', ASSET))).toBe('90');
    expect(await bal(ledger!, userAvailable(BENE, ASSET))).toBe('10');
    expect(ledger!.reconcile()).toEqual({ ok: true });
    await f.close();
  });
});
