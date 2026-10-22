import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, railBoundary, userAvailable } from '@intafaced/ledger-client';
import { createBankServices, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { BankError } from '../errors.js';
import type { PayFiatRampPort } from './pay-fiat-adapter.js';
import { BANK_CRYPTO_LEDGER_RAIL, CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME, RAMP_SETTINGS, rampProgrammeFor } from './rails.js';
import { RampService } from './ramp-service.js';

/**
 * bank.ramps — CRYPTO LEDGER half (D-S-09) + FIAT VIA PAY ADAPTERS (D26-P1-B4).
 *
 * Proves money paths, named refusals, and that fiat reuses svc-pay RailAdapter
 * posture (empty/sandbox refuse; live uses ledger-client only — no second book).
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
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
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-bank ramps (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'bank', url: URL, migrations });
  const sql = db.sql;

  let ledger: MemoryLedger;
  let bank: BankServices;
  let ramps: RampService;

  beforeEach(async () => {
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations, bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
    });
    ramps = bank.ramps;
  });

  afterAll(async () => {
    await db.drop();
  }, 30_000);

  describe('refuse-closed defaults', () => {
    it('refuses every money path when no programme is configured', async () => {
      const none = new RampService(sql, ledger, { programme: NO_RAMP_PROGRAMME });
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
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_no_pay_adapter' });

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
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_no_pay_adapter' });
    });

    it('sandbox pay rails still refuse fiat — no PSP laundering into bank', async () => {
      const sandboxOnly: PayFiatRampPort = {
        listFiatRails: () => [{ railId: 'card-sandbox', mode: 'sandbox', capabilities: ['onramp', 'offramp'] }],
      };
      const withSandbox = new RampService(sql, ledger, {
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
      ).rejects.toMatchObject({ code: 'bank.fiat_ramp_no_pay_adapter' });
      const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
      expect(count[0]!.n).toBe(0);
    });
  });

  describe('fiat via live pay adapter — same ledger recipes, no second book', () => {
    const livePay: PayFiatRampPort = {
      listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
    };

    it('credits fiat on-ramp onto the pay rail id via recipes.deposit', async () => {
      const fiatRamps = new RampService(sql, ledger, {
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
      });
      const row = await fiatRamps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        kind: 'fiat',
        railRef: 'ach-in-1',
        creditedBy: OPERATOR,
      });
      expect(row.kind).toBe('fiat');
      expect(row.rail).toBe('pay-fiat-ach');
      expect(row.simulated).toBe(true);
      expect(row.status).toBe('settled');
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('25');
      expect(formatAmount((await ledger.balance(railBoundary('pay-fiat-ach', 'USDT'))).amount)).toBe('-25');
      expect(ledger.reconcile().ok).toBe(true);
    });

    it('settles fiat off-ramp through the pay rail without inventing a bank PSP book', async () => {
      const fiatRamps = new RampService(sql, ledger, {
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
      });
      await fiatRamps.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        kind: 'fiat',
        railRef: 'ach-fund',
        creditedBy: OPERATOR,
      });
      const id = randomUUID();
      const out = await fiatRamps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('15'),
        kind: 'fiat',
        destinationRef: 'GB82WEST12345698765432',
        clientRef: 'fiat-out-1',
      });
      expect(out.kind).toBe('fiat');
      expect(out.rail).toBe('pay-fiat-ach');
      expect(out.simulated).toBe(true);
      expect(out.status).toBe('settled');
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('25');
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

  it('BankError codes stay named for the fiat socket', () => {
    expect(() => {
      throw new BankError('fiat', 'bank.fiat_ramp_socket');
    }).toThrow(BankError);
  });
}
