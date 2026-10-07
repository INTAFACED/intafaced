import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  rewardsEngine,
  railBoundary,
  userAvailable,
  withdrawalHoldAccount,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { MarkQuality, PriceSource, QuotedMark } from '../loans/prices.js';
import { CardService } from './card-service.js';
import { DEFAULT_CARD_CONVERSION_POLICY, fundingFor, noConversionRates, quoteConversion } from './conversion.js';
import {
  cardIssuerFor,
  cardProgrammeOutput,
  cardSim,
  cardSimIsLivePosture,
  cardSimNotLive,
  cashbackOn,
  noCardIssuer,
  type CardIssuerAdapter,
} from './issuer.js';

/**
 * CARDS (§8.1) — the LEDGER half.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS ACTUALLY PROVING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Not "the simulator works". The simulator does nothing — that is the point of
 * it, and `issuer.ts` says so at length. What is under test is the MONEY PATH,
 * which is production code: every posting below is a real transaction in a real
 * ledger, and the only thing standing in for a counterparty is the thing that
 * cannot be built without a licence.
 *
 * Three properties carry the file:
 *
 *   1. Value is conserved. `ledger.totalsByAsset()` is zero after every path,
 *      including the ones that fail halfway.
 *   2. A hold belongs to ONE authorisation, and ends at exactly zero once that
 *      authorisation is settled — asserted on the ACCOUNT, not by adding up our
 *      own rows, because the ledger is the one that has to be right.
 *   3. Every refusal is NAMED. No default, no silent zero, no approval on
 *      behalf of a ledger that never answered.
 *
 * Own database per run, for the same reason `loans.test.ts` takes one: this file
 * and `bank-service.test.ts` would otherwise race each other's truncates across
 * worktrees.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BANK_INIT = readFileSync(join(here, '..', '..', 'drizzle', '0000_bank_init.sql'), 'utf8');
const POSITION_PENDING = readFileSync(join(here, '..', '..', 'drizzle', '0001_position_pending.sql'), 'utf8');
const LOANS_MIGRATION = readFileSync(join(here, '..', '..', 'drizzle', '0002_bank_loans.sql'), 'utf8');
const CARDS_MIGRATION = readFileSync(join(here, '..', '..', 'drizzle', '0003_bank_cards.sql'), 'utf8');
const JIT_CONVERSION = readFileSync(join(here, '..', '..', 'drizzle', '0007_card_jit_conversion.sql'), 'utf8');

const HOLDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FEE_PAYER = '99999999-9999-4999-8999-999999999999';

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · ARITHMETIC AND THE PORT — no database, no ledger.
// ═══════════════════════════════════════════════════════════════════════════════

describe('cashback is integer arithmetic, and rounds against the platform’s optimism', () => {
  it('computes basis points exactly, with no float in the path', () => {
    expect(formatAmount(cashbackOn(amt('100'), 100))).toBe('1'); // 1%
    expect(formatAmount(cashbackOn(amt('250'), 50))).toBe('1.25'); // 0.5%
    expect(formatAmount(cashbackOn(amt('1'), 10_000))).toBe('1'); // 100%
  });

  /**
   * Floor, and deliberately.
   *
   * A rounding unit invented in the user's favour is value the rewards pot never
   * earned, paid out of a pot that has to balance. Under-paying by one atomic
   * unit is visible and correctable; over-paying is a slow leak nobody notices.
   */
  it('rounds DOWN, so a reward is never larger than the fees behind it', () => {
    // 1 attounit at 1% is 0.01 of an attounit, which does not exist.
    expect(cashbackOn(1n, 100)).toBe(0n);
    expect(formatAmount(cashbackOn(amt('0.000000000000000199'), 100))).toBe('0.000000000000000001');
  });

  it('treats a zero or absent rate as no reward rather than as an error', () => {
    expect(cashbackOn(amt('1000'), 0)).toBe(0n);
    expect(cashbackOn(amt('1000'), -1)).toBe(0n);
  });
});

describe('the simulator says what it is on every surface it has', () => {
  it('declares itself simulated, and names itself so in the display string', () => {
    const programme = cardSim().programme;
    expect(programme.simulated).toBe(true);
    expect(programme.id).toBe('card-sim');
    expect(programme.displayName.toLowerCase()).toContain('simulated');
    expect(Object.hasOwn(programme, 'simulated')).toBe(true);
    expect(JSON.parse(JSON.stringify(programme)).simulated).toBe(true);
  });

  it('cannot omit simulated:true — a missing flag would look like a live card', () => {
    const wire = JSON.stringify(cardProgrammeOutput(cardSim().programme));
    expect(wire).toContain('"simulated":true');
    expect(() => cardProgrammeOutput({ id: 'card-sim', displayName: 'Simulated card (no card programme)' } as never)).toThrow(TypeError);
  });

  it('derives a stable four-digit tail from the card id, and it is not a card number', async () => {
    const cardId = '7b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40';
    const first = await cardSim().issue({ cardId, userId: HOLDER, assetId: 'USDT' });
    const second = await cardSim().issue({ cardId, userId: HOLDER, assetId: 'USDT' });

    // Re-issuing the same card id is the same card, not two.
    expect(first).toEqual(second);
    expect(first.panTail).toMatch(/^\d{4}$/);
    // A tail derived from a uuid corresponds to no card anybody has issued.
    expect(cardId).not.toContain(first.panTail);
  });
});

