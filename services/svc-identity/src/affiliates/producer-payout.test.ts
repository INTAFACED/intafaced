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
import { registerAffiliateProducerAccrue } from './producer-accrue.js';
import { AFFILIATE_PRODUCER_PAYOUT_PATH, registerAffiliateProducerPayout } from './producer-payout.js';

const SECRET = 'test-internal-service-secret-32ch!!';
const PAYER = '00000000-0000-4000-8000-00000000000a';
const BENE = '00000000-0000-4000-8000-00000000000b';
const FEE = 'fee-evt-producer-payout';
const ASSET = 'USDT';

const PUBLISHED: AccrualTierLaw = { published: true, tiers: [{ hop: 0, rate: '0.130' }] };

const here = dirname(fileURLToPath(import.meta.url));

function row(over: Partial<CommissionRow> = {}): CommissionRow {
  return {
    feeEventId: FEE,
    beneficiaryId: BENE,
    payerId: PAYER,
    hop: 0,
    rate: '0.130',
    feeAmount: '100',
    commissionAmount: '13',
    asset: ASSET,
    accruedAt: new Date('2026-08-16T00:00:00.000Z'),
    sourceModule: 'trade',
    ...over,
  };
}

async function fundedLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: PAYER,
      assetId: ASSET,
      amount: parseAmount('1000'),
      rail: 'crypto-native',
      railRef: 'seed-payout',
    }),
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

function accountsOf(statuses: Record<string, 'active' | 'frozen' | 'closed' | null> = {}) {
  return {
    accountState: async (userId: string) => {
      const status = userId in statuses ? statuses[userId]! : 'active';
      return status === null ? null : { userId, status, kycTier: 'basic' as const, archived: false };
    },
  };
}

async function app(
  opts: {
    law?: AccrualTierLaw;
    ledger?: MemoryLedger | undefined;
    frozen?: ReadonlySet<string>;
    /** Account status per user; anyone unlisted is active. `null` is an unknown user. */
    accounts?: Record<string, 'active' | 'frozen' | 'closed' | null>;
    seed?: boolean;
    depth?: number | undefined;
  } = {},
) {
  const store = new MemoryAccrualStore();
  if (opts.seed !== false) await store.saveRows([row()]);
  const ledger = 'ledger' in opts ? opts.ledger : await fundedLedger();
  const f = Fastify({ logger: false });
  registerAffiliateProducerPayout(f, {
    internalSecret: SECRET,
    freeze: { frozenIds: async () => opts.frozen ?? new Set<string>() },
    accounts: accountsOf(opts.accounts),
    accruals: store,
    accrualTierLaw: opts.law,
    programmeDepth: 'depth' in opts ? opts.depth : 5,
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
    expect(src).toMatch(/installRawBody:\s*false/);
  });

  it('co-mounts with accrue without a second JSON parser (identity boot)', async () => {
    const store = new MemoryAccrualStore();
    const f = Fastify({ logger: false });
    registerAffiliateProducerAccrue(f, {
      internalSecret: SECRET,
      referral: { loadParentMap: async () => new Map() },
      freeze: { frozenIds: async () => new Set<string>() },
      accruals: store,
      accrualTierLaw: PUBLISHED,
      programmeDepth: 5,
    });
    registerAffiliateProducerPayout(f, {
      internalSecret: SECRET,
      freeze: { frozenIds: async () => new Set<string>() },
      accounts: accountsOf(),
      accruals: store,
      accrualTierLaw: PUBLISHED,
      programmeDepth: 5,
      ledger: undefined,
      installRawBody: false,
    });
    await f.ready();
    await f.close();
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

  it('412 blank programme depth (RC-campaigns-07) — nothing posted, even with published rates', async () => {
    const { f, ledger } = await app({ law: PUBLISHED, depth: undefined });
    const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.programme_depth_unset' });
    expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
    await f.close();
  });

  it('412 unpublished hop — nothing posted', async () => {
    const law: AccrualTierLaw = { published: true, tiers: [{ hop: 1, rate: '0.07' }] };
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

  // #4689: the programme's freeze is not the account's. A frozen, closed or unknown account takes no credit.
  for (const status of ['frozen', 'closed', null] as const) {
    it(`412 beneficiary account ${status ?? 'unknown'} — nothing posted, no balance moves`, async () => {
      const { f, ledger } = await app({ law: PUBLISHED, accounts: { [BENE]: status } });
      const journalBefore = ledger!.journal().map((tx) => tx.idempotencyKey);
      const beneBefore = await bal(ledger!, userAvailable(BENE, ASSET));
      const feesBefore = await bal(ledger!, houseFees('trade', ASSET));
      const res = await f.inject(post({ feeEventId: FEE }));
      expect(res.statusCode).toBe(412);
      expect(res.json()).toMatchObject({ code: 'affiliate.payout.beneficiary_cannot_receive' });
      expect(ledger!.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await bal(ledger!, userAvailable(BENE, ASSET))).toBe(beneBefore);
      expect(await bal(ledger!, houseFees('trade', ASSET))).toBe(feesBefore);
      await f.close();
    });
  }

  it('an active beneficiary is still paid once the account check passes', async () => {
    const { f, ledger } = await app({ law: PUBLISHED, accounts: { [BENE]: 'active' } });
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(200);
    expect(await bal(ledger!, userAvailable(BENE, ASSET))).toBe('13');
    await f.close();
  });

  it('412 tampered commissionAmount — nothing posted', async () => {
    const store = new MemoryAccrualStore();
    await store.saveRows([row({ commissionAmount: '99' })]);
    const ledger = await fundedLedger();
    const f = Fastify({ logger: false });
    registerAffiliateProducerPayout(f, {
      internalSecret: SECRET,
      freeze: { frozenIds: async () => new Set<string>() },
      accounts: accountsOf(),
      accruals: store,
      accrualTierLaw: PUBLISHED,
      programmeDepth: 5,
      ledger,
    });
    await f.ready();
    const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);
    const res = await f.inject(post({ feeEventId: FEE }));
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'affiliate.payout.commission_mismatch' });
    expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
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
    expect(body.totalCommission).toBe('13');
    expect(body.idempotencyKeys.some((k) => k.includes(FEE))).toBe(true);
    expect(await bal(ledger!, houseFees('trade', ASSET))).toBe('87');
    expect(await bal(ledger!, userAvailable(BENE, ASSET))).toBe('13');
    expect(ledger!.reconcile()).toEqual({ ok: true });
    await f.close();
  });
});
