/**
 * Append-only mirror trail. A refusal stores its stable code, never the
 * internal sentence. Replay of the same leader fill inserts nothing new.
 *
 * Divergence is the signed follower-order price minus the leader fill price,
 * and that difference in whole basis points. No tolerance is applied. The
 * number is only recorded.
 *
 * Whole basis points, half away from zero:
 *   sign(diff) * floor((|diff| * 10000 + leaderPrice / 2) / leaderPrice)
 * Both prices are scaled 1e18, so the scale cancels. A zero leader price
 * cannot be divided; basis points stay null and the code names that.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { div, formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { requireCopyFollowId } from './copy-lifecycle.js';
import { CopyError } from './errors.js';
import { canonicalizeCopyFillId } from './fee-share.js';
import type { CopyFollowStore } from './follow-store.js';

export const MIRROR_EVENT_KINDS = ['intent', 'planned', 'placed', 'partial', 'filled', 'rejected', 'skipped', 'divergence'] as const;
export type MirrorEventKind = (typeof MIRROR_EVENT_KINDS)[number];

export const TRADE_COPY_DIVERGENCE_BASIS_UNSET = 'trade.copy_divergence_basis_unset' as const;

export interface MirrorEventDraft {
  readonly followId: string;
  readonly leaderFillId: string;
  readonly kind: MirrorEventKind;
  readonly followerOrderId?: string | null;
  readonly followerFillId?: string | null;
  readonly quantity?: Amount | null;
  readonly price?: Amount | null;
  readonly basisPoints?: bigint | null;
  readonly code?: string | null;
  readonly at: Date;
}

/** A `skipped` step as the skip log reads it: the leader fill, the reason id kept in `code`, and when. */
export interface MirrorSkipRecord {
  readonly leaderFillId: string;
  readonly code: string | null;
  readonly at: Date;
}

export interface MirrorEventLog {
  append(draft: MirrorEventDraft): Promise<'inserted' | 'replay'>;
  /** This follow's `skipped` steps, newest first, at most `limit`. */
  listSkips(followId: string, limit: number): Promise<MirrorSkipRecord[]>;
}

interface MemoryRow extends MirrorEventDraft {
  readonly eventId: string;
  readonly seq: number;
}

export class MemoryMirrorEventLog implements MirrorEventLog {
  private readonly rows: MemoryRow[] = [];
  private seq = 0;

  async append(draft: MirrorEventDraft): Promise<'inserted' | 'replay'> {
    if (this.rows.some((row) => sameEvent(row, draft))) return 'replay';
    this.seq += 1;
    this.rows.push({ ...draft, eventId: randomUUID(), seq: this.seq });
    return 'inserted';
  }

  async listSkips(followId: string, limit: number): Promise<MirrorSkipRecord[]> {
    return this.rows
      .filter((row) => row.followId === followId && row.kind === 'skipped')
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.seq - a.seq)
      .slice(0, limit)
      .map((row) => ({ leaderFillId: row.leaderFillId, code: row.code ?? null, at: row.at }));
  }
}

function sameEvent(row: MirrorEventDraft, draft: MirrorEventDraft): boolean {
  if (row.followId !== draft.followId || row.leaderFillId !== draft.leaderFillId || row.kind !== draft.kind) return false;
  if (draft.kind === 'partial' || draft.kind === 'filled') return row.followerFillId === draft.followerFillId;
  return true;
}

export class SqlMirrorEventLog implements MirrorEventLog {
  constructor(private readonly sql: Sql) {}

  async append(draft: MirrorEventDraft): Promise<'inserted' | 'replay'> {
    const inserted = await this.sql<Array<{ event_id: string }>>`
      INSERT INTO copy_mirror_events (
        event_id, follow_id, leader_fill_id, kind, follower_order_id, follower_fill_id,
        quantity, price, basis_points, code, occurred_at
      ) VALUES (
        ${randomUUID()},
        ${draft.followId},
        ${draft.leaderFillId},
        ${draft.kind},
        ${draft.followerOrderId ?? null},
        ${draft.followerFillId ?? null},
        ${draft.quantity == null ? null : formatAmount(draft.quantity)},
        ${draft.price == null ? null : formatAmount(draft.price)},
        ${draft.basisPoints == null ? null : draft.basisPoints.toString()},
        ${draft.code ?? null},
        ${draft.at}
      )
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `;
    return inserted.length > 0 ? 'inserted' : 'replay';
  }