describe('no issuer configured means no card programme, and it refuses by name', () => {
  /**
   * THE MISSING-COUNTERPARTY REFUSAL, and the sibling of
   * `bank.no_liquidation_counterparty`.
   *
   * The dangerous default here is the plausible one — fall back to the simulator
   * and an environment somebody believes is live starts approving authorisations
   * against a counterparty that does not exist. Choosing `cardSim()` has to be an
   * act somebody performed.
   */
  it('is the CardService default, not the simulator', () => {
    const unconfigured = new CardService(null as never, null as never);
    expect(unconfigured.programme()).toEqual(noCardIssuer.programme);
    expect(unconfigured.programme().id).toBe('none');
    expect(unconfigured.programme().id).not.toBe('card-sim');
    expect(JSON.stringify(unconfigured.programme())).toContain('"simulated":true');
  });

  it('refuses to issue, respond or set status', async () => {
    await expect(noCardIssuer.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT' })).rejects.toMatchObject({
      code: 'bank.no_card_issuer',
    });
    await expect(
      noCardIssuer.respondToAuthorization({
        cardId: randomUUID(),
        issuerRef: 'x',
        authorizationRef: 'y',
        outcome: { decision: 'declined', reason: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'bank.no_card_issuer' });
    await expect(noCardIssuer.setStatus({ cardId: randomUUID(), issuerRef: 'x', status: 'frozen' })).rejects.toMatchObject({
      code: 'bank.no_card_issuer',
    });
  });
});

describe('card-sim under live posture is not a BIN', () => {
  it('treats NODE_ENV=production and APP_ENV staging/prod as live, not test/dev', () => {
    expect(cardSimIsLivePosture({ live: true })).toBe(true);
    expect(cardSimIsLivePosture({ live: false, NODE_ENV: 'production' })).toBe(false);
    expect(cardSimIsLivePosture({ NODE_ENV: 'production' })).toBe(true);
    expect(cardSimIsLivePosture({ NODE_ENV: 'test', APP_ENV: 'prod' })).toBe(true);
    expect(cardSimIsLivePosture({ NODE_ENV: 'test', APP_ENV: 'staging' })).toBe(true);
    expect(cardSimIsLivePosture({ NODE_ENV: 'test', APP_ENV: 'dev' })).toBe(false);
  });

  it('named-refuses issue, respond and setStatus as bank.card_sim_not_live', async () => {
    const issuer = cardSimNotLive();
    expect(issuer.programme).toMatchObject({ id: 'card-sim', simulated: true });
    await expect(issuer.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT' })).rejects.toMatchObject({
      code: 'bank.card_sim_not_live',
    });
    await expect(
      issuer.respondToAuthorization({
        cardId: randomUUID(),
        issuerRef: 'x',
        authorizationRef: 'y',
        outcome: { decision: 'declined', reason: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'bank.card_sim_not_live' });
    await expect(issuer.setStatus({ cardId: randomUUID(), issuerRef: 'x', status: 'frozen' })).rejects.toMatchObject({
      code: 'bank.card_sim_not_live',
    });
  });

  it('cardIssuerFor(card-sim) selects the refusing adapter on live flags', () => {
    expect(cardIssuerFor('card-sim', { live: true }).mutationRefuse).toBe('bank.card_sim_not_live');
    expect(cardIssuerFor('card-sim', { NODE_ENV: 'production' }).mutationRefuse).toBe('bank.card_sim_not_live');
    expect(cardIssuerFor('card-sim', { APP_ENV: 'prod' }).mutationRefuse).toBe('bank.card_sim_not_live');
    expect(cardIssuerFor('card-sim').mutationRefuse).toBeUndefined();
  });

  it('CARD_ISSUER=none under live posture stays bank.no_card_issuer', async () => {
    const issuer = cardIssuerFor('none', { live: true, NODE_ENV: 'production', APP_ENV: 'prod' });
    expect(issuer).toBe(noCardIssuer);
    await expect(issuer.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT' })).rejects.toMatchObject({
      code: 'bank.no_card_issuer',
    });
  });
});

describe('JIT conversion arithmetic (§18) — no rate is invented, and the rounding lands on the user', () => {
  it('converts a settlement amount into funding units at the quoted rate', () => {
    // 100 of the settlement asset at 50,000 settlement-per-funding = 0.002.
    expect(formatAmount(fundingFor(amt('100'), amt('50000')))).toBe('0.002');
    expect(formatAmount(fundingFor(amt('50000'), amt('50000')))).toBe('1');
  });

  /**
   * CEIL, and the direction is deliberate.
   *
   * The rounding unit has to land on somebody. `cashbackOn` floors so a reward
   * is never larger than the fees behind it; this ceils so the units handed to a
   * settlement rail are never fewer than the purchase cost. Both round against
   * the platform's optimism, which is the only rule that does not leak.
   */
  it('rounds UP, so a spend never leaves the rail one unit short', () => {
    expect(fundingFor(1n, amt('3'))).toBe(1n);
    expect(formatAmount(fundingFor(amt('10'), amt('3')))).toBe('3.333333333333333334');
  });

  /**
   * THE PROPERTY THE HOLD ACCOUNT DEPENDS ON.
   *
   * A partial capture converts at the same frozen rate the authorisation did. If
   * that could ever produce MORE funding units than the whole authorisation did,
   * a capture would overdraw a hold account containing only the hold. It cannot,
   * because this is monotonic — and it is EQUAL at the top, which is what makes
   * a full capture leave that account at exactly zero.
   */
  it('is monotonic in the settlement amount, and exact at the full amount', () => {
    const rate = amt('1234.5678');
    const whole = fundingFor(amt('999.99'), rate);
    for (const part of ['0.01', '1', '250', '999.98']) {
      expect(fundingFor(amt(part), rate) <= whole).toBe(true);
    }
    expect(fundingFor(amt('999.99'), rate)).toBe(whole);
  });

  it('refuses a non-positive rate rather than treating it as a free card', () => {
    expect(() => fundingFor(amt('100'), 0n)).toThrow(expect.objectContaining({ code: 'bank.mark_invalid' }));
    expect(() => fundingFor(amt('100'), -1n)).toThrow(expect.objectContaining({ code: 'bank.mark_invalid' }));
  });
});

describe('the default rate source has no rates in it, and that is the whole point', () => {
  /**
   * THE SIBLING OF `noCardIssuer`.
   *
   * There is no FX source in this platform. The shell deleted the one rate it
   * had invented, for the reason that a fiat conversion computed from a rate we
   * made up is a price and not a decoration. So the default returns nothing, and
   * a card that needs a conversion refuses by name rather than quietly
   * converting at a number somebody typed once.
   */
  it('returns no mark for any asset, in any quote asset', async () => {
    expect((await noConversionRates.marks(['BTC', 'USDT', 'IFC'], 'USDT')).size).toBe(0);
    // Not even the identity case. A same-asset card never asks, so answering
    // "one" here could only ever serve a caller that had lost track of which
    // asset it was converting.
    expect((await noConversionRates.marks(['USDT'], 'USDT')).size).toBe(0);
  });

  it('makes quoteConversion refuse by name rather than return a number', async () => {
    await expect(
      quoteConversion({
        rates: noConversionRates,
        fundingAssetId: 'BTC',
        settlementAssetId: 'USDT',
        settlementAmount: amt('100'),
        previous: null,
        now: new Date('2026-08-08T12:00:00Z'),
        policy: DEFAULT_CARD_CONVERSION_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'bank.mark_missing' });
  });

  /**
   * `last` IS NOT A BASIS FOR TAKING SOMEBODY'S MONEY.
   *
   * The same judgement `DEFAULT_MARK_POLICY` makes about liquidations, and for a
   * sharper reason: a printed rate here does not mis-value a position, it takes
   * the wrong number of units out of a balance and hands them to a rail.
   */
  it('refuses a last-trade rate and a stale rate, both by name', async () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const quote = (quality: MarkQuality, asOf: Date) =>
      quoteConversion({
        rates: { marks: async () => new Map([['BTC', { assetId: 'BTC', price: amt('50000'), asOf, quality }]]) },
        fundingAssetId: 'BTC',
        settlementAssetId: 'USDT',
        settlementAmount: amt('100'),
        previous: null,
        now,
        policy: DEFAULT_CARD_CONVERSION_POLICY,
      });

    await expect(quote('last', now)).rejects.toMatchObject({ code: 'bank.mark_unusable' });
    await expect(quote('mid', new Date(now.getTime() - 120_000))).rejects.toMatchObject({ code: 'bank.mark_unusable' });
    // And the one that works, so the two above are refusals and not a broken harness.
    expect((await quote('mid', now)).fundingAmount).toBe(amt('0.002'));
  });

  /**
   * THE BREAKER, AND THE WINDOW THAT ARMS IT.
   *
   * A rate that moved further than a real market does between two spends is
   * refused. But a card may not be used for a month, and comparing today's
   * swipe against a rate from March would refuse a genuine market at a till —
   * so outside the lookback the previous rate is not a comparison at all.
   */
  it('trips on a rate that jumped since the last spend, unless that spend is too old to compare with', async () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const quote = (previous: { rate: bigint; acceptedAt: Date } | null) =>
      quoteConversion({
        rates: { marks: async () => new Map([['BTC', { assetId: 'BTC', price: amt('25000'), asOf: now, quality: 'mid' }]]) },
        fundingAssetId: 'BTC',
        settlementAssetId: 'USDT',
        settlementAmount: amt('100'),
        previous,
        now,
        policy: DEFAULT_CARD_CONVERSION_POLICY,
      });

    // Halved since ten minutes ago — 5,000bps against a 2,000bps breaker.
    await expect(quote({ rate: amt('50000'), acceptedAt: new Date(now.getTime() - 600_000) })).rejects.toMatchObject({
      code: 'bank.mark_unusable',
    });
    // Same move, but the comparison is a day old and means nothing.
    expect((await quote({ rate: amt('50000'), acceptedAt: new Date(now.getTime() - 86_400_000) })).rate).toBe(amt('25000'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE MONEY PATH — real Postgres, real ledger postings.
// ═══════════════════════════════════════════════════════════════════════════════

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
      `H8a: svc-bank cards is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-bank cards (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-bank cards PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({
      service: 'bank',
      url: admin.url,
      migrations: [BANK_INIT, POSITION_PENDING, LOANS_MIGRATION, CARDS_MIGRATION, JIT_CONVERSION],
    });
    sql = db.sql;
  }, 120_000);

  /** 30s: dropping a database is heavier than closing a pool. See bank-service.test.ts. */
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('CardService', () => {
    let ledger: MemoryLedger;
    let cards: CardService;

    beforeEach(async () => {
      await sql`TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      cards = new CardService(sql, ledger, { issuer: cardSim() });
    });

    async function fund(userId: string, assetId: string, value: string) {
      await ledger.post(
        recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${Math.random()}` }),
      );
    }

    /** Real bank revenue, then swept into the pot cashback is paid from. */
    async function fundCashbackPot(assetId: string, value: string) {
      await fund(FEE_PAYER, assetId, value);
      await ledger.post(
        recipes.feeCharge({
          chargeId: `bank:${Math.random()}`,
          userId: FEE_PAYER,
          module: 'bank',
          mode: 'asset',
          assetId,
          amount: amt(value),
        }),
      );
      await cards.fundCashbackPot({ windowId: `w:${Math.random()}`, assetId, amount: amt(value) });
    }

    const availableOf = async (userId: string, assetId: string) =>
      formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);

    const heldOn = async (authorizationId: string, userId = HOLDER, assetId = 'USDT') =>
      formatAmount((await ledger.balance(withdrawalHoldAccount(userId, assetId, authorizationId))).amount);

    async function issueCard(options: { cashbackBps?: number; limit?: string; userId?: string } = {}) {
      return cards.issue({
        cardId: randomUUID(),
        userId: options.userId ?? HOLDER,
        assetId: 'USDT',
        ...(options.cashbackBps === undefined ? {} : { cashbackBps: options.cashbackBps }),
        perAuthorizationLimit: amt(options.limit ?? '1000'),
      });
    }

    // ── Issue ────────────────────────────────────────────────────────────────

    it('issues a card that says it is simulated, and no card number exists anywhere', async () => {
      const card = await issueCard();

      expect(card.simulated).toBe(true);
      expect(Object.hasOwn(card, 'simulated')).toBe(true);
      expect(JSON.parse(JSON.stringify({ simulated: card.simulated })).simulated).toBe(true);
      expect(card.issuer).toBe('card-sim');
      expect(card.panTail).toMatch(/^\d{4}$/);

      // The schema has no column a PAN could be stored in, and the guard in
      // bank-service.test.ts would fail the build on a money column; this is the
      // narrower claim that nothing card-number-shaped is persisted here.
      const columns = await sql<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_schema = 'bank' AND table_name = 'cards'
      `;
      const names = columns.map((c) => c.column_name);
      expect(names).not.toContain('pan');
      expect(names).not.toContain('card_number');
      expect(names.filter((n) => /balance|spendable|available/i.test(n))).toEqual([]);
    });

    it('is idempotent on the card id — a retried issue is one card, not two on one balance', async () => {
      const cardId = randomUUID();
      const first = await cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('500') });
      const second = await cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('500') });

      expect(second.id).toBe(first.id);
      const rows = await sql`SELECT id FROM bank.cards WHERE user_id = ${HOLDER}`;
      expect(rows).toHaveLength(1);
    });

    it('refuses to issue at all when the deployment has no issuer', async () => {
      const unconfigured = new CardService(sql, ledger);
      await expect(
        unconfigured.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') }),
      ).rejects.toMatchObject({ code: 'bank.no_card_issuer' });

      // And nothing was written on the way to refusing.
      const rows = await sql`SELECT id FROM bank.cards`;
      expect(rows).toHaveLength(0);
    });

    it('refuses issue and authorise when card-sim is under production posture — never holds as if a BIN exists', async () => {
      const live = new CardService(sql, ledger, { issuer: cardIssuerFor('card-sim', { NODE_ENV: 'production' }) });
      await expect(
        live.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') }),
      ).rejects.toMatchObject({ code: 'bank.card_sim_not_live' });
      expect(await sql`SELECT id FROM bank.cards`).toHaveLength(0);

      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const liveAuth = new CardService(sql, ledger, { issuer: cardIssuerFor('card-sim', { APP_ENV: 'prod' }) });
      await expect(liveAuth.authorize({ cardId: card.id, authorizationRef: 'auth-live', amount: amt('50') })).rejects.toMatchObject({
        code: 'bank.card_sim_not_live',
      });
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
      const auths = await sql`SELECT id FROM bank.card_authorizations`;
      expect(auths).toHaveLength(0);
    });

    // ── Authorise ────────────────────────────────────────────────────────────

    it('approves against a real ledger balance and holds the funds in this authorisation’s own account', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120'), merchantCategory: 'grocery' });

      expect(auth.decision).toBe('approved');
      expect(auth.status).toBe('settled');
      expect(auth.holdLedgerTxId).not.toBeNull();

      // The user's spendable balance fell, and the value is in a hold keyed to
      // THIS authorisation — not a shared per-user pot a second authorisation
      // could spend out from under it.
      expect(await availableOf(HOLDER, 'USDT')).toBe('380');
      expect(await heldOn(auth.id)).toBe('120');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('gives every authorisation a hold account of its own', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const first = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
      const second = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('50') });

      expect(await heldOn(first.id)).toBe('100');
      expect(await heldOn(second.id)).toBe('50');
      expect(await availableOf(HOLDER, 'USDT')).toBe('350');

      // Settling the first must not touch the second's reservation.
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
      expect(await heldOn(first.id)).toBe('0');
      expect(await heldOn(second.id)).toBe('50');
    });

    it('returns the FIRST decision when the issuer redelivers, and does not hold twice', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const first = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      const redelivered = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      expect(redelivered.id).toBe(first.id);
      expect(await availableOf(HOLDER, 'USDT')).toBe('380');
      expect(await heldOn(first.id)).toBe('120');

      const rows = await sql`SELECT id FROM bank.card_authorizations WHERE card_id = ${card.id}`;
      expect(rows).toHaveLength(1);
    });

    /**
     * THE FOUR DECLINES, EACH BY NAME.
     *
     * A decline is an answer a user will ask about days later, so it is a row
     * with a reason on it rather than an exception that vanishes. There is no
     * fifth reason and no score — risk modelling belongs to a rail this
     * deployment does not have.
     */
    it('declines an insufficient balance without moving anything, and records why', async () => {
      await fund(HOLDER, 'USDT', '50');
      const card = await issueCard();

      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      expect(auth.decision).toBe('declined');
      expect(auth.declineCode).toBe('ledger.insufficient_funds');
      expect(auth.holdLedgerTxId).toBeNull();
      expect(await availableOf(HOLDER, 'USDT')).toBe('50');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('declines on a frozen card, and the freeze is what a user reaches for first', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      await cards.setStatus(card.id, 'frozen');

      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') });
      expect(auth.decision).toBe('declined');
      expect(auth.declineCode).toBe('bank.card_not_active');
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
    });

    it('declines above the per-authorisation ceiling', async () => {
      await fund(HOLDER, 'USDT', '5000');
      const card = await issueCard({ limit: '200' });

      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200.000000000000000001') });
      expect(auth.declineCode).toBe('bank.card_limit_exceeded');

      // Exactly on the ceiling is under it, not over.
      const onTheLine = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('200') });
      expect(onTheLine.decision).toBe('approved');
    });

    it('refuses to reopen a closed card', async () => {
      const card = await issueCard();
      await cards.setStatus(card.id, 'closed');
      await expect(cards.setStatus(card.id, 'active')).rejects.toMatchObject({ code: 'bank.card_not_active' });
    });

    /**
     * A LEDGER THAT NEVER ANSWERED IS NOT A DECLINE.
     *
     * Turning an unreachable svc-ledger into "declined" would be answering no on
     * behalf of a system that never spoke — a lie the user pays for at the till.
     * The row stays claimed and a redelivery re-drives it.
     */
    it('does not manufacture a decline when the ledger itself is unavailable', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const broken = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async () => {
            throw new Error('svc-ledger unreachable');
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      const rows = await sql<Array<{ decision: string; status: string; hold_ledger_tx_id: string | null }>>`
        SELECT decision, status, hold_ledger_tx_id FROM bank.card_authorizations WHERE card_id = ${card.id}
      `;
      expect(rows[0]).toMatchObject({ decision: 'approved', status: 'pending', hold_ledger_tx_id: null });

      // And re-driving completes it, at the stored amount, not the number this
      // delivery arrived with. The hold post is idempotent on the authorisation's
      // own uuid.
      const redriven = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('80') });
      expect(redriven.status).toBe('settled');
      expect(redriven.decision).toBe('approved');
      expect(redriven.holdLedgerTxId).not.toBeNull();
      expect(formatAmount(redriven.amount)).toBe('10');
      expect(await heldOn(redriven.id)).toBe('10');
      expect(await availableOf(HOLDER, 'USDT')).toBe('490');
    });

    /**
     * A crash after the approved pending insert and before hold_ledger_tx_id is
     * written. Redelivery must post the stored hold, not hand back the pending
     * row, and not size the hold from whatever amount arrived this time.
     */
    it('re-drives an approved pending hold at the stored amount, and a second post does not move it again', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const broken = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey.startsWith('withdraw.hold:')) throw new Error('svc-ledger unreachable');
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      const stranded = await sql<Array<{ id: string; amount: string }>>`
        SELECT id, amount::text AS amount FROM bank.card_authorizations WHERE card_id = ${card.id}
      `;
      const authorizationId = stranded[0]!.id;
      expect(formatAmount(amt(stranded[0]!.amount))).toBe('10');

      // The post landed; the row update did not. The redelivery must reuse this key.
      const posted = await ledger.post(
        recipes.withdrawHold({
          userId: HOLDER,
          assetId: 'USDT',
          amount: amt('10'),
          rail: 'card-sim',
          withdrawalId: authorizationId,
        }),
      );
      const journalLength = ledger.journal().length;

      // A different number on the redelivery is not a new quote to hold against.
      const redriven = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('80') });

      expect(redriven.id).toBe(authorizationId);
      expect(redriven.status).toBe('settled');
      expect(redriven.decision).toBe('approved');
      expect(redriven.holdLedgerTxId).toBe(posted.id);
      expect(formatAmount(redriven.amount)).toBe('10');
      expect(ledger.journal().length).toBe(journalLength);
      expect(await heldOn(authorizationId)).toBe('10');
      expect(await availableOf(HOLDER, 'USDT')).toBe('490');
      expect(ledger.totalsByAsset().USDT).toBe('0');

      const hold = await ledger.getTxByKey(`withdraw.hold:${authorizationId}`);
      expect(hold?.meta).toMatchObject({ withdrawalId: authorizationId });
      expect(formatAmount(hold!.entries[0]!.amount)).toBe('10');

      const again = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('80') });
      expect(again.holdLedgerTxId).toBe(posted.id);
      expect(ledger.journal().length).toBe(journalLength);
      expect(await heldOn(authorizationId)).toBe('10');
    });

    it('returns a declined authorisation on redelivery and does not hold', async () => {
      await fund(HOLDER, 'USDT', '50');
      const card = await issueCard();

      const first = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      const again = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('1') });

      expect(again.id).toBe(first.id);
      expect(again.decision).toBe('declined');
      expect(again.status).toBe('rejected');
      expect(again.declineCode).toBe('ledger.insufficient_funds');
      expect(again.holdLedgerTxId).toBeNull();
      expect(await availableOf(HOLDER, 'USDT')).toBe('50');
      expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('withdraw.hold:'))).toHaveLength(0);
    });

    it('declines a re-driven hold when the ledger answers insufficient funds', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const broken = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey.startsWith('withdraw.hold:')) throw new Error('svc-ledger unreachable');
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      // The balance is gone before the re-drive. The ledger's answer is the decline.
      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-other', amount: amt('500') });
      const redriven = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') });

      expect(redriven.decision).toBe('declined');
      expect(redriven.declineCode).toBe('ledger.insufficient_funds');
      expect(redriven.status).toBe('rejected');
      expect(redriven.holdLedgerTxId).toBeNull();
      expect(await availableOf(HOLDER, 'USDT')).toBe('0');
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `withdraw.hold:${redriven.id}`)).toHaveLength(0);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('leaves the pending hold and throws when a re-drive cannot reach the ledger', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();

      const broken = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey.startsWith('withdraw.hold:')) throw new Error('svc-ledger unreachable');
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') })).rejects.toThrow(
        'svc-ledger unreachable',
      );
      await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('80') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      const rows = await sql<Array<{ decision: string; status: string; hold_ledger_tx_id: string | null; amount: string }>>`
        SELECT decision, status, hold_ledger_tx_id, amount::text AS amount
          FROM bank.card_authorizations WHERE card_id = ${card.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decision: 'approved', status: 'pending', hold_ledger_tx_id: null });
      expect(formatAmount(amt(rows[0]!.amount))).toBe('10');
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
      expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('withdraw.hold:'))).toHaveLength(0);
    });

    // ── Capture, reversal, and the hold that must end at zero ────────────────

    it('captures the full amount: value leaves the book at the rail boundary and the hold reads zero', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      expect(formatAmount(result.captured)).toBe('120');
      expect(formatAmount(result.returned)).toBe('0');
      expect(result.reversalLedgerTxId).toBeNull();

      expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('380');
      expect(formatAmount((await ledger.balance(railBoundary('card-sim', 'USDT'))).amount)).toBe('120');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    /**
     * THE PARTIAL CAPTURE, WHICH IS WHY THIS IS TWO POSTINGS.
     *
     * The merchant takes what they charged and the unspent remainder of the hold
     * goes back to the user in the same pass. Two facts, two rows, two ledger
     * transactions — and the invariant is checked on the hold ACCOUNT rather
     * than by adding up our own rows, because the ledger is the one that has to
     * be right.
     */
    it('captures part of an authorisation and returns the remainder in the same pass', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('75.5') });

      expect(formatAmount(result.captured)).toBe('75.5');
      expect(formatAmount(result.returned)).toBe('44.5');
      expect(result.reversalLedgerTxId).not.toBeNull();

      expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('424.5');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('returns the whole hold when an authorisation is voided or expires', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      const reversed = await cards.reverse({ cardId: card.id, authorizationRef: 'auth-1' });

      expect(formatAmount(reversed.returned)).toBe('120');
      expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses to capture an authorisation that was already settled, and to settle one twice', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      await expect(cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') })).rejects.toMatchObject({
        code: 'bank.card_authorization_closed',
      });
      await expect(cards.reverse({ cardId: card.id, authorizationRef: 'auth-1' })).rejects.toMatchObject({
        code: 'bank.card_authorization_closed',
      });

      // The double attempt moved nothing.
      expect(await availableOf(HOLDER, 'USDT')).toBe('380');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    // ── One failed post must not strand the hold ──────────────────────────────
    //
    // These three are the regression suite for a defect that had no test: the
    // "already settled" check counted every sequence-0 settlement row regardless
    // of status, so a post that threw — one transient svc-ledger blip — closed
    // the authorisation on the strength of a settlement that never happened. The
    // retry was refused, `reverse()` was refused because it comes through the
    // same check, and the user's entire hold sat in an account nothing could
    // reach. There was no operator surface to release it and none to read it.

    /** A CardService whose ledger refuses one kind of post, and only that one. */
    const ledgerFailingOn = (keyPrefix: string) => {
      const client = {
        ...ledger,
        balance: ledger.balance.bind(ledger),
        post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
          if (tx.idempotencyKey.startsWith(keyPrefix)) throw new Error('svc-ledger unreachable');
          return ledger.post(tx);
        },
      } as unknown as MemoryLedger;
      return new CardService(sql, client, { issuer: cardSim() });
    };

    it('re-drives a capture whose post failed, instead of stranding the whole hold', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      // The hold landed; the capture's post does not.
      const broken = ledgerFailingOn('withdraw.settle');
      await expect(broken.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      // The row records the failure, and the money is still held — not lost.
      const rows = await sql<Array<{ status: string; rejection_code: string | null }>>`
        SELECT status, rejection_code FROM bank.card_settlements WHERE authorization_id = ${auth.id} AND sequence = 0
      `;
      expect(rows[0]!.status).toBe('rejected');
      expect(await heldOn(auth.id)).toBe('120');

      // THE POINT: the retry is allowed through, and it completes.
      const captured = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      expect(formatAmount(captured.captured)).toBe('120');
      expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('380');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('lets reverse() release a hold after a failed capture, rather than refusing it as closed', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      const broken = ledgerFailingOn('withdraw.settle');
      await expect(broken.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      // The merchant never got paid, so the whole hold goes back to the user.
      const reversed = await cards.reverse({ cardId: card.id, authorizationRef: 'auth-1' });
      expect(formatAmount(reversed.returned)).toBe('120');
      expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    /**
     * The remainder case, and the reason `resumeSettlements` exists as a CALL.
     *
     * Sequence 0 settled, so the authorisation is correctly closed to new
     * decisions — re-driving `capture` is refused and should be. Without a
     * recovery procedure the user's unspent remainder has nothing left that can
     * move it.
     */
    it('recovers the remainder of a partial capture whose reversal post failed', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      const broken = ledgerFailingOn('withdraw.reverse');
      await expect(broken.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('50') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      // The merchant has their 50. The user's 70 is stuck in the hold account.
      expect(await heldOn(auth.id)).toBe('70');
      await expect(cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('50') })).rejects.toMatchObject({
        code: 'bank.card_authorization_closed',
      });

      const recovered = await cards.resumeSettlements({ cardId: card.id, authorizationRef: 'auth-1' });
      expect(recovered.resumed).toEqual([expect.objectContaining({ sequence: 1, kind: 'reversal', outcome: 'settled' })]);
      expect(formatAmount(recovered.held)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('450');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    /**
     * The ledger's business key is the authorisation, not the amount, and `post()`
     * returns an existing transaction for a reused key without comparing bodies.
     * So a second caller at the same sequence with a different amount used to be
     * handed the first caller's transaction and believe its own number — wrong
     * captured figure to the operator, wrong remainder reversed, cashback paid on
     * a value the ledger never saw.
     */
    it('refuses a settlement that disagrees with the amount its row was claimed for', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard({ cashbackBps: 500 });
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

      // Sequence 0 is claimed for 40 and its post fails, leaving the claim behind.
      const broken = ledgerFailingOn('withdraw.settle');
      await expect(broken.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('40') })).rejects.toThrow(
        'svc-ledger unreachable',
      );

      // A capture for a DIFFERENT amount is refused by name, not reconciled.
      await expect(cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') })).rejects.toMatchObject({
        code: 'bank.card_settlement_amount_conflict',
      });

      // Nothing moved, and no cashback was paid on a number nobody captured.
      expect(await heldOn(auth.id)).toBe('100');
      const cashback = await sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM bank.card_cashback WHERE authorization_id = ${auth.id}
      `;
      expect(cashback[0]!.count).toBe('0');

      // The claimed amount still completes, which is what a re-drive means.
      const captured = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('40') });
      expect(formatAmount(captured.captured)).toBe('40');
      expect(formatAmount(captured.returned)).toBe('60');
      expect(await heldOn(auth.id)).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    /**
     * A full capture and a reverse both use sequence 0. While the capture claim
     * is still pending they used to share that row, and once it carried a ledger
     * transaction id the reverse handed that id back as the reversal.
     *
     * The same kind at the same amount still is a re-drive: it returns the
     * existing transaction and posts nothing else. The other kind is a conflict.
     * A pending reversal is the same door, shut the other way.
     */
    it('refuses a reverse while a full capture claim is still pending, and does not report the capture transaction as the reversal', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      let releaseCapture!: () => void;
      const captureGate = new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      let capturePending!: () => void;
      const captureClaimed = new Promise<void>((resolve) => {
        capturePending = resolve;
      });
      let captureTxId = '';

      const pausing = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey.startsWith('withdraw.settle:')) {
              const posted = await ledger.post(tx);
              captureTxId = posted.id;
              capturePending();
              await captureGate;
              return posted;
            }
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      const captureInFlight = pausing.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      await captureClaimed;

      // The ledger has the capture. The row is still pending — the status write
      // has not happened — so a reverse can see the transaction id.
      await sql`
        UPDATE bank.card_settlements
           SET ledger_tx_id = ${captureTxId}
         WHERE authorization_id = ${auth.id} AND sequence = 0 AND status = 'pending'
      `;
      const pending = await sql<Array<{ kind: string; status: string; ledger_tx_id: string | null }>>`
        SELECT kind, status, ledger_tx_id FROM bank.card_settlements WHERE authorization_id = ${auth.id}
      `;
      expect(pending).toEqual([{ kind: 'capture', status: 'pending', ledger_tx_id: captureTxId }]);

      const settleCount = () => ledger.journal().filter((tx) => tx.idempotencyKey === `withdraw.settle:${auth.id}`).length;
      expect(settleCount()).toBe(1);

      // Same kind, same amount: the existing transaction, and no second movement.
      const redriven = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      expect(redriven.captureLedgerTxId).toBe(captureTxId);
      expect(settleCount()).toBe(1);

      await expect(pausing.reverse({ cardId: card.id, authorizationRef: 'auth-1' })).rejects.toMatchObject({
        code: 'bank.card_settlement_kind_conflict',
      });

      const afterReverse = await sql<Array<{ kind: string; status: string; ledger_tx_id: string | null }>>`
        SELECT kind, status, ledger_tx_id FROM bank.card_settlements WHERE authorization_id = ${auth.id}
      `;
      expect(afterReverse).toEqual([{ kind: 'capture', status: 'pending', ledger_tx_id: captureTxId }]);
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `withdraw.reverse:${auth.id}`)).toHaveLength(0);

      releaseCapture();
      const captured = await captureInFlight;
      expect(captured.captureLedgerTxId).toBe(captureTxId);
      expect(settleCount()).toBe(1);

      const settled = await sql<Array<{ kind: string; status: string; ledger_tx_id: string | null }>>`
        SELECT kind, status, ledger_tx_id FROM bank.card_settlements WHERE authorization_id = ${auth.id} AND sequence = 0
      `;
      expect(settled).toEqual([{ kind: 'capture', status: 'settled', ledger_tx_id: captureTxId }]);
      await expect(cards.reverse({ cardId: card.id, authorizationRef: 'auth-1' })).rejects.toMatchObject({
        code: 'bank.card_authorization_closed',
      });

      // The other direction: a pending reversal is not an open door for a capture.
      const voided = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('80') });
      let releaseReverse!: () => void;
      const reverseGate = new Promise<void>((resolve) => {
        releaseReverse = resolve;
      });
      let reversePending!: () => void;
      const reverseClaimed = new Promise<void>((resolve) => {
        reversePending = resolve;
      });
      let reverseTxId = '';
      const pausingReverse = new CardService(
        sql,
        {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey === `withdraw.reverse:${voided.id}`) {
              const posted = await ledger.post(tx);
              reverseTxId = posted.id;
              reversePending();
              await reverseGate;
              return posted;
            }
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger,
        { issuer: cardSim() },
      );

      const reverseInFlight = pausingReverse.reverse({ cardId: card.id, authorizationRef: 'auth-2' });
      await reverseClaimed;
      await sql`
        UPDATE bank.card_settlements
           SET ledger_tx_id = ${reverseTxId}
         WHERE authorization_id = ${voided.id} AND sequence = 0 AND status = 'pending'
      `;

      await expect(cards.capture({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('80') })).rejects.toMatchObject({
        code: 'bank.card_settlement_kind_conflict',
      });
      const reverseRow = await sql<Array<{ kind: string; status: string; ledger_tx_id: string | null }>>`
        SELECT kind, status, ledger_tx_id FROM bank.card_settlements WHERE authorization_id = ${voided.id}
      `;
      expect(reverseRow).toEqual([{ kind: 'reversal', status: 'pending', ledger_tx_id: reverseTxId }]);
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `withdraw.settle:${voided.id}`)).toHaveLength(0);

      releaseReverse();
      const reversed = await reverseInFlight;
      expect(reversed.ledgerTxId).toBe(reverseTxId);
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `withdraw.reverse:${voided.id}`)).toHaveLength(1);
      expect(await heldOn(voided.id)).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses a capture larger than what was authorised and held', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard();
      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });

      await expect(
        cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120.000000000000000001') }),
      ).rejects.toMatchObject({ code: 'bank.card_capture_exceeds_authorization' });
    });

    it('refuses to capture against a declined authorisation, which holds nothing', async () => {
      await fund(HOLDER, 'USDT', '10');
      const card = await issueCard();
      const declined = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') });
      expect(declined.decision).toBe('declined');

      await expect(cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('120') })).rejects.toMatchObject({
        code: 'bank.card_authorization_declined',
      });
    });

    it('refuses an authorisation reference this card has never seen', async () => {
      const card = await issueCard();
      await expect(cards.capture({ cardId: card.id, authorizationRef: 'never', amount: amt('1') })).rejects.toMatchObject({
        code: 'bank.card_authorization_not_found',
      });
    });

    // ── Cashback ─────────────────────────────────────────────────────────────

    it('pays cashback out of a pot funded from real bank revenue', async () => {
      await fund(HOLDER, 'USDT', '500');
      await fundCashbackPot('USDT', '10');
      const card = await issueCard({ cashbackBps: 100 }); // 1%

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });

      expect(result.cashback.status).toBe('paid');
      expect(formatAmount(result.cashback.amount)).toBe('2');

      // 500 − 200 spent + 2 back.
      expect(await availableOf(HOLDER, 'USDT')).toBe('302');
      expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('8');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('pays cashback on the CAPTURED amount, never on the authorised one', async () => {
      // A reward on an amount the merchant did not take would be cashback on a
      // purchase that did not happen at that size.
      await fund(HOLDER, 'USDT', '500');
      await fundCashbackPot('USDT', '10');
      const card = await issueCard({ cashbackBps: 100 });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('50') });

      expect(formatAmount(result.cashback.amount)).toBe('0.5');
    });

    it('pays nothing at all on a reversed authorisation', async () => {
      await fund(HOLDER, 'USDT', '500');
      await fundCashbackPot('USDT', '10');
      const card = await issueCard({ cashbackBps: 100 });

      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      await cards.reverse({ cardId: card.id, authorizationRef: 'auth-1' });

      expect(await cards.cashbackFor(auth.id)).toBeNull();
      expect(await availableOf(HOLDER, 'USDT')).toBe('500');
      expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('10');
    });

    /**
     * THE REFUSAL THAT MATTERS MOST IN THIS FILE.
     *
     * The pot is empty, so the advertised rate is not currently earned. The
     * capture still stands — undoing a purchase the merchant already has,
     * because a marketing promise could not be kept, would be the worse
     * failure — and the reward is refused BY NAME, on a row, where an operator
     * finds it on the day it became true.
     */
    it('refuses cashback by name when the pot is unfunded, and leaves the capture standing', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard({ cashbackBps: 100 });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });

      expect(result.cashback).toMatchObject({ status: 'refused', reason: 'bank.cashback_pot_unfunded' });
      expect(formatAmount(result.cashback.amount)).toBe('2');

      // The capture happened: the merchant has the money, the user does not.
      expect(await availableOf(HOLDER, 'USDT')).toBe('300');
      expect(formatAmount((await ledger.balance(railBoundary('card-sim', 'USDT'))).amount)).toBe('200');

      // And the unpaid reward is a row somebody can look at, not an absence.
      const record = await cards.cashbackFor(result.authorizationId);
      expect(record).toMatchObject({ status: 'rejected', rejectionCode: 'bank.cashback_pot_unfunded' });
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('pays nothing and records nothing when the card earns no cashback', async () => {
      await fund(HOLDER, 'USDT', '500');
      const card = await issueCard(); // 0 bps

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });

      // Not a refusal and not a payment. A zero-value posting to say "nothing
      // was earned" would be noise in the book.
      expect(result.cashback).toEqual({ status: 'none', amount: 0n });
      expect(await cards.cashbackFor(result.authorizationId)).toBeNull();
    });

    it('pays one cashback per authorisation however many times a capture is re-driven', async () => {
      await fund(HOLDER, 'USDT', '500');
      await fundCashbackPot('USDT', '10');
      const card = await issueCard({ cashbackBps: 100 });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      // The second capture is refused as closed, which is the guard that makes
      // the reward unrepeatable too.
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') }).catch(() => undefined);

      const rows = await sql`SELECT id FROM bank.card_cashback`;
      expect(rows).toHaveLength(1);
      expect(await availableOf(HOLDER, 'USDT')).toBe('302');
    });

    it('snapshots the rate, so re-rating the card later cannot rewrite what was promised', async () => {
      await fund(HOLDER, 'USDT', '500');
      await fundCashbackPot('USDT', '10');
      const card = await issueCard({ cashbackBps: 100 });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('200') });

      await sql`UPDATE bank.cards SET cashback_bps = 500 WHERE id = ${card.id}`;
      const rows = await sql<Array<{ rate_bps: number }>>`
        SELECT rate_bps FROM bank.card_cashback WHERE authorization_id = ${result.authorizationId}
      `;
      expect(Number(rows[0]!.rate_bps)).toBe(100);
    });

    // ── Ownership, and what a row can say about somebody else ────────────────

    it('never returns one user’s authorisations under another user’s card id', async () => {
      await fund(HOLDER, 'USDT', '500');
      const mine = await issueCard();
      const theirs = await issueCard({ userId: OTHER });

      await cards.authorize({ cardId: mine.id, authorizationRef: 'auth-1', amount: amt('10') });

      // The service reads by card, and the ROUTER owner-checks the card — the
      // same split as `transfers.executions`, where only the router knows what
      // the caller should be told. This pins the service half: no cross-card
      // bleed.
      expect(await cards.authorizationsOf(theirs.id, 50)).toHaveLength(0);
      expect(await cards.authorizationsOf(mine.id, 50)).toHaveLength(1);
    });

    // ── Conservation, over everything at once ────────────────────────────────

    it('conserves value across issue, authorise, decline, partial capture, reversal and cashback', async () => {
      await fund(HOLDER, 'USDT', '1000');
      await fundCashbackPot('USDT', '25');
      const card = await issueCard({ cashbackBps: 250 });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('300') });
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('180') });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('90') });
      await cards.reverse({ cardId: card.id, authorizationRef: 'auth-2' });

      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-3', amount: amt('5000') }); // declined: over limit

      expect(ledger.totalsByAsset().USDT).toBe('0');
      // 1000 − 180 captured + 4.5 cashback (2.5% of 180).
      expect(await availableOf(HOLDER, 'USDT')).toBe('824.5');
      expect(formatAmount((await ledger.balance(railBoundary('card-sim', 'USDT'))).amount)).toBe('180');
      expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('20.5');
    });

    it('leaves no value in any hold account once every authorisation is settled', async () => {
      await fund(HOLDER, 'USDT', '1000');
      const card = await issueCard();

      const a = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
      const b = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('200') });
      const c = await cards.authorize({ cardId: card.id, authorizationRef: 'auth-3', amount: amt('300') });

      await cards.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
      await cards.capture({ cardId: card.id, authorizationRef: 'auth-2', amount: amt('50') });
      await cards.reverse({ cardId: card.id, authorizationRef: 'auth-3' });

      for (const auth of [a, b, c]) expect(await heldOn(auth.id)).toBe('0');
      expect(await availableOf(HOLDER, 'USDT')).toBe('850');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    // ── The adapter cannot move value ────────────────────────────────────────

    /**
     * An issuer decides whether a card exists and carries our decision back to
     * the network. The LEDGER decides where money goes, through recipes (§0.6).
     * An adapter that posted anything would be a second book with a partner's
     * name on it — so the port is handed no ledger, and this is the behavioural
     * proof that nothing leaks one to it.
     */
    it('hands the issuer adapter nothing it could move money with', async () => {
      await fund(HOLDER, 'USDT', '500');

      const seen: unknown[] = [];
      const spy: CardIssuerAdapter = {
        programme: cardSim().programme,
        issue: async (input) => {
          seen.push(input);
          return cardSim().issue(input);
        },
        respondToAuthorization: async (input) => void seen.push(input),
        setStatus: async (input) => void seen.push(input),
      };

      const service = new CardService(sql, ledger, { issuer: spy });
      const card = await service.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('500') });
      await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') });

      const flattened = JSON.stringify(seen, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(flattened).not.toContain('post');
      expect(flattened).not.toContain('balance');
      for (const call of seen) {
        expect(Object.values(call as Record<string, unknown>).some((v) => typeof v === 'function')).toBe(false);
      }
    });

    /**
     * A DECISION ALREADY TRUE IS NOT UNDONE BY FAILING TO DELIVER IT.
     *
     * The funds are held and the row is written before the issuer is told. If
     * the network cannot be reached the scheme treats the silence as a decline
     * at the till, and the hold is released when the authorisation expires —
     * whereas throwing here would unwind a ledger transaction that has committed.
     */
    it('keeps the hold when the issuer cannot be told the answer', async () => {
      await fund(HOLDER, 'USDT', '500');
      const unreachable: CardIssuerAdapter = {
        programme: cardSim().programme,
        issue: cardSim().issue,
        respondToAuthorization: async () => {
          throw new BankError('issuer unreachable', 'bank.no_card_issuer');
        },
        setStatus: async () => undefined,
      };

      const service = new CardService(sql, ledger, { issuer: unreachable });
      const card = await service.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('500') });
      const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('10') });

      expect(auth.decision).toBe('approved');
      expect(await heldOn(auth.id)).toBe('10');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    // ── JIT conversion (§18) ─────────────────────────────────────────────────
    //
    // A card funded in BTC and charged in USDT. Every posting below is still a
    // BTC posting — available → hold → rail — because a conversion decides the
    // SIZE of one movement and is not a second movement. If any of these ever
    // starts touching a second asset on our book, that is a second money book
    // and `totalsByAsset` is what will say so.

    describe('a card charged in one asset and funded from another', () => {
      const NOW = new Date('2026-08-08T12:00:00Z');

      /** A rate feed whose answer, quality and timestamp a test can move under the service. */
      function movableRates(initial: { rate: string; quality?: MarkQuality; asOf?: Date }) {
        const state = { rate: initial.rate, quality: initial.quality ?? ('mid' as MarkQuality), asOf: initial.asOf ?? NOW, calls: 0 };
        const source: PriceSource = {
          marks: async (assetIds) => {
            state.calls += 1;
            const out = new Map<string, QuotedMark>();
            for (const assetId of assetIds) {
              out.set(assetId, { assetId, price: amt(state.rate), asOf: state.asOf, quality: state.quality });
            }
            return out;
          },
        };
        return { source, state };
      }

      const converting = (rates: PriceSource) => new CardService(sql, ledger, { issuer: cardSim(), rates, clock: () => NOW });

      const issueConverting = async (service: CardService, limit = '1') =>
        service.issue({
          cardId: randomUUID(),
          userId: HOLDER,
          assetId: 'BTC',
          settlementAssetId: 'USDT',
          perAuthorizationLimit: amt(limit),
        });

      /**
       * THE REFUSAL THIS SLICE EXISTS FOR.
       *
       * No rate source is configured — which is the state of every deployment,
       * because this platform has no FX feed. The authorisation does not become
       * a decline: a decline is an answer ("your money is not there") and
       * nobody answered. Nothing is written and nothing moves.
       */
      it('refuses by name when no rate can be got, and records no decision at all', async () => {
        await fund(HOLDER, 'BTC', '1');
        // Default options: `noConversionRates`. Not a mock — the shipping default.
        const service = new CardService(sql, ledger, { issuer: cardSim() });
        const card = await issueConverting(service);

        await expect(service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') })).rejects.toMatchObject({
          code: 'bank.mark_missing',
        });

        expect(await service.authorizationsOf(card.id, 50)).toEqual([]);
        const conversions = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.card_conversions`;
        expect(conversions[0]!.count).toBe('0');
        // The user still has every unit they had. A refusal moves nothing.
        expect(await availableOf(HOLDER, 'BTC')).toBe('1');
        expect(ledger.totalsByAsset().BTC).toBe('0');
      });

      it('refuses a stale rate rather than spending on a memory', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source } = movableRates({ rate: '50000', asOf: new Date(NOW.getTime() - 120_000) });
        const service = converting(source);
        const card = await issueConverting(service);

        await expect(service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') })).rejects.toMatchObject({
          code: 'bank.mark_unusable',
        });
        expect(await availableOf(HOLDER, 'BTC')).toBe('1');
      });

      it('holds the CONVERTED amount in the funding asset, and nothing in the settlement asset', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source } = movableRates({ rate: '50000' });
        const service = converting(source);
        const card = await issueConverting(service);

        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(auth.decision).toBe('approved');
        // 100 USDT at 50,000 USDT per BTC.
        expect(formatAmount(auth.amount)).toBe('0.002');
        expect(await heldOn(auth.id, HOLDER, 'BTC')).toBe('0.002');
        expect(await availableOf(HOLDER, 'BTC')).toBe('0.998');

        // The frozen quote, readable beside the decision.
        expect(auth.conversion).toMatchObject({ settlementAssetId: 'USDT', fundingAssetId: 'BTC', quality: 'mid' });
        expect(formatAmount(auth.conversion!.settlementAmount)).toBe('100');
        expect(formatAmount(auth.conversion!.rate)).toBe('50000');

        // NO SECOND ASSET MOVED. The settlement currency never touches our book;
        // the counterparty that hands it to the merchant is `socket.live-issuer`.
        expect(ledger.totalsByAsset().BTC).toBe('0');
        expect(ledger.totalsByAsset().USDT).toBeUndefined();
      });

      /**
       * THE BUG THIS DESIGN EXISTS TO MAKE IMPOSSIBLE.
       *
       * The rate moves 40% between the swipe and the clearing. A capture that
       * re-quoted would settle a different number of funding units than were
       * held: too many overdraws the hold account, too few leaves it above zero
       * with a silently wrong remainder. Either way the user is charged a rate
       * nobody showed them, days after they agreed a price at a till.
       */
      it('captures at the rate the authorisation was decided on, not the rate at capture time', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source, state } = movableRates({ rate: '50000' });
        const service = converting(source);
        const card = await issueConverting(service);

        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        expect(formatAmount(auth.amount)).toBe('0.002');

        // The market moves hard before the clearing file arrives.
        state.rate = '30000';
        const callsBefore = state.calls;

        const result = await service.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        // The feed was not asked again. Had it been, this would be 0.003334.
        expect(state.calls).toBe(callsBefore);
        expect(formatAmount(result.captured)).toBe('0.002');
        expect(formatAmount(result.returned)).toBe('0');
        expect(result.settlement).toMatchObject({ assetId: 'USDT' });
        expect(formatAmount(result.settlement!.rate)).toBe('50000');

        // THE INVARIANT, read off the account rather than added up from rows.
        expect(await heldOn(auth.id, HOLDER, 'BTC')).toBe('0');
        expect(ledger.totalsByAsset().BTC).toBe('0');
      });

      it('splits a partial capture at the frozen rate, and the hold still ends at zero', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source, state } = movableRates({ rate: '50000' });
        const service = converting(source);
        const card = await issueConverting(service);

        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        state.rate = '10';

        // The merchant clears 40 of the 100 they authorised.
        const result = await service.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('40') });

        expect(formatAmount(result.captured)).toBe('0.0008');
        expect(formatAmount(result.returned)).toBe('0.0012');
        expect(await heldOn(auth.id, HOLDER, 'BTC')).toBe('0');
        expect(await availableOf(HOLDER, 'BTC')).toBe('0.9992');
        expect(ledger.totalsByAsset().BTC).toBe('0');
      });

      it('refuses a capture larger than the merchant authorised, in the merchant’s own currency', async () => {
        await fund(HOLDER, 'BTC', '1');
        const service = converting(movableRates({ rate: '50000' }).source);
        const card = await issueConverting(service);
        await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        await expect(service.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100.01') })).rejects.toMatchObject({
          code: 'bank.card_capture_exceeds_authorization',
        });
      });

      /**
       * IDEMPOTENCY ACROSS A RATE MOVE.
       *
       * An issuer redelivers an authorisation and the market has moved in
       * between. The second delivery must return the FIRST decision at the FIRST
       * rate — one hold, one conversion row, one purchase. A service that
       * re-quoted on redelivery would hold twice, at two different sizes, for
       * one swipe.
       */
      it('re-drives a pending converted hold at the stored funding amount, not a fresh quote', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source, state } = movableRates({ rate: '50000' });
        const failing = {
          ...ledger,
          balance: ledger.balance.bind(ledger),
          post: async (tx: Parameters<MemoryLedger['post']>[0]) => {
            if (tx.idempotencyKey.startsWith('withdraw.hold:')) throw new Error('svc-ledger unreachable');
            return ledger.post(tx);
          },
        } as unknown as MemoryLedger;
        const broken = new CardService(sql, failing, { issuer: cardSim(), rates: source, clock: () => NOW });
        const card = await broken.issue({
          cardId: randomUUID(),
          userId: HOLDER,
          assetId: 'BTC',
          settlementAssetId: 'USDT',
          perAuthorizationLimit: amt('1'),
        });

        await expect(broken.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') })).rejects.toThrow(
          'svc-ledger unreachable',
        );
        const callsAfterDecision = state.calls;

        // Inside the deviation breaker, so a fresh quote would be a different hold.
        state.rate = '45000';
        const healthy = new CardService(sql, ledger, { issuer: cardSim(), rates: source, clock: () => NOW });
        const redriven = await healthy.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(state.calls).toBe(callsAfterDecision);
        expect(redriven.status).toBe('settled');
        expect(redriven.decision).toBe('approved');
        expect(formatAmount(redriven.amount)).toBe('0.002');
        expect(formatAmount(redriven.conversion!.rate)).toBe('50000');
        expect(await heldOn(redriven.id, HOLDER, 'BTC')).toBe('0.002');
        expect(await availableOf(HOLDER, 'BTC')).toBe('0.998');
        expect(ledger.totalsByAsset().BTC).toBe('0');

        const again = await healthy.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        expect(again.holdLedgerTxId).toBe(redriven.holdLedgerTxId);
        expect(state.calls).toBe(callsAfterDecision);
        expect(await heldOn(redriven.id, HOLDER, 'BTC')).toBe('0.002');
      });

      it('re-quotes nothing on a redelivered authorisation, and holds exactly once', async () => {
        await fund(HOLDER, 'BTC', '1');
        const { source, state } = movableRates({ rate: '50000' });
        const service = converting(source);
        const card = await issueConverting(service);

        const first = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        state.rate = '1000';
        const second = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(second.id).toBe(first.id);
        expect(formatAmount(second.amount)).toBe('0.002');
        expect(formatAmount(second.conversion!.rate)).toBe('50000');
        // ONE hold, not two, and one frozen quote.
        expect(await heldOn(first.id, HOLDER, 'BTC')).toBe('0.002');
        expect(await availableOf(HOLDER, 'BTC')).toBe('0.998');
        const rows = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.card_conversions`;
        expect(rows[0]!.count).toBe('1');
        expect(ledger.totalsByAsset().BTC).toBe('0');
      });

      /**
       * THE CEILING IS ON WHAT LEAVES THE BALANCE.
       *
       * Checked against the CONVERTED figure, because a limit denominated in the
       * asset the card draws on is a limit on what can leave that balance. A
       * settlement-denominated tier limit is a different thing and is not built.
       */
      it('declines on the converted amount when it breaches the funding-asset ceiling', async () => {
        await fund(HOLDER, 'BTC', '1');
        const service = converting(movableRates({ rate: '50000' }).source);
        // 0.001 BTC ceiling; 100 USDT converts to 0.002.
        const card = await issueConverting(service, '0.001');

        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(auth.decision).toBe('declined');
        expect(auth.declineCode).toBe('bank.card_limit_exceeded');
        // A decline is a decision and it gets a row — with the rate it was taken
        // at, so "why was I declined" can be answered in the merchant's numbers.
        expect(formatAmount(auth.conversion!.rate)).toBe('50000');
        expect(await availableOf(HOLDER, 'BTC')).toBe('1');
        expect(ledger.totalsByAsset().BTC).toBe('0');
      });

      /**
       * A CARD THAT CONVERTS NOTHING NEVER ASKS.
       *
       * This is what keeps every card that existed before §18 working in a
       * deployment with no rate adapter — which is every deployment. The source
       * below throws if it is touched at all.
       */
      it('consults no rate source for a card charged in the asset it draws on', async () => {
        await fund(HOLDER, 'USDT', '500');
        const exploding: PriceSource = {
          marks: async () => {
            throw new Error('a same-asset card must never reach the rate source');
          },
        };
        const service = new CardService(sql, ledger, { issuer: cardSim(), rates: exploding });
        const card = await service.issue({ cardId: randomUUID(), userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('500') });

        expect(card.settlementAssetId).toBe('USDT');
        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(auth.decision).toBe('approved');
        expect(auth.conversion).toBeNull();
        expect(await heldOn(auth.id)).toBe('100');

        const result = await service.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        expect(result.settlement).toBeNull();
        expect(await heldOn(auth.id)).toBe('0');
        expect(ledger.totalsByAsset().USDT).toBe('0');
      });

      /**
       * DOCTRINE §0.6, ON THE PATH THAT MOST WANTED A SECOND BOOK.
       *
       * A conversion is where a service starts believing it owes the user a swap
       * and opens a table to remember it in. This asserts the opposite from the
       * outside: after a full converted spend the books close, and the only
       * balance-shaped fact about the card is a ledger account.
       */
      it('moves value only through the ledger, and holds no conversion balance anywhere', async () => {
        await fund(HOLDER, 'BTC', '1');
        const service = converting(movableRates({ rate: '50000' }).source);
        const card = await issueConverting(service);
        const auth = await service.authorize({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });
        await service.capture({ cardId: card.id, authorizationRef: 'auth-1', amount: amt('100') });

        expect(ledger.totalsByAsset().BTC).toBe('0');
        expect(await heldOn(auth.id, HOLDER, 'BTC')).toBe('0');
        expect(await availableOf(HOLDER, 'BTC')).toBe('0.998');

        // Nothing on the conversion row accumulates or is revised after insert.
        const columns = await sql<Array<{ column_name: string }>>`
          SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'bank' AND table_name = 'card_conversions'
        `;
        const names = columns.map((c) => c.column_name);
        expect(names.filter((n) => /balance|available|held|outstanding|running|total/i.test(n))).toEqual([]);
        expect(names).not.toContain('updated_at');
      });
    });
  });
});
