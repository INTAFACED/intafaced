import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  DIVIDEND_OWNER_QUESTION,
  type CampaignDistribution,
  type CampaignState,
  type DistributionKind,
  type DistributionRecord,
  type DistributionRun,
  type DistributionsMine,
} from '@intafaced/contracts/campaigns-catalogue';
import type { DistributionPlan } from '@intafaced/contracts/campaigns-payout-board';
import { CampaignsError } from './codes.js';
import { effectiveState } from './campaigns.js';
import type { PayoutSaga } from './payouts.js';
import { drawnOf } from './tasks.js';
import type { EquitySource } from './venue-equity.js';

/**
 * Airdrop distributions (CM-airdrop-campaigns-01, J-campaigns-13 #1 to #3). A `distribution` campaign of kind `airdrop`
 * pays its pool, the campaign's budget (INTAFACED's own money), to the accounts that joined it by its snapshot time, each
 * its share of the pool by its venue equity at the snapshot. A `dividend` waits for the owner's decision (OWNER 87): it
 * never goes live, and listing dividends refuses `owner.decision` naming the question.
 *
 * The run, once the snapshot time has passed (each pass of `tick`, or an operator's `run`):
 *
 * 1. The run row is written once (`distribution_runs`, by campaign), with the pool and the snapshot time.
 * 2. Each account that joined by the snapshot is read from the venue once (`distribution_standings`, by campaign and
 *    account): `counted` with its equity, `excluded_negative` when the equity is below zero, or `unread` with the code
 *    when the venue did not answer. An unread account is read again on later passes until `READ_GRACE_MS` after the
 *    run began reading (never before the snapshot); then it is `held_out`: named, out of the total, owed nothing from this run, never counted as zero.
 * 3. Once no account is waiting, every share is written in one transaction with the campaign locked: the pool in the
 *    token's smallest payable unit, times each counted account's equity over the total equity counted, rounded down,
 *    and the units left by rounding given one each to the largest remainders (ties to the lower account id), so the
 *    shares sum exactly to the pool. Each share above zero is a reward intent `distribution:<campaign>:<account>`, and the
 *    run is marked `owed` in that same transaction.
 * 4. After the commit each share is owed by the reward saga and paid once to the account's connected wallet by the
 *    reward payer, which books it with the chain transaction that paid it.
 *
 * A run killed part way resumes from what it kept: an account already read is never read again, and a share already
 * written is never written again (the run's state and the intent's unique key), so nobody is owed or paid twice.
 */

type Sql = postgres.Sql;

/** How long after the snapshot an account the venue did not answer for is read again before it is held out. */
export const READ_GRACE_MS = 10 * 60_000;

export const distributionKeyOf = (campaignId: string, accountId: string) => `distribution:${campaignId}:${accountId}`;
const PERIOD = 'distribution';

type DistributionRow = {
  id: string;
  name: string;
  type: string;
  state: CampaignState;
  starts_at: Date | null;
  ends_at: Date | null;
  budget_asset: string | null;
  budget_limit: string | null;
  distribution: CampaignDistribution | null;
};

type RunRow = {
  campaign_id: string;
  snapshot_at: Date;
  asset: string;
  equity_asset: string;
  pool: string;
  state: 'reading' | 'owed';
  total_equity: string | null;
  shares_total: string | null;
  started_at: Date;
};

type StandingRow = {
  account_id: string;
  standing: 'counted' | 'excluded_negative' | 'held_out' | 'unread';
  equity: string | null;
  as_of: Date | null;
  reason: string | null;
  share: string | null;
  reward_key: string | null;
};

const LIVE_STATES: readonly CampaignState[] = ['active', 'paused', 'ended', 'closed'];

/**
 * Splits `pool` (in units of `unit`) by `weights`, each share rounded down to a whole unit, the units left over going one
 * each to the largest remainders, ties to the earlier key. The shares sum exactly to the pool; with no weight, none.
 */
export function splitPool(pool: bigint, unit: bigint, weights: readonly { key: string; weight: bigint }[]): Map<string, bigint> {
  if (pool % unit !== 0n) throw new CampaignsError('campaigns.distribution_invalid', 'The pool is not a whole number of payable units');
  const units = pool / unit;
  const total = weights.reduce((n, w) => n + w.weight, 0n);
  const out = new Map<string, bigint>();
  if (total === 0n) return out;
  const parts = weights.map((w) => ({ key: w.key, q: (units * w.weight) / total, r: (units * w.weight) % total }));
  let left = units - parts.reduce((n, p) => n + p.q, 0n);
  const order = [...parts].sort((a, b) => (a.r === b.r ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.r > b.r ? -1 : 1));
  for (const p of order) {
    if (left === 0n) break;
    p.q += 1n;
    left -= 1n;
  }
  for (const p of parts) out.set(p.key, p.q * unit);
  return out;
}

