import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { failureReason, listFailureReasons, type FailureReason } from '../../withdrawals/reasons.js';
import { customerStatus, storedStatusesFor, WITHDRAWAL_CANCELED_CODE, type WithdrawalStatus } from '../../withdrawals/status.js';
import { CustodyTxError } from './errors.js';
import type { ConfirmationRequestView, CustodyTxState, TimelineEntry, TxDetail, TxItem, TxListInput } from './schemas.js';
import { CUSTODY_TX_STATES } from './schemas.js';

/**
 * Custody transaction history, lifecycle, reason catalog and confirmation policy (W-custody-ops-11).
 *
 * A custody transaction is a row of `pay.withdrawals`; nothing here keeps a second copy or a balance. The lifecycle is
 * that row's status in the custody vocabulary, with a travel-rule outcome shown as the sub-status that blocks it. The
 * chain is a port this process may not have: block height and hash come from a `TxChainReader`, and with none the
 * answer is `unwired` (`rail.crypto`), never a guess. `PENDING_SIGNATURE` and `SIGNED` exist in the vocabulary but no
 * stored signal says a withdrawal is in them yet, so a row is never put there.
 *
 * Confirmation policy: the network default is the registry's count (blank stays blank). An override is a request with a
 * reason, approved by someone other than the requester; one below the default also carries an expiry; zero is allowed only
 * for one transaction whose destination is one of our own custody wallets. An override applies to custody only. A customer
 * credit always uses `creditConfirmations`, which reads the registry and nothing else.
 */
export interface ChainTxInfo {
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly confirmations: number;
}

/** Reads a transaction from the chain. Returns null when the chain does not know the hash. */
export interface TxChainReader {
  lookup(txHash: string): Promise<ChainTxInfo | null>;
}

export interface CustodyTxServiceDeps {
  readonly sql: Sql;
  readonly chain?: TxChainReader;
  /** The clock for expiry and overdue checks. Defaults to the wall clock. */
  readonly now?: () => Date;
}

const BLOCKING_TRAVEL = new Set(['blocking_time_expired', 'rejected', 'repair', 'provider_unavailable']);
const SCREENING_TRAVEL = new Set(['started', 'pending', 'review']);
const TERMINAL: ReadonlySet<WithdrawalStatus> = new Set(['settled', 'failed', 'canceled', 'rejected']);

const STATE_OF: Record<WithdrawalStatus, CustodyTxState> = {
  requested: 'SUBMITTED',
  pending_review: 'PENDING_AUTHORIZATION',
  approved: 'QUEUED',
  held: 'QUEUED',
  dispatching: 'BROADCASTING',
  broadcast: 'BROADCASTING',
  confirming: 'CONFIRMING',
  settled: 'COMPLETED',
  rejected: 'REJECTED',
  canceled: 'CANCELLED',
  failed: 'FAILED',
  needs_review: 'NEEDS_REVIEW',
};

/** The custody lifecycle state of a withdrawal status and its latest travel-rule status (null when it has none). */
export function custodyState(status: WithdrawalStatus, travelStatus: string | null): CustodyTxState {
  if (!TERMINAL.has(status) && travelStatus !== null) {
    if (BLOCKING_TRAVEL.has(travelStatus)) return 'BLOCKED';
    if (SCREENING_TRAVEL.has(travelStatus)) return 'PENDING_AML_SCREENING';
  }
  return STATE_OF[status];
}

interface TxRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  rail: string;
  destination: { kind: string; ref: string };
  client_ref: string;
  rail_ref: string | null;
  failure_code: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  tr_status: string | null;
  tr_rule_seq: string | null;
  tr_actor: string | null;
}

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ISO_MICRO = /^[0-9T:.\-Z+ ]{10,40}$/;
const UUID = /^[0-9a-f-]{36}$/;

function encodeCursor(row: Pick<TxRow, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: row.created_at, i: row.id }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { t: string; i: string } {
  try {
    const { t, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof t === 'string' && typeof i === 'string' && ISO_MICRO.test(t) && UUID.test(i)) return { t, i };
  } catch {
    // fall through
  }
  throw new CustodyTxError('custody_tx.cursor_invalid', 'the page cursor is not one this list issued');
}

function norm(amount: string): string {
  return formatAmount(parseAmount(amount));
}

export class CustodyTxService {
  private readonly sql: Sql;
  private readonly chain: TxChainReader | undefined;
  private readonly now: () => Date;

