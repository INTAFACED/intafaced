import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { PayError } from '../../payment-service.js';
import { CustodyStuckError } from './errors.js';
import type { ActionInput, ActionView, ReverseView, StuckKind } from './schemas.js';

/**
 * Per-vault queue, stuck transaction handling and reverse (W-custody-ops-12).
 *
 * The chain is two ports this process may not have. With no `TxReplacer` a boost, replace or drop refuses `rail.crypto`
 * and writes nothing; with no `NonceChain` an action is never resolved. An action is an intent first: it is written with
 * the caller's business key BEFORE the replacer is asked, the replacer must be idempotent on that key, and a definite
 * refusal (for example GAS_PRICE_TOO_LOW_FOR_RBF) is recorded as `failed`. Any other error leaves the intent without an
 * outcome and the same key resumes it. The original transaction is final only when a later outcome row says the chain
 * showed it replaced or dropped; asking the replacer never makes it so.
 *
 * A reverse returns a held withdrawal's funds, so it is gated three ways: the action must be a DROP (a transaction that
 * consumed the nonce), its outcome must be `dropped` (the chain showed the nonce spent by our drop), and a second founder
 * must approve. A plain eviction from the mempool is never enough, because an evicted transaction can be rebroadcast and
 * mined. The posting itself is `DroppedReverser`, which is the withdrawal service posting `withdrawReverse` under the
 * original attempt key: a repeat posts once.
 */
export interface ReplaceRequest {
  readonly kind: StuckKind;
  /** The caller's business key: the replacer must treat a repeat as the same request. */
  readonly actionKey: string;
  readonly originalTxHash: string;
  readonly nonce: number;
  readonly maxFee: string | null;
  readonly maxFeeUnit: string | null;
}

/** Signs and broadcasts a boost (same payment, higher fee), a replace or a drop (cancel: a self-send on the same nonce). */
export interface TxReplacer {
  submit(input: ReplaceRequest): Promise<{ txHash: string }>;
}

/** A definite refusal: nothing was broadcast. `code` is the chain-side state, for example `GAS_PRICE_TOO_LOW_FOR_RBF`. */
export class ReplacerRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReplacerRefusal';
  }
}

export interface NonceStatus {
  /**
   * `original_mined`: the original transaction confirmed. `replaced`: another transaction took the nonce, named by
   * `replacementTxHash`. `dropped`: the original left the mempool and the nonce is still free. `pending`: none of these.
   */
  readonly state: 'pending' | 'original_mined' | 'replaced' | 'dropped';
  readonly replacementTxHash?: string | null;
}

export interface NonceChain {
  status(input: { originalTxHash: string; nonce: number }): Promise<NonceStatus>;
}

/**
 * The customer-withdrawal cancel (W-withdraw-07). It cancels a requested withdrawal with no send on record, and a held one only
 * when its dispatch journal proves nothing was sent; anything that may have been sent, a sent and a failed one are refused.
 */
export interface WithdrawalCanceller {
  cancelWithdrawal(input: { userId: string; withdrawalId: string }): Promise<unknown>;
}

/** Posts the ledger reverse for a held withdrawal whose transaction was dropped. It refuses any attempt but `expectedAttempt`. */
export interface DroppedReverser {
  reverseDropped(input: { withdrawalId: string; evidenceRef: string; expectedAttempt: number }): Promise<unknown>;
}

export interface CustodyStuckServiceDeps {
  readonly sql: Sql;
  readonly replacer?: TxReplacer;
  readonly chain?: NonceChain;
  readonly canceller?: WithdrawalCanceller;
  readonly reverser?: DroppedReverser;
  readonly now?: () => Date;
}

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface ActionRow {
  id: string;
  action_key: string;
  kind: StuckKind;
  withdrawal_id: string;
  withdrawal_attempt: number;
  original_tx_hash: string;
  nonce: string;
  max_fee: string | null;
  max_fee_unit: string | null;
  reason: string;
  requested_by: string;
  at: string;
}

