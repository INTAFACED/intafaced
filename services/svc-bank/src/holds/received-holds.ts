/**
 * Holds on received funds (PP-money-balance-05; pay ENGINE-SPEC RH-1 to RH-4), the stranger class (J-pay-03 #5).
 *
 * A person chooses how payments from people not in their contacts are treated: paid into their balance (the default),
 * or held for them to accept. "Not in their contacts" is a person they have never paid: no posted personal send from
 * the recipient to the payer. A payment that settles the recipient's own request is never a stranger's.
 *
 * The decision is taken once, when the send is reserved, and written in the same transaction as the reservation
 * (`bank.received_holds`, state `placing`), so a retried send, a crash after the post or a changed rule cannot change it.
 * After the send posts, the hold is one ledger post (`payReceivedHold`, recipient available → the recipient's own pot
 * `pay:recv:<transferId>`, key `pay.recv.hold:<transferId>`). The money stays the recipient's: it counts as set aside,
 * not available. Accept releases it whole to the recipient (`payReceivedRelease`); Deny returns it whole to the payer
 * (`payReceivedReturn`). Each outcome is claimed first (`held → releasing | returning`), so only one can happen (RH-2), and
 * the ledger's non-negative hold refuses a second. A hold nobody answers by its release date is returned to the payer.
 *
 * The release period is the owner's (`BANK_STRANGER_HOLD_DAYS`). Blank means the stranger class cannot place holds
 * (RH-3): choosing "hold" refuses `bank.stranger_hold_period_unset`, and a payment arriving under an older choice is
 * paid in, never held without a date. A hold never blocks a dispute or a refund request (RH-4): it only limits what the
 * recipient can spend.
 *
 * Crash safety: every step is keyed and retried by the recovery timer (`sweep`): a `placing` row whose send posted is
 * placed; a `releasing` or `returning` row is finished; a `held` row past its release date is returned. A hold the ledger
 * refuses for want of funds (the recipient spent the payment in the instant between the send and the hold) is marked
 * `lapsed` only after the in-flight bound has passed since its last attempt and the hold key is still empty: the money is
 * then simply the recipient's, as if no rule applied.
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  bankTransferKey,
  formatAmount,
  parseAmount,
  POST_IN_FLIGHT_BOUND_SECONDS,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { isDefiniteLedgerRefusal } from '../ledger-outcome.js';

export type StrangerRule = 'pay_in' | 'hold';
export type ReceivedHoldState = 'placing' | 'held' | 'releasing' | 'released' | 'returning' | 'returned' | 'lapsed';

/** The person's choice for payments from people not in their contacts, and the owner's release period. */
export interface ReceiveRuleView {
  readonly strangers: StrangerRule;
  /** Whole days a held payment waits for an answer before it goes back to the sender; null = not published. */
  readonly holdDays: number | null;
}

/** One payment held for the recipient, as they see it. */
export interface ReceivedHoldView {
  readonly transferId: string;
  readonly state: ReceivedHoldState;
  /** Why it is held, as a stored class (never free text). */
  readonly reasonClass: 'stranger';
  readonly amount: string;
  readonly assetId: string;
  readonly fromHandle: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  /** When it goes back to the sender if not accepted. */
  readonly releaseAt: string;
  readonly decidedAt: string | null;
}

export const BANK_STRANGER_HOLD_DAYS_ENV = 'BANK_STRANGER_HOLD_DAYS';
const DAY_MS = 86_400_000;

/** The owner's stranger hold period in whole days (1 to 365), or null when blank or not a whole number in range. */
export function readStrangerHoldDays(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[0-9]{1,3}$/.test(trimmed)) return null;
  const days = Number.parseInt(trimmed, 10);
  return days >= 1 && days <= 365 ? days : null;
}

interface HoldRow {
  transfer_id: string;
  recipient_user_id: string;
  payer_user_id: string;
  asset_id: string;
  amount: string;
  reason_class: 'stranger';
  state: ReceivedHoldState;
  release_at: Date;
  hold_tx_id: string | null;
  outcome_tx_id: string | null;
  decided_by: string | null;
  attempted_at: Date | null;
  /** When the ledger first refused this hold for want of funds, with no unknown attempt since. */
  refused_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
}

const HOLD_COLUMNS = [
  'transfer_id',
  'recipient_user_id',
  'payer_user_id',
  'asset_id',
  'amount',
  'reason_class',
  'state',
  'release_at',
  'hold_tx_id',
  'outcome_tx_id',
  'decided_by',
  'attempted_at',
  'refused_at',
  'created_at',
  'decided_at',
] as const;
/** The hold row's columns, optionally from a table alias; the amount is read as text, never a number. */
const holdCols = (alias = ''): string =>
  HOLD_COLUMNS.map((c) => (c === 'amount' ? `${alias}amount::text AS amount` : `${alias}${c}`)).join(', ');
