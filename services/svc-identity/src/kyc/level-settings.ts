/**
 * Per-level requirements and review times, edited by compliance with a second person (I-kyc-compliance-05,
 * J-identity-20 #7). The owner's published values (`IDENTITY_KYC_REQUIREMENTS_BY_LEVEL`, `IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL`)
 * are the starting point. A change for one level is proposed and waits; a different person approves it (the proposer may
 * not: `kyc.same_reviewer`), and only then does it take effect, as one override row for that level. A change can also put
 * a level back to the owner's published values. One change waits per level at a time (`kyc.level_change_waiting`).
 */
import {
  KYC_REQUIREMENT_KEYS,
  KYC_SETTABLE_LEVELS,
  type KycLevelSettingChange,
  type KycLevelSettingsView,
  type KycRequirementKey,
  type KycSettableLevel,
} from '@intafaced/contracts/identity-kyc-levels';
import type { Sql } from 'postgres';
import type { KycLadderSettings } from './levels.js';

export type KycLevelSettingsErrorCode =
  'kyc.level_change_waiting' | 'kyc.level_change_unknown' | 'kyc.level_change_state' | 'kyc.same_reviewer' | 'kyc.requirement_unknown';

export class KycLevelSettingsError extends Error {
  constructor(
    message: string,
    readonly code: KycLevelSettingsErrorCode,
  ) {
    super(message);
    this.name = 'KycLevelSettingsError';
  }
}

/** Effective settings: the ladder's settings with review times in minutes, so an edited time below an hour is exact. */
export interface KycEffectiveSettings extends KycLadderSettings {
  readonly reviewMinutes: ReadonlyMap<KycSettableLevel, number>;
}

interface ChangeRow {
  id: string;
  level: KycSettableLevel;
  restore: boolean;
  requirements: string[] | null;
  review_minutes: number | null;
  state: 'waiting' | 'applied' | 'withdrawn';
  proposed_by: string;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}

const CHANGE_COLUMNS = 'id, level, restore, requirements, review_minutes, state, proposed_by, proposed_at, decided_by, decided_at';

