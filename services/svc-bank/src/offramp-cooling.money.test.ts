import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { RampService } from './ramps/ramp-service.js';
import { CRYPTO_LEDGER_PROGRAMME } from './ramps/rails.js';
import { memorySecurityLock } from './security-lock.js';

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

/**
 * H8b money proof — offramp cooling is dest-elapsed and PG-hard.
 *
 * Unset / blank still `bank.offramp_cooling_unset` (never 24h). A real owner
 * integer then refuses `bank.offramp_cooling_active` when dest `updated_at`
 * is inside the window — before claimOfframp / withdrawHold. Zero hours is
 * no wait. Missing dest stays `bank.withdraw_destination_missing`.
 *
 * PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed
 * suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const EVM = '0x000000000000000000000000000000000000dEaD';
const EVM_OTHER = '0x0000000000000000000000000000000000000001';
const H8B_IMAGE = 'postgres:16-alpine';

async function openH8bAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8B_IMAGE)
      .withDatabase('intafaced_h8b_test')
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
      `H8b: offramp dest-elapsed cooling is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8B_IMAGE}: ${msg}`,
    );
  }
}

describe('offramp cooling dest-elapsed hitch (source)', () => {
  it('offramp reads dest updated_at and asserts elapsed before claimOfframp / withdrawHold', () => {
    const src = readFileSync(join(here, 'ramps/ramp-service.ts'), 'utf8');
    const hours = src.indexOf('requireOfframpCoolingHours(');
    const dest = src.indexOf('this.resolveWithdrawDestination(');
    const elapsed = src.indexOf('assertOfframpDestCoolingElapsed(');
    const span = src.indexOf("withMoneySpan(\n      'bank.ramp.offramp'");
    const claim = src.indexOf('this.claimOfframp(');
    const hold = src.indexOf('recipes.withdrawHold({');
    expect(hours).toBeGreaterThan(-1);
    expect(dest).toBeGreaterThan(hours);
    expect(elapsed).toBeGreaterThan(dest);
    expect(span).toBeGreaterThan(elapsed);
    expect(claim).toBeGreaterThan(span);
    expect(hold).toBeGreaterThan(claim);
  });

  it('H8b money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-bank offramp cooling dest-elapsed money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let ramps: RampService;

  async function fund(amount = '80') {
    await ramps.creditOnramp({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      kind: 'crypto',
      railRef: `h8b-fund-${randomUUID()}`,
      creditedBy: OPERATOR,
    });
  }

  beforeAll(async () => {
    const admin = await openH8bAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    ramps = new RampService(sql, ledger, {
      securityLock: memorySecurityLock(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      offrampCoolingHours: '48',
    });
  });

  it('blank owner window refuses bank.offramp_cooling_unset with zero ledger posts', async () => {
    await fund();
    const closed = new RampService(sql, ledger, {
      securityLock: memorySecurityLock(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      offrampCoolingHours: '',
    });
    await expect(
      closed.offramp({
        offrampId: randomUUID(),
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: EVM,
        clientRef: `h8b-blank-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_unset' });
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held' || tx.reason === 'withdraw.settled')).toBe(false);
    const rows = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
    expect(rows[0]!.n).toBe(0);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('80');
  });

  it('dest inside window refuses bank.offramp_cooling_active with zero ledger posts', async () => {
    await fund();
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        clientRef: `h8b-active-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_active' });
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held' || tx.reason === 'withdraw.settled')).toBe(false);
    const rows = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
    expect(rows[0]!.n).toBe(0);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('80');
  });

  it('same-ref persist still bumps updated_at and restarts the window', async () => {
    await fund();
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    await sql`
      UPDATE bank.user_withdraw_destinations
         SET updated_at = now() - interval '49 hours'
       WHERE user_id = ${USER} AND kind = 'crypto'
    `;
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        clientRef: `h8b-bump-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_active' });
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
  });

  it('changing dest restarts the window', async () => {
    await fund();
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    await sql`
      UPDATE bank.user_withdraw_destinations
         SET updated_at = now() - interval '49 hours'
       WHERE user_id = ${USER} AND kind = 'crypto'
    `;
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM_OTHER });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        clientRef: `h8b-change-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_active' });
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
  });

  it('dest older than the window is not cooling_active — hold-then-settle may proceed', async () => {
    await fund();
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    await sql`
      UPDATE bank.user_withdraw_destinations
         SET updated_at = now() - interval '49 hours'
       WHERE user_id = ${USER} AND kind = 'crypto'
    `;
    const id = randomUUID();
    const row = await ramps.offramp({
      offrampId: id,
      userId: USER,
      assetId: 'USDT',
      amount: amt('10'),
      kind: 'crypto',
      clientRef: `h8b-elapsed-${id}`,
    });
    expect(row.status).toBe('settled');
    expect(row.holdLedgerTxId).toBeTruthy();
    expect(row.settleLedgerTxId).toBeTruthy();
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('70');
  });

  it('zero hours is a real owner choice — dest just changed is not cooling_active', async () => {
    const zero = new RampService(sql, ledger, {
      securityLock: memorySecurityLock(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      offrampCoolingHours: '0',
    });
    await zero.creditOnramp({
      userId: USER,
      assetId: 'USDT',
      amount: amt('20'),
      kind: 'crypto',
      railRef: `h8b-zero-${randomUUID()}`,
      creditedBy: OPERATOR,
    });
    await zero.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
    const id = randomUUID();
    const row = await zero.offramp({
      offrampId: id,
      userId: USER,
      assetId: 'USDT',
      amount: amt('5'),
      kind: 'crypto',
      clientRef: `h8b-zero-${id}`,
    });
    expect(row.status).toBe('settled');
  });
});