export interface DistributionServiceOptions {
  sql: Sql;
  saga: PayoutSaga | null;
  equity: EquitySource | null;
  /** Notes the connected wallet on the person's open USDC rewards that have none (TaskService.recordPayTo). */
  payTo?: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  /** The decimals of the token shares are paid in (the reward payer's); 18 when unset. */
  payDecimals?: number | null;
  readGraceMs?: number;
  now?: () => Date;
  log?: (msg: string, detail: Record<string, unknown>) => void;
}

export class DistributionService {
  private readonly sql: Sql;
  private readonly saga: PayoutSaga | null;
  private readonly equity: EquitySource | null;
  private readonly payTo: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  private readonly unit: bigint;
  private readonly readGraceMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail: Record<string, unknown>) => void;

  constructor(options: DistributionServiceOptions) {
    this.sql = options.sql;
    this.saga = options.saga;
    this.equity = options.equity;
    this.payTo = options.payTo ?? (async () => false);
    this.unit = 10n ** BigInt(18 - (options.payDecimals ?? 18));
    this.readGraceMs = options.readGraceMs ?? READ_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  private async row(campaignId: string): Promise<DistributionRow> {
    const [row] = await this.sql<DistributionRow[]>`
      SELECT id, name, type, state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, distribution
      FROM campaigns.campaigns WHERE id = ${campaignId}`;
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.state)) {
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    }
    if (row.type !== 'distribution') throw new CampaignsError('campaigns.not_distribution', 'This campaign is not a distribution');
    if (row.distribution?.kind === 'dividend') throw new CampaignsError('owner.decision', DIVIDEND_OWNER_QUESTION);
    return row;
  }

  private terms(row: DistributionRow): { snapshotAt: Date; equityAsset: string; asset: string; pool: string } {
    const d = row.distribution;
    if (!d?.snapshotAt || !d.equityAsset || !row.budget_asset || row.budget_limit === null) {
      throw new CampaignsError('campaigns.distribution_unset', 'This distribution is missing its terms');
    }
    return { snapshotAt: new Date(d.snapshotAt), equityAsset: d.equityAsset, asset: row.budget_asset, pool: row.budget_limit };
  }

  private async runRow(campaignId: string): Promise<RunRow | null> {
    const [run] = await this.sql<RunRow[]>`
      SELECT campaign_id, snapshot_at, asset, equity_asset, pool::text AS pool, state, total_equity::text AS total_equity,
        shares_total::text AS shares_total, started_at
      FROM campaigns.distribution_runs WHERE campaign_id = ${campaignId}`;
    return run ?? null;
  }

  private standings(campaignId: string): Promise<StandingRow[]> {
    return this.sql<StandingRow[]>`
      SELECT account_id, standing, equity::text AS equity, as_of, reason, share::text AS share, reward_key
      FROM campaigns.distribution_standings WHERE campaign_id = ${campaignId} ORDER BY account_id`;
  }

  /** Reads one account's equity and keeps its standing; an account already read is left as it is. */
  private async readAccount(run: RunRow, accountId: string): Promise<void> {
    const answer = this.equity ? await this.equity.equity(accountId, run.equity_asset) : { unread: 'campaigns.equity_unread' };
    if ('unread' in answer) {
      await this.sql`
        INSERT INTO campaigns.distribution_standings (campaign_id, account_id, standing, reason)
        VALUES (${run.campaign_id}, ${accountId}, 'unread', ${answer.unread})
        ON CONFLICT (campaign_id, account_id) DO UPDATE
          SET reason = EXCLUDED.reason, attempts = campaigns.distribution_standings.attempts + 1, updated_at = now()
          WHERE campaigns.distribution_standings.standing = 'unread'`;
      return;
    }
    const equity = parseAmount(answer.equity);
    const standing = equity < 0n ? 'excluded_negative' : 'counted';
    await this.sql`
      INSERT INTO campaigns.distribution_standings (campaign_id, account_id, standing, equity, as_of, reason)
      VALUES (${run.campaign_id}, ${accountId}, ${standing}, ${formatAmount(equity)}, ${new Date(answer.asOf)}, NULL)
      ON CONFLICT (campaign_id, account_id) DO UPDATE
        SET standing = EXCLUDED.standing, equity = EXCLUDED.equity, as_of = EXCLUDED.as_of, reason = NULL,
          attempts = campaigns.distribution_standings.attempts + 1, updated_at = now()
        WHERE campaigns.distribution_standings.standing = 'unread'`;
  }

  /**
   * Takes the snapshot, or resumes it: reads every account not read yet, and once none is waiting writes every share in
   * one transaction. Returns the run as it stands. Refuses `campaigns.snapshot_not_due` before the snapshot time.
   */
  async run(campaignId: string, by?: { actor: string; reason: string }): Promise<DistributionRun> {
    const row = await this.row(campaignId);
    if (by) {
      await this.sql`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${by.actor}, 'campaign.distribution.run_requested', ${row.id}, ${this.sql.json({ reason: by.reason })})`;
    }
    const terms = this.terms(row);
    const now = this.now();
    if (!LIVE_STATES.includes(effectiveState(row, now))) throw new CampaignsError('campaign.unknown', 'No such campaign');
    if (now < terms.snapshotAt) throw new CampaignsError('campaigns.snapshot_not_due', 'The snapshot time has not come yet');
    await this.sql`
      INSERT INTO campaigns.distribution_runs (campaign_id, snapshot_at, asset, equity_asset, pool)
      VALUES (${row.id}, ${terms.snapshotAt}, ${terms.asset}, ${terms.equityAsset}, ${terms.pool})
      ON CONFLICT (campaign_id) DO NOTHING`;
    let run = (await this.runRow(row.id))!;
    if (run.state === 'reading') {
      const joined = await this.sql<{ account_id: string }[]>`
        SELECT account_id FROM campaigns.participations
        WHERE campaign_id = ${row.id} AND created_at <= ${run.snapshot_at} ORDER BY account_id`;
      const kept = new Map((await this.standings(row.id)).map((s) => [s.account_id, s.standing]));
      for (const { account_id } of joined) {
        const standing = kept.get(account_id);
        if (standing === undefined || standing === 'unread') await this.readAccount(run, account_id);
      }
      const waiting = (await this.standings(row.id)).filter((s) => s.standing === 'unread');
      // The wait runs from when the run began reading, which is never before the snapshot time.
      if (waiting.length > 0 && now.getTime() < run.started_at.getTime() + this.readGraceMs) return this.summary(run);
      const keys = await this.owe(row, run);
      for (const key of keys) await this.attemptOwe(key);
      run = (await this.runRow(row.id))!;
    }
    return this.summary(run);
  }

  /** Writes every share and marks the run owed, in one transaction; returns the keys written (none when already owed). */
  private owe(row: DistributionRow, run: RunRow): Promise<string[]> {
    return transaction(this.sql, async (tx) => {
      await tx`SELECT 1 FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      const [again] = await tx<{ state: string }[]>`
        SELECT state FROM campaigns.distribution_runs WHERE campaign_id = ${row.id} FOR UPDATE`;
      if (again?.state !== 'reading') return [];
      await tx`
        UPDATE campaigns.distribution_standings SET standing = 'held_out', updated_at = now()
        WHERE campaign_id = ${row.id} AND standing = 'unread'`;
      const counted = await tx<{ account_id: string; equity: string }[]>`
        SELECT account_id, equity::text AS equity FROM campaigns.distribution_standings
        WHERE campaign_id = ${row.id} AND standing = 'counted' ORDER BY account_id`;
      const weights = counted.map((c) => ({ key: c.account_id, weight: parseAmount(c.equity) }));
      const totalEquity = weights.reduce((n, w) => n + w.weight, 0n);
      const pool = parseAmount(run.pool);
      const shares = splitPool(pool, this.unit, weights);
      const sharesTotal = [...shares.values()].reduce((n, s) => n + s, 0n);
      if ((await drawnOf(tx, row.id)) + sharesTotal > parseAmount(row.budget_limit!)) {
        throw new CampaignsError('campaigns.budget_exhausted', 'This distribution’s pool has no room for its shares');
      }
      const keys: string[] = [];
      for (const c of counted) {
        const share = shares.get(c.account_id) ?? 0n;
        const key = share > 0n ? distributionKeyOf(row.id, c.account_id) : null;
        if (key) {
          await tx`
            INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
            VALUES (${key}, ${row.id}, ${c.account_id}, ${PERIOD}, ${run.asset}, ${formatAmount(share)}, 'qualified', 'paid')`;
          await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${key}, 'qualified')`;
          keys.push(key);
        }
        await tx`
          UPDATE campaigns.distribution_standings SET share = ${formatAmount(share)}, reward_key = ${key}, updated_at = now()
          WHERE campaign_id = ${row.id} AND account_id = ${c.account_id}`;
      }
      await tx`
        UPDATE campaigns.distribution_runs
        SET state = 'owed', total_equity = ${formatAmount(totalEquity)}, shares_total = ${formatAmount(sharesTotal)}, owed_at = now()
        WHERE campaign_id = ${row.id}`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES ('svc-campaigns', 'campaign.distribution.owe', ${row.id},
          ${tx.json({ shares: keys.length, sharesTotal: formatAmount(sharesTotal), totalEquity: formatAmount(totalEquity) })})`;
      return keys;
    });
  }

  private async attemptOwe(key: string): Promise<void> {
    if (!this.saga) return;
    try {
      await this.saga.attempt(key);
    } catch (err) {
      this.log('campaigns.distribution.owe_failed', { key, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async summary(run: RunRow): Promise<DistributionRun> {
    const standings = await this.standings(run.campaign_id);
    const count = (s: StandingRow['standing']) => standings.filter((x) => x.standing === s).length;
    return {
      campaignId: run.campaign_id,
      snapshotAt: run.snapshot_at.toISOString(),
      state: run.state,
      pool: formatAmount(parseAmount(run.pool)),
      totalEquity: run.total_equity === null ? null : formatAmount(parseAmount(run.total_equity)),
      counted: count('counted'),
      excludedNegative: count('excluded_negative'),
      heldOut: count('held_out') + count('unread'),
      sharesTotal: run.shares_total === null ? null : formatAmount(parseAmount(run.shares_total)),
    };
  }

  /**
   * The operator's view of one airdrop's plan (J-campaigns-19 #5 #6): the run as it stands and every account at its
   * snapshot (counted with its equity and share, excluded for a negative equity, or named and held out with the venue's
   * code), each share's reward state and, once paid, its chain transaction. Before the run starts it is `not_started`
   * with no accounts. Read only.
   */
  async plan(campaignId: string): Promise<DistributionPlan> {
    const row = await this.row(campaignId);
    const run = await this.runRow(row.id);
    if (!run) {
      return {
        campaignId: row.id,
        campaignName: row.name,
        snapshotAt: null,
        state: 'not_started',
        asset: row.budget_asset,
        pool: row.budget_limit === null ? null : formatAmount(parseAmount(row.budget_limit)),
        totalEquity: null,
        sharesTotal: null,
        accounts: [],
      };
    }
    const accounts = await this.sql<
      (StandingRow & {
        reward_state: DistributionPlan['accounts'][number]['rewardState'];
        chain_tx: string | null;
        to_wallet: string | null;
      })[]
    >`
      SELECT s.account_id, s.standing, s.equity::text AS equity, s.as_of, s.reason, s.share::text AS share, s.reward_key,
        i.state AS reward_state, pay.chain_tx, pay.to_wallet
      FROM campaigns.distribution_standings s
      LEFT JOIN campaigns.reward_intents i ON i.reward_key = s.reward_key
      LEFT JOIN campaigns.reward_payments pay ON pay.reward_key = s.reward_key AND pay.state = 'booked'
      WHERE s.campaign_id = ${row.id} ORDER BY s.account_id`;
    return {
      campaignId: row.id,
      campaignName: row.name,
      snapshotAt: run.snapshot_at.toISOString(),
      state: run.state,
      asset: run.asset,
      pool: formatAmount(parseAmount(run.pool)),
      totalEquity: run.total_equity === null ? null : formatAmount(parseAmount(run.total_equity)),
      sharesTotal: run.shares_total === null ? null : formatAmount(parseAmount(run.shares_total)),
      accounts: accounts.map((a) => ({
        accountId: a.account_id,
        // An account not answered yet is waiting while the run reads; once the run is owed it was held out.
        standing: a.standing === 'unread' ? (run.state === 'owed' ? 'held_out' : 'waiting') : a.standing,
        equity: a.equity === null ? null : formatAmount(parseAmount(a.equity)),
        equityAsOf: a.as_of ? a.as_of.toISOString() : null,
        reason: a.reason,
        share: a.share === null ? null : formatAmount(parseAmount(a.share)),
        rewardKey: a.reward_key,
        rewardState: a.reward_state ?? null,
        chainTx: a.chain_tx,
        toWallet: a.to_wallet,
      })),
    };
  }

  /** One pass over every airdrop whose snapshot time has passed and whose run is not owed. One failing never stops the others. */
  async tick(): Promise<void> {
    const now = this.now();
    const rows = await this.sql<{ id: string }[]>`
      SELECT c.id FROM campaigns.campaigns c
      WHERE c.type = 'distribution' AND c.state IN ('active', 'paused', 'ended', 'closed')
        AND c.distribution->>'kind' = 'airdrop' AND (c.distribution->>'snapshotAt')::timestamptz <= ${now}
        AND NOT EXISTS (SELECT 1 FROM campaigns.distribution_runs r WHERE r.campaign_id = c.id AND r.state = 'owed')
      ORDER BY c.id LIMIT 100`;
    for (const { id } of rows) {
      try {
        await this.run(id);
      } catch (err) {
        this.log('campaigns.distribution.tick_failed', { campaignId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * The caller's own distributions, newest snapshot first: each airdrop they joined, how they stood at its snapshot, their
   * share and, once paid, the chain transaction that paid it. Dividends refuse `owner.decision` naming the question. In
   * the caller's own request their connected wallet is noted on their open shares, which are paid to it.
   */
  async mine(input: { accountId: string; kind: DistributionKind; forwarded?: Record<string, string> }): Promise<DistributionsMine> {
    if (input.kind === 'dividend') throw new CampaignsError('owner.decision', DIVIDEND_OWNER_QUESTION);
    await this.payTo(input.accountId, input.forwarded ?? {});
    const rows = await this.sql<
      {
        campaign_id: string;
        name: string;
        budget_asset: string;
        budget_limit: string;
        distribution: CampaignDistribution;
        run_state: string | null;
        standing: StandingRow['standing'] | null;
        equity: string | null;
        as_of: Date | null;
        reason: string | null;
        share: string | null;
        reward_key: string | null;
        intent_state: string | null;
        chain_tx: string | null;
        to_wallet: string | null;
      }[]
    >`
      SELECT c.id AS campaign_id, c.name, c.budget_asset, c.budget_limit::text AS budget_limit, c.distribution,
        r.state AS run_state, s.standing, s.equity::text AS equity, s.as_of, s.reason, s.share::text AS share, s.reward_key,
        i.state AS intent_state, pay.chain_tx, pay.to_wallet
      FROM campaigns.participations p
      JOIN campaigns.campaigns c ON c.id = p.campaign_id
      LEFT JOIN campaigns.distribution_runs r ON r.campaign_id = c.id
      LEFT JOIN campaigns.distribution_standings s ON s.campaign_id = c.id AND s.account_id = p.account_id
      LEFT JOIN campaigns.reward_intents i ON i.reward_key = s.reward_key
      LEFT JOIN campaigns.reward_payments pay ON pay.reward_key = s.reward_key AND pay.state = 'booked'
      WHERE p.account_id = ${input.accountId} AND c.type = 'distribution' AND c.distribution->>'kind' = 'airdrop'
        AND c.state NOT IN ('draft', 'pending_approval', 'approved')
        AND p.created_at <= (c.distribution->>'snapshotAt')::timestamptz
      ORDER BY (c.distribution->>'snapshotAt')::timestamptz DESC, c.id`;
    const records: DistributionRecord[] = rows.map((r) => {
      // An account still being read, or a run not owed yet, shows as waiting; an unread one past the run shows held out.
      const standing: DistributionRecord['standing'] =
        r.standing === null || (r.standing === 'unread' && r.run_state !== 'owed')
          ? 'waiting'
          : r.standing === 'unread'
            ? 'held_out'
            : r.standing;
      return {
        campaignId: r.campaign_id,
        campaignName: r.name,
        kind: 'airdrop',
        snapshotAt: new Date(r.distribution.snapshotAt!).toISOString(),
        asset: r.budget_asset,
        pool: formatAmount(parseAmount(r.budget_limit)),
        standing: r.run_state === 'owed' || standing !== 'counted' ? standing : 'waiting',
        equity: r.equity === null ? null : formatAmount(parseAmount(r.equity)),
        equityAsset: r.distribution.equityAsset!,
        equityAsOf: r.as_of ? r.as_of.toISOString() : null,
        heldOut: standing === 'held_out' ? (r.reason ?? 'campaigns.equity_unread') : null,
        share: r.share === null ? null : formatAmount(parseAmount(r.share)),
        rewardKey: r.reward_key,
        state: r.intent_state,
        chainTx: r.chain_tx,
        toWallet: r.to_wallet,
      };
    });
    return { records };
  }
}
