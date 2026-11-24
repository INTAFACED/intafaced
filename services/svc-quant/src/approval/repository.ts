import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';

/**
 * The account owner's live approval policy and the approvals of strategy versions (RC-algo-dev-01; J-algo-dev-16 #4).
 * Holds no balance and moves nothing. An approval binds to a content hash of the version's rules and the strategy's
 * risk settings, so any change, a new version or a risk edit, leaves no approval standing for what changed.
 */

export type ApprovalDecision = 'pending' | 'approved' | 'rejected';

export interface StoredPolicy {
  readonly accountId: string;
  readonly required: boolean;
  readonly key: string;
  readonly actor: string;
  readonly setAt: string;
}

export interface StoredApproval {
  readonly id: string;
  readonly key: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly contentHash: string;
  readonly requester: string;
  readonly reviewer: string | null;
  readonly decision: ApprovalDecision;
  readonly reason: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export interface ApprovalRepository {
  policy(accountId: string): Promise<StoredPolicy | null>;
  /** Sets the policy; the same key again reads back what it stored and changes nothing. */
  setPolicy(input: { accountId: string; required: boolean; key: string; actor: string; at: Date }): Promise<StoredPolicy>;
  /** A strategy's approval requests, newest first. */
  approvals(strategyId: string): Promise<readonly StoredApproval[]>;
  get(id: string): Promise<StoredApproval | null>;
  /** One request per key: the same key again returns the row it stored. */
  request(input: Omit<StoredApproval, 'id' | 'reviewer' | 'decision' | 'reason' | 'decidedAt'>): Promise<StoredApproval>;
  /** Sets a pending request's decision once; null when it was already decided. */
  decide(input: {
    id: string;
    reviewer: string;
    decision: 'approved' | 'rejected';
    reason: string;
    at: Date;
  }): Promise<StoredApproval | null>;
}

/** The hash an approval binds to: the version's rules and the strategy's risk settings, as canonical JSON. */
export function approvalContentHash(input: { readonly version: unknown; readonly risk: unknown }): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}

