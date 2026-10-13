import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { createBankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter } from '../router.js';
import { CARD_ISSUER_SETTINGS, cardIssuerFor, cardProgrammeOutput, noCardIssuer } from './issuer.js';

/**
 * CAN ANYBODY ACTUALLY CALL THIS? (§8.1 `bank.cards`, D-S-15)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND CARDS SUITE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `cards.test.ts` proves the money path is correct. It cannot prove the money
 * path is REACHABLE, because it reaches it the one way a caller never can: by
 * constructing `new CardService(sql, ledger, { issuer: cardSim() })` itself.
 *
 * That gap was real. The adapter, the simulator, the migration and 36 tests were
 * on main; the router mounted eleven card procedures with correct scopes; the
 * edge routed `/api/bank`. And `index.ts` passed no `cards` option to
 * `createBankServices`, so every deployment ran `noCardIssuer` with no setting
 * an operator could change. A tested module nobody can call presents identically
 * to one that works — the state D-S-15 named UNFINISHED, and the reason it named
 * it: there was no gate that told the two apart.
 *
 * This file is that gate. It enters through `createBankRouter(...).createCaller`
 * over a context built by the REAL `createEdgeContext` from a signed principal
 * header — the same construction `index.ts` mounts on `/trpc`, and the same
 * reason `router.mount.test.ts` refuses to use a `Context` literal. Nothing here
 * touches `CardService` directly. If the composition root stops wiring an issuer,
 * or the router stops mounting the procedures, or the scopes drift, these fail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS CAREFUL NOT TO CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That a card exists. It does not. Every assertion below that touches a card
 * also asserts `simulated: true`, deliberately, so this suite cannot be read as
 * evidence of a card programme. The live rail is `socket.live-issuer`: a
 * card-scheme sponsor and an issuing BIN, which is a contract and not a test.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '0000_bank_init.sql',
  '0001_position_pending.sql',
  '0002_bank_loans.sql',
  '0003_bank_cards.sql',
  '0007_card_jit_conversion.sql',
].map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const EDGE_SECRET = 'a-bank-cards-reachability-edge-secret-long-enough';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const FEE_PAYER = '99999999-9999-4999-8999-999999999999';

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
      `H8a: svc-bank cards.reachable is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · THE SELECTOR — no database, no ledger, no router.
// ═══════════════════════════════════════════════════════════════════════════════

describe('choosing an issuer is a closed decision with a refusing default', () => {
  it('offers exactly two settings, and no third one can be spelled', () => {
    expect([...CARD_ISSUER_SETTINGS]).toEqual(['none', 'card-sim']);
  });

  /**
   * The important half. Making the simulator selectable must not make it the
   * thing you get by accident — `'none'` is still what silence means, and the
   * mapping is a total `switch` rather than a `?? cardSim()` fallback.
   */
  it('maps the absent choice to the adapter that refuses everything', () => {
    expect(cardIssuerFor('none')).toBe(noCardIssuer);
    expect(cardIssuerFor('none').programme).toEqual({ id: 'none', simulated: true, displayName: 'No card programme' });
    expect(cardIssuerFor('none')).not.toBe(cardIssuerFor('card-sim'));
  });

  it('maps the only other choice to something that says it is a simulator', () => {
    const programme = cardIssuerFor('card-sim').programme;
    expect(programme.id).toBe('card-sim');
    expect(programme.simulated).toBe(true);
    expect(programme.displayName.toLowerCase()).toContain('simulated');
  });

  it('never omits simulated:true on either closed setting — neither is a live rail', () => {
    for (const setting of CARD_ISSUER_SETTINGS) {
      const programme = cardProgrammeOutput(cardIssuerFor(setting).programme);
      expect(Object.hasOwn(programme, 'simulated')).toBe(true);
      expect(programme.simulated).toBe(true);
      expect(JSON.stringify(programme)).toContain('"simulated":true');
    }
  });
});

