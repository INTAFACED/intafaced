/**
 * Pooled masters, pool whitelists, takeovers and lead levels on the founders' copy desk (J-copy-bots-otc-10 #6, #7).
 *
 * - CB-copy-pro-share-11: a customer applies to run a pool (nickname, contact, style) under the business key
 *   `pool.apply:<userId>`; one open application per person, so the same submit again answers it. The founders read
 *   the applications oldest first.
 * - CB-copy-pro-share-06: whitelists per pool and UID, with the owner's import batch limit
 *   (TRADE_COPY_POOL_WHITELIST_BATCH_MAX; blank is "not set", never a default).
 * - CB-copy-pro-share-09: takeovers, one row per pool and day under `pool.takeover:<poolId>:<day>`, and the owner's
 *   thresholds (TRADE_COPY_POOL_TAKEOVER_NAV_FLOOR, TRADE_COPY_POOL_TAKEOVER_MARGIN_RATE_MAX; blank: no takeover runs).
 * - CB-copy-pro-share-03: each lead's computed level and the maximum profit-share ratio, which the platform never
 *   sets: `maxRatio` is always null, and setting one refuses `trade.copy_pnl_fee_forbidden`. The level computation is
 *   CB-copy-13's weekly job, not built yet, so every level reads null ("not computed") rather than an invented one.
 *
 * Pools themselves are not built (CB-copy-pro-share-04), so whitelists and takeovers read their honest empty state.
 * Nothing here moves money or imports a ledger write.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { requireOperator } from '../admin/common.js';
import { CopyError } from './errors.js';

export type PoolMasterStatus = 'applied' | 'approved' | 'rejected';

export interface PoolMasterApplicationView {
  readonly id: string;
  /** The business key the application was filed under: `pool.apply:<userId>`. */
  readonly key: string;
  readonly userId: string;
  readonly nickname: string;
  readonly contact: string;
  readonly style: string;
  readonly status: PoolMasterStatus;
  readonly appliedAt: string;
}

export interface MyPoolMasterApplication {
  readonly applicationId: string;
  readonly nickname: string;
  readonly status: PoolMasterStatus;
  readonly appliedAt: string;
}

export interface PoolWhitelistEntryView {
  readonly poolId: string;
  readonly investorUid: string;
  readonly state: 'active' | 'removed';
  readonly addedAt: string;
  readonly removedAt: string | null;
}

export interface PoolTakeoverView {
  readonly key: string;
  readonly poolId: string;
  readonly day: string;
  readonly trigger: 'nav_floor' | 'margin_rate';
  readonly at: string;
}

export interface LeadLevelView {
  readonly leaderRef: string;
  readonly displayName: string;
  /** The computed level (CB-copy-13), or null while it is not computed. */
  readonly level: string | null;
}

export interface PoolDeskRead {
  readonly pooledMasters: {
    readonly applications: PoolMasterApplicationView[];
    readonly whitelists: { readonly batchLimit: number | null; readonly entries: PoolWhitelistEntryView[] };
  };
  readonly takeovers: {
    readonly thresholds: { readonly navFloor: string | null; readonly marginRateMax: string | null };
    readonly rows: PoolTakeoverView[];
  };
  readonly levels: { readonly maxRatio: null; readonly rows: LeadLevelView[] };
}

/** The owner's values the desk shows. Each null is unset: shown as "not set", never filled with a default. */
export interface PoolOwnerValues {
  readonly whitelistBatchMax: number | null;
  readonly takeoverNavFloor: string | null;
  readonly takeoverMarginRateMax: string | null;
}

export interface PoolDeskDeps {
  readonly sql: Sql;
  readonly now: () => Date;
  readonly owner: PoolOwnerValues;
}

const LIST_MAX = 200;
const NICK_MAX = 80;
const CONTACT_MAX = 200;
const STYLE_MAX = 500;
/** The largest import batch the owner may set. */
export const POOL_WHITELIST_BATCH_CAP = 10_000;

/** The owner's whitelist batch limit from its env value: blank is unset (null); anything but a whole 1..10000 throws. */
export function parsePoolWhitelistBatchMax(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > POOL_WHITELIST_BATCH_CAP) {
    throw new Error(`TRADE_COPY_POOL_WHITELIST_BATCH_MAX must be a whole number, 1 to ${POOL_WHITELIST_BATCH_CAP}, or blank`);
  }
  return n;
}

/** A takeover threshold from its env value, kept as the decimal string it was set as: blank is unset (null). */
export function parsePoolTakeoverThreshold(name: string, raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) throw new Error(`${name} must be a decimal number, or blank`);
  return value;
}

export const poolApplyKey = (userId: string): string => `pool.apply:${userId}`;

function text(value: string, max: number, what: string, code: string): string {
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length < 1 || v.length > max) throw new CopyError(`${what} is required (1–${max} characters)`, code);
  return v;
}

interface ApplicationRow {
  id: string;
  request_key: string;
  user_id: string;
  nickname: string;
  contact: string;
  style: string;
  status: PoolMasterStatus;
  created_at: Date;
}

