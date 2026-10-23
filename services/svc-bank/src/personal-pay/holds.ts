import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { personalPayError } from './errors.js';
import type { GlobalSendService, SendView } from './global.js';
import { parseProofLimits, type ProofLimits } from './payee-controls.js';

/**
 * Compliance holds on a global send, and the document a customer is asked for (BK-xfer-07).
 *
 * A hold applies only to a send that is still `submitted` with no ledger transaction, so no value has moved and none is
 * reserved: there is no hold recipe because there is nothing to hold. If a hold lands in the instant the forward entry is
 * being posted, the debit stands on the held send and no payout is made until it is released. A settled send refuses `bank.transfer_settled`. The
 * hold's reason is internal and is never in anything a customer reads; the customer sees only the request an operator wrote
 * for them. Release needs a different person from the one who held (four-eyes, by the signed-in operator id, never a typed
 * one). If releasing leaves the outcome unknown and nothing was posted, the hold goes back on.
 *
 * Cancel (BK-xfer-08): while a send is on hold with nothing posted, its customer can cancel it, and the owner's window
 * (`BANK_GLOBAL_HOLD_CANCEL_HOURS`) cancels one still on hold that long after the hold was placed. The window has no
 * default: blank, nothing is cancelled automatically and every screen says the rule is not published. A cancelled send
 * never posts; the window is applied whenever the send or the queue is read and before any release.
 */

export type HoldState = 'requested' | 'under_review' | 'released' | 'cancelled';

export const BANK_GLOBAL_HOLD_CANCEL_HOURS_ENV = 'BANK_GLOBAL_HOLD_CANCEL_HOURS';
const HOUR_MS = 3_600_000;

/** The owner's auto-cancel window in whole hours (1 or more), or null when blank or not a whole number. */
export function readHoldCancelHours(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[0-9]{1,6}$/.test(trimmed)) return null;
  const hours = Number.parseInt(trimmed, 10);
  return hours >= 1 ? hours : null;
}

/** The auto-cancel rule as every screen shows it: the window, or that it is not published. */
export type AutoCancelRule = { readonly state: 'unset'; readonly hours: null } | { readonly state: 'published'; readonly hours: number };

/** Who placed a hold the stand-in's screening put on: not a person, so it never matches a signed-in operator. */
export const SCREENING_OPERATOR = 'system:test-screening';
const SCREENING_REASON = 'TEST screening: the stand-in marks this amount for a compliance look';

type HoldRow = {
  id: string;
  send_id: string;
  hold_key: string;
  reason: string;
  placed_by: string;
  state: HoldState;
  info_request: string | null;
  proof_name: string | null;
  proof_type: string | null;
  proof_size: number | null;
  proof_sha256: string | null;
  proof_uploaded_at: Date | null;
  released_by: string | null;
  released_at: Date | null;
  created_at: Date;
};

const COLUMNS = `id, send_id, hold_key, reason, placed_by, state, info_request, proof_name, proof_type, proof_size, proof_sha256,
  proof_uploaded_at, released_by, released_at, created_at`;

/** What an operator sees: everything but the file itself. */
export interface HoldView {
  readonly id: string;
  readonly sendId: string;
  readonly state: HoldState;
  readonly reason: string;
  readonly heldBy: string;
  readonly infoRequest: string | null;
  readonly proof: { name: string; type: string; size: number; sha256: string; uploadedAt: string } | null;
  readonly releasedBy: string | null;
  readonly createdAt: string;
}

/** What the customer sees: no reason, no operator, no screening detail. */
export interface CustomerHoldView {
  readonly state: HoldState;
  readonly infoRequest: string | null;
  readonly proofUploaded: boolean;
  readonly proofLimits: { allowedTypes: string[]; maxBytes: number } | null;
  /** The owner's rule, and when this hold is cancelled by it (null when the rule is unset or the hold is closed). */
  readonly autoCancel: AutoCancelRule & { readonly at: string | null };
}

function holdView(row: HoldRow): HoldView {
  return {
    id: row.id,
    sendId: row.send_id,
    state: row.state,
    reason: row.reason,
    heldBy: row.placed_by,
    infoRequest: row.info_request,
    proof:
      row.proof_sha256 && row.proof_uploaded_at
        ? {
            name: row.proof_name ?? '',
            type: row.proof_type ?? '',
            size: row.proof_size ?? 0,
            sha256: row.proof_sha256,
            uploadedAt: row.proof_uploaded_at.toISOString(),
          }
        : null,
    releasedBy: row.released_by,
    createdAt: row.created_at.toISOString(),
  };
}

