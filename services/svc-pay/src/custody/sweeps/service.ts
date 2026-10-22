import { compare, formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { CustodySweepError } from './errors.js';
import type { SweepDueView, SweepPolicySetInput, SweepPolicyView, SweepView } from './schemas.js';

/**
 * Sweeps from customer deposit addresses to the treasury address (W-custody-ops-05).
 *
 * CUSTODY SIDE ONLY. A sweep moves coins between our own addresses. It never posts to the ledger and never changes a
 * customer balance (ENGINE D-5): the customer was credited by the `deposit` post when the deposit was recorded
 * (W-deposit-05), and that stands whether a sweep succeeds, fails or is never made.
 *
 * OWNER-SET, BLANK REFUSES. The trigger and the treasury address are set per (network, asset) by a founder; a pair with
 * no policy refuses every sweep and every due check. Each trigger needs its own figure (amount, count, minutes) and
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
  created_at: Date;
  updated_at: Date;
}

const policyView = (r: PolicyRow): SweepPolicyView => ({
  networkId: r.network_id,
  assetId: r.asset_id,
  trigger: r.trigger,
  thresholdAmount: r.threshold_amount,
  thresholdCount: r.threshold_count,
  scheduleMinutes: r.schedule_minutes,
  treasuryAddress: r.treasury_address,
  reason: r.reason,
  setBy: r.set_by,
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
  amount: r.amount,
  status: r.status,
  txHash: r.tx_hash,
  attempts: r.attempts,
  lastError: r.last_error,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

function invalid(message: string): never {
  throw new CustodySweepError('custody_sweep.policy_invalid', message);
}

export class CustodySweepService {
  constructor(private readonly deps: { readonly sql: Sql; readonly broadcaster?: SweepBroadcaster }) {}

  async setPolicy(actor: string, input: SweepPolicySetInput): Promise<SweepPolicyView> {
    const address = input.treasuryAddress.trim();
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
    const [row] = await this.deps.sql<PolicyRow[]>`
      INSERT INTO pay.custody_sweep_policy_events
        (network_id, asset_id, trigger, threshold_amount, threshold_count, schedule_minutes, treasury_address, reason, set_by)
      VALUES (${input.networkId}, ${input.assetId}, ${input.trigger}, ${amount},
              ${input.trigger === 'count' ? input.thresholdCount : null}, ${input.trigger === 'schedule' ? input.scheduleMinutes : null},
              ${address}, ${input.reason}, ${actor})
      RETURNING *`;
    return policyView(row!);
  }

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

  /** Write the intent row for one credited deposit. Idempotent on `sweep:<depositId>:treasury`. */
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
  async execute(sweepId: string): Promise<SweepView> {
    const [row] = await this.deps.sql<SweepRow[]>`SELECT * FROM pay.custody_sweeps WHERE id = ${sweepId}`;
    if (!row) throw new CustodySweepError('custody_sweep.sweep_not_found', `no sweep ${sweepId}`);
    if (row.status === 'broadcast') return sweepView(row);
    const broadcaster = this.deps.broadcaster;
    if (!broadcaster)
      throw new CustodySweepError('rail.crypto', 'Sweeping to treasury needs rail.crypto. It is switched off in this build.');
    await this.deps
      .sql`UPDATE pay.custody_sweeps SET attempts = attempts + 1, updated_at = now() WHERE id = ${sweepId} AND status <> 'broadcast'`;
    let result: SweepBroadcastResult;
    try {
      result = await broadcaster.send({
        idempotencyKey: row.idempotency_key,
        networkId: row.network_id,
        assetId: row.asset_id,
        fromAddress: row.from_address,
        toAddress: row.to_address,
        amount: row.amount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [unknown] = await this.deps.sql<SweepRow[]>`
        UPDATE pay.custody_sweeps SET status = 'unknown', last_error = ${`unknown: ${message}`.slice(0, 500)}, updated_at = now()
         WHERE id = ${sweepId} AND status <> 'broadcast' RETURNING *`;
      return sweepView(unknown ?? (await this.byId(sweepId)));
    }
    const [done] =
      result.state === 'broadcast'
        ? await this.deps.sql<SweepRow[]>`
            UPDATE pay.custody_sweeps SET status = 'broadcast', tx_hash = ${result.txHash}, last_error = NULL, updated_at = now()
             WHERE id = ${sweepId} AND status <> 'broadcast' RETURNING *`
        : await this.deps.sql<SweepRow[]>`
            UPDATE pay.custody_sweeps SET status = 'failed', last_error = ${result.error.slice(0, 500)}, updated_at = now()
             WHERE id = ${sweepId} AND status <> 'broadcast' RETURNING *`;
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
