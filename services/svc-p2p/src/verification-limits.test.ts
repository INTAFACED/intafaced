import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';
import { parseVerificationLimits, type VerificationLimitConfig } from './verification-limits.js';

/**
 * P-disputes-security-15: verification-level buy caps, and a sell lock that
 * refuses when the owner publishes a duration identity cannot time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';

const row = (orderMin: string, orderMax: string, dailyMax: string, lifetimeMax: string) => ({
  orderMin,
  orderMax,
  dailyMax,
  lifetimeMax,
});

function limits(basic: ReturnType<typeof row>, currency = 'USD'): VerificationLimitConfig {
  const wide = row('0', '1000', '1000', '1000');
  return parseVerificationLimits({
    currency,
    tiers: { none: wide, basic, full: wide, institutional: wide },
  });
}

describe('svc-p2p verification limits and security-change sell lock (P-disputes-security-15)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    for (const methodId of ['sepa']) {
      await instruments.registerMethodSchema({
        methodId,
        country: ANY_COUNTRY,
        label: 'Test rail',
        fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
      });
    }
    for (const ownerId of [MAKER, TAKER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'sepa',
        details: { account_reference: `ref-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function service(options: { verificationLimits?: VerificationLimitConfig; securityChangeLockSeconds?: number | null } = {}) {
    return new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      verificationLimits: options.verificationLimits,
      securityChangeLockSeconds: options.securityChangeLockSeconds,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  async function sell(p2p: P2pService, fiatCurrency = 'USD') {
    return p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency,
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'pay the named amount',
    });
  }

  const SECRET = 'p2p-limits-edge-secret-long-enough';
  function caller(p2p: P2pService, userId: string) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-limits');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: userId,
      userId,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-limits',
      }),
    );
  }

  it('leaves takes alone and refuses the reads when the owner has published nothing', async () => {
    const p2p = service();
    await fund(MAKER, '100');
    const offer = await sell(p2p);
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    expect(trade.status).toBe('escrowed');
    await expect(caller(p2p, TAKER).limits.verification()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.verification_limits_unset' }),
    });
    await expect(caller(p2p, TAKER).limits.securityChange()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.security_change_lock_unset' }),
    });
  });

  it('refuses a buy past the tier cap and reports remaining from the same trades', async () => {
    const p2p = service({ verificationLimits: limits(row('0', '25', '30', '40')) });
    await fund(MAKER, '100');
    const offer = await sell(p2p);
    const first = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
      tier: 'basic',
    });
    expect(first.fiatAmount).toBe(parseAmount('20'));
    await expect(
      p2p.quoteTake({ offerId: offer.id, takerId: TAKER, amount: parseAmount('15'), method: 'sepa', tier: 'basic' }),
    ).rejects.toMatchObject({ code: 'p2p.verification_daily_limit' });
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('21'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        tier: 'basic',
      }),
    ).rejects.toMatchObject({ code: 'p2p.verification_daily_limit' });
    const allowance = await caller(p2p, TAKER).limits.verification();
    expect(allowance).toMatchObject({
      tier: 'basic',
      currency: 'USD',
      orderMax: '25',
      dailyMax: '30',
      lifetimeMax: '40',
      dailyUsed: '20',
      lifetimeUsed: '20',
      dailyRemaining: '10',
      lifetimeRemaining: '20',
    });
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'p2p.verification_level_unwired' });
  });

  it('does not convert a buy in another fiat into the limit currency', async () => {
    const p2p = service({ verificationLimits: limits(row('0', '1000', '1000', '1000')) });
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa-eur',
      details: { account_reference: 'ref-eur' },
      instrumentId: crypto.randomUUID(),
    });
    await fund(MAKER, '100');
    const offer = await sell(p2p, 'EUR');
    await expect(
      p2p.quoteTake({ offerId: offer.id, takerId: TAKER, amount: parseAmount('10'), method: 'sepa', tier: 'basic' }),
    ).rejects.toMatchObject({ code: 'p2p.verification_limit_currency' });
  });

  it('refuses a broken table instead of ignoring it', async () => {
    const p2p = service({ verificationLimits: parseVerificationLimits('{"currency":"USD"}') });
    await fund(MAKER, '100');
    const offer = await sell(p2p);
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        tier: 'basic',
      }),
    ).rejects.toMatchObject({ code: 'p2p.verification_limits_invalid' });
  });

  it('refuses a new sell when a lock duration is published and identity has no change time', async () => {
    const p2p = service({ securityChangeLockSeconds: 86_400 });
    await expect(
      p2p.createOffer({
        makerId: MAKER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: parseAmount('1'),
        minAmt: parseAmount('1'),
        maxAmt: parseAmount('10'),
        totalAmt: parseAmount('10'),
        methods: ['sepa'],
      }),
    ).rejects.toMatchObject({ code: 'p2p.security_change_lock_unwired' });
    const buy = await p2p.createOffer({
      makerId: MAKER,
      side: 'buy',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('10'),
      totalAmt: parseAmount('10'),
      methods: ['sepa'],
    });
    await fund(TAKER, '20');
    await expect(
      p2p.takeOffer({
        offerId: buy.id,
        takerId: TAKER,
        amount: parseAmount('5'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        tier: 'basic',
      }),
    ).rejects.toMatchObject({ code: 'p2p.security_change_lock_unwired' });
    expect(() => p2p.securityChangeLock()).toThrow(expect.objectContaining({ code: 'p2p.security_change_lock_unwired' }));
    const zero = service({ securityChangeLockSeconds: 0 });
    expect(() => zero.securityChangeLock()).toThrow(expect.objectContaining({ code: 'p2p.invalid_security_change_lock' }));
  });
});
