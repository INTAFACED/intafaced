import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { createBankServices } from './bank-service.js';
import { cardIssuerFor } from './cards/issuer.js';
import { type PayFiatRampPort } from './ramps/pay-fiat-adapter.js';
import { CRYPTO_LEDGER_PROGRAMME } from './ramps/rails.js';
import { createBankRouter } from './router.js';

/**
 * Public bank actions. A simulated card programme must not pay cashback.
 * A simulated cash ramp must not post. The ledger client is the book.
 */

const SECRET = 'bank-simulated-cashback-ramp-edge-secret';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const FEE_PAYER = '99999999-9999-4999-8999-999999999999';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

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
      `H8a: simulated cashback ramp is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('simulated card capture pays no cashback', () => {
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

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions,
               bank.card_authorizations, bank.cards
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function caller(scopes: Principal['scopes'], userId = HOLDER) {
    const principal = {
      sub: userId,
      userId,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim') },
    });
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

  it('refuses rewards on capture while no issuer is connected and posts no cashback', async () => {
    await ledger.post(
      recipes.deposit({
        userId: HOLDER,
        assetId: 'USDT',
        amount: amt('500'),
        rail: 'test',
        railRef: `holder-${randomUUID()}`,
      }),
    );
    await ledger.post(
      recipes.deposit({
        userId: FEE_PAYER,
        assetId: 'USDT',
        amount: amt('10'),
        rail: 'test',
        railRef: `fee-${randomUUID()}`,
      }),
    );
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

    const ops = caller(['admin:treasury'], OPERATOR);
    const user = caller(['bank:read', 'bank:write']);
    await ops.ops.fundCashbackPot({
      windowId: `w-${randomUUID()}`,
      assetId: 'USDT',
      amount: '10',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });

    const programme = await user.cards.programme();
    expect(programme.simulated).toBe(true);

    const card = await user.cards.issue({
      cardId: randomUUID(),
      assetId: 'USDT',
      cashbackBps: 100,
      perAuthorizationLimit: '250',
    });
    expect(card.simulated).toBe(true);
    expect(card.issuer).toBe('card-sim');

    const authorizationRef = `auth-${randomUUID()}`;
    await ops.ops.cardAuthorize({
      cardId: card.id,
      authorizationRef,
      amount: '100',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    const captured = await ops.ops.cardCapture({
      cardId: card.id,
      authorizationRef,
      amount: '100',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });

    expect(captured.captured).toBe('100');
    expect(captured.cashback).toEqual({ status: 'refused', amount: '1', reason: 'bank.rewards_issuer_unset' });
    expect(ledger.journal().some((tx) => tx.reason === 'bank.card.cashback' || tx.idempotencyKey.startsWith('reward:'))).toBe(false);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('400'));

    await expect(user.cards.rewards()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.rewards_issuer_unset' },
    });
    const cashbackRows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM bank.card_cashback
    `;
    expect(cashbackRows[0]!.count).toBe('0');
  });

  it('reconciles a landed legacy reward but never posts a pending simulated reward on resume', async () => {
    await ledger.post(recipes.deposit({ userId: HOLDER, assetId: 'USDT', amount: amt('500'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(recipes.deposit({ userId: FEE_PAYER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(
      recipes.feeCharge({ chargeId: randomUUID(), userId: FEE_PAYER, module: 'bank', mode: 'asset', assetId: 'USDT', amount: amt('10') }),
    );
    const ops = caller(['admin:treasury'], OPERATOR);
    const user = caller(['bank:read', 'bank:write']);
    await ops.ops.fundCashbackPot({ windowId: randomUUID(), assetId: 'USDT', amount: '10', confirmOperatorId: CONFIRM, ...APPROVAL });
    const card = await user.cards.issue({ cardId: randomUUID(), assetId: 'USDT', cashbackBps: 100, perAuthorizationLimit: '250' });
    for (const ref of ['legacy-landed', 'legacy-missing']) {
      const authorization = await ops.ops.cardAuthorize({
        cardId: card.id,
        authorizationRef: ref,
        amount: '100',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
      const captured = await ops.ops.cardCapture({
        cardId: card.id,
        authorizationRef: ref,
        amount: '100',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
      expect(captured.cashback).toMatchObject({ status: 'refused', reason: 'bank.rewards_issuer_unset' });
      // These records model pending rows retained from the previous implementation.
      await sql`INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount) VALUES (${authorization.authorizationId}, 100, '1'::numeric)`;
      const landed =
        ref === 'legacy-landed'
          ? await ledger.post(
              recipes.rewardPay({
                rewardId: `bank.card.cashback:${authorization.authorizationId}`,
                userId: HOLDER,
                assetId: 'USDT',
                amount: amt('1'),
                reason: 'bank.card.cashback',
              }),
            )
          : null;
      const posts = ledger.journal().length;
      const resumed = await ops.ops.cardResumeSettlement({
        cardId: card.id,
        authorizationRef: ref,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
      expect(resumed.resumed).toEqual([]);
      expect(ledger.journal()).toHaveLength(posts);
      const rows = await sql<Array<{ status: string; ledger_tx_id: string | null; rejection_code: string | null }>>`
        SELECT status, ledger_tx_id, rejection_code FROM bank.card_cashback WHERE authorization_id = ${authorization.authorizationId}
      `;
      expect(rows).toEqual([{ status: landed ? 'settled' : 'pending', ledger_tx_id: landed?.id ?? null, rejection_code: null }]);
    }
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('301'));
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });
});

const livePay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
};

describe('simulated cash ramp posts nothing', () => {
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

  beforeEach(async () => {
    process.env.BANK_OFFRAMP_COOLING_HOURS = '0';
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function caller(scopes: Principal['scopes'], userId = HOLDER) {
    const principal = {
      sub: userId,
      userId,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay },
    });
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

  it('refuses a fiat on-ramp, off-ramp, and settle while the programme is simulated', async () => {
    const user = caller(['bank:read', 'bank:write']);
    const ops = caller(['admin:treasury'], OPERATOR);
    const programme = await user.ramps.programme();
    expect(programme.simulated).toBe(true);

    await expect(user.ramps.fiatSettle()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        code: 'bank.live_ramp_unset',
        message: expect.stringMatching(/outside company/i),
      },
    });

    await expect(
      ops.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '25',
        kind: 'fiat',
        railRef: `ach-in-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    await expect(
      user.ramps.offramp({
        offrampId: randomUUID(),
        assetId: 'USDT',
        amount: '10',
        kind: 'fiat',
        destinationRef: 'GB82WEST12345698765432',
        clientRef: `fiat-out-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    expect(ledger.journal()).toHaveLength(0);
    const counts = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bank.ramp_onramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.ramp_offramps
    `;
    expect(counts.every((row) => row.n === 0)).toBe(true);
  });
});
