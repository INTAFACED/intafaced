import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type Context } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';
import { createTakeGate, type ContactReader, type TakeGate } from './take-eligibility.js';
import { confirmedTakeStepUp } from './take-gate-fixture.js';

/**
 * P-trade-orders-02: a take is refused by an unmet requirement (confirmed
 * contact) before anything is reserved or locked, and the eligibility list says
 * the same thing. No risk notice gates a take (owner decision 2026-10-27).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const SECRET = 'p2p-eligibility-edge-secret-long-enough';

describe('svc-p2p take eligibility (P-trade-orders-02)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-maker' },
      instrumentId: crypto.randomUUID(),
    });
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function sellOffer() {
    return p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });
  }

  /** A contact reader that answers `confirmed` and records the principal it was asked under. */
  function contact(confirmed: boolean | 'down') {
    const seen: Array<Context['forwardedPrincipal']> = [];
    const reader: ContactReader = {
      async emailConfirmed(ctx) {
        seen.push(ctx.forwardedPrincipal);
        if (confirmed === 'down') {
          const { TakeGateError } = await import('./take-eligibility.js');
          throw new TakeGateError('p2p.contact_unverifiable: identity down', 'p2p.contact_unverifiable');
        }
        return confirmed;
      },
    };
    return { reader, seen };
  }

  function gate(reader: ContactReader): TakeGate {
    return createTakeGate({ contact: reader });
  }

  function caller(takeGate: TakeGate | undefined, options: { tier?: Principal['tier']; kid?: string } = {}) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-eligibility');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: TAKER,
      userId: TAKER,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read', 'p2p:write'],
      tier: options.tier ?? 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
      ...(options.kid ? { kid: options.kid } : {}),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, takeGate ? { takeGate, takeStepUp: confirmedTakeStepUp() } : {}).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-eligibility',
      }),
    );
  }

  const take = (c: ReturnType<typeof caller>, offerId: string) =>
    c.trades.take({ offerId, tradeId: crypto.randomUUID(), amount: '10', method: 'sepa' });

  async function nothingReserved(offerId: string) {
    expect((await p2p.getOffer(offerId)).remainingAmt).toBe(parseAmount('100'));
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    // The ledger saw only the TEST funding: no escrow lock was posted.
    expect(ledger.journal()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  it('lists every requirement in order and names the fix for the ones not met', async () => {
    const { reader } = contact(false);
    const out = await caller(gate(reader), { tier: 'none' }).access.eligibility();
    expect(out.canTake).toBe(false);
    expect(out.checks.map((c) => [c.id, c.state, c.reason, c.fix])).toEqual([
      ['verification', 'not_met', 'denied.kyc_required', '/verification'],
      ['contact', 'not_met', 'p2p.contact_required', '/uc/account'],
      ['jurisdiction', 'met', 'region.allowed', null],
      ['deposit', 'met', 'deposit.none_for_takers', null],
    ]);
  });

  it('refuses a take without a confirmed email as p2p.contact_required, and nothing is reserved', async () => {
    const offer = await sellOffer();
    const { reader, seen } = contact(false);
    await expect(take(caller(gate(reader)), offer.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'p2p.contact_required' }),
    });
    await nothingReserved(offer.id);
    // Asked as the person of this request: the edge-signed principal, byte for byte.
    expect(seen[0]?.raw).toBeTruthy();
    expect(seen[0]?.region).toBe('DE');
  });

  it('refuses when identity cannot answer, rather than taking the address as confirmed', async () => {
    const offer = await sellOffer();
    const { reader } = contact('down');
    const c = caller(gate(reader));
    await expect(take(c, offer.id)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.contact_unverifiable' }),
    });
    await nothingReserved(offer.id);
    const contactCheck = (await c.access.eligibility()).checks.find((check) => check.id === 'contact');
    expect(contactCheck).toMatchObject({ state: 'unknown', reason: 'p2p.contact_unverifiable', fix: null });
  });

  it('takes with confirmed contact and no risk notice to accept, and escrows once (owner decision 2026-10-27)', async () => {
    const offer = await sellOffer();
    const c = caller(gate(contact(true).reader));
    const eligibility = await c.access.eligibility();
    expect(eligibility.canTake).toBe(true);
    expect(eligibility.checks.map((check) => check.id)).not.toContain('risk');
    expect(eligibility).not.toHaveProperty('notice');

    const trade = await take(c, offer.id);
    expect(trade.status).toBe('escrowed');
    expect((await p2p.getOffer(offer.id)).remainingAmt).toBe(parseAmount('90'));
    // Nothing was asked or stored about a risk notice.
    expect(await sql`SELECT user_id FROM p2p.risk_acceptances`).toHaveLength(0);
  });

  it('with no gate installed every take refuses instead of skipping the checks', async () => {
    const offer = await sellOffer();
    await expect(take(caller(undefined), offer.id)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.take_gate_unwired' }),
    });
    await nothingReserved(offer.id);
  });
});
