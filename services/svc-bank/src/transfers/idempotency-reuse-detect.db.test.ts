/**
 * F-2.1. Payer A moves money between their own spaces under transfer id T, then
 * pays B's request with the same T. In ledger detect mode the book returns A's
 * original transaction as success. That must not mark B paid, and nothing may
 * move to B.
 *
 * The ledger here is PostgresLedger with idempotencyConflict 'detect' — the
 * mode svc-ledger used to boot in. MemoryLedger refuses a different body, so
 * it cannot see this hole.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Scope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, createTestDb, rewriteSchemaSql, type TestDatabase, type TestDb } from '@intafaced/db';
import { formatAmount, parseAmount, userAvailable } from '@intafaced/ledger-client';
import { PostgresLedger } from '../../../svc-ledger/src/ledger/postgres-ledger.js';
import { truncateBook } from '../../../svc-ledger/src/db/journal-guards.testkit.js';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import type { LedgerHistory } from '../analytics/ledger-history.js';
import { memoryPartyHandles } from './party-handles.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SID = '44444444-4444-4444-8444-444444444444';
const T = 'reuse-key-T1';

const tokenConfig = {
  secret: 'idemkey-test-signing-secret-long-enough-ok',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const bankDrizzle = join(here, '..', '..', 'drizzle');
const bankMigrations = readdirSync(bankDrizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(bankDrizzle, f), 'utf8'));

const ledgerDrizzle = join(here, '..', '..', '..', 'svc-ledger', 'drizzle');
const ledgerMigrations = readdirSync(ledgerDrizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(ledgerDrizzle, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const emptyHistory: LedgerHistory = { async entriesFor() { return []; } };

describe('reused transfer id under a detect-mode Postgres ledger', () => {
  let bankDb: TestDatabase;
  let ledgerDb: TestDb;
  let ledger: PostgresLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;

  beforeAll(async () => {
    const url = adminUrl();
    bankDb = await createTestDatabase({ service: 'bank', url, migrations: bankMigrations });
    ledgerDb = await createTestDb({ service: 'ledger', url, migrations: ledgerMigrations });
    ledger = new PostgresLedger(ledgerDb.sql, { idempotencyConflict: 'detect' });
    bank = createBankServices(bankDb.sql, ledger, emptyHistory, {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [A]: 'ada', [B]: 'bob' }),
    });
    router = createBankRouter(bank);
  }, 180_000);

  afterAll(async () => {
    await bankDb?.drop();
    await ledgerDb?.drop();
  }, 30_000);

  async function caller(userId: string, scopes: Scope[]) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'full', mfa: true }, tokenConfig);
    const ctx: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: 'idemkey',
    };
    return router.createCaller(ctx);
  }

  it('does not mark B paid when A reuses an own-space transfer id and nothing moves to B', async () => {
    await bankDb.sql`
      TRUNCATE bank.personal_request_reminds, bank.personal_transfers, bank.personal_requests,
               bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    await truncateBook(ledgerDb.sql, 'ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE');
    await ledgerDb.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;

    const payer = await caller(A, ['bank:read', 'bank:write']);
    const payee = await caller(B, ['bank:read', 'bank:write']);
    const primary = await bank.spaces.ensurePrimary(A, 'USDT');
    await bank.spaces.ensurePrimary(B, 'USDT');
    const named = await payer.spaces.create({ assetId: 'USDT', name: 'Spending' });
    await ledger.post(
      (await import('@intafaced/ledger-client')).recipes.deposit({
        userId: A,
        assetId: 'USDT',
        amount: parseAmount('100'),
        rail: 'test',
        railRef: 'idemkey-fund-a',
      }),
    );

    await bank.transfers.transfer({
      transferId: T,
      fromSpaceId: primary.id,
      toSpaceId: named.id,
      amount: parseAmount('10'),
    });

    const opened = await payee.personalRequest.create({
      payerUserId: A,
      assetId: 'USDT',
      amount: '15',
      expiresAt: '2026-12-01T00:00:00.000Z',
      idempotencyKey: 'idemkey-request-1',
    });

    await expect(
      payer.transfers.toUser({
        transferId: T,
        fromSpaceId: primary.id,
        toUserId: B,
        amount: '15',
        requestId: opened.requestId,
      }),
    ).rejects.toThrow();

    const request = await payee.personalRequest.get({ requestId: opened.requestId });
    expect(request.status).toBe('open');
    expect(request.ledgerTxId).toBeNull();

    const posted = await bankDb.sql<Array<{ status: string }>>`
      SELECT status FROM bank.personal_transfers WHERE transfer_id = ${T} AND status = 'posted'
    `;
    expect(posted).toHaveLength(0);
    expect(formatAmount((await ledger.balance(userAvailable(B, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(userAvailable(A, 'USDT'))).amount)).toBe('90');
    const namedSpace = await bank.spaces.get(named.id);
    expect(formatAmount(await bank.spaces.balanceOf(namedSpace))).toBe('10');
  });
});
