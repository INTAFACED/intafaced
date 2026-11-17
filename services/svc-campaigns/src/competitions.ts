import type postgres from 'postgres';
import { transaction, type Queryable } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { CampaignCompetition, CampaignState, CompetitionBoard } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { effectiveState } from './campaigns.js';
import type { PayoutSaga } from './payouts.js';
import { drawnOf } from './tasks.js';

/**
 * Trading competitions (CM-promotions-events-01, J-campaigns-11). A `competition` campaign ranks its entrants by the
 * volume they trade on the venue through INTAFACED during its period, and pays its prize table and milestone prizes from
 * its pool (the campaign's budget): INTAFACED's own money, each prize owed once and paid once to the winner's own
 * connected wallet through the reward saga and the reward payer, never credited to a balance.
 *
 * - Seats: `CampaignService.join` gives each entrant one seat, one join at a time, so two joins for the last seat give it
 *   to one and refuse the other `campaigns.seats_full`.
 * - Volume: read from the venue's own fills of the entrant's orders placed through our door with our builder fee above
 *   zero (svc-trade `GET /internal/venue/our-fills`), from the later of the period's start and the entrant's join, up
 *   to the period's close, in the competition's volume asset. Each fill is kept once, by the venue, its account and its
 *   own fill id, so a fill read again (or redelivered) adds nothing. A read that fails is named on the board, never read
 *   as no volume.
 * - The leaderboard: volume, high to low; a tie keeps the earlier seat first, so its order never changes between reads.
 * - Milestones: an entrant whose volume reaches a tier is queued that tier's prize once (`competition:<campaign>:<period>:
 *   <account>:m<tier>`): owed at once, held until the period closes, then paid.
 * - The period closes at the campaign's end time, or when operators end it first. A short time after the close (so a fill
 *   the venue reports late is read), the period is settled once: every entrant's fills are read a last time, each place
 *   of the prize table goes to the entrant at that place whose volume reached the threshold
 *   (`competition:<campaign>:<period>:<account>`), and the standings, the winners, every prize and what is left of the
 *   pool are written together. Settling again finds the settlement and writes nothing; a crash before the commit writes
 *   nothing and the next pass settles from the start. Prizes + remainder = pool, checked by the table.
 */

type Sql = postgres.Sql;

/** One period per competition: the campaign's own time frame. */
export const COMPETITION_PERIOD = '1';
/** How long after the close a period waits before it is settled, so a fill the venue reports late still counts. */
export const SETTLE_AFTER_MS = 15_000;
/** The most standings one board lists. */
const BOARD_LIMIT = 500;

export const placeKeyOf = (campaignId: string, accountId: string) => `competition:${campaignId}:${COMPETITION_PERIOD}:${accountId}`;
export const milestoneKeyOf = (campaignId: string, accountId: string, tier: number) =>
  `competition:${campaignId}:${COMPETITION_PERIOD}:${accountId}:m${tier}`;

/** One fill as svc-trade reads it from the venue. */
export interface CompetitionFill {
  readonly fillId: string;
  readonly venueAccount: string;
  readonly symbol: string;
  readonly quoteAsset: string;
  readonly notional: string;
  readonly builderFee: string;
  readonly filledAt: string;
}

/** The venue's fills of one person's orders placed through our door since a time; `unread` with a code when unread. */
export interface CompetitionFillSource {
  ourFills(userId: string, since: Date): Promise<{ venueId: string; asOf: string; fills: readonly CompetitionFill[] } | { unread: string }>;
}

type CompetitionRow = {
  id: string;
  type: string;
  state: CampaignState;
  starts_at: Date | null;
  ends_at: Date | null;
  budget_asset: string | null;
  budget_limit: string | null;
  competition: CampaignCompetition | null;
};

type EntryRow = {
  account_id: string;
  seat: number;
  pay_to_wallet: string | null;
  joined_at: Date;
  read_at: Date | null;
  unread: string | null;
  volume: string;
  fills: number;
};

type Terms = CampaignCompetition & { volumeAsset: string; threshold: string; seats: number };

const OPEN_STATES: readonly CampaignState[] = ['active', 'paused'];
const CLOSED_STATES: readonly CampaignState[] = ['ended', 'closed', 'archived'];

export interface CompetitionServiceOptions {
  sql: Sql;
  saga: PayoutSaga | null;
  fills: CompetitionFillSource | null;
  /** The person's connected wallets, read for them in their own request; null when unread. */
  wallets?: ((forwarded: Record<string, string>) => Promise<string[] | null>) | null;
  /** Notes the connected wallet on the person's open USDC rewards that have none (TaskService.recordPayTo). */
  payTo?: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  now?: () => Date;
  log?: (msg: string, detail: Record<string, unknown>) => void;
}

