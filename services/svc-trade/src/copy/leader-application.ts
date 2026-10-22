/**
 * Lead trader application and new-trader missions (CB-copy-12).
 *
 * copy-bots-otc-copy-012: `trade.copy.leader.apply` writes one application row
 * per (user, lead mode) under the business key `copy.leader_apply:<userId>:<mode>`.
 * Eligibility is checked on write, in order, and each failure refuses typed
 * before any row is written:
 *   1. owner market list for the mode is set, and every chosen market is in it
 *   2. not following any master (an ACTIVE follow)
 *   3. no copy account on the same user (any follow row, past or present;
 *      this also covers "no existing copy trades", which need a follow)
 *   4. verification at the owner level (identity read; unwired refuses)
 *   5. free balance at or above the owner threshold (blank refuses)
 *
 * copy-bots-otc-copy-013: `trade.copy.leader.missions` lists onboarding steps.
 * A blank owner value is reported as `not_set_by_platform` and keeps the
 * listing step blocked; blank never means "no requirement".
 *
 * A listing is created only by the founder approval (CB-ops-01 queue); this
 * module never calls upsertListing.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import { TIER_ORDER } from '@intafaced/auth';
import { CopyError } from './errors.js';
import type { ReadIdentityTierPort } from './identity-tier.js';
import type { CopyLeadLaw } from './lead-law.js';

export const COPY_LEAD_MODES = ['spot', 'futures'] as const;
export type CopyLeadMode = (typeof COPY_LEAD_MODES)[number];

export const COPY_LEADER_APPLICATION_STATES = ['submitted', 'under_review', 'approved', 'disapproved'] as const;
export type CopyLeaderApplicationState = (typeof COPY_LEADER_APPLICATION_STATES)[number];

export function leaderApplyKey(userId: string, mode: CopyLeadMode): string {
  return `copy.leader_apply:${userId}:${mode}`;
}

export type CopyLeaderApplication = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly mode: CopyLeadMode;
  readonly nickname: string;
  readonly contact: string;
  readonly tradingStyle: string;
  readonly markets: readonly string[];
  readonly state: CopyLeaderApplicationState;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly decidedAt: Date | null;
  readonly submittedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type LeaderApplyInput = {
  readonly mode: CopyLeadMode;
  readonly nickname: string;
  readonly contact: string;
  readonly tradingStyle: string;
  readonly markets: readonly string[];
};

export interface LeaderApplicationStore {
  /** Runs fn holding a row lock on the key (or the insert slot for it). */
  withKey<T>(key: string, fn: (tx: LeaderApplicationTx) => Promise<T>): Promise<T>;
  listByUser(userId: string): Promise<CopyLeaderApplication[]>;
  getById(id: string): Promise<CopyLeaderApplication | null>;
}

export interface LeaderApplicationTx {
  get(): Promise<CopyLeaderApplication | null>;
  insert(row: CopyLeaderApplication): Promise<void>;
  update(row: CopyLeaderApplication): Promise<void>;
}

export interface LeaderEligibilityPorts {
  /** ACTIVE follows where the user is the follower. */
  activeFollowCount(userId: string): Promise<number>;
  /** Any follow row where the user is the follower, in any state. */
  copyAccountCount(userId: string): Promise<number>;
  /**
   * CB-copy-03 svc-identity tier read (createIdentityTierReader). Absent (unconfigured)
   * or any failure refuses trade.copy_lead_verification_unavailable.
   */
  readIdentityTier?: ReadIdentityTierPort;
  /** Free (available) balance in the owner asset. */
  freeBalance(userId: string, assetId: string): Promise<bigint>;
}

export type MissionStep = {
  readonly key: 'apply' | 'approval' | 'transfer_minimum' | 'days_to_list';
  readonly state: 'done' | 'pending' | 'blocked';
  readonly value: string | null;
  readonly reason: 'not_set_by_platform' | 'not_applied' | 'awaiting_review' | 'disapproved' | null;
};

export type LeaderMissions = {
  readonly mode: CopyLeadMode;
  readonly applicationState: CopyLeaderApplicationState | null;
  readonly steps: readonly MissionStep[];
  readonly listingStep: { readonly state: 'blocked' | 'pending'; readonly reason: 'not_set_by_platform' | 'awaiting_steps' };
};

