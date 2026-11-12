/**
 * Pooled masters on the founders' copy desk (CB-copy-pro-share-11, -06, -09, -03; J-copy-bots-otc-10 #6 #7).
 *
 * A customer applies from the master center to run a pooled strategy: one application per person, under the business
 * key `pool.apply:<userId>`, so the same submit twice answers the first. The founders read the applications oldest
 * first beside the lead applications.
 *
 * A pool holds its followers' money in one place, which is the custodial layer (OWNER 226: INTAFACED launches holding
 * no customer money). So no pool is created here, and the whitelists and takeovers read the pools that exist: none.
 * The whitelist batch limit is an owner value (TRADE_POOL_WHITELIST_BATCH_MAX): blank is unset, never a default.
 * Takeover rows are keyed `pool.takeover:<poolId>:<day>`. Lead levels list every lead in the directory with its level
 * unset, because the platform does not measure a lead's record, and the maximum profit-share ratio is not set by the
 * platform (a profit-based fee is refused, `pnlFeeForbidden`).
 *
 * Nothing here moves money or imports a ledger write.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { requireOperator } from '../admin/common.js';
import { CopyError } from './errors.js';

export interface MyPoolMasterApplication {
  readonly applicationId: string;
  readonly key: string;
  readonly state: 'applied';
  readonly nickname: string;
  readonly style: string;
  readonly appliedAt: string;
}

export interface PoolMasterApplicationView extends MyPoolMasterApplication {
  readonly userId: string;
}

/** One person on one pool's whitelist. No pool exists, so no row does. */
export interface PoolWhitelistRow {
  readonly poolId: string;
  readonly userId: string;
  readonly addedAt: string;
}

/** One pool's takeover on one day, under `pool.takeover:<poolId>:<day>`. No pool exists, so no row does. */
export interface PoolTakeoverRow {
  readonly key: string;
  readonly poolId: string;
  readonly day: string;
  readonly reason: string;
  readonly at: string;
}

export interface LeadLevelRow {
  readonly leaderRef: string;
  readonly displayName: string;
  readonly state: 'unlisted' | 'listed' | 'suspended' | 'delisted';
  /** Null: the platform does not measure a lead's record, so no level is computed. */
  readonly level: null;
}

export interface PooledDeskRead {
  /** Pools that exist: none, while INTAFACED holds no customer money (OWNER 226). */
  readonly pools: { readonly count: 0; readonly reason: 'custody_layer_off' };
  readonly masterApplications: readonly PoolMasterApplicationView[];
  readonly whitelists: { readonly batchLimit: number | null; readonly rows: readonly PoolWhitelistRow[] };
  readonly takeovers: { readonly rows: readonly PoolTakeoverRow[] };
  readonly levels: { readonly maxRatio: null; readonly rows: readonly LeadLevelRow[] };
}

export interface PooledDeskDeps {
  readonly sql: Sql;
  readonly now: () => Date;
  /** The owner's whitelist batch limit (TRADE_POOL_WHITELIST_BATCH_MAX). Null or omitted: unset. */
  readonly whitelistBatchMax?: number | null;
}

export const POOL_WHITELIST_BATCH_MAX_LIMIT = 1000;

/** The owner's whitelist batch limit from its env value: blank is unset (null); anything but 1..1000 stops the boot. */
export function parsePoolWhitelistBatchMax(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  return checkedBatchMax(/^\d+$/.test(value) ? Number(value) : Number.NaN);
}

function checkedBatchMax(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > POOL_WHITELIST_BATCH_MAX_LIMIT) {
    throw new Error(`TRADE_POOL_WHITELIST_BATCH_MAX must be a whole number, 1 to ${POOL_WHITELIST_BATCH_MAX_LIMIT}, or blank`);
  }
  return n;
}

/** The business key of a person's one master application. */
export const poolApplyKey = (userId: string): string => `pool.apply:${userId}`;

const NICKNAME_MAX = 80;
const STYLE_MAX = 280;
const LIST_MAX = 200;

const tidy = (value: string) => value.trim().replace(/\s+/g, ' ');

interface ApplicationRow {
  id: string;
  key: string;
  user_id: string;
  nickname: string;
  style: string;
  status: 'applied';
  created_at: Date;
}

function mine(row: ApplicationRow): MyPoolMasterApplication {
  return {
    applicationId: row.id,
    key: row.key,
    state: row.status,
    nickname: row.nickname,
    style: row.style,
    appliedAt: row.created_at.toISOString(),
  };
}

export class PooledDesk {
  private readonly batchMax: number | null;

  constructor(private readonly deps: PooledDeskDeps) {
    const n = deps.whitelistBatchMax ?? null;
    this.batchMax = n === null ? null : checkedBatchMax(n);
  }

  /** The caller's master application, or null. */
  async mine(principal: Principal): Promise<MyPoolMasterApplication | null> {
    const [row] = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_pool_master_applications WHERE key = ${poolApplyKey(principal.userId)}`;
    return row ? mine(row) : null;
  }

  /**
   * Apply to run a pooled strategy. The same nickname and style again answers the application already sent; anything
   * else after it refuses `trade.pool_master_application_open` and changes nothing.
   */
  async apply(principal: Principal, input: { nickname: string; style: string }): Promise<MyPoolMasterApplication> {
    const nickname = tidy(input.nickname);
    const style = tidy(input.style);
    if (nickname.length < 1 || nickname.length > NICKNAME_MAX) {
      throw new CopyError(`A nickname is required (1–${NICKNAME_MAX} characters)`, 'trade.pool_master_name_invalid');
    }
    if (style.length < 1 || style.length > STYLE_MAX) {
      throw new CopyError(`Describe your trading style (1–${STYLE_MAX} characters)`, 'trade.pool_master_style_invalid');
    }
    const key = poolApplyKey(principal.userId);
    const now = this.deps.now();
    await this.deps.sql`
      INSERT INTO trade.copy_pool_master_applications (id, key, user_id, nickname, style, status, created_at)
      VALUES (${randomUUID()}, ${key}, ${principal.userId}, ${nickname}, ${style}, 'applied', ${now.toISOString()})
      ON CONFLICT (key) DO NOTHING`;
    const [row] = await this.deps.sql<ApplicationRow[]>`SELECT * FROM trade.copy_pool_master_applications WHERE key = ${key}`;
    if (!row) throw new CopyError('The application was not saved', 'trade.copy_unavailable');
    if (row.nickname !== nickname || row.style !== style) {
      throw new CopyError('You have already applied to run a pool', 'trade.pool_master_application_open');
    }
    return mine(row);
  }

  /** What the founders read: master applications oldest first, whitelists, takeovers and lead levels. */
  async desk(principal: Principal): Promise<PooledDeskRead> {
    requireOperator(principal);
    const applications = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_pool_master_applications ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`;
    const leads = await this.deps.sql<Array<{ leader_ref: string; display_name: string; state: LeadLevelRow['state'] }>>`
      SELECT leader_ref, display_name, state FROM trade.copy_leader_listings
      ORDER BY display_name ASC, leader_ref ASC LIMIT ${LIST_MAX}`;
    return {
      pools: { count: 0, reason: 'custody_layer_off' },
      masterApplications: applications.map((r) => ({ ...mine(r), userId: r.user_id })),
      whitelists: { batchLimit: this.batchMax, rows: [] },
      takeovers: { rows: [] },
      levels: {
        maxRatio: null,
        rows: leads.map((l) => ({ leaderRef: l.leader_ref, displayName: l.display_name, state: l.state, level: null })),
      },
    };
  }
}
