/**
 * Pooled masters (CB-copy-pro-share-11), pool creation (CB-copy-pro-share-04, creation only) and the pool whitelist
 * (CB-copy-pro-share-06), for J-copy-bots-otc-10 #6.
 *
 * A customer applies to run a pooled strategy from the master center under a nickname, a contact and a trading style.
 * The application enters the founders' one review queue (`trade.copy_lead_applications`, kind `pool_master`) and is
 * decided there as a lead application is: two founders approve, or one rejects with a reason the applicant reads. The
 * same submit again answers the open application. An approved master creates one pool of a type (stable or
 * aggressive) whose limits are the owner's for that type; a blank type refuses `trade.pool_limit_not_set`. The pool is
 * a lifecycle row and its limits, never a balance: subscribe, redeem and profit are ledger recipes the ledger owner has
 * not written, so no money door of a pool exists here. Founders add investors to a pool's whitelist by account id, at
 * most the owner's batch limit per import (blank refuses `trade.pool_batch_limit_unset`); an import is keyed by its
 * request id, so a retry writes nothing new.
 *
 * Nothing here moves money or imports a ledger write.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { requireOperator, requireOperatorWrite, writeOperatorAudit } from '../admin/common.js';
import { CopyError } from './errors.js';
import {
  applicantState,
  applicationView,
  reapplyAt,
  type ApplicationRow,
  type LeadApplicationView,
  type MyLeadApplication,
} from './lead-applications.js';

export type PoolStrategyType = 'stable' | 'aggressive';
export const POOL_STRATEGY_TYPES: readonly PoolStrategyType[] = ['stable', 'aggressive'];

/** The owner's limits for one strategy type, as decimal strings. */
export interface PoolTypeLimits {
  readonly maxLeverage: string;
  readonly maxDrawdownPct: string;
  readonly maxCapital: string;
}

/** The owner's limits per type; a type that is absent is unset and creating a pool of it refuses. */
export type PoolLaw = Partial<Record<PoolStrategyType, PoolTypeLimits>>;

const DECIMAL = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
const BATCH_MAX = 10_000;

/**
 * The owner's pool limits from TRADE_COPY_POOL_TYPE_LIMITS: blank is unset (every type refuses). Published shape:
 * {"published":true,"stable":{"maxLeverage":"…","maxDrawdownPct":"…","maxCapital":"…"},"aggressive":{…}}. A type left
 * out stays unset. Anything malformed stops the boot.
 */
export function parsePoolLaw(raw: string | undefined): PoolLaw {
  const text = (raw ?? '').trim();
  if (!text) return {};
  const fail = (why: string): never => {
    throw new Error(`TRADE_COPY_POOL_TYPE_LIMITS ${why}`);
  };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('is not JSON');
  }
  if (!json || typeof json !== 'object' || (json as { published?: unknown }).published !== true) return fail('must say "published": true');
  const law: Partial<Record<PoolStrategyType, PoolTypeLimits>> = {};
  for (const type of POOL_STRATEGY_TYPES) {
    const entry = (json as Record<string, unknown>)[type];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object') return fail(`${type} must be an object`);
    const limits = entry as Record<string, unknown>;
    for (const key of ['maxLeverage', 'maxDrawdownPct', 'maxCapital'] as const) {
      const value = limits[key];
      if (typeof value !== 'string' || !DECIMAL.test(value) || !/[1-9]/.test(value)) {
        return fail(`${type}.${key} must be a positive decimal string`);
      }
    }
    law[type] = {
      maxLeverage: limits.maxLeverage as string,
      maxDrawdownPct: limits.maxDrawdownPct as string,
      maxCapital: limits.maxCapital as string,
    };
  }
  return law;
}

/** The owner's whitelist batch limit from TRADE_COPY_POOL_WHITELIST_BATCH_MAX: blank is unset (null). */
export function parsePoolWhitelistBatchMax(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > BATCH_MAX) {
    throw new Error(`TRADE_COPY_POOL_WHITELIST_BATCH_MAX must be a whole number, 1 to ${BATCH_MAX}, or blank`);
  }
  return Number(value);
}

export interface PoolView {
  readonly poolId: string;
  readonly masterUserId: string;
  readonly applicationId: string;
  readonly name: string;
  readonly strategyType: PoolStrategyType;
  readonly limits: PoolTypeLimits;
  readonly state: 'strategy_creation' | 'seed_round' | 'trading' | 'settlement' | 'matured' | 'terminated';
  readonly createdAt: string;
}