export function createMemoryApprovalRepository(): ApprovalRepository {
  const policies = new Map<string, StoredPolicy>();
  const rows: StoredApproval[] = [];
  return {
    async policy(accountId) {
      return policies.get(accountId) ?? null;
    },
    async setPolicy({ accountId, required, key, actor, at }) {
      const prior = policies.get(accountId);
      if (prior?.key === key) return prior;
      const row = { accountId, required, key, actor, setAt: at.toISOString() };
      policies.set(accountId, row);
      return row;
    },
    async approvals(strategyId) {
      return rows.filter((r) => r.strategyId === strategyId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async request(input) {
      const prior = rows.find((r) => r.key === input.key);
      if (prior) return prior;
      const row: StoredApproval = { ...input, id: randomUUID(), reviewer: null, decision: 'pending', reason: '', decidedAt: null };
      rows.push(row);
      return row;
    },
    async decide({ id, reviewer, decision, reason, at }) {
      const i = rows.findIndex((r) => r.id === id && r.decision === 'pending');
      if (i < 0) return null;
      const row = { ...rows[i]!, reviewer, decision, reason, decidedAt: at.toISOString() };
      rows[i] = row;
      return row;
    },
  };
}

interface PolicySql {
  account_id: string;
  required: boolean;
  write_key: string;
  actor: string;
  set_at: Date | string;
}
interface ApprovalSql {
  id: string;
  request_key: string;
  account_id: string;
  strategy_id: string;
  strategy_version: number;
  content_hash: string;
  requester: string;
  reviewer: string | null;
  decision: ApprovalDecision;
  reason: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
}
const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const policyOf = (r: PolicySql): StoredPolicy => ({
  accountId: r.account_id,
  required: r.required,
  key: r.write_key,
  actor: r.actor,
  setAt: iso(r.set_at),
});
const approvalOf = (r: ApprovalSql): StoredApproval => ({
  id: r.id,
  key: r.request_key,
  accountId: r.account_id,
  strategyId: r.strategy_id,
  strategyVersion: r.strategy_version,
  contentHash: r.content_hash,
  requester: r.requester,
  reviewer: r.reviewer,
  decision: r.decision,
  reason: r.reason,
  requestedAt: iso(r.requested_at),
  decidedAt: r.decided_at === null ? null : iso(r.decided_at),
});

export function createPostgresApprovalRepository(sql: Sql): ApprovalRepository {
  return {
    async policy(accountId) {
      const [row] = await sql<PolicySql[]>`SELECT * FROM quant.approval_policies WHERE account_id = ${accountId}`;
      return row ? policyOf(row) : null;
    },
    async setPolicy({ accountId, required, key, actor, at }) {
      const [row] = await sql<PolicySql[]>`
        INSERT INTO quant.approval_policies (account_id, required, write_key, actor, set_at)
        VALUES (${accountId}, ${required}, ${key}, ${actor}, ${at})
        ON CONFLICT (account_id) DO UPDATE SET required = EXCLUDED.required, write_key = EXCLUDED.write_key,
          actor = EXCLUDED.actor, set_at = EXCLUDED.set_at
        WHERE quant.approval_policies.write_key <> EXCLUDED.write_key
        RETURNING *`;
      if (row) return policyOf(row);
      const [kept] = await sql<PolicySql[]>`SELECT * FROM quant.approval_policies WHERE account_id = ${accountId}`;
      return policyOf(kept!);
    },
    async approvals(strategyId) {
      const rows = await sql<ApprovalSql[]>`
        SELECT * FROM quant.strategy_approvals WHERE strategy_id = ${strategyId} ORDER BY requested_at DESC, id DESC LIMIT 200`;
      return rows.map(approvalOf);
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [row] = await sql<ApprovalSql[]>`SELECT * FROM quant.strategy_approvals WHERE id = ${id}`;
      return row ? approvalOf(row) : null;
    },
    async request(input) {
      const [row] = await sql<ApprovalSql[]>`
        INSERT INTO quant.strategy_approvals
          (id, request_key, account_id, strategy_id, strategy_version, content_hash, requester, decision, requested_at)
        VALUES (${randomUUID()}, ${input.key}, ${input.accountId}, ${input.strategyId}, ${input.strategyVersion},
          ${input.contentHash}, ${input.requester}, 'pending', ${input.requestedAt})
        ON CONFLICT (request_key) DO NOTHING
        RETURNING *`;
      if (row) return approvalOf(row);
      const [kept] = await sql<ApprovalSql[]>`SELECT * FROM quant.strategy_approvals WHERE request_key = ${input.key}`;
      return approvalOf(kept!);
    },
    async decide({ id, reviewer, decision, reason, at }) {
      const [row] = await sql<ApprovalSql[]>`
        UPDATE quant.strategy_approvals SET reviewer = ${reviewer}, decision = ${decision}, reason = ${reason}, decided_at = ${at}
        WHERE id = ${id} AND decision = 'pending'
        RETURNING *`;
      return row ? approvalOf(row) : null;
    },
  };
}

/** The approval store. No URL means every call refuses by name. Pool size is never invented. */
export function openApprovalRepository(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  repository: ApprovalRepository;
  close: () => Promise<void>;
} {
  const refuse = (code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string) => {
    const fail = async (): Promise<never> => {
      throw new QuantError(code, detail);
    };
    const repository: ApprovalRepository = { policy: fail, setPolicy: fail, approvals: fail, get: fail, request: fail, decide: fail };
    return { repository, close: async () => undefined };
  };
  const url = env.DATABASE_URL?.trim();
  if (!url) return refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset');
  const raw = env.DATABASE_POOL_MAX?.trim() ?? '';
  const pool = Number(raw);
  if (!raw || !Number.isInteger(pool) || pool < 1 || pool > 200) {
    return refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200');
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return { repository: createPostgresApprovalRepository(sql), close: () => sql.end({ timeout: 5 }) };
}