export class CompetitionService {
  private readonly sql: Sql;
  private readonly saga: PayoutSaga | null;
  private readonly fills: CompetitionFillSource | null;
  private readonly wallets: ((forwarded: Record<string, string>) => Promise<string[] | null>) | null;
  private readonly payTo: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail: Record<string, unknown>) => void;

  constructor(options: CompetitionServiceOptions) {
    this.sql = options.sql;
    this.saga = options.saga;
    this.fills = options.fills;
    this.wallets = options.wallets ?? null;
    this.payTo = options.payTo ?? (async () => false);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  private async row(campaignId: string): Promise<CompetitionRow> {
    const [row] = await this.sql<CompetitionRow[]>`
      SELECT id, type, state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, competition
      FROM campaigns.campaigns WHERE id = ${campaignId}`;
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.state)) {
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    }
    if (row.type !== 'competition') throw new CampaignsError('campaigns.not_competition', 'This campaign is not a competition');
    return row;
  }

  /** The terms a live competition must have (the activation gate made sure); a row without them refuses. */
  private terms(row: CompetitionRow): Terms {
    const c = row.competition;
    if (!c || c.volumeAsset === null || c.threshold === null || c.seats === null || !row.budget_asset || row.budget_limit === null) {
      throw new CampaignsError('campaigns.competition_unset', 'This competition is missing its terms');
    }
    return { ...c, volumeAsset: c.volumeAsset, threshold: c.threshold, seats: c.seats };
  }

  /** When the period closed: its end time, or when operators ended it first; null while it is open. */
  private async closedAt(row: CompetitionRow, now: Date): Promise<Date | null> {
    const state = effectiveState(row, now);
    if (!CLOSED_STATES.includes(state)) return null;
    const [ended] = await this.sql<{ at: Date }[]>`
      SELECT min(created_at) AS at FROM campaigns.audit_log WHERE target = ${row.id} AND action = 'campaign.end'`;
    const byOperators = ended?.at ?? null;
    if (row.ends_at && (!byOperators || row.ends_at <= byOperators)) return row.ends_at;
    return byOperators ?? row.ends_at ?? now;
  }

  private entries(campaignId: string): Promise<EntryRow[]> {
    return this.sql<EntryRow[]>`
      SELECT e.account_id, e.seat, e.pay_to_wallet, e.joined_at, e.read_at, e.unread,
        COALESCE(sum(f.notional), 0)::text AS volume, count(f.fill_id)::int AS fills
      FROM campaigns.competition_entries e
      LEFT JOIN campaigns.competition_fills f ON f.campaign_id = e.campaign_id AND f.account_id = e.account_id
      WHERE e.campaign_id = ${campaignId}
      GROUP BY e.account_id, e.seat, e.pay_to_wallet, e.joined_at, e.read_at, e.unread
      ORDER BY sum(f.notional) DESC NULLS LAST, e.seat ASC`;
  }

  // ── Volume ─────────────────────────────────────────────────────────────────

  /**
   * Reads one entrant's fills from the venue and keeps each new one once. Only fills from the later of the period's start
   * and the join, before the close (or now), in the volume asset, count. Returns false when the venue was not read.
   */
  private async readEntrant(
    row: CompetitionRow,
    terms: Terms,
    entry: Pick<EntryRow, 'account_id' | 'joined_at'>,
    upTo: Date,
  ): Promise<boolean> {
    const since = row.starts_at && row.starts_at > entry.joined_at ? row.starts_at : entry.joined_at;
    const answer = this.fills ? await this.fills.ourFills(entry.account_id, since) : { unread: 'campaigns.fills_unread' };
    if ('unread' in answer) {
      await this.sql`
        UPDATE campaigns.competition_entries SET unread = ${answer.unread}
        WHERE campaign_id = ${row.id} AND account_id = ${entry.account_id}`;
      return false;
    }
    const counted = answer.fills.filter((f) => {
      const at = new Date(f.filledAt);
      return (
        f.quoteAsset === terms.volumeAsset && at >= since && at < upTo && parseAmount(f.notional) > 0n && parseAmount(f.builderFee) > 0n
      );
    });
    await transaction(this.sql, async (tx) => {
      for (const f of counted) {
        await tx`
          INSERT INTO campaigns.competition_fills (campaign_id, account_id, venue_id, venue_account, fill_id, symbol, notional,
            builder_fee, filled_at)
          VALUES (${row.id}, ${entry.account_id}, ${answer.venueId}, ${f.venueAccount}, ${f.fillId}, ${f.symbol}, ${f.notional},
            ${f.builderFee}, ${new Date(f.filledAt)})
          ON CONFLICT (campaign_id, venue_id, venue_account, fill_id) DO NOTHING`;
      }
      await tx`
        UPDATE campaigns.competition_entries SET read_at = ${new Date(answer.asOf)}, unread = NULL
        WHERE campaign_id = ${row.id} AND account_id = ${entry.account_id}`;
    });
    return true;
  }

  /**
   * Queues each milestone the entrant's volume has reached and was not queued yet: one row per entrant and tier, and its
   * prize a reward intent owed now and held until `holdUntil`, the period's close. Returns the keys it queued.
   */
  private async queueMilestones(row: CompetitionRow, terms: Terms, accountId: string, holdUntil: Date): Promise<string[]> {
    if (terms.milestones.length === 0) return [];
    const [sum] = await this.sql<{ volume: string }[]>`
      SELECT COALESCE(sum(notional), 0)::text AS volume FROM campaigns.competition_fills
      WHERE campaign_id = ${row.id} AND account_id = ${accountId}`;
    const volume = parseAmount(sum!.volume);
    const queued: string[] = [];
    for (let i = 0; i < terms.milestones.length; i += 1) {
      const tier = i + 1;
      const m = terms.milestones[i]!;
      if (volume < parseAmount(m.volume)) break;
      const key = milestoneKeyOf(row.id, accountId, tier);
      const made = await transaction(this.sql, async (tx) => {
        await tx`SELECT 1 FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
        const [reached] = await tx`
          INSERT INTO campaigns.competition_milestones (campaign_id, account_id, tier, reward_key)
          VALUES (${row.id}, ${accountId}, ${tier}, ${key}) ON CONFLICT DO NOTHING RETURNING tier`;
        if (!reached) return false;
        await this.writePrize(tx, row, accountId, key, `competition:${COMPETITION_PERIOD}:m${tier}`, m.amount, holdUntil);
        return true;
      });
      if (made) queued.push(key);
    }
    return queued;
  }

  /** One prize as a reward intent, inside the caller's transaction with the campaign locked; the pool must cover it. */
  private async writePrize(
    tx: Queryable,
    row: CompetitionRow,
    accountId: string,
    key: string,
    period: string,
    amount: string,
    holdUntil: Date | null,
  ): Promise<void> {
    if ((await drawnOf(tx, row.id)) + parseAmount(amount) > parseAmount(row.budget_limit!)) {
      throw new CampaignsError('campaigns.budget_exhausted', 'This competition’s pool has no room for another prize');
    }
    const [entry] = await tx<{ pay_to_wallet: string | null }[]>`
      SELECT pay_to_wallet FROM campaigns.competition_entries WHERE campaign_id = ${row.id} AND account_id = ${accountId}`;
    await tx`
      INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, hold_until, form,
        pay_to_wallet)
      VALUES (${key}, ${row.id}, ${accountId}, ${period}, ${row.budget_asset!}, ${amount}, 'qualified', ${holdUntil}, 'paid',
        ${entry?.pay_to_wallet ?? null})`;
    await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${key}, 'qualified')`;
    await tx`
      INSERT INTO campaigns.audit_log (actor, action, target, detail)
      VALUES ('svc-campaigns', 'campaign.competition.prize', ${row.id}, ${tx.json({ rewardKey: key, amount })})`;
  }

  /** Owes each new prize: the saga posts it under its own key; one that does not post now is posted by the reconciler. */
  private async owe(keys: readonly string[]): Promise<void> {
    if (!this.saga) return;
    for (const key of keys) {
      try {
        await this.saga.attempt(key);
      } catch (err) {
        this.log('campaigns.competition.owe_failed', { key, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** While the period is open: reads each entrant's fills (or only `onlyAccount`'s) and queues the milestones reached. */
  private async refreshOpen(row: CompetitionRow, terms: Terms, onlyAccount?: string): Promise<void> {
    const now = this.now();
    const holdUntil = row.ends_at ?? now;
    for (const e of await this.entries(row.id)) {
      if (onlyAccount && e.account_id !== onlyAccount) continue;
      if (await this.readEntrant(row, terms, e, now)) await this.owe(await this.queueMilestones(row, terms, e.account_id, holdUntil));
    }
  }

  // ── Settlement ─────────────────────────────────────────────────────────────

  /**
   * Settles a closed period once. Every entrant is read a last time up to the close; while any is unread, nothing is
   * settled and the next pass tries again. Returns true when this call wrote the settlement.
   */
  async settle(campaignId: string): Promise<boolean> {
    const row = await this.row(campaignId);
    const terms = this.terms(row);
    const now = this.now();
    const closedAt = await this.closedAt(row, now);
    if (!closedAt || now.getTime() < closedAt.getTime() + SETTLE_AFTER_MS) return false;
    const [done] = await this.sql`
      SELECT 1 FROM campaigns.competition_settlements WHERE campaign_id = ${row.id} AND period = ${COMPETITION_PERIOD}`;
    if (done) return false;
    const entries = await this.entries(row.id);
    for (const e of entries) {
      if (!(await this.readEntrant(row, terms, e, closedAt))) {
        this.log('campaigns.competition.settle_waits', { campaignId: row.id, reason: 'fills_unread' });
        return false;
      }
    }
    const milestones: string[] = [];
    for (const e of entries) milestones.push(...(await this.queueMilestones(row, terms, e.account_id, closedAt)));
    await this.owe(milestones);
    const winners = await transaction(this.sql, async (tx) => {
      await tx`SELECT 1 FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      const [again] = await tx`
        SELECT 1 FROM campaigns.competition_settlements WHERE campaign_id = ${row.id} AND period = ${COMPETITION_PERIOD}`;
      if (again) return null;
      const standings = await tx<{ account_id: string; seat: number; volume: string }[]>`
        SELECT e.account_id, e.seat, COALESCE(sum(f.notional), 0)::text AS volume
        FROM campaigns.competition_entries e
        LEFT JOIN campaigns.competition_fills f ON f.campaign_id = e.campaign_id AND f.account_id = e.account_id
        WHERE e.campaign_id = ${row.id}
        GROUP BY e.account_id, e.seat ORDER BY sum(f.notional) DESC NULLS LAST, e.seat ASC`;
      const threshold = parseAmount(terms.threshold);
      const placed: { rank: number; seat: number; accountId: string; amount: string; rewardKey: string }[] = [];
      for (const prize of terms.prizes) {
        const s = standings[prize.rank - 1];
        if (!s || parseAmount(s.volume) <= 0n || parseAmount(s.volume) < threshold) continue;
        const key = placeKeyOf(row.id, s.account_id);
        await this.writePrize(tx, row, s.account_id, key, `competition:${COMPETITION_PERIOD}`, prize.amount, null);
        placed.push({ rank: prize.rank, seat: s.seat, accountId: s.account_id, amount: prize.amount, rewardKey: key });
      }
      // A milestone prize queued before an early close is paid at the close, not at the planned end.
      await tx`
        UPDATE campaigns.reward_intents SET hold_until = ${closedAt}, updated_at = now()
        WHERE campaign_id = ${row.id} AND period LIKE ${`competition:${COMPETITION_PERIOD}:m%`} AND hold_until > ${closedAt}`;
      const [owed] = await tx<{ total: string }[]>`
        SELECT COALESCE(sum(amount), 0)::text AS total FROM campaigns.reward_intents
        WHERE campaign_id = ${row.id} AND period LIKE ${`competition:${COMPETITION_PERIOD}%`} AND state NOT IN ('failed', 'forfeited')`;
      const pool = parseAmount(row.budget_limit!);
      const total = parseAmount(owed!.total);
      await tx`
        INSERT INTO campaigns.competition_settlements (campaign_id, period, pool, prizes_total, remainder, standings, winners)
        VALUES (${row.id}, ${COMPETITION_PERIOD}, ${formatAmount(pool)}, ${formatAmount(total)}, ${formatAmount(pool - total)},
          ${tx.json(standings.map((s, i) => ({ rank: i + 1, seat: s.seat, accountId: s.account_id, volume: s.volume })))},
          ${tx.json(placed)})`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES ('svc-campaigns', 'campaign.competition.settle', ${row.id},
          ${tx.json({ period: COMPETITION_PERIOD, winners: placed.length, prizesTotal: formatAmount(total) })})`;
      return placed;
    });
    if (!winners) return false;
    await this.owe(winners.map((w) => w.rewardKey));
    return true;
  }

  /** One pass over every live or closed, unsettled competition: open ones are read and their milestones queued; closed
   * ones are settled. One competition failing never stops the others. */
  async tick(): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT c.id FROM campaigns.campaigns c
      WHERE c.type = 'competition' AND c.state IN ('scheduled', 'active', 'paused', 'ended', 'closed')
        AND NOT EXISTS (SELECT 1 FROM campaigns.competition_settlements s WHERE s.campaign_id = c.id AND s.period = ${COMPETITION_PERIOD})
      ORDER BY c.id LIMIT 100`;
    for (const { id } of rows) {
      try {
        const row = await this.row(id);
        const state = effectiveState(row, this.now());
        if (OPEN_STATES.includes(state)) await this.refreshOpen(row, this.terms(row));
        else if (CLOSED_STATES.includes(state)) await this.settle(id);
      } catch (err) {
        this.log('campaigns.competition.tick_failed', { campaignId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // ── The board ──────────────────────────────────────────────────────────────

  /**
   * The competition as the caller sees it. In the caller's own request their connected wallet is noted on their entry
   * (prizes are paid to it) and on their open rewards; while the period is open, their own fills are read first, so a
   * trade they just made shows.
   */
  async board(input: { campaignId: string; accountId: string; forwarded?: Record<string, string> }): Promise<CompetitionBoard> {
    const row = await this.row(input.campaignId);
    const terms = this.terms(row);
    const now = this.now();
    const forwarded = input.forwarded ?? {};
    const [own] = await this.sql<{ pay_to_wallet: string | null }[]>`
      SELECT pay_to_wallet FROM campaigns.competition_entries WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`;
    if (own && !own.pay_to_wallet && this.wallets && Object.keys(forwarded).length > 0) {
      const wallet = (await this.wallets(forwarded))?.find((w) => /^0x[0-9a-f]{40}$/.test(w));
      if (wallet) {
        await this.sql`
          UPDATE campaigns.competition_entries SET pay_to_wallet = ${wallet}
          WHERE campaign_id = ${row.id} AND account_id = ${input.accountId} AND pay_to_wallet IS NULL`;
      }
    }
    if (own) await this.payTo(input.accountId, forwarded);
    const closedAt = await this.closedAt(row, now);
    if (own && !closedAt && OPEN_STATES.includes(effectiveState(row, now))) await this.refreshOpen(row, terms, input.accountId);

    const entries = await this.entries(row.id);
    const threshold = parseAmount(terms.threshold);
    const standings = entries.slice(0, BOARD_LIMIT).map((e, i) => ({
      rank: i + 1,
      seat: e.seat,
      you: e.account_id === input.accountId,
      volume: formatAmount(parseAmount(e.volume)),
      fills: e.fills,
      qualifies: parseAmount(e.volume) > 0n && parseAmount(e.volume) >= threshold,
    }));
    const mineAt = entries.findIndex((e) => e.account_id === input.accountId);
    const me = mineAt >= 0 ? entries[mineAt]! : null;
    const reached = me
      ? await this.sql<{ tier: number; reward_key: string; reached_at: Date }[]>`
          SELECT tier, reward_key, reached_at FROM campaigns.competition_milestones
          WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`
      : [];
    const [settled] = await this.sql<
      {
        settled_at: Date;
        prizes_total: string;
        remainder: string;
        winners: { rank: number; seat: number; accountId: string; amount: string }[];
      }[]
    >`
      SELECT settled_at, prizes_total::text AS prizes_total, remainder::text AS remainder, winners
      FROM campaigns.competition_settlements WHERE campaign_id = ${row.id} AND period = ${COMPETITION_PERIOD}`;
    const unread = me?.unread ?? null;
    return {
      campaignId: row.id,
      period: COMPETITION_PERIOD,
      basis: terms.basis,
      volumeAsset: terms.volumeAsset,
      threshold: formatAmount(threshold),
      prizeAsset: row.budget_asset!,
      pool: formatAmount(parseAmount(row.budget_limit!)),
      prizes: terms.prizes,
      seats: terms.seats,
      seatsLeft: Math.max(0, terms.seats - entries.length),
      closesAt: (closedAt ?? row.ends_at ?? now).toISOString(),
      closed: closedAt !== null,
      standings,
      mine: me
        ? { seat: me.seat, joinedAt: me.joined_at.toISOString(), volume: formatAmount(parseAmount(me.volume)), rank: mineAt + 1 }
        : null,
      milestones: terms.milestones.map((m, i) => {
        const hit = reached.find((r) => r.tier === i + 1);
        return {
          tier: i + 1,
          volume: m.volume,
          amount: m.amount,
          reached: Boolean(hit),
          reachedAt: hit ? hit.reached_at.toISOString() : null,
          rewardKey: hit ? hit.reward_key : null,
        };
      }),
      settlement: settled
        ? {
            settledAt: settled.settled_at.toISOString(),
            winners: settled.winners.map((w) => ({ rank: w.rank, seat: w.seat, you: w.accountId === input.accountId, amount: w.amount })),
            prizesTotal: formatAmount(parseAmount(settled.prizes_total)),
            remainder: formatAmount(parseAmount(settled.remainder)),
          }
        : null,
      asOf: me?.read_at ? me.read_at.toISOString() : null,
      unread,
    };
  }
}
