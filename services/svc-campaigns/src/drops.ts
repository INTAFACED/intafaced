import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { transaction, type Queryable } from '@intafaced/db';
import type {
  Drop,
  DropClaim,
  DropClaimResult,
  DropReward,
  DropRoom,
  DropValue,
  DropView,
  Season,
  SeasonView,
  TgeSchedule,
} from '@intafaced/contracts/campaigns-drops';
import { CAMPAIGN_STATES } from '@intafaced/contracts/campaigns-catalogue';
import { campaignLimitsSchema } from '@intafaced/contracts/campaigns-vouchers';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { effectiveState } from './campaigns.js';
import { CampaignsError } from './codes.js';
import type { PayoutSaga } from './payouts.js';
import { LIMIT_WORDS, drawnOf, limitRefusalOf } from './tasks.js';
import { tgeView } from './tge.js';

/**
 * Seasons and limited drops claimed once per account (RC-campaigns-04, J-campaigns-20 #4-#5).
 *
 * - A season is a published window (start, end, name). A blank date refuses `campaigns.window_unset`; a time with no
 *   offset refuses `campaigns.timezone_unset`. Its points are the caller's reward points from the season's task
 *   campaigns, read from reward records. No task campaign exists in this version (CM-tasks-quests-01), so a season has
 *   zero task campaigns and the sum is over no records: "0", with `taskCampaigns: 0` saying why.
 * - A limited drop has a fixed count (blank refuses `drop.count_unset`). A claim writes one row under the business key
 *   `drop:<dropId>:<account>` and takes one from the count in the same transaction, under a lock on the drop row, so
 *   concurrent claims never exceed the count. Sold out refuses `drop.sold_out`; a second claim returns the first.
 * - A drop with no campaign is an entitlement: a claim records the right and moves nothing. A drop with value names its
 *   `drop` campaign (live, its reward set and in its budget's asset): each claim is worth the campaign's reward. In the
 *   claim's own transaction, under the drop's lock and then the campaign's, the campaign must be live, the account inside
 *   the campaign's limits and the reward inside its budget; the claim and one reward intent under the claim's own key
 *   (`drop:<dropId>:<account>`) commit together. After the commit the caller's connected wallet is noted on it and the
 *   reward saga (CM-payouts-ledger-02) owes it; the reward payer pays it once to that wallet and books the chain
 *   transaction. A saga that is not wired refuses creating a drop with value (`campaigns.reward_saga_unwired`).
 * - Operators create (`campaigns:ops`); a second person publishes. The database refuses a publish by the creator too.
 *   Every change and every claim writes an audit row. Nothing is visible to customers until published.
 */

type Sql = postgres.Sql;

/** The same ISO 8601 time with an offset the contract's outputs carry. */
const ISO_WITH_OFFSET = z.string().datetime({ offset: true });
const ISO_LOCAL = z.string().datetime({ local: true });

/**
 * An operator-typed time: blank refuses `campaigns.window_unset`, an ISO time with no offset `campaigns.timezone_unset`,
 * anything else that is not an ISO time with an offset `campaigns.window_invalid`. Never read in the server's zone.
 */
export function parseWindowTime(raw: string | null | undefined, field: string): Date {
  const value = raw?.trim();
  if (!value) throw new CampaignsError('campaigns.window_unset', `${field} is not set`);
  if (ISO_WITH_OFFSET.safeParse(value).success) return new Date(value);
  if (ISO_LOCAL.safeParse(value).success) throw new CampaignsError('campaigns.timezone_unset', `${field} has no time zone offset`);
  throw new CampaignsError('campaigns.window_invalid', `${field} is not an ISO time with an offset`);
}

/** The drop count: blank refuses `drop.count_unset`; anything but a whole number from 1 to 1,000,000 is invalid. */
export function parseDropCount(raw: string | null | undefined): number {
  const value = raw?.trim();
  if (!value) throw new CampaignsError('drop.count_unset', 'The drop count is not set');
  if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > 1_000_000) {
    throw new CampaignsError('drop.count_invalid', 'The drop count must be a whole number from 1 to 1000000');
  }
  return Number(value);
}

type SeasonRow = {
  id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  status: 'draft' | 'published';
  created_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
};