const text = (raw: string, max: number): string => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > max) throw personalPayError('bank.personal_pay_request_invalid');
  return trimmed;
};

export class GlobalHoldService {
  private readonly limits: ProofLimits | null;

  constructor(
    private readonly sql: Sql,
    private readonly sends: GlobalSendService,
    proofLimitsJson?: string,
    holdCancelHours: () => string | undefined = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.limits = parseProofLimits(proofLimitsJson);
    this.cancelHours = holdCancelHours;
  }

  private readonly cancelHours: () => string | undefined;

  /** The owner's auto-cancel rule for a send on hold. */
  autoCancelRule(): AutoCancelRule {
    const hours = readHoldCancelHours(this.cancelHours());
    return hours === null ? { state: 'unset', hours: null } : { state: 'published', hours };
  }

  private cancelsAt(hold: HoldRow): Date | null {
    const rule = this.autoCancelRule();
    if (rule.state === 'unset' || (hold.state !== 'requested' && hold.state !== 'under_review')) return null;
    const at = new Date(hold.created_at.getTime() + rule.hours * HOUR_MS);
    return Number.isFinite(at.getTime()) ? at : null;
  }

  /** The customer cancels their send while it is on hold. Nothing was posted, so nothing is returned or reversed. */
  async cancel(userId: string, sendId: string): Promise<SendView> {
    await this.sends.get(userId, sendId);
    await this.expireOverdue({ sendId });
    const send = await this.sends.get(userId, sendId);
    // Cancelled already (by the customer, or by the window just now) is the same answer.
    if (send.status === 'cancelled') return send;
    const open = (
      await this.sql<HoldRow[]>`
        SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE send_id = ${sendId} AND state IN ('requested', 'under_review')
      `
    )[0];
    if (send.status !== 'held' || send.ledgerTxId !== null || !open) throw personalPayError('bank.global_send_not_cancellable');
    try {
      await this.cancelHold(open, 'customer');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'bank.transfer_settled' || code === 'bank.hold_not_found') throw personalPayError('bank.global_send_not_cancellable');
      throw err;
    }
    return this.sends.get(userId, sendId);
  }

  /**
   * Applies the owner's window: every open hold placed longer ago than it, on a send with nothing posted, is cancelled.
   * Scoped to one customer or one send when a read names one. Blank window, nothing happens.
   */
  async expireOverdue(scope: { userId?: string; sendId?: string }): Promise<number> {
    const rule = this.autoCancelRule();
    if (rule.state === 'unset') return 0;
    const before = new Date(this.now().getTime() - rule.hours * HOUR_MS);
    const rows = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(
        COLUMNS.split(',')
          .map((c) => `h.${c.trim()}`)
          .join(', '),
      )}
      FROM bank.global_send_holds h JOIN bank.global_sends s ON s.id = h.send_id
      WHERE h.state IN ('requested', 'under_review') AND h.created_at <= ${before}
        AND s.status = 'held' AND s.ledger_tx_id IS NULL
        ${scope.userId === undefined ? this.sql`` : this.sql`AND s.user_id = ${scope.userId}`}
        ${scope.sendId === undefined ? this.sql`` : this.sql`AND s.id = ${scope.sendId}`}
      ORDER BY h.created_at LIMIT 200
    `;
    let cancelled = 0;
    for (const row of rows) {
      if (
        await this.cancelHold(row, 'auto').then(
          () => true,
          () => false,
        )
      )
        cancelled += 1;
    }
    return cancelled;
  }

  /** Closes an open hold as cancelled and cancels its send, in one transaction: only a held send with nothing posted. */
  private async cancelHold(hold: HoldRow, by: 'customer' | 'auto'): Promise<void> {
    await this.sql.begin(async (tx) => {
      const closed = await tx`
        UPDATE bank.global_send_holds
        SET state = 'cancelled', released_by = ${by === 'customer' ? 'customer' : 'system:auto-cancel'}, released_at = now(), updated_at = now()
        WHERE id = ${hold.id} AND state IN ('requested', 'under_review') RETURNING id
      `;
      if (closed.length === 0) throw personalPayError('bank.hold_not_found');
      const moved = await tx`
        UPDATE bank.global_sends SET status = 'cancelled', cancelled_by = ${by}, updated_at = now()
        WHERE id = ${hold.send_id} AND status = 'held' AND ledger_tx_id IS NULL RETURNING id
      `;
      // A hold that landed while the forward entry was being posted stands on a debit: that send cannot be cancelled.
      if (moved.length === 0) throw personalPayError('bank.transfer_settled');
    });
  }

  proofLimitsStatus(): { state: 'unset' | 'published'; allowedTypes: string[]; maxBytes: number | null } {
    return this.limits
      ? { state: 'published', allowedTypes: [...this.limits.allowedTypes], maxBytes: this.limits.maxBytes }
      : { state: 'unset', allowedTypes: [], maxBytes: null };
  }

  /** Puts a send that has not left on hold. Replaying the same hold key returns the same hold. */
  async hold(input: { sendId: string; operatorId: string; holdKey: string; reason: string; infoRequest?: string }): Promise<HoldView> {
    const holdKey = text(input.holdKey, 128);
    if (holdKey.length < 8) throw personalPayError('bank.personal_pay_request_invalid');
    const reason = text(input.reason, 500);
    const infoRequest = input.infoRequest === undefined ? null : text(input.infoRequest, 1000);
    const operatorId = text(input.operatorId, 128);

    const prior = await this.sql<HoldRow[]>`SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE hold_key = ${holdKey}`;
    if (prior[0]) {
      const same = prior[0].send_id === input.sendId && prior[0].reason === reason && (prior[0].info_request ?? null) === infoRequest;
      if (!same) throw personalPayError('bank.hold_conflict');
      return holdView(prior[0]);
    }
    const send = await this.sends.opsGet(input.sendId);
    if (send.status === 'sent' || send.status === 'on_the_way' || send.status === 'arrived')
      throw personalPayError('bank.transfer_settled');
    if (send.status === 'failed') throw personalPayError('bank.transfer_not_holdable');
    if (send.status === 'held') throw personalPayError('bank.hold_conflict');
    if (send.ledgerTxId) throw personalPayError('bank.transfer_settled');

    const id = randomUUID();
    const rows = await this.sql.begin(async (tx) => {
      const moved = await tx`
        UPDATE bank.global_sends SET status = 'held', updated_at = now()
        WHERE id = ${input.sendId} AND status = 'submitted' AND ledger_tx_id IS NULL
        RETURNING id
      `;
      if (moved.length === 0) throw personalPayError('bank.transfer_settled');
      return tx<HoldRow[]>`
        INSERT INTO bank.global_send_holds (id, send_id, hold_key, reason, placed_by, state, info_request)
        VALUES (${id}, ${input.sendId}, ${holdKey}, ${reason}, ${operatorId}, 'requested', ${infoRequest})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
    });
    return holdView(rows[0]!);
  }

  /**
   * The TEST stand-in's screening (`GlobalPorts.review`): puts a send it marks on hold before anything is posted, placed by
   * `SCREENING_OPERATOR`, with no request to the customer until an operator writes one. A send is screened once: one that
   * has ever been held carries on. True when the send now waits on this hold. Any operator can release it, since the
   * screening is not a person; it exists only on the stand-in, which is refused under live posture.
   */
  async screen(sendId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const moved = await tx`
        UPDATE bank.global_sends SET status = 'held', updated_at = now()
        WHERE id = ${sendId} AND status = 'submitted' AND ledger_tx_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM bank.global_send_holds WHERE send_id = ${sendId})
        RETURNING id
      `;
      if (moved.length === 0) return false;
      await tx`
        INSERT INTO bank.global_send_holds (id, send_id, hold_key, reason, placed_by, state, info_request)
        VALUES (${randomUUID()}, ${sendId}, ${`screening:${sendId}`}, ${SCREENING_REASON}, ${SCREENING_OPERATOR}, 'requested', NULL)
      `;
      return true;
    });
  }

  /** Writes (or rewrites) what the customer is asked for. Allowed while the hold is open. */
  async requestInfo(input: { sendId: string; infoRequest: string }): Promise<HoldView> {
    const infoRequest = text(input.infoRequest, 1000);
    const rows = await this.sql<HoldRow[]>`
      UPDATE bank.global_send_holds SET info_request = ${infoRequest}, updated_at = now()
      WHERE send_id = ${input.sendId} AND state IN ('requested', 'under_review')
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!rows[0]) throw personalPayError('bank.hold_not_found');
    return holdView(rows[0]);
  }

  /** Open holds, newest first: the compliance queue. */
  async queue(input: { limit?: number }): Promise<(HoldView & { send: SendView & { userId: string } })[]> {
    if (input.limit === undefined) throw personalPayError('bank.global_list_limit_unset');
    await this.expireOverdue({});
    const rows = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds
      WHERE state IN ('requested', 'under_review') ORDER BY created_at DESC, id DESC LIMIT ${input.limit}
    `;
    return Promise.all(rows.map(async (row) => ({ ...holdView(row), send: await this.sends.opsGet(row.send_id) })));
  }

  /** The open hold on a send, for an operator. */
  async openHold(sendId: string): Promise<HoldView> {
    return holdView(await this.mustOpen(sendId));
  }

  /** The customer's own view of the hold on their send. */
  async forCustomer(userId: string, sendId: string): Promise<CustomerHoldView> {
    await this.sends.get(userId, sendId);
    await this.expireOverdue({ sendId });
    const rows = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE send_id = ${sendId}
      ORDER BY created_at DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.hold_not_found');
    return {
      state: row.state,
      infoRequest: row.info_request,
      proofUploaded: row.proof_sha256 !== null,
      proofLimits: this.limits ? { allowedTypes: [...this.limits.allowedTypes], maxBytes: this.limits.maxBytes } : null,
      autoCancel: { ...this.autoCancelRule(), at: this.cancelsAt(row)?.toISOString() ?? null },
    };
  }

  /** The customer's document. One file, by hash: the same file again is the same answer, a different one is refused. */
  async uploadProof(input: {
    userId: string;
    sendId: string;
    name: string;
    type: string;
    contentBase64: string;
  }): Promise<CustomerHoldView> {
    if (!this.limits) throw personalPayError('bank.proof_limits_unset');
    await this.sends.get(input.userId, input.sendId);
    const name = text(input.name, 200);
    const type = input.type.trim().toLowerCase();
    if (!this.limits.allowedTypes.includes(type)) throw personalPayError('bank.proof_type_not_allowed');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) || input.contentBase64.length % 4 !== 0)
      throw personalPayError('bank.proof_invalid');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0) throw personalPayError('bank.proof_invalid');
    if (bytes.length > this.limits.maxBytes) throw personalPayError('bank.proof_too_large');
    const sha = createHash('sha256').update(bytes).digest('hex');

    const open = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE send_id = ${input.sendId} AND state IN ('requested', 'under_review')
    `;
    const hold = open[0];
    if (!hold || hold.info_request === null) throw personalPayError('bank.proof_not_requested');
    if (hold.proof_sha256) {
      if (hold.proof_sha256 === sha) return this.forCustomer(input.userId, input.sendId);
      throw personalPayError('bank.proof_already_uploaded');
    }
    const moved = await this.sql`
      UPDATE bank.global_send_holds
      SET proof_name = ${name}, proof_type = ${type}, proof_size = ${bytes.length}, proof_sha256 = ${sha},
          proof_bytes = ${bytes}, proof_uploaded_at = now(), state = 'under_review', updated_at = now()
      WHERE id = ${hold.id} AND state = 'requested' AND proof_sha256 IS NULL
      RETURNING id
    `;
    if (moved.length === 0) {
      const again = await this.sql<
        { proof_sha256: string | null }[]
      >`SELECT proof_sha256 FROM bank.global_send_holds WHERE id = ${hold.id}`;
      if (again[0]?.proof_sha256 === sha) return this.forCustomer(input.userId, input.sendId);
      throw personalPayError('bank.proof_already_uploaded');
    }
    return this.forCustomer(input.userId, input.sendId);
  }

  /** The stored document, for an operator who has to read it. */
  async proofFor(sendId: string): Promise<{ name: string; type: string; contentBase64: string }> {
    const rows = await this.sql<{ proof_name: string; proof_type: string; proof_bytes: Buffer }[]>`
      SELECT proof_name, proof_type, proof_bytes FROM bank.global_send_holds
      WHERE send_id = ${sendId} AND proof_bytes IS NOT NULL ORDER BY created_at DESC LIMIT 1
    `;
    if (!rows[0]) throw personalPayError('bank.hold_not_found');
    return { name: rows[0].proof_name, type: rows[0].proof_type, contentBase64: rows[0].proof_bytes.toString('base64') };
  }

  /** Lets a held send carry on. The person who held it cannot release it. */
  async release(input: { sendId: string; operatorId: string }): Promise<SendView> {
    const operatorId = text(input.operatorId, 128);
    if ((await this.expireOverdue({ sendId: input.sendId })) > 0) throw personalPayError('bank.global_send_cancelled');
    const hold = await this.mustOpen(input.sendId);
    if (hold.placed_by === operatorId) throw personalPayError('bank.release_same_operator');
    await this.close(hold, operatorId);
    try {
      return await this.sends.resume(input.sendId);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'bank.global_outcome_unknown') await this.putBack(hold);
      throw err;
    }
  }

  /** Links an incoming payment's reference to a send. If the send is held, the link releases it. */
  async linkReference(input: { sendId: string; operatorId: string; reference: string }): Promise<{ linked: true; send: SendView }> {
    const operatorId = text(input.operatorId, 128);
    const reference = text(input.reference, 64).toUpperCase();
    if (reference.length < 6) throw personalPayError('bank.personal_pay_request_invalid');
    await this.sends.opsGet(input.sendId);
    if ((await this.expireOverdue({ sendId: input.sendId })) > 0) throw personalPayError('bank.global_send_cancelled');
    const hold = (
      await this.sql<HoldRow[]>`
        SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE send_id = ${input.sendId} AND state IN ('requested', 'under_review')
      `
    )[0];
    if (hold && hold.placed_by === operatorId) throw personalPayError('bank.release_same_operator');
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO bank.global_incoming_links (id, reference, send_id, linked_by)
      VALUES (${randomUUID()}, ${reference}, ${input.sendId}, ${operatorId})
      ON CONFLICT (reference) DO NOTHING RETURNING id
    `;
    if (inserted.length === 0) {
      const existing = await this.sql<{ send_id: string }[]>`SELECT send_id FROM bank.global_incoming_links WHERE reference = ${reference}`;
      if (existing[0]?.send_id !== input.sendId) throw personalPayError('bank.link_reference_conflict');
    }
    if (!hold) return { linked: true, send: await this.sends.opsGet(input.sendId) };
    await this.close(hold, operatorId);
    try {
      return { linked: true, send: await this.sends.resume(input.sendId) };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'bank.global_outcome_unknown') await this.putBack(hold);
      throw err;
    }
  }

  private async mustOpen(sendId: string): Promise<HoldRow> {
    const rows = await this.sql<HoldRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.global_send_holds WHERE send_id = ${sendId} AND state IN ('requested', 'under_review')
    `;
    if (!rows[0]) throw personalPayError('bank.hold_not_found');
    return rows[0];
  }

  private async close(hold: HoldRow, operatorId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const closed = await tx`
        UPDATE bank.global_send_holds SET state = 'released', released_by = ${operatorId}, released_at = now(), updated_at = now()
        WHERE id = ${hold.id} AND state IN ('requested', 'under_review') RETURNING id
      `;
      if (closed.length === 0) throw personalPayError('bank.hold_not_found');
      await tx`UPDATE bank.global_sends SET status = 'submitted', updated_at = now() WHERE id = ${hold.send_id} AND status = 'held'`;
    });
  }

  /** Release left the outcome unknown. If nothing was posted the hold goes back on; if value moved the send is retried instead. */
  private async putBack(hold: HoldRow): Promise<void> {
    await this.sql.begin(async (tx) => {
      const back = await tx`
        UPDATE bank.global_sends SET status = 'held', updated_at = now()
        WHERE id = ${hold.send_id} AND status = 'submitted' AND ledger_tx_id IS NULL RETURNING id
      `;
      if (back.length === 0) return;
      await tx`
        UPDATE bank.global_send_holds SET state = ${hold.state}, released_by = NULL, released_at = NULL, updated_at = now()
        WHERE id = ${hold.id}
      `;
    });
  }
}