/** What the master reads in the master center. */
export interface MyPoolMaster {
  readonly application:
    (Omit<MyLeadApplication, 'displayName'> & { readonly nickname: string; readonly contact: string; readonly style: string }) | null;
  readonly pool: PoolView | null;
  /** Investors in the pool: none can join until the pool's money doors exist. */
  readonly investors: number;
}

export interface WhitelistView {
  readonly poolId: string;
  readonly poolName: string;
  readonly masterUserId: string;
  readonly members: ReadonlyArray<{ readonly userId: string; readonly addedAt: string; readonly addedBy: string }>;
}

/** The founders' pooled masters desk: master applications from the master center, pools, whitelists and the batch limit. */
export interface PooledMastersRead {
  readonly applications: LeadApplicationView[];
  readonly pools: PoolView[];
  readonly whitelists: WhitelistView[];
  /** The owner's batch limit per whitelist import, or null when unset (every import refuses). */
  readonly batchLimit: number | null;
}

export interface WhitelistImportResult {
  readonly poolId: string;
  readonly importId: string;
  readonly requested: number;
  readonly added: number;
  readonly members: number;
}

export interface PoolDeskDeps {
  readonly sql: Sql;
  readonly now: () => Date;
  readonly law: PoolLaw;
  readonly whitelistBatchMax: number | null;
  /** The owner's wait after a rejection, shared with the lead queue (TRADE_COPY_LEAD_REAPPLY_WAIT_SECONDS). */
  readonly reapplyWaitSeconds?: number | null;
}

interface PoolRow {
  id: string;
  master_user_id: string;
  application_id: string;
  name: string;
  strategy_type: PoolStrategyType;
  max_leverage: string;
  max_drawdown_pct: string;
  max_capital: string;
  state: PoolView['state'];
  client_request_id: string;
  created_at: Date;
}

const LIST_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function poolView(row: PoolRow): PoolView {
  return {
    poolId: row.id,
    masterUserId: row.master_user_id,
    applicationId: row.application_id,
    name: row.name,
    strategyType: row.strategy_type,
    limits: { maxLeverage: row.max_leverage, maxDrawdownPct: row.max_drawdown_pct, maxCapital: row.max_capital },
    state: row.state,
    createdAt: row.created_at.toISOString(),
  };
}

function text(value: string, min: number, max: number, what: string): string {
  const out = value.trim().replace(/\s+/g, ' ');
  if (out.length < min || out.length > max) {
    throw new CopyError(`${what} is required (${min}–${max} characters)`, 'trade.pool_master_application_invalid');
  }
  return out;
}

export class PoolDesk {
  constructor(private readonly deps: PoolDeskDeps) {}

  private get waitSeconds(): number | null {
    return this.deps.reapplyWaitSeconds ?? null;
  }

  private mineOf(row: ApplicationRow): NonNullable<MyPoolMaster['application']> {
    return {
      applicationId: row.id,
      state: applicantState(row.status),
      nickname: row.display_name,
      contact: row.contact ?? '',
      style: row.style ?? '',
      submittedAt: row.created_at.toISOString(),
      reason: row.status === 'rejected' ? row.reason : null,
      reapplyAfter: reapplyAt(row, this.waitSeconds)?.toISOString() ?? null,
    };
  }

  /** The caller's newest pooled master application, their pool, and its investors. */
  async mine(principal: Principal): Promise<MyPoolMaster> {
    const [row] = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_lead_applications WHERE user_id = ${principal.userId} AND kind = 'pool_master'
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    const [pool] = await this.deps.sql<PoolRow[]>`
      SELECT * FROM trade.copy_pools WHERE master_user_id = ${principal.userId} AND state <> 'terminated' LIMIT 1`;
    return { application: row ? this.mineOf(row) : null, pool: pool ? poolView(pool) : null, investors: 0 };
  }