  async listSkips(followId: string, limit: number): Promise<MirrorSkipRecord[]> {
    const rows = await this.sql<Array<{ leader_fill_id: string; code: string | null; occurred_at: Date }>>`
      SELECT leader_fill_id, code, occurred_at
        FROM copy_mirror_events
       WHERE follow_id = ${followId} AND kind = 'skipped'
       ORDER BY occurred_at DESC, seq DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      leaderFillId: row.leader_fill_id,
      code: row.code,
      at: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
    }));
  }
}

/** Signed follower order price minus leader fill price, and whole basis points. */
export function mirrorDivergence(
  followerPrice: Amount,
  leaderPrice: Amount,
): { price: Amount; basisPoints: bigint | null; code: string | null } {
  const price = sub(followerPrice, leaderPrice);
  if (leaderPrice === 0n) {
    return { price, basisPoints: null, code: TRADE_COPY_DIVERGENCE_BASIS_UNSET };
  }
  return { price, basisPoints: wholeBasisPoints(price, leaderPrice), code: null };
}

export function wholeBasisPoints(diff: Amount, leaderPrice: Amount): bigint {
  if (leaderPrice === 0n) {
    throw new Error('leader price is zero — basis points are unset, not estimated');
  }
  const negative = diff < 0n;
  const magnitude = negative ? -diff : diff;
  const numerator = magnitude * 10_000n;
  const half = leaderPrice / 2n;
  const rounded = (numerator + half) / leaderPrice;
  return negative ? -rounded : rounded;
}

function leaderFillKey(fillId: string): string | null {
  const trimmed = fillId.trim();
  if (!trimmed || trimmed.length > 128) return null;
  try {
    return canonicalizeCopyFillId(trimmed);
  } catch {
    return null;
  }
}

/**
 * Trail rows are evidence on the follower's own follow. A missing follow, or
 * one owned by someone else, records nothing — including `trade.copy_not_following`.
 * The call still throws whatever `run` throws.
 */
async function callerOwnsFollow(store: CopyFollowStore, principal: Principal, followId: string): Promise<boolean> {
  let id: string;
  try {
    id = requireCopyFollowId(followId);
  } catch {
    return false;
  }
  const follow = await store.getFollow(id);
  return follow !== null && follow.followerId === principal.userId;
}

async function appendRefusal(events: MirrorEventLog, followId: string, fillId: string, err: unknown, at: Date): Promise<void> {
  if (!(err instanceof CopyError) || err.code === 'trade.copy_not_following') return;
  const leaderFillId = leaderFillKey(fillId);
  if (!leaderFillId || !followId.trim()) return;
  await events.append({
    followId,
    leaderFillId,
    kind: 'rejected',
    code: err.code,
    at,
  });
}

export async function recordPlanMirrorEvents<T extends { qty: string; notional: string; fillId: string }>(
  events: MirrorEventLog,
  store: CopyFollowStore,
  principal: Principal,
  input: { followId: string; fillId: string },
  at: Date,
  run: () => Promise<T>,
): Promise<T> {
  const owned = await callerOwnsFollow(store, principal, input.followId);
  const leaderFillId = leaderFillKey(input.fillId);
  if (owned && leaderFillId) {
    await events.append({ followId: input.followId, leaderFillId, kind: 'intent', at });
  }
  try {
    const planned = await run();
    if (owned) {
      const qty = parseAmount(planned.qty);
      const notional = parseAmount(planned.notional);
      await events.append({
        followId: input.followId,
        leaderFillId: planned.fillId,
        kind: 'planned',
        quantity: qty,
        price: div(notional, qty, 'half-up'),
        at,
      });
    }
    return planned;
  } catch (err) {
    if (owned) await appendRefusal(events, input.followId, input.fillId, err, at);
    throw err;
  }
}

export async function recordPlaceMirrorEvents<T extends { fillId: string; orderId: string; qty: string; price: string }>(
  events: MirrorEventLog,
  store: CopyFollowStore,
  principal: Principal,
  input: { followId: string; fillId: string },
  at: Date,
  run: () => Promise<T>,
): Promise<T> {
  const owned = await callerOwnsFollow(store, principal, input.followId);
  try {
    const placed = await run();
    if (!owned) return placed;
    const followerPrice = parseAmount(placed.price);
    const qty = parseAmount(placed.qty);
    await events.append({
      followId: input.followId,
      leaderFillId: placed.fillId,
      kind: 'placed',
      followerOrderId: placed.orderId,
      quantity: qty,
      price: followerPrice,
      at,
    });
    const plan = await store.getMirroredFill(input.followId, placed.fillId);
    if (plan && plan.qty > 0n) {
      const leaderPrice = div(plan.notional, plan.qty, 'half-up');
      const divergence = mirrorDivergence(followerPrice, leaderPrice);
      await events.append({
        followId: input.followId,
        leaderFillId: placed.fillId,
        kind: 'divergence',
        followerOrderId: placed.orderId,
        price: divergence.price,
        basisPoints: divergence.basisPoints,
        code: divergence.code,
        at,
      });
    }
    return placed;
  } catch (err) {
    if (owned) await appendRefusal(events, input.followId, input.fillId, err, at);
    throw err;
  }
}

export interface CopyMirrorFillNotice {
  readonly orderId: string;
  readonly fillId: string;
  readonly side: 'buy' | 'sell';
  readonly price: Amount;
  readonly qty: Amount;
}

/** Record partial or filled once the follower order's fill is on trade.fills. */
export async function observeCopyMirrorFill(sql: Sql, events: MirrorEventLog, notice: CopyMirrorFillNotice, at: Date): Promise<void> {
  const placed = await sql<Array<{ follow_id: string; fill_id: string }>>`
    SELECT follow_id, fill_id
      FROM copy_placed_mirrors
     WHERE order_id = ${notice.orderId}
     LIMIT 1
  `;
  const row = placed[0];
  if (!row) return;
  const orders = await sql<Array<{ qty: string }>>`
    SELECT qty::text AS qty FROM trade.orders WHERE id = ${notice.orderId}::uuid LIMIT 1
  `;
  const filled = await sql<Array<{ qty: string }>>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty FROM trade.fills WHERE order_id = ${notice.orderId}::uuid
  `;
  const orderQty = orders[0] ? parseAmount(orders[0].qty) : null;
  const filledQty = parseAmount(filled[0]?.qty ?? '0');
  const kind: MirrorEventKind = orderQty !== null && filledQty >= orderQty ? 'filled' : 'partial';
  await events.append({
    followId: row.follow_id,
    leaderFillId: row.fill_id,
    kind,
    followerOrderId: notice.orderId,
    followerFillId: notice.fillId,
    quantity: notice.qty,
    price: notice.price,
    at,
  });
}
