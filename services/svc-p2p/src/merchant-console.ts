import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { P2pError, type OfferRecord } from './p2p-service.js';

/**
 * P-ads-merchant-08 (J-p2p-05 #4): the merchant console. A person's presence (online, offline, or a weekly schedule in
 * their own time zone) decides whether their ads are on the board; open orders carry on either way. The to-do list
 * reads the person's own open orders and disputes into typed items with a deadline and a link, soonest first. Bulk
 * actions pause, resume or remove several ads at once, each ad answering for itself, and a repeat with the same key
 * answers the same results and changes nothing.
 */

export const PRESENCE_MODES = ['online', 'offline', 'scheduled'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

/** A weekly window: ISO day (1 Monday … 7 Sunday), from `start` up to `end` ("24:00" is the end of the day). */
export interface PresenceWindow {
  day: number;
  start: string;
  end: string;
}

export interface Presence {
  mode: PresenceMode;
  timezone: string;
  windows: PresenceWindow[];
  /** Whether the person's ads are on the board now. */
  onBoard: boolean;
  /** On a schedule: when the board next changes (the open window's end, or the next window's start); else null. */
  nextChangeAt: Date | null;
  updatedAt: Date | null;
}

/** Most windows one schedule may hold: four a day. */
export const MAX_PRESENCE_WINDOWS = 28;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutes = (hhmm: string): number => (hhmm === '24:00' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

function scheduleInvalid(why: string): P2pError {
  return new P2pError(`The schedule is not valid: ${why}`, 'p2p.schedule_invalid');
}

/** Checks a schedule: real days and times, each window ending after it starts, none overlapping on one day. */
export function assertSchedule(windows: PresenceWindow[]): PresenceWindow[] {
  if (windows.length === 0) throw scheduleInvalid('a schedule needs at least one window');
  if (windows.length > MAX_PRESENCE_WINDOWS) throw scheduleInvalid(`at most ${MAX_PRESENCE_WINDOWS} windows`);
  for (const w of windows) {
    if (!Number.isInteger(w.day) || w.day < 1 || w.day > 7) throw scheduleInvalid('a day is 1 (Monday) to 7 (Sunday)');
    if (!HHMM.test(w.start)) throw scheduleInvalid('a start is HH:MM');
    if (!(HHMM.test(w.end) || w.end === '24:00')) throw scheduleInvalid('an end is HH:MM or 24:00');
    if (minutes(w.end) <= minutes(w.start)) throw scheduleInvalid('a window ends after it starts; split one that crosses midnight');
  }
  const sorted = [...windows].sort((a, b) => a.day - b.day || minutes(a.start) - minutes(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.day === cur.day && minutes(cur.start) < minutes(prev.end)) throw scheduleInvalid('two windows overlap on one day');
  }
  return sorted.map((w) => ({ day: w.day, start: w.start, end: w.end }));
}

interface PresenceRow {
  mode: PresenceMode;
  timezone: string;
  windows: PresenceWindow[];
  updated_at: Date;
  on_board: boolean;
  next_change_at: Date | null;
}

/** Reads a person's presence; no row is online. */
export async function readPresence(sql: Sql, userId: string): Promise<Presence> {
  const [row] = await sql<PresenceRow[]>`
    SELECT mp.mode, mp.timezone, mp.windows, mp.updated_at,
           p2p.maker_on_board(mp.user_id, now()) AS on_board,
           CASE WHEN mp.mode <> 'scheduled' THEN NULL ELSE (
             SELECT min(edge) FROM (
               SELECT ((((now() AT TIME ZONE mp.timezone)::date + d) + (w->>side)::time) AT TIME ZONE mp.timezone) AS edge
                 FROM generate_series(0, 7) d,
                      jsonb_array_elements(mp.windows) w,
                      (VALUES ('start'), ('end')) s(side)
                WHERE extract(isodow FROM ((now() AT TIME ZONE mp.timezone)::date + d))::int = (w->>'day')::int
             ) edges
              WHERE edge > now()
                -- A window's end that is the next window's start is no change.
                AND p2p.presence_open(mp.timezone, mp.windows, edge) <> p2p.presence_open(mp.timezone, mp.windows, now())
           ) END AS next_change_at
      FROM p2p.merchant_presence mp
     WHERE mp.user_id = ${userId}
  `;
  if (!row) return { mode: 'online', timezone: 'UTC', windows: [], onBoard: true, nextChangeAt: null, updatedAt: null };
  return {
    mode: row.mode,
    timezone: row.timezone,
    windows: row.windows,
    onBoard: row.on_board,
    nextChangeAt: row.next_change_at,
    updatedAt: row.updated_at,
  };
}

/** Sets a person's presence. A schedule needs a real IANA time zone and valid windows; online and offline keep none. */
export async function setPresence(
  sql: Sql,
  userId: string,
  input: { mode: PresenceMode; timezone?: string | null; windows?: PresenceWindow[] | null },
): Promise<Presence> {
  const timezone = input.timezone ?? 'UTC';
  const [zone] = await sql<Array<{ name: string }>>`SELECT name FROM pg_timezone_names WHERE name = ${timezone}`;
  if (!zone) throw scheduleInvalid(`${timezone} is not a time zone`);
  const windows = input.mode === 'scheduled' ? assertSchedule(input.windows ?? []) : [];
  await sql`
    INSERT INTO p2p.merchant_presence (user_id, mode, timezone, windows, updated_at)
    VALUES (${userId}, ${input.mode}, ${timezone}, ${sql.json(windows as never)}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET mode = EXCLUDED.mode, timezone = EXCLUDED.timezone, windows = EXCLUDED.windows, updated_at = now()
  `;
  return readPresence(sql, userId);
}

export const TODO_KINDS = ['payment_required', 'release_required', 'counterparty_action', 'dispute_open'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];

export interface TodoItem {
  kind: TodoKind;
  tradeId: string;
  role: 'buyer' | 'seller';
  status: string;
  asset: string;
  amount: string;
  fiatCurrency: string;
  fiatAmount: string;
  /** When this item's clock runs out: the order's own deadline, or the dispute's for a disputed order. */
  deadlineAt: Date | null;
  /** Where the person answers it. */
  link: string;
}

interface TodoRow {
  id: string;
  buyer_id: string;
  seller_id: string;
  status: string;
  asset: string;
  amount: string;
  fiat_currency: string;
  fiat_amount: string;
  deadline_at: Date | null;
}

/**
 * The person's own open orders that wait on someone, soonest deadline first (no deadline last, then oldest first):
 * pay (buyer, escrowed), release (seller, paid), the other side's move, and an open dispute with its moderator deadline.
 */
export async function listTodos(sql: Sql, userId: string, limit: number): Promise<TodoItem[]> {
  const rows = await sql<TodoRow[]>`
    SELECT t.id, t.buyer_id, t.seller_id, t.status::text AS status, t.asset, t.amount::text AS amount,
           t.fiat_currency, t.fiat_amount::text AS fiat_amount,
           CASE WHEN t.status = 'disputed' THEN d.deadline_at ELSE t.deadline_at END AS deadline_at
      FROM p2p.p2p_trades t
      LEFT JOIN p2p.disputes d ON d.trade_id = t.id AND d.status = 'open'
     WHERE (t.buyer_id = ${userId} OR t.seller_id = ${userId})
       AND t.status IN ('escrowed', 'fiat_sent', 'disputed')
     ORDER BY 9 ASC NULLS LAST, t.created_at ASC, t.id ASC
     LIMIT ${limit}
  `;
  return rows.map((row) => {
    const role = row.buyer_id === userId ? 'buyer' : 'seller';
    const kind: TodoKind =
      row.status === 'disputed'
        ? 'dispute_open'
        : row.status === 'escrowed'
          ? role === 'buyer'
            ? 'payment_required'
            : 'counterparty_action'
          : role === 'seller'
            ? 'release_required'
            : 'counterparty_action';
    return {
      kind,
      tradeId: row.id,
      role,
      status: row.status,
      asset: row.asset,
      amount: row.amount,
      fiatCurrency: row.fiat_currency,
      fiatAmount: row.fiat_amount,
      deadlineAt: row.deadline_at,
      link: `/uc/order?tradeId=${row.id}`,
    };
  });
}

export const BULK_ACTIONS = ['pause', 'resume', 'remove'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Most ads one bulk action may name, or reach with `all`. */
export const MAX_BULK_OFFERS = 100;

export interface BulkResult {
  offerId: string;
  ok: boolean;
  /** The ad's status after the action, when it succeeded. */
  status: OfferRecord['status'] | null;
  /** Why this ad was refused, when it was. */
  code: string | null;
}

export interface BulkOutcome {
  action: BulkAction;
  results: BulkResult[];
  /** True when this answers an earlier run with the same key; nothing changed this time. */
  replayed: boolean;
}

interface BulkDoors {
  pause(offerId: string, makerId: string): Promise<OfferRecord>;
  resume(offerId: string, makerId: string): Promise<OfferRecord>;
  close(offerId: string, makerId: string): Promise<OfferRecord>;
}

/**
 * Pauses, resumes or removes (closes) several of the caller's ads. `all` reaches every ad the action applies to (active
 * to pause, paused to resume, either to remove), at most `MAX_BULK_OFFERS`. Each ad goes through the same door as a
 * single action, in its own transaction, and answers for itself: a closed ad refuses `p2p.offer_closed`, another's ad
 * `p2p.not_a_party`. The key is answered once: the same key and request return the stored results; the same key with
 * another request refuses `p2p.idempotency_conflict`.
 */
export async function bulkOffers(
  sql: Sql,
  doors: BulkDoors,
  input: { makerId: string; action: BulkAction; offerIds?: string[] | null; all?: boolean; idempotencyKey: string },
): Promise<BulkOutcome> {
  const scope = input.all ? 'all' : [...new Set(input.offerIds ?? [])].sort();
  if (scope !== 'all' && scope.length === 0) throw new P2pError('Name at least one ad, or all', 'p2p.bulk_scope_invalid');
  if (scope !== 'all' && scope.length > MAX_BULK_OFFERS) {
    throw new P2pError(`At most ${MAX_BULK_OFFERS} ads at once`, 'p2p.bulk_scope_invalid');
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ action: input.action, scope }))
    .digest('hex');
  const [claimed] = await sql<Array<{ maker_id: string }>>`
    INSERT INTO p2p.offer_bulk_runs (maker_id, idempotency_key, request_hash, action)
    VALUES (${input.makerId}, ${input.idempotencyKey}, ${requestHash}, ${input.action})
    ON CONFLICT (maker_id, idempotency_key) DO NOTHING
    RETURNING maker_id
  `;
  if (!claimed) {
    const [prior] = await sql<Array<{ request_hash: string; results: BulkResult[] | null }>>`
      SELECT request_hash, results FROM p2p.offer_bulk_runs
       WHERE maker_id = ${input.makerId} AND idempotency_key = ${input.idempotencyKey}
    `;
    if (!prior || prior.request_hash !== requestHash) {
      throw new P2pError('This key was used for another bulk action', 'p2p.idempotency_conflict');
    }
    if (prior.results === null) throw new P2pError('This bulk action is still running', 'p2p.idempotency_in_progress');
    return { action: input.action, results: prior.results, replayed: true };
  }
  try {
    const ids =
      scope === 'all'
        ? (
            await sql<Array<{ id: string }>>`
              SELECT id FROM p2p.offers
               WHERE maker_id = ${input.makerId}
                 AND status = ANY(${input.action === 'pause' ? ['active'] : input.action === 'resume' ? ['paused'] : ['active', 'paused']})
               ORDER BY created_at, id
               LIMIT ${MAX_BULK_OFFERS}
            `
          ).map((row) => row.id)
        : scope;
    const results: BulkResult[] = [];
    for (const offerId of ids) results.push(await bulkOne(sql, doors, input.makerId, input.action, offerId));
    await sql`
      UPDATE p2p.offer_bulk_runs SET results = ${sql.json(results as never)}
       WHERE maker_id = ${input.makerId} AND idempotency_key = ${input.idempotencyKey}
    `;
    return { action: input.action, results, replayed: false };
  } catch (err) {
    // Nothing was answered under this key: free it so a retry runs. Ads already changed stay changed, and each door is
    // idempotent for an ad already in the asked state.
    await sql`
      DELETE FROM p2p.offer_bulk_runs
       WHERE maker_id = ${input.makerId} AND idempotency_key = ${input.idempotencyKey} AND results IS NULL
    `;
    throw err;
  }
}

async function bulkOne(sql: Sql, doors: BulkDoors, makerId: string, action: BulkAction, offerId: string): Promise<BulkResult> {
  const [row] = await sql<Array<{ maker_id: string; status: OfferRecord['status'] }>>`
    SELECT maker_id, status FROM p2p.offers WHERE id = ${offerId}
  `;
  if (!row) return { offerId, ok: false, status: null, code: 'p2p.offer_not_found' };
  if (row.maker_id !== makerId) return { offerId, ok: false, status: null, code: 'p2p.not_a_party' };
  if (row.status === 'closed' && action !== 'remove') return { offerId, ok: false, status: null, code: 'p2p.offer_closed' };
  try {
    const done =
      action === 'pause'
        ? await doors.pause(offerId, makerId)
        : action === 'resume'
          ? await doors.resume(offerId, makerId)
          : await doors.close(offerId, makerId);
    return { offerId, ok: true, status: done.status, code: null };
  } catch (err) {
    if (err instanceof P2pError) return { offerId, ok: false, status: null, code: err.code };
    // Other typed refusals (a resume whose floating price has no reference, or whose method has no destination).
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('p2p.')) return { offerId, ok: false, status: null, code };
    throw err;
  }
}