describe('cards.reachable (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE WHOLE WAY IN — real Postgres, real postings, real edge context.
// ═══════════════════════════════════════════════════════════════════════════════

describe('svc-bank cards reachable (PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations: MIGRATIONS });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** A principal the EDGE signed. An unsigned one buys nothing — see router.mount.test.ts. */
  function caller(bank: ReturnType<typeof createBankServices>, scopes: Principal['scopes'], userId = HOLDER) {
    const p = {
      sub: userId,
      userId,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(p);
    return createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  describe('a signed caller reaches the card surface end to end', () => {
    let ledger: MemoryLedger;
    let bank: ReturnType<typeof createBankServices>;

    beforeEach(async () => {
      await sql`TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      // Exactly what index.ts now builds, for the operator who chose the
      // simulator. Nothing in this file constructs a CardService.
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        cards: { issuer: cardIssuerFor('card-sim') },
      });
    });

    async function fund(userId: string, assetId: string, value: string) {
      await ledger.post(
        recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
      );
    }

    /**
     * THE ONE THAT WOULD HAVE CAUGHT IT.
     *
     * Issue, authorise, capture — through the router, over the ledger, with no
     * direct service call anywhere in the path. Before this branch the first
     * line threw `bank.no_card_issuer` in every deployment there was.
     */
    it('issues, authorises and captures, and every amount on the wire is a decimal string', async () => {
      await fund(HOLDER, 'USDT', '500');

      const user = caller(bank, ['bank:read', 'bank:write']);
      const card = await user.cards.issue({
        cardId: randomUUID(),
        assetId: 'USDT',
        cashbackBps: 100,
        perAuthorizationLimit: '250',
      });

      // Money on the wire is a string, and it is the string we asked for.
      expect(card.perAuthorizationLimit).toBe('250');
      expect(typeof card.perAuthorizationLimit).toBe('string');
      // AND IT SAYS WHAT IT IS. Not optional, not inferred, not omitted.
      expect(card.simulated).toBe(true);
      expect(card.issuer).toBe('card-sim');

      const ops = caller(bank, ['admin:treasury'], OPERATOR);
      const authorizationRef = `auth-${randomUUID()}`;
      const authorized = await ops.ops.cardAuthorize({
        cardId: card.id,
        authorizationRef,
        amount: '80',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });

      expect(authorized.decision).toBe('approved');
      expect(authorized.amount).toBe('80');

      const captured = await ops.ops.cardCapture({
        cardId: card.id,
        authorizationRef,
        amount: '60',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });

      expect(captured.captured).toBe('60');
      // The unspent remainder came back in the same pass, as a string.
      expect(captured.returned).toBe('20');
      // No issuer is connected, so the reward refuses by name and the capture
      // still stands. A silent zero here would be the failure this refuses.
      expect(captured.cashback.status).toBe('refused');
      expect(captured.cashback.reason).toBe('bank.rewards_issuer_unset');

      // 500 − 60 captured, with the 20 remainder returned. Read off the LEDGER,
      // which is the only thing entitled to answer "how much".
      const balance = await ledger.balance(userAvailable(HOLDER, 'USDT'));
      expect(balance.amount).toBe(amt('440'));
    });

    /**
     * A DECLINE IS AN ANSWER, AND IT ARRIVES AS ONE.
     *
     * Reachability includes reaching the refusals. A surface that can only be
     * driven down its happy path has not been shown to work.
     */
    it('carries a named decline all the way back to the caller, and moves nothing', async () => {
      await fund(HOLDER, 'USDT', '10');

      const user = caller(bank, ['bank:read', 'bank:write']);
      const card = await user.cards.issue({ cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '250' });

      const ops = caller(bank, ['admin:treasury'], OPERATOR);
      const declined = await ops.ops.cardAuthorize({
        cardId: card.id,
        authorizationRef: `auth-${randomUUID()}`,
        amount: '80',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });

      expect(declined.decision).toBe('declined');
      expect(declined.declineCode).toBe('ledger.insufficient_funds');
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('10'));

      // And the user can read WHY, from their own history, without an operator.
      const history = await user.cards.authorizations({ cardId: card.id, limit: 50 });
      expect(history).toHaveLength(1);
      expect(history[0]?.declineCode).toBe('ledger.insufficient_funds');
    });

    /**
     * §18 OVER THE WIRE, INCLUDING THE PART THAT REFUSES.
     *
     * `createBankServices` is built above exactly as `index.ts` builds it for an
     * operator who chose the simulator — and with NO `rates`, which is the
     * shipping default and the honest state of every deployment, because this
     * platform has no FX source.
     *
     * So a card charged in an asset it does not draw on can be ISSUED, and the
     * settlement asset comes back as its own field rather than being inferred by
     * a screen. The authorisation then refuses by name, with a code the router
     * maps to PRECONDITION_FAILED — the PLATFORM is missing something, not the
     * caller. A 400 would tell an operator to fix their request, which is not
     * the problem and never becomes one by retrying.
     */
    it('issues a converted card and refuses its authorisation by name, because no rate exists', async () => {
      await fund(HOLDER, 'BTC', '1');

      const user = caller(bank, ['bank:read', 'bank:write']);
      const card = await user.cards.issue({
        cardId: randomUUID(),
        assetId: 'BTC',
        settlementAssetId: 'USDT',
        perAuthorizationLimit: '1',
      });

      expect(card.assetId).toBe('BTC');
      expect(card.settlementAssetId).toBe('USDT');
      expect(card.simulated).toBe(true);

      const ops = caller(bank, ['admin:treasury'], OPERATOR);
      await expect(
        ops.ops.cardAuthorize({
          cardId: card.id,
          authorizationRef: `auth-${randomUUID()}`,
          amount: '100',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      // NOT a decline, because nobody decided anything — there is no row at all.
      expect(await user.cards.authorizations({ cardId: card.id, limit: 50 })).toEqual([]);
      expect((await ledger.balance(userAvailable(HOLDER, 'BTC'))).amount).toBe(amt('1'));
    });

    /** A funded pot is not a rewards balance while the issuer is still card-sim. */
    it('does not pay a reward the operator funded while the issuer is simulated', async () => {
      await fund(HOLDER, 'USDT', '500');
      await fund(FEE_PAYER, 'USDT', '10');
      await ledger.post(
        recipes.feeCharge({
          chargeId: `bank:${randomUUID()}`,
          userId: FEE_PAYER,
          module: 'bank',
          mode: 'asset',
          assetId: 'USDT',
          amount: amt('10'),
        }),
      );

      const ops = caller(bank, ['admin:treasury'], OPERATOR);
      const funded = await ops.ops.fundCashbackPot({
        windowId: `w-${randomUUID()}`,
        assetId: 'USDT',
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
      expect(funded.capacity).toBe('10');

      const user = caller(bank, ['bank:read', 'bank:write']);
      const card = await user.cards.issue({ cardId: randomUUID(), assetId: 'USDT', cashbackBps: 100, perAuthorizationLimit: '250' });

      const authorizationRef = `auth-${randomUUID()}`;
      await ops.ops.cardAuthorize({ cardId: card.id, authorizationRef, amount: '100', confirmOperatorId: CONFIRM, ...APPROVAL });
      const captured = await ops.ops.cardCapture({
        cardId: card.id,
        authorizationRef,
        amount: '100',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });

      expect(captured.cashback.status).toBe('refused');
      expect(captured.cashback.reason).toBe('bank.rewards_issuer_unset');
      expect(captured.cashback.amount).toBe('1');
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('400'));
    });

    /**
     * THE SURFACE SAYS THERE IS NO CARD PROGRAMME, IN WORDS, BEFORE ANYONE ASKS.
     *
     * `programme` is a query, not an error path. An operator or a page finds out
     * what this deployment is from an answer rather than by attempting a
     * mutation and reading the failure.
     */
    it('states on a read that the programme is a simulator', async () => {
      const programme = await caller(bank, ['bank:read']).cards.programme();
      expect(programme).toEqual({ id: 'card-sim', simulated: true, displayName: 'Simulated card (no card programme)' });
    });

    /** The issuer's side is operator surface. A user session must never reach it. */
    it('refuses the authorisation procedures to a user session, however funded', async () => {
      await fund(HOLDER, 'USDT', '500');
      const user = caller(bank, ['bank:read', 'bank:write']);
      const card = await user.cards.issue({ cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '250' });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (user as any).ops.cardAuthorize({
          cardId: card.id,
          authorizationRef: `auth-${randomUUID()}`,
          amount: '10',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    /**
     * Hold recovery (#1102) is operator-only. A user who can re-drive settlements
     * can shape capture timing and cashback windows they do not own.
     * Same shape as ops.creditOnramp FORBIDDEN (#1186).
     */
    it('refuses ops.cardResumeSettlement for a user session without admin:treasury', async () => {
      const user = caller(bank, ['bank:read', 'bank:write']);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (user as any).ops.cardResumeSettlement({}),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * AND THE DEFAULT STILL REFUSES.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The whole risk of making the simulator reachable is that it becomes what a
   * deployment gets without asking. This is the assertion that it did not: the
   * same router, the same signed caller, an unconfigured composition root, and a
   * refusal with a name rather than a card.
   */
  describe('a deployment that chose nothing still has no card programme', () => {
    let bank: ReturnType<typeof createBankServices>;

    beforeEach(async () => {
      await sql`TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
      const ledger = new MemoryLedger();
      // No `cards` option. An omitted issuer must stay noCardIssuer, not card-sim.
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    });

    /**
     * `PRECONDITION_FAILED`, and the distinction is the whole point: this is the
     * PLATFORM missing something, not the caller getting something wrong. The
     * same shape as `bank.no_liquidation_counterparty`, and it is emphatically
     * not a decline — an unreachable programme must never be rendered as a card
     * that said no.
     */
    it('refuses to issue, by name, and never falls back to the simulator', async () => {
      await expect(
        caller(bank, ['bank:read', 'bank:write']).cards.issue({
          cardId: randomUUID(),
          assetId: 'USDT',
          perAuthorizationLimit: '250',
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'bank.no_card_issuer' } });
    });

    it('answers the programme query with the absence rather than an error', async () => {
      const programme = await caller(bank, ['bank:read']).cards.programme();
      expect(programme).toEqual({ id: 'none', simulated: true, displayName: 'No card programme' });
    });

    /** Nothing was written on the way to refusing. */
    it('leaves no card row behind', async () => {
      await caller(bank, ['bank:read', 'bank:write'])
        .cards.issue({ cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '250' })
        .catch(() => undefined);
      const rows = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.cards`;
      expect(rows[0]?.count).toBe('0');
    });
  });
});
