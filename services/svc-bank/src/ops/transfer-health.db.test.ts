/**
 * Operator transfer health, the failed list, and the drill-down.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { RECIPIENT_CANNOT_RECEIVE_MESSAGE } from '../spaces/space-service.js';
import { memoryPartyHandles } from '../transfers/party-handles.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CARA = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const SID = '99999999-9999-4999-8999-999999999999';
const KEY = '55555555-5555-4555-8555-555555555555';

function principal(userId: string, scopes: string[], kid?: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...(kid ? { kid } : {}),
  } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[], kid?: string) {
  const raw = encodePrincipal(principal(userId, scopes, kid));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank).createCaller(
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

describe('operator transfer health', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

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
      TRUNCATE bank.transfer_executions, bank.scheduled_transfers, bank.personal_transfers,
               bank.bill_payments, bank.spaces
      RESTART IDENTITY CASCADE
    `;
  });

  function services(handles: Readonly<Record<string, string>> | null = { [ADA]: 'ada', [BOB]: 'bob' }): BankServices {
    const ledger = new MemoryLedger();
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      ...(handles ? { handles: memoryPartyHandles(handles) } : {}),
    });
  }

  async function space(userId: string, name: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO bank.spaces (id, user_id, asset_id, kind, name)
      VALUES (${id}, ${userId}, 'USDT', 'named', ${name})
    `;
    return id;
  }

  async function schedule(userId: string, fromSpaceId: string, toSpaceId: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO bank.scheduled_transfers (
        id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, next_run_at, status
      ) VALUES (
        ${id}, ${userId}, 'USDT', ${fromSpaceId}, ${toSpaceId}, '25', 'monthly', now(), now(), 'active'
      )
    `;
    return id;
  }

  it('counts each standing-order status, an exact ratio, and leaves missing sources without a number', async () => {
    const adaFrom = await space(ADA, 'Ada from');
    const bobTo = await space(BOB, 'Bob to');
    const scheduleId = await schedule(ADA, adaFrom, bobTo);
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000);
    const pendingOld = new Date(Date.now() - 10 * 60 * 60 * 1000);
    let occurrence = 0;
    const execution = async (status: string, at: Date, code: string | null, ledger: string | null) => {
      const id = randomUUID();
      const n = occurrence;
      occurrence += 1;
      await sql`
        INSERT INTO bank.transfer_executions (
          id, schedule_id, occurrence, amount, status, rejection_code, ledger_tx_id, attempted_at, settled_at
        ) VALUES (
          ${id}, ${scheduleId}, ${n}, '1.50', ${status}::bank.execution_status, ${code}, ${ledger}, ${at},
          ${status === 'settled' ? at : null}
        )
      `;
    };
    for (let i = 0; i < 3; i += 1) await execution('rejected', recent, 'ledger.insufficient_funds', null);
    for (let i = 0; i < 4; i += 1) await execution('settled', recent, null, `tx-settled-${i}`);
    await execution('pending', pendingOld, null, null);
    await execution('pending', recent, null, null);
    await execution('pending', recent, null, null);
    await execution('skipped', recent, 'bank.schedule_paused', null);
    await execution('skipped', recent, 'bank.schedule_paused', null);
    await execution('rejected', old, 'ledger.insufficient_funds', null);
    await execution('pending', old, null, null);

    const reservedAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    for (const [transferId, status, ledger, at] of [
      ['xfer-reserved-a', 'reserved', null, reservedAt],
      ['xfer-reserved-b', 'reserved', null, recent],
      ['xfer-posted-a', 'posted', 'tx-one-a', recent],
      ['xfer-posted-b', 'posted', 'tx-one-b', recent],
      ['xfer-posted-c', 'posted', 'tx-one-c', recent],
      ['xfer-posted-old', 'posted', 'tx-one-old', old],
    ] as const) {
      await sql`
        INSERT INTO bank.personal_transfers (
          transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, created_at
        ) VALUES (
          ${transferId}, ${ledger}, ${ADA}, ${adaFrom}, ${BOB}, 'USDT', '8.00', ${status}, ${at}
        )
      `;
    }

    const billSpace = adaFrom;
    const submittedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const bills: Array<[string, string, string | null, Date]> = [
      ['submitted', 'bill-sub', null, submittedAt],
      ['accepted', 'bill-acc', null, recent],
      ['paid', 'bill-paid', null, recent],
      ['failed', 'bill-fail', 'bank.bills_rail_refused', recent],
      ['returned', 'bill-ret', null, recent],
      ['failed', 'bill-old', 'bank.bills_rail_refused', old],
    ];
    for (const [status, key, code, at] of bills) {
      await sql`
        INSERT INTO bank.bill_payments (
          id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
          status, failure_code, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${ADA}, ${key}, 'biller', 'ref', '4.00', 'USDT', ${billSpace},
          ${status}, ${code}, ${at}, ${at}
        )
      `;
    }

    const health = await caller(services(), OPERATOR, ['admin:read']).ops.transferHealth({ windowHours: 48 });
    expect(health.standingOrders).toMatchObject({
      pending: 3,
      settled: 4,
      rejected: 3,
      skipped: 2,
      total: 12,
      failureRate: '0.25',
    });
    expect(health.standingOrders.oldestPendingAgeSeconds).toBeGreaterThan(10 * 3600 - 30);
    expect(health.standingOrders.oldestPendingAgeSeconds).toBeLessThan(10 * 3600 + 30);
    expect(health.oneOff).toEqual({
      available: true,
      reserved: 2,
      posted: 3,
      total: 5,
      failureRate: null,
      failureRateReason: 'failures_not_recorded',
      oldestPendingAgeSeconds: expect.any(Number),
    });
    expect(health.oneOff.oldestPendingAgeSeconds).toBeGreaterThan(4 * 3600 - 30);
    expect(health.bills).toMatchObject({
      available: true,
      submitted: 1,
      accepted: 1,
      paid: 1,
      failed: 1,
      returned: 1,
      total: 5,
      failureRate: '0.2',
    });
    expect(health.p2p).toEqual({ available: false, reason: 'served_by_p2p_ops' });
    expect(Object.keys(health.p2p).sort()).toEqual(['available', 'reason']);
    const text = JSON.stringify(health);
    expect(text).not.toContain(ADA);
    expect(text).not.toContain(BOB);
    expect(text).not.toContain(scheduleId);

    const empty = await caller(services(), OPERATOR, ['admin:read']).ops.transferHealth({ windowHours: 1 });
    expect(empty.standingOrders.failureRate).toBeNull();
    expect(empty.standingOrders.failureRate).not.toBe(0);
    expect(empty.standingOrders.oldestPendingAgeSeconds).toBeNull();
    expect(empty.standingOrders.total).toBe(0);
    expect(empty.bills.failureRate).toBeNull();
    expect(empty.oneOff.failureRate).toBeNull();

    await expect(caller(services(), OPERATOR, ['admin:read']).ops.transferHealth({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('bank.transfer_health_window_unset'),
    });
    await expect(caller(services(), ADA, ['bank:read']).ops.transferHealth({ windowHours: 24 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lists rejected standing orders newest first, pages without gaps, and refuses the wrong session', async () => {
    const adaFrom = await space(ADA, 'Ada from');
    const adaTo = await space(ADA, 'Ada to');
    const bobFrom = await space(BOB, 'Bob from');
    const bobTo = await space(BOB, 'Bob to');
    const caraTo = await space(CARA, 'Cara to');
    const adaToBob = await schedule(ADA, adaFrom, bobTo);
    const adaToCara = await schedule(ADA, adaFrom, caraTo);
    const bobToAda = await schedule(BOB, bobFrom, adaTo);
    const base = new Date(Date.now() - 60 * 60 * 1000);
    const newest = randomUUID();
    const middle = randomUUID();
    const oldest = randomUUID();
    const settled = randomUUID();
    const outside = randomUUID();
    const sameMsNewer = randomUUID();
    const sameMsOlder = randomUUID();
    const insert = async (
      id: string,
      scheduleId: string,
      occurrence: number,
      status: string,
      code: string | null,
      ledger: string | null,
      at: Date | string,
    ) => {
      await sql`
        INSERT INTO bank.transfer_executions (
          id, schedule_id, occurrence, amount, status, rejection_code, ledger_tx_id, attempted_at, settled_at
        ) VALUES (
          ${id}, ${scheduleId}, ${occurrence}, '10.50', ${status}::bank.execution_status, ${code}, ${ledger},
          ${at}::timestamptz, ${status === 'settled' ? at : null}::timestamptz
        )
      `;
    };
    await insert(oldest, bobToAda, 0, 'rejected', 'vendor.mystery', null, new Date(base.getTime() - 3000));
    await insert(middle, adaToCara, 0, 'rejected', 'bank.recipient_cannot_receive', null, new Date(base.getTime() - 2000));
    await insert(newest, adaToBob, 0, 'rejected', 'ledger.insufficient_funds', null, new Date(base.getTime() - 1000));
    await insert(settled, adaToBob, 1, 'settled', null, 'tx-settled-page', new Date(base.getTime() + 5000));
    await insert(outside, adaToBob, 2, 'rejected', 'ledger.insufficient_funds', null, new Date(Date.now() - 100 * 60 * 60 * 1000));
    await sql`
      INSERT INTO bank.transfer_executions (
        id, schedule_id, occurrence, amount, status, rejection_code, attempted_at
      ) VALUES
        (${sameMsNewer}, ${adaToBob}, 3, '1', 'rejected', 'ledger.insufficient_funds', ${base}::timestamptz),
        (${sameMsOlder}, ${adaToBob}, 4, '1', 'rejected', 'ledger.insufficient_funds', ${base}::timestamptz - interval '300 microseconds')
    `;

    const ops = caller(services(), OPERATOR, ['admin:compliance']);
    const first = await ops.ops.failedTransfers({ windowHours: 48, limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([sameMsNewer, sameMsOlder]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await ops.ops.failedTransfers({ windowHours: 48, limit: 2, cursor: first.nextCursor ?? undefined });
    const third = await ops.ops.failedTransfers({ windowHours: 48, limit: 2, cursor: second.nextCursor ?? undefined });
    const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
    expect(ids).toEqual([sameMsNewer, sameMsOlder, newest, middle, oldest]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(third.nextCursor).toBeNull();
    expect(ids).not.toContain(settled);
    expect(ids).not.toContain(outside);

    const listed = second.items[0];
    expect(listed).toMatchObject({
      id: newest,
      kind: 'standing_order',
      amount: '10.5',
      assetId: 'USDT',
      status: 'rejected',
      rejectionCode: 'ledger.insufficient_funds',
      reason: 'ledger.insufficient_funds',
      sender: { handle: 'ada', reason: null },
      receiver: { handle: 'bob', reason: null },
    });
    expect(second.items[1]).toMatchObject({
      id: middle,
      rejectionCode: 'bank.recipient_cannot_receive',
      reason: RECIPIENT_CANNOT_RECEIVE_MESSAGE,
      sender: { handle: 'ada', reason: null },
      receiver: { handle: null, reason: 'handle_unresolved' },
    });
    const listedText = JSON.stringify(first.items.concat(second.items, third.items));
    expect(listedText).not.toContain(ADA);
    expect(listedText).not.toContain(BOB);
    expect(listedText).not.toContain(CARA);

    await expect(ops.ops.failedTransfers({ windowHours: 48 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('bank.failed_transfers_limit_unset'),
    });
    await expect(caller(services(), OPERATOR, ['admin:read']).ops.failedTransfers({ windowHours: 48, limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(services(), ADA, ['bank:read', 'bank:write']).ops.failedTransfers({ windowHours: 48, limit: 10 }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(services(), OPERATOR, ['admin:compliance'], KEY).ops.failedTransfers({ windowHours: 48, limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(services(null), OPERATOR, ['admin:compliance']).ops.failedTransfers({ windowHours: 48, limit: 2 }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('IDENTITY_URL'),
    });
  });

  it('returns the stored row, the same not-found for a bad id, and an audit line', async () => {
    const adaFrom = await space(ADA, 'Ada from');
    const bobTo = await space(BOB, 'Bob to');
    const scheduleId = await schedule(ADA, adaFrom, bobTo);
    const id = randomUUID();
    const attempted = new Date(Date.now() - 60 * 60 * 1000);
    await sql`
      INSERT INTO bank.transfer_executions (
        id, schedule_id, occurrence, amount, status, rejection_code, attempted_at
      ) VALUES (
        ${id}, ${scheduleId}, 7, '10.50', 'rejected', 'ledger.insufficient_funds', ${attempted}
      )
    `;
    await sql`
      INSERT INTO bank.personal_transfers (
        transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status
      ) VALUES (
        'xfer-detail-1', 'tx-detail-1', ${ADA}, ${adaFrom}, ${BOB}, 'USDT', '3.00', 'posted'
      )
    `;

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((msg) => {
      lines.push(String(msg));
    });
    try {
      const ops = caller(services(), OPERATOR, ['admin:compliance']);
      const row = await ops.ops.transferDetail({ id });
      expect(row).toMatchObject({
        id,
        kind: 'standing_order',
        senderUserId: ADA,
        receiverUserId: BOB,
        amount: '10.5',
        assetId: 'USDT',
        status: 'rejected',
        rejectionCode: 'ledger.insufficient_funds',
        reason: 'ledger.insufficient_funds',
        ledgerTxId: null,
        scheduleId,
        occurrence: 7,
      });
      expect(row.attemptedAt).toBe(attempted.toISOString());
      const oneOff = await ops.ops.transferDetail({ id: 'xfer-detail-1' });
      expect(oneOff).toMatchObject({
        id: 'xfer-detail-1',
        kind: 'one_off',
        senderUserId: ADA,
        receiverUserId: BOB,
        amount: '3',
        status: 'posted',
        ledgerTxId: 'tx-detail-1',
        scheduleId: null,
        occurrence: null,
        rejectionCode: null,
      });

      const missing = randomUUID();
      const unknown = await ops.ops.transferDetail({ id: missing }).catch((err: unknown) => err);
      const malformed = await ops.ops.transferDetail({ id: 'not-an-id' }).catch((err: unknown) => err);
      expect(unknown).toMatchObject({ code: 'NOT_FOUND', message: 'No such transfer (bank.ops_transfer_not_found)' });
      expect(malformed).toMatchObject({ code: 'NOT_FOUND', message: 'No such transfer (bank.ops_transfer_not_found)' });

      const audits = lines
        .map((line) => {
          try {
            return JSON.parse(line) as { event?: string; actorUserId?: string; id?: string };
          } catch {
            return null;
          }
        })
        .filter((line) => line?.event === 'bank.ops.transfer_detail_read');
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorUserId: OPERATOR, id }),
          expect.objectContaining({ actorUserId: OPERATOR, id: missing }),
          expect.objectContaining({ actorUserId: OPERATOR, id: 'not-an-id' }),
        ]),
      );
    } finally {
      spy.mockRestore();
    }

    const bank = services();
    await expect(caller(bank, ADA, ['bank:read']).ops.transferDetail({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, OPERATOR, ['admin:read']).ops.transferDetail({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, OPERATOR, ['admin:compliance'], KEY).ops.transferDetail({ id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller(bank, OPERATOR, ['admin:read'], KEY).ops.transferHealth({ windowHours: 24 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const ada = caller(bank, ADA, ['bank:read']);
    const own = await ada.transfers.listSchedules({ limit: 10 });
    expect(own.map((row) => row.id)).toEqual([scheduleId]);
    const bob = caller(bank, BOB, ['bank:read']);
    expect(await bob.transfers.listSchedules({ limit: 10 })).toEqual([]);
    await expect(bob.transfers.executions({ scheduleId, limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const executions = await ada.transfers.executions({ scheduleId, limit: 10 });
    expect(executions).toEqual([
      expect.objectContaining({ occurrence: 7, status: 'rejected', amount: '10.5', rejectionCode: 'ledger.insufficient_funds' }),
    ]);
  });
});
