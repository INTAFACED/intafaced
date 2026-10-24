import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { InsufficientFundsError, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
import { planDue, type Cadence } from '../transfers/schedule.js';
import { personalPayError, PSP_BLOCKER } from './errors.js';
import type { BillPorts, Biller, BillLookup, PortStatus } from './ports.js';
import { forwardKey, postToRail, reverseFromRail } from './post.js';

/**
 * Personal bill pay over one ledger.
 *
 * Search, lookup and pay all refuse while their port is unset. Pay records
 * the original instruction first, then either refuses with nothing posted or
 * posts once through ledger-client. A retry of the same key is that same
 * instruction. Recurring create refuses until the pay rail is live, because a
 * schedule that cannot pay is not a schedule.
 */

const BILL_STATUSES = ['submitted', 'accepted', 'paid', 'failed', 'returned'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
const RECURRING_CADENCES = ['weekly', 'monthly'] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

export interface BillView {
  readonly id: string;
  readonly billerId: string;
  readonly reference: string;
  readonly amount: string;
  readonly assetId: string;
  readonly fromSpaceId: string;
  readonly status: BillStatus;
  readonly failureCode: string | null;
  readonly failureBlocker: string | null;
  readonly providerRef: string | null;
  readonly ledgerTxId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecurringView {
  readonly id: string;
  readonly billerId: string;
  readonly reference: string;
  readonly amount: string;
  readonly assetId: string;
  readonly fromSpaceId: string;
  readonly cadence: RecurringCadence;
  readonly status: 'active' | 'paused' | 'cancelled' | 'completed';
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly nextRunAt: string;
}

type BillRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  biller_id: string;
  reference: string;
  amount: string;
  asset_id: string;
  from_space_id: string;
  status: BillStatus;
  failure_code: string | null;
  failure_blocker: string | null;
  provider_ref: string | null;
  ledger_tx_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type RecurringRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  biller_id: string;
  reference: string;
  amount: string;
  asset_id: string;
  from_space_id: string;
  cadence: RecurringCadence;
  status: RecurringView['status'];
  starts_at: Date;
  ends_at: Date | null;
  next_run_at: Date;
};

const TERMINAL_BILL = new Set([
  'bank.bills_psp_unset',
  'bank.bills_rail_refused',
  'bank.bills_insufficient_funds',
  'bank.bills_rail_unusable',
]);

function asStatus(value: string): BillStatus {
  if ((BILL_STATUSES as readonly string[]).includes(value)) return value as BillStatus;
  throw personalPayError('bank.bills_outcome_unknown');
}

function viewOf(row: BillRow): BillView {
  return {
    id: row.id,
    billerId: row.biller_id,
    reference: row.reference,
    amount: row.amount,
    assetId: row.asset_id,
    fromSpaceId: row.from_space_id,
    status: row.status,
    failureCode: row.failure_code,
    failureBlocker: row.failure_blocker,
    providerRef: row.provider_ref,
    ledgerTxId: row.ledger_tx_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function recurringView(row: RecurringRow): RecurringView {
  return {
    id: row.id,
    billerId: row.biller_id,
    reference: row.reference,
    amount: row.amount,
    assetId: row.asset_id,
    fromSpaceId: row.from_space_id,
    cadence: row.cadence,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    nextRunAt: row.next_run_at.toISOString(),
  };
}

function canonical(raw: string): { text: string; amount: Amount } {
  let amount: Amount;
  try {
    amount = parseAmount(raw);
  } catch {
    throw personalPayError('bank.personal_pay_request_invalid');
  }
  if (amount <= 0n) throw personalPayError('bank.personal_pay_request_invalid');
  return { text: formatAmount(amount), amount };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const pipe = text.lastIndexOf('|');
  const at = pipe > 0 ? text.slice(0, pipe) : '';
  const id = pipe > 0 ? text.slice(pipe + 1) : '';
  if (Number.isNaN(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw personalPayError('bank.bills_cursor_invalid');
  }
  return { at, id };
}

function requireText(value: string, max: number, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw personalPayError(code);
  return trimmed;
}

function usableBiller(row: Biller): Biller {
  const id = requireText(row.id, 64, 'bank.bills_directory_unusable');
  const name = requireText(row.name, 140, 'bank.bills_directory_unusable');
  const category = requireText(row.category, 64, 'bank.bills_directory_unusable');
  const country = row.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw personalPayError('bank.bills_directory_unusable');
  return { id, name, country, category };
}

function usableLookup(row: BillLookup): BillLookup {
  if (!/^\d+(\.\d{1,18})?$/.test(row.amountDue)) throw personalPayError('bank.bills_lookup_unusable');
  const amount = parseAmount(row.amountDue);
  if (amount <= 0n) throw personalPayError('bank.bills_lookup_unusable');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) || Number.isNaN(Date.parse(`${row.dueDate}T00:00:00Z`))) {
    throw personalPayError('bank.bills_lookup_unusable');
  }
  const payeeName = requireText(row.payeeName, 140, 'bank.bills_lookup_unusable');
  const currency = row.currency.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) throw personalPayError('bank.bills_lookup_unusable');
  return { amountDue: row.amountDue, dueDate: row.dueDate, payeeName, currency };
}

export class BillPayService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: import('@intafaced/ledger-client').LedgerClient,
    private readonly spaces: SpaceService,
    private readonly ports: BillPorts,
  ) {}

  /** Whether a bill partner is wired: with none, no bill can be paid or set to recur. */
  railStatus(): PortStatus {
    return this.ports.rail.status();
  }

  async search(input: { query: string; country?: string }): Promise<Biller[]> {
    if (this.ports.directory.status() !== 'live') throw personalPayError('bank.bills_directory_unset');
    const query = requireText(input.query, 64, 'bank.personal_pay_request_invalid');
    const country = input.country?.trim().toUpperCase();
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw personalPayError('bank.bills_directory_unusable');
    const rows = await this.ports.directory.search({ query, ...(country ? { country } : {}) });
    if (!Array.isArray(rows)) throw personalPayError('bank.bills_directory_unusable');
    return rows.map(usableBiller);
  }

  async lookup(input: { billerId: string; reference: string }): Promise<BillLookup> {
    if (this.ports.lookup.status() !== 'live') throw personalPayError('bank.bills_lookup_unset');
    const billerId = requireText(input.billerId, 64, 'bank.bills_lookup_unusable');
    const reference = requireText(input.reference, 64, 'bank.bills_lookup_unusable');
    const found = await this.ports.lookup.lookup({ billerId, reference });
    if (found === null) throw personalPayError('bank.bills_reference_unknown');
    return usableLookup(found);
  }

  async pay(input: {
    userId: string;
    idempotencyKey: string;
    billerId: string;
    reference: string;
    amount: string;
    fromSpaceId: string;
    now?: Date;
  }): Promise<BillView> {
    const now = input.now ?? new Date();
    const idempotencyKey = requireText(input.idempotencyKey, 128, 'bank.personal_pay_request_invalid');
    if (idempotencyKey.length < 8) throw personalPayError('bank.personal_pay_request_invalid');
    const billerId = requireText(input.billerId, 64, 'bank.personal_pay_request_invalid');
    const reference = requireText(input.reference, 64, 'bank.personal_pay_request_invalid');
    const money = canonical(input.amount);
    const space = await this.ownedSpace(input.userId, input.fromSpaceId, now);
    const row = await this.instruction({
      userId: input.userId,
      idempotencyKey,
      billerId,
      reference,
      amount: money.text,
      assetId: space.assetId,
      fromSpaceId: space.id,
    });
    return this.drive(row, space, money.amount);
  }

  async list(input: {
    userId: string;
    limit?: number;
    status?: BillStatus;
    cursor?: string;
  }): Promise<{ items: BillView[]; nextCursor: string | null }> {
    if (input.limit === undefined) throw personalPayError('bank.bills_list_limit_unset');
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = cursor
      ? await this.sql<BillRow[]>`
          SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
                 status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
          FROM bank.bill_payments
          WHERE user_id = ${input.userId}
            AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
            AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `
      : await this.sql<BillRow[]>`
          SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
                 status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
          FROM bank.bill_payments
          WHERE user_id = ${input.userId}
            AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `;
    return page(rows, input.limit);
  }

  async get(userId: string, id: string): Promise<BillView> {
    const rows = await this.sql<BillRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
      FROM bank.bill_payments
      WHERE id = ${id} AND user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.bills_not_found');
    return viewOf(row);
  }

  async createRecurring(input: {
    userId: string;
    idempotencyKey: string;
    billerId: string;
    reference: string;
    amount: string;
    fromSpaceId: string;
    cadence: RecurringCadence;
    startsAt: Date;
    endsAt: Date | null;
    now?: Date;
  }): Promise<RecurringView> {
    if (this.ports.rail.status() !== 'live') throw personalPayError('bank.bills_psp_unset');
    const now = input.now ?? new Date();
    const idempotencyKey = requireText(input.idempotencyKey, 128, 'bank.personal_pay_request_invalid');
    if (idempotencyKey.length < 8) throw personalPayError('bank.personal_pay_request_invalid');
    const billerId = requireText(input.billerId, 64, 'bank.personal_pay_request_invalid');
    const reference = requireText(input.reference, 64, 'bank.personal_pay_request_invalid');
    const money = canonical(input.amount);
    const space = await this.ownedSpace(input.userId, input.fromSpaceId, now);
    if (input.endsAt && input.endsAt.getTime() <= input.startsAt.getTime()) throw personalPayError('bank.bill_recurring_inactive');
    const id = randomUUID();
    await this.sql<{ id: string }[]>`
      INSERT INTO bank.bill_recurring (
        id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
        cadence, status, starts_at, ends_at, next_run_at
      ) VALUES (
        ${id}, ${input.userId}, ${idempotencyKey}, ${billerId}, ${reference}, ${money.text}, ${space.assetId}, ${space.id},
        ${input.cadence}, 'active', ${input.startsAt.toISOString()}::timestamptz, ${input.endsAt ? input.endsAt.toISOString() : null},
        ${input.startsAt.toISOString()}::timestamptz
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
      RETURNING id
    `;
    const row = await this.recurringByKey(input.userId, idempotencyKey);
    const same =
      row.biller_id === billerId &&
      row.reference === reference &&
      row.amount === money.text &&
      row.from_space_id === space.id &&
      row.asset_id === space.assetId &&
      row.cadence === input.cadence &&
      row.starts_at.getTime() === input.startsAt.getTime();
    if (!same) throw personalPayError('bank.bills_conflict');
    return recurringView(row);
  }

  async pauseRecurring(userId: string, id: string): Promise<RecurringView> {
    const row = await this.ownedRecurring(userId, id);
    if (row.status === 'paused') return recurringView(row);
    if (row.status !== 'active') throw personalPayError('bank.bill_recurring_inactive');
    await this.sql`UPDATE bank.bill_recurring SET status = 'paused' WHERE id = ${id} AND user_id = ${userId} AND status = 'active'`;
    return recurringView(await this.ownedRecurring(userId, id));
  }

  async cancelRecurring(userId: string, id: string): Promise<RecurringView> {
    const row = await this.ownedRecurring(userId, id);
    if (row.status === 'cancelled' || row.status === 'completed') return recurringView(row);
    if (row.status !== 'active' && row.status !== 'paused') throw personalPayError('bank.bill_recurring_inactive');
    await this.sql`
      UPDATE bank.bill_recurring SET status = 'cancelled'
      WHERE id = ${id} AND user_id = ${userId} AND status IN ('active', 'paused')
    `;
    return recurringView(await this.ownedRecurring(userId, id));
  }

  async listRecurring(input: { userId: string; limit?: number }): Promise<RecurringView[]> {
    if (input.limit === undefined) throw personalPayError('bank.bills_list_limit_unset');
    const rows = await this.sql<RecurringRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             cadence, status, starts_at, ends_at, next_run_at
      FROM bank.bill_recurring
      WHERE user_id = ${input.userId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(recurringView);
  }

  /**
   * Fire due recurring bills. Not a customer door: the caller is the job.
   * Each occurrence uses one idempotency key derived from the schedule, so a
   * second pass does not post again. A blank rail refuses that occurrence and
   * posts nothing.
   */
  async runDue(
    limit: number,
    now = new Date(),
  ): Promise<{ considered: number; settled: number; refused: number; failures: { scheduleId: string; code: string }[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw personalPayError('bank.bills_list_limit_unset');
    const schedules = await this.sql<RecurringRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             cadence, status, starts_at, ends_at, next_run_at
      FROM bank.bill_recurring
      WHERE status = 'active' AND next_run_at <= ${now.toISOString()}::timestamptz
      ORDER BY next_run_at, id
      LIMIT ${limit}
    `;
    let settled = 0;
    let refused = 0;
    const failures: { scheduleId: string; code: string }[] = [];
    for (const schedule of schedules) {
      const fired = await this.sql<{ occurrence: number }[]>`
        SELECT occurrence FROM bank.bill_recurring_firings WHERE schedule_id = ${schedule.id} ORDER BY occurrence DESC LIMIT 1
      `;
      const lastFired = fired[0]?.occurrence ?? null;
      const plan = planDue({
        startsAt: schedule.starts_at,
        cadence: schedule.cadence as Cadence,
        endsAt: schedule.ends_at,
        lastFired,
        now,
      });
      for (const occurrence of plan.occurrences) {
        const key = `bill-recur:${schedule.id}:${occurrence}`;
        try {
          const payment = await this.pay({
            userId: schedule.user_id,
            idempotencyKey: key,
            billerId: schedule.biller_id,
            reference: schedule.reference,
            amount: schedule.amount,
            fromSpaceId: schedule.from_space_id,
            now,
          });
          if (payment.status === 'accepted' || payment.status === 'paid') settled += 1;
          await this.recordFiring(schedule.id, occurrence, payment.id);
        } catch (err) {
          const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'bank.bills_outcome_unknown';
          if (!TERMINAL_BILL.has(code)) {
            failures.push({ scheduleId: schedule.id, code });
            break;
          }
          refused += 1;
          const existing = await this.paymentByKey(schedule.user_id, key);
          if (existing) await this.recordFiring(schedule.id, occurrence, existing.id);
          failures.push({ scheduleId: schedule.id, code });
        }
      }
      const nextStatus = plan.completed ? 'completed' : 'active';
      await this.sql`
        UPDATE bank.bill_recurring
        SET next_run_at = ${plan.nextRunAt.toISOString()}::timestamptz, status = ${nextStatus}
        WHERE id = ${schedule.id} AND status = 'active'
      `;
    }
    return { considered: schedules.length, settled, refused, failures };
  }

  async opsSummary(now = new Date()): Promise<{
    asOf: string;
    counts: Record<BillStatus, number>;
    volumes: { status: BillStatus; assetId: string; count: number; amount: string }[];
    rails: { billerDirectory: 'unset' | 'live'; lookup: 'unset' | 'live'; payRail: 'unset' | 'live'; blocker: typeof PSP_BLOCKER };
  }> {
    const grouped = await this.sql<{ status: BillStatus; asset_id: string; n: string; total: string }[]>`
      SELECT status, asset_id, count(*)::text AS n, sum(amount::numeric)::text AS total
      FROM bank.bill_payments
      GROUP BY status, asset_id
    `;
    const counts = Object.fromEntries(BILL_STATUSES.map((status) => [status, 0])) as Record<BillStatus, number>;
    const volumes: { status: BillStatus; assetId: string; count: number; amount: string }[] = [];
    for (const row of grouped) {
      const status = asStatus(row.status);
      const count = Number(row.n);
      if (!Number.isSafeInteger(count)) throw personalPayError('bank.bills_outcome_unknown');
      counts[status] += count;
      volumes.push({ status, assetId: row.asset_id, count, amount: formatAmount(parseAmount(row.total)) });
    }
    return {
      asOf: now.toISOString(),
      counts,
      volumes,
      rails: {
        billerDirectory: this.ports.directory.status(),
        lookup: this.ports.lookup.status(),
        payRail: this.ports.rail.status(),
        blocker: PSP_BLOCKER,
      },
    };
  }

  async opsFailed(input: { limit?: number; cursor?: string }): Promise<{
    items: (BillView & { userId: string })[];
    nextCursor: string | null;
  }> {
    if (input.limit === undefined) throw personalPayError('bank.bills_list_limit_unset');
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = cursor
      ? await this.sql<BillRow[]>`
          SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
                 status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
          FROM bank.bill_payments
          WHERE status = 'failed' AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `
      : await this.sql<BillRow[]>`
          SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
                 status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
          FROM bank.bill_payments
          WHERE status = 'failed'
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `;
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map((row) => ({ ...viewOf(row), userId: row.user_id })),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async opsGet(id: string): Promise<BillView & { userId: string }> {
    const rows = await this.sql<BillRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
      FROM bank.bill_payments WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.bills_not_found');
    return { ...viewOf(row), userId: row.user_id };
  }

  private async drive(
    row: BillRow,
    space: { id: string; userId: string; assetId: string; kind: 'primary' | 'named' },
    amount: Amount,
  ): Promise<BillView> {
    if (row.status === 'failed') throw personalPayError(row.failure_code ?? 'bank.bills_psp_unset');
    if (row.status === 'accepted' || row.status === 'paid' || row.status === 'returned') return viewOf(row);
    if (this.ports.rail.status() !== 'live') {
      if (row.ledger_tx_id) throw personalPayError('bank.bills_outcome_unknown');
      await this.fail(row.id, 'bank.bills_psp_unset');
      throw personalPayError('bank.bills_psp_unset');
    }
    const railId = this.ports.rail.railId().trim();
    if (!railId || railId.length > 64) {
      await this.failIfUnposted(row.id);
      throw personalPayError('bank.bills_rail_unusable');
    }
    const account = accountForSpace(space);
    let txId = row.ledger_tx_id;
    if (!txId) {
      try {
        const existing = await this.ledger.getTxByKey(forwardKey(row.id));
        const tx = existing ?? (await postToRail(this.ledger, row.id, account, railId, amount));
        txId = tx.id;
        await this.sql`
          UPDATE bank.bill_payments SET ledger_tx_id = ${txId}, updated_at = now()
          WHERE id = ${row.id} AND status = 'submitted' AND ledger_tx_id IS NULL
        `;
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          await this.fail(row.id, 'bank.bills_insufficient_funds');
          throw personalPayError('bank.bills_insufficient_funds', err.message);
        }
        throw err;
      }
    }
    let answer: Awaited<ReturnType<BillPorts['rail']['submit']>>;
    try {
      answer = await this.ports.rail.submit({
        paymentId: row.id,
        idempotencyKey: row.idempotency_key,
        billerId: row.biller_id,
        reference: row.reference,
        amount: row.amount,
        assetId: row.asset_id,
      });
    } catch {
      throw personalPayError('bank.bills_outcome_unknown');
    }
    if (!answer.ok) {
      try {
        await reverseFromRail(this.ledger, row.id, account, railId, amount);
      } catch {
        throw personalPayError('bank.bills_outcome_unknown');
      }
      await this.fail(row.id, 'bank.bills_rail_refused');
      throw personalPayError('bank.bills_rail_refused');
    }
    const providerRef = answer.providerRef?.trim() ?? '';
    if ((answer.status !== 'accepted' && answer.status !== 'paid') || !providerRef || providerRef.length > 128) {
      throw personalPayError('bank.bills_outcome_unknown');
    }
    await this.sql`
      UPDATE bank.bill_payments
      SET status = ${answer.status}, provider_ref = ${providerRef}, ledger_tx_id = ${txId},
          failure_code = NULL, failure_blocker = NULL, updated_at = now()
      WHERE id = ${row.id} AND status = 'submitted'
    `;
    return viewOf(await this.must(row.id));
  }

  private async instruction(input: {
    userId: string;
    idempotencyKey: string;
    billerId: string;
    reference: string;
    amount: string;
    assetId: string;
    fromSpaceId: string;
  }): Promise<BillRow> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO bank.bill_payments (
        id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id, status
      ) VALUES (
        ${id}, ${input.userId}, ${input.idempotencyKey}, ${input.billerId}, ${input.reference},
        ${input.amount}, ${input.assetId}, ${input.fromSpaceId}, 'submitted'
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `;
    const row = await this.paymentByKey(input.userId, input.idempotencyKey);
    if (!row) throw personalPayError('bank.bills_outcome_unknown');
    const same =
      row.biller_id === input.billerId &&
      row.reference === input.reference &&
      row.amount === input.amount &&
      row.asset_id === input.assetId &&
      row.from_space_id === input.fromSpaceId;
    if (!same) throw personalPayError('bank.bills_conflict');
    return row;
  }

  private async fail(id: string, code: string): Promise<void> {
    const blocker = personalPayError(code).blocker ?? null;
    await this.sql`
      UPDATE bank.bill_payments
      SET status = 'failed', failure_code = ${code}, failure_blocker = ${blocker}, ledger_tx_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'submitted'
    `;
  }

  private async failIfUnposted(id: string): Promise<void> {
    const row = await this.must(id);
    if (row.ledger_tx_id) throw personalPayError('bank.bills_outcome_unknown');
    await this.fail(id, 'bank.bills_rail_unusable');
  }

  private async ownedSpace(userId: string, spaceId: string, now: Date) {
    let space;
    try {
      space = await this.spaces.get(spaceId);
    } catch (err) {
      if (err instanceof BankError && err.code === 'bank.space_not_found') throw personalPayError('bank.bills_space_not_found');
      throw err;
    }
    if (space.userId !== userId) throw personalPayError('bank.bills_space_not_found');
    return this.spaces.resolveForDebit(spaceId, now);
  }

  private async paymentByKey(userId: string, idempotencyKey: string): Promise<BillRow | null> {
    const rows = await this.sql<BillRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
      FROM bank.bill_payments
      WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ?? null;
  }

  private async must(id: string): Promise<BillRow> {
    const rows = await this.sql<BillRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             status, failure_code, failure_blocker, provider_ref, ledger_tx_id, created_at, updated_at
      FROM bank.bill_payments WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.bills_not_found');
    return row;
  }

  private async ownedRecurring(userId: string, id: string): Promise<RecurringRow> {
    const rows = await this.sql<RecurringRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             cadence, status, starts_at, ends_at, next_run_at
      FROM bank.bill_recurring WHERE id = ${id} AND user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.bill_recurring_not_found');
    return row;
  }

  private async recurringByKey(userId: string, idempotencyKey: string): Promise<RecurringRow> {
    const rows = await this.sql<RecurringRow[]>`
      SELECT id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id,
             cadence, status, starts_at, ends_at, next_run_at
      FROM bank.bill_recurring WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.bill_recurring_not_found');
    return row;
  }

  private async recordFiring(scheduleId: string, occurrence: number, paymentId: string): Promise<void> {
    await this.sql`
      INSERT INTO bank.bill_recurring_firings (schedule_id, occurrence, payment_id)
      VALUES (${scheduleId}, ${occurrence}, ${paymentId})
      ON CONFLICT (schedule_id, occurrence) DO NOTHING
    `;
  }
}

function page(rows: BillRow[], limit: number): { items: BillView[]; nextCursor: string | null } {
  const items = rows.slice(0, limit).map(viewOf);
  const last = rows[limit - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
