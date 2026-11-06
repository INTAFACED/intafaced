/**
 * J-bank-13 (BK-cissue-01 to -04): getting a card, over real rows.
 *
 * Eligibility and terms before an order, the count limit under the person's lock, a single-use card that holds its one
 * use from approval and closes after its capture, a physical card's delivery and address history, activation, and a lost
 * report that reverses an open hold once and leaves one new inactive card.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable, withdrawalHoldAccount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { CardOrderService } from './card-orders.js';
import { parseCardProgramme, termsTextHash, type CardProgrammeTerms } from './card-programme.js';
import { cardIssuerFor } from './issuer.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const TERMS: CardProgrammeTerms = parseCardProgramme(
  JSON.stringify({
    network: 'TEST network',
    countries: ['DE', 'FR'],
    limits: { virtual: 2, physical: 1 },
    terms: { version: 'test-1', text: 'TEST terms' },
    designs: [{ id: 'classic', name: 'TEST Classic' }],
    speeds: [{ speed: 'standard', days: 7 }],
    deliveryCountries: ['DE'],
  }),
)!;
const ADDRESS = {
  name: 'Ada TEST',
  line1: '1 TEST Strasse',
  line2: null,
  city: 'Berlin',
  region: null,
  postalCode: '10115',
  country: 'DE',
};

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('getting a card (J-bank-13, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let cards: CardService;
  let orders: CardOrderService;
  let user: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);

  beforeEach(async () => {
    ledger = new MemoryLedger();
    cards = new CardService(sql, ledger, { issuer: cardIssuerFor('card-sim', { APP_ENV: 'test' }), programmeTerms: TERMS });
    orders = new CardOrderService(sql, cards, { terms: TERMS });
    user = randomUUID();
    await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `fund:${user}` }));
  });

  const accept = () => orders.acceptTerms(user, { termsVersion: 'test-1', textHash: termsTextHash('TEST terms') });
  const virtual = (extra: { usesAllowed?: number } = {}) =>
    orders.order({
      cardId: randomUUID(),
      userId: user,
      country: 'DE',
      termsVersion: 'test-1',
      assetId: 'USDT',
      perAuthorizationLimit: amt('50'),
      cardType: 'virtual',
      ...extra,
    });
  const physical = (cardId = randomUUID()) =>
    orders.order({
      cardId,
      userId: user,
      country: 'DE',
      termsVersion: 'test-1',
      assetId: 'USDT',
      perAuthorizationLimit: amt('50'),
      cardType: 'physical',
      designId: 'classic',
      deliverySpeed: 'standard',
      shippingAddress: ADDRESS,
    });
  const available = async () => (await ledger.balance(userAvailable(user, 'USDT'))).amount;

  it('names the reason for a country off the list and refuses the order there', async () => {
    const off = await orders.catalogue(user, 'us');
    expect(off).toMatchObject({ country: 'US', eligible: false, reason: 'bank.card_not_eligible' });
    await accept();
    await expect(orders.order({ ...(await baseOrder()), country: 'US' })).rejects.toMatchObject({ code: 'bank.card_not_eligible' });
    expect(await sql`SELECT id FROM bank.cards WHERE user_id = ${user}`).toHaveLength(0);
  });
  async function baseOrder() {
    return {
      cardId: randomUUID(),
      userId: user,
      country: 'DE',
      termsVersion: 'test-1',
      assetId: 'USDT',
      perAuthorizationLimit: amt('50'),
      cardType: 'virtual' as const,
    };
  }

  it('refuses an order before the terms are accepted, and records one acceptance however often it is given', async () => {
    await expect(virtual()).rejects.toMatchObject({ code: 'bank.card_terms_not_accepted' });
    const first = await accept();
    const again = await accept();
    expect(again.id).toBe(first.id);
    expect(await sql`SELECT id FROM bank.card_terms_acceptances WHERE user_id = ${user}`).toHaveLength(1);
    await expect(orders.acceptTerms(user, { termsVersion: 'test-1', textHash: 'sha256:other' })).rejects.toMatchObject({
      code: 'bank.card_terms_changed',
    });
  });

  it('refuses a card past the count limit, and a retried order of the same card is that card', async () => {
    await accept();
    const one = await virtual();
    await virtual();
    await expect(virtual()).rejects.toMatchObject({ code: 'bank.card_count_limit' });
    const retried = await orders.order({ ...(await baseOrder()), cardId: one.id });
    expect(retried.id).toBe(one.id);
    expect((await orders.catalogue(user, 'DE')).products.find((p) => p.type === 'virtual')).toEqual({ type: 'virtual', held: 2, limit: 2 });
  });

  it('holds a single-use card’s one use from approval, closes it after the capture, and declines what follows', async () => {
    await accept();
    const card = await virtual({ usesAllowed: 1 });
    const first = await cards.authorize({ cardId: card.id, authorizationRef: 'single-1', amount: amt('5') });
    expect(first.decision).toBe('approved');
    const second = await cards.authorize({ cardId: card.id, authorizationRef: 'single-2', amount: amt('5') });
    expect(second).toMatchObject({ decision: 'declined', declineCode: 'bank.card_use_limit_reached' });
    await cards.capture({ cardId: card.id, authorizationRef: 'single-1', amount: amt('5') });
    expect((await cards.card(card.id)).status).toBe('closed');
    expect(await cards.usesMade(card.id)).toBe(1);
    const third = await cards.authorize({ cardId: card.id, authorizationRef: 'single-3', amount: amt('1') });
    expect(third).toMatchObject({ decision: 'declined', declineCode: 'bank.card_not_active' });
    expect(await available()).toBe(amt('95'));
  });

  it('frees a single-use card’s use when its only hold is reversed whole', async () => {
    await accept();
    const card = await virtual({ usesAllowed: 1 });
    await cards.authorize({ cardId: card.id, authorizationRef: 'void-1', amount: amt('5') });
    await cards.reverse({ cardId: card.id, authorizationRef: 'void-1' });
    const next = await cards.authorize({ cardId: card.id, authorizationRef: 'void-2', amount: amt('5') });
    expect(next.decision).toBe('approved');
  });

  it('keeps a physical card inactive until it is activated, and declines it by name before then', async () => {
    await accept();
    const card = await physical();
    expect(card.activatedAt).toBeNull();
    const before = await cards.authorize({ cardId: card.id, authorizationRef: 'inactive-1', amount: amt('1') });
    expect(before).toMatchObject({ decision: 'declined', declineCode: 'bank.card_not_active' });
    const activated = await cards.activate({ cardId: card.id, userId: user });
    expect(activated.activatedAt).toBeInstanceOf(Date);
    const again = await cards.activate({ cardId: card.id, userId: user });
    expect(again.activatedAt?.getTime()).toBe(activated.activatedAt?.getTime());
    await expect(cards.activate({ cardId: card.id, userId: randomUUID() })).rejects.toMatchObject({ code: 'bank.card_not_found' });
    const after = await cards.authorize({ cardId: card.id, authorizationRef: 'inactive-2', amount: amt('1') });
    expect(after.decision).toBe('approved');
  });

  it('changes the address before print with the old one kept, and refuses once produced', async () => {
    await accept();
    const card = await physical();
    const moved = { ...ADDRESS, line1: '9 TEST Allee', city: 'Hamburg' };
    const requestId = randomUUID();
    const changed = await orders.updateShipping({ userId: user, cardId: card.id, requestId, address: moved });
    expect(changed.address.line1).toBe('9 TEST Allee');
    expect(changed.history.map((h) => h.address.line1)).toEqual(['1 TEST Strasse']);
    const replay = await orders.updateShipping({ userId: user, cardId: card.id, requestId, address: moved });
    expect(replay.history).toHaveLength(1);
    await orders.recordShipment({ cardId: card.id, state: 'produced' });
    await expect(orders.updateShipping({ userId: user, cardId: card.id, requestId: randomUUID(), address: ADDRESS })).rejects.toMatchObject(
      { code: 'bank.card_address_locked' },
    );
    await expect(orders.recordShipment({ cardId: card.id, state: 'ordered' })).rejects.toMatchObject({ code: 'bank.card_shipment_order' });
    expect((await orders.delivery(user, card.id)).address.line1).toBe('9 TEST Allee');
  });

  it('names hardware as not connected on every delivery read, and shows the carrier and number the printer reports', async () => {
    await accept();
    const card = await physical();
    expect(await orders.delivery(user, card.id)).toMatchObject({
      state: 'ordered',
      carrier: null,
      trackingRef: null,
      notConnected: 'hardware',
    });
    await orders.recordShipment({ cardId: card.id, state: 'produced' });
    await orders.recordShipment({ cardId: card.id, state: 'shipped', carrier: 'TEST Post', trackingRef: 'TEST-1' });
    expect(await orders.delivery(user, card.id)).toMatchObject({
      state: 'shipped',
      carrier: 'TEST Post',
      trackingRef: 'TEST-1',
      notConnected: 'hardware',
    });
  });

  it('on a lost report closes the card once, reverses its open hold once, and leaves one new inactive card', async () => {
    await accept();
    const card = await physical();
    await cards.activate({ cardId: card.id, userId: user });
    const hold = await cards.authorize({ cardId: card.id, authorizationRef: 'lost-1', amount: amt('3') });
    expect(await available()).toBe(amt('97'));
    const replacementId = randomUUID();
    const fresh = await cards.replace({ cardId: card.id, userId: user, replacementId, reason: 'stolen' });
    await orders.afterReplace(fresh);
    expect(fresh).toMatchObject({ id: replacementId, replacesCardId: card.id, cardType: 'physical', activatedAt: null });
    expect(await cards.card(card.id)).toMatchObject({ status: 'closed', replacedByCardId: replacementId });
    expect(await available()).toBe(amt('100'));
    expect((await ledger.balance(withdrawalHoldAccount(user, 'USDT', hold.id))).amount).toBe(0n);
    const retry = await cards.replace({ cardId: card.id, userId: user, replacementId, reason: 'stolen' });
    expect(retry.id).toBe(replacementId);
    expect(await sql`SELECT id FROM bank.cards WHERE user_id = ${user}`).toHaveLength(2);
    expect(await available()).toBe(amt('100'));
    expect((await orders.delivery(user, replacementId)).state).toBe('ordered');
  });
});
