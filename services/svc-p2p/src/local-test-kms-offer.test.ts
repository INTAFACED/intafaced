import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { P2pErasure } from './erasure.js';
import { createLocalTestInstrumentKeyProvider, instrumentDetailsAad } from './instrument-key-provider.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';

/**
 * Offers and sealed instruments on the shared test database.
 * `assertTestDatabase` refuses a name that does not end in `_test`, so a URL
 * whose database is `test` is pointed at this server's `intafaced_test`.
 */
function adminDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const EDGE_SECRET = 'local-test-kms-offer-edge-secret-long-enough';
const ACCOUNT = 'TEST-ACCOUNT-DO-NOT-LEAK-77ab';
const METHOD = 'test';

beforeEach(() => {
  vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
  vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:local-test-kms');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
});
afterEach(() => vi.unstubAllEnvs());

describe('local-test key: offers and sealed instruments', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  const key = createLocalTestInstrumentKeyProvider(randomBytes(32), 'TEST-a1b2c3d4');
  let instruments: InstrumentService;
  let p2p: P2pService;
  let bus: MemoryEventBus;
  let api: ReturnType<typeof createP2pRouter>;
  const edge = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-p2p' });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: adminDatabaseUrl(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function callerFor(userId: string) {
    const principal = {
      sub: userId,
      userId,
      sid: '99999999-9999-4999-8999-999999999999',
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as Principal;
    const raw = encodePrincipal(principal);
    return api.createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${userId}`,
      }),
    );
  }

  beforeEach(async () => {
    await db.truncateAll();
    instruments = new InstrumentService(sql, { retentionDays: 30, keyProvider: key });
    bus = new MemoryEventBus('svc-p2p');
    p2p = new P2pService(sql, new MemoryLedger(), bus, {
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
    api = createP2pRouter(p2p, instruments, new P2pErasure(sql), { instrumentKeyProvider: 'local-test' });
    await instruments.registerMethodSchema({
      methodId: METHOD,
      country: ANY_COUNTRY,
      label: 'TEST',
      fields: [
        { key: 'account_reference', label: 'Account reference', required: true },
        { key: 'holder_name', label: 'Account holder', required: true },
      ],
    });
  });

  const offerInput = {
    side: 'sell' as const,
    asset: 'USDT',
    fiatCurrency: 'USD',
    priceType: 'fixed' as const,
    price: '1.00',
    minAmount: '10.00',
    maxAmount: '100.00',
    totalAmount: '100.00',
    methods: [METHOD],
  };

  async function storeInstrument() {
    return instruments.createInstrument({
      ownerId: MAKER,
      methodId: METHOD,
      country: 'DE',
      fiatCurrency: 'USD',
      label: 'TEST destination',
      details: { account_reference: ACCOUNT, holder_name: 'Test Holder' },
      instrumentId: crypto.randomUUID(),
    });
  }

  it('creates a sell offer for a registered TEST method and lists it once', async () => {
    await storeInstrument();
    const caller = callerFor(MAKER);
    const created = await caller.offers.create(offerInput);
    expect(created.makerId).toBe(MAKER);
    expect(created.side).toBe('sell');
    expect(created.price).toBe('1');
    expect(created.minAmount).toBe('10');
    expect(created.maxAmount).toBe('100');
    const listed = await caller.offers.list({ limit: 20 });
    expect(listed.map((offer) => offer.id)).toContain(created.id);
    expect(bus.emitted('p2pOfferCreated')).toHaveLength(1);

    await expect(caller.offers.create({ ...offerInput, methods: ['not-a-rail'] })).rejects.toMatchObject({
      cause: { code: 'p2p.instrument_method_unknown' },
    });
    await instruments.registerMethodSchema({
      methodId: 'other',
      country: ANY_COUNTRY,
      label: 'TEST other',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await expect(caller.offers.create({ ...offerInput, methods: ['other'] })).rejects.toMatchObject({
      cause: { code: 'p2p.offer_method_no_destination' },
    });
    expect(bus.emitted('p2pOfferCreated')).toHaveLength(1);
  });

  it('reports health as not a configured KMS plus the local-test provider', async () => {
    const caller = createP2pRouter(p2p, instruments, new P2pErasure(sql), { instrumentKeyProvider: 'local-test' }).createCaller(
      edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon-health' }),
    );
    await expect(caller.health()).resolves.toMatchObject({
      instrumentKmsConfigured: false,
      instrumentKeyProvider: 'local-test',
    });
  });

  it('seals details at rest, opens them for the owner, and refuses without a provider', async () => {
    const created = await storeInstrument();
    const rows = await sql<Array<{ details: { _sealed?: string } }>>`
      SELECT details FROM p2p.payment_instruments WHERE id = ${created.id}
    `;
    expect(rows[0]!.details._sealed).toMatch(/^local-test:v1:/);
    expect(JSON.stringify(rows[0]!.details)).not.toContain(ACCOUNT);

    const revealed = await callerFor(MAKER).instruments.reveal({ instrumentId: created.id });
    expect(revealed.details).toEqual({ account_reference: ACCOUNT, holder_name: 'Test Holder' });

    expect(() => key.open(rows[0]!.details._sealed!, instrumentDetailsAad(created.id, 'other-owner'))).toThrow();
    try {
      key.open(rows[0]!.details._sealed!, instrumentDetailsAad(created.id, 'other-owner'));
    } catch (err) {
      expect(String(err)).not.toContain(ACCOUNT);
    }

    const plain = new InstrumentService(sql, { retentionDays: 30 });
    await expect(plain.revealOwn({ instrumentId: created.id, viewerId: MAKER })).rejects.toMatchObject({
      code: 'p2p.instrument_kms_required',
    });

    const exported = await callerFor(MAKER).data.export();
    const exportText = JSON.stringify(exported);
    expect(exportText).not.toContain(ACCOUNT);
    expect(exportText).not.toContain('_sealed');
  });

  it('keeps a plaintext row readable with or without a provider', async () => {
    const plainWriter = new InstrumentService(sql, { retentionDays: 30 });
    const created = await plainWriter.createInstrument({
      ownerId: MAKER,
      methodId: METHOD,
      country: 'DE',
      fiatCurrency: 'USD',
      label: 'plain',
      details: { account_reference: ACCOUNT, holder_name: 'Test Holder' },
      instrumentId: crypto.randomUUID(),
    });
    const raw = await sql<Array<{ details: Record<string, string> }>>`
      SELECT details FROM p2p.payment_instruments WHERE id = ${created.id}
    `;
    expect(raw[0]!.details).toEqual({ account_reference: ACCOUNT, holder_name: 'Test Holder' });
    await expect(plainWriter.revealOwn({ instrumentId: created.id, viewerId: MAKER })).resolves.toMatchObject({
      details: { account_reference: ACCOUNT, holder_name: 'Test Holder' },
    });
    await expect(instruments.revealOwn({ instrumentId: created.id, viewerId: MAKER })).resolves.toMatchObject({
      details: { account_reference: ACCOUNT, holder_name: 'Test Holder' },
    });
  });

  it('seals the trade snapshot and purgeExpiredSnapshots still clears it', async () => {
    await storeInstrument();
    const ledger = new MemoryLedger();
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
    api = createP2pRouter(p2p, instruments, new P2pErasure(sql), { instrumentKeyProvider: 'local-test' });
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: crypto.randomUUID() }));
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('100'),
      totalAmt: amt('100'),
      methods: [METHOD],
    });
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: BUYER,
      amount: amt('100'),
      method: METHOD,
      tradeId: crypto.randomUUID(),
    });
    const snap = await sql<Array<{ details: { _sealed?: string } }>>`
      SELECT details FROM p2p.trade_payment_instruments WHERE trade_id = ${trade.id}
    `;
    expect(snap[0]!.details._sealed).toMatch(/^local-test:v1:/);
    expect(JSON.stringify(snap[0]!.details)).not.toContain(ACCOUNT);
    const view = await callerFor(BUYER).trades.paymentInstrument({ tradeId: trade.id });
    expect(view.details).toEqual({ account_reference: ACCOUNT, holder_name: 'Test Holder' });

    await sql`
      UPDATE p2p.p2p_trades
         SET status = 'released', resolution = 'released', resolution_reason = 'seller.confirmed',
             resolved_at = now() - interval '45 days', deadline_at = null
       WHERE id = ${trade.id}
    `;
    await p2p.settle(trade.id);
    expect(await instruments.purgeExpiredSnapshots(500)).toEqual({ purged: 1 });
    const after = await sql<Array<{ details: unknown }>>`
      SELECT details FROM p2p.trade_payment_instruments WHERE trade_id = ${trade.id}
    `;
    expect(after[0]!.details).toBeNull();
  });
});