type DropRow = {
  id: string;
  title: string;
  season_id: string | null;
  kind: 'entitlement' | 'value';
  campaign_id: string | null;
  value_asset: string | null;
  value_amount: string | null;
  total_count: number;
  remaining: number;
  opens_at: Date;
  closes_at: Date | null;
  status: 'draft' | 'published';
  created_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
};

type ClaimRow = {
  claim_key: string;
  drop_id: string;
  kind: 'entitlement' | 'value';
  created_at: Date;
  reward_asset: string | null;
  reward_amount: string | null;
  reward_state: DropReward['state'] | null;
  pay_to_wallet: string | null;
  chain_tx: string | null;
};

/** The drop with its campaign's reward, as every read of it takes it. */
const SELECT_DROP = (sql: Queryable) =>
  sql`SELECT d.*, c.reward_asset AS value_asset, c.reward_amount::text AS value_amount
    FROM campaigns.drops d LEFT JOIN campaigns.campaigns c ON c.id = d.campaign_id`;

/** A claim with its reward and the reward's booked payment, if any. */
const SELECT_CLAIM = (sql: Queryable) =>
  sql`SELECT cl.claim_key, cl.drop_id, cl.kind, cl.created_at, i.asset AS reward_asset, i.amount::text AS reward_amount,
      i.state AS reward_state, i.pay_to_wallet, pay.chain_tx
    FROM campaigns.drop_claims cl
    LEFT JOIN campaigns.reward_intents i ON i.reward_key = cl.claim_key
    LEFT JOIN campaigns.reward_payments pay ON pay.reward_key = cl.claim_key AND pay.state = 'booked'`;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

function toSeason(r: SeasonRow): Season {
  return {
    id: r.id,
    name: r.name,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    status: r.status,
    createdBy: r.created_by,
    publishedBy: r.published_by,
    createdAt: iso(r.created_at),
    publishedAt: isoOrNull(r.published_at),
  };
}

function valueOf(r: DropRow): DropValue | null {
  if (r.kind !== 'value' || !r.campaign_id || !r.value_asset || r.value_amount === null) return null;
  return { campaignId: r.campaign_id, asset: r.value_asset, amount: formatAmount(parseAmount(r.value_amount)) };
}

function toDrop(r: DropRow): Drop {
  return {
    id: r.id,
    title: r.title,
    seasonId: r.season_id,
    count: r.total_count,
    remaining: r.remaining,
    opensAt: iso(r.opens_at),
    closesAt: isoOrNull(r.closes_at),
    kind: r.kind,
    value: valueOf(r),
    status: r.status,
    createdBy: r.created_by,
    publishedBy: r.published_by,
    createdAt: iso(r.created_at),
    publishedAt: isoOrNull(r.published_at),
  };
}

function toClaim(r: ClaimRow): DropClaim {
  const reward: DropReward | null =
    r.kind === 'value' && r.reward_state && r.reward_asset && r.reward_amount !== null
      ? {
          rewardKey: r.claim_key,
          asset: r.reward_asset,
          amount: formatAmount(parseAmount(r.reward_amount)),
          state: r.reward_state,
          payTo: r.pay_to_wallet,
          chainTx: r.chain_tx,
        }
      : null;
  return { dropId: r.drop_id, claimKey: r.claim_key, kind: r.kind, claimedAt: iso(r.created_at), reward };
}

function dropState(r: DropRow, now: Date): DropView['state'] {
  if (now < r.opens_at) return 'not_open';
  if (r.closes_at && now >= r.closes_at) return 'closed';
  return r.remaining === 0 ? 'sold_out' : 'open';
}

export const claimKeyOf = (dropId: string, accountId: string) => `drop:${dropId}:${accountId}`;
/** The reward intent's period for one drop: its key is then `drop:<dropId>:<account>`, the claim's own key. */
const dropPeriodOf = (dropId: string) => `drop:${dropId}`;