  constructor(deps: CustodyTxServiceDeps) {
    this.sql = deps.sql;
    this.chain = deps.chain;
    this.now = deps.now ?? (() => new Date());
  }

  // ── history ────────────────────────────────────────────────────────────────────────────────────────────────

  private async timeouts(): Promise<Map<string, number>> {
    const rows = await this.sql<Array<{ state: string; seconds: number }>>`
      SELECT DISTINCT ON (state) state, seconds FROM pay.custody_lifecycle_timeout_events ORDER BY state, seq DESC`;
    return new Map(rows.map((r) => [r.state, r.seconds]));
  }

  private item(r: TxRow, timeouts: Map<string, number>): TxItem {
    const status = customerStatus(r.status, r.failure_code);
    const state = custodyState(status, r.tr_status);
    const reason = this.reasonFor(status, state, r);
    const seconds = timeouts.get(state);
    const age = (this.now().getTime() - new Date(r.updated_at).getTime()) / 1000;
    return {
      withdrawalId: r.id,
      userId: r.user_id,
      assetId: r.asset_id,
      amount: norm(r.amount),
      rail: r.rail,
      destination: r.destination,
      clientRef: r.client_ref,
      railRef: r.rail_ref,
      status,
      state,
      reason,
      blockedBy:
        state === 'BLOCKED' && r.tr_status !== null && r.tr_rule_seq !== null && r.tr_actor !== null
          ? { source: 'travel_rule', status: r.tr_status, ruleSeq: Number(r.tr_rule_seq), decidedBy: r.tr_actor }
          : null,
      // Not overdue once the transaction is in a final state: a finished transaction waits on nothing.
      timeout: seconds === undefined ? null : { seconds, overdue: !TERMINAL.has(status) && age > seconds },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private reasonFor(status: WithdrawalStatus, state: CustodyTxState, r: TxRow): FailureReason | null {
    if (state === 'BLOCKED' && r.tr_status) return failureReason(`travel_rule.${r.tr_status}`);
    // Only a failed or cancelled row has a stored failure code that is the reason; a held row's code is not one.
    if (status === 'failed' || status === 'canceled') return failureReason(r.failure_code);
    return null;
  }

  private selectTx() {
    return this.sql`
      SELECT w.id, w.user_id, w.asset_id, w.amount::text AS amount, w.rail, w.destination, w.client_ref, w.rail_ref,
             w.failure_code, w.status::text AS status,
             ${this.sql.unsafe(TS('w.created_at'))} AS created_at, ${this.sql.unsafe(TS('w.updated_at'))} AS updated_at,
             tr.to_status AS tr_status, tr.rule_seq::text AS tr_rule_seq, tr.actor AS tr_actor
        FROM pay.withdrawals w
        LEFT JOIN LATERAL (
          SELECT t.to_status, x.rule_seq, t.actor
            FROM pay.travel_rule_transfers x
            JOIN pay.travel_rule_transitions t ON t.transfer_id = x.id
           WHERE x.withdrawal_id = w.id
           ORDER BY t.seq DESC LIMIT 1) tr ON true`;
  }

  async list(input: TxListInput): Promise<{ items: TxItem[]; next: string | null }> {
    const stored = input.status ? storedStatusesFor(input.status) : null;
    if (stored !== null && stored.length === 0) return { items: [], next: null };
    const canceledOnly = input.status === 'canceled' ? true : input.status === 'failed' ? false : null;
    const cursor = input.after ? decodeCursor(input.after) : null;
    const rows = await this.sql<TxRow[]>`
      ${this.selectTx()}
       WHERE (${input.userId ?? null}::text IS NULL OR w.user_id = ${input.userId ?? null})
         AND (${input.assetId ?? null}::text IS NULL OR w.asset_id = ${input.assetId ?? null})
         AND (${stored}::text[] IS NULL OR w.status::text = ANY(${stored}::text[]))
         AND (${canceledOnly}::boolean IS NULL OR (w.failure_code IS NOT DISTINCT FROM ${WITHDRAWAL_CANCELED_CODE}) = ${canceledOnly})
         AND (${input.since ?? null}::text IS NULL OR w.created_at >= ${input.since ?? null}::text::timestamptz)
         AND (${input.until ?? null}::text IS NULL OR w.created_at < ${input.until ?? null}::text::timestamptz)
         AND (${cursor?.t ?? null}::text IS NULL OR (w.created_at, w.id) < (${cursor?.t ?? null}::text::timestamptz, ${cursor?.i ?? null}::uuid))
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT ${input.limit + 1}`;
    const timeouts = await this.timeouts();
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.item(r, timeouts)), next: rows.length > input.limit && last ? encodeCursor(last) : null };
  }

