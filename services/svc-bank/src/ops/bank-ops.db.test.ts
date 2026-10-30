/**
 * Operator bank reads, the operator card freeze, and the business-account gaps.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { memoryBusinessDirectory, type DirectoryPerson } from '../business/business-directory.js';
import { cardSim } from '../cards/issuer.js';
import { DEFAULT_LIQUIDATION_POLICY } from '../loans/risk.js';
import { fixedPriceSource } from '../loans/prices.js';
import { BANK_CRYPTO_LEDGER_RAIL, CRYPTO_LEDGER_PROGRAMME } from '../ramps/rails.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const MAKER = '33333333-3333-4333-8333-333333333333';
const CHECKER = '44444444-4444-4444-8444-444444444444';
const PAYEE = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function caller(
  bank: BankServices,
  userId: string,
  scopes: string[],
  approvals?: { consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> },
) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, approvals ? { approvals } : {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

function founderApprovals() {
  const rows = new Map<string, { hash: string; cardId: string; status: string }>();
  return {
    issue(cardId: string, status: 'frozen' | 'active') {
      const approvalId = randomUUID();
      const operationId = randomUUID();
      rows.set(approvalId, { hash: bankActionPayloadHash('bank.ops.setCardStatus', { cardId, status }), cardId, status });
      return { approvalId, operationId };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      if (!row || row.hash !== input.payloadHash || input.targetId !== 'bank.ops.setCardStatus') {
        throw new ActionApprovalConsumeError('approval does not match this card and status', 'action_approval.consume_failed');
      }
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: 'bank.ops.setCardStatus',
        targetService: 'svc-bank',
        targetId: 'bank.ops.setCardStatus',
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: OPERATOR,
        approverId: APPROVER,
        requesterIsFounder: true,
        approverIsFounder: true,
        policyVersion: 'v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.operationId,
      };
    },
  };
}

describe('bank operator reads and business gaps', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.card_operator_commands, bank.card_authorizations, bank.cards,
               bank.earn_positions, bank.earn_pools,
               bank.loans, bank.loan_products,
               bank.ramp_onramps, bank.ramp_offramps,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function services(extra: Parameters<typeof createBankServices>[3] = {}): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      cards: { issuer: cardSim() },
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
      ...extra,
    });
  }

  it('reads pool totals from the ledger and refuses a customer', async () => {
    const bank = services();
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Cash', aprBps: 100 });
    const positionId = randomUUID();
    const closedId = randomUUID();
    await sql`
      INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, status)
      VALUES (${positionId}, ${pool.id}, ${OWNER}, 'USDT', '999999', 'active'),
             (${closedId}, ${pool.id}, ${OWNER}, 'USDT', '50', 'closed')
    `;
    await ledger.post(
      recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('10.50'), rail: 'test', railRef: randomUUID() }),
    );
    await ledger.post(recipes.earnDeposit({ positionId, poolId: pool.id, userId: OWNER, assetId: 'USDT', amount: parseAmount('10.50') }));

    const operator = caller(bank, OPERATOR, ['admin:read']);
    const totals = await operator.ops.poolTotals();
    expect(totals.pools).toEqual([
      {
        poolId: pool.id,
        assetId: 'USDT',
        amountHeld: '10.5',
        amountReason: null,
        depositorCount: 1,
        utilisation: null,
        utilisationReason: 'utilisation_not_recorded',
      },
    ]);
    expect(JSON.stringify(totals)).not.toContain(OWNER);

    const boom = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'balance')
          return async () => {
            throw new Error('ledger down');
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as LedgerClient;
    const down = createBankServices(sql, boom, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', cards: { issuer: cardSim() } });
    const failed = await caller(down, OPERATOR, ['admin:read']).ops.poolTotals();
    expect(failed.pools[0]).toMatchObject({ amountHeld: null, amountReason: 'ledger_unavailable', depositorCount: 1 });

    await expect(caller(bank, OWNER, ['bank:read']).ops.poolTotals()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('bands the loan book at the opening thresholds and refuses a customer', async () => {
    const bank = services();
    const product = await bank.loans.createProduct({
      name: 'BTC-backed USDT',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 1_000,
      maxLtvBps: 5_000,
      minPrincipal: 0n,
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    const borrower = OWNER;
    await ledger.post(
      recipes.deposit({ userId: borrower, assetId: 'BTC', amount: parseAmount('30'), rail: 'test', railRef: randomUUID() }),
    );
    const opened = new Date(Date.now() - 3_600_000);
    const newer = new Date(Date.now() - 60_000);
    const rows = [
      { id: randomUUID(), debt: 'USDT', principal: '1', collateral: '2', status: 'active', at: new Date() },
      { id: randomUUID(), debt: 'USDT', principal: '3', collateral: '4', status: 'active', at: new Date() },
      { id: randomUUID(), debt: 'USDT', principal: '17', collateral: '20', status: 'active', at: new Date() },
      { id: randomUUID(), debt: 'USDC', principal: '5', collateral: '1', status: 'active', at: new Date() },
      { id: randomUUID(), debt: 'USDT', principal: '7', collateral: '1', status: 'pending', at: opened },
      { id: randomUUID(), debt: 'USDT', principal: '8', collateral: '1', status: 'pending', at: newer },
    ];
    for (const row of rows) {
      await sql`
        INSERT INTO bank.loans (
          id, product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal, status, opened_at,
          margin_call_ltv_bps, liquidation_ltv_bps
        ) VALUES (
          ${row.id}, ${product.id}, ${borrower}, ${row.debt}, 'BTC', 'USDT', 1000, ${row.principal}::numeric, ${row.status}::bank.loan_status, ${row.at},
          7500, 8500
        )
      `;
      if (row.status === 'active') {
        await ledger.post(
          recipes.loanCollateralLock({
            loanId: row.id,
            userId: borrower,
            collateralAssetId: 'BTC',
            amount: parseAmount(row.collateral),
            sequence: 0,
          }),
        );
      }
    }
    await sql`
      UPDATE bank.loan_products
         SET margin_call_ltv_bps = 8000, liquidation_ltv_bps = 9000
       WHERE id = ${product.id}
    `;

    const book = await caller(bank, OPERATOR, ['admin:read']).ops.loanBook();
    expect(book.openCount).toBe(4);
    expect(book.bands).toEqual({ healthy: 1, marginCall: 1, liquidation: 1, unpriced: 1 });
    expect(book.unpriced).toEqual([{ loanId: rows[3]!.id, reason: 'bank.loan_health_price_unset' }]);
    expect(book.outstandingPrincipal).toEqual([
      { assetId: 'USDC', amount: '5' },
      { assetId: 'USDT', amount: '21' },
    ]);
    expect(book.oldestPending).toMatchObject({ id: rows[4]!.id });
    expect(book.oldestPending?.ageSeconds).toBeGreaterThanOrEqual(3_590);
    expect(book.oldestPending?.ageSeconds).toBeLessThan(3_700);
    expect(JSON.stringify(book)).not.toContain(borrower);
    expect(formatAmount(parseAmount('1') + parseAmount('3') + parseAmount('17'))).toBe('21');

    await expect(caller(bank, OWNER, ['bank:read']).ops.loanBook()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('counts the card programme and freezes only with a matching approval', async () => {
    const approvals = founderApprovals();
    const bank = services();
    const owner = caller(bank, OWNER, ['bank:read', 'bank:write']);
    const active = await owner.cards.issue({ cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '100' });
    const frozen = await owner.cards.issue({ cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '100' });
    const closed = await owner.cards.issue({ cardId: randomUUID(), assetId: 'BTC', perAuthorizationLimit: '100' });
    await owner.cards.setStatus({ cardId: frozen.id, status: 'frozen' });
    await owner.cards.setStatus({ cardId: closed.id, status: 'closed' });
    await sql`
      INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, decision, decline_code, status, decided_at)
      VALUES
        (${active.id}, 'a1', '10.50', 'approved', NULL, 'pending', '2026-06-01T12:00:00Z'),
        (${active.id}, 'a2', '1', 'declined', 'bank.card_limit_exceeded', 'rejected', '2026-06-01T13:00:00Z'),
        (${closed.id}, 'a3', '2', 'approved', NULL, 'pending', '2026-06-02T01:00:00Z')
    `;

    const programme = await caller(bank, OPERATOR, ['admin:read']).ops.cardProgramme({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-03T00:00:00.000Z',
    });
    expect(programme.simulated).toBe(true);
    expect(programme.issued).toBe(3);
    expect(programme.active).toBe(1);
    expect(programme.frozen).toBe(1);
    expect(programme.days).toEqual([
      { day: '2026-06-01', volume: [{ assetId: 'USDT', amount: '10.5' }], declines: 1 },
      { day: '2026-06-02', volume: [{ assetId: 'BTC', amount: '2' }], declines: 0 },
    ]);
    await expect(caller(bank, OPERATOR, ['admin:read']).ops.cardProgramme({})).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_programme_span_unset'),
    });

    const operator = caller(bank, OPERATOR, ['admin:treasury'], approvals);
    await expect(
      operator.ops.setCardStatus({ cardId: active.id, status: 'frozen', reason: 'lost phone', clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await bank.cards.card(active.id)).status).toBe('active');

    const other = approvals.issue(frozen.id, 'frozen');
    await expect(
      operator.ops.setCardStatus({
        cardId: active.id,
        status: 'frozen',
        reason: 'customer reported theft',
        clientRequestId: randomUUID(),
        approvalId: other.approvalId,
        operationId: other.operationId,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await bank.cards.card(active.id)).status).toBe('active');

    const matched = approvals.issue(active.id, 'frozen');
    const clientRequestId = randomUUID();
    const first = await operator.ops.setCardStatus({
      cardId: active.id,
      status: 'frozen',
      reason: 'customer reported theft',
      clientRequestId,
      approvalId: matched.approvalId,
      operationId: matched.operationId,
    });
    expect(first).toEqual({ cardId: active.id, status: 'frozen', frozenBy: 'operator' });
    const second = await operator.ops.setCardStatus({
      cardId: active.id,
      status: 'frozen',
      reason: 'customer reported theft',
      clientRequestId,
      approvalId: matched.approvalId,
      operationId: matched.operationId,
    });
    expect(second).toEqual(first);
    const commands = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.card_operator_commands`;
    expect(Number(commands[0]?.n)).toBe(1);

    await expect(owner.cards.setStatus({ cardId: active.id, status: 'active' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_operator_frozen'),
    });
    expect((await bank.cards.card(active.id)).status).toBe('frozen');
    await expect(
      caller(bank, OWNER, ['bank:read']).ops.cardProgramme({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reports ramp health as an exact ratio and an unset provider', async () => {
    const bare = services();
    const empty = await caller(bare, OPERATOR, ['admin:read']).ops.rampHealth({ windowHours: 1 });
    expect(empty.rails.every((rail) => rail.provider === 'unset')).toBe(true);
    expect(empty.rails.every((rail) => rail.failureRate === null && rail.lastProbeAt === null && rail.reason === 'no_heartbeat')).toBe(
      true,
    );

    const bank = services({ ramps: { programme: CRYPTO_LEDGER_PROGRAMME } });
    for (let i = 0; i < 9; i += 1) {
      await sql`
        INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, rail, rail_ref, credited_by, status, ledger_tx_id)
        VALUES (${OWNER}, 'USDT', '1', ${BANK_CRYPTO_LEDGER_RAIL}, ${`ok-${i}`}, 'op', 'settled', ${`tx-${i}`})
      `;
    }
    for (let i = 0; i < 3; i += 1) {
      await sql`
        INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, rail, rail_ref, credited_by, status, rejection_code)
        VALUES (${OWNER}, 'USDT', '1', ${BANK_CRYPTO_LEDGER_RAIL}, ${`bad-${i}`}, 'op', 'rejected', 'bank.ramp_conflict')
      `;
    }
    const health = await caller(bank, OPERATOR, ['admin:read']).ops.rampHealth({ windowHours: 24 });
    const crypto = health.rails.find((rail) => rail.id === BANK_CRYPTO_LEDGER_RAIL);
    const fiat = health.rails.find((rail) => rail.id === 'fiat');
    expect(crypto).toMatchObject({
      provider: BANK_CRYPTO_LEDGER_RAIL,
      failureCount: 3,
      totalCount: 12,
      failureRate: '3/12',
      lastProbeAt: null,
      reason: 'no_heartbeat',
    });
    expect(fiat).toMatchObject({ provider: 'unset', failureRate: null, lastProbeAt: null, reason: 'no_heartbeat' });
    await expect(caller(bank, OPERATOR, ['admin:read']).ops.rampHealth({})).rejects.toMatchObject({
      message: expect.stringContaining('bank.ramp_health_window_unset'),
    });
    await expect(caller(bank, OWNER, ['bank:read']).ops.rampHealth({ windowHours: 24 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists business approvals for an operator without a write, and names handles', async () => {
    const people: DirectoryPerson[] = [
      { userId: OWNER, handle: 'Ada_Admin', email: 'ada@example.com', status: 'active', displayName: 'Ada', showDisplayName: true },
      { userId: MAKER, handle: 'Max_Maker', email: 'max@example.com', status: 'active' },
      { userId: CHECKER, handle: 'Cara_Check', email: 'cara@example.com', status: 'active' },
      { userId: PAYEE, handle: 'Pat_Payee', email: 'pat@example.com', status: 'active', displayName: 'Pat', showDisplayName: false },
    ];
    const bank = services({ directory: memoryBusinessDirectory(people) });
    const admin = caller(bank, OWNER, ['bank:read', 'bank:write']);
    const first = await admin.business.create({ accountId: randomUUID(), name: 'North', assetId: 'USDT', spendThreshold: '100' });
    const second = await admin.business.create({ accountId: randomUUID(), name: 'South', assetId: 'USDT', spendThreshold: '250' });
    await admin.business.addMember({ accountId: first.id, userId: MAKER, role: 'maker' });
    await admin.business.addMember({ accountId: first.id, userId: CHECKER, role: 'checker' });
    await admin.business.addMember({ accountId: second.id, userId: MAKER, role: 'maker' });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.ensurePrimary(PAYEE, 'USDT');
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: randomUUID() }));
    const maker = caller(bank, MAKER, ['bank:read', 'bank:write']);
    await maker.business.proposeTransfer({
      accountId: first.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '150',
      clientId: randomUUID(),
    });
    const south = await maker.business.proposeTransfer({
      accountId: second.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '300.50',
      clientId: randomUUID(),
    });
    expect(south.kind).toBe('pending');

    const pending = await maker.business.pending({ accountId: first.id, limit: 20 });
    expect(pending[0]).toMatchObject({
      makerHandle: 'Max_Maker',
      makerHandleReason: null,
      receiverOwnerHandle: 'Pat_Payee',
      receiverOwnerHandleReason: null,
      receiverOwnerName: null,
      amount: '150',
    });
    expect(pending[0]).not.toHaveProperty('makerUserId');
    expect(JSON.stringify(pending)).not.toContain(MAKER);
    expect(JSON.stringify(pending)).not.toContain(PAYEE);

    const history = await maker.business.approvals({ accountId: first.id, limit: 20 });
    expect(history.items[0]).toMatchObject({ makerHandle: 'Max_Maker', receiverOwnerHandle: 'Pat_Payee', receiverOwnerName: null });
    expect(history.items[0]).not.toHaveProperty('makerUserId');

    expect(await caller(bank, OWNER, ['bank:read']).business.myRole({ accountId: first.id })).toEqual({ role: 'admin' });
    expect(await caller(bank, MAKER, ['bank:read']).business.myRole({ accountId: first.id })).toEqual({ role: 'maker' });
    expect(await caller(bank, CHECKER, ['bank:read']).business.myRole({ accountId: first.id })).toEqual({ role: 'checker' });
    const unknownId = randomUUID();
    const [missingErr, unknownErr] = await Promise.all([
      caller(bank, STRANGER, ['bank:read'])
        .business.myRole({ accountId: first.id })
        .then(
          () => null,
          (err: { code: string; message: string; cause: { code: string } }) => err,
        ),
      caller(bank, STRANGER, ['bank:read'])
        .business.myRole({ accountId: unknownId })
        .then(
          () => null,
          (err: { code: string; message: string; cause: { code: string } }) => err,
        ),
    ]);
    expect(missingErr?.cause.code).toBe('bank.business_not_found');
    expect(unknownErr?.cause.code).toBe('bank.business_not_found');
    expect(missingErr?.code).toBe(unknownErr?.code);
    expect(missingErr?.message.replace(first.id, 'ID')).toBe(unknownErr?.message.replace(unknownId, 'ID'));

    const operator = caller(bank, OPERATOR, ['admin:read']);
    const all = await operator.ops.businessApprovals({ limit: 20 });
    expect(all.approvals).toHaveLength(2);
    expect(all.approvals.map((row) => [row.businessId, row.amount, row.rule, row.makerHandle])).toEqual(
      expect.arrayContaining([
        [first.id, '150', '100', 'Max_Maker'],
        [second.id, '300.5', '250', 'Max_Maker'],
      ]),
    );
    const page = await operator.ops.businessApprovals({ limit: 1 });
    expect(page.approvals).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await operator.ops.businessApprovals({ limit: 1, cursor: page.nextCursor! });
    const listed = [...page.approvals, ...rest.approvals];
    expect(listed.map((row) => row.businessId).sort()).toEqual([first.id, second.id].sort());
    expect(JSON.stringify(listed)).not.toContain(MAKER);
    await expect(operator.ops.businessApprovals({})).rejects.toMatchObject({
      message: expect.stringContaining('bank.ops_business_approvals_limit_unset'),
    });

    const procedures = (createBankRouter(bank) as unknown as { _def: { procedures: Record<string, { _def: { type: string } }> } })._def
      .procedures;
    const operatorBusinessWrites = Object.entries(procedures).filter(
      ([path, proc]) => path.startsWith('ops.') && path.toLowerCase().includes('business') && proc._def.type === 'mutation',
    );
    expect(operatorBusinessWrites).toEqual([]);
    expect(procedures['ops.businessApprovals']?._def.type).toBe('query');
    await expect(caller(bank, OWNER, ['bank:read']).ops.businessApprovals({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const quiet = services({
      directory: memoryBusinessDirectory(people.filter((person) => person.userId !== PAYEE)),
    });
    const unresolved = await caller(quiet, MAKER, ['bank:read']).business.pending({ accountId: first.id, limit: 20 });
    expect(unresolved[0]).toMatchObject({
      makerHandle: 'Max_Maker',
      receiverOwnerHandle: null,
      receiverOwnerHandleReason: 'handle_unresolved',
      receiverOwnerName: null,
    });
  });

  it('creates one business account for one client id and refuses a conflicting replay', async () => {
    const bank = services({
      directory: memoryBusinessDirectory([{ userId: OWNER, handle: 'Ada_Admin', email: 'ada@example.com', status: 'active' }]),
    });
    const admin = caller(bank, OWNER, ['bank:read', 'bank:write']);
    const accountId = randomUUID();
    const input = { accountId, name: 'North', assetId: 'USDT', spendThreshold: '100' };
    const first = await admin.business.create(input);
    const second = await admin.business.create(input);
    expect(second).toEqual(first);
    const accounts = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.business_accounts`;
    const members = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.business_members`;
    expect(Number(accounts[0]?.n)).toBe(1);
    expect(Number(members[0]?.n)).toBe(1);

    await expect(admin.business.create({ ...input, spendThreshold: '200' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.business_conflict'),
    });
    const other = caller(bank, MAKER, ['bank:write']);
    await expect(other.business.create(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.business_conflict'),
    });
  });
});