const DAY_MS = 86_400_000;

function clean(v: string): string {
  return v.trim();
}

export class LeaderApplicationService {
  constructor(
    private readonly store: LeaderApplicationStore,
    private readonly ports: LeaderEligibilityPorts,
    private readonly law: CopyLeadLaw,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async apply(userId: string, input: LeaderApplyInput): Promise<CopyLeaderApplication> {
    const key = leaderApplyKey(userId, input.mode);
    return this.store.withKey(key, async (tx) => {
      const existing = await tx.get();
      if (existing && existing.state !== 'disapproved') return existing;
      if (existing) this.assertResubmitAllowed(existing);

      const markets = await this.checkEligibility(userId, input);
      const now = this.now();
      const row: CopyLeaderApplication = {
        id: existing?.id ?? randomUUID(),
        idempotencyKey: key,
        userId,
        mode: input.mode,
        nickname: clean(input.nickname),
        contact: clean(input.contact),
        tradingStyle: clean(input.tradingStyle),
        markets,
        state: 'submitted',
        decidedBy: null,
        decisionReason: null,
        decidedAt: null,
        submittedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) await tx.update(row);
      else await tx.insert(row);
      return row;
    });
  }

  /**
   * Review decision. Not routed in this slice: the founder queue (CB-ops-01)
   * is the caller. Kept here so the state machine and resubmit window live in one place.
   */
  async decide(
    id: string,
    decision: { state: 'under_review' | 'approved' | 'disapproved'; actorId: string; reason: string },
  ): Promise<CopyLeaderApplication> {
    const found = await this.store.getById(id);
    if (!found) throw new CopyError('lead application not found', 'trade.copy_lead_application_not_found');
    return this.store.withKey(found.idempotencyKey, async (tx) => {
      const row = await tx.get();
      if (!row) throw new CopyError('lead application not found', 'trade.copy_lead_application_not_found');
      const allowed: Record<CopyLeaderApplicationState, readonly string[]> = {
        submitted: ['under_review', 'approved', 'disapproved'],
        under_review: ['approved', 'disapproved'],
        approved: [],
        disapproved: [],
      };
      if (!allowed[row.state].includes(decision.state)) {
        throw new CopyError(`lead application cannot move ${row.state} -> ${decision.state}`, 'trade.copy_lead_state_invalid');
      }
      const reason = decision.reason.trim();
      if (!reason) throw new CopyError('a review decision needs a reason', 'trade.copy_lead_state_invalid');
      const now = this.now();
      const next: CopyLeaderApplication = {
        ...row,
        state: decision.state,
        decidedBy: decision.actorId,
        decisionReason: reason,
        decidedAt: decision.state === 'under_review' ? row.decidedAt : now,
        updatedAt: now,
      };
      await tx.update(next);
      return next;
    });
  }

  async mine(userId: string): Promise<CopyLeaderApplication[]> {
    return this.store.listByUser(userId);
  }

  async missions(userId: string, mode: CopyLeadMode): Promise<LeaderMissions> {
    const app = (await this.store.listByUser(userId)).find((a) => a.mode === mode) ?? null;
    const applyStep: MissionStep = app
      ? { key: 'apply', state: 'done', value: null, reason: null }
      : { key: 'apply', state: 'pending', value: null, reason: 'not_applied' };
    const approvalStep: MissionStep =
      app?.state === 'approved'
        ? { key: 'approval', state: 'done', value: null, reason: null }
        : app?.state === 'disapproved'
          ? { key: 'approval', state: 'blocked', value: null, reason: 'disapproved' }
          : { key: 'approval', state: 'pending', value: null, reason: app ? 'awaiting_review' : 'not_applied' };
    const transfer = this.law.missionTransferMinimum;
    const transferStep: MissionStep =
      transfer === null
        ? { key: 'transfer_minimum', state: 'blocked', value: null, reason: 'not_set_by_platform' }
        : { key: 'transfer_minimum', state: 'pending', value: transfer, reason: null };
    const days = this.law.missionDaysToList;
    const daysStep: MissionStep =
      days === null
        ? { key: 'days_to_list', state: 'blocked', value: null, reason: 'not_set_by_platform' }
        : { key: 'days_to_list', state: 'pending', value: String(days), reason: null };
    const ownerBlank = transfer === null || days === null;
    return {
      mode,
      applicationState: app?.state ?? null,
      steps: [applyStep, approvalStep, transferStep, daysStep],
      listingStep: ownerBlank ? { state: 'blocked', reason: 'not_set_by_platform' } : { state: 'pending', reason: 'awaiting_steps' },
    };
  }

  private assertResubmitAllowed(row: CopyLeaderApplication): void {
    const days = this.law.resubmitDays;
    if (days === null) {
      throw new CopyError('resubmit window is not set by the platform', 'trade.copy_lead_resubmit_not_set');
    }
    const decidedAt = row.decidedAt ?? row.updatedAt;
    if (this.now().getTime() < decidedAt.getTime() + days * DAY_MS) {
      throw new CopyError(`resubmit is allowed ${days} days after the decision`, 'trade.copy_lead_resubmit_too_early');
    }
  }

  private async checkEligibility(userId: string, input: LeaderApplyInput): Promise<readonly string[]> {
    const ownerMarkets = input.mode === 'spot' ? this.law.spotMarkets : this.law.futuresMarkets;
    if (!ownerMarkets) {
      throw new CopyError(`lead markets for ${input.mode} are not set by the platform`, 'trade.copy_lead_markets_not_set');
    }
    const chosen = [...new Set(input.markets.map(clean).filter(Boolean))];
    if (chosen.length === 0 || chosen.some((m) => !ownerMarkets.includes(m))) {
      throw new CopyError('every lead market must be on the platform list for this mode', 'trade.copy_lead_market_not_permitted');
    }
    if ((await this.ports.activeFollowCount(userId)) > 0) {
      throw new CopyError('a user who follows a master cannot apply to lead', 'trade.copy_lead_follows_master');
    }
    if ((await this.ports.copyAccountCount(userId)) > 0) {
      throw new CopyError('a user with a copy account cannot apply to lead', 'trade.copy_lead_has_copy_account');
    }
    const required = this.law.verificationLevel;
    if (required === null) {
      throw new CopyError('lead verification level is not set by the platform', 'trade.copy_lead_verification_not_set');
    }
    const read = this.ports.readIdentityTier;
    const level = read ? await read(userId).catch(() => null) : null;
    if (level === null) {
      throw new CopyError('identity verification could not be read', 'trade.copy_lead_verification_unavailable');
    }
    const have: number | undefined = (TIER_ORDER as Record<string, number>)[level];
    if (have === undefined || have < TIER_ORDER[required]) {
      throw new CopyError('verification is below the platform level for lead traders', 'trade.copy_lead_verification_insufficient');
    }
    const threshold = this.law.balanceThreshold;
    const asset = this.law.balanceAsset;
    if (threshold === null || asset === null) {
      throw new CopyError('lead balance threshold is not set by the platform', 'trade.copy_lead_threshold_not_set');
    }
    const free = await this.ports.freeBalance(userId, asset);
    if (free < parseAmount(threshold)) {
      throw new CopyError(
        `free ${asset} balance ${formatAmount(free)} is below the lead threshold ${threshold}`,
        'trade.copy_lead_balance_below_threshold',
      );
    }
    return chosen;
  }
}

/** Ledger-backed free balance. */
export function ledgerFreeBalance(ledger: Pick<LedgerClient, 'balance'>): LeaderEligibilityPorts['freeBalance'] {
  return async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount;
}

/** SQL follow reads for eligibility (trade.copy_follows). */
export function sqlFollowEligibility(sql: Sql): Pick<LeaderEligibilityPorts, 'activeFollowCount' | 'copyAccountCount'> {
  return {
    async activeFollowCount(userId) {
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.copy_follows
         WHERE follower_id = ${userId} AND relationship_state = 'ACTIVE'`;
      return row?.n ?? 0;
    },
    async copyAccountCount(userId) {
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.copy_follows WHERE follower_id = ${userId}`;
      return row?.n ?? 0;
    },
  };
}

type AppRow = {
  id: string;
  idempotency_key: string;
  user_id: string;
  lead_mode: CopyLeadMode;
  nickname: string;
  contact: string;
  trading_style: string;
  markets: string[];
  state: CopyLeaderApplicationState;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  submitted_at: Date;
  created_at: Date;
  updated_at: Date;
};

function fromRow(r: AppRow): CopyLeaderApplication {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    userId: r.user_id,
    mode: r.lead_mode,
    nickname: r.nickname,
    contact: r.contact,
    tradingStyle: r.trading_style,
    markets: r.markets,
    state: r.state,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    decidedAt: r.decided_at,
    submittedAt: r.submitted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = `id, idempotency_key, user_id, lead_mode, nickname, contact, trading_style, markets, state,
  decided_by, decision_reason, decided_at, submitted_at, created_at, updated_at`;

/**
 * Postgres store. withKey takes a transaction-scoped advisory lock on the key,
 * so two concurrent applies for the same key serialise: exactly one inserts,
 * the other reads the stored row. The UNIQUE key is the backstop.
 */
export class SqlLeaderApplicationStore implements LeaderApplicationStore {
  constructor(private readonly sql: Sql) {}

  async withKey<T>(key: string, fn: (tx: LeaderApplicationTx) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      await q`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn({
        get: async () => {
          const rows = await q.unsafe<AppRow[]>(
            `SELECT ${COLS} FROM trade.copy_leader_applications WHERE idempotency_key = $1 FOR UPDATE`,
            [key],
          );
          return rows[0] ? fromRow(rows[0]) : null;
        },
        insert: async (row) => {
          await q`
            INSERT INTO trade.copy_leader_applications (${q.unsafe(COLS)})
            VALUES (${row.id}, ${row.idempotencyKey}, ${row.userId}, ${row.mode}, ${row.nickname}, ${row.contact},
              ${row.tradingStyle}, ${q.json([...row.markets])}, ${row.state}, ${row.decidedBy}, ${row.decisionReason},
              ${row.decidedAt}, ${row.submittedAt}, ${row.createdAt}, ${row.updatedAt})`;
        },
        update: async (row) => {
          await q`
            UPDATE trade.copy_leader_applications SET
              nickname = ${row.nickname}, contact = ${row.contact}, trading_style = ${row.tradingStyle},
              markets = ${q.json([...row.markets])}, state = ${row.state}, decided_by = ${row.decidedBy},
              decision_reason = ${row.decisionReason}, decided_at = ${row.decidedAt},
              submitted_at = ${row.submittedAt}, updated_at = ${row.updatedAt}
            WHERE idempotency_key = ${row.idempotencyKey}`;
        },
      });
    })) as T;
  }

  async listByUser(userId: string): Promise<CopyLeaderApplication[]> {
    const rows = await this.sql.unsafe<AppRow[]>(
      `SELECT ${COLS} FROM trade.copy_leader_applications WHERE user_id = $1 ORDER BY lead_mode`,
      [userId],
    );
    return rows.map(fromRow);
  }

  async getById(id: string): Promise<CopyLeaderApplication | null> {
    const rows = await this.sql.unsafe<AppRow[]>(`SELECT ${COLS} FROM trade.copy_leader_applications WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

/** In-memory store for unit tests. Serialises withKey per key. */
export class MemoryLeaderApplicationStore implements LeaderApplicationStore {
  private readonly rows = new Map<string, CopyLeaderApplication>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async withKey<T>(key: string, fn: (tx: LeaderApplicationTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() =>
        fn({
          get: async () => this.rows.get(key) ?? null,
          insert: async (row) => {
            if (this.rows.has(key)) throw new Error('unique violation');
            this.rows.set(key, row);
          },
          update: async (row) => {
            this.rows.set(key, row);
          },
        }),
      );
    this.locks.set(key, run);
    return run;
  }

  async listByUser(userId: string): Promise<CopyLeaderApplication[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId).sort((a, b) => a.mode.localeCompare(b.mode));
  }

  async getById(id: string): Promise<CopyLeaderApplication | null> {
    return [...this.rows.values()].find((r) => r.id === id) ?? null;
  }
}
