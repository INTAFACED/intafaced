import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerError, MemoryLedger, formatAmount, parseAmount, recipes, userAvailable, type PostRequest } from '@intafaced/ledger-client';
import { createWithdrawalHistory } from '../history.js';
import { RETURN_BLOCKER } from './schemas.js';
import { WithdrawalReturnService } from './service.js';

/** Returned withdrawals against a real Postgres with every forward migration. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_returns_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const FOUNDER = 'founder-1';
const SECOND = 'founder-2';

describe('returned withdrawals (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let service: WithdrawalReturnService;
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.withdrawals RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    service = new WithdrawalReturnService({ sql: db.sql, ledger });
  }, 30_000);

  const available = async () => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);

  /** The ledger side of a sent withdrawal, as svc-pay's withdraw posts it: 100 in, a hold of the amount, then the settle. */
  async function settledOnLedger(id: string, amount = '40') {
    const w = { userId: USER, assetId: 'USDT', amount: parseAmount(amount), rail: 'card-sandbox', withdrawalId: `${id}:0` };
    await ledger.post(
      recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('100'), rail: 'card-sandbox', railRef: `in-${id}` }),
    );
    await ledger.post(recipes.withdrawHold(w));
    await ledger.post(recipes.withdrawSettle(w));
  }

  let n = 0;
  async function withdrawal(status: string, amount = '40', rail = 'card-sandbox'): Promise<string> {
    n += 1;
    const [r] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status)
      VALUES (${USER}, 'USDT', ${amount}::numeric, ${rail}, ${db.sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })},
              ${`ref-${n}`}, ${status === 'sent' ? `rail-${n}` : null}, ${status}::pay.withdrawal_status)
      RETURNING id`;
    return r!.id;
  }
  const input = (
    withdrawalId: string,
    o: Partial<{
      returnRef: string;
      amount: string;
      reason: string;
      reasonCode: 'destination_rejected' | 'network_returned' | 'other';
    }> = {},
  ) => ({
    withdrawalId,
    returnRef: o.returnRef ?? `ret-${withdrawalId}`,
    amount: o.amount ?? '40',
    reason: o.reason ?? 'Beneficiary bank returned the transfer',
    reasonCode: o.reasonCode ?? ('destination_rejected' as const),
  });

  it('records a return of a sent withdrawal, parked with its blocker named, and books nothing', async () => {
    const id = await withdrawal('sent');
    const out = await service.record(FOUNDER, input(id));
    expect(out).toMatchObject({
      withdrawalId: id,
      state: 'parked',
      blocker: RETURN_BLOCKER,
      reasonCode: 'destination_rejected',
      amount: '40.000000000000000000',
      userId: USER,
      approvedBy: null,
      ledgerTxId: null,
    });
    expect(ledger.journal()).toHaveLength(0);
    const events = await db.sql<Array<{ kind: string }>>`SELECT kind FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id}`;
    expect(events.map((e) => e.kind)).toEqual(['recorded']);
  });

  it('a repeat with the same terms returns the same record and adds no event', async () => {
    const id = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    const again = await service.record(FOUNDER, input(id));
    expect(again.withdrawalId).toBe(id);
    const [counted] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.withdrawal_return_events`;
    const count = counted?.n;
    expect(count).toBe('1');
  });

  it('refuses a second return with other terms, and a reference that names another withdrawal', async () => {
    const a = await withdrawal('sent');
    const b = await withdrawal('sent');
    await service.record(FOUNDER, input(a, { returnRef: 'ret-a' }));
    await expect(service.record(FOUNDER, input(a, { returnRef: 'ret-other' }))).rejects.toMatchObject({
      code: 'withdrawal_return.already_recorded',
    });
    await expect(service.record(FOUNDER, input(a, { returnRef: 'ret-a', amount: '10' }))).rejects.toMatchObject({
      code: 'withdrawal_return.ref_differs',
    });
    await expect(service.record(FOUNDER, input(a, { returnRef: 'ret-a', reasonCode: 'other' }))).rejects.toMatchObject({
      code: 'withdrawal_return.ref_differs',
    });
    await expect(service.record(FOUNDER, input(b, { returnRef: 'ret-a' }))).rejects.toMatchObject({
      code: 'withdrawal_return.ref_differs',
    });
  });

  it('only a sent withdrawal can come back; an unknown id is not found', async () => {
    for (const status of ['pending', 'held', 'failed']) {
      const id = await withdrawal(status);
      await expect(service.record(FOUNDER, input(id))).rejects.toMatchObject({ code: 'withdrawal_return.not_sent' });
    }
    await expect(service.record(FOUNDER, input('33333333-3333-4333-8333-333333333333'))).rejects.toMatchObject({
      code: 'withdrawal_return.withdrawal_not_found',
    });
  });

  it('refuses an amount above the withdrawal and a zero amount', async () => {
    const id = await withdrawal('sent', '40');
    await expect(service.record(FOUNDER, input(id, { amount: '40.000000000000000001' }))).rejects.toMatchObject({
      code: 'withdrawal_return.amount_exceeds_withdrawal',
    });
    await expect(service.record(FOUNDER, input(id, { amount: '0' }))).rejects.toMatchObject({ code: 'withdrawal_return.amount_invalid' });
    const partial = await service.record(FOUNDER, input(id, { amount: '12.5' }));
    expect(partial.amount).toBe('12.500000000000000000');
  });

  it('lists newest first with a cursor, no row twice', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await withdrawal('sent');
      ids.push(id);
      await service.record(FOUNDER, input(id));
    }
    const first = await service.list({ limit: 2 });
    const second = await service.list({ limit: 2, after: first[1]!.withdrawalId });
    const third = await service.list({ limit: 2, after: second[1]!.withdrawalId });
    const seen = [...first, ...second, ...third].map((r) => r.withdrawalId);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice().sort()).toEqual(ids.slice().sort());
  });

  it('a second founder puts it back in available once; the founder who recorded it cannot', async () => {
    const id = await withdrawal('sent');
    await settledOnLedger(id);
    expect(await available()).toBe('60');
    const approve = (actor: string) => service.recredit(actor, { withdrawalId: id, reason: 'Checked the bank return notice' });
    await expect(approve(SECOND)).rejects.toMatchObject({ code: 'withdrawal_return.not_found' });
    await service.record(FOUNDER, input(id));

    await expect(approve(FOUNDER)).rejects.toMatchObject({ code: 'withdrawal_return.same_founder' });
    expect(await available()).toBe('60');
    expect((await service.get(id)).state).toBe('parked');

    const credited = await approve(SECOND);
    expect(credited).toMatchObject({ state: 'credited', blocker: null, approvedBy: SECOND });
    expect(credited.ledgerTxId).toBeTruthy();
    expect(await available()).toBe('100');
    const tx = await ledger.getTxByKey(`withdraw.returned:${id}:0`);
    expect(tx?.id).toBe(credited.ledgerTxId);

    // Again, by either founder: the same record, nothing booked twice.
    expect((await approve(SECOND)).ledgerTxId).toBe(credited.ledgerTxId);
    expect((await approve(FOUNDER)).ledgerTxId).toBe(credited.ledgerTxId);
    expect(await available()).toBe('100');
    const events = await db.sql<Array<{ kind: string }>>`
      SELECT kind FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id} ORDER BY seq`;
    expect(events.map((e) => e.kind)).toEqual(['recorded', 'approved', 'credited']);
  });

  it('a part of it back is that part', async () => {
    const id = await withdrawal('sent');
    await settledOnLedger(id);
    await service.record(FOUNDER, input(id, { amount: '12.5' }));
    await service.recredit(SECOND, { withdrawalId: id, reason: 'Partial return checked' });
    expect(await available()).toBe('72.5');
  });

  it('a ledger answer lost after the post: the approval stays, and the same approval records the one credit', async () => {
    const id = await withdrawal('sent');
    await settledOnLedger(id);
    await service.record(FOUNDER, input(id));
    let lose = true;
    const flaky = Object.create(ledger) as MemoryLedger;
    flaky.post = async (request: PostRequest) => {
      const tx = await ledger.post(request);
      if (lose) {
        lose = false;
        throw new Error('socket hang up');
      }
      return tx;
    };
    const crashing = new WithdrawalReturnService({ sql: db.sql, ledger: flaky });
    await expect(crashing.recredit(SECOND, { withdrawalId: id, reason: 'Checked' })).rejects.toMatchObject({
      code: 'withdrawal_return.ledger_outcome_unknown',
    });
    expect((await service.get(id)).state).toBe('crediting');
    expect(await available()).toBe('100');

    const done = await crashing.recredit(SECOND, { withdrawalId: id, reason: 'Checked' });
    expect(done.state).toBe('credited');
    expect(await available()).toBe('100');
  });

  it('a ledger that refuses before booking: nothing is credited, the approval stays, and a retry books it once', async () => {
    const id = await withdrawal('sent');
    await settledOnLedger(id);
    await service.record(FOUNDER, input(id));
    const down = Object.create(ledger) as MemoryLedger;
    down.post = async () => {
      throw new Error('ledger unavailable');
    };
    await expect(
      new WithdrawalReturnService({ sql: db.sql, ledger: down }).recredit(SECOND, { withdrawalId: id, reason: 'Checked' }),
    ).rejects.toMatchObject({
      code: 'withdrawal_return.ledger_outcome_unknown',
    });
    expect(await available()).toBe('60');
    expect(await service.get(id)).toMatchObject({ state: 'crediting', blocker: 'ledger.unknown' });
    expect((await service.recredit(FOUNDER, { withdrawalId: id, reason: 'Retry' })).state).toBe('credited');
    expect(await available()).toBe('100');
    expect((await service.get(id)).blocker).toBeNull();
  });

  it('a ledger that refuses the credit itself: a typed refusal, nothing booked, and the return names the ledger code', async () => {
    const id = await withdrawal('sent');
    await settledOnLedger(id);
    await service.record(FOUNDER, input(id));
    const refusing = Object.create(ledger) as MemoryLedger;
    refusing.post = async () => {
      throw new LedgerError('A returned withdrawal must match its posted settle: no posted settle', 'ledger.withdraw_return_unbound');
    };
    const refused = new WithdrawalReturnService({ sql: db.sql, ledger: refusing });
    for (let i = 0; i < 2; i += 1) {
      await expect(refused.recredit(SECOND, { withdrawalId: id, reason: 'Checked' })).rejects.toMatchObject({
        code: 'withdrawal_return.ledger_refused',
      });
    }
    expect(await available()).toBe('60');
    expect(await service.get(id)).toMatchObject({ state: 'crediting', blocker: 'ledger.withdraw_return_unbound', ledgerTxId: null });
    const kinds = await db.sql<Array<{ kind: string }>>`
      SELECT kind FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id} ORDER BY seq`;
    expect(kinds.map((k) => k.kind)).toEqual(['recorded', 'approved', 'credit_failed', 'credit_failed']);
  });

  it('a withdrawal settled inside the platform cannot be recorded as returned', async () => {
    const id = await withdrawal('sent', '40', 'internal');
    await expect(service.record(FOUNDER, input(id))).rejects.toMatchObject({ code: 'withdrawal_return.internal_settlement' });
    expect(await db.sql`SELECT 1 FROM pay.withdrawal_returns WHERE withdrawal_id = ${id}`).toHaveLength(0);
  });

  it('a return recorded before the recipe existed reads as waiting on the second founder, not on a missing recipe', async () => {
    const id = await withdrawal('sent');
    await db.sql`
      INSERT INTO pay.withdrawal_returns (withdrawal_id, return_ref, asset_id, amount, reason, state, blocker, recorded_by)
      VALUES (${id}, ${`old-${id}`}, 'USDT', 40, 'Recorded last week', 'parked', 'ledger.recipe_missing:userWithdrawReturned', ${FOUNDER})`;
    expect(await service.get(id)).toMatchObject({ state: 'parked', blocker: RETURN_BLOCKER, reasonCode: null });
  });

  it('a recorded return and its history cannot be edited or deleted', async () => {
    const id = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    await expect(db.sql`UPDATE pay.withdrawal_returns SET reason = 'x' WHERE withdrawal_id = ${id}`).rejects.toMatchObject({
      code: '23001',
    });
    await expect(db.sql`DELETE FROM pay.withdrawal_returns WHERE withdrawal_id = ${id}`).rejects.toMatchObject({ code: '23001' });
    await expect(db.sql`DELETE FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id}`).rejects.toMatchObject({ code: '23001' });
    await settledOnLedger(id);
    await service.recredit(SECOND, { withdrawalId: id, reason: 'Checked' });
    await expect(db.sql`DELETE FROM pay.withdrawal_return_postings WHERE withdrawal_id = ${id}`).rejects.toMatchObject({ code: '23001' });
    await expect(db.sql`UPDATE pay.withdrawal_return_credits SET note = 'x' WHERE withdrawal_id = ${id}`).rejects.toMatchObject({
      code: '23001',
    });
  });

  it("the customer's history flags it as returned and keeps the status settled", async () => {
    const id = await withdrawal('sent');
    const other = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    const page = await createWithdrawalHistory(db.sql).search(USER, { limit: 10 });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(id)).toMatchObject({
      status: 'settled',
      returned: true,
      returnedFunds: { amount: '40', reasonCode: 'destination_rejected', credited: false },
    });
    expect(byId.get(other)).toMatchObject({ status: 'settled', returned: false, returnedFunds: null });
    await settledOnLedger(id);
    await service.recredit(SECOND, { withdrawalId: id, reason: 'Checked' });
    const after = await createWithdrawalHistory(db.sql).search(USER, { limit: 10, id });
    expect(after.items[0]?.returnedFunds).toMatchObject({ credited: true });
  });
});