const mine = (r: ApplicationRow): MyPoolMasterApplication => ({
  applicationId: r.id,
  nickname: r.nickname,
  status: r.status,
  appliedAt: r.created_at.toISOString(),
});

export class PoolDesk {
  constructor(private readonly deps: PoolDeskDeps) {}

  /**
   * Apply to run a pool. One open application per person under `pool.apply:<userId>`: the same nickname again answers
   * it; another nickname while one is open refuses `trade.pool_application_open`.
   */
  async apply(principal: Principal, input: { nickname: string; contact: string; style: string }): Promise<MyPoolMasterApplication> {
    const nickname = text(input.nickname, NICK_MAX, 'Nickname', 'trade.pool_nickname_invalid');
    const contact = text(input.contact, CONTACT_MAX, 'Contact', 'trade.pool_contact_invalid');
    const style = text(input.style, STYLE_MAX, 'Trading style', 'trade.pool_style_invalid');
    const key = poolApplyKey(principal.userId);
    const now = this.deps.now().toISOString();
    // The open index on the key makes a second insert a no-op, so two submits at once keep one application.
    await this.deps.sql`
      INSERT INTO trade.copy_pool_master_applications (id, request_key, user_id, nickname, contact, style, status, created_at)
      VALUES (${randomUUID()}, ${key}, ${principal.userId}, ${nickname}, ${contact}, ${style}, 'applied', ${now})
      ON CONFLICT (request_key) WHERE status = 'applied' DO NOTHING`;
    const [open] = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_pool_master_applications WHERE request_key = ${key} AND status = 'applied'`;
    if (!open) throw new CopyError('The application was not recorded', 'trade.pool_application_unknown');
    if (open.nickname !== nickname) {
      throw new CopyError('An application to run a pool is already waiting under another nickname', 'trade.pool_application_open');
    }
    return mine(open);
  }

  /** The caller's newest application to run a pool, or null. */
  async mine(principal: Principal): Promise<MyPoolMasterApplication | null> {
    const [row] = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_pool_master_applications WHERE user_id = ${principal.userId}
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    return row ? mine(row) : null;
  }

  /** Everything the founders' pooled-master, whitelist, takeover and level views show, read from this service. */
  async read(principal: Principal): Promise<PoolDeskRead> {
    requireOperator(principal);
    const { sql, owner } = this.deps;
    const [applications, entries, takeovers, leads] = await Promise.all([
      sql<ApplicationRow[]>`
        SELECT * FROM trade.copy_pool_master_applications ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`,
      sql<Array<{ pool_id: string; investor_uid: string; state: 'active' | 'removed'; added_at: Date; removed_at: Date | null }>>`
        SELECT pool_id, investor_uid, state, added_at, removed_at FROM trade.copy_pool_whitelist
        ORDER BY pool_id ASC, added_at ASC, investor_uid ASC LIMIT ${LIST_MAX}`,
      sql<Array<{ takeover_key: string; pool_id: string; day: string; trigger: 'nav_floor' | 'margin_rate'; created_at: Date }>>`
        SELECT takeover_key, pool_id, to_char(day, 'YYYY-MM-DD') AS day, trigger, created_at FROM trade.copy_pool_takeovers
        ORDER BY day DESC, pool_id ASC LIMIT ${LIST_MAX}`,
      sql<Array<{ leader_ref: string; display_name: string }>>`
        SELECT leader_ref, display_name FROM trade.copy_leader_listings
        ORDER BY state_changed_at DESC, leader_ref ASC LIMIT ${LIST_MAX}`,
    ]);
    return {
      pooledMasters: {
        applications: applications.map((r) => ({
          id: r.id,
          key: r.request_key,
          userId: r.user_id,
          nickname: r.nickname,
          contact: r.contact,
          style: r.style,
          status: r.status,
          appliedAt: r.created_at.toISOString(),
        })),
        whitelists: {
          batchLimit: owner.whitelistBatchMax,
          entries: entries.map((e) => ({
            poolId: e.pool_id,
            investorUid: e.investor_uid,
            state: e.state,
            addedAt: e.added_at.toISOString(),
            removedAt: e.removed_at?.toISOString() ?? null,
          })),
        },
      },
      takeovers: {
        thresholds: { navFloor: owner.takeoverNavFloor, marginRateMax: owner.takeoverMarginRateMax },
        rows: takeovers.map((t) => ({
          key: t.takeover_key,
          poolId: t.pool_id,
          day: t.day,
          trigger: t.trigger,
          at: t.created_at.toISOString(),
        })),
      },
      // CB-copy-13's weekly level job is not built: no level is computed, so none is shown.
      levels: { maxRatio: null, rows: leads.map((l) => ({ leaderRef: l.leader_ref, displayName: l.display_name, level: null })) },
    };
  }

  /** A maximum profit-share ratio is the owner's to forbid, and is forbidden (copy-policy pnlFeeForbidden): always refused. */
  setMaxRatio(principal: Principal): never {
    requireOperator(principal);
    throw new CopyError('The platform does not set a maximum profit-share ratio', 'trade.copy_pnl_fee_forbidden');
  }
}
