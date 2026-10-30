import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { P2pService } from './p2p-service.js';
import { InstrumentService, maskedValue } from './instrument-service.js';
import { ANY_COUNTRY, InstrumentError, methodIdKey } from './instruments.js';
import { createP2pRouter } from './router.js';
import { P2pErasure } from './erasure.js';
import { BlockRfqService } from './block-rfq.js';
import { MemoryBlockQuoteStore } from './block-rfq-store.js';
import { confirmedInstrumentStepUp, confirmedReleaseStepUp, confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';

// Attributed local screening fixture: exercise downstream authorization and storage.
// Explicit dev mode accepts this fixture; it is never a production sanctions list.
beforeEach(() => {
  vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
  vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-recovery');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
});
afterEach(() => vi.unstubAllEnvs());

/**
 * PAYMENT INSTRUMENTS — disclosure, refusal, and the record of both.
 *
 * Postgres is real, because every property this file asserts is enforced in
 * SQL: the reveal is one statement that cannot read without logging, the log is
 * append-only by trigger, and the "one active destination per slot" rule is a
 * partial unique index. A mocked database would assert the shape of the code
 * rather than the behaviour of the system.
 *
 * The tests are driven through the **tRPC router with real signed edge
 * principals**, not by calling the service directly, wherever the question is
 * "can this person see it". Authorisation that is only ever tested one layer
 * below the door is authorisation nobody has checked the door for.
 *
 * The standing device is a CANARY: the seller's account details contain a
 * string that appears nowhere else in the system. "It does not leak" is then a
 * mechanical question — call everything, scan every response.
 *
 * Public `offers.create` still named-refuses until OWNER KMS (Q-p2p). This
 * file drives `P2pService` directly for board/take paths. Fixture rails here
 * are not a live method registry.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `p2p.*` SQL stays on `p2p`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const MODERATOR = '44444444-4444-4444-8444-444444444444';

const ASSET = 'USDT';
const METHOD = 'test-transfer';

/**
 * The value that must never appear anywhere it is not explicitly allowed.
 *
 * Deliberately not a plausible account number: if this string turns up in a
 * response, a log or an event payload, there is exactly one way it got there.
 */
const CANARY = 'CANARY-a1b2c3d4-do-not-disclose';

const EDGE_SECRET = 'a-p2p-instrument-test-edge-secret-long-enough';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-p2p payment instruments is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p payment instruments PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-p2p payment instruments', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-p2p' });

  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let p2p: P2pService;
  let api: ReturnType<typeof createP2pRouter>;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
    instruments = new InstrumentService(sql);
  }, 120_000);

  /** A principal the edge really vouched for, for a given user. */
  function callerFor(userId: string, scopes: string[] = ['p2p:read', 'p2p:write']) {
    const principal = {
      sub: userId,
      userId,
      sid: '99999999-9999-4999-8999-999999999999',
      scopes,
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as Principal;

    const raw = encodePrincipal(principal);
    return api.createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${userId}`,
      }),
    );
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  /**
   * The operator's registry entry.
   *
   * A FIXTURE, not a claim about any real payment scheme. The registry ships
   * empty precisely because what a market's rails require is not this repo's
   * knowledge to invent, so the fields here are deliberately generic.
   */
  async function registerMethod(overrides: Partial<Parameters<InstrumentService['registerMethodSchema']>[0]> = {}) {
    return instruments.registerMethodSchema({
      methodId: METHOD,
      country: ANY_COUNTRY,
      label: 'Test transfer',
      fields: [
        { key: 'account_reference', label: 'Account reference', required: true },
        { key: 'holder_name', label: 'Account holder', required: true, maxLength: 80 },
        { key: 'note', label: 'Reference note', required: false },
      ],
      ...overrides,
    });
  }

  async function sellerInstrument(
    overrides: { fiatCurrency?: string; ownerId?: string; details?: Record<string, string>; instrumentId?: string } = {},
  ) {
    return instruments.createInstrument({
      ownerId: overrides.ownerId ?? SELLER,
      methodId: METHOD,
      country: 'DE',
      fiatCurrency: overrides.fiatCurrency ?? 'USD',
      label: 'Main account',
      details: overrides.details ?? { account_reference: CANARY, holder_name: 'A Seller' },
      instrumentId: overrides.instrumentId ?? crypto.randomUUID(),
    });
  }

  /** A funded seller, an offer, and a taken trade sitting in `escrowed`. */
  async function liveTrade(amount = '100') {
    await fund(SELLER, '1000');
    const offer = await p2p.createOffer({
      makerId: SELLER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('500'),
      totalAmt: amt('500'),
      methods: [METHOD],
    });
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: BUYER,
      amount: amt(amount),
      method: METHOD,
      tradeId: crypto.randomUUID(),
    });
    return { offer, trade };
  }

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    p2p = new P2pService(sql, ledger, bus, {
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
    // The erasure collaborator is wired in so the leak sweep below actually
    // CALLS `data.export` rather than getting a NOT_IMPLEMENTED that would pass
    // the scan while proving nothing about it. Same for block/RFQ: unwired
    // quote/accept would PRECONDITION_FAILED and never scan a quote payload.
    api = createP2pRouter(p2p, instruments, new P2pErasure(sql), {
      blockRfq: new BlockRfqService(new MemoryBlockQuoteStore()),
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
      releaseStepUp: confirmedReleaseStepUp(),
      instrumentStepUp: confirmedInstrumentStepUp(),
      // The router saves a destination only with the instrument key on; this suite's service stores them plainly.
      instrumentKeyProvider: 'local-test',
    });
    await registerMethod();
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── P-ads-merchant-18: the own-name rule, and P-trade-orders-03: the format hint ──

  describe('the own-name rule and the format hint (J-p2p-04 #2)', () => {
    const OWN = 'own-name-transfer';
    /** Identity's answer, faked: only SELLER's verified name is "A Seller"; STRANGER has none. */
    const holderNames = {
      calls: [] as Array<{ userId: string; name: string }>,
      async assertOwnName(userId: string, name: string) {
        holderNames.calls.push({ userId, name });
        if (userId === STRANGER) throw new InstrumentError('no verified name', 'p2p.holder_name_unverified');
        if (name !== 'A Seller') throw new InstrumentError('not your name', 'p2p.holder_name_mismatch');
      },
    };
    let ruled!: InstrumentService;

    beforeEach(async () => {
      holderNames.calls.length = 0;
      ruled = new InstrumentService(sql, { holderNames });
      await ruled.registerMethodSchema({
        methodId: OWN,
        country: 'DE',
        label: 'Own-name transfer',
        fields: [
          { key: 'account_holder', label: 'Account holder', required: true, maxLength: 120, holderName: true },
          {
            key: 'iban',
            label: 'IBAN',
            required: true,
            pattern: '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}',
            help: 'Two letters, two digits, then 11 to 30 letters or digits, no spaces',
          },
        ],
      });
    });

    const add = (service: InstrumentService, ownerId: string, details: Record<string, string>) =>
      service.createInstrument({
        ownerId,
        methodId: OWN,
        country: 'DE',
        fiatCurrency: 'EUR',
        label: 'Own account',
        details,
        instrumentId: crypto.randomUUID(),
      });
    const stored = async (ownerId: string) =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM p2p.payment_instruments WHERE owner_id = ${ownerId}`)[0]!.n;

    it('keeps the holder-name field on the schema, and refuses a second one or an optional one', async () => {
      const [schema] = await ruled.listMethodSchemas({ methodId: OWN, limit: 10 });
      expect(schema!.fields.find((field) => field.key === 'account_holder')).toMatchObject({ holderName: true });
      expect(schema!.fields.find((field) => field.key === 'iban')).not.toHaveProperty('holderName');
      const two = [
        { key: 'a', label: 'A', required: true, maxLength: 120, holderName: true },
        { key: 'b', label: 'B', required: true, maxLength: 120, holderName: true },
      ];
      await expect(ruled.registerMethodSchema({ methodId: 'two-holders', country: 'DE', label: 'Two', fields: two })).rejects.toMatchObject(
        {
          code: 'p2p.instrument_schema_invalid',
        },
      );
      // Identity holds a legal name of at most 200 characters: a holder field must not take more.
      for (const bounds of [{}, { maxLength: 201 }]) {
        await expect(
          ruled.registerMethodSchema({
            methodId: 'long-holder',
            country: 'DE',
            label: 'Long',
            fields: [{ key: 'a', label: 'A', required: true, holderName: true, ...bounds }],
          }),
        ).rejects.toMatchObject({ code: 'p2p.instrument_schema_invalid', message: expect.stringContaining('maxLength') });
      }
      const optional = [{ key: 'a', label: 'A', required: false, maxLength: 120, holderName: true }];
      await expect(
        ruled.registerMethodSchema({ methodId: 'optional-holder', country: 'DE', label: 'Opt', fields: optional }),
      ).rejects.toMatchObject({
        code: 'p2p.instrument_schema_invalid',
      });
    });

    it('stores a destination in the verified name, and refuses another name or no verified name with nothing stored', async () => {
      await expect(add(ruled, SELLER, { account_holder: 'Someone Else', iban: 'DE89370400440532013000' })).rejects.toMatchObject({
        code: 'p2p.holder_name_mismatch',
      });
      expect(await stored(SELLER)).toBe(0);
      await expect(add(ruled, STRANGER, { account_holder: 'A Seller', iban: 'DE89370400440532013000' })).rejects.toMatchObject({
        code: 'p2p.holder_name_unverified',
      });
      expect(await stored(STRANGER)).toBe(0);
      // Identity is asked with the name as validated (trimmed) and the owner, never anyone else's id.
      const saved = await add(ruled, SELLER, { account_holder: '  A Seller ', iban: 'DE89370400440532013000' });
      expect(saved.status).toBe('active');
      expect(holderNames.calls.at(-1)).toEqual({ userId: SELLER, name: 'A Seller' });

      // An edit of the details is checked again; a refused edit leaves the destination as it was.
      await expect(
        ruled.updateInstrument({
          instrumentId: saved.id,
          ownerId: SELLER,
          details: { account_holder: 'Someone Else', iban: 'DE89370400440532013000' },
        }),
      ).rejects.toMatchObject({ code: 'p2p.holder_name_mismatch' });
      expect((await ruled.revealOwn({ instrumentId: saved.id, viewerId: SELLER })).details).toMatchObject({ account_holder: 'A Seller' });
      // The masked view (J-p2p-04 #3): the holder whole, the IBAN by its last four only, and logged like any read.
      const before = (await ruled.accessLogFor(SELLER, 100)).length;
      expect((await ruled.revealOwnMasked({ instrumentId: saved.id, viewerId: SELLER })).details).toEqual({
        account_holder: 'A Seller',
        iban: '•••• 3000',
      });
      expect(await ruled.accessLogFor(SELLER, 100)).toHaveLength(before + 1);
      // Someone else's id is refused and logged as denied, as for the whole values.
      await expect(ruled.revealOwnMasked({ instrumentId: saved.id, viewerId: STRANGER })).rejects.toThrow();
      // A label-only edit has no name to check.
      const calls = holderNames.calls.length;
      await ruled.updateInstrument({ instrumentId: saved.id, ownerId: SELLER, label: 'Renamed' });
      expect(holderNames.calls.length).toBe(calls);
    });

    it('refuses every holder-named destination when identity is not wired, and leaves methods without one alone', async () => {
      await expect(add(instruments, SELLER, { account_holder: 'A Seller', iban: 'DE89370400440532013000' })).rejects.toMatchObject({
        code: 'p2p.holder_name_unverifiable',
      });
      expect(await stored(SELLER)).toBe(0);
      // The fixture method declares no holder-name field: nothing to check.
      expect((await sellerInstrument()).status).toBe('active');
    });

    it('refuses a badly formatted account with the format hint, naming the field and never the value, before identity is asked', async () => {
      const refused = await add(ruled, SELLER, { account_holder: 'A Seller', iban: 'DE89 3704 0044' }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(InstrumentError);
      expect(refused).toMatchObject({ code: 'p2p.account_format_invalid', field: 'iban', limit: { until: null, field: 'iban' } });
      expect((refused as Error).message).toBe(
        '"IBAN" is not in the expected format: Two letters, two digits, then 11 to 30 letters or digits, no spaces',
      );
      expect((refused as Error).message).not.toContain('3704');
      expect(holderNames.calls).toEqual([]);
      expect(await stored(SELLER)).toBe(0);
    });
  });

  // ── The registry: we do not invent a market's requirements ─────────────────

  describe('the method registry', () => {
    it('ships empty, so an unregistered market refuses rather than guesses', async () => {
      await sql`TRUNCATE p2p.payment_method_schemas CASCADE`;
      expect(await instruments.enabledMethodKeys()).toEqual(new Set());

      // PIN: an empty catalogue must refuse, not return []. [] is how a
      // seller/register/pay door still looks like a live rail with zero methods.
      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toMatchObject({
        code: 'p2p.instrument_method_unknown',
      });
      await expect(callerFor(SELLER).instruments.methods.list({ limit: 50 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(sellerInstrument()).rejects.toMatchObject({
        code: 'p2p.instrument_method_unknown',
        message: 'p2p.instrument_method_unknown',
      });
      await expect(
        callerFor(SELLER).instruments.create({
          instrumentId: crypto.randomUUID(),
          methodId: METHOD,
          country: 'DE',
          fiatCurrency: 'USD',
          details: { account_reference: CANARY, holder_name: 'A Seller' },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('PIN: empty registry refuses list/register/pay with a stable code, not a fake account', async () => {
      await sql`TRUNCATE p2p.payment_method_schemas CASCADE`;

      const unknown = { code: 'p2p.instrument_method_unknown' as const };

      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toMatchObject(unknown);
      await expect(sellerInstrument()).rejects.toMatchObject(unknown);
      await expect(
        p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD],
        }),
      ).rejects.toMatchObject(unknown);
      await expect(
        p2p.createOffer({
          makerId: BUYER,
          side: 'buy',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD],
        }),
      ).rejects.toMatchObject(unknown);

      // Pay disclosure with no trade is NOT_FOUND (oracle-closed), never a
      // destination. Operator register is the one door that must still work —
      // that is how the empty registry becomes a real rail.
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: crypto.randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        instruments.registerMethodSchema({
          methodId: METHOD,
          country: ANY_COUNTRY,
          label: 'Test transfer',
          fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
        }),
      ).resolves.toMatchObject({ methodId: METHOD });
    });

    it('RED: an empty registry is not a live payable rail', async () => {
      await sql`TRUNCATE p2p.payment_method_schemas CASCADE`;

      // `offer_method_no_destination` would mean "this rail exists; add a
      // destination." That sentence is how an empty registry looks payable.
      await expect(
        p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD],
        }),
      ).rejects.toMatchObject({ code: 'p2p.instrument_method_unknown' });

      // Buy offers used to skip every method check, so the board could advertise
      // whatever string the maker typed as if it were a rail.
      const buy = p2p.createOffer({
        makerId: BUYER,
        side: 'buy',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });
      await expect(buy).rejects.toMatchObject({ code: 'p2p.instrument_method_unknown' });

      expect(await p2p.listOffers({ limit: 50 })).toEqual([]);
    });

    it('a leftover destination is not payable once the operator registry is empty', async () => {
      const created = await sellerInstrument();
      await fund(SELLER, '1000');
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });

      await sql`TRUNCATE p2p.payment_method_schemas CASCADE`;

      expect(await instruments.liveMethodKeys(SELLER, 'USD')).toEqual(new Set());
      expect(await instruments.enabledMethodKeys()).toEqual(new Set());
      expect(created.status).toBe('active');

      // #1858 closed create/board. Take still used `loadOfferRaw` + attach on
      // any active dest, so a leftover row after the operator emptied the
      // registry still locked escrow. The dest is still there; it is not a rail.
      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: METHOD, tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.take_refused',
      });

      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log.some((e) => e.outcome === 'denied' && e.denyReason === 'take_refused')).toBe(true);
    });

    it('a leftover destination is not payable after the operator disables the schema', async () => {
      await sellerInstrument();
      await fund(SELLER, '1000');
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });

      await instruments.setMethodSchemaEnabled(METHOD, ANY_COUNTRY, false, 'provider_withdrawn');

      // Retired everywhere, so the take names the retirement and its reason (P-trade-orders-03) instead of the
      // uniform refusal; nothing is reserved either way.
      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: METHOD, tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.method_delisted',
        limit: { until: null, reason: 'provider_withdrawn' },
      });
      expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    });

    it('omitting enabled on a label or field replace leaves a disabled method schema disabled', async () => {
      await instruments.setMethodSchemaEnabled(METHOD, ANY_COUNTRY, false, 'low_demand');
      const disabled = { code: 'p2p.instrument_method_disabled' as const };
      await expect(sellerInstrument()).rejects.toMatchObject(disabled);

      const relabeled = await registerMethod({ label: 'Renamed test transfer' });
      expect(relabeled).toMatchObject({ enabled: false, label: 'Renamed test transfer' });
      await expect(sellerInstrument()).rejects.toMatchObject(disabled);

      const refielded = await registerMethod({
        label: 'Renamed test transfer',
        fields: [
          { key: 'account_reference', label: 'Account reference', required: true },
          { key: 'holder_name', label: 'Account holder', required: true, maxLength: 80 },
          { key: 'note', label: 'Payment note', required: false },
        ],
      });
      expect(refielded.enabled).toBe(false);
      expect(refielded.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'note', label: 'Payment note' })]));
      await expect(sellerInstrument()).rejects.toMatchObject(disabled);

      const forcedOn = await registerMethod({ enabled: true, label: 'Renamed test transfer' });
      expect(forcedOn.enabled).toBe(true);
      await expect(sellerInstrument({ ownerId: BUYER })).resolves.toMatchObject({ methodId: METHOD });

      // A live method is switched off only with a retirement reason, so a register cannot do it (P-trade-orders-03).
      await expect(registerMethod({ enabled: false, label: 'Renamed test transfer' })).rejects.toMatchObject({
        code: 'p2p.delist_reason_required',
      });
      const forcedOff = await instruments.setMethodSchemaEnabled(METHOD, ANY_COUNTRY, false, 'regulation');
      expect(forcedOff.enabled).toBe(false);
      await expect(sellerInstrument()).rejects.toMatchObject(disabled);

      await instruments.setMethodSchemaEnabled(METHOD, ANY_COUNTRY, true);
      await expect(sellerInstrument()).resolves.toMatchObject({ methodId: METHOD });
    });

    it('rejects a field the operator never declared instead of dropping it', async () => {
      // Silently ignoring unknown keys would let a client push arbitrary
      // personal data into a blob nobody designed, nobody validates, and
      // everybody then has to protect and eventually delete.
      await expect(
        sellerInstrument({ details: { account_reference: 'x', holder_name: 'y', national_id: '123456' } }),
      ).rejects.toMatchObject({ code: 'p2p.instrument_field_undeclared', field: 'national_id' });
    });

    it('rejects a required field that is present but blank', async () => {
      await expect(sellerInstrument({ details: { account_reference: '   ', holder_name: 'y' } })).rejects.toMatchObject({
        code: 'p2p.instrument_field_missing',
        field: 'account_reference',
      });
    });

    it('lets an exact country override the wildcard, and does not fall back past it', async () => {
      await registerMethod({
        country: 'NG',
        label: 'Test transfer (NG)',
        fields: [{ key: 'wallet_handle', label: 'Handle', required: true }],
      });

      // The NG entry says "this market is different". Falling back to the
      // generic field list here would accept a destination that market cannot
      // actually receive at.
      await expect(
        instruments.createInstrument({
          ownerId: SELLER,
          methodId: METHOD,
          country: 'NG',
          fiatCurrency: 'NGN',
          details: { account_reference: 'x', holder_name: 'y' },
          instrumentId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'p2p.instrument_field_undeclared' });

      const ok = await instruments.createInstrument({
        ownerId: SELLER,
        methodId: METHOD,
        country: 'NG',
        fiatCurrency: 'NGN',
        details: { wallet_handle: 'h' },
        instrumentId: crypto.randomUUID(),
      });
      expect(ok.country).toBe('NG');
    });

    it('refuses a second active destination for the same method and currency', async () => {
      await sellerInstrument();
      // One answer to "which account does the buyer pay?", by construction. A
      // lookup that could return two rows would pick one by an ordering nobody
      // designed, on the one field where the wrong choice sends a stranger's
      // money to the wrong bank.
      await expect(sellerInstrument({ details: { account_reference: 'other', holder_name: 'A Seller' } })).rejects.toMatchObject({
        code: 'p2p.instrument_slot_taken',
      });

      const first = (await instruments.listInstruments(SELLER, false, 200))[0]!;
      await instruments.removeInstrument({ instrumentId: first.id, ownerId: SELLER });
      // Rotation is sequential, and it works.
      await expect(sellerInstrument({ details: { account_reference: 'other', holder_name: 'A Seller' } })).resolves.toMatchObject({
        status: 'active',
      });
    });

    it('refuses omit so a retried add cannot mint a second instrument', async () => {
      await expect(
        instruments.createInstrument({
          ownerId: SELLER,
          methodId: METHOD,
          country: 'DE',
          fiatCurrency: 'USD',
          details: { account_reference: CANARY, holder_name: 'A Seller' },
        } as Parameters<InstrumentService['createInstrument']>[0]),
      ).rejects.toMatchObject({ code: 'p2p.instrument_id_required' });

      await expect(
        instruments.createInstrument({
          ownerId: SELLER,
          methodId: METHOD,
          country: 'DE',
          fiatCurrency: 'USD',
          details: { account_reference: CANARY, holder_name: 'A Seller' },
          instrumentId: '   ',
        }),
      ).rejects.toMatchObject({ code: 'p2p.instrument_id_required' });
    });
  });

  // ── A trade cannot open with nowhere to pay ───────────────────────────────

  describe('taking an offer', () => {
    it('refuses before any lock when the seller has nowhere to be paid', async () => {
      await fund(SELLER, '1000');
      // A USD destination exists; a GBP sell cannot list the method at all now
      // (board honesty). The residual take path is: create with a live destination,
      // remove it, then take — still refuse before any lock.
      await sellerInstrument({ fiatCurrency: 'USD' });
      await expect(
        p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'GBP',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          totalAmt: amt('500'),
          methods: [METHOD],
        }),
      ).rejects.toMatchObject({ code: 'p2p.offer_method_no_destination' });

      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        totalAmt: amt('500'),
        methods: [METHOD],
      });
      const [header] = await instruments.listInstruments(SELLER, false, 200);
      await instruments.removeInstrument({ instrumentId: header!.id, ownerId: SELLER });

      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: METHOD, tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.take_refused',
      });

      // BEFORE ANY LOCK, and the transaction rolled back with it: no trade row,
      // no reserved inventory, nothing in escrow. The alternative is escrowing
      // the seller's asset against a payment nobody can make and letting them
      // discover it fifteen minutes later via a timeout.
      expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
      expect(await sql`SELECT trade_id FROM p2p.trade_payment_instruments`).toHaveLength(0);
      expect(ledger.totalsByAsset()[ASSET] ?? '0').toBe('0');
      // Off the board once the destination is gone — strangers cannot probe it.
      await expect(p2p.getOffer(offer.id)).rejects.toMatchObject({ code: 'p2p.offer_not_found' });
    });

    it('freezes the destination onto the trade in the same transaction', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      const rows = await sql<Array<{ trade_id: string; owner_id: string; fingerprint: string }>>`
        SELECT trade_id, owner_id, fingerprint FROM p2p.trade_payment_instruments WHERE trade_id = ${trade.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner_id).toBe(SELLER);
    });

    /**
     * THE CAPITAL LETTER THAT MADE AN OFFER UNTAKEABLE.
     *
     * Every other test in this file uses a method id that is already lowercase,
     * which is exactly why nothing caught this: storage normalises the id, the
     * offer stores whatever the maker typed, the taker echoes the offer back,
     * and the lookup compared the two with `=`. A maker who capitalised
     * anything produced an offer nobody could take — and the message the seller
     * got was that they had no destination, while holding one.
     *
     * Driven through `takeOffer`, not `attachToTrade`, because the bug needed
     * BOTH comparisons on the path (`methodAllowed`, then the instrument
     * lookup) to agree that case is not meaning. Fixing either alone just moves
     * which layer refuses.
     */
    it('completes a take when the maker capitalised the method id and the instrument did not', async () => {
      await fund(SELLER, '1000');
      await registerMethod({ methodId: 'Bank_Transfer' });

      // Stored lowercase — `createInstrument` normalises, as every write does.
      const created = await instruments.createInstrument({
        ownerId: SELLER,
        methodId: 'BANK_TRANSFER',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'Main account',
        details: { account_reference: CANARY, holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });
      expect(created.methodId).toBe('bank_transfer');

      // Stored verbatim — an offer's `methods` are the maker's own strings.
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        totalAmt: amt('500'),
        methods: ['Bank_Transfer'],
      });
      expect(offer.methods).toEqual(['Bank_Transfer']);

      // The taker sends back what the offer showed them.
      const trade = await p2p.takeOffer({
        offerId: offer.id,
        takerId: BUYER,
        amount: amt('100'),
        method: 'Bank_Transfer',
        tradeId: crypto.randomUUID(),
      });

      const rows = await sql<Array<{ instrument_id: string; method_id: string }>>`
        SELECT instrument_id, method_id FROM p2p.trade_payment_instruments WHERE trade_id = ${trade.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.instrument_id).toBe(created.id);
      // The frozen snapshot carries the normalised id, not the maker's spelling.
      expect(rows[0]!.method_id).toBe('bank_transfer');

      // And the buyer really can pay it — the whole point of not refusing.
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY },
      });
    });

    it('accepts either spelling from the taker, since neither was ever shown to matter', async () => {
      await fund(SELLER, '1000');
      await registerMethod({ methodId: 'bank_transfer' });
      await instruments.createInstrument({
        ownerId: SELLER,
        methodId: 'bank_transfer',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'Main account',
        details: { account_reference: CANARY, holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });

      // The mirror image of the test above: the maker was lowercase, the taker
      // capitalises. Refusing here would have been the same failure wearing the
      // other hat.
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        totalAmt: amt('500'),
        methods: ['bank_transfer'],
      });

      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: '  BANK_Transfer  ', tradeId: crypto.randomUUID() }),
      ).resolves.toBeTruthy();
    });

    it('still refuses a method the seller genuinely has no destination for', async () => {
      // The fix must not become "any string matches". Case is not meaning; a
      // different method still is.
      await fund(SELLER, '1000');
      await registerMethod({ methodId: 'Bank_Transfer' });
      await registerMethod({ methodId: 'other_rail' });
      await instruments.createInstrument({
        ownerId: SELLER,
        methodId: 'Bank_Transfer',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'Main account',
        details: { account_reference: CANARY, holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });

      // List the method they DO hold; probe a different method at take.
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        totalAmt: amt('500'),
        methods: ['Bank_Transfer'],
      });

      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: 'Other_Rail', tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.take_refused',
      });
    });
  });

  // ── THE ORACLE ────────────────────────────────────────────────────────────

  /**
   * `trades.take` WAS A FREE, UNLOGGED, SELF-DESCRIBING PROBE.
   *
   * `attachToTrade` threw with the method id and the currency echoed back, and
   * the router returned `err.message` verbatim as a `BAD_REQUEST`. The throw is
   * inside the reserve transaction, so the probe rolled back cleanly — no trade
   * row, no inventory decrement, no escrow, no cost — and `logDenied` was not
   * called on that path, so it wrote no access-log row. With
   * `instruments.methods.list` supplying the candidate ids, that is a complete
   * confirm/deny for "does seller S hold an instrument for method M in currency
   * C", answered for nothing and never recorded.
   *
   * These tests are the two halves of closing it: the refusals must be
   * indistinguishable, and every one of them must be on the record.
   */
  describe('the take oracle', () => {
    /**
     * An offer that lists `methodId`, from a seller funded and ready.
     * Sell create requires a live destination for each listed method — pass
     * `withInstrument: false` only after one was created and then removed
     * (legacy residual / mid-life removal).
     */
    async function offerListing(methodId: string, fiatCurrency = 'USD') {
      await fund(SELLER, '1000');
      // Ensure a live destination for create; caller may remove afterwards.
      const existing = await instruments.listInstruments(SELLER, false, 200);
      const has = existing.some((h) => h.methodId === methodIdKey(methodId) && h.fiatCurrency === fiatCurrency && h.status === 'active');
      if (!has) {
        await instruments.createInstrument({
          ownerId: SELLER,
          methodId,
          country: 'DE',
          fiatCurrency,
          label: 'for board',
          details: { account_reference: CANARY, holder_name: 'A Seller' },
          instrumentId: crypto.randomUUID(),
        });
      }
      return p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency,
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        totalAmt: amt('500'),
        methods: [methodId],
      });
    }

    async function removeAllSellerInstruments() {
      for (const h of await instruments.listInstruments(SELLER, false, 200)) {
        if (h.status === 'active') await instruments.removeInstrument({ instrumentId: h.id, ownerId: SELLER });
      }
    }

    /** Everything a caller can observe from one refused take. */
    async function refusalShape(offerId: string, method: string) {
      const err = await callerFor(BUYER)
        .trades.take({ offerId, amount: '100', method, tradeId: crypto.randomUUID() })
        .then(
          () => null,
          (e: unknown) => e as { code?: string; message?: string; shape?: unknown; data?: unknown },
        );
      return {
        code: (err as { code?: string })?.code,
        message: (err as { message?: string })?.message,
        keys: Object.keys((err ?? {}) as object).sort(),
        data: JSON.parse(JSON.stringify((err as { data?: unknown })?.data ?? null)),
      };
    }

    /**
     * THE PROOF.
     *
     * Two takes that fail for two entirely different reasons — one because the
     * seller holds no destination for the method, one because the offer does
     * not accept it — and nothing a caller can see tells them apart.
     */
    it('refuses "no such instrument" and "offer does not accept it" identically', async () => {
      await registerMethod();
      await registerMethod({ methodId: 'other-rail' });

      // (a) Offer listed the method; destination was removed after post.
      const noInstrument = await offerListing('other-rail');
      await removeAllSellerInstruments();
      const a = await refusalShape(noInstrument.id, 'other-rail');

      // (b) The offer does NOT list the method. The seller DOES hold one for METHOD only.
      await sellerInstrument();
      const notAccepted = await offerListing('other-rail'); // needs other-rail instrument to create
      // Keep METHOD instrument; drop other-rail so take with METHOD is "not accepted" by offer.
      for (const h of await instruments.listInstruments(SELLER, false, 200)) {
        if (h.methodId === 'other-rail' && h.status === 'active') {
          await instruments.removeInstrument({ instrumentId: h.id, ownerId: SELLER });
        }
      }
      const b = await refusalShape(notAccepted.id, METHOD);

      expect(a.code).toBe('BAD_REQUEST');
      expect(a).toEqual(b);
      // And the message names nothing the caller was not entitled to see: not
      // the method they asked for, not the currency, not the seller.
      expect(a.message).toBe('p2p.take_refused');
      expect(a.message).not.toContain('other-rail');
      expect(a.message).not.toContain(METHOD);
      expect(a.message).not.toContain('USD');
      expect(a.message).not.toContain(SELLER);
    });

    it('costs the prober nothing to attempt and everything to hide', async () => {
      // The rollback that made the probe free is still there — refusing before
      // any lock is correct and is not what changed. What changed is that the
      // attempt is now on the seller's own access log.
      await registerMethod();
      await registerMethod({ methodId: 'other-rail' });
      const offer = await offerListing('other-rail');
      await removeAllSellerInstruments();

      await expect(refusalShape(offer.id, 'other-rail')).resolves.toMatchObject({ code: 'BAD_REQUEST' });

      expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
      // Off the board (no live destination) — remaining inventory still in DB via raw.
      await expect(p2p.getOffer(offer.id)).rejects.toMatchObject({ code: 'p2p.offer_not_found' });
      expect(ledger.totalsByAsset()[ASSET] ?? '0').toBe('0');

      // THE LOG ROW SURVIVED THE ROLLBACK. Not written on the reserve
      // transaction — a log row written inside the transaction the throw aborts
      // would vanish with it, which is precisely what "unlogged" meant. Nor
      // written while that transaction is still open and holding a pool
      // connection, which was #805's own defect: it is queued by `refuseTake`
      // and written by `duringTake` once the transaction has let go. See
      // `take-refusal-deadlock.test.ts`.
      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        ownerId: SELLER,
        viewerId: BUYER,
        outcome: 'denied',
        denyReason: 'take_refused',
        instrumentId: null,
        tradeId: null,
      });
    });

    it('logs both refusals the same way, so the log does not restore the distinction', async () => {
      await registerMethod();
      await registerMethod({ methodId: 'other-rail' });

      const noInstrument = await offerListing('other-rail');
      await removeAllSellerInstruments();
      await refusalShape(noInstrument.id, 'other-rail');

      await sellerInstrument();
      const notAccepted = await offerListing('other-rail');
      for (const h of await instruments.listInstruments(SELLER, false, 200)) {
        if (h.methodId === 'other-rail' && h.status === 'active') {
          await instruments.removeInstrument({ instrumentId: h.id, ownerId: SELLER });
        }
      }
      await refusalShape(notAccepted.id, METHOD);

      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(2);
      const shapes = log.map((e) => ({
        outcome: e.outcome,
        denyReason: e.denyReason,
        viewerRole: e.viewerRole,
        instrumentId: e.instrumentId,
        tradeId: e.tradeId,
      }));
      expect(shapes[0]).toEqual(shapes[1]);
    });

    it('enumerating a seller is now a visible act, not a silent one', async () => {
      // The seller reads their own log and sees that somebody spent an
      // afternoon asking. Before this, there was nothing to see.
      await registerMethod();
      await registerMethod({ methodId: 'other-rail' });
      const offer = await offerListing('other-rail');
      await removeAllSellerInstruments();

      for (let i = 0; i < 5; i++) await refusalShape(offer.id, 'other-rail');

      const log = await callerFor(SELLER).instruments.accessLog({ limit: 100 });
      expect(log.filter((e) => e.outcome === 'denied' && e.denyReason === 'take_refused')).toHaveLength(5);
    });
  });

  // ── THE HEADLINE: who can see it, and when ────────────────────────────────

  describe('disclosure', () => {
    it('shows the buyer the destination while the escrow is held', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      const view = await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });
      expect(view.details).toEqual({ account_reference: CANARY, holder_name: 'A Seller' });
      expect(view.methodId).toBe(METHOD);
      expect(view.fiatCurrency).toBe('USD');

      // And still after the buyer says they have paid — the seller has not
      // confirmed yet and the buyer may need to quote the account in a dispute.
      await p2p.markFiatSent(trade.id, BUYER);
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY },
      });
    });

    it('shows the seller their own destination on their own trade', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await expect(callerFor(SELLER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY },
      });
    });

    it('refuses a non-counterparty, and refuses it as NOT_FOUND', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      // FORBIDDEN would confirm that a trade with this id exists and that its
      // seller has an account on file — the first half of what the caller was
      // trying to learn.
      await expect(callerFor(STRANGER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses before the escrow is locked', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      // The two-minute `created` window is not reachable through the API (a
      // take escrows or fails), so it is set up directly. It matters because it
      // is the window in which a taker has committed nothing: if it disclosed,
      // opening and abandoning takes would be a free harvest.
      await sql`UPDATE p2p.p2p_trades SET status = 'created' WHERE id = ${trade.id}`;

      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('stops showing it the moment the trade closes', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toBeTruthy();

      await p2p.markFiatSent(trade.id, BUYER);
      await p2p.confirmFiatReceived(trade.id, SELLER);

      // A completed trade is not a permanent licence to read the account of
      // someone you dealt with once.
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(callerFor(SELLER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('stops showing it on a refunded trade too', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await p2p.cancelTrade(trade.id, SELLER, 'changed_mind');

      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets a moderator see it only while a dispute on that trade is open', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      const moderator = () => callerFor(MODERATOR, ['p2p:read', 'admin:compliance']);

      // No dispute: `admin:compliance` is not a skeleton key.
      await expect(moderator().trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await p2p.markFiatSent(trade.id, BUYER);
      await p2p.openDispute({ tradeId: trade.id, openedBy: BUYER, reason: 'paid, not released' });

      // §A2: a disputed release needs a human, and both sides see the same
      // evidence. A human asked to rule on "I paid" / "nothing arrived" without
      // seeing the account the payment was meant to reach is being asked to
      // guess.
      await expect(moderator().trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY },
      });

      await p2p.resolveDispute({ tradeId: trade.id, moderatorId: MODERATOR, resolution: 'release' });
      await expect(moderator().trades.paymentInstrument({ tradeId: trade.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ── THE LEAK SWEEP ────────────────────────────────────────────────────────

  describe('no leak through any other path', () => {
    /**
     * Every procedure in the router, called as a stranger against the REAL ids
     * of a live trade, with every successful response scanned for the canary.
     *
     * The map is exhaustive by construction: a procedure the router exposes and
     * this map does not name fails the test. That is the point — the risk this
     * guards is not the endpoints that exist today, it is the next list
     * endpoint someone adds that happens to select the whole row.
     */
    it('never returns the account details to a stranger from any procedure', async () => {
      await sellerInstrument();
      const { offer, trade } = await liveTrade();

      const inputs: Record<string, unknown> = {
        health: undefined,
        'fiat.list': undefined,
        'fees.schedule': undefined,
        'offers.list': { limit: 50 },
        'offers.page': { limit: 50 },
        'offers.get': { offerId: offer.id },
        'offers.mine': { status: 'active', limit: 50 },
        'offers.create': {
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: '1',
          minAmount: '10',
          maxAmount: '100',
          idempotencyKey: 'leak-sweep-create',
        },
        'offers.update': { offerId: offer.id, idempotencyKey: 'leak-sweep-update', terms: 'probe' },
        // The caller's own confirmation window: a time, never an instrument.
        'trades.stepUpWindow': undefined,
        'trades.releaseStepUpWindow': undefined,
        // A reminder answers counts and times only.
        'trades.remind': { tradeId: trade.id },
        'trades.reportMismatch': { tradeId: trade.id, kind: 'under', amountReceived: '1' },
        'trades.validatePayment': { tradeId: trade.id },
        'trades.quote': { offerId: offer.id, amount: '10', method: METHOD },
        'trades.lockQuote': { quoteId: '77777777-7777-4777-8777-777777777777', offerId: offer.id, amount: '10', method: METHOD },
        'trades.export': { from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' },
        'chat.messages.list': { tradeId: trade.id, limit: 50 },
        'chat.messages.send': { tradeId: trade.id, text: 'probe', clientId: 'leak-sweep-chat' },
        'chat.unread': { tradeId: trade.id },
        'disputes.mine': { limit: 50 },
        'contacts.list': undefined,
        'contacts.follow': { peerId: SELLER, idempotencyKey: 'leak-sweep-follow' },
        'contacts.unfollow': { peerId: SELLER, idempotencyKey: 'leak-sweep-unfollow' },
        'contacts.block': { peerId: SELLER, idempotencyKey: 'leak-sweep-block' },
        'contacts.unblock': { peerId: SELLER, idempotencyKey: 'leak-sweep-unblock' },
        'offers.close': { offerId: offer.id },
        'offers.pause': { offerId: offer.id },
        'offers.resume': { offerId: offer.id },
        // A random offer id on purpose: a stranger who TAKES an offer becomes a
        // counterparty, which is the product working, not a leak.
        'trades.take': { offerId: crypto.randomUUID(), amount: '10', method: METHOD, tradeId: crypto.randomUUID() },
        'trades.markFiatSent': { tradeId: trade.id },
        'trades.confirmReceived': { tradeId: trade.id },
        'trades.cancel': { tradeId: trade.id },
        'trades.get': { tradeId: trade.id },
        'trades.list': { limit: 50 },
        'trades.paymentInstrument': { tradeId: trade.id },
        'disputes.open': { tradeId: trade.id, reason: 'probing' },
        // Considered, per the note below the map. Neither can carry an
        // instrument: `appendEvidence` returns only the caller's OWN evidence
        // envelopes, and `list` serialises dispute rows, which hold no
        // instrument id and never join the instrument tables. Both are probed
        // as a stranger anyway — the assertion is on what comes back, not on
        // the reasoning.
        'disputes.appendEvidence': { tradeId: trade.id, evidence: ['probing'] },
        'disputes.list': { limit: 50 },
        'disputes.get': { tradeId: trade.id },
        'disputes.resolve': { tradeId: trade.id, resolution: 'release' },
        // Moderator backlog counts only (open/overdue/escalated/neverSeen) —
        // no instrument id, no account details, no dispute row join. Stranger
        // without allowlist/moderation env refuses; probe asserts no canary.
        'disputes.backlog': {},
        // Operator-only late settlement queue — no instrument fields; stranger refuses.
        'ops.lateSettlements': { limit: 100 },
        'reputation.get': { userId: SELLER },
        // P-trade-orders-21: the caller's own appeal row; no instrument join.
        'reputation.myAppeal': {},
        'reputation.appeal': { tradeId: trade.id, reason: 'probing' },
        // Caller's own order page (P-trade-orders-13): trade rows + counts, no instrument join.
        'trades.page': { limit: 50 },
        // P-trade-orders-14: one own receipt; no instrument join. Stranger has no quotas set → refuses.
        'trades.receipt': { tradeId: trade.id },
        // Own counts and decimal volume sums only (P-ads-merchant-20); no instrument join.
        'merchants.stats': {},
        'instruments.methods.list': { limit: 50 },
        'instruments.methods.register': { methodId: 'probe', country: 'DE', label: 'p', fields: [{ key: 'a', label: 'A' }] },
        'instruments.methods.setEnabled': { methodId: METHOD, country: ANY_COUNTRY, enabled: false, reason: 'regulation' },
        'instruments.create': {
          instrumentId: crypto.randomUUID(),
          methodId: METHOD,
          country: 'DE',
          fiatCurrency: 'EUR',
          details: { account_reference: 'own', holder_name: 'S' },
        },
        'instruments.list': { limit: 200 },
        'instruments.accessLog': { limit: 100 },
        'instruments.update': { instrumentId: (await instruments.listInstruments(SELLER, false, 200))[0]!.id, label: 'mine now' },
        'instruments.remove': { instrumentId: (await instruments.listInstruments(SELLER, false, 200))[0]!.id },
        'instruments.reveal': { instrumentId: (await instruments.listInstruments(SELLER, false, 200))[0]!.id },
        'instruments.revealMasked': { instrumentId: (await instruments.listInstruments(SELLER, false, 200))[0]!.id },
        'instruments.removalImpact': { instrumentId: (await instruments.listInstruments(SELLER, false, 200))[0]!.id },
        // Considered, and this is the interesting pair. Both are self-only —
        // neither takes a `userId`, so a stranger calling them gets their own
        // (empty) record and never the seller's. `data.export` DOES carry
        // instruments, and carries HEADERS only: the values stay behind
        // `instruments.reveal`, which access-logs every read. Probed with a
        // real erasure collaborator wired in, so the canary scan below is a
        // scan of what `data.export` actually returned.
        'data.export': undefined,
        'data.erase': undefined,
        // Considered. The merchant programme holds MEMBERSHIP — a status, the
        // reputation numbers that justified an application, and who decided
        // what and why. It joins no instrument table and carries no account
        // details, by construction: `merchant-service.ts` selects from
        // `p2p_merchants` and `p2p_merchant_events` only.
        //
        // `apiAccess`, `me` and `submitApplication` are self-only — none takes
        // a userId, so a stranger reaches their own standing only. `apiAccess`
        // returns literals plus that status and never joins instrument tables.
        // `decide` and `history` need `admin:compliance`, which a stranger does
        // not hold. Probed anyway: the assertion is on what comes back.
        'merchants.apiAccess': undefined,
        'merchants.me': undefined,
        // Offer-ceiling posture only — decimal strings / null from env policy.
        // Never joins instrument tables (merchant-limits.ts pure functions).
        'merchants.offerLimits': undefined,
        'merchants.myOfferCeiling': undefined,
        'merchants.submitApplication': undefined,
        'merchants.withdraw': { reason: 'probing' },
        'merchants.decide': { userId: SELLER, to: 'approved', reason: 'probing' },
        'merchants.history': { userId: SELLER },
        // Considered. Block/RFQ (PTX-M12) is a firm bilateral quote — size,
        // price, expiry, labeled capacity/firmness. `presentBlockQuote` never
        // joins instrument tables and never carries account details. A stranger
        // calling `quote` becomes the maker of a NEW quote (not a read of the
        // seller's instrument); `accept`/`expire`/`get` refuse unless the
        // caller is a named party; `allocate`/`giveUp` stay refuse-closed even
        // with a named receiving account (owner law, never a payment-instrument
        // reveal). Probe inputs do not contain the canary.
        'rfq.quote': {
          takerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          size: '1',
          price: '1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 'principal',
          firmness: 'firm',
        },
        'rfq.accept': { quoteId: crypto.randomUUID() },
        'rfq.expire': { quoteId: crypto.randomUUID() },
        'rfq.get': { quoteId: crypto.randomUUID() },
        'rfq.allocate': { quoteId: crypto.randomUUID(), allocations: [{ receivingAccount: 'probe' }] },
        'rfq.giveUp': { quoteId: crypto.randomUUID(), receivingAccount: 'probe' },
        // Considered. Manual escalation writes the actor and re-arms the trade
        // deadline. It joins no instrument table and moves no money. A stranger
        // is not a moderator, so the door refuses before any row is read.
        'disputes.escalate': { disputeId: crypto.randomUUID(), reason: 'probe', clientRequestId: 'probe-escalate' },
        // Considered. Operator reads (admin:compliance). The row lists are
        // explicit columns: offer and trade terms, never payment-instrument
        // details, chat text, or a sealed field. A stranger holds neither
        // admin:compliance nor a moderator allowlist entry.
        'ops.offers': { status: 'active', limit: 1 },
        'ops.trades': { status: 'escrowed', limit: 1 },
        'ops.counts': undefined,
        'ops.disputeRate24h': undefined,
        // P-disputes-security-15. Own cap and the sell-lock posture. No
        // instrument join. Unset owner tables refuse before any row is read.
        'limits.verification': undefined,
        'limits.securityChange': undefined,
        // P-ads-merchant-21. Review text is the caller's own words, never a
        // payment-instrument field. A stranger is not a party, so leave, edit
        // and reply refuse. list is public counts and comments. moderate
        // refuses until the caller is a moderator.
        'reviews.leave': { tradeId: trade.id, rating: 'good', comment: 'probe' },
        'reviews.edit': { tradeId: trade.id, comment: 'probe' },
        'reviews.reply': { tradeId: trade.id, text: 'probe' },
        'reviews.list': { userId: SELLER, limit: 20 },
        'reviews.forTrade': { tradeId: trade.id },
        'reviews.moderate': { reviewId: crypto.randomUUID(), reason: 'probe' },
        'access.eligibility': undefined,
        // P-ads-merchant-01: the caller's own terms acceptance and own free balance; no instrument table is read.
        'merchants.advertiserTerms': undefined,
        'merchants.acceptAdvertiserTerms': { version: 'TEST' },
        'offers.sellBalance': { asset: 'USDT' },
        // P-ads-merchant-12: the caller's own posting checklist (tier, order counts); no instrument table is read.
        'merchants.postingEligibility': { fiatCurrency: 'EUR' },
        // J-p2p-04 #5. A report holds the reporter's own words and the two
        // party ids, never an instrument field. A stranger is not a party to
        // the trade, so the report and the own-case read refuse; the case list is moderators only.
        'trades.reportSensitiveRemark': { caseId: crypto.randomUUID(), tradeId: trade.id, remark: 'probe' },
        'disputes.remarkCases': { limit: 50 },
        'trades.remarkCase': { tradeId: trade.id },
        // P-ads-merchant-06: the caller's own edit count, and a relist of the caller's own closed ad (a stranger's id
        // is refused not_a_party); an offer row carries no instrument field.
        'offers.editQuota': undefined,
        'offers.relist': { offerId: crypto.randomUUID() },
      };

      const paths = Object.keys((api as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
      const unmapped = paths.filter((p) => !(p in inputs));
      // A new procedure has to be considered here before it can ship. Adding it
      // to the map is the act of deciding it cannot leak an instrument.
      expect(unmapped, 'new router procedure — add it to the leak sweep').toEqual([]);

      const stranger = callerFor(STRANGER) as unknown as Record<string, unknown>;
      const responses: unknown[] = [];
      const succeeded: string[] = [];

      for (const path of paths) {
        const fn = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], stranger);
        try {
          responses.push(await (fn as (i: unknown) => Promise<unknown>)(inputs[path]));
          succeeded.push(path);
        } catch {
          // A refusal is a pass. What matters is what came back when one did not.
        }
      }

      // Sanity: if everything refused, the scan below would prove nothing.
      expect(succeeded.length).toBeGreaterThan(3);
      expect(JSON.stringify(responses)).not.toContain(CANARY);
      expect(succeeded).not.toContain('trades.paymentInstrument');
    });

    it('never returns the account details through the counterparty’s ordinary reads', async () => {
      await sellerInstrument();
      const { offer, trade } = await liveTrade();
      const buyer = callerFor(BUYER);

      // The buyer IS entitled to the details — through `trades.paymentInstrument`
      // and nowhere else, so that a disclosure is always a deliberate, logged
      // act rather than a side effect of rendering a screen.
      const ordinary = [
        await buyer.trades.get({ tradeId: trade.id }),
        await buyer.trades.list({ limit: 50 }),
        await buyer.offers.get({ offerId: offer.id }),
        await buyer.offers.list({ limit: 50 }),
        await buyer.instruments.list({ limit: 200 }),
        await buyer.instruments.methods.list({ limit: 50 }),
        await buyer.reputation.get({ userId: SELLER }),
      ];
      expect(JSON.stringify(ordinary)).not.toContain(CANARY);

      await expect(buyer.trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY },
      });
    });

    it('never returns the values on the owner’s own list', async () => {
      await sellerInstrument();
      const list = await callerFor(SELLER).instruments.list({ limit: 200 });
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(CANARY);
      // No masked hint either: a mask is still the data, on a path that is not
      // access-logged, one helpful refactor from being the whole value.
      expect(Object.keys(list[0]!)).not.toContain('details');
      expect(Object.keys(list[0]!)).not.toContain('fingerprint');
    });

    it('never puts the values on an offer or on a published event', async () => {
      await sellerInstrument();
      const { offer, trade } = await liveTrade();

      const published = bus.emitted('p2pOfferCreated').concat(bus.emitted('p2pEscrowLocked') as never);
      expect(JSON.stringify(published)).not.toContain(CANARY);

      // The offer carries method IDS — what a maker accepts — and never a
      // destination. That distinction is the whole reason a public board is
      // safe to publish.
      const board = await callerFor(STRANGER).offers.list({ limit: 50 });
      expect(JSON.stringify(board)).not.toContain(CANARY);
      expect(board.find((o) => o.id === offer.id)?.methods).toEqual([METHOD]);
      expect(trade.id).toBeTruthy();
    });
  });

  // ── Sell board honesty: no method without a live destination ─────────────

  describe('a sell offer only advertises methods the maker can be paid on', () => {
    it('refuses create when the maker lists a method with no active destination', async () => {
      // beforeEach registered the method schema; no instrument for SELLER.
      await expect(
        p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD],
        }),
      ).rejects.toMatchObject({ code: 'p2p.offer_method_no_destination' });
    });

    it('drops the offer from the board after the destination is removed', async () => {
      await sellerInstrument();
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });
      expect((await p2p.listOffers({ limit: 50 })).some((o) => o.id === offer.id)).toBe(true);

      const [header] = await instruments.listInstruments(SELLER, false, 200);
      await instruments.removeInstrument({ instrumentId: header!.id, ownerId: SELLER });

      // Residual closed: board no longer advertises a method that cannot be paid.
      expect((await p2p.listOffers({ limit: 50 })).find((o) => o.id === offer.id)).toBeUndefined();
      await expect(p2p.getOffer(offer.id)).rejects.toMatchObject({ code: 'p2p.offer_not_found' });
    });

    it('does not force buy offers to hold destinations at create', async () => {
      // Maker is the buyer; seller is the eventual taker — unknown at post time.
      // The method still has to be an operator-registered rail, or the board
      // would advertise an invented string as payable.
      await expect(
        p2p.createOffer({
          makerId: BUYER,
          side: 'buy',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD],
        }),
      ).resolves.toMatchObject({ side: 'buy', methods: [METHOD] });
    });

    it('drops a buy offer from the board when the operator registry is emptied', async () => {
      const offer = await p2p.createOffer({
        makerId: BUYER,
        side: 'buy',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });
      expect((await p2p.listOffers({ limit: 50 })).some((o) => o.id === offer.id)).toBe(true);

      await sql`TRUNCATE p2p.payment_method_schemas CASCADE`;

      expect((await p2p.listOffers({ limit: 50 })).find((o) => o.id === offer.id)).toBeUndefined();
      await expect(p2p.getOffer(offer.id)).rejects.toMatchObject({ code: 'p2p.offer_not_found' });
    });

    it('filters a multi-method sell offer down to live rails only', async () => {
      await registerMethod({ methodId: 'other-rail' });
      await sellerInstrument(); // METHOD only
      await expect(
        p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          methods: [METHOD, 'other-rail'],
        }),
      ).rejects.toMatchObject({ code: 'p2p.offer_method_no_destination' });

      // After both destinations exist, both list; remove one → board shows one.
      await instruments.createInstrument({
        ownerId: SELLER,
        methodId: 'other-rail',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'Other',
        details: { account_reference: 'x', holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD, 'other-rail'],
      });
      expect((await p2p.listOffers({ limit: 50 })).find((o) => o.id === offer.id)?.methods).toEqual([METHOD, 'other-rail']);

      const headers = await instruments.listInstruments(SELLER, false, 200);
      const other = headers.find((h) => h.methodId === 'other-rail');
      await instruments.removeInstrument({ instrumentId: other!.id, ownerId: SELLER });
      expect((await p2p.listOffers({ limit: 50 })).find((o) => o.id === offer.id)?.methods).toEqual([METHOD]);
    });
  });

  // ── Removal and editing, against a trade that is already running ──────────

  // ── P-ads-merchant-18 (J-p2p-04 #4): removing a method an ad needs warns, pauses on confirm, and tells the maker ──

  describe('removing a payment method an ad needs (J-p2p-04 #4)', () => {
    const SECOND = 'second-transfer';
    const sellAd = (methods: string[], fiatCurrency = 'USD') =>
      p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency,
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods,
      });
    const secondInstrument = async () => {
      await registerMethod({ methodId: SECOND, label: 'Second transfer' });
      return instruments.createInstrument({
        ownerId: SELLER,
        methodId: SECOND,
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'Second account',
        details: { account_reference: CANARY, holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });
    };
    const owed = () => sql<Array<{ offer_ids: string[]; handed_at: Date | null }>>`SELECT * FROM p2p.method_removal_pauses`;
    const notices = () => bus.emitted('p2pOfferPaused');

    it('the warning lists each active sell ad that lists the method, and which ones lose their last payable method', async () => {
      const only = await sellerInstrument();
      await secondInstrument();
      const alone = await sellAd([METHOD]);
      const covered = await sellAd([METHOD, SECOND]);
      await sellAd([SECOND]);
      const impact = await callerFor(SELLER).instruments.removalImpact({ instrumentId: only.id });
      expect(impact).toEqual({
        instrumentId: only.id,
        methodId: METHOD,
        fiatCurrency: 'USD',
        ads: [
          { offerId: alone.id, asset: ASSET, fiatCurrency: 'USD', pauses: true },
          { offerId: covered.id, asset: ASSET, fiatCurrency: 'USD', pauses: false },
        ],
      });
      // Another person cannot read it, and the answer does not say whether the instrument exists.
      await expect(callerFor(STRANGER).instruments.removalImpact({ instrumentId: only.id })).rejects.toMatchObject({
        cause: { code: 'p2p.instrument_not_found' },
      });
    });

    it('without the confirmation the removal is refused and nothing changes', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await expect(callerFor(SELLER).instruments.remove({ instrumentId: only.id })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'p2p.method_in_use' },
      });
      expect((await instruments.listInstruments(SELLER, false, 50)).map((h) => h.id)).toEqual([only.id]);
      expect((await p2p.getOffer(ad.id, SELLER)).status).toBe('active');
      expect(await owed()).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });

    it('a confirmation for other ads does not cover one posted since, and a refused removal spends no confirmation', async () => {
      const only = await sellerInstrument();
      const shown = await sellAd([METHOD]);
      expect((await p2p.methodRemovalImpact(only.id, SELLER)).ads.map((ad) => ad.offerId)).toEqual([shown.id]);
      const postedSince = await sellAd([METHOD]);
      const confirmations = vi.fn(async () => undefined);
      const counted = createP2pRouter(p2p, instruments, new P2pErasure(sql), {
        blockRfq: new BlockRfqService(new MemoryBlockQuoteStore()),
        takeGate: metTakeGate(),
        takeStepUp: confirmedTakeStepUp(),
        releaseStepUp: confirmedReleaseStepUp(),
        instrumentStepUp: { assertConfirmed: confirmations },
        instrumentKeyProvider: 'local-test',
      });
      const raw = encodePrincipal({
        sub: SELLER,
        userId: SELLER,
        sid: '99999999-9999-4999-8999-999999999999',
        scopes: ['p2p:read', 'p2p:write'],
        tier: 'basic',
        mfa: false,
        expiresAt: new Date(Date.now() + 60_000),
      } as unknown as Principal);
      const seller = counted.createCaller(
        edgeContext({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: 'req-counted',
        }),
      );
      await expect(seller.instruments.remove({ instrumentId: only.id, pauseOfferIds: [shown.id] })).rejects.toMatchObject({
        cause: { code: 'p2p.method_in_use' },
      });
      expect(confirmations).not.toHaveBeenCalled();
      await expect(p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [shown.id] })).rejects.toMatchObject({
        code: 'p2p.method_in_use',
      });
      expect((await p2p.getOffer(shown.id, SELLER)).status).toBe('active');
      expect((await p2p.getOffer(postedSince.id, SELLER)).status).toBe('active');
      expect(await instruments.listInstruments(SELLER, false, 50)).toHaveLength(1);

      await seller.instruments.remove({ instrumentId: only.id, pauseOfferIds: [shown.id, postedSince.id] });
      expect(confirmations).toHaveBeenCalledTimes(1);
      expect((await p2p.getOffer(postedSince.id, SELLER)).status).toBe('paused');
    });

    it('posting an ad and removing its only method at once never leaves an active ad nobody can pay', async () => {
      for (let round = 0; round < 5; round++) {
        await db!.truncateAll();
        await registerMethod();
        const only = await sellerInstrument();
        const [posted, removed] = await Promise.allSettled([
          sellAd([METHOD]),
          p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [] }),
        ]);
        // Under the maker's instrument key one goes first: the post sees the method gone, or the removal sees the ad.
        expect([posted.status, removed.status].sort()).toEqual(['fulfilled', 'rejected']);
        if (posted.status === 'rejected') expect(posted.reason).toMatchObject({ code: 'p2p.offer_method_no_destination' });
        else expect(removed).toMatchObject({ reason: { code: 'p2p.method_in_use' } });
        const unpayable = await sql`
          SELECT o.id FROM p2p.offers o
           WHERE o.status = 'active' AND NOT EXISTS (
             SELECT 1 FROM p2p.payment_instruments i WHERE i.owner_id = o.maker_id AND i.status = 'active'
           )
        `;
        expect(unpayable).toHaveLength(0);
      }
    });

    it('erasing the maker erases the record of their removals', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      const report = await new P2pErasure(sql).eraseFor(SELLER);
      expect(report.erased).toContainEqual({ category: 'ads paused by a removed payment method', rows: 1 });
      expect(await owed()).toHaveLength(0);
    });

    it('confirmed, the method goes, its ads pause with the reason, the maker is told once, and an ad with another method stays up', async () => {
      const only = await sellerInstrument();
      await secondInstrument();
      const alone = await sellAd([METHOD]);
      const covered = await sellAd([METHOD, SECOND]);
      const removed = await callerFor(SELLER).instruments.remove({ instrumentId: only.id, pauseOfferIds: [alone.id] });
      expect(removed.status).toBe('removed');

      const pausedAd = await callerFor(SELLER).offers.get({ offerId: alone.id });
      expect(pausedAd).toMatchObject({ status: 'paused', pauseReason: 'method_removed' });
      expect(await callerFor(SELLER).offers.get({ offerId: covered.id })).toMatchObject({ status: 'active', pauseReason: null });
      expect((await p2p.listOffers({ limit: 50 })).map((o) => o.id)).toEqual([covered.id]);

      expect(notices()).toHaveLength(1);
      expect(notices()[0]?.payload).toEqual({
        instrumentId: only.id,
        makerId: SELLER,
        methodId: METHOD,
        offerIds: [alone.id],
        reason: 'method_removed',
        pausedAt: expect.any(String),
      });
      const [row] = await owed();
      expect(row?.offer_ids).toEqual([alone.id]);
      expect(row?.handed_at).not.toBeNull();
      // Nothing owed is left for the sweep, so it hands nothing over twice.
      expect(await p2p.sweepOfferPauses(100)).toEqual({ sent: 0, failures: [] });
      expect(notices()).toHaveLength(1);
    });

    it('ads in another currency and buy ads are not touched; an ad paused by hand is not asked about but takes the reason', async () => {
      const usd = await sellerInstrument();
      await sellerInstrument({ fiatCurrency: 'EUR' });
      const euro = await sellAd([METHOD], 'EUR');
      const buy = await p2p.createOffer({
        makerId: SELLER,
        side: 'buy',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: amt('10'),
        maxAmt: amt('500'),
        methods: [METHOD],
      });
      const byHand = await sellAd([METHOD]);
      await p2p.pauseOffer(byHand.id, SELLER);
      expect((await p2p.methodRemovalImpact(usd.id, SELLER)).ads).toEqual([]);
      await p2p.removeMethod({ instrumentId: usd.id, ownerId: SELLER, pauseOfferIds: [] });
      expect((await p2p.getOffer(euro.id, SELLER)).status).toBe('active');
      expect((await p2p.getOffer(buy.id, SELLER)).status).toBe('active');
      // Already off the board, so nothing was asked and no notice is owed; it now says why resuming needs a method first.
      expect(await p2p.getOffer(byHand.id, SELLER)).toMatchObject({ status: 'paused', pauseReason: 'method_removed' });
      expect(await owed()).toHaveLength(0);
    });

    it('the ad resumes only once a method is payable again, and resuming clears the reason', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      await expect(callerFor(SELLER).offers.resume({ offerId: ad.id })).rejects.toMatchObject({
        cause: { code: 'p2p.offer_method_no_destination' },
      });
      expect(await p2p.getOffer(ad.id, SELLER)).toMatchObject({ status: 'paused', pauseReason: 'method_removed' });

      await sellerInstrument();
      expect(await callerFor(SELLER).offers.resume({ offerId: ad.id })).toMatchObject({ status: 'active', pauseReason: null });
      expect((await p2p.listOffers({ limit: 50 })).map((o) => o.id)).toEqual([ad.id]);
    });

    it('closing a paused ad clears the reason, and pausing by hand never sets one', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      expect(await p2p.closeOffer(ad.id, SELLER)).toMatchObject({ status: 'closed', pauseReason: null });
    });

    it('with the bus down the removal still commits; the sweep hands the notice over once', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      const publish = vi.spyOn(bus, 'publish').mockRejectedValueOnce(new Error('bus unavailable'));
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      publish.mockRestore();
      expect(await p2p.getOffer(ad.id, SELLER)).toMatchObject({ status: 'paused', pauseReason: 'method_removed' });
      expect(notices()).toHaveLength(0);
      expect((await owed())[0]?.handed_at).toBeNull();

      expect(await p2p.sweepOfferPauses(100)).toEqual({ sent: 1, failures: [] });
      expect(await p2p.sweepOfferPauses(100)).toEqual({ sent: 0, failures: [] });
      expect(notices().map((n) => (n.payload as { offerIds: string[] }).offerIds)).toEqual([[ad.id]]);
    });

    it('a removal already done answers not found, and pauses nothing twice', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      await expect(p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] })).rejects.toMatchObject({
        code: 'p2p.instrument_not_found',
      });
      expect(await owed()).toHaveLength(1);
      expect(notices()).toHaveLength(1);
    });

    it('two removals at once cannot both leave an ad up with no payable method', async () => {
      const first = await sellerInstrument();
      const second = await secondInstrument();
      const ad = await sellAd([METHOD, SECOND]);
      const results = await Promise.allSettled([
        p2p.removeMethod({ instrumentId: first.id, ownerId: SELLER, pauseOfferIds: [] }),
        p2p.removeMethod({ instrumentId: second.id, ownerId: SELLER, pauseOfferIds: [] }),
      ]);
      // Under the maker's instrument key one goes first; the other then sees it is the ad's last method and asks.
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'p2p.method_in_use' } });
      expect((await p2p.getOffer(ad.id, SELLER)).status).toBe('active');
      expect(await instruments.listInstruments(SELLER, false, 50)).toHaveLength(1);
    });

    it('the maker finds the paused ad in their own list and reads it as stored; anyone else gets not found', async () => {
      const only = await sellerInstrument();
      const ad = await sellAd([METHOD]);
      await p2p.removeMethod({ instrumentId: only.id, ownerId: SELLER, pauseOfferIds: [ad.id] });
      expect((await callerFor(SELLER).offers.mine({ status: 'paused', limit: 50 })).map((o) => [o.id, o.pauseReason])).toEqual([
        [ad.id, 'method_removed'],
      ]);
      expect(await callerFor(SELLER).offers.mine({ status: 'active', limit: 50 })).toEqual([]);
      expect(await callerFor(SELLER).offers.get({ offerId: ad.id })).toMatchObject({ methods: [METHOD], status: 'paused' });
      await expect(callerFor(BUYER).offers.get({ offerId: ad.id })).rejects.toMatchObject({ cause: { code: 'p2p.offer_not_found' } });
    });
  });

  describe('an in-flight trade', () => {
    it('keeps working after the owner removes the instrument', async () => {
      const created = await sellerInstrument();
      const { trade } = await liveTrade();

      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toBeTruthy();

      // The ad it was the only method for pauses with it (J-p2p-04 #4); the order already taken carries on.
      await callerFor(SELLER).instruments.remove({ instrumentId: created.id, pauseOfferIds: [trade.offerId] });

      // The buyer is mid-payment. A removal must not blank the screen they are
      // copying an account number out of.
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY, holder_name: 'A Seller' },
        // P-trade-orders-08: the buyer is told the seller no longer keeps this destination.
        payeeChange: { kind: 'removed' },
      });

      // And it is gone for everything that has not started yet: the ad is paused, so no new order reaches it.
      expect(await callerFor(SELLER).instruments.list({ limit: 200 })).toEqual([]);
      await expect(
        p2p.takeOffer({ offerId: trade.offerId, takerId: BUYER, amount: amt('50'), method: METHOD, tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.offer_not_active',
      });
    });

    it('does not let the seller redirect a payment already in flight', async () => {
      const created = await sellerInstrument();
      const { trade } = await liveTrade();
      // The labels the buyer reads, in the schema's order, and no change to report yet.
      const placed = await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });
      expect(placed.fields).toEqual([
        { key: 'account_reference', label: 'Account reference' },
        { key: 'holder_name', label: 'Account holder' },
      ]);
      expect(placed.payeeChange).toBeNull();
      // Renaming the destination is not a change of payee.
      await callerFor(SELLER).instruments.update({ instrumentId: created.id, label: 'Renamed' });
      expect((await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).payeeChange).toBeNull();

      await callerFor(SELLER).instruments.update({
        instrumentId: created.id,
        details: { account_reference: 'SWITCHED-ACCOUNT', holder_name: 'A Seller' },
      });

      // THE SCAM THIS PREVENTS: show account A, wait for the buyer to start the
      // transfer, switch to account B, then truthfully report that nothing
      // arrived at B. A live pointer instead of a snapshot is what makes it
      // work; the frozen row is what makes it evidence.
      const view = await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });
      expect(view.details).toEqual({ account_reference: CANARY, holder_name: 'A Seller' });
      // P-trade-orders-08: and the buyer is told the seller's details changed since the order was placed.
      expect(view.payeeChange).toEqual({ kind: 'changed' });

      // The owner's own copy did change — the edit was legitimate, it just does
      // not reach backwards.
      const own = await callerFor(SELLER).instruments.reveal({ instrumentId: created.id });
      expect(own.details).toEqual({ account_reference: 'SWITCHED-ACCOUNT', holder_name: 'A Seller' });
    });
  });

  describe('the labels on an in-flight trade', () => {
    it('are display only: a stored schema that cannot be read still shows the details, under their keys', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      // A shape the database accepts but a pattern the service will not run, so reading the schema throws.
      await sql`UPDATE p2p.payment_method_schemas SET fields = ${sql.json([
        { key: 'account_reference', label: 'Account reference', pattern: '(?=[0-9]{4})[0-9]+' },
        { key: 'holder_name', label: 'Account holder' },
      ] as never)}`;
      const view = await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });
      expect(view.details).toEqual({ account_reference: CANARY, holder_name: 'A Seller' });
      expect(view.fields).toHaveLength(2);
      expect(view.fields).toEqual(
        expect.arrayContaining([
          { key: 'account_reference', label: 'account_reference' },
          { key: 'holder_name', label: 'holder_name' },
        ]),
      );
    });
  });

  // ── The access log ────────────────────────────────────────────────────────

  describe('the access log', () => {
    it('records who saw whose details, on which trade', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });

      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ viewerId: BUYER, viewerRole: 'counterparty', outcome: 'revealed', tradeId: trade.id });
      expect(log[0]!.at).toBeInstanceOf(Date);
    });

    it('records the owner’s own reads too', async () => {
      const created = await sellerInstrument();
      await callerFor(SELLER).instruments.reveal({ instrumentId: created.id });

      // The owner is not exempt: an account takeover reads exactly like an
      // owner, because it holds the session. A log with a hole shaped like "the
      // owner" says nothing about the one attack it most needs to describe.
      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ viewerId: SELLER, viewerRole: 'owner', outcome: 'revealed', tradeId: null });
    });

    it('records refusals, which is the half that shows harvesting', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      await expect(callerFor(STRANGER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toThrow();
      await expect(
        callerFor(MODERATOR, ['p2p:read', 'admin:compliance']).trades.paymentInstrument({ tradeId: trade.id }),
      ).rejects.toThrow();

      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(2);
      expect(log.map((e) => [e.viewerId, e.outcome, e.denyReason]).sort()).toEqual(
        [
          [MODERATOR, 'denied', 'moderator_without_open_dispute'],
          [STRANGER, 'denied', 'not_a_party'],
        ].sort(),
      );
    });

    it('is the owner’s to read, and shows them a look they did not expect', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await expect(callerFor(STRANGER).trades.paymentInstrument({ tradeId: trade.id })).rejects.toThrow();

      const mine = await callerFor(SELLER).instruments.accessLog({ limit: 100 });
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ viewerId: STRANGER, outcome: 'denied' });

      // And it is not anyone else's to read.
      expect(await callerFor(STRANGER).instruments.accessLog({ limit: 100 })).toEqual([]);
    });

    it('cannot be edited or deleted, even behind the service’s back', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });

      // Raw SQL, bypassing every line of application code. A log the service
      // could tidy is a log whose value depends on the service not having been
      // the thing that was compromised.
      await expect(sql`UPDATE p2p.instrument_access_log SET viewer_id = 'someone-else'`).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM p2p.instrument_access_log`).rejects.toThrow(/append-only/i);

      expect(await instruments.accessLogFor(SELLER, 100)).toHaveLength(1);
    });

    it('cannot be avoided: no disclosure exists without a row', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();

      const before = await sql<Array<{ n: string }>>`SELECT count(*) AS n FROM p2p.instrument_access_log WHERE outcome = 'revealed'`;
      expect(Number(before[0]!.n)).toBe(0);

      for (let i = 0; i < 3; i++) await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });

      // One row per disclosure, not one per session. The reveal is a single SQL
      // statement in which the SELECT of the details is cross-joined to the
      // INSERT of this row, so the count cannot fall behind the reads.
      const after = await sql<Array<{ n: string }>>`SELECT count(*) AS n FROM p2p.instrument_access_log WHERE outcome = 'revealed'`;
      expect(Number(after[0]!.n)).toBe(3);
    });
  });

  // ── Retention ─────────────────────────────────────────────────────────────

  describe('retention', () => {
    it('wipes the details off a closed trade past the window and keeps the fingerprint', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await p2p.markFiatSent(trade.id, BUYER);
      await p2p.confirmFiatReceived(trade.id, SELLER);

      const short = new InstrumentService(sql, { retentionDays: 30 });
      // Nothing is due yet — a purge that ran early would destroy evidence an
      // open appeal still needs.
      expect(await short.purgeExpiredSnapshots(500)).toEqual({ purged: 0 });

      // A separate past decision fixture; never rewrite a completed decision.
      const expiredTrade = (await liveTrade()).trade;
      await sql`UPDATE p2p.p2p_trades SET status = 'released', resolution = 'released', resolution_reason = 'seller.confirmed', resolved_at = now() - interval '45 days', deadline_at = null WHERE id = ${expiredTrade.id}`;
      await p2p.settle(expiredTrade.id);
      expect(await short.purgeExpiredSnapshots(500)).toEqual({ purged: 1 });

      const rows = await sql<Array<{ details: unknown; fingerprint: string; purged_at: Date | null }>>`
        SELECT details, fingerprint, purged_at FROM p2p.trade_payment_instruments WHERE trade_id = ${expiredTrade.id}
      `;
      expect(rows[0]!.details).toBeNull();
      expect(rows[0]!.purged_at).toBeInstanceOf(Date);
      // The fingerprint outlives the values: an appeal can still be told whether
      // the account a seller now names is the one the buyer was shown, without
      // us holding the account in order to say so.
      expect(rows[0]!.fingerprint).toHaveLength(64);

      expect(
        await sql`SELECT trade_id FROM p2p.trade_payment_instruments WHERE trade_id = ${expiredTrade.id} AND details::text LIKE ${'%' + CANARY + '%'}`,
      ).toHaveLength(0);
    });

    it('never touches a trade that is still live', async () => {
      await sellerInstrument();
      const { trade } = await liveTrade();
      await sql`UPDATE p2p.trade_payment_instruments SET attached_at = now() - interval '400 days' WHERE trade_id = ${trade.id}`;

      const short = new InstrumentService(sql, { retentionDays: 30 });
      expect(await short.purgeExpiredSnapshots(500)).toEqual({ purged: 0 });
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toBeTruthy();
    });

    /**
     * "REMOVE MY BANK ACCOUNT" HAS TO MEAN THE ACCOUNT IS GONE.
     *
     * Removal used to set the status and nothing else. Nothing else nulled the
     * details either — the snapshot purge only touches
     * `trade_payment_instruments` — so the account number stayed in the row
     * indefinitely, in a state where `revealOwn` (which filters `active`) would
     * not let the owner so much as look at what was still held.
     *
     * Retained and unreadable is the worst pair available: no delete path and
     * no export path, under a README and an `env.ts` that both promise a
     * retention window.
     */
    it('wipes the account details when the owner removes the instrument, and keeps the fingerprint', async () => {
      const created = await sellerInstrument();

      // THE EXPORT, and it must exist BEFORE the removal — this is the moment
      // the owner can still get their own data out. `reveal` is the export, and
      // it is logged like every other read.
      const exported = await callerFor(SELLER).instruments.reveal({ instrumentId: created.id });
      expect(exported.details).toEqual({ account_reference: CANARY, holder_name: 'A Seller' });

      await callerFor(SELLER).instruments.remove({ instrumentId: created.id });

      const rows = await sql<Array<{ details: unknown; fingerprint: string; status: string; removed_at: Date | null }>>`
        SELECT details, fingerprint, status, removed_at FROM p2p.payment_instruments WHERE id = ${created.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('removed');
      expect(rows[0]!.details).toBeNull();
      expect(rows[0]!.removed_at).toBeInstanceOf(Date);
      // Kept on purpose: an appeal can still be told whether the account a
      // seller now names is the one the buyer was shown.
      expect(rows[0]!.fingerprint).toHaveLength(64);

      // The canary is the mechanical version of the claim: it appears nowhere
      // else in the system, so scanning the whole table is a complete answer.
      expect(await sql`SELECT id FROM p2p.payment_instruments WHERE details::text LIKE ${'%' + CANARY + '%'}`).toHaveLength(0);

      // The header survives, because the access log has to keep meaning
      // something after the data it describes is gone.
      const [header] = await instruments.listInstruments(SELLER, true, 200);
      expect(header).toMatchObject({ id: created.id, status: 'removed', methodId: METHOD });
    });

    it('will not let a removed instrument hold details, even behind the service’s back', async () => {
      const created = await sellerInstrument();
      await callerFor(SELLER).instruments.remove({ instrumentId: created.id });

      // The rule is a CHECK constraint, not a line in `removeInstrument`. A
      // retention promise kept only by the one function that happens to write
      // the row is a promise the next edit one layer up drops silently.
      await expect(
        sql`UPDATE p2p.payment_instruments SET details = ${sql.json({ account_reference: CANARY } as never)} WHERE id = ${created.id}`,
      ).rejects.toMatchObject({ code: '23514' });

      // And the other half of the same constraint: an ACTIVE instrument cannot
      // be emptied, because a destination with no address is one the buyer
      // cannot pay.
      const live = await sellerInstrument({ fiatCurrency: 'GBP' });
      await expect(sql`UPDATE p2p.payment_instruments SET details = NULL WHERE id = ${live.id}`).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('leaves the owner nothing to read once it is removed, and says so as NOT_FOUND', async () => {
      const created = await sellerInstrument();
      await callerFor(SELLER).instruments.remove({ instrumentId: created.id });

      // There is nothing left to disclose, and the refusal is the same
      // NOT_FOUND every other refusal collapses to — a removed instrument must
      // not be distinguishable from one that never existed.
      await expect(callerFor(SELLER).instruments.reveal({ instrumentId: created.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('does not strand a buyer who is mid-payment when the seller removes the destination', async () => {
      const created = await sellerInstrument();
      const { trade } = await liveTrade();

      await callerFor(SELLER).instruments.remove({ instrumentId: created.id, pauseOfferIds: [trade.offerId] });

      // The live row is wiped; the trade's own frozen copy is a separate one and
      // survives until the retention sweep. Wiping on removal must not become a
      // way to blank the screen a buyer is copying an account number out of.
      expect(await sql`SELECT id FROM p2p.payment_instruments WHERE id = ${created.id} AND details IS NOT NULL`).toHaveLength(0);
      await expect(callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id })).resolves.toMatchObject({
        details: { account_reference: CANARY, holder_name: 'A Seller' },
      });
    });
  });

  // ── Ownership ─────────────────────────────────────────────────────────────

  describe('ownership', () => {
    it('refuses every owner operation to someone who is not the owner', async () => {
      const created = await sellerInstrument();
      const stranger = callerFor(STRANGER);

      for (const call of [
        () => stranger.instruments.reveal({ instrumentId: created.id }),
        () => stranger.instruments.update({ instrumentId: created.id, label: 'mine' }),
        () => stranger.instruments.remove({ instrumentId: created.id }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }

      const untouched = await instruments.revealOwn({ instrumentId: created.id, viewerId: SELLER });
      expect(untouched.label).toBe('Main account');
      expect(untouched.details).toEqual({ account_reference: CANARY, holder_name: 'A Seller' });
    });

    it('logs the refused attempt against the attempt, not the owner', async () => {
      const created = await sellerInstrument();
      await expect(callerFor(STRANGER).instruments.reveal({ instrumentId: created.id })).rejects.toThrow();

      // Nothing resolved, so nothing is attributed to the owner — but the
      // attempt itself is on the record, under the viewer who made it.
      expect(await instruments.accessLogFor(SELLER, 100)).toEqual([]);
      const attempts = await sql<Array<{ viewer_id: string; outcome: string; deny_reason: string }>>`
        SELECT viewer_id, outcome, deny_reason FROM p2p.instrument_access_log WHERE viewer_id = ${STRANGER}
      `;
      expect(attempts).toEqual([{ viewer_id: STRANGER, outcome: 'denied', deny_reason: 'not_the_owner' }]);
    });
  });

  // ── A row that did not come through the API ────────────────────────────────

  /**
   * THE DOOR IS NOT THE CONTROL.
   *
   * `registerMethodSchema` is the only writer with `admin:compliance` in front
   * of it, and it validates. Everything else that can reach the column —
   * a migration, a data-fix script, a psql session, some future writer in this
   * same service — validated nothing, and `toSchema` cast the row straight to
   * `FieldSpec[]`. "Only a trusted operator can get here" is a statement about
   * who is holding the door; it stops being true the first time a scope widens
   * or a migration writes the row directly, and it was never something the code
   * enforced.
   *
   * These tests write rows with RAW SQL — deliberately bypassing every line of
   * TypeScript in this service — and assert that both halves hold:
   *
   *   · the DATABASE refuses a structurally bad field list at write time,
   *     whoever is writing;
   *   · the SERVICE refuses a field list it cannot run at read time, because
   *     "is this pattern safe to execute" is not a question SQL can answer.
   */
  describe('a schema row inserted behind the API', () => {
    /** Straight to the table. No service code involved on the way in. */
    async function rawInsertSchema(fields: unknown, methodId = 'raw-method') {
      return sql`
        INSERT INTO p2p.payment_method_schemas (method_id, country, label, fields, enabled)
        VALUES (${methodId}, ${ANY_COUNTRY}, 'Inserted behind the API', ${sql.json(fields as never)}, true)
        ON CONFLICT (method_id, country) DO UPDATE SET fields = EXCLUDED.fields
      `;
    }

    it('is refused by the database when the field list is malformed', async () => {
      // The column guard used to be "a non-empty JSON array" and nothing more,
      // so every one of these was storable.
      const REFUSED: Array<[string, unknown]> = [
        ['no fields at all', []],
        ['not an array', { key: 'a' }],
        ['above MAX_FIELDS', Array.from({ length: 25 }, (_, i) => ({ key: `f${i}`, label: 'L' }))],
        ['a key that is not a key', [{ key: 'Not A Key', label: 'L' }]],
        ['no key', [{ label: 'L' }]],
        ['no label', [{ key: 'a' }]],
        ['a blank label', [{ key: 'a', label: '   ' }]],
        ['a label over MAX_LABEL_LENGTH', [{ key: 'a', label: 'x'.repeat(121) }]],
        ['a pattern over MAX_PATTERN_LENGTH', [{ key: 'a', label: 'L', pattern: 'x'.repeat(201) }]],
        ['a pattern that is not a string', [{ key: 'a', label: 'L', pattern: 5 }]],
        ['a minLength of 0', [{ key: 'a', label: 'L', minLength: 0 }]],
        ['a minLength past MAX_VALUE_LENGTH', [{ key: 'a', label: 'L', minLength: 513 }]],
        ['a fractional minLength', [{ key: 'a', label: 'L', minLength: 1.5 }]],
        ['minLength above maxLength', [{ key: 'a', label: 'L', minLength: 10, maxLength: 4 }]],
        [
          'a duplicate key',
          [
            { key: 'a', label: 'A' },
            { key: 'a', label: 'B' },
          ],
        ],
        ['a non-boolean required', [{ key: 'a', label: 'L', required: 'yes' }]],
        ['an element that is not an object', ['nope']],
      ];

      for (const [what, fields] of REFUSED) {
        await expect(rawInsertSchema(fields), what).rejects.toMatchObject({
          constraint_name: 'payment_method_schemas_fields_ck',
        });
      }

      // And nothing landed.
      const rows = await sql`SELECT method_id FROM p2p.payment_method_schemas WHERE method_id = 'raw-method'`;
      expect(rows).toEqual([]);
    });

    /**
     * The half SQL cannot cover.
     *
     * `(?=…)` is a perfectly well-formed string of 12 characters, so the column
     * constraint has no grounds to refuse it — deciding whether a pattern is one
     * this service can run in linear time means running this service's parser.
     * That is why the re-validation on READ exists as well, and this is the test
     * that would go green again if `toSchema` went back to casting the row.
     */
    it('is refused by the service on read when the pattern is one we cannot run', async () => {
      await rawInsertSchema([{ key: 'acct', label: 'Account', pattern: '(?=[0-9]{4})[0-9]+' }]);

      // It really is in the table — the database had no reason to object.
      const stored = await sql`SELECT fields FROM p2p.payment_method_schemas WHERE method_id = 'raw-method'`;
      expect(stored).toHaveLength(1);

      // Every read path refuses it, and says which row is the problem.
      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toThrow(/raw-method/);
      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toThrow(/lookahead/);
      await expect(
        instruments.createInstrument({
          ownerId: SELLER,
          methodId: 'raw-method',
          country: 'DE',
          fiatCurrency: 'USD',
          details: { acct: '1234' },
          instrumentId: crypto.randomUUID(),
        }),
      ).rejects.toThrow(InstrumentError);
    });

    it('refuses on read for the rest of the rules too, not only patterns', async () => {
      // A row whose SHAPE the constraint accepts but whose CONTENT the service
      // will not: `help` is a string, so SQL is satisfied, and the pattern is a
      // 13-character automaton bomb that only the compiler can recognise.
      await rawInsertSchema([{ key: 'acct', label: 'Account', pattern: '(a{100}){100}' }]);

      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toThrow(InstrumentError);
      await expect(instruments.listMethodSchemas({ limit: 50 })).rejects.toThrow(/raw-method/);
    });

    it('lets a legitimate hand-written row through untouched', async () => {
      // Fail-closed must not mean fail-always. A row an operator could have
      // registered through the API reads back exactly as written — including a
      // pattern with an escaped dollar sign, the one that used to explode.
      await rawInsertSchema([
        { key: 'amount', label: 'Amount', required: true, pattern: '\\d+\\$' },
        { key: 'holder_name', label: 'Account holder', required: true, maxLength: 80 },
      ]);

      const all = await instruments.listMethodSchemas({ methodId: 'raw-method', limit: 50 });
      expect(all).toHaveLength(1);
      expect(all[0]!.fields.map((f) => f.key)).toEqual(['amount', 'holder_name']);
      expect(all[0]!.fields[0]!.pattern).toBe('\\d+\\$');

      const created = await instruments.createInstrument({
        ownerId: SELLER,
        methodId: 'raw-method',
        country: 'DE',
        fiatCurrency: 'USD',
        details: { amount: '2500$', holder_name: 'A Seller' },
        instrumentId: crypto.randomUUID(),
      });
      expect(created.methodId).toBe('raw-method');
    });
  });
});

describe('maskedValue (J-p2p-04 #3)', () => {
  it('shows the last four of a long value, spaces dropped, and none of a short one', () => {
    expect(maskedValue('DE89 3704 0044 0532 0130 00')).toBe('•••• 3000');
    expect(maskedValue('123456')).toBe('••••');
    expect(maskedValue('')).toBe('••••');
  });
});
