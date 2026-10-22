import { compare, formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { CustodyTaskExecutionError } from '../approvals/errors.js';
import type { TaskExecutor } from '../approvals/service.js';
import { CustodySweepError } from './errors.js';
import { SWEEP_TRIGGERS } from './schemas.js';
import type { SweepDueView, SweepPolicySetInput, SweepPolicyView, SweepView } from './schemas.js';

/**
 * Sweeps from customer deposit addresses to the treasury address (W-custody-ops-05).
 *
 * CUSTODY SIDE ONLY. A sweep moves coins between our own addresses. It never posts to the ledger and never changes a
 * customer balance (ENGINE D-5): the customer was credited by the `deposit` post when the deposit was recorded
 * (W-deposit-05), and that stands whether a sweep succeeds, fails or is never made.
 *
 * OWNER-SET, TWO PEOPLE, BLANK REFUSES. The trigger and the treasury address change only through an approved custody
 * `config` task (scope `policy`, `payload.kind = 'sweep_policy'`), the W-custody-ops-06 quorum; `policy.validate` returns
 * the payload to propose. The proposer and the approvers are stored on the row. A pair with no policy
 * refuses every sweep and every due check. Each trigger needs its own figure (amount, count, minutes) and
 * nothing is defaulted.
 *
 * SAGA. `create` writes the intent row under the business key `sweep:<depositId>:treasury` before the rail is asked;
 * a second create returns the same row. `execute` asks the broadcaster with that same key every time. A definite
 * failure is `failed` and may be retried; a broadcaster that throws leaves the row `unknown` (never voided here), and the
 * retry asks again with the original key, which the rail must answer with its first outcome. `broadcast` is final here.
 * Without a broadcaster in this process, `execute` refuses `rail.crypto` and the row stays as it was.
 */
export type SweepBroadcastResult =
  { readonly state: 'broadcast'; readonly txHash: string } | { readonly state: 'failed'; readonly error: string };

export interface SweepBroadcaster {
  send(input: {
    readonly idempotencyKey: string;
    readonly networkId: string;
    readonly assetId: string;
    readonly fromAddress: string;
    readonly toAddress: string;
    readonly amount: string;
  }): Promise<SweepBroadcastResult>;
}

const TIER = 'treasury' as const;
export const SWEEP_POLICY_KIND = 'sweep_policy' as const;

export interface SweepPolicyFields {
  readonly networkId: string;
  readonly assetId: string;
  readonly trigger: SweepPolicyView['trigger'];
  readonly thresholdAmount: string | null;
  readonly thresholdCount: number | null;
  readonly scheduleMinutes: number | null;
  readonly treasuryAddress: string;
  readonly reason: string;
}
export const sweepKey = (depositId: string) => `sweep:${depositId}:${TIER}`;

interface PolicyRow {
  network_id: string;
  asset_id: string;
  trigger: SweepPolicyView['trigger'];
  threshold_amount: string | null;
  threshold_count: number | null;
  schedule_minutes: number | null;
  treasury_address: string;
  reason: string;
  set_by: string;
  approved_by: string[];
  approval_task_id: string;
  set_at: Date;
}

interface SweepRow {
  id: string;
  idempotency_key: string;
  deposit_id: string;
  tier: typeof TIER;
  network_id: string;
  asset_id: string;
  from_address: string;
  to_address: string;
  amount: string;
  status: SweepView['status'];
  tx_hash: string | null;
  attempts: number;
  last_error: string | null;
  created_by: string;
  last_executed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const policyView = (r: PolicyRow): SweepPolicyView => ({
  networkId: r.network_id,
  assetId: r.asset_id,
  trigger: r.trigger,
  thresholdAmount: r.threshold_amount === null ? null : decimal(r.threshold_amount),
  thresholdCount: r.threshold_count,
  scheduleMinutes: r.schedule_minutes,
  treasuryAddress: r.treasury_address,
  reason: r.reason,
  setBy: r.set_by,
  approvedBy: r.approved_by,
  approvalTaskId: r.approval_task_id,
  setAt: r.set_at.toISOString(),
});

const sweepView = (r: SweepRow): SweepView => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  depositId: r.deposit_id,
  tier: r.tier,
  networkId: r.network_id,
  assetId: r.asset_id,
  fromAddress: r.from_address,
  toAddress: r.to_address,
  amount: decimal(r.amount),
  status: r.status,
  txHash: r.tx_hash,
  attempts: r.attempts,
  lastError: r.last_error,
  createdBy: r.created_by,
  lastExecutedBy: r.last_executed_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** numeric(38,18) comes back as a decimal string with trailing zeros; parse to bigint and print the canonical form. */
function decimal(v: string): string {
  return formatAmount(parseAmount(String(v)));
}

function invalid(message: string): never {
  throw new CustodySweepError('custody_sweep.policy_invalid', message);
}

export class CustodySweepService {
  constructor(
    private readonly deps: {
      readonly sql: Sql;
      readonly broadcaster?: SweepBroadcaster;
      /**
       * Owner-set seconds after which a row left `broadcasting` (a crash after the claim) may be claimed again and
       * re-sent under its original key. null = not set: such a row refuses `custody_sweep.stale_ttl_unset`.
       */
      readonly staleAfterSeconds?: number | null;
    },
  ) {}

  /** Checks the figures and returns the policy exactly as it would be stored. Reads and writes nothing. */
  private normalize(input: SweepPolicySetInput): SweepPolicyFields {
    const address = input.treasuryAddress.trim();
    if (
      typeof input.networkId !== 'string' ||
      typeof input.assetId !== 'string' ||
      typeof input.reason !== 'string' ||
      !input.reason.trim()
    ) {
      invalid('networkId, assetId and reason are required');
    }
    if (!input.networkId.trim() || !input.assetId.trim()) invalid('networkId and assetId are required');
    if (!(SWEEP_TRIGGERS as readonly string[]).includes(input.trigger)) invalid(`trigger must be one of ${SWEEP_TRIGGERS.join(', ')}`);
    if (address === '' || /\s/.test(address)) invalid('treasuryAddress is required and has no spaces');
    let amount: string | null = null;
    const others = { amount: input.thresholdAmount, count: input.thresholdCount, schedule: input.scheduleMinutes };
    for (const [k, v] of Object.entries(others)) {
      if (k !== input.trigger && v !== null) invalid(`trigger ${input.trigger} takes no ${k} figure`);
    }
    if (input.trigger === 'amount') {
      let parsed: bigint;
      try {
        parsed = parseAmount((input.thresholdAmount ?? '').trim());
      } catch {
        invalid('thresholdAmount must be a positive decimal string');
      }
      if (parsed <= 0n) invalid('thresholdAmount must be a positive decimal string');
      amount = formatAmount(parsed);
    }
    if (input.trigger === 'count' && (input.thresholdCount ?? 0) < 1) invalid('thresholdCount must be at least 1');
    if (input.trigger === 'schedule' && (input.scheduleMinutes ?? 0) < 1) invalid('scheduleMinutes must be at least 1');
    return {
      networkId: input.networkId,
      assetId: input.assetId,
      trigger: input.trigger,
      thresholdAmount: amount,
      thresholdCount: input.trigger === 'count' ? input.thresholdCount : null,
      scheduleMinutes: input.trigger === 'schedule' ? input.scheduleMinutes : null,
      treasuryAddress: address,
      reason: input.reason,
    };
  }

  /** What a founder proposes as the `policy` config task payload (`kind: 'sweep_policy'`). Reads and writes nothing. */
  validatePolicy(input: SweepPolicySetInput): SweepPolicyFields & { kind: typeof SWEEP_POLICY_KIND } {
    return { kind: SWEEP_POLICY_KIND, ...this.normalize(input) };
  }

  /**
   * Applier for an approved custody `config` task, scope `policy`, `payload.kind = 'sweep_policy'` (W-custody-ops-06
   * quorum: registered approvers, never the initiator). Stores the policy with the proposer as `set_by`, the approvers
   * from `custody_task_decisions` as `approved_by`, and the task id. A re-run of the same task stores nothing new.
   */
  readonly policyApplier: TaskExecutor = async (task) => {
    let p: SweepPolicyFields;
    try {
      const raw = task.payload as Record<string, unknown>;
      const orNull = (v: unknown) => (v === undefined ? null : v);
      p = this.normalize({
        ...(raw as unknown as SweepPolicySetInput),
        thresholdAmount: orNull(raw.thresholdAmount) as string | null,
        thresholdCount: orNull(raw.thresholdCount) as number | null,
        scheduleMinutes: orNull(raw.scheduleMinutes) as number | null,
        treasuryAddress: typeof raw.treasuryAddress === 'string' ? raw.treasuryAddress : '',
      });
    } catch (error) {
      throw new CustodyTaskExecutionError('custody_sweep.policy_invalid', error instanceof Error ? error.message : 'invalid sweep policy');
    }
    await transaction(this.deps.sql, async (tx) => {
      const done = await tx`SELECT 1 FROM pay.custody_sweep_policy_events WHERE approval_task_id = ${task.taskId}`;
      if (done.length > 0) return;
      const approvers = await tx<Array<{ approver_id: string }>>`
        SELECT approver_id FROM pay.custody_task_decisions
         WHERE task_id = ${task.taskId} AND decision = 'approve' AND payload_hash = ${task.payloadHash}
         ORDER BY decided_at, approver_id`;
      if (approvers.length === 0)
        throw new CustodyTaskExecutionError('custody_sweep.approvers_missing', 'the task carries no recorded approval');
      await tx`
        INSERT INTO pay.custody_sweep_policy_events
          (network_id, asset_id, trigger, threshold_amount, threshold_count, schedule_minutes, treasury_address, reason, set_by,
           approved_by, approval_task_id)
        VALUES (${p.networkId}, ${p.assetId}, ${p.trigger}, ${p.thresholdAmount}, ${p.thresholdCount}, ${p.scheduleMinutes},
                ${p.treasuryAddress}, ${p.reason}, ${task.initiator}, ${approvers.map((a) => a.approver_id)}, ${task.taskId})`;
    });
  };

  async getPolicy(networkId: string, assetId: string): Promise<SweepPolicyView> {
    return policyView(await this.policy(networkId, assetId));
  }

  private async policy(networkId: string, assetId: string): Promise<PolicyRow> {
    const [row] = await this.deps.sql<PolicyRow[]>`
      SELECT * FROM pay.custody_sweep_policy_events WHERE network_id = ${networkId} AND asset_id = ${assetId} ORDER BY seq DESC LIMIT 1`;
    if (!row) throw new CustodySweepError('custody_sweep.policy_unset', `no sweep policy for ${assetId} on ${networkId}`);
    return row;
  }

  /** Whether the pair's trigger fires now, from credited deposits that have no sweep yet. Reads only. */
  async due(networkId: string, assetId: string): Promise<SweepDueView> {
    const policy = await this.policy(networkId, assetId);
    const [agg] = await this.deps.sql<Array<{ n: number; total: string; last: Date | null }>>`
      SELECT (SELECT count(*)::int FROM pay.custody_deposits d
               WHERE d.network_id = ${networkId} AND d.asset_id = ${assetId} AND d.status = 'credited'
                 AND NOT EXISTS (SELECT 1 FROM pay.custody_sweeps s WHERE s.deposit_id = d.id)) AS n,
             (SELECT COALESCE(SUM(d.amount::numeric), 0)::text FROM pay.custody_deposits d
               WHERE d.network_id = ${networkId} AND d.asset_id = ${assetId} AND d.status = 'credited'
                 AND NOT EXISTS (SELECT 1 FROM pay.custody_sweeps s WHERE s.deposit_id = d.id)) AS total,
             (SELECT MAX(created_at) FROM pay.custody_sweeps WHERE network_id = ${networkId} AND asset_id = ${assetId}) AS last`;
    const n = agg!.n;
    const total = parseAmount(agg!.total);
    let due = false;
    if (n > 0) {
      switch (policy.trigger) {
        case 'immediate':
          due = true;
          break;
        case 'amount':
          due = compare(total, parseAmount(policy.threshold_amount!)) >= 0;
          break;
        case 'count':
          due = n >= policy.threshold_count!;
          break;
        case 'schedule':
          due = agg!.last === null || Date.now() - agg!.last.getTime() >= policy.schedule_minutes! * 60_000;
          break;
      }
    }
    return {
      networkId,
      assetId,
      trigger: policy.trigger,
      due,
      unsweptCount: n,
      unsweptAmount: formatAmount(total),
      lastSweepAt: agg!.last?.toISOString() ?? null,
    };
  }

  /**
   * Write the intent row for one credited deposit. Idempotent on `sweep:<depositId>:treasury`.
   *
   * `custody_sweeps.deposit_id` has no foreign key (the deposit record tables are truncated as a group by their own
   * tests), so this read is the existence check. It runs outside the insert's transaction on purpose: a credited
   * deposit row is never deleted and a credit is never undone into another status by the deposit book except
   * `reversed` (W-deposit-06), and a sweep row moves no customer balance, so a race here can at worst sweep coins that
   * already arrived on chain, never change what a customer holds.
   */
  async create(actor: string, depositId: string): Promise<SweepView> {
    const [dep] = await this.deps.sql<
      Array<{ id: string; network_id: string; asset_id: string; address: string; amount: string; status: string }>
    >`
      SELECT id, network_id, asset_id, address, amount, status FROM pay.custody_deposits WHERE id = ${depositId}`;
    if (!dep) throw new CustodySweepError('custody_sweep.deposit_not_found', `no deposit ${depositId}`);
    const existing = await this.byKey(sweepKey(dep.id));
    if (existing) return sweepView(existing);
    if (dep.status !== 'credited') {
      throw new CustodySweepError(
        'custody_sweep.deposit_not_credited',
        `deposit ${depositId} is ${dep.status}; only a credited deposit is swept`,
      );
    }
    const policy = await this.policy(dep.network_id, dep.asset_id);
    await this.deps.sql`
      INSERT INTO pay.custody_sweeps (idempotency_key, deposit_id, tier, network_id, asset_id, from_address, to_address, amount, created_by)
      VALUES (${sweepKey(dep.id)}, ${dep.id}, ${TIER}, ${dep.network_id}, ${dep.asset_id}, ${dep.address}, ${policy.treasury_address},
              ${dep.amount}, ${actor})
      ON CONFLICT (idempotency_key) DO NOTHING`;
    return sweepView((await this.byKey(sweepKey(dep.id)))!);
  }

  async list(input: { networkId?: string; assetId?: string; limit: number }): Promise<SweepView[]> {
    const rows = await this.deps.sql<SweepRow[]>`
      SELECT * FROM pay.custody_sweeps
       WHERE (${input.networkId ?? null}::text IS NULL OR network_id = ${input.networkId ?? null})
         AND (${input.assetId ?? null}::text IS NULL OR asset_id = ${input.assetId ?? null})
       ORDER BY created_at DESC, id LIMIT ${input.limit}`;
    return rows.map(sweepView);
  }

  /** Ask the rail to send one sweep, always under its original key. */
  async execute(actor: string, sweepId: string): Promise<SweepView> {
    const [row] = await this.deps.sql<SweepRow[]>`SELECT * FROM pay.custody_sweeps WHERE id = ${sweepId}`;
    if (!row) throw new CustodySweepError('custody_sweep.sweep_not_found', `no sweep ${sweepId}`);
    if (row.status === 'broadcast') return sweepView(row);
    const broadcaster = this.deps.broadcaster;
    if (!broadcaster)
      throw new CustodySweepError('rail.crypto', 'Sweeping to treasury needs rail.crypto. It is switched off in this build.');
    const ttl = this.deps.staleAfterSeconds ?? null;
    if (row.status === 'broadcasting') {
      if (ttl === null) {
        throw new CustodySweepError(
          'custody_sweep.stale_ttl_unset',
          'this sweep is marked as being sent; taking over a stalled send needs the owner-set stale time, which is not set',
        );
      }
      if (Date.now() - row.updated_at.getTime() < ttl * 1000) {
        throw new CustodySweepError('custody_sweep.in_flight', 'this sweep is being sent; its outcome is read back with the same key');
      }
    }
    // Conditional claim to a transitional status: of two concurrent calls only one moves the row and asks the rail.
    // A row stuck in `broadcasting` past the owner-set stale time (a crash after the claim) is taken over and re-sent
    // under its original key, which the rail treats as the same send.
    const [claimed] = await this.deps.sql<SweepRow[]>`
      UPDATE pay.custody_sweeps SET status = 'broadcasting', attempts = attempts + 1, last_executed_by = ${actor}, updated_at = now()
       WHERE id = ${sweepId}
         AND (status IN ('pending', 'failed', 'unknown')
              OR (status = 'broadcasting' AND ${ttl}::int IS NOT NULL AND updated_at < now() - make_interval(secs => ${ttl}::int)))
       RETURNING *`;
    if (!claimed) {
      const now = await this.byId(sweepId);
      if (now.status === 'broadcast') return sweepView(now);
      throw new CustodySweepError('custody_sweep.in_flight', 'this sweep is being sent; its outcome is read back with the same key');
    }
    let result: SweepBroadcastResult;
    try {
      result = await broadcaster.send({
        idempotencyKey: claimed.idempotency_key,
        networkId: claimed.network_id,
        assetId: claimed.asset_id,
        fromAddress: claimed.from_address,
        toAddress: claimed.to_address,
        amount: decimal(claimed.amount),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [unknown] = await this.deps.sql<SweepRow[]>`
        UPDATE pay.custody_sweeps SET status = 'unknown', last_error = ${`unknown: ${message}`.slice(0, 500)}, updated_at = now()
         WHERE id = ${sweepId} AND status = 'broadcasting' RETURNING *`;
      return sweepView(unknown ?? (await this.byId(sweepId)));
    }
    const [done] =
      result.state === 'broadcast'
        ? await this.deps.sql<SweepRow[]>`
            UPDATE pay.custody_sweeps SET status = 'broadcast', tx_hash = ${result.txHash}, last_error = NULL, updated_at = now()
             WHERE id = ${sweepId} AND status = 'broadcasting' RETURNING *`
        : await this.deps.sql<SweepRow[]>`
            UPDATE pay.custody_sweeps SET status = 'failed', last_error = ${result.error.slice(0, 500)}, updated_at = now()
             WHERE id = ${sweepId} AND status = 'broadcasting' RETURNING *`;
    return sweepView(done ?? (await this.byId(sweepId)));
  }

  private async byKey(key: string): Promise<SweepRow | undefined> {
    const [row] = await this.deps.sql<SweepRow[]>`SELECT * FROM pay.custody_sweeps WHERE idempotency_key = ${key}`;
    return row;
  }

  private async byId(id: string): Promise<SweepRow> {
    const [row] = await this.deps.sql<SweepRow[]>`SELECT * FROM pay.custody_sweeps WHERE id = ${id}`;
    return row!;
  }
}

/** Reads PAY_CUSTODY_SWEEP_STALE_SECONDS. Blank = not set (null, a stalled send refuses); not a positive integer = boot error. */
export function loadSweepStaleAfterSeconds(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = (env.PAY_CUSTODY_SWEEP_STALE_SECONDS ?? '').trim();
  if (raw === '') return null;
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error('PAY_CUSTODY_SWEEP_STALE_SECONDS must be a positive whole number of seconds');
  return Number(raw);
}
