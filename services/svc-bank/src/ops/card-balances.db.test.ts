/**
 * BK-cops-04 `ops.cardBalances` (#5787's shape): ledger, available and pending per card asset for one customer, read from
 * the ledger. Enters through the router svc-edge serves at /api/bank. Uses TEST_DATABASE_URL. Does not start Docker.
 * All amounts are TEST values.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { cardSim } from '../cards/issuer.js';
import { fixedPriceSource } from '../loans/prices.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const BIZ = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[]) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

const NOW = new Date('2026-10-22T08:00:00Z');

describe('ops.cardBalances (BK-cops-04): card funds read from the ledger', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      cards: {
        issuer: cardSim(),
        rates: {
          marks: async () => new Map([['BTC', { assetId: 'BTC', price: parseAmount('50000'), asOf: NOW, quality: 'mid' as const }]]),
        },
        clock: () => NOW,
      },
      loans: { priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
    });
  }

  it('pending is what the ledger still holds for the card; available and ledger are the customer main balance', async () => {
    const bank = services();
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'seed:usdt' }));
    const card = await bank.cards.issue({
      cardId: randomUUID(),
      userId: OWNER,
      assetId: 'USDT',
      perAuthorizationLimit: parseAmount('1000'),
    });
    await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-a1', amount: parseAmount('30') });
    await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-a2', amount: parseAmount('20') });
    await bank.cards.capture({ cardId: card.id, authorizationRef: 'TEST-a2', amount: parseAmount('20') });

    const out = await caller(bank, OPERATOR, ['admin:treasury']).ops.cardBalances({ scope: { kind: 'individual', userId: OWNER } });
    expect(out.scope).toEqual({ kind: 'individual', userId: OWNER });
    expect(out.rows).toEqual([{ assetCode: 'USDT', ledger: '80', available: '50', pending: '30' }]);
    expect(Number.isNaN(Date.parse(out.readAt))).toBe(false);
  });

  it('filters by asset; a customer with no card has no rows', async () => {
    const bank = services();
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('5'), rail: 'test', railRef: 'seed:u5' }));
    await bank.cards.issue({ cardId: randomUUID(), userId: OWNER, assetId: 'USDT', perAuthorizationLimit: parseAmount('10') });
    const op = caller(bank, OPERATOR, ['admin:treasury']);
    expect((await op.ops.cardBalances({ scope: { kind: 'individual', userId: OWNER }, assetCode: 'BTC' })).rows).toEqual([]);
    expect((await op.ops.cardBalances({ scope: { kind: 'individual', userId: OWNER }, assetCode: 'USDT' })).rows).toEqual([
      { assetCode: 'USDT', ledger: '5', available: '5', pending: '0' },
    ]);
    expect((await op.ops.cardBalances({ scope: { kind: 'individual', userId: STRANGER } })).rows).toEqual([]);
  });

  it('programme and business scopes refuse bank.card_funds_scope_unwired; no aggregate is invented', async () => {
    const op = caller(services(), OPERATOR, ['admin:treasury']);
    for (const scope of [{ kind: 'programme' as const }, { kind: 'business' as const, businessId: BIZ }]) {
      await expect(op.ops.cardBalances({ scope })).rejects.toMatchObject({
        message: expect.stringMatching(/bank\.card_funds_scope_unwired/),
      });
    }
  });

  it('needs admin:treasury; a customer session or admin:read is refused', async () => {
    const bank = services();
    for (const scopes of [['admin:read'], ['bank:read']]) {
      await expect(caller(bank, OPERATOR, scopes).ops.cardBalances({ scope: { kind: 'individual', userId: OWNER } })).rejects.toBeTruthy();
    }
  });
});
