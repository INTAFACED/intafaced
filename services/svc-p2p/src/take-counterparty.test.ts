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
import { confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';
import { CounterpartyStateUnavailableError, memoryCounterpartyState } from './counterparty-state.js';

/**
 * #4689: a take against an ad whose maker is frozen, closed or unknown to identity is refused before anything is
 * reserved or locked, on a sell ad (the taker would pay fiat to a seller who must not be paid) and on a buy ad (the
 * taker's coin would be locked for a buyer who must not receive it). An unanswered check refuses too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const SECRET = 'p2p-counterparty-edge-secret-long-enough';

describe('svc-p2p take refuses a maker who may not trade (#4689)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let identity!: ReturnType<typeof memoryCounterpartyState>;
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    identity = memoryCounterpartyState();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const ownerId of [MAKER, TAKER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'EUR',
        label: 'sepa',
        details: { account_reference: `ref-${ownerId.slice(0, 4)}` },
        instrumentId: crypto.randomUUID(),
      });
      await ledger.post(
        recipes.deposit({ userId: ownerId, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${ownerId}:fund` }),
      );
    }
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
      counterpartyState: identity,
    });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function offer(side: 'sell' | 'buy') {
    return p2p.createOffer({
      makerId: MAKER,
      side,
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

  function caller() {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-counterparty');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: TAKER,
      userId: TAKER,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, { takeGate: metTakeGate(), takeStepUp: confirmedTakeStepUp() }).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-counterparty',
      }),
    );
  }

  const take = (offerId: string) => caller().trades.take({ offerId, tradeId: crypto.randomUUID(), amount: '10', method: 'sepa' });

  async function nothingReserved(offerId: string) {
    expect((await p2p.getOffer(offerId)).remainingAmt).toBe(parseAmount('100'));
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    // The ledger saw only the two TEST fundings: no escrow lock was posted.
    expect(ledger.journal()).toHaveLength(2);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  for (const side of ['sell', 'buy'] as const) {
    for (const status of ['frozen', 'closed', 'not_found'] as const) {
      it(`refuses a take on a ${side} ad whose maker is ${status}, with one code, and reserves nothing`, async () => {
        const ad = await offer(side);
        identity.set(MAKER, status);
        await expect(take(ad.id)).rejects.toMatchObject({
          code: 'CONFLICT',
          cause: expect.objectContaining({ code: 'p2p.counterparty_unavailable' }),
        });
        await nothingReserved(ad.id);
        expect(identity.asked).toEqual([MAKER]);
      });
    }
  }

  it('refuses when identity cannot answer, rather than taking the maker as active', async () => {
    const ad = await offer('sell');
    identity.failWith(new CounterpartyStateUnavailableError('identity down'));
    await expect(take(ad.id)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.counterparty_unverifiable' }),
    });
    await nothingReserved(ad.id);
  });

  it('takes an active maker’s ad and escrows once, asking about the maker and never the taker', async () => {
    const ad = await offer('sell');
    const trade = await take(ad.id);
    expect(trade.status).toBe('escrowed');
    expect((await p2p.getOffer(ad.id)).remainingAmt).toBe(parseAmount('90'));
    expect(identity.asked).toEqual([MAKER]);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
