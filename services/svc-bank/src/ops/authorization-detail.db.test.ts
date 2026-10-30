/**
 * BK-cops-01 `ops.authorizationGet`: one card authorisation for the support agent.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const STRANGER = '66666666-6666-4666-8666-666666666666';
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

describe('ops.authorizationGet (BK-cops-01)', () => {
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

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      cards: { issuer: cardSim() },
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
    });
  }

  async function seed(bank: BankServices) {
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'seed:1' }));
    const card = await bank.cards.issue({
      cardId: randomUUID(),
      userId: OWNER,
      assetId: 'USDT',
      perAuthorizationLimit: parseAmount('1000'),
    });
    const approved = await bank.cards.authorize({
      cardId: card.id,
      authorizationRef: 'TEST-auth-ok',
      amount: parseAmount('40'),
      merchantCategory: '5812',
    });
    const declined = await bank.cards.authorize({ cardId: card.id, authorizationRef: 'TEST-auth-nsf', amount: parseAmount('500') });
    return { card, approved, declined };
  }

  it('returns the stored decision and names every field card-sim does not have', async () => {
    const bank = services();
    const { card, approved, declined } = await seed(bank);
    const before = await sql`SELECT count(*)::int AS n FROM bank.card_authorizations`;
    const ops = caller(bank, OPERATOR, ['admin:compliance']).ops;

    const ok = await ops.authorizationGet({ id: approved.id });
    expect(ok).toMatchObject({
      id: approved.id,
      cardId: card.id,
      userId: OWNER,
      authorizationRef: 'TEST-auth-ok',
      amount: '40',
      merchantCategory: '5812',
      decision: 'approved',
      declineCode: null,
      status: approved.status,
      conversion: null,
    });
    expect(ok.holdLedgerTxId).not.toBeNull();
    expect(ok.notAvailable.map((f) => f.field)).toEqual([
      'merchantName',
      'merchantCountry',
      'networkData',
      'method',
      'cardPresence',
      'initiator',
      'type',
    ]);
    for (const f of ok.notAvailable) expect(f.reason).toBe('not available on card-sim');

    const no = await ops.authorizationGet({ id: declined.id });
    expect(no.decision).toBe('declined');
    expect(no.declineCode).toBe(declined.declineCode);
    expect(no.declineCode).not.toBeNull();
    expect(no.status).toBe(declined.status);
    expect(no.holdLedgerTxId).toBeNull();

    const after = await sql`SELECT count(*)::int AS n FROM bank.card_authorizations`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('answers an unknown and a malformed id with the same not-found', async () => {
    const ops = caller(services(), OPERATOR, ['admin:compliance']).ops;
    await expect(ops.authorizationGet({ id: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ops.authorizationGet({ id: 'not-an-id' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a caller without the compliance scope, including the card holder', async () => {
    const bank = services();
    const { approved } = await seed(bank);
    await expect(caller(bank, OWNER, ['bank:read']).ops.authorizationGet({ id: approved.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller(bank, STRANGER, ['admin:treasury']).ops.authorizationGet({ id: approved.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses extra input fields at validation', async () => {
    const ops = caller(services(), OPERATOR, ['admin:compliance']).ops;
    await expect(ops.authorizationGet({ id: randomUUID(), userId: OWNER } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
