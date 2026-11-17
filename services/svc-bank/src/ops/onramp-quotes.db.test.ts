/**
 * Fiat buy prices for finance (J-cex-spot-17 #8): `ops.onrampQuotes` lists the on-ramp quotes customers were given,
 * newest first, with their exact amounts. Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { testPartner } from '../partner/test-partner.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const SID = '99999999-9999-4999-8999-999999999999';

function caller(bank: BankServices, userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank).createCaller(
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

describe('operator fiat buy quotes', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

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
    await sql`TRUNCATE bank.add_money_requests, bank.ramp_onramp_quotes RESTART IDENTITY CASCADE`;
  });

  const services = (options: { testPartner?: ReturnType<typeof testPartner> } = {}): BankServices => {
    const ledger = new MemoryLedger();
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', ...options });
  };

  async function quote(userId: string, createdAt: string, fee: string): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO bank.ramp_onramp_quotes (
        user_id, asset_id, amount, method, country, pay_amount, fee, rate, pay_currency, expires_at, simulated, created_at
      ) VALUES (
        ${userId}, 'USDT', '50', 'card', 'NL', '46.000000000000000001', ${fee}, '0.92', 'EUR',
        ${new Date(Date.parse(createdAt) + 60_000)}, true, ${createdAt}
      ) RETURNING id::text`;
    return row!.id;
  }

  it('lists every customer’s fiat buy quotes newest first, with the exact amounts as quoted', async () => {
    const older = await quote(ADA, '2026-11-06T09:00:00.000Z', '0.5');
    const newer = await quote(BOB, '2026-11-06T09:30:00.000Z', '1.250000000000000001');
    const rows = await caller(services(), OPERATOR, ['admin:read']).ops.onrampQuotes({ limit: 10 });
    expect(rows.map((r) => r.quoteId)).toEqual([newer, older]);
    expect(rows[0]).toEqual({
      quoteId: newer,
      userId: BOB,
      assetId: 'USDT',
      amount: '50',
      method: 'card',
      country: 'NL',
      payAmount: '46.000000000000000001',
      fee: '1.250000000000000001',
      rate: '0.92',
      payCurrency: 'EUR',
      simulated: true,
      createdAt: '2026-11-06T09:30:00.000Z',
      expiresAt: '2026-11-06T09:31:00.000Z',
    });
    expect(await caller(services(), OPERATOR, ['admin:read']).ops.onrampQuotes({ limit: 1 })).toHaveLength(1);
  });

  it('refuses a read with no page size, and a caller who is not an operator', async () => {
    for (const limit of [undefined, 0, 101]) {
      await expect(
        caller(services(), OPERATOR, ['admin:read']).ops.onrampQuotes(limit === undefined ? {} : { limit }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('bank.onramp_quotes_limit_unset') });
    }
    await expect(caller(services(), ADA, ['bank:read']).ops.onrampQuotes({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  async function asked(userId: string, createdAt: string, refusal: string | null, quoteId: string | null = null): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO bank.add_money_requests (id, user_id, asset_id, amount, method, country, rail, status, refusal_code, quote_id, created_at)
      VALUES (${id}, ${userId}, 'USDT', '20.000000000000000001', 'bank_transfer', 'NL', 'rail.bank',
              ${refusal ? 'refused' : 'opening'}, ${refusal}, ${quoteId}, ${createdAt})`;
    return id;
  }

  it('lists the buys the partner gave no fee for, newest first, as "not known": no fee, pay amount or rate is read', async () => {
    const older = await asked(ADA, '2026-11-06T09:00:00.000Z', 'bank.onramp_fee_not_known');
    const newer = await asked(BOB, '2026-11-06T09:30:00.000Z', 'bank.onramp_fee_not_known');
    // Refused for another reason, or quoted and opening: neither is a fee the partner did not give.
    await asked(ADA, '2026-11-06T09:40:00.000Z', 'bank.onramp_rate_unset');
    await asked(ADA, '2026-11-06T09:50:00.000Z', null, await quote(ADA, '2026-11-06T09:50:00.000Z', '1'));
    // A request whose quote was kept has a fee the partner gave, whatever refused it later: it is in the priced list.
    await asked(BOB, '2026-11-06T09:55:00.000Z', 'bank.onramp_fee_not_known', await quote(BOB, '2026-11-06T09:55:00.000Z', '1'));
    const read = await caller(services(), OPERATOR, ['admin:read']).ops.onrampFeesNotKnown({ limit: 10 });
    // No TEST partner is wired here, so nothing is labelled TEST.
    expect(read.testPartner).toBeNull();
    const rows = read.rows;
    expect(rows.map((r) => r.requestId)).toEqual([newer, older]);
    expect(rows[0]).toEqual({
      requestId: newer,
      userId: BOB,
      assetId: 'USDT',
      amount: '20.000000000000000001',
      method: 'bank_transfer',
      country: 'NL',
      refusalCode: 'bank.onramp_fee_not_known',
      createdAt: '2026-11-06T09:30:00.000Z',
    });
    expect(rows[0]).not.toHaveProperty('fee');
    expect((await caller(services(), OPERATOR, ['admin:read']).ops.onrampFeesNotKnown({ limit: 1 })).rows).toHaveLength(1);
  });

  it("labels the list TEST when the local stack's TEST partner ramp is the one that gave no fee", async () => {
    await asked(ADA, '2026-11-06T09:00:00.000Z', 'bank.onramp_fee_not_known');
    const read = await caller(services({ testPartner: testPartner() }), OPERATOR, ['admin:read']).ops.onrampFeesNotKnown({ limit: 10 });
    expect(read.testPartner).toBe('TEST partner bank');
    expect(read.rows).toHaveLength(1);
  });

  it('refuses a not-known read with no page size, and a caller who is not an operator', async () => {
    for (const limit of [undefined, 0, 101]) {
      await expect(
        caller(services(), OPERATOR, ['admin:read']).ops.onrampFeesNotKnown(limit === undefined ? {} : { limit }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('bank.onramp_quotes_limit_unset') });
    }
    await expect(caller(services(), ADA, ['bank:read']).ops.onrampFeesNotKnown({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
