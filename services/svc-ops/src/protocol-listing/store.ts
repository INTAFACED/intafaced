import type { Sql } from 'postgres';
import type { ListingState, ProtocolOpsAction } from '@intafaced/contracts';

/** A pool or a market. A hide is a LISTING decision: it never pauses a contract and never touches a balance. */
export type ListingKind = 'pool' | 'market';

export interface ListingRow {
  readonly kind: ListingKind;
  readonly targetId: string;
  readonly state: Exclude<ListingState, 'applying'>;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly approvalId: string;
  readonly policyVersion: string;
  readonly updatedAt: string;
}

export interface ListingDecision {
  readonly idempotencyKey: string;
  readonly action: ProtocolOpsAction;
  readonly kind: ListingKind;
  readonly targetId: string;
  readonly outcome: 'applied' | 'noop';
  readonly note: string | null;
  readonly state: Exclude<ListingState, 'applying'>;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly approvalId: string;
  readonly requesterId: string;
  readonly approverId: string;
  readonly policyVersion: string;
}

export interface ListingStore {
  state(kind: ListingKind, targetId: string): Promise<ListingRow | null>;
  decision(idempotencyKey: string): Promise<ListingDecision | null>;
  /** Every target that has ever been decided, hidden or restored. */
  list(kind: ListingKind): Promise<readonly ListingRow[]>;
  /**
   * One transaction: append the decision and, when it applied, set the state. A decision whose key already exists is
   * not written twice: the stored one comes back.
   */
  record(decision: ListingDecision, at: string): Promise<ListingDecision>;
}

const stateOf = (action: ProtocolOpsAction): ListingRow['state'] =>
  action === 'protocol.pool.hide' || action === 'protocol.market.delist' ? 'hidden' : 'visible';

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryListingStore(): ListingStore {
  const rows = new Map<string, ListingRow>();
  const decisions = new Map<string, ListingDecision>();
  const key = (kind: ListingKind, targetId: string) => `${kind}:${targetId}`;
  return {
    async state(kind, targetId) {
      return rows.get(key(kind, targetId)) ?? null;
    },
    async decision(idempotencyKey) {
      return decisions.get(idempotencyKey) ?? null;
    },
    async list(kind) {
      return [...rows.values()].filter((row) => row.kind === kind);
    },
    async record(decision, at) {
      const stored = decisions.get(decision.idempotencyKey);
      if (stored) return stored;
      decisions.set(decision.idempotencyKey, decision);
      if (decision.outcome === 'applied') {
        rows.set(key(decision.kind, decision.targetId), {
          kind: decision.kind,
          targetId: decision.targetId,
          state: decision.state,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
          approvalId: decision.approvalId,
          policyVersion: decision.policyVersion,
          updatedAt: at,
        });
      }
      return decision;
    },
  };
}

interface OverrideRow {
  kind: ListingKind;
  target_id: string;
  state: ListingRow['state'];
  reason_code: string | null;
  reason: string | null;
  approval_id: string;
  policy_version: string;
  updated_at: Date;
}
interface DecisionRow {
  idempotency_key: string;
  action: ProtocolOpsAction;
  kind: ListingKind;
  target_id: string;
  outcome: 'applied' | 'noop';
  note: string | null;
  reason_code: string | null;
  reason: string | null;
  approval_id: string;
  requester_id: string;
  approver_id: string;
  policy_version: string;
}

const toRow = (row: OverrideRow): ListingRow => ({
  kind: row.kind,
  targetId: row.target_id,
  state: row.state,
  reasonCode: row.reason_code,
  reason: row.reason,
  approvalId: row.approval_id,
  policyVersion: row.policy_version,
  updatedAt: row.updated_at.toISOString(),
});

const toDecision = (row: DecisionRow): ListingDecision => ({
  idempotencyKey: row.idempotency_key,
  action: row.action,
  kind: row.kind,
  targetId: row.target_id,
  outcome: row.outcome,
  note: row.note,
  // The state the target was in after the decision: a no-op leaves the target in the state the action names.
  state: stateOf(row.action),
  reasonCode: row.reason_code,
  reason: row.reason,
  approvalId: row.approval_id,
  requesterId: row.requester_id,
  approverId: row.approver_id,
  policyVersion: row.policy_version,
});

/** Decisions live in `ops.protocol_listing_decisions` (append-only) and the current state in `ops.protocol_listing_overrides`. */
export function createPgListingStore(sql: Sql): ListingStore {
  const decisionByKey = async (q: Sql, idempotencyKey: string): Promise<ListingDecision | null> => {
    const [row] = await q<
      DecisionRow[]
    >`SELECT idempotency_key,action,kind,target_id,outcome,note,reason_code,reason,approval_id,requester_id,approver_id,policy_version
      FROM ops.protocol_listing_decisions WHERE idempotency_key=${idempotencyKey}`;
    return row ? toDecision(row) : null;
  };
  return {
    async state(kind, targetId) {
      const [row] = await sql<
        OverrideRow[]
      >`SELECT kind,target_id,state,reason_code,reason,approval_id,policy_version,updated_at FROM ops.protocol_listing_overrides WHERE kind=${kind} AND target_id=${targetId}`;
      return row ? toRow(row) : null;
    },
    decision: (idempotencyKey) => decisionByKey(sql, idempotencyKey),
    async list(kind) {
      const rows = await sql<
        OverrideRow[]
      >`SELECT kind,target_id,state,reason_code,reason,approval_id,policy_version,updated_at FROM ops.protocol_listing_overrides WHERE kind=${kind} ORDER BY target_id`;
      return rows.map(toRow);
    },
    async record(decision, at) {
      return sql.begin(async (tx) => {
        const q = tx as unknown as Sql;
        // One writer per target at a time, so the no-op check and the write see the same state.
        await q`SELECT pg_advisory_xact_lock(hashtext(${`ops.protocol_listing:${decision.kind}:${decision.targetId}`}))`;
        const prior = await decisionByKey(q, decision.idempotencyKey);
        if (prior) return prior;
        await q`INSERT INTO ops.protocol_listing_decisions
          (idempotency_key,action,kind,target_id,outcome,note,reason_code,reason,approval_id,requester_id,approver_id,policy_version,decided_at)
          VALUES (${decision.idempotencyKey},${decision.action},${decision.kind},${decision.targetId},${decision.outcome},${decision.note},
            ${decision.reasonCode},${decision.reason},${decision.approvalId},${decision.requesterId},${decision.approverId},${decision.policyVersion},${at})`;
        if (decision.outcome === 'applied') {
          await q`INSERT INTO ops.protocol_listing_overrides (kind,target_id,state,reason_code,reason,approval_id,policy_version,updated_at)
            VALUES (${decision.kind},${decision.targetId},${decision.state},${decision.reasonCode},${decision.reason},${decision.approvalId},${decision.policyVersion},${at})
            ON CONFLICT (kind,target_id) DO UPDATE SET state=EXCLUDED.state, reason_code=EXCLUDED.reason_code, reason=EXCLUDED.reason,
              approval_id=EXCLUDED.approval_id, policy_version=EXCLUDED.policy_version, updated_at=EXCLUDED.updated_at`;
        }
        return decision;
      });
    },
  };
}
