import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { CampaignPool, CampaignState, PoolBoard, PoolDay } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { effectiveState } from './campaigns.js';
import type { CompetitionFillSource } from './competitions.js';
import type { PayoutSaga } from './payouts.js';
import { drawnOf } from './tasks.js';
import type { EquitySource } from './venue-equity.js';

/**
 * Reward pools paying daily (CM-airdrop-campaigns-02, J-campaigns-13 #4 #5). A `pool` campaign pays its pool, the
 * campaign's budget (INTAFACED's own money), one day's slice at a time to the accounts that joined it.
 *
 * - A day: day n runs from the campaign's start plus (n - 1) times `daySeconds` for `daySeconds`, the last one cut at
 *   the campaign's end.
 * - Settling a day, once it has ended and `SETTLE_AFTER_MS` more has passed (so a fill the venue reports late counts):
 *   each entrant who joined before the day ended is read from the venue: their activity is the notional, in the pool's
 *   activity asset, of the venue's fills of their orders placed through INTAFACED (our builder fee above zero) during
 *   the day and after they joined; their balance is their venue equity in that asset. An entrant whose balance is below
 *   the minimum earns nothing that day and is left out of the total. While any entrant is unread the day is not settled
 *   and waits (`campaigns.fills_unread`, `campaigns.equity_unread`): an unread entrant is never counted as no activity.
 * - Each share is the day's slice times the entrant's activity over the total, rounded down to the token's smallest
 *   payable unit, up to the per-user cap; what rounding and the cap keep back stays in the pool. The slice is the daily
 *   slice, or what is left of the budget when that is less. Shares plus the remainder equal the slice (checked by the
 *   table).
 * - The day, every entrant's line and every share above zero (a reward intent `pool:<campaign>:<day>:<account>`) are
 *   written in one transaction with the campaign locked. Settling the day again finds it and writes nothing, so each
 *   share is owed once; the reward saga owes it and the reward payer pays it once to the connected wallet, booked with
 *   the chain transaction that paid it.
 */

type Sql = postgres.Sql;

/** How long after a day ends it waits before it is settled, so a fill the venue reports late still counts. */
export const SETTLE_AFTER_MS = 15_000;
/** The most days one board lists, newest first. */
const BOARD_DAYS = 60;

export const poolKeyOf = (campaignId: string, day: number, accountId: string) => `pool:${campaignId}:${day}:${accountId}`;

type PoolRow = {
  id: string;
  type: string;
  state: CampaignState;
  starts_at: Date | null;
  ends_at: Date | null;
  budget_asset: string | null;
  budget_limit: string | null;
  pool: CampaignPool | null;
};

type Terms = {
  activityAsset: string;
  dailySlice: bigint;
  perUserCap: bigint;
  minBalance: bigint;
  daySeconds: number;
  startsAt: Date;
  endsAt: Date;
};

type DayRow = {
  day: number;
  starts_at: Date;
  ends_at: Date;
  slice: string;
  total_activity: string;
  shares_total: string;
  remainder: string;
  settled_at: Date;
};

const LIVE_STATES: readonly CampaignState[] = ['active', 'paused', 'ended', 'closed'];

const amount = (n: bigint) => formatAmount(n);

export interface PoolServiceOptions {
  sql: Sql;
  saga: PayoutSaga | null;
  fills: CompetitionFillSource | null;
  equity: EquitySource | null;
  payTo?: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  /** The decimals of the token shares are paid in (the reward payer's); 18 when unset. */
  payDecimals?: number | null;
  now?: () => Date;
  log?: (msg: string, detail: Record<string, unknown>) => void;
}