export interface DropServiceOptions {
  sql: Sql;
  tgeSchedule: () => TgeSchedule | null;
  /** The reward saga. Null while the ledger is not connected: a drop with value cannot be created. */
  saga?: PayoutSaga | null;
  /**
   * Notes the caller's connected wallet on their open USDC rewards (TaskService.recordPayTo), from the headers their own
   * request forwarded, so a claimed drop's reward is paid to that wallet. Absent: it is owed and waits for one.
   */
  payTo?: (accountId: string, forwarded: Record<string, string>) => Promise<boolean>;
  log?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

export class DropService {
  private readonly sql: Sql;
  private readonly now: () => Date;

  constructor(private readonly options: DropServiceOptions) {
    this.sql = options.sql;
    this.now = options.now ?? (() => new Date());
  }

  /** Notes the caller's connected wallet on their open rewards; a failed read leaves them owed and waiting. */
  private async notePayTo(accountId: string, forwarded: Record<string, string> | undefined): Promise<void> {
    if (!this.options.payTo || !forwarded) return;
    await this.options.payTo(accountId, forwarded).catch((err: unknown) => {
      this.options.log?.('campaigns.drop.pay_to_unread', { accountId, message: err instanceof Error ? err.message : String(err) });
      return false;
    });
  }

  /** The owner's TGE schedule, or null while blank. */
  tgeSchedule(): TgeSchedule | null {
    return this.options.tgeSchedule();
  }

  // ── Operator (campaigns:ops) ────────────────────────────────────────────────