const HOLD_COLS = holdCols();

/** Who ends a hold at its release date: not a person. */
export const RELEASE_DATE_ACTOR = 'system:release-date';

export type HoldOutcome = 'release' | 'return';

export interface ReceivedHoldSweepResult {
  readonly outcome: 'completed' | 'failed';
  readonly reason?: string;
}

export class ReceivedHoldService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'post' | 'getTxByKey'>,
    private readonly options: { holdDays: number | null; now?: () => Date },
  ) {}

  private now(at?: Date): Date {
    return at ?? this.options.now?.() ?? new Date();
  }

  async rule(userId: string): Promise<ReceiveRuleView> {
    const [row] = await this.sql<Array<{ strangers: StrangerRule }>>`
      SELECT strangers FROM bank.receive_rules WHERE user_id = ${userId}
    `;
    return { strangers: row?.strangers ?? 'pay_in', holdDays: this.options.holdDays };
  }

  async setRule(userId: string, strangers: StrangerRule, at?: Date): Promise<ReceiveRuleView> {
    if (strangers === 'hold' && this.options.holdDays === null) {
      throw new BankError(
        'No release period is published for held payments, so payments cannot be held yet (bank.stranger_hold_period_unset)',
        'bank.stranger_hold_period_unset',
      );
    }
    const now = this.now(at);
    await this.sql`
      INSERT INTO bank.receive_rules (user_id, strangers, updated_at) VALUES (${userId}, ${strangers}, ${now})
      ON CONFLICT (user_id) DO UPDATE SET strangers = EXCLUDED.strangers, updated_at = EXCLUDED.updated_at
    `;
    return this.rule(userId);
  }

  /**
   * Called inside the send's reservation transaction, once per new send to another person. Writes the hold row when the
   * recipient holds strangers' payments and the payer is one; the row is the decision, so a retry never asks again.
   */
  async decide(
    tx: TransactionSql,
    input: {
      transferId: string;
      payerUserId: string;
      recipientUserId: string;
      assetId: string;
      amount: Amount;
      requestId: string | null;
      now: Date;
    },
  ): Promise<boolean> {
    const days = this.options.holdDays;
    if (days === null || input.requestId || input.payerUserId === input.recipientUserId) return false;
    const [rule] = await tx<Array<{ strangers: StrangerRule }>>`
      SELECT strangers FROM bank.receive_rules WHERE user_id = ${input.recipientUserId}
    `;
    if (rule?.strangers !== 'hold') return false;
    const [known] = await tx<Array<{ one: number }>>`
      SELECT 1 AS one FROM bank.personal_transfers
       WHERE from_user_id = ${input.recipientUserId} AND to_user_id = ${input.payerUserId} AND status = 'posted'
       LIMIT 1
    `;
    if (known) return false;
    const releaseAt = new Date(input.now.getTime() + days * DAY_MS);
    await tx`
      INSERT INTO bank.received_holds (
        transfer_id, recipient_user_id, payer_user_id, asset_id, amount, reason_class, state, release_at, created_at
      ) VALUES (
        ${input.transferId}, ${input.recipientUserId}, ${input.payerUserId}, ${input.assetId},
        ${formatAmount(input.amount)}::numeric, 'stranger', 'placing', ${releaseAt}, ${input.now}
      )
      ON CONFLICT (transfer_id) DO NOTHING
    `;
    return true;
  }

  /**
   * After the send posted: place its hold if it has one. Returns true while the payment is held (or being placed or
   * decided), so the caller does not hand it to the income sorter. Never throws for a ledger failure: the send has
   * posted, and the recovery timer finishes the hold.
   */
  async placeFor(transferId: string, at?: Date): Promise<boolean> {
    const row = await this.find(transferId);
    if (!row) return false;
    if (row.state !== 'placing') return row.state !== 'lapsed';
    try {
      await this.place(row, this.now(at));
    } catch (err) {
      logHoldFailure('bank.received_hold_place_failed', transferId, err);
    }
    return true;
  }

  /**
   * The recipient's payments waiting for an answer, newest first, with the state each is in. Anyone else's are never
   * listed. A read only: the recovery timer finishes unfinished steps, never a page view.
   */
  async waiting(userId: string): Promise<ReceivedHoldView[]> {
    const rows = await this.sql<Array<HoldRow & { from_handle: string | null; note: string | null }>>`
      SELECT ${this.sql.unsafe(holdCols('h.'))}, t.from_handle, t.note
        FROM bank.received_holds h
        JOIN bank.personal_transfers t ON t.transfer_id = h.transfer_id
       WHERE h.recipient_user_id = ${userId} AND h.state IN ('placing', 'held', 'releasing', 'returning')
       ORDER BY h.created_at DESC
       LIMIT 50
    `;
    return rows.map((row) => toView(row, row.from_handle, row.note));
  }

  /** The recipient accepts (release) or denies (return to the payer) one held payment. Only the recipient can. */
  async decideHold(userId: string, transferId: string, outcome: HoldOutcome, at?: Date): Promise<ReceivedHoldView> {
    const now = this.now(at);
    const claiming: ReceivedHoldState = outcome === 'release' ? 'releasing' : 'returning';
    const claimed = await this.sql.begin(async (tx) => {
      const [row] = await tx<HoldRow[]>`
        SELECT ${tx.unsafe(HOLD_COLS)} FROM bank.received_holds WHERE transfer_id = ${transferId} FOR UPDATE
      `;
      if (!row || row.recipient_user_id !== userId) {
        throw new BankError('No payment of yours is waiting under this id (bank.received_hold_not_found)', 'bank.received_hold_not_found');
      }
      // The same answer again resumes it; a different one, or one after the hold ended, is refused.
      if (row.state === claiming || row.state === (outcome === 'release' ? 'released' : 'returned')) return row;
      if (row.state !== 'held') {
        throw new BankError(
          row.state === 'placing'
            ? 'This payment is still being set aside; try again in a moment (bank.received_hold_not_ready)'
            : 'This payment was already answered (bank.received_hold_decided)',
          row.state === 'placing' ? 'bank.received_hold_not_ready' : 'bank.received_hold_decided',
        );
      }
      if (row.release_at <= now) {
        throw new BankError(
          'This payment went back to the sender at its release date (bank.received_hold_decided)',
          'bank.received_hold_decided',
        );
      }
      const [next] = await tx<HoldRow[]>`
        UPDATE bank.received_holds SET state = ${claiming}, decided_by = ${userId}, attempted_at = ${now}
         WHERE transfer_id = ${transferId} AND state = 'held'
        RETURNING ${tx.unsafe(HOLD_COLS)}
      `;
      return next!;
    });
    // The answer is recorded once claimed. A ledger failure now leaves it `releasing` or `returning`, which the recovery
    // timer finishes; the person is told their answer stands, never that nothing happened.
    const done = await this.finish(claimed, now).catch((err: unknown) => {
      logHoldFailure('bank.received_hold_finish_failed', transferId, err);
      return claimed;
    });
    const [extra] = await this.sql<Array<{ from_handle: string | null; note: string | null }>>`
      SELECT from_handle, note FROM bank.personal_transfers WHERE transfer_id = ${transferId}
    `;
    return toView(done, extra?.from_handle ?? null, extra?.note ?? null);
  }

  /** The recovery timer's pass: place, finish and expire holds whose step was lost or whose date has come. */
  async sweep(limit: number, at?: Date): Promise<ReceivedHoldSweepResult[]> {
    const now = this.now(at);
    const rows = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(HOLD_COLS)} FROM bank.received_holds
       WHERE state IN ('placing', 'releasing', 'returning') OR (state = 'held' AND release_at <= ${now})
       ORDER BY created_at LIMIT ${limit}
    `;
    const results: ReceivedHoldSweepResult[] = [];
    for (const row of rows) {
      try {
        await this.advance(row, now);
        results.push({ outcome: 'completed' });
      } catch (err) {
        results.push({ outcome: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  private async find(transferId: string): Promise<HoldRow | null> {
    const [row] = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(HOLD_COLS)} FROM bank.received_holds WHERE transfer_id = ${transferId}
    `;
    return row ?? null;
  }

  private async advance(row: HoldRow, now: Date): Promise<void> {
    if (row.state === 'placing') {
      await this.place(row, now);
      return;
    }
    if (row.state === 'releasing' || row.state === 'returning') {
      await this.finish(row, now);
      return;
    }
    if (row.state === 'held' && row.release_at <= now) {
      const [claimed] = await this.sql<HoldRow[]>`
        UPDATE bank.received_holds SET state = 'returning', decided_by = ${RELEASE_DATE_ACTOR}, attempted_at = ${now}
         WHERE transfer_id = ${row.transfer_id} AND state = 'held'
        RETURNING ${this.sql.unsafe(HOLD_COLS)}
      `;
      if (claimed) await this.finish(claimed, now);
    }
  }

  /**
   * Place a `placing` row's hold once its send's money has arrived. The ledger is asked, not only the send's row: a send
   * whose answer was lost stays `reserved` until its payer sends again, but its money may already be the recipient's.
   */
  private async place(row: HoldRow, now: Date): Promise<void> {
    const [send] = await this.sql<Array<{ status: string; created_at: Date }>>`
      SELECT status, created_at FROM bank.personal_transfers WHERE transfer_id = ${row.transfer_id}
    `;
    // An abandoned reservation is deleted, and its hold row with it (`received_holds` cascades from the send).
    if (!send) return;
    if (send.status !== 'posted' && !(await this.ledger.getTxByKey(bankTransferKey('p2p', row.transfer_id, 0)))) {
      // Not arrived. Past the in-flight bound it never will: nothing is held, and the payer's own retry or sweep closes
      // the send itself.
      if (now.getTime() - send.created_at.getTime() > POST_IN_FLIGHT_BOUND_SECONDS * 1000)
        await this.markLapsed(row.transfer_id, now, 'the payment never arrived');
      return;
    }
    const request = recipes.payReceivedHold({
      holdId: row.transfer_id,
      userId: row.recipient_user_id,
      assetId: row.asset_id,
      amount: parseAmount(row.amount),
    });
    await this.sql`UPDATE bank.received_holds SET attempted_at = ${now} WHERE transfer_id = ${row.transfer_id} AND state = 'placing'`;
    let txId: string;
    try {
      txId = (await this.ledger.post(request)).id;
    } catch (err) {
      const booked = await this.ledger.getTxByKey(request.idempotencyKey);
      if (!booked) {
        const short = isDefiniteLedgerRefusal(err) && (err as { code?: string }).code === 'ledger.insufficient_funds';
        // The recipient spent the payment before it could be set aside. That refusal proves this attempt posted
        // nothing; once a refusal has stood for the in-flight bound with no attempt of unknown outcome since, no earlier
        // attempt can land either, and the payment is simply the recipient's. Any other failure may still land, so the
        // clock starts again.
        if (short && row.refused_at && now.getTime() - row.refused_at.getTime() > POST_IN_FLIGHT_BOUND_SECONDS * 1000) {
          await this.markLapsed(row.transfer_id, now, 'the payment was spent before it could be set aside');
          return;
        }
        await this.sql`
          UPDATE bank.received_holds SET refused_at = ${short ? (row.refused_at ?? now) : null}
           WHERE transfer_id = ${row.transfer_id} AND state = 'placing'
        `;
        throw err;
      }
      txId = booked.id;
    }
    await this.sql`
      UPDATE bank.received_holds SET state = 'held', hold_tx_id = ${txId}, placed_at = ${now}
       WHERE transfer_id = ${row.transfer_id} AND state = 'placing'
    `;
  }

  private async markLapsed(transferId: string, now: Date, why: string): Promise<void> {
    await this.sql`
      UPDATE bank.received_holds SET state = 'lapsed', decided_at = ${now}, lapse_reason = ${why}
       WHERE transfer_id = ${transferId} AND state = 'placing'
    `;
  }

  /** Post a claimed outcome (`releasing` or `returning`) under its key and record it. Safe to repeat. */
  private async finish(row: HoldRow, now: Date): Promise<HoldRow> {
    if (row.state !== 'releasing' && row.state !== 'returning') return row;
    const base = {
      holdId: row.transfer_id,
      userId: row.recipient_user_id,
      assetId: row.asset_id,
      amount: parseAmount(row.amount),
      heldAmount: parseAmount(row.amount),
    };
    const request =
      row.state === 'releasing' ? recipes.payReceivedRelease(base) : recipes.payReceivedReturn({ ...base, payerUserId: row.payer_user_id });
    let txId: string;
    try {
      txId = (await this.ledger.post(request)).id;
    } catch (err) {
      const booked = await this.ledger.getTxByKey(request.idempotencyKey);
      if (!booked) throw err;
      txId = booked.id;
    }
    const done: ReceivedHoldState = row.state === 'releasing' ? 'released' : 'returned';
    const [updated] = await this.sql<HoldRow[]>`
      UPDATE bank.received_holds SET state = ${done}, outcome_tx_id = ${txId}, decided_at = ${now}
       WHERE transfer_id = ${row.transfer_id} AND state = ${row.state}
      RETURNING ${this.sql.unsafe(HOLD_COLS)}
    `;
    return updated ?? (await this.find(row.transfer_id)) ?? row;
  }
}

function toView(row: HoldRow, fromHandle: string | null, note: string | null): ReceivedHoldView {
  return {
    transferId: row.transfer_id,
    state: row.state,
    reasonClass: row.reason_class,
    amount: formatAmount(parseAmount(row.amount)),
    assetId: row.asset_id,
    fromHandle,
    note,
    createdAt: row.created_at.toISOString(),
    releaseAt: row.release_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function logHoldFailure(event: string, transferId: string, err: unknown): void {
  console.error(
    JSON.stringify({ level: 'error', service: 'svc-bank', event, transferId, detail: err instanceof Error ? err.message : String(err) }),
  );
}
