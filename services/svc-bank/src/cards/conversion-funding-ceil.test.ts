/**
 * L1108 — card_conversions.funding_amount is the smallest numeric(38,18) that
 * is at least settlement / rate, the same value as div(settlement, rate, 'ceil').
 *
 * 0007 says funding_amount is the ceil of settlement / rate, and only checks
 * that settlement_amount, funding_amount, and rate are positive. A frozen quote
 * can disagree with the recorded rate and still store.
 *
 * A whole-unit ceil(settlement_amount / rate) is a different number. The check
 * multiplies only. Numeric division rounds to 18 fractional digits before ceil,
 * so a rounded quotient is not that ceiling.
 *
 * H8a PG-hard: this file never describe.skip / postgresAvailable. The admin
 * URL is TEST_DATABASE_URL. Docker/PG down is a failed suite, not a green skip.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { div, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const CHECK_VIOLATION = '23514';
const FUNDING_CEIL = 'card_conversions_funding_ceil';
const H8A_IMAGE = 'postgres:16-alpine';

/** Decimal fixtures. 1/3 ceilings at the 18th place, not at the next whole unit. */
const SETTLEMENT = '1';
const RATE = '3';
const WHOLE_UNIT_CEIL = '1';
const SCALED_CEILING = '0.333333333333333334';
/**
 * Numeric division of this pair rounds to 18 fractional digits before ceil and
 * lands one attounit under div(..., 'ceil').
 */
const NEAR_SETTLEMENT = '2.999999999999999998';
const NEAR_RATE = '3.000000000000000001';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

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
      `H8a: svc-bank conversion-funding-ceil is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('card conversion funding amount is the scaled ceiling', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function authorizationId(): Promise<string> {
    const cards = await sql<Array<{ id: string }>>`
      INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit)
      VALUES (${USER}, 'USDT', 'USD', 'card-sim', ${`ceil-${randomUUID()}`}, '4242', ${'100'}::numeric)
      RETURNING id
    `;
    const auths = await sql<Array<{ id: string }>>`
      INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, decision)
      VALUES (${cards[0]!.id}, ${`auth-${randomUUID()}`}, ${SETTLEMENT}::numeric, 'approved')
      RETURNING id
    `;
    return auths[0]!.id;
  }

  it('rejects a funding amount that is not the scaled ceiling', async () => {
    const authorization = await authorizationId();
    await expect(sql`
      INSERT INTO bank.card_conversions (
        authorization_id, settlement_asset_id, settlement_amount, funding_asset_id,
        funding_amount, rate, rate_quality, rate_as_of
      )
      VALUES (
        ${authorization}, 'USD', ${SETTLEMENT}::numeric, 'USDT',
        ${WHOLE_UNIT_CEIL}::numeric, ${RATE}::numeric, 'mid', now()
      )
    `).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: FUNDING_CEIL });

    const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.card_conversions`;
    expect(count[0]!.n).toBe(0);
  });

  it('stores a funding amount that is the scaled ceiling of settlement / rate', async () => {
    const settlementAmount: Amount = parseAmount(SETTLEMENT);
    const rateAmount: Amount = parseAmount(RATE);
    const fundingAmount: Amount = div(settlementAmount, rateAmount, 'ceil');
    const funding = formatAmount(fundingAmount);
    expect(funding).toBe(SCALED_CEILING);

    const authorization = await authorizationId();
    const stored = await sql<Array<{ funding_amount: string; settlement_amount: string; rate: string }>>`
      INSERT INTO bank.card_conversions (
        authorization_id, settlement_asset_id, settlement_amount, funding_asset_id,
        funding_amount, rate, rate_quality, rate_as_of
      )
      VALUES (
        ${authorization}, 'USD', ${SETTLEMENT}::numeric, 'USDT',
        ${funding}::numeric, ${RATE}::numeric, 'mid', now()
      )
      RETURNING funding_amount::text AS funding_amount, settlement_amount::text AS settlement_amount, rate::text AS rate
    `;
    expect(typeof stored[0]!.funding_amount).toBe('string');
    expect(parseAmount(stored[0]!.funding_amount)).toBe(fundingAmount);
    expect(parseAmount(stored[0]!.settlement_amount)).toBe(settlementAmount);
    expect(parseAmount(stored[0]!.rate)).toBe(rateAmount);
    expect(formatAmount(parseAmount(stored[0]!.funding_amount))).toBe(funding);
  });

  it('stores the ceiling when numeric division would round under div ceil', async () => {
    const settlementAmount: Amount = parseAmount(NEAR_SETTLEMENT);
    const rateAmount: Amount = parseAmount(NEAR_RATE);
    const fundingAmount: Amount = div(settlementAmount, rateAmount, 'ceil');
    const funding = formatAmount(fundingAmount);

    const authorization = await authorizationId();
    const stored = await sql<Array<{ funding_amount: string; settlement_amount: string; rate: string }>>`
      INSERT INTO bank.card_conversions (
        authorization_id, settlement_asset_id, settlement_amount, funding_asset_id,
        funding_amount, rate, rate_quality, rate_as_of
      )
      VALUES (
        ${authorization}, 'USD', ${NEAR_SETTLEMENT}::numeric, 'USDT',
        ${funding}::numeric, ${NEAR_RATE}::numeric, 'mid', now()
      )
      RETURNING funding_amount::text AS funding_amount, settlement_amount::text AS settlement_amount, rate::text AS rate
    `;
    expect(typeof stored[0]!.funding_amount).toBe('string');
    expect(parseAmount(stored[0]!.funding_amount)).toBe(fundingAmount);
    expect(parseAmount(stored[0]!.settlement_amount)).toBe(settlementAmount);
    expect(parseAmount(stored[0]!.rate)).toBe(rateAmount);
    expect(formatAmount(parseAmount(stored[0]!.funding_amount))).toBe(funding);
  });

  it('rejects one attounit under that ceiling and stores no row', async () => {
    const fundingAmount: Amount = div(parseAmount(NEAR_SETTLEMENT), parseAmount(NEAR_RATE), 'ceil');
    const under = formatAmount(fundingAmount - 1n);

    const authorization = await authorizationId();
    await expect(sql`
      INSERT INTO bank.card_conversions (
        authorization_id, settlement_asset_id, settlement_amount, funding_asset_id,
        funding_amount, rate, rate_quality, rate_as_of
      )
      VALUES (
        ${authorization}, 'USD', ${NEAR_SETTLEMENT}::numeric, 'USDT',
        ${under}::numeric, ${NEAR_RATE}::numeric, 'mid', now()
      )
    `).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: FUNDING_CEIL });

    const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.card_conversions`;
    expect(count[0]!.n).toBe(0);
  });
});