function toChange(r: ChangeRow): KycLevelSettingChange {
  return {
    id: r.id,
    level: r.level,
    restore: r.restore,
    requirements: r.requirements as KycRequirementKey[] | null,
    reviewMinutes: r.review_minutes,
    state: r.state,
    proposedBy: r.proposed_by,
    proposedAt: r.proposed_at.toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

export class KycLevelSettingsDesk {
  constructor(
    private readonly sql: Sql,
    private readonly published: KycLadderSettings,
  ) {}

  /** The owner's published review time for a level, in minutes, or null. */
  private publishedMinutes(level: KycSettableLevel): number | null {
    const hours = this.published.reviewHours.get(level);
    return hours === undefined ? null : hours * 60;
  }

  /** The settings in force now: the owner's published values with each approved override in place. */
  async effective(): Promise<KycEffectiveSettings> {
    const rows = await this.sql<Array<{ level: KycSettableLevel; requirements: string[] | null; review_minutes: number | null }>>`
      SELECT level, requirements, review_minutes FROM kyc_level_settings`;
    const requirements = new Map(this.published.requirements);
    const reviewHours = new Map(this.published.reviewHours);
    const reviewMinutes = new Map<KycSettableLevel, number>();
    for (const level of KYC_SETTABLE_LEVELS) {
      const m = this.publishedMinutes(level);
      if (m !== null) reviewMinutes.set(level, m);
    }
    for (const r of rows) {
      if (r.requirements === null) requirements.delete(r.level);
      else requirements.set(r.level, r.requirements as KycRequirementKey[]);
      reviewHours.delete(r.level);
      reviewMinutes.delete(r.level);
      if (r.review_minutes !== null) {
        reviewMinutes.set(r.level, r.review_minutes);
        if (r.review_minutes % 60 === 0) reviewHours.set(r.level, r.review_minutes / 60);
      }
    }
    return { requirements, reviewHours, reviewMinutes };
  }

  /** Each level's published and effective values, and the changes waiting for a second person. */
  async read(): Promise<KycLevelSettingsView> {
    const now = await this.effective();
    const overridden = new Set((await this.sql<Array<{ level: string }>>`SELECT level FROM kyc_level_settings`).map((r) => r.level));
    const waiting = await this.sql<ChangeRow[]>`
      SELECT ${this.sql.unsafe(CHANGE_COLUMNS)} FROM kyc_level_setting_changes WHERE state = 'waiting' ORDER BY proposed_at, id`;
    return {
      levels: KYC_SETTABLE_LEVELS.map((level) => ({
        level,
        requirements: now.requirements.has(level) ? [...now.requirements.get(level)!] : null,
        reviewMinutes: now.reviewMinutes.get(level) ?? null,
        published: {
          requirements: this.published.requirements.has(level) ? [...this.published.requirements.get(level)!] : null,
          reviewMinutes: this.publishedMinutes(level),
        },
        edited: overridden.has(level),
      })),
      waiting: waiting.map(toChange),
    };
  }

  /** Propose a change for one level. It takes effect only when a different person approves it. */
  async propose(
    by: string,
    input: { level: KycSettableLevel; restore: boolean; requirements: readonly string[] | null; reviewMinutes: number | null },
    at = new Date(),
  ): Promise<KycLevelSettingChange> {
    const requirements = input.restore ? null : input.requirements;
    for (const key of requirements ?? [])
      if (!(KYC_REQUIREMENT_KEYS as readonly string[]).includes(key))
        throw new KycLevelSettingsError(`${key} is not a requirement this platform knows`, 'kyc.requirement_unknown');
    try {
      const [row] = await this.sql<ChangeRow[]>`
        INSERT INTO kyc_level_setting_changes (level, restore, requirements, review_minutes, proposed_by, proposed_at)
        VALUES (${input.level}, ${input.restore}, ${requirements === null ? null : this.sql.array([...requirements])},
          ${input.restore ? null : input.reviewMinutes}, ${by}, ${at})
        RETURNING ${this.sql.unsafe(CHANGE_COLUMNS)}`;
      return toChange(row!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new KycLevelSettingsError(`A change for ${input.level} already waits for a second person`, 'kyc.level_change_waiting');
      throw err;
    }
  }

  /**
   * A different person approves a waiting change, and it takes effect in the same transaction. The proposer is refused
   * `kyc.same_reviewer`; a change already applied or withdrawn, `kyc.level_change_state`.
   */
  async approve(changeId: string, by: string, at = new Date()): Promise<KycLevelSettingChange> {
    return await this.sql.begin(async (tx) => {
      const [c] = await tx<ChangeRow[]>`
        SELECT ${tx.unsafe(CHANGE_COLUMNS)} FROM kyc_level_setting_changes WHERE id = ${changeId} FOR UPDATE`;
      if (!c) throw new KycLevelSettingsError('No such change', 'kyc.level_change_unknown');
      if (c.state !== 'waiting') throw new KycLevelSettingsError(`This change is ${c.state}`, 'kyc.level_change_state');
      if (c.proposed_by === by)
        throw new KycLevelSettingsError('You proposed this change; a different person approves it', 'kyc.same_reviewer');
      if (c.restore) await tx`DELETE FROM kyc_level_settings WHERE level = ${c.level}`;
      else
        await tx`
          INSERT INTO kyc_level_settings (level, requirements, review_minutes, change_id, updated_at)
          VALUES (${c.level}, ${c.requirements === null ? null : tx.array(c.requirements)}, ${c.review_minutes}, ${c.id}, ${at})
          ON CONFLICT (level) DO UPDATE SET requirements = EXCLUDED.requirements, review_minutes = EXCLUDED.review_minutes,
            change_id = EXCLUDED.change_id, updated_at = EXCLUDED.updated_at`;
      const [row] = await tx<ChangeRow[]>`
        UPDATE kyc_level_setting_changes SET state = 'applied', decided_by = ${by}, decided_at = ${at} WHERE id = ${changeId}
        RETURNING ${tx.unsafe(CHANGE_COLUMNS)}`;
      return toChange(row!);
    });
  }

  /** The proposer withdraws a waiting change; nothing takes effect. */
  async withdraw(changeId: string, by: string, at = new Date()): Promise<KycLevelSettingChange> {
    const [row] = await this.sql<ChangeRow[]>`
      UPDATE kyc_level_setting_changes SET state = 'withdrawn', decided_by = ${by}, decided_at = ${at}
      WHERE id = ${changeId} AND state = 'waiting' AND proposed_by = ${by}
      RETURNING ${this.sql.unsafe(CHANGE_COLUMNS)}`;
    if (row) return toChange(row);
    const [c] = await this.sql<
      ChangeRow[]
    >`SELECT ${this.sql.unsafe(CHANGE_COLUMNS)} FROM kyc_level_setting_changes WHERE id = ${changeId}`;
    if (!c) throw new KycLevelSettingsError('No such change', 'kyc.level_change_unknown');
    throw new KycLevelSettingsError('Only the proposer withdraws a waiting change', 'kyc.level_change_state');
  }
}
