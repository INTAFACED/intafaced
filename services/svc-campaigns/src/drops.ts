import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { transaction } from '@intafaced/db';
import type {
  Drop,
  DropClaim,
  DropClaimResult,
  DropRoom,
  DropView,
  Season,
  SeasonView,
  TgeSchedule,
} from '@intafaced/contracts/campaigns-drops';
import { CampaignsError } from './codes.js';
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
 * - A drop carries no value here: a claim records an entitlement and moves nothing. A drop with value pays through the
 *   reward saga (CM-payouts-ledger-02), which is not wired, so creating one refuses `campaigns.reward_saga_unwired`.
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

type ClaimRow = { claim_key: string; drop_id: string; created_at: Date };

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

function toDrop(r: DropRow): Drop {
  return {
    id: r.id,
    title: r.title,
    seasonId: r.season_id,
    count: r.total_count,
    remaining: r.remaining,
    opensAt: iso(r.opens_at),
    closesAt: isoOrNull(r.closes_at),
    kind: 'entitlement',
    status: r.status,
    createdBy: r.created_by,
    publishedBy: r.published_by,
    createdAt: iso(r.created_at),
    publishedAt: isoOrNull(r.published_at),
  };
}

function toClaim(r: ClaimRow): DropClaim {
  return { dropId: r.drop_id, claimKey: r.claim_key, kind: 'entitlement', claimedAt: iso(r.created_at) };
}

function dropState(r: DropRow, now: Date): DropView['state'] {
  if (now < r.opens_at) return 'not_open';
  if (r.closes_at && now >= r.closes_at) return 'closed';
  return r.remaining === 0 ? 'sold_out' : 'open';
}

export const claimKeyOf = (dropId: string, accountId: string) => `drop:${dropId}:${accountId}`;

export interface DropServiceOptions {
  sql: Sql;
  tgeSchedule: () => TgeSchedule | null;
  now?: () => Date;
}

export class DropService {
  private readonly sql: Sql;
  private readonly now: () => Date;

  constructor(private readonly options: DropServiceOptions) {
    this.sql = options.sql;
    this.now = options.now ?? (() => new Date());
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
    value?: { asset: string; amount: string } | null;
    actor: string;
  }): Promise<Drop> {
    if (input.value) {
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
      const [row] = await tx<DropRow[]>`
        INSERT INTO campaigns.drops (id, title, season_id, total_count, remaining, opens_at, closes_at, created_by)
        VALUES (${id}, ${input.title}, ${seasonId}, ${count}, ${count}, ${opensAt}, ${closesAt}, ${input.actor})
        RETURNING *`;
      await audit(tx, input.actor, 'drop.create', id, { title: input.title, seasonId, count, opensAt: iso(opensAt) });
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
      const [out] = await tx<DropRow[]>`
        UPDATE campaigns.drops SET status = 'published', published_by = ${input.actor}, published_at = now(), updated_at = now()
        WHERE id = ${input.id} RETURNING *`;
      await audit(tx, input.actor, 'drop.publish', input.id, {});
      return toDrop(out!);
    });
  }

  async listForOps(): Promise<{ seasons: Season[]; drops: Drop[] }> {
    const [seasons, drops] = await Promise.all([
      this.sql<SeasonRow[]>`SELECT * FROM campaigns.seasons ORDER BY created_at DESC LIMIT 100`,
      this.sql<DropRow[]>`SELECT * FROM campaigns.drops ORDER BY created_at DESC LIMIT 100`,
    ]);
    return { seasons: seasons.map(toSeason), drops: drops.map(toDrop) };
  }

  // ── Customer (own account only; the account comes from the principal) ─────

  async room(accountId: string): Promise<DropRoom> {
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
        SELECT * FROM campaigns.drops d
        WHERE d.status = 'published'
          AND (d.closes_at IS NULL OR d.closes_at > ${now}
            OR EXISTS (SELECT 1 FROM campaigns.drop_claims c WHERE c.drop_id = d.id AND c.account_id = ${accountId}))
        ORDER BY d.opens_at DESC, d.id ASC
        LIMIT 200`,
      this.sql<ClaimRow[]>`SELECT claim_key, drop_id, created_at FROM campaigns.drop_claims WHERE account_id = ${accountId}`,
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
      const { id, title, seasonId, count, remaining, opensAt, closesAt, kind } = toDrop(r);
      return { id, title, seasonId, count, remaining, opensAt, closesAt, kind, state: dropState(r, now), mine: mine.get(r.id) ?? null };
    });
    return { season, drops, tge: tgeView(this.tgeSchedule()) };
  }

  /**
   * One claim per account. The caller's own stored claim comes back first, whatever the drop's state now. Otherwise,
   * under a lock on the drop row: unknown or unpublished refuses `drop.unknown`, outside its window `drop.not_open`,
   * none left `drop.sold_out`; else the claim row and the count change commit together.
   */
  async claim(input: { dropId: string; accountId: string }): Promise<DropClaimResult> {
    const key = claimKeyOf(input.dropId, input.accountId);
    return transaction(
      this.sql,
      async (tx) => {
        const [drop] = await tx<DropRow[]>`SELECT * FROM campaigns.drops WHERE id = ${input.dropId} FOR UPDATE`;
        if (!drop || drop.status !== 'published') throw new CampaignsError('drop.unknown', 'No such drop');
        const [existing] = await tx<ClaimRow[]>`
          SELECT claim_key, drop_id, created_at FROM campaigns.drop_claims WHERE claim_key = ${key}`;
        if (existing) return { claim: toClaim(existing), created: false, remaining: drop.remaining };
        const state = dropState(drop, this.now());
        if (state === 'not_open' || state === 'closed') {
          throw new CampaignsError('drop.not_open', state === 'closed' ? 'This drop has closed' : 'This drop opens later');
        }
        if (state === 'sold_out') throw new CampaignsError('drop.sold_out', 'This drop is sold out');
        const [claim] = await tx<ClaimRow[]>`
          INSERT INTO campaigns.drop_claims (claim_key, drop_id, account_id)
          VALUES (${key}, ${input.dropId}, ${input.accountId})
          RETURNING claim_key, drop_id, created_at`;
        const [left] = await tx<{ remaining: number }[]>`
          UPDATE campaigns.drops SET remaining = remaining - 1, updated_at = now()
          WHERE id = ${input.dropId} AND remaining > 0 RETURNING remaining`;
        // The row lock makes this unreachable; if it ever happens the transaction rolls back and nothing is claimed.
        if (!left) throw new CampaignsError('drop.sold_out', 'This drop is sold out');
        await audit(tx, input.accountId, 'drop.claim', input.dropId, { claimKey: key });
        return { claim: toClaim(claim!), created: true, remaining: left.remaining };
      },
      { isolation: 'read committed' },
    );
  }
}

function assertPublishable(row: { status: string; created_by: string }, actor: string): void {
  if (row.status === 'published') throw new CampaignsError('campaigns.already_published', 'Already published');
  if (row.created_by === actor) {
    throw new CampaignsError('campaigns.second_person_required', 'A second person publishes; the creator cannot');
  }
}

async function audit(tx: Sql, actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await tx`INSERT INTO campaigns.audit_log (actor, action, target, detail) VALUES (${actor}, ${action}, ${target}, ${tx.json(detail as postgres.JSONValue)})`;
}
