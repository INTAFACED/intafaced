import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { EventBus } from '@intafaced/events';
import type { RankPerks } from '@intafaced/contracts';
import { RANK_TIERS, perksFor, rankForXp, tierFor, xpToNextRank, type RankTier } from './thresholds.js';

/**
 * THE RANK ENGINE (§4.1).
 *
 *   "Every module emits intafaced.identity.xp.earned events.
 *    svc-identity is the only writer to rank_state."
 *
 * One graph, many sources. An Academy certification and a spotless P2P record
 * are the same kind of fact here, which is why a certification can raise a P2P
 * limit without either module knowing the other exists.
 *
 * Schema: SQL is search_path-relative (not hard-coded `identity.*`) so tests can
 * run in a per-suite schema via `createTestDb` without touching the shared one.
 */

export interface RankSnapshot {
  readonly userId: string;
  readonly rank: number;
  readonly title: string;
  readonly xp: bigint;
  readonly seasonXp: bigint;
  readonly xpToNext: bigint | null;
  readonly perks: RankPerks;
  readonly updatedAt: Date;
}

export interface AwardXpInput {
  readonly userId: string;
  readonly sourceModule: string;
  readonly action: string;
  readonly xpDelta: number;
  /** An award is a fact that happened once. This is what stops it paying twice. */
  readonly idempotencyKey: string;
  readonly meta?: Record<string, unknown>;
}

export interface AwardResult {
  readonly snapshot: RankSnapshot;
  /** False when the award was a duplicate and nothing changed. */
  readonly applied: boolean;
  readonly rankChanged: boolean;
  readonly previousRank: number;
}

