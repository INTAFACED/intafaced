import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createBankServices, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { BankError } from '../errors.js';
import type { PayFiatRampPort } from './pay-fiat-adapter.js';
import {
  BANK_CRYPTO_LEDGER_RAIL,
  CRYPTO_LEDGER_PROGRAMME,
  NO_RAMP_PROGRAMME,
  RAMP_SETTINGS,
  assertFiatSocketWhenNone,
  rampProgrammeFor,
  refuseFiatRamp,
  type RampProgramme,
} from './rails.js';
import { destinationSanctions, memorySanctions, type DestinationSanctionsPort } from './sanctions-list.js';
import { RampService } from './ramp-service.js';
import { BANK_OFFRAMP_COOLING_HOURS_ENV } from '../offramp-cooling.js';
import { assertOnlyWithdrawDestinations, memoryWithdrawDestinations } from '../withdraw-destination.js';
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

/**
 * bank.ramps — CRYPTO LEDGER half (D-S-09).
 *
 * Proves the crypto ledger half, and that kind fiat refuses bank.fiat_ramp_socket
 * before a row or a ledger post. Kind fiat does not store a ramp row and does not post.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

describe('choosing a ramp programme is a closed decision with a refusing default', () => {
  it('offers exactly two settings, and no third one can be spelled', () => {
    expect([...RAMP_SETTINGS]).toEqual(['none', 'crypto-ledger']);
  });

  it('maps silence to the programme that refuses money paths', () => {
    expect(rampProgrammeFor('none')).toBe(NO_RAMP_PROGRAMME);
    expect(rampProgrammeFor('none').cryptoRail).toBeNull();
    expect(rampProgrammeFor('none').fiatLeg).toBe('socket.psp-partners');
    expect(rampProgrammeFor('none').fiatVia).toBe('svc-pay.RailAdapter');
  });

  it('crypto-ledger is always simulated and names the fiat socket + pay-adapter path', () => {
    const p = rampProgrammeFor('crypto-ledger');
    expect(p).toEqual(CRYPTO_LEDGER_PROGRAMME);
    expect(p.simulated).toBe(true);
    expect(p.cryptoRail).toBe(BANK_CRYPTO_LEDGER_RAIL);
    expect(p.fiatLeg).toBe('socket.psp-partners');
    expect(p.fiatVia).toBe('svc-pay.RailAdapter');
  });

  it('simulated is required true — cannot be omitted or flipped live', () => {
    const required: true = NO_RAMP_PROGRAMME.simulated;
    const cryptoRequired: true = CRYPTO_LEDGER_PROGRAMME.simulated;
    expect(required).toBe(true);
    expect(cryptoRequired).toBe(true);
    type SimulatedMustBeTrue = RampProgramme extends { simulated: true } ? true : never;
    const pin: SimulatedMustBeTrue = true;
    expect(pin).toBe(true);
  });

  it('mode none keeps fiat on bank.fiat_ramp_socket — no default fiat rail', () => {
    expect(() => refuseFiatRamp()).toThrow(BankError);
    try {
      refuseFiatRamp();
    } catch (err) {
      expect(err).toMatchObject({ code: 'bank.fiat_ramp_socket' });
    }
    try {
      assertFiatSocketWhenNone(NO_RAMP_PROGRAMME);
    } catch (err) {
      expect(err).toMatchObject({ code: 'bank.fiat_ramp_socket' });
    }
    expect(() => assertFiatSocketWhenNone(CRYPTO_LEDGER_PROGRAMME)).not.toThrow();
  });

  it('BankError codes stay named for the fiat socket', () => {
    expect(() => {
      throw new BankError('fiat', 'bank.fiat_ramp_socket');
    }).toThrow(BankError);
  });
});

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

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
      `H8a: svc-bank ramps is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('ramps (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('ramps PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;
  let ramps: RampService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    process.env[BANK_OFFRAMP_COOLING_HOURS_ENV] = '0';
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations, bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME },
    });
    ramps = bank.ramps;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('refuse-closed defaults', () => {
    it('refuses fiat on bank.fiat_ramp_socket when mode is none — live pay adapter cannot sneak a default rail', async () => {
      const livePay: PayFiatRampPort = {
        listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
      };
      const none = new RampService(sql, ledger, { securityLock: memorySecurityLock(), programme: NO_RAMP_PROGRAMME, payFiat: livePay });
      await expect(
        none.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'fiat',
          railRef: 'sneak-1',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      await expect(
        none.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'fiat',
          destinationRef: 'IBAN',
          clientRef: 'sneak-off',
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      await expect(none.fiatSettle()).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
    });

    it('refuses every money path when no programme is configured', async () => {
      const none = new RampService(sql, ledger, { securityLock: memorySecurityLock(), programme: NO_RAMP_PROGRAMME });
      await expect(
        none.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'crypto',
          railRef: 'tx-1',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.no_ramp_rail' });

      await expect(
        none.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'crypto',
          destinationRef: '0xabc',
          clientRef: 'c1',
        }),
      ).rejects.toMatchObject({ code: 'bank.no_ramp_rail' });
    });

    it('refuses fiat before a row is written when no live pay adapter is injected', async () => {
      await expect(
        ramps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'fiat',
          railRef: 'ach-1',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });

      const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);

      await expect(
        ramps.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'fiat',
          destinationRef: 'IBAN',
          clientRef: 'fiat-1',
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
    });

    it('sandbox pay rails still refuse fiat — no PSP laundering into bank', async () => {
      const sandboxOnly: PayFiatRampPort = {
        listFiatRails: () => [{ railId: 'card-sandbox', mode: 'sandbox', capabilities: ['onramp', 'offramp'] }],
      };
      const withSandbox = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: sandboxOnly,
      });
      await expect(
        withSandbox.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'fiat',
          railRef: 'sandbox-ach',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
    });
  });

  describe('fiat kind refuses the socket before a row or a ledger post', () => {
    const livePay: PayFiatRampPort = {
      listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
    };

    it('refuses a fiat on-ramp when a live pay rail is injected', async () => {
      const fiatRamps = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
      });
      await expect(
        fiatRamps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('25'),
          kind: 'fiat',
          railRef: 'ach-in-1',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
      expect(ledger.journal()).toHaveLength(0);
      expect(ledger.reconcile().ok).toBe(true);
    });

    it('refuses the same fiat railRef again when the live rail id would have changed', async () => {
      let order = ['pay-fiat-first'];
      const shifting: PayFiatRampPort = {
        listFiatRails: () => order.map((railId) => ({ railId, mode: 'live' as const, capabilities: ['onramp' as const] })),
      };
      const fiatRamps = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: shifting,
      });
      const railRef = 'ach-same-ref-rail-moves';
      await expect(
        fiatRamps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('25'),
          kind: 'fiat',
          railRef,
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });

      order = ['pay-fiat-second', 'pay-fiat-first'];
      await expect(
        fiatRamps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('25'),
          kind: 'fiat',
          railRef,
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });

      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bank.ramp_onramps WHERE rail_ref = ${railRef}
      `;
      expect(rows[0]!.n).toBe(0);
      expect(ledger.journal()).toHaveLength(0);
      expect(ledger.reconcile().ok).toBe(true);
    });

    it('refuses a non-positive fiat amount with the socket before a row or a deposit', async () => {
      const fiatRamps = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
      });
      for (const amount of [0n, -1n]) {
        await expect(
          fiatRamps.creditOnramp({
            userId: USER,
            assetId: 'USDT',
            amount,
            kind: 'fiat',
            railRef: 'ach-non-positive',
            creditedBy: OPERATOR,
          }),
        ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      }
      const count = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
      expect(ledger.journal()).toHaveLength(0);
    });

    it('refuses a fiat off-ramp when a live pay rail is injected', async () => {
      const fiatRamps = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
      });
      await expect(
        fiatRamps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('40'),
          kind: 'fiat',
          railRef: 'ach-fund',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      const id = randomUUID();
      await expect(
        fiatRamps.offramp({
          offrampId: id,
          userId: USER,
          assetId: 'USDT',
          amount: amt('15'),
          kind: 'fiat',
          destinationRef: 'GB82WEST12345698765432',
          clientRef: 'fiat-out-1',
        }),
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_socket' });
      const counts = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bank.ramp_onramps
        UNION ALL
        SELECT count(*)::int AS n FROM bank.ramp_offramps
      `;
      expect(counts.every((row) => row.n === 0)).toBe(true);
      expect(ledger.journal()).toHaveLength(0);
      expect(ledger.reconcile().ok).toBe(true);
    });
  });

  describe('refuse-closed defaults (continued)', () => {
    it('refuses a blank or whitespace asset before any row or ledger post', async () => {
      await expect(
        ramps.creditOnramp({
          userId: USER,
          assetId: '   ',
          amount: amt('10'),
          kind: 'crypto',
          railRef: 'blank-asset-1',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_invalid_asset' });

      await expect(
        ramps.creditOnramp({
          userId: USER,
          assetId: '',
          amount: amt('10'),
          kind: 'crypto',
          railRef: 'blank-asset-2',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_invalid_asset' });

      const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');

      await expect(
        ramps.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: ' USDT',
          amount: amt('10'),
          kind: 'crypto',
          destinationRef: '0xabc',
          clientRef: 'blank-off-1',
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_invalid_asset' });
    });
  });

  describe('crypto on-ramp — deposit recipe only', () => {
    it('credits available via recipes.deposit and keeps simulated true', async () => {
      const row = await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('100'),
        kind: 'crypto',
        railRef: '0xdeposit1',
        creditedBy: OPERATOR,
      });

      expect(row.status).toBe('settled');
      expect(row.simulated).toBe(true);
      expect(row.rail).toBe(BANK_CRYPTO_LEDGER_RAIL);
      expect(row.ledgerTxId).toBeTruthy();
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('100');
      // Boundary is the other side of the deposit: a credit posts as a signed
      // negative on balance() for treasury/rail accounts in MemoryLedger.
      expect(formatAmount((await ledger.balance(railBoundary(BANK_CRYPTO_LEDGER_RAIL, 'USDT'))).amount)).toBe('-100');
      expect(ledger.reconcile().ok).toBe(true);
    });

    it('is idempotent on (rail, railRef) and refuses a conflicting amount', async () => {
      const first = await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        kind: 'crypto',
        railRef: 'same-ref',
        creditedBy: OPERATOR,
      });
      const second = await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        kind: 'crypto',
        railRef: 'same-ref',
        creditedBy: OPERATOR,
      });
      expect(second.id).toBe(first.id);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');

      await expect(
        ramps.creditOnramp({
          userId: USER,
          assetId: 'USDT',
          amount: amt('99'),
          kind: 'crypto',
          railRef: 'same-ref',
          creditedBy: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_conflict' });
    });
  });

  describe('offramp cooling — owner window required before withdrawHold', () => {
    const dead = '0x000000000000000000000000000000000000dEaD';

    async function fund(): Promise<void> {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('80'),
        kind: 'crypto',
        railRef: `cool-fund-${randomUUID()}`,
        creditedBy: OPERATOR,
      });
    }

    it('blank / unset / non-integer / negative refuse bank.offramp_cooling_unset before any hold', async () => {
      await fund();
      const journalBefore = ledger.journal().length;

      for (const hours of ['', '  ', '24h', '-1', '1.5']) {
        const closed = new RampService(sql, ledger, {
          securityLock: memorySecurityLock(),
          programme: CRYPTO_LEDGER_PROGRAMME,
          offrampCoolingHours: hours,
        });
        await expect(
          closed.offramp({
            offrampId: randomUUID(),
            userId: USER,
            assetId: 'USDT',
            amount: amt('5'),
            kind: 'crypto',
            destinationRef: dead,
            clientRef: `cool-blank-${hours}-${randomUUID()}`,
          }),
        ).rejects.toMatchObject({ code: 'bank.offramp_cooling_unset' });
      }

      const prev = process.env[BANK_OFFRAMP_COOLING_HOURS_ENV];
      delete process.env[BANK_OFFRAMP_COOLING_HOURS_ENV];
      try {
        const unset = new RampService(sql, ledger, { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME });
        await expect(
          unset.offramp({
            offrampId: randomUUID(),
            userId: USER,
            assetId: 'USDT',
            amount: amt('5'),
            kind: 'crypto',
            destinationRef: dead,
            clientRef: `cool-unset-${randomUUID()}`,
          }),
        ).rejects.toMatchObject({ code: 'bank.offramp_cooling_unset' });
      } finally {
        process.env[BANK_OFFRAMP_COOLING_HOURS_ENV] = prev;
      }

      expect(ledger.journal()).toHaveLength(journalBefore);
      expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
      const rows = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
      expect(rows[0]!.n).toBe(0);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('80');
    });

    it('set owner window allows hold-then-settle once dest is older than the window', async () => {
      await fund();
      await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: dead });
      await sql`
        UPDATE bank.user_withdraw_destinations
           SET updated_at = now() - interval '49 hours'
         WHERE user_id = ${USER} AND kind = 'crypto'
      `;
      const set = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        offrampCoolingHours: '48',
      });
      const id = randomUUID();
      const row = await set.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('30'),
        kind: 'crypto',
        clientRef: `cool-set-${id}`,
      });
      expect(row.status).toBe('settled');
      expect(row.holdLedgerTxId).toBeTruthy();
      expect(row.settleLedgerTxId).toBeTruthy();
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
    });
  });

  describe('crypto off-ramp — hold then settle', () => {
    it('moves value to the rail boundary and leaves the hold at zero', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('80'),
        kind: 'crypto',
        railRef: 'fund-off',
        creditedBy: OPERATOR,
      });

      const id = randomUUID();
      const row = await ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('30'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'off-1',
      });

      expect(row.status).toBe('settled');
      expect(row.simulated).toBe(true);
      expect(row.holdLedgerTxId).toBeTruthy();
      expect(row.settleLedgerTxId).toBeTruthy();
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
      expect(formatAmount((await ledger.balance(ramps.holdAccount(USER, 'USDT', id))).amount)).toBe('0');
    });

    it('refuses insufficient funds by name and rejects the row', async () => {
      const id = randomUUID();
      await expect(
        ramps.offramp({
          offrampId: id,
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          destinationRef: '0x000000000000000000000000000000000000dEaD',
          clientRef: 'broke',
        }),
      ).rejects.toThrow(/insufficient/i);

      const rows = await sql<Array<{ status: string; rejection_code: string }>>`
        SELECT status, rejection_code FROM bank.ramp_offramps WHERE id = ${id}
      `;
      expect(rows[0]).toMatchObject({ status: 'rejected', rejection_code: 'ledger.insufficient_funds' });
    });

    it('a concurrent caller cannot settle an offramp this caller rejected for insufficient funds', async () => {
      const dest = '0x000000000000000000000000000000000000dEaD';
      await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: dest });
      const id = randomUUID();
      const input = {
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto' as const,
        clientRef: `race-${id}`,
      };

      // Both callers reach withdrawHold while the balance is empty. The first
      // hold fails for real and rejects the row. Funding the caller that is
      // already inside hold is the window: a claim released before the posts
      // lets that caller settle and report settled against the rejected row.
      const realPost = ledger.post.bind(ledger);
      let holdEntrants = 0;
      ledger.post = async (request: PostRequest) => {
        if (request.reason !== 'withdraw.held') return realPost(request);
        const n = ++holdEntrants;
        if (n === 1) {
          await waitFor(() => holdEntrants >= 2, 2_000);
          return realPost(request);
        }
        const rejected = await waitFor(async () => {
          const rows = await sql<Array<{ status: string }>>`
            SELECT status FROM bank.ramp_offramps WHERE id = ${id}
          `;
          return rows[0]?.status === 'rejected';
        }, 3_000);
        if (rejected) {
          await realPost(
            recipes.deposit({
              userId: USER,
              assetId: 'USDT',
              amount: amt('10'),
              rail: 'test',
              railRef: `race-fund-${id}`,
            }),
          );
        }
        return realPost(request);
      };

      const results = await Promise.allSettled([ramps.offramp(input), ramps.offramp(input)]);

      const reportedSettled = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'settled');
      expect(reportedSettled).toHaveLength(0);
      expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held' || tx.reason === 'withdraw.settled')).toBe(false);

      const rows = await sql<Array<{ status: string; rejection_code: string | null }>>`
        SELECT status, rejection_code FROM bank.ramp_offramps WHERE id = ${id}
      `;
      expect(rows[0]).toMatchObject({ status: 'rejected', rejection_code: 'ledger.insufficient_funds' });

      await expect(ramps.offramp(input)).rejects.toMatchObject({ code: 'bank.ramp_conflict' });
      await expect(
        ramps.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: 0n,
          kind: 'crypto',
          clientRef: `zero-${id}`,
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_invalid_amount' });
    }, 20_000);

    it('retries on the same clientRef return the same settled offramp', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        kind: 'crypto',
        railRef: 'fund-retry',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      const a = await ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'retry-me',
      });
      const b = await ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'retry-me',
      });
      expect(b.id).toBe(a.id);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('30');
    });

    it('same offrampId with a different clientRef is bank.ramp_conflict, not raw PG 23505', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        kind: 'crypto',
        railRef: 'fund-id-conflict',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      await ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'first-ref',
      });

      await expect(
        ramps.offramp({
          offrampId: id,
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          kind: 'crypto',
          destinationRef: '0x000000000000000000000000000000000000dEaD',
          clientRef: 'other-ref',
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_conflict' });

      // Balance unchanged after the conflict (only the first offramp settled).
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('30');
    });
  });

  describe('user withdraw destination persist before withdrawHold', () => {
    it('refuses a gibberish dest before any hold is posted', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-garbage',
        creditedBy: OPERATOR,
      });
      await expect(
        ramps.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          destinationRef: '0xdead',
          clientRef: 'garbage-dest',
        }),
      ).rejects.toMatchObject({ code: 'bank.ramp_invalid_destination' });
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
      const holds = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
      expect(holds[0]!.n).toBe(0);
    });

    it('refuses a later withdraw when no dest was persisted', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-missing',
        creditedBy: OPERATOR,
      });
      await expect(
        ramps.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          clientRef: 'missing-dest',
        }),
      ).rejects.toMatchObject({ code: 'bank.withdraw_destination_missing' });
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
    });

    it('loads a persisted dest so a later withdraw has a real ref', async () => {
      await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' });
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-persist',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      const row = await ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('8'),
        kind: 'crypto',
        clientRef: 'from-store',
      });
      expect(row.destinationRef).toBe('0x000000000000000000000000000000000000dEaD');
      expect(row.status).toBe('settled');
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('12');
    });

    it('refuses crypto withdraw when no EVM dest is stored — nothing held', async () => {
      const closed = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        destinations: assertOnlyWithdrawDestinations(),
      });
      await closed.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'crypto-no-store',
        creditedBy: OPERATOR,
      });
      await expect(
        closed.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          destinationRef: '0x000000000000000000000000000000000000dEaD',
          clientRef: 'crypto-no-store-off',
        }),
      ).rejects.toMatchObject({ code: 'bank.withdraw_destination_missing' });
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
      const holds = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
      expect(holds[0]!.n).toBe(0);
    });

    it('withdraws crypto to the stored EVM dest through ledger-client', async () => {
      const dests = memoryWithdrawDestinations();
      const evm = '0x000000000000000000000000000000000000dEaD';
      await dests.persist({ userId: USER, kind: 'crypto', ref: evm });
      const live = new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        destinations: dests,
      });
      await live.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'crypto-stored',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      const row = await live.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('8'),
        kind: 'crypto',
        clientRef: 'crypto-stored-off',
      });
      expect(row.destinationRef).toBe(evm);
      expect(row.status).toBe('settled');
      expect(row.holdLedgerTxId).toBeTruthy();
      expect(row.settleLedgerTxId).toBeTruthy();
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('12');
    });
  });

  describe('destination sanctions list (J-wallet-05 #2)', () => {
    const SANCTIONED = '0x5a7c7100000000000000000000000000000ba5ed';
    const service = (sanctions: DestinationSanctionsPort, dests = memoryWithdrawDestinations()) =>
      new RampService(sql, ledger, {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        destinations: dests,
        sanctions,
      });
    const funded = async (live: RampService, railRef: string) =>
      live.creditOnramp({ userId: USER, assetId: 'USDT', amount: amt('20'), kind: 'crypto', railRef, creditedBy: OPERATOR });

    it('starts no send to a listed address, offered or stored, and holds nothing', async () => {
      const dests = memoryWithdrawDestinations();
      const live = service(memorySanctions([{ network: '*', address: SANCTIONED }]), dests);
      await funded(live, 'sanctioned-credit');
      const before = formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
      const send = (destinationRef?: string) =>
        live.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('8'),
          kind: 'crypto',
          clientRef: `sanctioned-off-${randomUUID()}`,
          ...(destinationRef ? { destinationRef } : {}),
        });
      await expect(send(SANCTIONED.toUpperCase().replace('0X', '0x'))).rejects.toMatchObject({ code: 'bank.destination_sanctions_listed' });
      expect(await dests.list(USER)).toEqual([]);
      // Stored before it was listed: still no send.
      await dests.persist({ userId: USER, kind: 'crypto', ref: SANCTIONED });
      await expect(send()).rejects.toMatchObject({ code: 'bank.destination_sanctions_listed' });
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe(before);
    });

    it('a send held before its address was listed, or before the list went blank, refuses and stays held: never settled', async () => {
      for (const after of ['listed', 'blank'] as const) {
        const sanctioned: Array<{ network: string; address: string }> = [];
        let unset = false;
        let settleFails = true;
        // The rail's settle fails once, so the send is left held, as a crash between hold and settle leaves it.
        const flaky = new Proxy(ledger, {
          get(target, prop) {
            if (prop === 'post') {
              return async (tx: Parameters<MemoryLedger['post']>[0]) => {
                if (settleFails && tx.reason === 'withdraw.settled') throw new Error('TEST rail down at settle');
                return target.post(tx);
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        const dests = memoryWithdrawDestinations();
        const live = new RampService(sql, flaky, {
          securityLock: memorySecurityLock(),
          programme: CRYPTO_LEDGER_PROGRAMME,
          destinations: dests,
          sanctions: { check: (network, ref) => (unset ? 'unset' : memorySanctions(sanctioned).check(network, ref)) },
        });
        const userId = after === 'listed' ? 'abcdeaaa-5555-4555-8555-000000000001' : 'abcdeaaa-5555-4555-8555-000000000002';
        await live.creditOnramp({
          userId,
          assetId: 'USDT',
          amount: amt('20'),
          kind: 'crypto',
          railRef: `held-${after}`,
          creditedBy: OPERATOR,
        });
        const id = randomUUID();
        const send = () =>
          live.offramp({
            offrampId: id,
            userId,
            assetId: 'USDT',
            amount: amt('8'),
            kind: 'crypto',
            clientRef: `held-off-${after}`,
            destinationRef: SANCTIONED,
          });
        await expect(send()).rejects.toThrow('TEST rail down at settle');
        expect(formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount)).toBe('12');
        // Listed (or the list blanked) while it is held; the rail is back. The resume refuses and nothing settles.
        if (after === 'listed') sanctioned.push({ network: '*', address: SANCTIONED });
        else unset = true;
        settleFails = false;
        await expect(send()).rejects.toMatchObject({
          code: after === 'listed' ? 'bank.destination_sanctions_listed' : 'bank.destination_sanctions_unset',
        });
        const [row] = await sql<Array<{ status: string; settle_ledger_tx_id: string | null; hold_ledger_tx_id: string | null }>>`
          SELECT status, settle_ledger_tx_id, hold_ledger_tx_id FROM bank.ramp_offramps WHERE id = ${id}::uuid
        `;
        expect(row).toMatchObject({ status: 'pending', settle_ledger_tx_id: null });
        expect(row!.hold_ledger_tx_id).toBeTruthy();
        expect(formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount)).toBe('12');
        expect(ledger.journal().some((tx) => tx.reason === 'withdraw.settled' && tx.idempotencyKey?.includes(id))).toBe(false);
      }
    });

    it('answers a send settled before its address was listed as before, and posts nothing more', async () => {
      const sanctioned: Array<{ network: string; address: string }> = [];
      const live = service({ check: (network, ref) => memorySanctions(sanctioned).check(network, ref) });
      const userId = 'abcdeaaa-5555-4555-8555-000000000003';
      await live.creditOnramp({
        userId,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'settled-before',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      const send = () =>
        live.offramp({
          offrampId: id,
          userId,
          assetId: 'USDT',
          amount: amt('8'),
          kind: 'crypto',
          clientRef: 'settled-before-off',
          destinationRef: SANCTIONED,
        });
      const first = await send();
      expect(first.status).toBe('settled');
      sanctioned.push({ network: '*', address: SANCTIONED });
      const posted = ledger.journal().length;
      await expect(send()).resolves.toMatchObject({ id: first.id, status: 'settled' });
      expect(ledger.journal()).toHaveLength(posted);
    });

    it('starts no send while the list is unset, and stores no withdrawal address', async () => {
      const dests = memoryWithdrawDestinations();
      const live = service(
        destinationSanctions(() => undefined),
        dests,
      );
      await funded(live, 'unset-credit');
      const before = formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
      await expect(
        live.offramp({
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('8'),
          kind: 'crypto',
          clientRef: 'unset-off',
          destinationRef: '0x000000000000000000000000000000000000dEaD',
        }),
      ).rejects.toMatchObject({ code: 'bank.destination_sanctions_unset' });
      await expect(
        live.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' }),
      ).rejects.toMatchObject({ code: 'bank.destination_sanctions_unset' });
      expect(await dests.list(USER)).toEqual([]);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe(before);
    });
  });

  describe('conservation', () => {
    it('closes the books after on-ramp then off-ramp', async () => {
      await ramps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        kind: 'crypto',
        railRef: 'cons-1',
        creditedBy: OPERATOR,
      });
      await ramps.offramp({
        offrampId: randomUUID(),
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'cons-off',
      });
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');
      expect(formatAmount((await ledger.balance(railBoundary(BANK_CRYPTO_LEDGER_RAIL, 'USDT'))).amount)).toBe('0');
      expect(ledger.reconcile().ok).toBe(true);
    });
  });
});
