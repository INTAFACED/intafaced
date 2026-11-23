/**
 * D26-P1-B3 — bank.sovereign-card custodial JIT seal.
 *
 * Done bar: "JIT conversion refuse-invent rates sealed".
 *
 * Breaks caught:
 *   · a converted card authorises at an invented 1:1 (or any invented FX) when
 *     no rate feed answered — writing a decision the till never earned;
 *   · capture re-quotes after the market moves, settling a different funding
 *     size than the hold;
 *   · the settlement asset appears as a second balance on our book.
 *
 * Enter through the mounted router with a signed edge principal. Value moves
 * only via imported ledger-client recipes (MemoryLedger). No auto-invest /
 * business surfaces are touched.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amount, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import type { MarkQuality, PriceSource, QuotedMark } from '../loans/prices.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter } from '../router.js';
import { cardIssuerFor } from './issuer.js';

const SECRET = 'bank-sovereign-card-b3-product-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const NOW = new Date('2026-08-12T12:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
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
      `H8a: svc-bank sovereign-card-product is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

function movableRates(initial: { rate: string; quality?: MarkQuality; asOf?: Date }) {
  const state = {
    rate: initial.rate,
    quality: initial.quality ?? ('mid' as MarkQuality),
    asOf: initial.asOf ?? NOW,
    calls: 0,
  };
  const source: PriceSource = {
    marks: async (assetIds) => {
      state.calls += 1;
      const out = new Map<string, QuotedMark>();
      for (const assetId of assetIds) {
        out.set(assetId, { assetId, price: amount(state.rate), asOf: state.asOf, quality: state.quality });
      }
      return out;
    },
  };
  return { source, state };
}

describe('sovereign-card-product (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('mounted sovereign-card JIT doors (D26-P1-B3)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(userId: string, scopes: Principal['scopes']): Principal {
    return {
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
  }

  function signedCaller(bank: ReturnType<typeof createBankServices>, actor: Principal) {
    const raw = encodePrincipal(actor);
    return createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
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

  async function fund(userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amount(value),
        rail: 'test',
        railRef: `${userId}:${assetId}:${randomUUID()}`,
      }),
    );
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions,
               bank.card_authorizations, bank.cards
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('refuses converted authorisation by name when no rate exists — no invent FX, no row, no move', async () => {
    await fund(USER, 'BTC', '1');
    // Shipping default: noConversionRates. Not a mock of absence — the absence.
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim'), clock: () => NOW },
    });

    const user = signedCaller(bank, principal(USER, ['bank:read', 'bank:write']));
    const card = await user.cards.issue({
      cardId: randomUUID(),
      assetId: 'BTC',
      settlementAssetId: 'USDT',
      perAuthorizationLimit: '1',
    });

    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    await expect(
      ops.ops.cardAuthorize({
        cardId: card.id,
        authorizationRef: `auth-${randomUUID()}`,
        amount: '100',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.mark_missing' },
    });

    expect(await user.cards.authorizations({ cardId: card.id, limit: 50 })).toEqual([]);
    const conversions = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.card_conversions`;
    expect(conversions[0]?.count).toBe('0');
    expect((await ledger.balance(userAvailable(USER, 'BTC'))).amount).toBe(amount('1'));
    expect(ledger.totalsByAsset().USDT).toBeUndefined();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('captures at the frozen auth rate through the mounted door — never re-quotes; settlement asset never books', async () => {
    await fund(USER, 'BTC', '1');
    const { source, state } = movableRates({ rate: '50000' });
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim'), rates: source, clock: () => NOW },
    });

    const user = signedCaller(bank, principal(USER, ['bank:read', 'bank:write']));
    const card = await user.cards.issue({
      cardId: randomUUID(),
      assetId: 'BTC',
      settlementAssetId: 'USDT',
      perAuthorizationLimit: '1',
    });

    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    const authorizationRef = `auth-${randomUUID()}`;
    const auth = await ops.ops.cardAuthorize({ cardId: card.id, authorizationRef, amount: '100', confirmOperatorId: CONFIRM, ...APPROVAL });

    expect(auth.decision).toBe('approved');
    expect(auth.amount).toBe('0.002');
    expect(auth.conversion).toMatchObject({
      settlementAssetId: 'USDT',
      settlementAmount: '100',
      rate: '50000',
      rateQuality: 'mid',
    });

    state.rate = '30000';
    const callsBefore = state.calls;

    const captured = await ops.ops.cardCapture({
      cardId: card.id,
      authorizationRef,
      amount: '100',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });

    expect(state.calls).toBe(callsBefore);
    expect(captured.captured).toBe('0.002');
    expect(captured.returned).toBe('0');
    expect(captured.settlement).toMatchObject({ assetId: 'USDT', amount: '100', rate: '50000' });

    expect((await ledger.balance(userAvailable(USER, 'BTC'))).amount).toBe(amount('0.998'));
    expect(ledger.totalsByAsset().BTC).toBe('0');
    expect(ledger.totalsByAsset().USDT).toBeUndefined();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('same-asset cards never consult a rate source — converted seal does not regress pre-§18 cards', async () => {
    await fund(USER, 'USDT', '500');
    const exploding: PriceSource = {
      marks: async () => {
        throw new Error('same-asset card must never reach the rate source');
      },
    };
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim'), rates: exploding, clock: () => NOW },
    });

    const user = signedCaller(bank, principal(USER, ['bank:read', 'bank:write']));
    const card = await user.cards.issue({
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '250',
    });
    expect(card.settlementAssetId).toBe('USDT');

    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    const authorizationRef = `auth-${randomUUID()}`;
    const auth = await ops.ops.cardAuthorize({ cardId: card.id, authorizationRef, amount: '100', confirmOperatorId: CONFIRM, ...APPROVAL });
    expect(auth.decision).toBe('approved');
    expect(auth.conversion).toBeNull();

    const captured = await ops.ops.cardCapture({
      cardId: card.id,
      authorizationRef,
      amount: '100',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(captured.settlement).toBeNull();
    expect(ledger.totalsByAsset().USDT).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