export class PoolService {
  private readonly sql: Sql;
  private readonly saga: PayoutSaga | null;
  private readonly fills: CompetitionFillSource | null;
  private readonly equity: EquitySource | null;
  private readonly payTo: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  private readonly unit: bigint;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail: Record<string, unknown>) => void;

  constructor(options: PoolServiceOptions) {
    this.sql = options.sql;
    this.saga = options.saga;
    this.fills = options.fills;
    this.equity = options.equity;
    this.payTo = options.payTo ?? (async () => false);
    this.unit = 10n ** BigInt(18 - (options.payDecimals ?? 18));
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  private async row(campaignId: string): Promise<PoolRow> {
    const [row] = await this.sql<PoolRow[]>`
      SELECT id, type, state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, pool
      FROM campaigns.campaigns WHERE id = ${campaignId}`;
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.state)) {
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    }
    if (row.type !== 'pool') throw new CampaignsError('campaigns.not_pool', 'This campaign is not a reward pool');
    return row;
  }

  /** The terms a live pool must have (the activation gate made sure); a row without them refuses. */
  private terms(row: PoolRow): Terms {
    const p = row.pool;
    if (
      !p ||
      !p.activityAsset ||
      p.dailySlice === null ||
      p.perUserCap === null ||
      p.minBalance === null ||
      p.daySeconds === null ||
      !row.starts_at ||
      !row.ends_at ||
      !row.budget_asset ||
      row.budget_limit === null
    ) {
      throw new CampaignsError('campaigns.pool_unset', 'This reward pool is missing its terms');
    }
    return {
      activityAsset: p.activityAsset,
      dailySlice: parseAmount(p.dailySlice),
      perUserCap: parseAmount(p.perUserCap),
      minBalance: parseAmount(p.minBalance),
      daySeconds: p.daySeconds,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  /** Day n's window, or null past the campaign's end. */
  private window(terms: Terms, day: number): { startsAt: Date; endsAt: Date } | null {
    const length = terms.daySeconds * 1000;
    const startsAt = new Date(terms.startsAt.getTime() + (day - 1) * length);
    if (startsAt >= terms.endsAt) return null;
    const endsAt = new Date(Math.min(startsAt.getTime() + length, terms.endsAt.getTime()));
    return { startsAt, endsAt };
  }

  /** The days that have started by `at`, oldest first. */
  private started(terms: Terms, at: Date): number[] {
    const out: number[] = [];
    for (let day = 1; ; day += 1) {
      const w = this.window(terms, day);
      if (!w || w.startsAt > at) return out;
      out.push(day);
    }
  }

  private async dayRow(campaignId: string, day: number): Promise<DayRow | null> {
    const [d] = await this.sql<DayRow[]>`
      SELECT day, starts_at, ends_at, slice::text AS slice, total_activity::text AS total_activity,
        shares_total::text AS shares_total, remainder::text AS remainder, settled_at
      FROM campaigns.pool_days WHERE campaign_id = ${campaignId} AND day = ${day}`;
    return d ?? null;
  }

  private dayOf(d: DayRow): Omit<PoolDay, 'mine'> {
    return {
      day: d.day,
      startsAt: d.starts_at.toISOString(),
      endsAt: d.ends_at.toISOString(),
      settledAt: d.settled_at.toISOString(),
      slice: amount(parseAmount(d.slice)),
      totalActivity: amount(parseAmount(d.total_activity)),
      sharesTotal: amount(parseAmount(d.shares_total)),
      remainder: amount(parseAmount(d.remainder)),
    };
  }

  /** One entrant's activity in the day (from the venue's fills) and venue equity; throws the code when either is unread. */
  private async readEntrant(
    terms: Terms,
    w: { startsAt: Date; endsAt: Date },
    entrant: { account_id: string; joined_at: Date },
  ): Promise<{ activity: bigint; balance: bigint; balanceAsOf: Date }> {
    const since = entrant.joined_at > w.startsAt ? entrant.joined_at : w.startsAt;
    const fills = this.fills ? await this.fills.ourFills(entrant.account_id, since) : { unread: 'campaigns.fills_unread' };
    if ('unread' in fills) throw new CampaignsError('campaigns.fills_unread', `Activity could not be read (${fills.unread})`);
    const seen = new Set<string>();
    let activity = 0n;
    for (const f of fills.fills) {
      const at = new Date(f.filledAt);
      const key = `${f.venueAccount}#${f.fillId}`;
      if (f.quoteAsset !== terms.activityAsset || at < since || at >= w.endsAt || seen.has(key)) continue;
      if (parseAmount(f.notional) <= 0n || parseAmount(f.builderFee) <= 0n) continue;
      seen.add(key);
      activity += parseAmount(f.notional);
    }
    const eq = this.equity ? await this.equity.equity(entrant.account_id, terms.activityAsset) : { unread: 'campaigns.equity_unread' };
    if ('unread' in eq) throw new CampaignsError('campaigns.equity_unread', `The venue balance could not be read (${eq.unread})`);
    return { activity, balance: parseAmount(eq.equity), balanceAsOf: new Date(eq.asOf) };
  }

  /**
   * Settles one ended day once. Returns `settled: true` when this call wrote it; settling it again returns the day as it
   * was settled and writes nothing. Refuses `campaigns.pool_day_open` before the day has ended (and the short wait after),
   * `campaigns.pool_day_unknown` for a day past the end, and the unread code while an entrant could not be read.
   */
  async settle(
    campaignId: string,
    day: number,
    by?: { actor: string; reason: string },
  ): Promise<{ settled: boolean; day: Omit<PoolDay, 'mine'> }> {
    const row = await this.row(campaignId);
    if (by) {
      await this.sql`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${by.actor}, 'campaign.pool.settle_requested', ${row.id}, ${this.sql.json({ reason: by.reason, day })})`;
    }
    const terms = this.terms(row);
    const now = this.now();
    if (!LIVE_STATES.includes(effectiveState(row, now))) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const w = this.window(terms, day);
    if (!w) throw new CampaignsError('campaigns.pool_day_unknown', 'This pool has no such day');
    const done = await this.dayRow(row.id, day);
    if (done) return { settled: false, day: this.dayOf(done) };
    if (now.getTime() < w.endsAt.getTime() + SETTLE_AFTER_MS) {
      throw new CampaignsError('campaigns.pool_day_open', 'This day has not ended yet');
    }
    const entrants = await this.sql<{ account_id: string; joined_at: Date }[]>`
      SELECT account_id, created_at AS joined_at FROM campaigns.participations
      WHERE campaign_id = ${row.id} AND created_at < ${w.endsAt} ORDER BY account_id`;
    const lines: { accountId: string; activity: bigint; balance: bigint; balanceAsOf: Date; eligible: boolean }[] = [];
    for (const e of entrants) {
      const read = await this.readEntrant(terms, w, e);
      lines.push({ accountId: e.account_id, ...read, eligible: read.balance >= terms.minBalance });
    }
    const written = await transaction(this.sql, async (tx) => {
      await tx`SELECT 1 FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      const [again] = await tx`SELECT 1 FROM campaigns.pool_days WHERE campaign_id = ${row.id} AND day = ${day}`;
      if (again) return null;
      const left = parseAmount(row.budget_limit!) - (await drawnOf(tx, row.id));
      const slice = left < terms.dailySlice ? (left > 0n ? left : 0n) : terms.dailySlice;
      const total = lines.reduce((n, l) => n + (l.eligible ? l.activity : 0n), 0n);
      const cap = (terms.perUserCap / this.unit) * this.unit;
      const keys: string[] = [];
      let sharesTotal = 0n;
      const shares = lines.map((l) => {
        const raw = l.eligible && total > 0n ? ((slice * l.activity) / total / this.unit) * this.unit : 0n;
        const share = raw > cap ? cap : raw;
        sharesTotal += share;
        return { ...l, share, capped: raw > cap };
      });
      await tx`
        INSERT INTO campaigns.pool_days (campaign_id, day, starts_at, ends_at, slice, total_activity, shares_total, remainder)
        VALUES (${row.id}, ${day}, ${w.startsAt}, ${w.endsAt}, ${amount(slice)}, ${amount(total)}, ${amount(sharesTotal)},
          ${amount(slice - sharesTotal)})`;
      for (const s of shares) {
        const key = s.share > 0n ? poolKeyOf(row.id, day, s.accountId) : null;
        if (key) {
          await tx`
            INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
            VALUES (${key}, ${row.id}, ${s.accountId}, ${`pool:${day}`}, ${row.budget_asset!}, ${amount(s.share)}, 'qualified', 'paid')`;
          await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${key}, 'qualified')`;
          keys.push(key);
        }
        await tx`
          INSERT INTO campaigns.pool_day_shares (campaign_id, day, account_id, activity, balance, balance_as_of, eligible, share,
            capped, reward_key)
          VALUES (${row.id}, ${day}, ${s.accountId}, ${amount(s.activity)}, ${amount(s.balance)}, ${s.balanceAsOf}, ${s.eligible},
            ${amount(s.share)}, ${s.capped}, ${key})`;
      }
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES ('svc-campaigns', 'campaign.pool.settle', ${row.id},
          ${tx.json({ day, slice: amount(slice), sharesTotal: amount(sharesTotal), remainder: amount(slice - sharesTotal) })})`;
      return keys;
    });
    if (written) {
      for (const key of written) {
        if (!this.saga) break;
        try {
          await this.saga.attempt(key);
        } catch (err) {
          this.log('campaigns.pool.owe_failed', { key, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { settled: written !== null, day: this.dayOf((await this.dayRow(row.id, day))!) };
  }

  /** One pass over every live pool: each ended day not settled yet is settled, oldest first; a day that waits stops its pool. */
  async tick(): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM campaigns.campaigns WHERE type = 'pool' AND state IN ('active', 'paused', 'ended', 'closed')
      ORDER BY id LIMIT 100`;
    const now = this.now();
    for (const { id } of rows) {
      try {
        const row = await this.row(id);
        const terms = this.terms(row);
        const settled = new Set(
          (await this.sql<{ day: number }[]>`SELECT day FROM campaigns.pool_days WHERE campaign_id = ${id}`).map((d) => d.day),
        );
        for (const day of this.started(terms, now)) {
          if (settled.has(day)) continue;
          const w = this.window(terms, day)!;
          if (now.getTime() < w.endsAt.getTime() + SETTLE_AFTER_MS) break;
          await this.settle(id, day);
        }
      } catch (err) {
        this.log('campaigns.pool.tick_failed', { campaignId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * The pool as the caller sees it: its terms, each day that has started (newest first) with the caller's share once it is
   * settled, and the day under way with the caller's venue balance read now. In the caller's own request their connected
   * wallet is noted on their open shares, which are paid to it.
   */
  async board(input: { campaignId: string; accountId: string; forwarded?: Record<string, string> }): Promise<PoolBoard> {
    const row = await this.row(input.campaignId);
    const terms = this.terms(row);
    const now = this.now();
    await this.payTo(input.accountId, input.forwarded ?? {});
    const [joined] = await this.sql`
      SELECT 1 FROM campaigns.participations WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`;
    const settled = await this.sql<DayRow[]>`
      SELECT day, starts_at, ends_at, slice::text AS slice, total_activity::text AS total_activity,
        shares_total::text AS shares_total, remainder::text AS remainder, settled_at
      FROM campaigns.pool_days WHERE campaign_id = ${row.id}`;
    const mine = await this.sql<
      {
        day: number;
        activity: string;
        balance: string;
        balance_as_of: Date;
        eligible: boolean;
        share: string;
        capped: boolean;
        reward_key: string | null;
        intent_state: string | null;
        chain_tx: string | null;
      }[]
    >`
      SELECT s.day, s.activity::text AS activity, s.balance::text AS balance, s.balance_as_of, s.eligible, s.share::text AS share,
        s.capped, s.reward_key, i.state AS intent_state, pay.chain_tx
      FROM campaigns.pool_day_shares s
      LEFT JOIN campaigns.reward_intents i ON i.reward_key = s.reward_key
      LEFT JOIN campaigns.reward_payments pay ON pay.reward_key = s.reward_key AND pay.state = 'booked'
      WHERE s.campaign_id = ${row.id} AND s.account_id = ${input.accountId}`;
    const byDay = new Map(settled.map((d) => [d.day, d]));
    const mineByDay = new Map(mine.map((m) => [m.day, m]));
    const days: PoolDay[] = this.started(terms, now)
      .reverse()
      .slice(0, BOARD_DAYS)
      .map((day) => {
        const w = this.window(terms, day)!;
        const d = byDay.get(day);
        const m = mineByDay.get(day);
        return {
          ...(d
            ? this.dayOf(d)
            : {
                day,
                startsAt: w.startsAt.toISOString(),
                endsAt: w.endsAt.toISOString(),
                settledAt: null,
                slice: amount(terms.dailySlice),
                totalActivity: null,
                sharesTotal: null,
                remainder: null,
              }),
          mine: m
            ? {
                activity: amount(parseAmount(m.activity)),
                balance: amount(parseAmount(m.balance)),
                balanceAsOf: m.balance_as_of.toISOString(),
                eligible: m.eligible,
                share: amount(parseAmount(m.share)),
                capped: m.capped,
                rewardKey: m.reward_key,
                state: m.intent_state,
                chainTx: m.chain_tx,
              }
            : null,
        };
      });
    let today: PoolBoard['today'] = null;
    const current = this.started(terms, now).at(-1);
    const w = current ? this.window(terms, current) : null;
    if (joined && current && w && now < w.endsAt && LIVE_STATES.includes(effectiveState(row, now))) {
      const eq = this.equity ? await this.equity.equity(input.accountId, terms.activityAsset) : { unread: 'campaigns.equity_unread' };
      today =
        'unread' in eq
          ? { day: current, endsAt: w.endsAt.toISOString(), balance: null, balanceAsOf: null, belowMinimum: null, unread: eq.unread }
          : {
              day: current,
              endsAt: w.endsAt.toISOString(),
              balance: amount(parseAmount(eq.equity)),
              balanceAsOf: new Date(eq.asOf).toISOString(),
              belowMinimum: parseAmount(eq.equity) < terms.minBalance,
              unread: null,
            };
    }
    return {
      campaignId: row.id,
      asset: row.budget_asset!,
      pool: amount(parseAmount(row.budget_limit!)),
      activityAsset: terms.activityAsset,
      dailySlice: amount(terms.dailySlice),
      perUserCap: amount(terms.perUserCap),
      minBalance: amount(terms.minBalance),
      daySeconds: terms.daySeconds,
      joined: Boolean(joined),
      days,
      today,
    };
  }
}