  /**
   * Apply to run a pooled strategy. The same submit answers the open application; a different one while it waits
   * refuses; an approved master does not apply again; after a rejection the owner's wait applies, as for leads.
   */
  async apply(principal: Principal, input: { nickname: string; contact: string; style: string }): Promise<MyPoolMaster> {
    const nickname = text(input.nickname, 1, 80, 'Nickname');
    const contact = text(input.contact, 1, 200, 'Contact');
    const style = text(input.style, 1, 500, 'Trading style');
    const userId = principal.userId;
    await this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`pool.apply:${userId}`}))`;
      const [latest] = await tx<ApplicationRow[]>`
        SELECT * FROM trade.copy_lead_applications WHERE user_id = ${userId} AND kind = 'pool_master'
        ORDER BY created_at DESC, id DESC LIMIT 1`;
      if (latest && (latest.status === 'pending' || latest.status === 'awaiting_second')) {
        if (latest.display_name !== nickname || latest.contact !== contact || latest.style !== style) {
          throw new CopyError('An application to run a pooled strategy is already waiting', 'trade.pool_master_application_open');
        }
        return;
      }
      if (latest?.status === 'approved') throw new CopyError('You already run pooled strategies', 'trade.pool_master_already_approved');
      const now = this.deps.now();
      if (latest?.status === 'rejected') {
        const opens = reapplyAt(latest, this.waitSeconds);
        if (!opens) throw new CopyError('The wait before applying again is not set by the platform', 'trade.copy_lead_reapply_wait_unset');
        if (now.getTime() < opens.getTime()) {
          throw new CopyError(`You may apply again after ${opens.toISOString()}`, 'trade.copy_lead_reapply_wait');
        }
      }
      await tx`
        INSERT INTO trade.copy_lead_applications (id, kind, user_id, display_name, contact, style, status, created_at, updated_at)
        VALUES (${randomUUID()}, 'pool_master', ${userId}, ${nickname}, ${contact}, ${style}, 'pending', ${now.toISOString()},
                ${now.toISOString()})`;
    });
    return this.mine(principal);
  }

  /**
   * Create the master's one pool. Needs an approved pooled master application and the owner's limits for the type.
   * The same request id answers the pool it made; a second active pool refuses.
   */
  async create(principal: Principal, input: { name: string; strategyType: string; clientRequestId: string }): Promise<PoolView> {
    const userId = principal.userId;
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 80) throw new CopyError('Name the strategy (1–80 characters)', 'trade.pool_name_invalid');
    const type = input.strategyType as PoolStrategyType;
    if (!POOL_STRATEGY_TYPES.includes(type)) throw new CopyError('Choose stable or aggressive', 'trade.pool_type_invalid');
    const requestId = `pool.create:${userId}:${input.clientRequestId.trim()}`;
    return this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`pool.create:${userId}`}))`;
      const [same] = await tx<PoolRow[]>`SELECT * FROM trade.copy_pools WHERE client_request_id = ${requestId}`;
      if (same) return poolView(same);
      const [approved] = await tx<ApplicationRow[]>`
        SELECT * FROM trade.copy_lead_applications WHERE user_id = ${userId} AND kind = 'pool_master' AND status = 'approved'
        ORDER BY decided_at DESC LIMIT 1`;
      if (!approved) {
        throw new CopyError('Only an approved pooled master can create a strategy', 'trade.pool_master_not_approved');
      }
      const limits = this.deps.law[type];
      if (!limits) throw new CopyError(`The ${type} strategy limits are not set by the platform`, 'trade.pool_limit_not_set');
      const [active] = await tx<PoolRow[]>`
        SELECT * FROM trade.copy_pools WHERE master_user_id = ${userId} AND state <> 'terminated' LIMIT 1`;
      if (active) throw new CopyError('A master runs one active strategy', 'trade.pool_one_strategy_only');
      const now = this.deps.now();
      const [row] = await tx<PoolRow[]>`
        INSERT INTO trade.copy_pools (id, master_user_id, application_id, name, strategy_type, max_leverage, max_drawdown_pct,
                                      max_capital, state, client_request_id, created_at, updated_at)
        VALUES (${randomUUID()}, ${userId}, ${approved.id}, ${name}, ${type}, ${limits.maxLeverage}, ${limits.maxDrawdownPct},
                ${limits.maxCapital}, 'strategy_creation', ${requestId}, ${now.toISOString()}, ${now.toISOString()})
        RETURNING *`;
      return poolView(row!);
    });
  }

  /** The founders' read: master applications oldest first (every state), pools, whitelists and the batch limit. */
  async read(principal: Principal): Promise<PooledMastersRead> {
    requireOperator(principal);
    const applications = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_lead_applications WHERE kind = 'pool_master' ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`;
    const pools = await this.deps.sql<PoolRow[]>`SELECT * FROM trade.copy_pools ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`;
    const members = await this.deps.sql<Array<{ pool_id: string; user_id: string; created_at: Date; added_by: string }>>`
      SELECT pool_id, user_id, created_at, added_by FROM trade.copy_pool_whitelist
      WHERE pool_id IN (SELECT id FROM trade.copy_pools ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX})
      ORDER BY created_at ASC, user_id ASC`;
    return {
      applications: applications.map(applicationView),
      pools: pools.map(poolView),
      whitelists: pools.map((p) => ({
        poolId: p.id,
        poolName: p.name,
        masterUserId: p.master_user_id,
        members: members
          .filter((m) => m.pool_id === p.id)
          .map((m) => ({ userId: m.user_id, addedAt: m.created_at.toISOString(), addedBy: m.added_by })),
      })),
      batchLimit: this.deps.whitelistBatchMax,
    };
  }

  /**
   * Add investors to a pool's whitelist by account id. Refuses while the batch limit is unset and above it, before
   * anything is written. The request id is the import's key: the same import again answers the first.
   */
  async importWhitelist(
    principal: Principal,
    input: { poolId: string; userIds: readonly string[]; clientRequestId: string },
  ): Promise<WhitelistImportResult> {
    requireOperatorWrite(principal);
    const limit = this.deps.whitelistBatchMax;
    if (limit === null) throw new CopyError('The whitelist batch limit is not set by the platform', 'trade.pool_batch_limit_unset');
    const userIds = [...new Set(input.userIds.map((u) => u.trim().toLowerCase()).filter((u) => u.length > 0))];
    if (userIds.length === 0) throw new CopyError('Add at least one account id', 'trade.pool_whitelist_empty');
    if (userIds.length > limit) {
      throw new CopyError(`One import adds at most ${limit} accounts; this one has ${userIds.length}`, 'trade.pool_batch_too_large');
    }
    const bad = userIds.find((u) => !UUID.test(u));
    if (bad) throw new CopyError(`Not an account id: ${bad.slice(0, 40)}`, 'trade.pool_whitelist_uid_invalid');
    if (!UUID.test(input.poolId)) throw new CopyError('No such pool', 'trade.pool_not_found');
    const requestId = `pool.whitelist:${input.poolId.toLowerCase()}:${input.clientRequestId.trim()}`;
    return this.deps.sql.begin(async (tx) => {
      const [pool] = await tx<PoolRow[]>`SELECT * FROM trade.copy_pools WHERE id = ${input.poolId} FOR UPDATE`;
      if (!pool) throw new CopyError('No such pool', 'trade.pool_not_found');
      const count = async () =>
        Number(
          (await tx<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.copy_pool_whitelist WHERE pool_id = ${pool.id}`)[0]!.n,
        );
      const [done] = await tx<Array<{ id: string; user_ids: string[] }>>`
        SELECT id, user_ids FROM trade.copy_pool_whitelist_imports WHERE client_request_id = ${requestId}`;
      if (done) {
        const sameIds = JSON.stringify([...done.user_ids].sort()) === JSON.stringify([...userIds].sort());
        if (!sameIds) throw new CopyError('That import key was used for other accounts', 'trade.pool_whitelist_key_reused');
        const [mine] = await tx<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM trade.copy_pool_whitelist WHERE import_id = ${done.id}`;
        return { poolId: pool.id, importId: done.id, requested: userIds.length, added: Number(mine?.n ?? 0), members: await count() };
      }
      const now = this.deps.now();
      const importId = randomUUID();
      await tx`
        INSERT INTO trade.copy_pool_whitelist_imports (id, pool_id, client_request_id, user_ids, imported_by, created_at)
        VALUES (${importId}, ${pool.id}, ${requestId}, ${tx.json(userIds)}, ${principal.userId}, ${now.toISOString()})`;
      const added = await tx`
        INSERT INTO trade.copy_pool_whitelist (pool_id, user_id, import_id, added_by, created_at)
        SELECT ${pool.id}, u, ${importId}, ${principal.userId}, ${now.toISOString()} FROM unnest(${tx.array(userIds)}::text[]) AS u
        ON CONFLICT (pool_id, user_id) DO NOTHING`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          kind: 'copy_pool.whitelist_import',
          operatorId: principal.userId,
          accountId: null,
          objectId: pool.id,
          approverId: null,
          reason: null,
          detail: { key: requestId, importId, requested: userIds.length, added: added.count },
        },
        now,
      );
      return { poolId: pool.id, importId, requested: userIds.length, added: added.count, members: await count() };
    });
  }
}