  private async load(withdrawalId: string): Promise<TxRow> {
    const [row] = await this.sql<TxRow[]>`${this.selectTx()} WHERE w.id = ${withdrawalId}::uuid`;
    if (!row) throw new CustodyTxError('custody_tx.not_found', `no custody transaction ${withdrawalId}`);
    return row;
  }

  async get(withdrawalId: string): Promise<TxDetail> {
    const row = await this.load(withdrawalId);
    const item = this.item(row, await this.timeouts());
    const notes = await this.sql<Array<{ seq: string; note: string; author: string; at: string }>>`
      SELECT seq::text AS seq, note, author, ${this.sql.unsafe(TS('at'))} AS at
        FROM pay.custody_tx_notes WHERE withdrawal_id = ${withdrawalId}::uuid ORDER BY seq`;
    return {
      ...item,
      block: await this.blockInfo(row),
      notes: notes.map((n) => ({ seq: Number(n.seq), note: n.note, author: n.author, at: n.at })),
    };
  }

  private async blockInfo(r: TxRow): Promise<TxDetail['block']> {
    if (r.destination.kind !== 'crypto' || !r.rail_ref) return { state: 'not_broadcast' };
    if (!this.chain) return { state: 'unwired', txHash: r.rail_ref, blocker: 'rail.crypto' };
    const found = await this.chain.lookup(r.rail_ref);
    if (!found) return { state: 'unknown_to_chain', txHash: r.rail_ref };
    return {
      state: 'in_block',
      txHash: r.rail_ref,
      blockHeight: found.blockHeight,
      blockHash: found.blockHash,
      confirmations: found.confirmations,
    };
  }

  async addNote(author: string, withdrawalId: string, note: string): Promise<TxDetail> {
    await this.load(withdrawalId);
    await this.sql`INSERT INTO pay.custody_tx_notes (withdrawal_id, note, author) VALUES (${withdrawalId}::uuid, ${note}, ${author})`;
    return this.get(withdrawalId);
  }