  async createSeason(input: { name: string; startsAt: string; endsAt: string; actor: string }): Promise<Season> {
    const startsAt = parseWindowTime(input.startsAt, 'The season start');
    const endsAt = parseWindowTime(input.endsAt, 'The season end');
    if (endsAt <= startsAt) throw new CampaignsError('campaigns.window_invalid', 'The season must end after it starts');
    const id = `season_${randomUUID()}`;
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<SeasonRow[]>`
        INSERT INTO campaigns.seasons (id, name, starts_at, ends_at, created_by)
        VALUES (${id}, ${input.name}, ${startsAt}, ${endsAt}, ${input.actor})
        RETURNING *`;
      await audit(tx, input.actor, 'season.create', id, { name: input.name, startsAt: iso(startsAt), endsAt: iso(endsAt) });
      return toSeason(row!);
    });
  }

  async publishSeason(input: { id: string; actor: string }): Promise<Season> {
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<SeasonRow[]>`SELECT * FROM campaigns.seasons WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new CampaignsError('season.unknown', 'No such season');
      assertPublishable(row, input.actor);
      const [out] = await tx<SeasonRow[]>`
        UPDATE campaigns.seasons SET status = 'published', published_by = ${input.actor}, published_at = now(), updated_at = now()
        WHERE id = ${input.id} RETURNING *`;
      await audit(tx, input.actor, 'season.publish', input.id, {});
      return toSeason(out!);
    });
  }

  async createDrop(input: {
    title: string;
    seasonId?: string | null;
    count: string;
    opensAt: string;
    closesAt?: string | null;
    campaignId?: string | null;
    actor: string;
  }): Promise<Drop> {
    const campaignId = input.campaignId?.trim() ? input.campaignId.trim() : null;
    if (campaignId && !this.options.saga) {
      throw new CampaignsError(
        'campaigns.reward_saga_unwired',
        'A drop with value pays through the reward saga, which is not connected; create it with no value',
      );
    }
    const count = parseDropCount(input.count);
    const opensAt = parseWindowTime(input.opensAt, 'The drop opening time');
    const closesAt = input.closesAt?.trim() ? parseWindowTime(input.closesAt, 'The drop closing time') : null;
    if (closesAt && closesAt <= opensAt) throw new CampaignsError('campaigns.window_invalid', 'The drop must close after it opens');
    const seasonId = input.seasonId?.trim() ? input.seasonId.trim() : null;
    const id = `drop_${randomUUID()}`;
    return transaction(this.sql, async (tx) => {
      if (seasonId) {
        const [season] = await tx<SeasonRow[]>`SELECT * FROM campaigns.seasons WHERE id = ${seasonId}`;
        if (!season) throw new CampaignsError('season.unknown', 'No such season');
        if (opensAt < season.starts_at || (closesAt ?? opensAt) > season.ends_at) {
          throw new CampaignsError('campaigns.window_invalid', 'A drop in a season opens and closes inside the season');
        }
      }
      if (campaignId) await assertDropCampaign(tx, campaignId);
      await tx`
        INSERT INTO campaigns.drops (id, title, season_id, total_count, remaining, opens_at, closes_at, created_by, kind, campaign_id)
        VALUES (${id}, ${input.title}, ${seasonId}, ${count}, ${count}, ${opensAt}, ${closesAt}, ${input.actor},
          ${campaignId ? 'value' : 'entitlement'}, ${campaignId})`;
      await audit(tx, input.actor, 'drop.create', id, { title: input.title, seasonId, count, opensAt: iso(opensAt), campaignId });
      const [row] = await tx<DropRow[]>`${SELECT_DROP(tx)} WHERE d.id = ${id}`;
      return toDrop(row!);
    });
  }

  async publishDrop(input: { id: string; actor: string }): Promise<Drop> {
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<DropRow[]>`SELECT * FROM campaigns.drops WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new CampaignsError('drop.unknown', 'No such drop');
      assertPublishable(row, input.actor);
      if (row.season_id) {
        const [season] = await tx<{ status: string }[]>`SELECT status FROM campaigns.seasons WHERE id = ${row.season_id}`;
        if (season?.status !== 'published') {
          throw new CampaignsError('season.not_published', 'Publish the drop’s season before the drop');
        }
      }
      await tx`
        UPDATE campaigns.drops SET status = 'published', published_by = ${input.actor}, published_at = now(), updated_at = now()
        WHERE id = ${input.id}`;
      await audit(tx, input.actor, 'drop.publish', input.id, {});
      const [out] = await tx<DropRow[]>`${SELECT_DROP(tx)} WHERE d.id = ${input.id}`;
      return toDrop(out!);
    });
  }

  async listForOps(): Promise<{ seasons: Season[]; drops: Drop[] }> {
    const [seasons, drops] = await Promise.all([
      this.sql<SeasonRow[]>`SELECT * FROM campaigns.seasons ORDER BY created_at DESC LIMIT 100`,
      this.sql<DropRow[]>`${SELECT_DROP(this.sql)} ORDER BY d.created_at DESC LIMIT 100`,
    ]);
    return { seasons: seasons.map(toSeason), drops: drops.map(toDrop) };
  }

  // ── Customer (own account only; the account comes from the principal) ─────

  async room(accountId: string, forwarded?: Record<string, string>): Promise<DropRoom> {
    // The person's own read: a claimed drop's reward with no wallet yet is given their connected wallet here.
    await this.notePayTo(accountId, forwarded);
    const now = this.now();
    const [seasonRows, dropRows, claimRows] = await Promise.all([
      // The live season that started last; with none live, the next to start.
      this.sql<SeasonRow[]>`
        SELECT * FROM campaigns.seasons
        WHERE status = 'published' AND ends_at > ${now}
        ORDER BY (starts_at <= ${now}) DESC, CASE WHEN starts_at <= ${now} THEN starts_at END DESC, starts_at ASC
        LIMIT 1`,
      // Every drop still open or to come, and every drop the caller claimed; closed ones nobody here claimed drop out.
      this.sql<DropRow[]>`
        ${SELECT_DROP(this.sql)}
        WHERE d.status = 'published'
          AND (d.closes_at IS NULL OR d.closes_at > ${now}
            OR EXISTS (SELECT 1 FROM campaigns.drop_claims c WHERE c.drop_id = d.id AND c.account_id = ${accountId}))
        ORDER BY d.opens_at DESC, d.id ASC
        LIMIT 200`,
      this.sql<ClaimRow[]>`${SELECT_CLAIM(this.sql)} WHERE cl.account_id = ${accountId}`,
    ]);
    const mine = new Map(claimRows.map((c) => [c.drop_id, toClaim(c)]));
    const s = seasonRows[0];
    const season: SeasonView | null = s
      ? {
          id: s.id,
          name: s.name,
          startsAt: iso(s.starts_at),
          endsAt: iso(s.ends_at),
          state: now < s.starts_at ? 'upcoming' : 'live',
          // No task campaign feeds a season in this version: the sum over zero reward records.
          points: '0',
          taskCampaigns: 0,
        }
      : null;
    const drops: DropView[] = dropRows.map((r) => {
      const { id, title, seasonId, count, remaining, opensAt, closesAt, kind, value } = toDrop(r);
      return {
        id,
        title,
        seasonId,
        count,
        remaining,
        opensAt,
        closesAt,
        kind,
        value,
        state: dropState(r, now),
        mine: mine.get(r.id) ?? null,
      };
    });
    return { season, drops, tge: tgeView(this.tgeSchedule()) };
  }

  /**
   * One claim per account. The caller's own stored claim comes back first, whatever the drop's state now. Otherwise,
   * under a lock on the drop row: unknown or unpublished refuses `drop.unknown`, outside its window `drop.not_open`,
   * none left `drop.sold_out`; else the claim row and the count change commit together. A drop with value then locks its
   * campaign: not live refuses `campaign.not_active`, a limit reached or unset by its name, no room in the budget
   * `campaigns.budget_exhausted`; else its reward intent commits with the claim, under the claim's own key, and is owed
   * after the commit. Whatever is refused, nothing is claimed and nothing is owed.
   */
  async claim(input: { dropId: string; accountId: string; forwarded?: Record<string, string> }): Promise<DropClaimResult> {
    const key = claimKeyOf(input.dropId, input.accountId);
    const outcome = await transaction(
      this.sql,
      async (tx) => {
        const locked = await tx`SELECT id FROM campaigns.drops WHERE id = ${input.dropId} FOR UPDATE`;
        const [drop] = locked.length > 0 ? await tx<DropRow[]>`${SELECT_DROP(tx)} WHERE d.id = ${input.dropId}` : [];
        if (!drop || drop.status !== 'published') throw new CampaignsError('drop.unknown', 'No such drop');
        const [existing] = await tx<{ claim_key: string }[]>`
          SELECT claim_key FROM campaigns.drop_claims WHERE claim_key = ${key}`;
        if (existing) return { created: false, remaining: drop.remaining, valued: drop.kind === 'value' };
        const state = dropState(drop, this.now());
        if (state === 'not_open' || state === 'closed') {
          throw new CampaignsError('drop.not_open', state === 'closed' ? 'This drop has closed' : 'This drop opens later');
        }
        if (state === 'sold_out') throw new CampaignsError('drop.sold_out', 'This drop is sold out');
        // A drop with value: its campaign is locked after the drop, so its budget and limits cannot move under us.
        const value = drop.kind === 'value' ? await this.valueRoom(tx, drop, input.accountId) : null;
        await tx`
          INSERT INTO campaigns.drop_claims (claim_key, drop_id, account_id, kind)
          VALUES (${key}, ${input.dropId}, ${input.accountId}, ${drop.kind})`;
        const [left] = await tx<{ remaining: number }[]>`
          UPDATE campaigns.drops SET remaining = remaining - 1, updated_at = now()
          WHERE id = ${input.dropId} AND remaining > 0 RETURNING remaining`;
        // The row lock makes this unreachable; if it ever happens the transaction rolls back and nothing is claimed.
        if (!left) throw new CampaignsError('drop.sold_out', 'This drop is sold out');
        if (value) {
          await tx`
            INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
            VALUES (${key}, ${value.campaignId}, ${input.accountId}, ${dropPeriodOf(input.dropId)}, ${value.asset},
              ${value.amount}, 'qualified', 'paid')`;
          await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${key}, 'qualified')`;
        }
        await audit(tx, input.accountId, 'drop.claim', input.dropId, { claimKey: key, ...(value ? { value } : {}) });
        return { created: true, remaining: left.remaining, valued: value !== null };
      },
      { isolation: 'read committed' },
    );
    if (outcome.valued) {
      // The claimer's connected wallet is noted before the reward is owed, so the payer can send it once it is.
      await this.notePayTo(input.accountId, input.forwarded);
      // Owed after the commit, with no transaction open. A refusal or a lost answer leaves the intent open, and the
      // saga's reconciler posts the same key again; the claim stands either way.
      if (outcome.created && this.options.saga) {
        await this.options.saga.attempt(key).catch((err: unknown) => {
          this.options.log?.('campaigns.drop.owe_failed', { key, message: err instanceof Error ? err.message : String(err) });
        });
      }
    }
    const [claim] = await this.sql<ClaimRow[]>`${SELECT_CLAIM(this.sql)} WHERE cl.claim_key = ${key}`;
    return { claim: toClaim(claim!), created: outcome.created, remaining: outcome.remaining };
  }

  /** What one claim of a drop with value is owed, once its campaign has room for it; refuses by name otherwise. */
  private async valueRoom(tx: Queryable, drop: DropRow, accountId: string): Promise<DropValue> {
    const [c] = DropCampaignRow.array().parse(
      await tx`
        SELECT id, type, state, starts_at, ends_at, reward_asset, reward_amount::text AS reward_amount, budget_asset,
          budget_limit::text AS budget_limit, limits
        FROM campaigns.campaigns WHERE id = ${drop.campaign_id} FOR UPDATE`,
    );
    if (!c) throw new CampaignsError('drop.campaign_invalid', 'This drop’s campaign is missing');
    const live = effectiveState(c, this.now());
    if (live !== 'active') throw new CampaignsError('campaign.not_active', `This drop’s campaign is ${live}, so it pays nothing now`);
    if (!c.budget_asset || c.budget_limit === null) {
      throw new CampaignsError('campaigns.budget_unset', 'This drop’s campaign has no budget set, so nothing can be claimed');
    }
    if (!c.reward_asset || c.reward_amount === null) {
      throw new CampaignsError('drop.campaign_invalid', 'This drop’s campaign has no reward set');
    }
    if (c.reward_asset !== c.budget_asset) {
      throw new CampaignsError('campaigns.budget_asset_mismatch', 'The budget and the reward are in different assets');
    }
    const over = await limitRefusalOf(tx, c.id, accountId, c.limits);
    if (over) throw new CampaignsError(over, LIMIT_WORDS[over]);
    const units = parseAmount(c.reward_amount);
    if ((await drawnOf(tx, c.id)) + units > parseAmount(c.budget_limit)) {
      throw new CampaignsError('campaigns.budget_exhausted', 'This drop’s budget has no room for another claim');
    }
    return { campaignId: c.id, asset: c.reward_asset, amount: formatAmount(units) };
  }
}

/** The campaign row a claim of a drop with value reads under its lock, parsed where it is read. */
const DropCampaignRow = z.object({
  id: z.string(),
  type: z.string(),
  state: z.enum(CAMPAIGN_STATES),
  starts_at: z.date().nullable(),
  ends_at: z.date().nullable(),
  reward_asset: z.string().nullable(),
  reward_amount: z.string().nullable(),
  budget_asset: z.string().nullable(),
  budget_limit: z.string().nullable(),
  limits: campaignLimitsSchema.nullable(),
});
const DropCampaignOf = DropCampaignRow.pick({ type: true, reward_asset: true, reward_amount: true, budget_asset: true });

/** A drop with value names a `drop` campaign whose reward is set, in its budget's asset. */
async function assertDropCampaign(tx: Queryable, campaignId: string): Promise<void> {
  const [c] = DropCampaignOf.array().parse(
    await tx`SELECT type, reward_asset, reward_amount::text AS reward_amount, budget_asset FROM campaigns.campaigns WHERE id = ${campaignId}`,
  );
  if (!c || c.type !== 'drop') throw new CampaignsError('drop.campaign_invalid', 'A drop with value names a drop campaign');
  if (!c.reward_asset || c.reward_amount === null) {
    throw new CampaignsError('drop.campaign_invalid', 'The drop campaign has no reward set, so a claim would be worth nothing');
  }
  if (c.budget_asset && c.budget_asset !== c.reward_asset) {
    throw new CampaignsError('campaigns.budget_asset_mismatch', 'The budget and the reward are in different assets');
  }
}

function assertPublishable(row: { status: string; created_by: string }, actor: string): void {
  if (row.status === 'published') throw new CampaignsError('campaigns.already_published', 'Already published');
  if (row.created_by === actor) {
    throw new CampaignsError('campaigns.second_person_required', 'A second person publishes; the creator cannot');
  }
}

async function audit(tx: Queryable, actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await tx`INSERT INTO campaigns.audit_log (actor, action, target, detail) VALUES (${actor}, ${action}, ${target}, ${tx.json(detail as postgres.JSONValue)})`;
}