const sameHash = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class CustodyStuckService {
  private readonly sql: Sql;
  private readonly deps: CustodyStuckServiceDeps;
  private readonly now: () => Date;

  constructor(deps: CustodyStuckServiceDeps) {
    this.sql = deps.sql;
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  // ── links, thresholds, queue ─────────────────────────────────────────────────────────────────────────────

  /** Ties a withdrawal to the custody wallet (and nonce) it was signed with. The send path calls this; so can an operator. */
  async link(actor: string, input: { withdrawalId: string; walletId: string; nonce?: number }) {
    const [w] = await this.sql`SELECT 1 FROM pay.withdrawals WHERE id = ${input.withdrawalId}::uuid`;
    if (!w) throw new CustodyStuckError('stuck.withdrawal_not_found', `no withdrawal ${input.withdrawalId}`);
    const [wallet] = await this.sql`SELECT 1 FROM pay.custody_wallets WHERE wallet_id = ${input.walletId}::uuid`;
    if (!wallet) throw new CustodyStuckError('stuck.wallet_not_found', `no custody wallet ${input.walletId}`);
    // The link belongs to the withdrawal's CURRENT attempt, read in the same statement that writes it.
    await this.sql`INSERT INTO pay.custody_tx_wallet_links (withdrawal_id, attempt, wallet_id, nonce, linked_by)
      SELECT id, attempts, ${input.walletId}::uuid, ${input.nonce ?? null}, ${actor} FROM pay.withdrawals WHERE id = ${input.withdrawalId}::uuid
      ON CONFLICT (withdrawal_id, attempt) DO NOTHING`;
    const link = await this.linkOf(input.withdrawalId);
    if (!link || link.walletId !== input.walletId || link.nonce !== (input.nonce ?? null)) {
      throw new CustodyStuckError('stuck.already_linked', 'this withdrawal is already linked to a different wallet or nonce');
    }
    return link;
  }

  private async linkOf(withdrawalId: string) {
    const [r] = await this.sql<Array<{ withdrawal_id: string; wallet_id: string; nonce: string | null; linked_by: string; at: string }>>`
      SELECT l.withdrawal_id, l.wallet_id, l.nonce::text AS nonce, l.linked_by, ${this.sql.unsafe(TS('l.at'))} AS at
        FROM pay.custody_tx_wallet_links l JOIN pay.withdrawals w ON w.id = l.withdrawal_id AND w.attempts = l.attempt
       WHERE l.withdrawal_id = ${withdrawalId}::uuid`;
    return r
      ? {
          withdrawalId: r.withdrawal_id,
          walletId: r.wallet_id,
          nonce: r.nonce === null ? null : Number(r.nonce),
          linkedBy: r.linked_by,
          at: r.at,
        }
      : null;
  }

  async threshold(networkId: string) {
    const [r] = await this.sql<Array<{ seconds: number; set_by: string; at: string }>>`
      SELECT seconds, set_by, ${this.sql.unsafe(TS('at'))} AS at FROM pay.custody_stuck_threshold_events
       WHERE network_id = ${networkId} ORDER BY seq DESC LIMIT 1`;
    return { networkId, seconds: r?.seconds ?? null, setBy: r?.set_by ?? null, setAt: r?.at ?? null };
  }

  async setThreshold(actor: string, input: { networkId: string; seconds: number; reason: string }) {
    const [n] = await this.sql`SELECT 1 FROM pay.network_registry WHERE network_id = ${input.networkId}`;
    if (!n) throw new CustodyStuckError('stuck.network_unknown', `${input.networkId} is not in the network registry`);
    await this.sql`INSERT INTO pay.custody_stuck_threshold_events (network_id, seconds, reason, set_by)
      VALUES (${input.networkId}, ${input.seconds}, ${input.reason}, ${actor})`;
    return this.threshold(input.networkId);
  }

  private async inFlight(walletId: string) {
    const [wallet] = await this.sql<
      Array<{ network_id: string }>
    >`SELECT network_id FROM pay.custody_wallets WHERE wallet_id = ${walletId}::uuid`;
    if (!wallet) throw new CustodyStuckError('stuck.wallet_not_found', `no custody wallet ${walletId}`);
    const rows = await this.sql<Array<{ id: string; nonce: string | null; updated_at: string }>>`
      SELECT w.id, l.nonce::text AS nonce, ${this.sql.unsafe(TS('w.updated_at'))} AS updated_at
        FROM pay.custody_tx_wallet_links l JOIN pay.withdrawals w ON w.id = l.withdrawal_id AND w.attempts = l.attempt
       WHERE l.wallet_id = ${walletId}::uuid AND w.status::text = 'held'
       ORDER BY l.nonce NULLS LAST, w.created_at, w.id`;
    return { networkId: wallet.network_id, rows };
  }

  async queue(walletId: string) {
    const { networkId, rows } = await this.inFlight(walletId);
    const threshold = (await this.threshold(networkId)).seconds;
    const items = rows.map((r, i) => {
      const age = Math.max(0, Math.floor((this.now().getTime() - new Date(r.updated_at).getTime()) / 1000));
      return {
        withdrawalId: r.id,
        nonce: r.nonce === null ? null : Number(r.nonce),
        ageSeconds: age,
        stuck: threshold === null ? null : age > threshold,
        headOfLine: i === 0 && r.nonce !== null && rows.length > 1,
      };
    });
    return { walletId, networkId, thresholdSeconds: threshold, items };
  }

  async diagnose(walletId: string) {
    const q = await this.queue(walletId);
    if (q.thresholdSeconds === null) {
      throw new CustodyStuckError('stuck.threshold_unset', `the owner has set no stuck threshold for ${q.networkId}`);
    }
    const findings: Array<{ code: 'head_of_line_stuck' | 'stuck' | 'nonce_unknown'; withdrawalId: string; detail: string }> = [];
    for (const it of q.items) {
      if (it.nonce === null) {
        findings.push({
          code: 'nonce_unknown',
          withdrawalId: it.withdrawalId,
          detail: 'no nonce is linked, so it cannot be boosted, replaced or dropped',
        });
      }
      if (it.stuck && it.headOfLine) {
        findings.push({
          code: 'head_of_line_stuck',
          withdrawalId: it.withdrawalId,
          detail: `nonce ${it.nonce} has been in flight ${it.ageSeconds}s and ${q.items.length - 1} transaction(s) wait behind it`,
        });
      } else if (it.stuck) {
        findings.push({ code: 'stuck', withdrawalId: it.withdrawalId, detail: `in flight ${it.ageSeconds}s, past ${q.thresholdSeconds}s` });
      }
    }
    return {
      walletId,
      networkId: q.networkId,
      thresholdSeconds: q.thresholdSeconds,
      inFlight: q.items.length,
      stuckCount: q.items.filter((i) => i.stuck).length,
      findings,
    };
  }

  // ── boost, replace, drop ─────────────────────────────────────────────────────────────────────────────────

  private async actionRow(where: { id?: string; key?: string }): Promise<ActionRow | undefined> {
    const [r] = await this.sql<ActionRow[]>`
      SELECT id, action_key, kind, withdrawal_id, withdrawal_attempt, original_tx_hash, nonce::text AS nonce, max_fee::text AS max_fee, max_fee_unit,
             reason, requested_by, ${this.sql.unsafe(TS('at'))} AS at
        FROM pay.custody_tx_actions
       WHERE (${where.id ?? null}::uuid IS NOT NULL AND id = ${where.id ?? null}::uuid)
          OR (${where.key ?? null}::text IS NOT NULL AND action_key = ${where.key ?? null})`;
    return r;
  }

  private async actionView(row: ActionRow): Promise<ActionView> {
    const outcomes = await this.sql<Array<{ outcome: string; tx_hash: string | null; failure_code: string | null }>>`
      SELECT outcome, tx_hash, failure_code FROM pay.custody_tx_action_outcomes WHERE action_id = ${row.id}::uuid ORDER BY seq`;
    const has = (o: string) => outcomes.find((x) => x.outcome === o);
    // The chain-shown outcomes win over `submitted`, which wins over `failed` and over no answer at all.
    const terminal = has('dropped') ?? has('replaced') ?? has('original_mined');
    const status = (terminal?.outcome ?? has('submitted')?.outcome ?? has('failed')?.outcome ?? 'intent') as ActionView['status'];
    return {
      id: row.id,
      actionKey: row.action_key,
      kind: row.kind,
      withdrawalId: row.withdrawal_id,
      attempt: row.withdrawal_attempt,
      originalTxHash: row.original_tx_hash,
      nonce: Number(row.nonce),
      maxFee: row.max_fee === null ? null : formatAmount(parseAmount(row.max_fee)),
      maxFeeUnit: row.max_fee_unit,
      reason: row.reason,
      requestedBy: row.requested_by,
      at: row.at,
      status,
      submittedTxHash: has('submitted')?.tx_hash ?? null,
      failureCode: has('failed')?.failure_code ?? null,
    };
  }

  async action(actionId: string): Promise<ActionView> {
    const row = await this.actionRow({ id: actionId });
    if (!row) throw new CustodyStuckError('stuck.action_not_found', `no action ${actionId}`);
    return this.actionView(row);
  }

  async listActions(withdrawalId: string): Promise<ActionView[]> {
    const rows = await this.sql<ActionRow[]>`
      SELECT id, action_key, kind, withdrawal_id, withdrawal_attempt, original_tx_hash, nonce::text AS nonce, max_fee::text AS max_fee, max_fee_unit,
             reason, requested_by, ${this.sql.unsafe(TS('at'))} AS at
        FROM pay.custody_tx_actions WHERE withdrawal_id = ${withdrawalId}::uuid ORDER BY at, id`;
    return Promise.all(rows.map((r) => this.actionView(r)));
  }

  async act(actor: string, input: ActionInput): Promise<ActionView> {
    const replacer = this.deps.replacer;
    if (!replacer) throw new CustodyStuckError('rail.crypto', 'no chain signer is connected, so nothing was written or sent');
    const maxFee = input.maxFee === undefined ? null : formatAmount(parseAmount(input.maxFee));
    let row = await this.actionRow({ key: input.actionKey });
    if (row) {
      const same =
        row.kind === input.kind &&
        row.withdrawal_id === input.withdrawalId &&
        sameHash(row.original_tx_hash, input.originalTxHash) &&
        Number(row.nonce) === input.nonce &&
        (row.max_fee === null ? null : formatAmount(parseAmount(row.max_fee))) === maxFee &&
        row.max_fee_unit === (input.maxFeeUnit ?? null);
      if (!same) throw new CustodyStuckError('stuck.action_differs', `the action key ${input.actionKey} was used for a different request`);
    } else {
      const attempt = await this.assertActionable(input);
      await this.sql`INSERT INTO pay.custody_tx_actions
          (action_key, kind, withdrawal_id, withdrawal_attempt, original_tx_hash, nonce, max_fee, max_fee_unit, reason, requested_by)
        VALUES (${input.actionKey}, ${input.kind}, ${input.withdrawalId}::uuid, ${attempt}, ${input.originalTxHash}, ${input.nonce},
                ${maxFee}::numeric, ${input.maxFeeUnit ?? null}, ${input.reason}, ${actor})
        ON CONFLICT (action_key) DO NOTHING`;
      row = (await this.actionRow({ key: input.actionKey }))!;
    }
    const view = await this.actionView(row);
    // Anything but "no answer yet" is already settled: the same key never reaches the chain twice.
    if (view.status !== 'intent') return view;
    try {
      const sent = await replacer.submit({
        kind: input.kind,
        actionKey: input.actionKey,
        originalTxHash: input.originalTxHash,
        nonce: input.nonce,
        maxFee,
        maxFeeUnit: input.maxFeeUnit ?? null,
      });
      await this
        .sql`INSERT INTO pay.custody_tx_action_outcomes (action_id, outcome, tx_hash) VALUES (${row.id}::uuid, 'submitted', ${sent.txHash})
                     ON CONFLICT (action_id, outcome) DO NOTHING`;
    } catch (error) {
      if (error instanceof ReplacerRefusal) {
        await this
          .sql`INSERT INTO pay.custody_tx_action_outcomes (action_id, outcome, failure_code) VALUES (${row.id}::uuid, 'failed', ${error.code})
                       ON CONFLICT (action_id, outcome) DO NOTHING`;
      } else {
        throw new CustodyStuckError('stuck.outcome_unknown', 'the signer did not answer; the same action key resumes this action');
      }
    }
    return this.actionView(row);
  }

  private async assertActionable(input: ActionInput): Promise<number> {
    const [w] = await this.sql<
      Array<{ status: string; attempts: number }>
    >`SELECT status::text AS status, attempts FROM pay.withdrawals WHERE id = ${input.withdrawalId}::uuid`;
    if (!w) throw new CustodyStuckError('stuck.withdrawal_not_found', `no withdrawal ${input.withdrawalId}`);
    const link = await this.linkOf(input.withdrawalId);
    if (!link) throw new CustodyStuckError('stuck.not_linked', 'this withdrawal is not linked to a custody wallet');
    if (w.status !== 'held') throw new CustodyStuckError('stuck.not_in_flight', `a ${w.status} withdrawal is not in flight`);
    if (link.nonce !== null && link.nonce !== input.nonce) {
      throw new CustodyStuckError('stuck.nonce_mismatch', `the withdrawal was signed with nonce ${link.nonce}, not ${input.nonce}`);
    }
    return w.attempts;
  }

  /**
   * Asks the chain what became of the original and records it. `replaced` and `dropped` are recorded only when the chain
   * shows them. For a DROP action, `dropped` is recorded only when the nonce was taken by the drop's own transaction:
   * a plain eviction leaves the nonce free, the original could still be rebroadcast, and nothing is recorded.
   */
  async resolve(actionId: string): Promise<ActionView> {
    const chain = this.deps.chain;
    if (!chain)
      throw new CustodyStuckError('rail.crypto', 'no chain reader is connected, so the original cannot be shown replaced or dropped');
    const row = await this.actionRow({ id: actionId });
    if (!row) throw new CustodyStuckError('stuck.action_not_found', `no action ${actionId}`);
    const view = await this.actionView(row);
    const status = await chain.status({ originalTxHash: row.original_tx_hash, nonce: Number(row.nonce) });
    const record = (outcome: string, txHash: string | null) =>
      this.sql`INSERT INTO pay.custody_tx_action_outcomes (action_id, outcome, tx_hash) VALUES (${row.id}::uuid, ${outcome}, ${txHash})
               ON CONFLICT (action_id, outcome) DO NOTHING`;
    if (status.state === 'original_mined') await record('original_mined', null);
    else if (status.state === 'replaced' && status.replacementTxHash) {
      const ours = view.submittedTxHash !== null && sameHash(view.submittedTxHash, status.replacementTxHash);
      if (row.kind === 'drop') {
        if (ours) await record('dropped', null);
        else await record('replaced', status.replacementTxHash);
      } else await record('replaced', status.replacementTxHash);
    } else if (status.state === 'dropped' && row.kind !== 'drop') await record('dropped', null);
    return this.actionView(row);
  }

  // ── cancel before broadcast ──────────────────────────────────────────────────────────────────────────────

  /**
   * An operator cancels a customer's withdrawal before any send attempt (W-withdraw-07), through the customer's own cancel: a
   * held one only when its dispatch journal proves nothing was sent; one that may have been sent, or was sent, is refused there.
   */
  async cancel(actor: string, withdrawalId: string): Promise<{ withdrawalId: string; canceled: true }> {
    const canceller = this.deps.canceller;
    if (!canceller) throw new CustodyStuckError('stuck.cancel_unwired', 'the withdrawal cancel is not connected here');
    const [w] = await this.sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.withdrawals WHERE id = ${withdrawalId}::uuid`;
    if (!w) throw new CustodyStuckError('stuck.withdrawal_not_found', `no withdrawal ${withdrawalId}`);
    try {
      await canceller.cancelWithdrawal({ userId: w.user_id, withdrawalId });
    } catch (error) {
      if (error instanceof PayError) throw new CustodyStuckError('stuck.cancel_refused', `${error.code}: ${error.message}`);
      throw error;
    }
    await this
      .sql`INSERT INTO pay.custody_tx_notes (withdrawal_id, note, author) VALUES (${withdrawalId}::uuid, 'Canceled by an operator before broadcast', ${actor})`;
    return { withdrawalId, canceled: true };
  }

  // ── reverse after a dropped transaction ──────────────────────────────────────────────────────────────────

  async requestReverse(
    actor: string,
    input: { withdrawalId: string; actionId: string; evidenceTxHash: string; evidenceNonce: number; reason: string },
  ): Promise<ReverseView> {
    const action = await this.actionRow({ id: input.actionId });
    if (!action || action.withdrawal_id !== input.withdrawalId) {
      throw new CustodyStuckError('stuck.action_not_found', 'no such action for this withdrawal');
    }
    if (!sameHash(action.original_tx_hash, input.evidenceTxHash) || Number(action.nonce) !== input.evidenceNonce) {
      throw new CustodyStuckError(
        'stuck.reverse_evidence_mismatch',
        'the evidence hash and nonce must be those of the dropped transaction',
      );
    }
    const view = await this.actionView(action);
    if (action.kind !== 'drop' || view.status !== 'dropped') {
      throw new CustodyStuckError('stuck.reverse_needs_drop', 'a reverse needs a drop action that the chain showed took the nonce');
    }
    // The evidence is about ONE attempt. A customer retry opens a new attempt with a new hold and a new send, so evidence
    // from an earlier attempt must never reverse the current one: the withdrawal must still be on the action's attempt.
    const [w] = await this.sql<Array<{ status: string; attempts: number }>>`
      SELECT status::text AS status, attempts FROM pay.withdrawals WHERE id = ${input.withdrawalId}::uuid`;
    if (!w || w.status !== 'held' || w.attempts !== action.withdrawal_attempt) {
      throw new CustodyStuckError(
        'stuck.reverse_stale',
        'the withdrawal is no longer held on the attempt this drop was about; there is nothing to reverse from this evidence',
      );
    }
    await this
      .sql`INSERT INTO pay.custody_reverse_requests (withdrawal_id, action_id, attempt, evidence_tx_hash, evidence_nonce, reason, requested_by)
      VALUES (${input.withdrawalId}::uuid, ${input.actionId}::uuid, ${action.withdrawal_attempt}, ${action.original_tx_hash}, ${input.evidenceNonce}, ${input.reason}, ${actor})
      ON CONFLICT (withdrawal_id, attempt) DO NOTHING`;
    const [r] = await this.sql<Array<{ id: string; action_id: string }>>`
      SELECT id, action_id FROM pay.custody_reverse_requests
       WHERE withdrawal_id = ${input.withdrawalId}::uuid AND attempt = ${action.withdrawal_attempt}`;
    if (r!.action_id !== input.actionId)
      throw new CustodyStuckError('stuck.reverse_exists', 'a reverse was already requested for this attempt on another action');
    return this.reverseView(r!.id);
  }

  async approveReverse(actor: string, requestId: string): Promise<ReverseView> {
    const view = await this.reverseView(requestId);
    if (view.requestedBy === actor) {
      throw new CustodyStuckError(
        'stuck.second_approver_required',
        'a reverse is approved by someone other than the person who requested it',
      );
    }
    await this.sql`INSERT INTO pay.custody_reverse_approvals (request_id, approver) VALUES (${requestId}::uuid, ${actor})
                   ON CONFLICT (request_id, approver) DO NOTHING`;
    return this.reverseView(requestId);
  }

  /** Posts the reverse once. A repeat of an executed request returns the record; the ledger key is the attempt's own. */
  async executeReverse(actor: string, requestId: string): Promise<ReverseView> {
    const view = await this.reverseView(requestId);
    if (view.executed) return view;
    if (!view.approved) throw new CustodyStuckError('stuck.reverse_not_approved', 'a second founder must approve before the reverse runs');
    const reverser = this.deps.reverser;
    if (!reverser) throw new CustodyStuckError('stuck.reverse_unwired', 'the ledger reverse is not connected here');
    // The stored outcome is the evidence; ask the chain once more so a reorg that confirmed the original blocks the reverse.
    if (this.deps.chain) {
      const action = await this.actionRow({ id: view.actionId });
      const now = await this.deps.chain.status({ originalTxHash: action!.original_tx_hash, nonce: Number(action!.nonce) });
      if (now.state === 'original_mined') {
        throw new CustodyStuckError(
          'stuck.reverse_original_mined',
          'the chain now shows the original transaction confirmed; nothing is reversed',
        );
      }
    }
    try {
      await reverser.reverseDropped({ withdrawalId: view.withdrawalId, evidenceRef: requestId, expectedAttempt: view.attempt });
    } catch (error) {
      throw new CustodyStuckError(
        'stuck.reverse_failed',
        `${error instanceof Error ? error.message : 'reverse failed'}; running it again is safe`,
      );
    }
    await this.sql`INSERT INTO pay.custody_reverse_outcomes (request_id, executed_by) VALUES (${requestId}::uuid, ${actor})
                   ON CONFLICT (request_id) DO NOTHING`;
    return this.reverseView(requestId);
  }

  private async reverseView(requestId: string): Promise<ReverseView> {
    const [r] = await this.sql<
      Array<{
        id: string;
        withdrawal_id: string;
        action_id: string;
        attempt: number;
        evidence_tx_hash: string;
        evidence_nonce: string;
        reason: string;
        requested_by: string;
        at: string;
      }>
    >`SELECT id, withdrawal_id, action_id, attempt, evidence_tx_hash, evidence_nonce::text AS evidence_nonce, reason, requested_by, ${this.sql.unsafe(TS('at'))} AS at
        FROM pay.custody_reverse_requests WHERE id = ${requestId}::uuid`;
    if (!r) throw new CustodyStuckError('stuck.reverse_not_found', `no reverse request ${requestId}`);
    const approvers = await this.sql<
      Array<{ approver: string }>
    >`SELECT approver FROM pay.custody_reverse_approvals WHERE request_id = ${requestId}::uuid ORDER BY seq`;
    const [done] = await this.sql`SELECT 1 FROM pay.custody_reverse_outcomes WHERE request_id = ${requestId}::uuid`;
    return {
      id: r.id,
      withdrawalId: r.withdrawal_id,
      actionId: r.action_id,
      attempt: r.attempt,
      evidenceTxHash: r.evidence_tx_hash,
      evidenceNonce: Number(r.evidence_nonce),
      reason: r.reason,
      requestedBy: r.requested_by,
      at: r.at,
      approvers: approvers.map((a) => a.approver),
      approved: approvers.some((a) => a.approver !== r.requested_by),
      executed: done !== undefined,
    };
  }
}
