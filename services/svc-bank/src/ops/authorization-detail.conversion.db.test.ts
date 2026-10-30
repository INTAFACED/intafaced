/**
 * BK-cops-01 `ops.authorizationGet`: the asset of the amount, both legs of a
 * conversion, the audit line and the id length bound.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
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

describe('ops.authorizationGet (BK-cops-01): asset, conversion legs, audit, id bound', () => {
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
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
    });
  }

  it('returns both legs of a conversion and the funding asset of the amount', async () => {
    const bank = services();
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'BTC', amount: parseAmount('1'), rail: 'test', railRef: 'seed:btc' }));
    const card = await bank.cards.issue({
      cardId: randomUUID(),
      userId: OWNER,
      assetId: 'BTC',
      settlementAssetId: 'USDT',
      perAuthorizationLimit: parseAmount('1'),
    });
    const auth = await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-auth-fx', amount: parseAmount('100') });
    expect(auth.decision).toBe('approved');

    const got = await caller(bank, OPERATOR, ['admin:compliance']).ops.authorizationGet({ id: auth.id });
    expect(got.assetId).toBe('BTC');
    expect(got.amount).toBe('0.002');
    expect(got.conversion).toEqual({
      settlementAssetId: 'USDT',
      settlementAmount: '100',
      fundingAssetId: 'BTC',
      fundingAmount: '0.002',
      rate: '50000',
      rateQuality: 'mid',
      rateAsOf: NOW.toISOString(),
    });
  });

  it('names the card asset on a same-asset card, approved or declined', async () => {
    const bank = services();
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'seed:usdt' }));
    const card = await bank.cards.issue({
      cardId: randomUUID(),
      userId: OWNER,
      assetId: 'USDT',
      perAuthorizationLimit: parseAmount('1000'),
    });
    const ok = await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-auth-ok', amount: parseAmount('40') });
    const no = await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-auth-nsf', amount: parseAmount('500') });
    const ops = caller(bank, OPERATOR, ['admin:compliance']).ops;

    expect(await ops.authorizationGet({ id: ok.id })).toMatchObject({ assetId: 'USDT', amount: '40', conversion: null });
    expect(await ops.authorizationGet({ id: no.id })).toMatchObject({
      assetId: 'USDT',
      decision: 'declined',
      holdLedgerTxId: null,
      conversion: null,
    });
  });

  it('writes one audit line with the actor and the id', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const id = randomUUID();
    await expect(caller(services(), OPERATOR, ['admin:compliance']).ops.authorizationGet({ id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const lines = info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('bank.ops.authorization_read'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([{ level: 'info', service: 'svc-bank', event: 'bank.ops.authorization_read', actorUserId: OPERATOR, id }]);
  });

  it('refuses an id longer than 64 characters at validation and logs nothing for it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(caller(services(), OPERATOR, ['admin:compliance']).ops.authorizationGet({ id: 'x'.repeat(65) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(info.mock.calls.some((c) => String(c[0]).includes('bank.ops.authorization_read'))).toBe(false);
  });
});
