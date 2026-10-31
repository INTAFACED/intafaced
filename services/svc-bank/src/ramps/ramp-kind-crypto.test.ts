/**
 * L1107 — ramp_onramps and ramp_offramps are the crypto ledger half only.
 *
 * 0004 left ramp_kind as ('crypto', 'fiat') and defaulted kind to crypto
 * without checking it, so a fiat onramp or offramp could be stored. A direct
 * insert of kind fiat is refused. Kind crypto still stores. A service caller
 * that passes kind fiat gets bank.fiat_ramp_socket before any row and before
 * any ledger post.
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
import { MemoryLedger, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PayFiatRampPort } from './pay-fiat-adapter.js';
import { RampService } from './ramp-service.js';
import { CRYPTO_LEDGER_PROGRAMME } from './rails.js';
import { memorySecurityLock } from '../security-lock.js';

// The owner's destination sanctions list, a TEST entry for this file: without one every save and send refuses
// bank.destination_sanctions_unset. No address these tests use is on it.
const sanctionsBefore = process.env.BANK_DESTINATION_SANCTIONS;
beforeAll(() => {
  process.env.BANK_DESTINATION_SANCTIONS = '*:0x5a7c7100000000000000000000000000000ba5ed';
});
afterAll(() => {
  if (sanctionsBefore === undefined) delete process.env.BANK_DESTINATION_SANCTIONS;
  else process.env.BANK_DESTINATION_SANCTIONS = sanctionsBefore;
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CHECK_VIOLATION = '23514';
const ONRAMP_KIND = 'ramp_onramps_kind_crypto_ck';
const OFFRAMP_KIND = 'ramp_offramps_kind_crypto_ck';
const H8A_IMAGE = 'postgres:16-alpine';

const livePay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
};

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
      `H8a: svc-bank ramp-kind-crypto is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('ramp tables are the crypto ledger half only', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let ramps: RampService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    process.env.BANK_OFFRAMP_COOLING_HOURS = '0';
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    ramps = new RampService(sql, ledger, { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses a direct insert of kind fiat on ramp_onramps', async () => {
    await expect(sql`
      INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, kind, rail, rail_ref, credited_by)
      VALUES (${USER}, 'USDT', ${'1.00'}::numeric, 'fiat', 'bank-crypto-ledger', ${`fiat-on-${randomUUID()}`}, ${OPERATOR})
    `).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: ONRAMP_KIND });

    const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(count[0]!.n).toBe(0);
  });

  it('refuses a direct insert of kind fiat on ramp_offramps', async () => {
    await expect(sql`
      INSERT INTO bank.ramp_offramps (user_id, asset_id, amount, kind, rail, destination_ref, client_ref)
      VALUES (
        ${USER}, 'USDT', ${'1.00'}::numeric, 'fiat', 'bank-crypto-ledger',
        '0x000000000000000000000000000000000000dEaD', ${`fiat-off-${randomUUID()}`}
      )
    `).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: OFFRAMP_KIND });

    const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
    expect(count[0]!.n).toBe(0);
  });

  it('stores kind crypto on both ramp tables', async () => {
    const onramps = await sql<Array<{ kind: string; amount: string }>>`
      INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, kind, rail, rail_ref, credited_by)
      VALUES (${USER}, 'USDT', ${'1.00'}::numeric, 'crypto', 'bank-crypto-ledger', ${`crypto-on-${randomUUID()}`}, ${OPERATOR})
      RETURNING kind, amount::text AS amount
    `;
    expect(onramps[0]!.kind).toBe('crypto');
    expect(onramps[0]!.amount.startsWith('1')).toBe(true);
    expect(typeof onramps[0]!.amount).toBe('string');

    const offramps = await sql<Array<{ kind: string; amount: string }>>`
      INSERT INTO bank.ramp_offramps (user_id, asset_id, amount, kind, rail, destination_ref, client_ref)
      VALUES (
        ${USER}, 'USDT', ${'2.50'}::numeric, 'crypto', 'bank-crypto-ledger',
        '0x000000000000000000000000000000000000dEaD', ${`crypto-off-${randomUUID()}`}
      )
      RETURNING kind, amount::text AS amount
    `;
    expect(offramps[0]!.kind).toBe('crypto');
    expect(offramps[0]!.amount.startsWith('2.5')).toBe(true);
    expect(typeof offramps[0]!.amount).toBe('string');
  });

  it('refuses a fiat onramp with bank.fiat_ramp_socket and posts nothing', async () => {
    await expect(
      ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        kind: 'fiat',
        railRef: `ach-in-${randomUUID()}`,
        creditedBy: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });

    const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(count[0]!.n).toBe(0);
    expect(ledger.journal()).toHaveLength(0);
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('0'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a fiat offramp with bank.fiat_ramp_socket and posts nothing', async () => {
    const offrampId = randomUUID();
    await expect(
      ramps.offramp({
        offrampId,
        userId: USER,
        assetId: 'USDT',
        amount: amt('15'),
        kind: 'fiat',
        destinationRef: 'GB82WEST12345698765432',
        clientRef: `fiat-out-${offrampId}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });

    const counts = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bank.ramp_offramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.ramp_onramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.user_withdraw_destinations
    `;
    expect(counts.every((row) => row.n === 0)).toBe(true);
    expect(ledger.journal()).toHaveLength(0);
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('0'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('stores and settles a crypto onramp and a crypto offramp', async () => {
    const credited = await ramps.creditOnramp({
      userId: USER,
      assetId: 'USDT',
      amount: amt('40'),
      kind: 'crypto',
      railRef: `crypto-fund-${randomUUID()}`,
      creditedBy: OPERATOR,
    });
    expect(credited.kind).toBe('crypto');
    expect(credited.status).toBe('settled');
    expect(typeof credited.amount).toBe('bigint');

    const offrampId = randomUUID();
    const out = await ramps.offramp({
      offrampId,
      userId: USER,
      assetId: 'USDT',
      amount: amt('15'),
      kind: 'crypto',
      destinationRef: '0x000000000000000000000000000000000000dEaD',
      clientRef: `crypto-out-${offrampId}`,
    });
    expect(out.kind).toBe('crypto');
    expect(out.status).toBe('settled');
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('25'));
    expect(ledger.reconcile()).toEqual({ ok: true });

    const stored = await sql<Array<{ kind: string }>>`
      SELECT kind FROM bank.ramp_onramps
      UNION ALL
      SELECT kind FROM bank.ramp_offramps
    `;
    expect(stored.map((row) => row.kind)).toEqual(['crypto', 'crypto']);
  });
});