  async timeline(withdrawalId: string): Promise<TimelineEntry[]> {
    const row = await this.load(withdrawalId);
    const travel = await this.sql<
      Array<{ at: string; from_status: string | null; to_status: string; source: string; actor: string; reason: string | null }>
    >`
      SELECT ${this.sql.unsafe(TS('t.at'))} AS at, t.from_status, t.to_status, t.source, t.actor, t.reason
        FROM pay.travel_rule_transfers x JOIN pay.travel_rule_transitions t ON t.transfer_id = x.id
       WHERE x.withdrawal_id = ${withdrawalId}::uuid ORDER BY t.seq`;
    const returns = await this.sql<Array<{ at: string; kind: string; actor_id: string }>>`
      SELECT ${this.sql.unsafe(TS('at'))} AS at, kind, actor_id FROM pay.withdrawal_return_events
       WHERE withdrawal_id = ${withdrawalId}::uuid ORDER BY seq`;
    const notes = await this.sql<Array<{ at: string; note: string; author: string }>>`
      SELECT ${this.sql.unsafe(TS('at'))} AS at, note, author FROM pay.custody_tx_notes
       WHERE withdrawal_id = ${withdrawalId}::uuid ORDER BY seq`;
    const status = customerStatus(row.status, row.failure_code);
    const entries: TimelineEntry[] = [
      { at: row.created_at, kind: 'created', detail: 'requested', actor: null },
      ...travel.map((t): TimelineEntry => ({
        at: t.at,
        kind: 'travel_rule',
        detail: `${t.from_status ?? 'none'} -> ${t.to_status} (${t.source})${t.reason ? `: ${t.reason}` : ''}`,
        actor: t.actor,
      })),
      ...returns.map((x): TimelineEntry => ({ at: x.at, kind: 'return', detail: x.kind, actor: x.actor_id })),
      ...notes.map((n): TimelineEntry => ({ at: n.at, kind: 'note', detail: n.note, actor: n.author })),
      { at: row.updated_at, kind: 'current', detail: status, actor: null },
    ];
    return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  // ── reason catalog and lifecycle timeouts ─────────────────────────────────────────────────────────────────────

  reasons(): FailureReason[] {
    return listFailureReasons();
  }

  async listTimeouts(): Promise<Array<{ state: CustodyTxState; seconds: number | null; setBy: string | null; setAt: string | null }>> {
    const rows = await this.sql<Array<{ state: string; seconds: number; set_by: string; at: string }>>`
      SELECT DISTINCT ON (state) state, seconds, set_by, ${this.sql.unsafe(TS('at'))} AS at
        FROM pay.custody_lifecycle_timeout_events ORDER BY state, seq DESC`;
    const byState = new Map(rows.map((r) => [r.state, r]));
    return CUSTODY_TX_STATES.map((state) => {
      const r = byState.get(state);
      return { state, seconds: r?.seconds ?? null, setBy: r?.set_by ?? null, setAt: r?.at ?? null };
    });
  }

  async setTimeout(actor: string, input: { state: CustodyTxState; seconds: number; reason: string }) {
    if (!CUSTODY_TX_STATES.includes(input.state)) {
      throw new CustodyTxError('custody_tx.timeout_state_unknown', `${input.state} is not a custody lifecycle state`);
    }
    await this.sql`INSERT INTO pay.custody_lifecycle_timeout_events (state, seconds, reason, set_by)
      VALUES (${input.state}, ${input.seconds}, ${input.reason}, ${actor})`;
    const all = await this.listTimeouts();
    return all.find((t) => t.state === input.state)!;
  }

  // ── confirmation policy ────────────────────────────────────────────────────────────────────────────────────

  private async registryDefault(networkId: string): Promise<number | null> {
    const [row] = await this.sql<Array<{ confirmations_required: number | null }>>`
      SELECT confirmations_required FROM pay.network_registry WHERE network_id = ${networkId}`;
    if (!row) throw new CustodyTxError('confirmation.network_unknown', `${networkId} is not in the network registry`);
    return row.confirmations_required;
  }

  /** The count a customer credit waits for: the registry's published count and nothing else. Overrides never apply. */
  async creditConfirmations(networkId: string): Promise<number> {
    const value = await this.registryDefault(networkId);
    if (value === null) throw new CustodyTxError('confirmation.default_unset', `${networkId} has no published confirmation count`);
    return value;
  }

  private async effectiveOverride(networkId: string, withdrawalId: string | null) {
    const at = this.now().toISOString();
    const rows = await this.sql<Array<{ id: string; scope: string; confirmations: number; expires_at: string | null }>>`
      SELECT r.id, r.scope, r.confirmations, ${this.sql.unsafe(TS('r.expires_at'))} AS expires_at
        FROM pay.confirmation_override_requests r
       WHERE r.network_id = ${networkId}
         AND ((r.scope = 'transaction' AND r.withdrawal_id = ${withdrawalId}::uuid) OR r.scope = 'network')
         AND (r.expires_at IS NULL OR r.expires_at > ${at}::timestamptz)
         AND EXISTS (SELECT 1 FROM pay.confirmation_override_approvals a WHERE a.request_id = r.id AND a.approver <> r.requested_by)
       ORDER BY (r.scope = 'transaction') DESC, r.requested_at DESC, r.id DESC
       LIMIT 1`;
    return rows[0] ?? null;
  }

  async confirmationPolicy(networkId: string, withdrawalId: string | null) {
    const networkDefault = await this.registryDefault(networkId);
    const o = await this.effectiveOverride(networkId, withdrawalId);
    if (o) {
      return {
        networkId,
        networkDefault,
        effective: o.confirmations,
        source: o.scope === 'transaction' ? ('transaction_override' as const) : ('network_override' as const),
        overrideId: o.id,
        expiresAt: o.expires_at,
      };
    }
    return {
      networkId,
      networkDefault,
      effective: networkDefault,
      source: networkDefault === null ? ('unset' as const) : ('default' as const),
      overrideId: null,
      expiresAt: null,
    };
  }

  async requestOverride(
    actor: string,
    input: { networkId: string; withdrawalId?: string; confirmations: number; reason: string; expiresAt?: string },
  ): Promise<ConfirmationRequestView> {
    const networkDefault = await this.registryDefault(input.networkId);
    if (networkDefault === null) {
      throw new CustodyTxError('confirmation.default_unset', `${input.networkId} has no network default to judge an override against`);
    }
    let destination: string | null = null;
    if (input.withdrawalId) destination = (await this.load(input.withdrawalId)).destination.ref;
    if (input.confirmations === 0) {
      const own =
        destination === null
          ? []
          : await this
              .sql`SELECT 1 FROM pay.custody_wallets WHERE network_id = ${input.networkId} AND lower(address) = lower(${destination}) LIMIT 1`;
      if (own.length === 0) {
        throw new CustodyTxError(
          'confirmation.zero_needs_own_wallets',
          'zero confirmations are allowed only for one transaction between our own custody wallets',
        );
      }
    }
    if (input.expiresAt !== undefined && new Date(input.expiresAt).getTime() <= this.now().getTime()) {
      throw new CustodyTxError('confirmation.expiry_in_past', 'the expiry is already past');
    }
    if (input.confirmations < networkDefault && input.expiresAt === undefined) {
      throw new CustodyTxError('confirmation.expiry_required', `a count below the network default of ${networkDefault} needs an expiry`);
    }
    const [row] = await this.sql<Array<{ id: string }>>`
      INSERT INTO pay.confirmation_override_requests
        (scope, network_id, withdrawal_id, confirmations, default_at_request, reason, requested_by, expires_at)
      VALUES (${input.withdrawalId ? 'transaction' : 'network'}, ${input.networkId}, ${input.withdrawalId ?? null}::uuid,
              ${input.confirmations}, ${networkDefault}, ${input.reason}, ${actor}, ${input.expiresAt ?? null}::timestamptz)
      RETURNING id`;
    return this.requestView(row!.id);
  }

  async approveOverride(actor: string, requestId: string): Promise<ConfirmationRequestView> {
    const view = await this.requestView(requestId);
    if (view.requestedBy === actor) {
      throw new CustodyTxError(
        'confirmation.second_approver_required',
        'an override is approved by someone other than the person who requested it',
      );
    }
    if (view.expiresAt !== null && new Date(view.expiresAt).getTime() <= this.now().getTime()) {
      throw new CustodyTxError('confirmation.request_expired', 'this override has already expired');
    }
    await this.sql`INSERT INTO pay.confirmation_override_approvals (request_id, approver) VALUES (${requestId}::uuid, ${actor})
                   ON CONFLICT (request_id, approver) DO NOTHING`;
    return this.requestView(requestId);
  }

  async listOverrides(networkId: string, limit: number): Promise<ConfirmationRequestView[]> {
    const ids = await this.sql<Array<{ id: string }>>`
      SELECT id FROM pay.confirmation_override_requests WHERE network_id = ${networkId}
       ORDER BY requested_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(ids.map((r) => this.requestView(r.id)));
  }

  private async requestView(requestId: string): Promise<ConfirmationRequestView> {
    const [r] = await this.sql<
      Array<{
        id: string;
        scope: 'network' | 'transaction';
        network_id: string;
        withdrawal_id: string | null;
        confirmations: number;
        default_at_request: number;
        reason: string;
        requested_by: string;
        requested_at: string;
        expires_at: string | null;
      }>
    >`SELECT id, scope, network_id, withdrawal_id, confirmations, default_at_request, reason, requested_by,
              ${this.sql.unsafe(TS('requested_at'))} AS requested_at, ${this.sql.unsafe(TS('expires_at'))} AS expires_at
         FROM pay.confirmation_override_requests WHERE id = ${requestId}::uuid`;
    if (!r) throw new CustodyTxError('confirmation.request_not_found', `no override request ${requestId}`);
    const approvers = await this.sql<Array<{ approver: string }>>`
      SELECT approver FROM pay.confirmation_override_approvals WHERE request_id = ${requestId}::uuid ORDER BY seq`;
    const live = r.expires_at === null || new Date(r.expires_at).getTime() > this.now().getTime();
    return {
      id: r.id,
      scope: r.scope,
      networkId: r.network_id,
      withdrawalId: r.withdrawal_id,
      confirmations: r.confirmations,
      defaultAtRequest: r.default_at_request,
      reason: r.reason,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      expiresAt: r.expires_at,
      approvers: approvers.map((a) => a.approver),
      effective: live && approvers.some((a) => a.approver !== r.requested_by),
    };
  }
}