export class RankService {
  /** Cached ladder. Reloaded on demand so an operator can re-tune live. */
  private tiers: readonly RankTier[] = RANK_TIERS;

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
  ) {}

  /** Load the ladder from the database, which is authoritative once seeded. */
  async loadTiers(): Promise<void> {
    const rows = await this.sql<Array<{ rank: number; xp_required: string; title: string; perks: RankPerks }>>`
      SELECT rank, xp_required, title, perks FROM rank_thresholds ORDER BY rank ASC
    `;
    if (rows.length > 0) {
      this.tiers = rows.map((r) => ({ rank: r.rank, xpRequired: BigInt(r.xp_required), title: r.title, perks: r.perks }));
    }
  }

  /** Seed the ladder. Idempotent — safe on every boot. */
  async seedTiers(): Promise<void> {
    for (const tier of RANK_TIERS) {
      await this.sql`
        INSERT INTO rank_thresholds (rank, xp_required, title, perks)
        VALUES (${tier.rank}, ${tier.xpRequired.toString()}, ${tier.title}, ${this.sql.json(tier.perks as never)})
        ON CONFLICT (rank) DO NOTHING
      `;
    }
    await this.loadTiers();
  }

  /**
   * Apply an XP award and recalculate rank.
   *
   * The insert into `xp_events` carries a unique index on the idempotency key,
   * so a replayed event fails the insert rather than double-paying. That is the
   * dedupe — not a prior SELECT, which would race.
   */
  async awardXp(input: AwardXpInput): Promise<AwardResult> {
    return transaction(
      this.sql,
      async (tx) => {
        // Lock the user's rank row FIRST, before any write.
        //
        // Order matters: inserting the XP event first created a read/write
        // conflict that made concurrent awards abort each other under
        // SERIALIZABLE. Taking the row lock up front serialises awards per
        // user — which is exactly the granularity we want, since two users
        // earning XP have nothing to do with each other.
        const current = await this.lockRankState(tx, input.userId);

        const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO xp_events (user_id, source_module, action, xp_delta, meta, idempotency_key)
          VALUES (
            ${input.userId}, ${input.sourceModule}, ${input.action}, ${input.xpDelta},
            ${tx.json((input.meta ?? {}) as never)}, ${input.idempotencyKey}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;

        // Duplicate award: return the unchanged state rather than an error. The
        // caller asked for a fact to be true, and it already is.
        if (inserted.length === 0) {
          return {
            snapshot: this.snapshotOf(input.userId, current.xp, current.seasonXp, current.updatedAt),
            applied: false,
            rankChanged: false,
            previousRank: current.rank,
          };
        }

        const xp = current.xp + BigInt(input.xpDelta);
        const seasonXp = current.seasonXp + BigInt(input.xpDelta);

        // XP floors at zero. A correction can take it down, but a negative
        // lifetime XP is meaningless and would break the ladder walk.
        const clampedXp = xp < 0n ? 0n : xp;
        const clampedSeasonXp = seasonXp < 0n ? 0n : seasonXp;

        const nextRank = rankForXp(clampedXp, this.tiers);
        const updatedAt = new Date();

        await tx`
          INSERT INTO rank_state (user_id, rank, xp, season_xp, updated_at)
          VALUES (${input.userId}, ${nextRank}, ${clampedXp.toString()}, ${clampedSeasonXp.toString()}, ${updatedAt})
          ON CONFLICT (user_id) DO UPDATE
            SET rank = EXCLUDED.rank, xp = EXCLUDED.xp, season_xp = EXCLUDED.season_xp, updated_at = EXCLUDED.updated_at
        `;

        const snapshot = this.snapshotOf(input.userId, clampedXp, clampedSeasonXp, updatedAt);
        const rankChanged = nextRank !== current.rank;

        // Only announce a rank change. Every module caches perks; an event per
        // XP award would be a cache-invalidation storm for no benefit.
        if (rankChanged) {
          await this.bus.publish(
            'rankUpdated',
            { userId: input.userId, rank: nextRank, previousRank: current.rank, xp: clampedXp.toString() },
            { idempotencyKey: `rank:${input.userId}:${nextRank}:${clampedXp}` },
          );
        }

        return { snapshot, applied: true, rankChanged, previousRank: current.rank };
      },
      {
        // READ COMMITTED, because the rank-row lock above already establishes a
        // total order per user. Same reasoning as svc-ledger's chain-tip lock:
        // when a lock does the ordering, SERIALIZABLE only adds aborts.
        isolation: 'read committed',
        maxAttempts: 10,
      },
    );
  }

  async get(userId: string): Promise<RankSnapshot> {
    const rows = await this.sql<Array<{ rank: number; xp: string; season_xp: string; updated_at: Date }>>`
      SELECT rank, xp, season_xp, updated_at FROM rank_state WHERE user_id = ${userId}
    `;
    const row = rows[0];
    // An unranked user is rank 0, not an error. Every user has a rank from the
    // moment they exist, whether or not a row has been written.
    return row
      ? this.snapshotOf(userId, BigInt(row.xp), BigInt(row.season_xp), row.updated_at)
      : this.snapshotOf(userId, 0n, 0n, new Date());
  }

  async perks(userId: string): Promise<RankPerks> {
    return (await this.get(userId)).perks;
  }

  /** Season reset — clears season XP, leaves lifetime XP and rank alone (§11 drop V). */
  async resetSeason(): Promise<number> {
    const result = await this.sql`UPDATE rank_state SET season_xp = 0, updated_at = now()`;
    return result.count;
  }

  private async lockRankState(tx: Sql, userId: string): Promise<{ rank: number; xp: bigint; seasonXp: bigint; updatedAt: Date }> {
    // A first award has no row to lock, so concurrent first awards would each
    // read xp 0 and overwrite one another. Create the zero row (a no-op when it
    // exists), then lock it: awards for one user serialise from the first one.
    await tx`INSERT INTO rank_state (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
    const rows = await tx<Array<{ rank: number; xp: string; season_xp: string; updated_at: Date }>>`
      SELECT rank, xp, season_xp, updated_at FROM rank_state WHERE user_id = ${userId} FOR UPDATE
    `;
    const row = rows[0]!;
    return { rank: row.rank, xp: BigInt(row.xp), seasonXp: BigInt(row.season_xp), updatedAt: row.updated_at };
  }

  private snapshotOf(userId: string, xp: bigint, seasonXp: bigint, updatedAt: Date): RankSnapshot {
    const rank = rankForXp(xp, this.tiers);
    return {
      userId,
      rank,
      title: tierFor(rank, this.tiers).title,
      xp,
      seasonXp,
      xpToNext: xpToNextRank(xp, this.tiers),
      perks: perksFor(rank, this.tiers),
      updatedAt,
    };
  }
}
