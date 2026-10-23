/**
 * Home's work list, the bank's part (HM-dashboard-03): `workItems.list` through the mounted router, derived from the
 * signed person's own loans and cards and parsed by the shared contract. Records are TEST fixtures written straight to
 * the bank's tables. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, ownsAll, signPrincipalHeader, workItemsOutputSchema } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { bpsRatio } from './work-items.js';

const SECRET = 'bank-work-items-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

describe('bank work items (HM-dashboard-03)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let product: string;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.loan_margin_calls, bank.loans, bank.loan_products, bank.cards RESTART IDENTITY CASCADE`;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO bank.loan_products (
        name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps, margin_call_ltv_bps,
        liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, grace_seconds
      ) VALUES ('TEST loan', 'USDT', 'BTC', 'USDT', 800, 5000, 7500, 8500, 9500, 4000, 500, 5000, 86400)
      RETURNING id
    `;
    product = rows[0]!.id;
  });

  function as(userId: string, delegated: Partial<Pick<Principal, 'kid' | 'sub_account'>> = {}) {
    const bank = createBankServices(sql, new MemoryLedger(), memoryLedgerHistory(new MemoryLedger()));
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes: ['bank:read'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
      ...delegated,
    } as Principal);
    return createBankRouter(bank).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  async function loan(userId: string, status: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal, status)
      VALUES (${product}::uuid, ${userId}, 'USDT', 'BTC', 'USDT', 800, '1000', ${status})
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function call(loanId: string, sequence: number, ltvBps: number, cure: string, graceHours: number, cleared = false) {
    await sql`
      INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, grace_expires_at, cleared_at)
      VALUES (${loanId}::uuid, ${sequence}, ${ltvBps}, ${cure}::numeric, now() + make_interval(hours => ${graceHours}),
              ${cleared ? sql`now()` : null})
    `;
  }

  async function card(userId: string, status: string, frozenBy: string | null): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit, status, frozen_by)
      VALUES (${userId}, 'USDT', 'USDT', 'card-sim', ${`TEST-${randomUUID()}`}, '4242', '100', ${status}, ${frozenBy})
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it('nothing owed is an empty list', async () => {
    await loan(ADA, 'active');
    await card(ADA, 'active', null);
    expect(await as(ADA).workItems.list()).toEqual({ items: [] });
  });

  it('a loan in a margin call is the borrower’s to cure: due when the grace ends, with the collateral and the call’s LTV', async () => {
    const id = await loan(ADA, 'margin_call');
    await call(id, 1, 7600, '0.5', 2, true);
    await call(id, 2, 7812, '0.125000000000000000', 6);
    const { items } = await as(ADA).workItems.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `margin_health:${id}`,
      kind: 'margin_health',
      source: 'bank',
      severity: 'action',
      titleKey: 'bank.margin.call_open',
      link: '/bank/loans',
      amount: { value: '0.125', asset: 'BTC' },
      ratio: '0.7812',
    });
    const [newest] = await sql<{ grace_expires_at: Date }[]>`
      SELECT grace_expires_at FROM bank.loan_margin_calls WHERE loan_id = ${id}::uuid AND sequence = 2
    `;
    expect(items[0]!.dueAt).toBe(newest!.grace_expires_at.toISOString());
  });

  it('a liquidating loan is a warning; a cleared call, a repaid loan or an active loan with no call is nothing', async () => {
    const liquidating = await loan(ADA, 'liquidating');
    await call(liquidating, 1, 8600, '1', 1);
    await loan(ADA, 'active');
    const cured = await loan(ADA, 'active');
    await call(cured, 1, 7600, '0.2', 1, true);
    const repaid = await loan(ADA, 'repaid');
    await call(repaid, 1, 7600, '0.2', 1);
    const { items } = await as(ADA).workItems.list();
    expect(items.map((item) => [item.id, item.severity, item.titleKey])).toEqual([
      [`margin_health:${liquidating}`, 'warning', 'bank.margin.liquidating'],
    ]);
  });

  it('an open call whose loan status has not moved yet is still the borrower’s to cure', async () => {
    const id = await loan(ADA, 'active');
    await call(id, 1, 7600, '0.2', 3);
    expect((await as(ADA).workItems.list()).items).toMatchObject([{ id: `margin_health:${id}`, severity: 'action' }]);
  });

  it('a frozen card: frozen by them is theirs to lift, frozen by the bank they wait; closed and active cards are nothing', async () => {
    const mine = await card(ADA, 'frozen', 'owner');
    const banks = await card(ADA, 'frozen', 'operator');
    const unrecorded = await card(ADA, 'frozen', null);
    await card(ADA, 'closed', null);
    await card(ADA, 'active', null);
    const { items } = await as(ADA).workItems.list();
    expect(items).toEqual([
      {
        id: `card_frozen:${mine}`,
        kind: 'card_frozen',
        source: 'bank',
        severity: 'action',
        titleKey: 'bank.card.frozen_by_you',
        link: '/bank/cards',
        reasonCode: 'bank.card_frozen_by_owner',
      },
      {
        id: `card_frozen:${banks}`,
        kind: 'card_frozen',
        source: 'bank',
        severity: 'info',
        titleKey: 'bank.card.frozen_by_bank',
        link: '/bank/cards',
        reasonCode: 'bank.card_frozen_by_operator',
      },
      // Frozen before the bank recorded who froze it: the owner may lift it, so it is theirs, with no reason invented.
      {
        id: `card_frozen:${unrecorded}`,
        kind: 'card_frozen',
        source: 'bank',
        severity: 'action',
        titleKey: 'bank.card.frozen',
        link: '/bank/cards',
      },
    ]);
  });

  it('only the signed person’s own records, only bank kinds, never a loan payment, and the answer parses as the contract', async () => {
    const bobs = await loan(BOB, 'margin_call');
    await call(bobs, 1, 7600, '0.3', 3);
    await card(BOB, 'frozen', 'owner');
    const adas = await loan(ADA, 'margin_call');
    await call(adas, 1, 7700, '0.4', 4);
    await card(ADA, 'frozen', 'operator');

    const ada = await as(ADA).workItems.list();
    expect(workItemsOutputSchema.safeParse(ada).success).toBe(true);
    expect(ownsAll('bank', ada)).toBe(true);
    expect(ada.items.map((item) => item.kind).sort()).toEqual(['card_frozen', 'margin_health']);
    expect(ada.items.some((item) => item.id.includes(bobs))).toBe(false);
    expect(ada.items.some((item) => item.kind === 'loan_payment_due')).toBe(false);
    expect((await as(BOB).workItems.list()).items.map((item) => item.kind).sort()).toEqual(['card_frozen', 'margin_health']);
  });

  it('an API key or a sub-account has no Home of its own: refused, and nothing of the owner’s is read out', async () => {
    await card(ADA, 'frozen', 'owner');
    for (const delegated of [{ kid: 'TEST-api-key' }, { sub_account: '33333333-3333-4333-8333-333333333333' }]) {
      const err = await as(ADA, delegated)
        .workItems.list()
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('bank.work_items_delegated') });
    }
    expect((await as(ADA).workItems.list()).items).toHaveLength(1);
  });

  it('a margin warning level is never assumed: an active loan near its call band, with no call, lists nothing', async () => {
    const id = await loan(ADA, 'active');
    await sql`UPDATE bank.loans SET margin_call_ltv_bps = 7500, last_mark_price = '1', last_marked_at = now() WHERE id = ${id}::uuid`;
    expect((await as(ADA).workItems.list()).items).toEqual([]);
  });

  it('basis points read as the contract’s ratio', () => {
    expect([0, 1, 7500, 7812, 10_000, 12_345].map(bpsRatio)).toEqual(['0', '0.0001', '0.75', '0.7812', '1', '1.2345']);
    expect(() => bpsRatio(-1)).toThrow();
  });
});
