import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ChannelId, RefusalCode } from './channels/channel.js';

/**
 * PERSISTENCE FOR CHANNELS — who we may contact, and what actually happened.
 *
 * Two tables, and the split between them is the whole design:
 *
 *   channel_targets   an address the USER gave us and CONFIRMED. svc-notify
 *                     owns this rather than reading svc-identity's `users.email`,
 *                     because §2 forbids reaching into another service's tables
 *                     and because a login address is not consent to be texted.
 *
 *   deliveries        one row per (notification, channel) — the attempt AND the
 *                     outcome, kept apart. `attempted_at` says we tried;
 *                     `accepted_at` says a transport took it. A message that was
 *                     never accepted can never read as accepted, because there
 *                     is no single column that would let it.
 *
 * Both stores come in a memory pair for tests and a Postgres pair for prod, the
 * same shape as `store.ts`, so the suite needs no database.
 */

export type DeliveryStatus =
  /** Claimed for an attempt. In flight, or the process died mid-attempt. */
  | 'pending'
  /** A transport accepted it. The only status that may read as "the user was told". */
  | 'accepted'
  /** Declined before attempting anything. `refusalCode` says why. Terminal. */
  | 'refused'
  /** Attempted, did not work, will be tried again. */
  | 'failed'
  /** Attempted, did not work, will NOT be tried again. Terminal and stated. */
  | 'abandoned';

/**
 * How long a successful claim owns a pending row before another replica may
 * re-claim it (crash recovery).
 *
 * Two bounds decide this, and they pull opposite ways:
 *
 *   at least  the longest a single attempt can take — `NOTIFY_GATEWAY_TIMEOUT_MS`
 *             — or a lease expires under a sender that is merely slow, and the
 *             double-send this lease exists to stop comes back.
 *   at most   the bus `ack_wait` (30s, `packages/events/src/jetstream-bus.ts`) —
 *             or the natural redelivery of a crashed sender's message arrives
 *             while the lease is still live and can do nothing but nak again.
 *
 * `index.ts` derives it from the configured gateway timeout for that reason
 * rather than taking this default, which only covers callers that build a store
 * by hand. The env schema caps the timeout at `MAX_GATEWAY_TIMEOUT_MS` (25s)
 * so every legal value still has a covering lease under `ack_wait`.
 */
export const DEFAULT_CLAIM_LEASE_MS = 15_000;

/**
 * JetStream bus `ack_wait` default (packages/events jetstream-bus).
 * A claim lease must stay strictly under this or redelivery naks forever while
 * the holder is still alive.
 */
export const BUS_ACK_WAIT_MS = 30_000;

/**
 * Slack under `ack_wait` so a redelivery of a crashed holder can reclaim before
 * the bus parks the message. Production lease is
 * `min(gatewayTimeoutMs * 2, BUS_ACK_WAIT_MS - CLAIM_LEASE_ACK_SLACK_MS)`.
 */
export const CLAIM_LEASE_ACK_SLACK_MS = 5_000;

/**
 * Hard ceiling on `NOTIFY_GATEWAY_TIMEOUT_MS`.
 *
 * Equals the claim-lease ceiling (`ack_wait − slack`). Above this, no lease
 * length can both (a) outlast one gateway attempt and (b) stay under bus
 * `ack_wait` for reclaim. The env schema used to allow 30s — then
 * `claimLeaseMsFromGatewayTimeout(30_000)` returned 25s and a slow attempt
 * could still be mid-POST when a replica reclaimed the same delivery row
 * (double free SMS). Cap the env so every legal timeout has a covering lease.
 */
export const MAX_GATEWAY_TIMEOUT_MS = BUS_ACK_WAIT_MS - CLAIM_LEASE_ACK_SLACK_MS;

/**
 * Production claim-lease length from the gateway timeout.
 *
 * At least long enough for one attempt (`timeout × 2` covers the attempt plus
 * settle). At most under bus `ack_wait` so a dead holder never blocks reclaim
 * for a full redelivery window. Paired with `MAX_GATEWAY_TIMEOUT_MS`: every
 * legal timeout yields `lease ≥ timeout` and `lease < ack_wait`.
 */
export function claimLeaseMsFromGatewayTimeout(gatewayTimeoutMs: number): number {
  const fromTimeout = Math.max(1, Math.floor(gatewayTimeoutMs) * 2);
  return Math.min(fromTimeout, MAX_GATEWAY_TIMEOUT_MS);
}

/**
 * How often the delivery sweep runs — see `DeliveryStore.reapExhausted`.
 *
 * One minute, and the exact number does not matter much: the rows it retires
 * are already finished, so the interval only decides how long a finished row
 * reads as `pending`. Short enough that a person checking whether their margin
 * call went out gets the truth within a minute of it becoming true; long enough
 * that the sweep is invisible next to the traffic.
 */
export const DELIVERY_REAP_INTERVAL_MS = 60_000;

/**
 * How long after a claim lease dies we wait before abandoning a still-`pending`
 * row even when `attempts < maxAttempts`.
 *
 * WHY THIS EXISTS
 *
 * The `in_flight` path returns retryable WITHOUT incrementing `attempts` —
 * deliberately, so two replicas do not stack a double send. Each such pass
 * still burns one bus delivery. With bus `maxDeliver` 5 and
 * `NOTIFY_MAX_DELIVERY_ATTEMPTS` 3, sustained lease contention burns every bus
 * delivery while `attempts` stays at 1–2. JetStream then parks the message, and
 * the attempts-ceiling arm of `reapExhausted` never fires. The row sits
 * `pending` forever — the exact lie the sweep exists to remove, reached through
 * a different door (closeout: LANE-CLOSEOUT-OPS-2026-08-08).
 *
 * Bound: bus default `maxDeliver` (5) × `ack_wait` (30s) = 150s. After the
 * lease has been dead that long, the bus cannot still be retrying in a way that
 * would reclaim the row — any redelivery that was coming would already have
 * arrived and reclaimed. Waiting that window is how we know nobody is coming
 * back, without throwing away a retry the user is still owed.
 *
 * Paired with `DEFAULT_CLAIM_LEASE_MS` / the configured lease: a live lease is
 * never touched; only dead leases past this grace are candidates.
 */
export const STUCK_PENDING_GRACE_MS = 5 * 30_000;

export interface ReapExhaustedOptions {
  /**
   * Override for the stuck-pending grace (tests with a driven clock). Production
   * uses `STUCK_PENDING_GRACE_MS`.
   */
  readonly stuckGraceMs?: number;
}

export interface DeliveryRecord {
  id: string;
  notificationId: string;
  channel: ChannelId;
  status: DeliveryStatus;
  /** How many times a send was claimed. Bounded by `maxAttempts`. */
  attempts: number;
  /** When a send was last actually attempted. NULL on a pure refusal — nothing was tried. */
  attemptedAt: Date | null;
  /** When a transport accepted it. NULL unless `status === 'accepted'`. */
  acceptedAt: Date | null;
  /**
   * Exclusive claim window. While status is pending and this is in the future,
   * another claim must not re-own the row (two-replica double-send guard).
   * NULL means no active lease (legacy rows / settled).
   */
  leaseUntil: Date | null;
  refusalCode: RefusalCode | null;
  /** Free text from the transport, truncated. Never shown as user copy. */
  detail: string | null;
  /** The transport's own handle, when it gives one. */
  reference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelTarget {
  userId: string;
  channel: ChannelId;
  address: string;
  locale: string;
  /** NULL means never confirmed — and nothing is ever sent to an unconfirmed address. */
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClaimResult =
  | { claimed: true; id: string; attempt: number }
  | {
      claimed: false;
      reason: 'already_accepted' | 'terminal' | 'exhausted' | 'in_flight' | 'receipt_pending';
      record: DeliveryRecord;
    };

export interface SettleInput {
  id: string;
  /**
   * Wave 13 L12: ownership by attempt. A late settle from a reclaimed
   * attempt must not overwrite the live attempt's row (multi-replica free SMS
   * / status corruption when lease expired mid-gateway).
   */
  attempt: number;
  status: Exclude<DeliveryStatus, 'pending'>;
  refusalCode?: RefusalCode | null;
  detail?: string | null;
  reference?: string | null;
  /** Set when a send was genuinely attempted. Left alone on a refusal. */
  attempted: boolean;
}

/**
 * The gateway already returned a receipt and `accepted` has not been written.
 *
 * `reference` is the transport's handle, or null when it gave none. Callers
 * must pass that value through. A stand-in reference would claim a receipt
 * the gateway did not return.
 */
export interface NoteReceiptInput {
  id: string;
  /** Ownership by attempt, same rule as `settle`. */
  attempt: number;
  reference: string | null;
}

/** The cursor id is not a finished delivery owned by this caller. */
export class OwnedRecentCursorError extends Error {
  readonly code = 'notify.recent_deliveries_cursor_invalid' as const;

  constructor() {
    super('notify.recent_deliveries_cursor_invalid');
    this.name = 'OwnedRecentCursorError';
  }
}

export interface OwnedRecentQuery {
  readonly userId: string;
  readonly limit: number;
  /**
   * Last delivery id of the previous page. Null on the first page.
   * The store compares `(created_at, id)` against that row inside its own engine,
   * so a timestamp is never round-tripped through a millisecond clock.
   */
  readonly beforeId: string | null;
  readonly belongsTo?: (notificationId: string) => Promise<boolean>;
}

export interface DeliveryStore {
  /**
   * Take exclusive ownership of the next attempt for this (notification, channel).
   *
   * This is the idempotency guard. At-least-once bus delivery means this runs
   * twice for the same business event; the second call must not produce a second
   * email. A single atomic upsert decides — never a read-then-write, which under
   * two replicas is a race that sends twice.
   */
  claim(notificationId: string, channel: ChannelId, maxAttempts: number): Promise<ClaimResult>;
  /**
   * Remember a receipt on the pending row without marking it accepted and
   * without releasing the claim.
   *
   * `settle(accepted)` is a second write. If it throws, the row must already
   * say the gateway took the message, or the next claim treats the gap as a
   * crash mid-send and delivers again.
   */
  noteReceipt(input: NoteReceiptInput): Promise<void>;
  settle(input: SettleInput): Promise<void>;
  /**
   * Record a send this channel owes and has no sender for: a `pending` row named `code`, never claimed (no attempts, no
   * lease, `attempted_at` NULL), so the stuck-pending reaper leaves it and nothing reads it as sent. When a row for this
   * notification and channel already exists it is returned as it stands; nothing is overwritten.
   */
  wait(notificationId: string, channel: ChannelId, code: RefusalCode): Promise<DeliveryRecord>;
  listForNotification(notificationId: string): Promise<DeliveryRecord[]>;
  /**
   * Operator delivery-outcomes view (D26-P1-O5 residual).
   *
   * Newest-first across the whole delivery table — not scoped to a caller.
   * Callers must gate with an admin scope; this store method has no auth.
   * Caps at `limit` so an ops console cannot pull the entire history by accident.
   */
  listRecent(limit: number, status?: DeliveryStatus): Promise<DeliveryRecord[]>;
  /** Counts of every delivery row. Not a page. */
  aggregate(): Promise<{ total: number; byStatus: Record<DeliveryStatus, number>; byChannel: Record<string, number> }>;
  /**
   * The caller's finished delivery rows, newest first.
   * Pending is omitted. Postgres joins `notifications` on `userId`.
   * Memory has no user column: without `belongsTo` it returns nothing,
   * so a missing predicate cannot dump every account.
   */
  listOwnedRecent(query: OwnedRecentQuery): Promise<DeliveryRecord[]>;
  /**
   * Retire rows that have run out of attempts — or out of anyone who will try —
   * and that nobody owns.
   *
   * WHY THIS EXISTS AS A SWEEP AND NOT ONLY INSIDE `claim`
   *
   * `abandoned` used to be written in exactly one place: the retire branch of
   * `claim`, reached when a LATER bus redelivery finds the row out of attempts.
   * That branch depends on there being a later redelivery, and there is not
   * always one. `max_deliver` is 5 and `NOTIFY_MAX_DELIVERY_ATTEMPTS` may be
   * configured up to 5 — the README's env table says "1–5, at or below the bus
   * maxDeliver" — so the delivery that spends the last attempt can be the same
   * one JetStream then parks. No sixth message arrives, `claim` is never called
   * again for that pair, and the row stays `pending` forever.
   *
   * README: "After NOTIFY_MAX_DELIVERY_ATTEMPTS the row is `abandoned` rather
   * than left looking like it is still being retried." `notify.deliveries` is
   * user-facing on purpose — a margin call's own recipient reads it — so a row
   * that says `pending` while nothing is retrying it is the service telling the
   * person whose collateral is at risk that help is still on the way.
   *
   * TWO ARMS (either is enough to retire)
   *
   *   1. Attempts-ceiling (what `claim` would retire on a later redelivery):
   *      `attempts >= maxAttempts` AND (settled `failed`, or `pending` with no
   *      live lease).
   *
   *   2. Stuck-pending with a dead lease past the bus redelivery window:
   *      `status = pending`, at least one claim was taken, lease is null or
   *      expired, and the lease has been dead longer than `STUCK_PENDING_GRACE_MS`
   *      (bus maxDeliver × ack_wait). This closes the hole where `in_flight`
   *      naks burn `max_deliver` without raising `attempts`, so arm 1 never
   *      fires — see `STUCK_PENDING_GRACE_MS`.
   *
   * A live lease is never touched. That row has an owner who is about to settle
   * it, possibly as `accepted`.
   *
   * Returns the number of rows retired. Never sends, never acks, never writes
   * `accepted_at`: this only ever moves a row from "still being tried" to the
   * truth, which is that it is over.
   */
  reapExhausted(maxAttempts: number, opts?: ReapExhaustedOptions): Promise<number>;
}

export interface UpsertTargetInput {
  userId: string;
  channel: ChannelId;
  address: string;
  locale: string;
  verifyTokenHash: string;
  verifyExpiresAt: Date;
}

export interface TargetStore {
  /** Register or replace an address. A changed address is ALWAYS unconfirmed again. */
  upsert(input: UpsertTargetInput): Promise<ChannelTarget>;
  list(userId: string): Promise<ChannelTarget[]>;
  /** The only list the dispatcher may use. */
  verified(userId: string): Promise<ChannelTarget[]>;
  /**
   * Channels holding a registered but UNCONFIRMED address.
   *
   * Ids only, deliberately — never addresses. The dispatcher needs this to tell
   * "you gave us nothing" apart from "you gave us something and never clicked
   * the code", which are different facts and only the second one is something
   * the user can fix. Returning ids and not rows means the dispatcher cannot
   * send to one of these even by mistake: it never holds the address.
   */
  unverifiedChannels(userId: string): Promise<readonly ChannelId[]>;
  /** Confirm with the token we sent. Returns false for a wrong, expired or spent token. */
  markVerified(userId: string, channel: ChannelId, tokenHash: string, now: Date): Promise<boolean>;
  remove(userId: string, channel: ChannelId): Promise<boolean>;
}

// ── memory ───────────────────────────────────────────────────────────────────

function deliveryKey(notificationId: string, channel: ChannelId): string {
  return `${notificationId}\0${channel}`;
}

function ownedNewestFirst(a: DeliveryRecord, b: DeliveryRecord): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function ownedRowIsOlder(row: DeliveryRecord, before: { readonly createdAt: Date; readonly id: string }): boolean {
  const time = row.createdAt.getTime();
  const bound = before.createdAt.getTime();
  if (time < bound) return true;
  if (time > bound) return false;
  return row.id < before.id;
}

export class MemoryDeliveryStore implements DeliveryStore {
  private readonly byKey = new Map<string, DeliveryRecord>();
  private readonly byId = new Map<string, DeliveryRecord>();
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(opts: { leaseMs?: number; now?: () => Date } = {}) {
    this.leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  async claim(notificationId: string, channel: ChannelId, maxAttempts: number): Promise<ClaimResult> {
    const key = deliveryKey(notificationId, channel);
    const existing = this.byKey.get(key);
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    if (!existing) {
      const record: DeliveryRecord = {
        id: randomUUID(),
        notificationId,
        channel,
        status: 'pending',
        attempts: 1,
        attemptedAt: null,
        acceptedAt: null,
        leaseUntil,
        refusalCode: null,
        detail: null,
        reference: null,
        createdAt: now,
        updatedAt: now,
      };
      this.byKey.set(key, record);
      this.byId.set(record.id, record);
      return { claimed: true, id: record.id, attempt: 1 };
    }

    if (existing.status === 'accepted') return { claimed: false, reason: 'already_accepted', record: existing };
    if (existing.status === 'refused' || existing.status === 'abandoned') {
      return { claimed: false, reason: 'terminal', record: existing };
    }

    // Gateway already returned a receipt. The accepted write is what is left.
    // Reclaiming this row would deliver a second time.
    if (existing.status === 'pending' && existing.attemptedAt != null) {
      return { claimed: false, reason: 'receipt_pending', record: existing };
    }

    // Active lease first — never abandon or reclaim under a live holder.
    if (existing.status === 'pending' && existing.leaseUntil != null && existing.leaseUntil.getTime() > now.getTime()) {
      return { claimed: false, reason: 'in_flight', record: existing };
    }

    if (existing.attempts >= maxAttempts) {
      existing.status = 'abandoned';
      existing.refusalCode = 'channel.attempts_exhausted';
      existing.leaseUntil = null;
      existing.updatedAt = now;
      return { claimed: false, reason: 'exhausted', record: existing };
    }

    // Reclaim: failed (retryable settle) or pending with expired / null lease.
    // Clear attempted_at. It belonged to the previous attempt. Left in place,
    // a pending row would look like a receipt already noted, and the next
    // claim would skip a send that never happened.
    existing.attempts += 1;
    existing.status = 'pending';
    existing.attemptedAt = null;
    existing.leaseUntil = leaseUntil;
    existing.updatedAt = now;
    return { claimed: true, id: existing.id, attempt: existing.attempts };
  }

  async wait(notificationId: string, channel: ChannelId, code: RefusalCode): Promise<DeliveryRecord> {
    const key = deliveryKey(notificationId, channel);
    const existing = this.byKey.get(key);
    if (existing) return { ...existing };
    const now = this.now();
    const record: DeliveryRecord = {
      id: randomUUID(),
      notificationId,
      channel,
      status: 'pending',
      attempts: 0,
      attemptedAt: null,
      acceptedAt: null,
      leaseUntil: null,
      refusalCode: code,
      detail: null,
      reference: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byKey.set(key, record);
    this.byId.set(record.id, record);
    return { ...record };
  }

  async noteReceipt(input: NoteReceiptInput): Promise<void> {
    const record = this.byId.get(input.id);
    if (!record) return;
    if (record.attempts !== input.attempt) return;
    if (record.status !== 'pending') return;
    const now = this.now();
    record.reference = input.reference;
    if (record.attemptedAt == null) record.attemptedAt = now;
    record.updatedAt = now;
  }

  async settle(input: SettleInput): Promise<void> {
    const record = this.byId.get(input.id);
    if (!record) return;
    // Ownership: only the claim attempt that owns the row may settle it. A late
    // gateway response after reclaim must not stamp accepted over attempt N+1.
    if (record.attempts !== input.attempt) return;
    if (record.status !== 'pending') return;
    const now = this.now();
    record.status = input.status;
    record.refusalCode = input.refusalCode ?? null;
    record.detail = input.detail ?? null;
    record.reference = input.reference ?? null;
    if (input.attempted) record.attemptedAt = now;
    record.acceptedAt = input.status === 'accepted' ? now : null;
    // Lease ends when the attempt does — a settled failure is free for retry.
    record.leaseUntil = null;
    record.updatedAt = now;
  }

  async listForNotification(notificationId: string): Promise<DeliveryRecord[]> {
    return [...this.byId.values()].filter((r) => r.notificationId === notificationId).sort((a, b) => a.channel.localeCompare(b.channel));
  }

  async listRecent(limit: number, status?: DeliveryStatus): Promise<DeliveryRecord[]> {
    const cap = Math.max(0, Math.min(Math.floor(limit), 500));
    if (cap === 0) return [];
    return [...this.byId.values()]
      .filter((row) => status === undefined || row.status === status)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, cap);
  }

  async aggregate(): Promise<{ total: number; byStatus: Record<DeliveryStatus, number>; byChannel: Record<string, number> }> {
    const byStatus: Record<DeliveryStatus, number> = { pending: 0, accepted: 0, refused: 0, failed: 0, abandoned: 0 };
    const byChannel: Record<string, number> = {};
    for (const row of this.byId.values()) {
      byStatus[row.status] += 1;
      byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1;
    }
    return { total: this.byId.size, byStatus, byChannel };
  }

  async listOwnedRecent(query: OwnedRecentQuery): Promise<DeliveryRecord[]> {
    if (!query.belongsTo) return [];
    const cap = Math.max(0, Math.floor(query.limit));
    if (cap === 0) return [];
    let cursor: DeliveryRecord | null = null;
    if (query.beforeId) {
      const row = this.byId.get(query.beforeId) ?? null;
      if (!row || row.status === 'pending' || !(await query.belongsTo(row.notificationId))) {
        throw new OwnedRecentCursorError();
      }
      cursor = row;
    }
    const rows: DeliveryRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.status === 'pending') continue;
      if (cursor && !ownedRowIsOlder(record, cursor)) continue;
      if (!(await query.belongsTo(record.notificationId))) continue;
      rows.push(record);
    }
    rows.sort(ownedNewestFirst);
    return rows.slice(0, cap);
  }

  async reapExhausted(maxAttempts: number, opts: ReapExhaustedOptions = {}): Promise<number> {
    const now = this.now();
    const graceMs = opts.stuckGraceMs ?? STUCK_PENDING_GRACE_MS;
    let retired = 0;
    for (const record of this.byId.values()) {
      const decision = reapDecision(record, maxAttempts, now, graceMs);
      if (!decision.reaped) continue;
      record.status = 'abandoned';
      record.refusalCode = decision.reason;
      record.leaseUntil = null;
      record.updatedAt = now;
      retired += 1;
    }
    return retired;
  }
}

/**
 * Pure predicate for both memory and Postgres reapers — one decision table.
 *
 * See `DeliveryStore.reapExhausted` and `STUCK_PENDING_GRACE_MS` for the law.
 * Exported so unit tests can assert the edge cases without driving a store.
 */
/** Why a reaper arm would abandon a row — or null if it must leave it alone. */
export type ReapDecision =
  { readonly reaped: true; readonly reason: 'channel.attempts_exhausted' | 'channel.delivery_stuck' } | { readonly reaped: false };

/**
 * Pure decision for both memory and Postgres reapers — one table.
 *
 * Arm 1 wins when both could match (attempts spent AND stuck): the attempt
 * budget is the accurate story. Arm 2 is only for rows that still have
 * attempts left but nobody is coming back to spend them.
 */
export function reapDecision(
  record: Pick<DeliveryRecord, 'status' | 'attempts' | 'leaseUntil' | 'updatedAt'> & {
    /** Pending + set means a receipt is held and `accepted` is not written yet. */
    readonly attemptedAt?: Date | null;
  },
  maxAttempts: number,
  now: Date,
  stuckGraceMs: number = STUCK_PENDING_GRACE_MS,
): ReapDecision {
  if (record.status !== 'pending' && record.status !== 'failed') return { reaped: false };

  // A receipt is already on the row and `accepted` has not been written.
  // Abandoning it would record a transport failure for a message the gateway took.
  if (record.status === 'pending' && record.attemptedAt != null) return { reaped: false };

  const nowMs = now.getTime();
  const leaseLive = record.status === 'pending' && record.leaseUntil !== null && record.leaseUntil.getTime() > nowMs;
  if (leaseLive) return { reaped: false };

  // Arm 1 — attempts ceiling: claim would refuse to re-own; settle as abandoned.
  if (record.attempts >= maxAttempts) {
    return { reaped: true, reason: 'channel.attempts_exhausted' };
  }

  // Arm 2 — stuck pending: lease dead longer than the bus could still retry.
  // `failed` with attempts left is still owed a redelivery — leave it alone.
  if (record.status !== 'pending') return { reaped: false };
  if (record.attempts < 1) return { reaped: false };

  // Lease dead-since: when lease_until is known, use it; when null (legacy /
  // pre-migration), fall back to updated_at so a never-leased pending row is
  // not reaped the instant it appears.
  const deadSinceMs = record.leaseUntil !== null ? record.leaseUntil.getTime() : record.updatedAt.getTime();
  if (nowMs - deadSinceMs >= stuckGraceMs) {
    return { reaped: true, reason: 'channel.delivery_stuck' };
  }
  return { reaped: false };
}

/** @deprecated Prefer `reapDecision(...).reaped` — kept so existing call sites compile. */
export function shouldReapDelivery(
  record: Pick<DeliveryRecord, 'status' | 'attempts' | 'leaseUntil' | 'updatedAt'>,
  maxAttempts: number,
  now: Date,
  stuckGraceMs: number = STUCK_PENDING_GRACE_MS,
): boolean {
  return reapDecision(record, maxAttempts, now, stuckGraceMs).reaped;
}

export class MemoryTargetStore implements TargetStore {
  private readonly rows = new Map<string, ChannelTarget & { verifyTokenHash: string | null; verifyExpiresAt: Date | null }>();

  private key(userId: string, channel: ChannelId): string {
    return `${userId}\0${channel}`;
  }

  async upsert(input: UpsertTargetInput): Promise<ChannelTarget> {
    const now = new Date();
    const key = this.key(input.userId, input.channel);
    const existing = this.rows.get(key);
    const row = {
      userId: input.userId,
      channel: input.channel,
      address: input.address,
      locale: input.locale,
      // A changed address is a different address. Confirmation does not carry over.
      verifiedAt: existing && existing.address === input.address ? existing.verifiedAt : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      verifyTokenHash: input.verifyTokenHash,
      verifyExpiresAt: input.verifyExpiresAt,
    };
    this.rows.set(key, row);
    return stripSecrets(row);
  }

  async list(userId: string): Promise<ChannelTarget[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId).map(stripSecrets);
  }

  /** Every registered address, for the operator recipient list. Secrets stripped. */
  all(): ChannelTarget[] {
    return [...this.rows.values()].map(stripSecrets);
  }

  async verified(userId: string): Promise<ChannelTarget[]> {
    return (await this.list(userId)).filter((r) => r.verifiedAt !== null);
  }

  async unverifiedChannels(userId: string): Promise<readonly ChannelId[]> {
    return (await this.list(userId)).filter((r) => r.verifiedAt === null).map((r) => r.channel);
  }

  async markVerified(userId: string, channel: ChannelId, tokenHash: string, now: Date): Promise<boolean> {
    const row = this.rows.get(this.key(userId, channel));
    if (!row || row.verifyTokenHash === null || row.verifyExpiresAt === null) return false;
    if (row.verifyTokenHash !== tokenHash || row.verifyExpiresAt.getTime() < now.getTime()) return false;
    row.verifiedAt = now;
    row.updatedAt = now;
    // Single use — a code that still works after it was used is a code someone can replay.
    row.verifyTokenHash = null;
    row.verifyExpiresAt = null;
    return true;
  }

  async remove(userId: string, channel: ChannelId): Promise<boolean> {
    return this.rows.delete(this.key(userId, channel));
  }
}

function stripSecrets(row: ChannelTarget & { verifyTokenHash: string | null; verifyExpiresAt: Date | null }): ChannelTarget {
  return {
    userId: row.userId,
    channel: row.channel,
    address: row.address,
    locale: row.locale,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── postgres ─────────────────────────────────────────────────────────────────

type DeliveryPgRow = {
  id: string;
  notification_id: string;
  channel: ChannelId;
  status: DeliveryStatus;
  attempts: number;
  attempted_at: Date | null;
  accepted_at: Date | null;
  lease_until: Date | null;
  refusal_code: RefusalCode | null;
  detail: string | null;
  reference: string | null;
  created_at: Date;
  updated_at: Date;
};

function fromDeliveryPg(row: DeliveryPgRow): DeliveryRecord {
  return {
    id: row.id,
    notificationId: row.notification_id,
    channel: row.channel,
    status: row.status,
    attempts: Number(row.attempts),
    attemptedAt: row.attempted_at,
    acceptedAt: row.accepted_at,
    leaseUntil: row.lease_until,
    refusalCode: row.refusal_code,
    detail: row.detail,
    reference: row.reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresDeliveryStore implements DeliveryStore {
  private readonly leaseMs: number;

  constructor(
    private readonly sql: Sql,
    opts: { leaseMs?: number } = {},
  ) {
    this.leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  }

  async claim(notificationId: string, channel: ChannelId, maxAttempts: number): Promise<ClaimResult> {
    // ONE statement decides. Two replicas racing the same redelivered event both
    // run this; exactly one gets a row back, and the other is told why not. A
    // read-then-write here would send the same email twice under load.
    //
    // Lease: pending rows with a live lease_until are NOT re-owned. That is the
    // two-replica mid-send guard. Failed rows and expired leases remain reclaimable.
    //
    // The transaction exists so a miss and the follow-up read share one now().
    // Date.now() ahead of Postgres would call a lease that UPDATE still treats
    // as live a terminal miss. The bus would ack, and nothing would claim it.
    const leaseSeconds = Math.max(1, Math.ceil(this.leaseMs / 1000));
    return this.sql.begin(async (tx): Promise<ClaimResult> => {
      const claimed = await tx<DeliveryPgRow[]>`
      INSERT INTO notify.deliveries (notification_id, channel, status, attempts, lease_until)
      VALUES (${notificationId}, ${channel}, 'pending', 1, now() + (${leaseSeconds}::text || ' seconds')::interval)
      ON CONFLICT (notification_id, channel) DO UPDATE
        SET attempts = notify.deliveries.attempts + 1,
            status = 'pending',
            attempted_at = NULL,
            lease_until = now() + (${leaseSeconds}::text || ' seconds')::interval,
            updated_at = now()
        WHERE notify.deliveries.attempts < ${maxAttempts}
          -- A pending row with attempted_at already holds a receipt. Reclaiming
          -- it would deliver again. Failed rows still match: their status is
          -- not pending. The SET clears attempted_at so a new attempt does not
          -- inherit the previous try's timestamp.
          AND NOT (
            notify.deliveries.status = 'pending'
            AND notify.deliveries.attempted_at IS NOT NULL
          )
          AND (
            notify.deliveries.status = 'failed'
            OR (
              notify.deliveries.status = 'pending'
              AND (
                notify.deliveries.lease_until IS NULL
                OR notify.deliveries.lease_until <= now()
              )
            )
          )
      RETURNING id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at
    `;

      if (claimed.length > 0) {
        const row = fromDeliveryPg(claimed[0]!);
        return { claimed: true, id: row.id, attempt: row.attempts };
      }

      // The upsert was blocked. Say precisely why, and retire a row that has run
      // out of attempts rather than leaving it 'failed' forever, which would read
      // as "still being retried" when nothing is retrying it.
      // Exhausted only when nobody owns a live lease — never abandon under a holder.
      const retired = await tx<DeliveryPgRow[]>`
      UPDATE notify.deliveries
         SET status = 'abandoned',
             refusal_code = 'channel.attempts_exhausted',
             lease_until = NULL,
             updated_at = now()
       WHERE notification_id = ${notificationId}
         AND channel = ${channel}
         AND attempts >= ${maxAttempts}
         AND NOT (status = 'pending' AND attempted_at IS NOT NULL)
         AND (
           status = 'failed'
           OR (
             status = 'pending'
             AND (lease_until IS NULL OR lease_until <= now())
           )
         )
      RETURNING id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at
    `;
      if (retired.length > 0) return { claimed: false, reason: 'exhausted', record: fromDeliveryPg(retired[0]!) };

      const current = await tx<(DeliveryPgRow & { lease_live: boolean })[]>`
      SELECT id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at,
             (status = 'pending' AND lease_until IS NOT NULL AND lease_until > now()) AS lease_live
        FROM notify.deliveries
       WHERE notification_id = ${notificationId} AND channel = ${channel}
       LIMIT 1
    `;
      const row = current[0]!;
      const record = fromDeliveryPg(row);
      if (record.status === 'pending' && record.attemptedAt != null) {
        return { claimed: false, reason: 'receipt_pending', record };
      }
      if (record.status === 'accepted') {
        return { claimed: false, reason: 'already_accepted', record };
      }
      // Same now() as the UPDATE that missed. Not Date.now().
      if (row.lease_live) {
        return { claimed: false, reason: 'in_flight', record };
      }
      return { claimed: false, reason: 'terminal', record };
    });
  }

  async wait(notificationId: string, channel: ChannelId, code: RefusalCode): Promise<DeliveryRecord> {
    // DO NOTHING on conflict: a row already there (claimed, sent or refused) is the truer record.
    await this.sql`
      INSERT INTO notify.deliveries (notification_id, channel, status, attempts, refusal_code)
      VALUES (${notificationId}, ${channel}, 'pending', 0, ${code})
      ON CONFLICT (notification_id, channel) DO NOTHING
    `;
    const rows = await this.sql<DeliveryPgRow[]>`
      SELECT id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at FROM notify.deliveries
       WHERE notification_id = ${notificationId} AND channel = ${channel}
    `;
    return fromDeliveryPg(rows[0]!);
  }

  async noteReceipt(input: NoteReceiptInput): Promise<void> {
    // Same ownership rule as settle. Status stays pending, accepted_at stays
    // null, and the lease stays with the claim. reference is stored as given,
    // including null when the transport returned no handle.
    await this.sql`
      UPDATE notify.deliveries
         SET reference = ${input.reference},
             attempted_at = COALESCE(attempted_at, now()),
             updated_at = now()
       WHERE id = ${input.id}
         AND status = 'pending'
         AND attempts = ${input.attempt}
    `;
  }

  async settle(input: SettleInput): Promise<void> {
    // Ownership: attempt number must still match. Late settle after reclaim is a no-op.
    await this.sql`
      UPDATE notify.deliveries
         SET status = ${input.status},
             refusal_code = ${input.refusalCode ?? null},
             detail = ${input.detail ?? null},
             reference = ${input.reference ?? null},
             attempted_at = CASE WHEN ${input.attempted} THEN now() ELSE attempted_at END,
             accepted_at = CASE WHEN ${input.status === 'accepted'} THEN now() ELSE NULL END,
             lease_until = NULL,
             updated_at = now()
       WHERE id = ${input.id}
         AND status = 'pending'
         AND attempts = ${input.attempt}
    `;
  }

  async listForNotification(notificationId: string): Promise<DeliveryRecord[]> {
    const rows = await this.sql<DeliveryPgRow[]>`
      SELECT id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at FROM notify.deliveries
       WHERE notification_id = ${notificationId}
       ORDER BY channel ASC
    `;
    return rows.map(fromDeliveryPg);
  }

  async listOwnedRecent(query: OwnedRecentQuery): Promise<DeliveryRecord[]> {
    const cap = Math.max(0, Math.floor(query.limit));
    if (cap === 0) return [];
    if (query.beforeId) {
      const owned = await this.sql<{ id: string }[]>`
        SELECT c.id
          FROM notify.deliveries c
          JOIN notify.notifications cn ON cn.id = c.notification_id
         WHERE c.id = ${query.beforeId}::uuid
           AND cn.user_id = ${query.userId}
           AND c.status IN ('accepted', 'refused', 'failed', 'abandoned')
         LIMIT 1
      `;
      if (owned.length === 0) throw new OwnedRecentCursorError();
    }
    const rows = query.beforeId
      ? await this.sql<DeliveryPgRow[]>`
          SELECT d.id, d.notification_id, d.channel, d.status, d.attempts, d.attempted_at, d.accepted_at, d.lease_until,
                 d.refusal_code, d.detail, d.reference, d.created_at, d.updated_at
            FROM notify.deliveries d
            JOIN notify.notifications n ON n.id = d.notification_id
           WHERE n.user_id = ${query.userId}
             AND d.status IN ('accepted', 'refused', 'failed', 'abandoned')
             AND (d.created_at, d.id) < (
               SELECT c.created_at, c.id
                 FROM notify.deliveries c
                 JOIN notify.notifications cn ON cn.id = c.notification_id
                WHERE c.id = ${query.beforeId}::uuid
                  AND cn.user_id = ${query.userId}
             )
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT ${cap}
        `
      : await this.sql<DeliveryPgRow[]>`
          SELECT d.id, d.notification_id, d.channel, d.status, d.attempts, d.attempted_at, d.accepted_at, d.lease_until,
                 d.refusal_code, d.detail, d.reference, d.created_at, d.updated_at
            FROM notify.deliveries d
            JOIN notify.notifications n ON n.id = d.notification_id
           WHERE n.user_id = ${query.userId}
             AND d.status IN ('accepted', 'refused', 'failed', 'abandoned')
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT ${cap}
        `;
    return rows.map(fromDeliveryPg);
  }

  async listRecent(limit: number, status?: DeliveryStatus): Promise<DeliveryRecord[]> {
    const cap = Math.max(0, Math.min(Math.floor(limit), 500));
    if (cap === 0) return [];
    const rows = await this.sql<DeliveryPgRow[]>`
      SELECT id, notification_id, channel, status, attempts, attempted_at, accepted_at, lease_until, refusal_code, detail, reference, created_at, updated_at FROM notify.deliveries
       WHERE ${status === undefined ? this.sql`TRUE` : this.sql`status = ${status}`}
       ORDER BY updated_at DESC, id ASC
       LIMIT ${cap}
    `;
    return rows.map(fromDeliveryPg);
  }

  async aggregate(): Promise<{ total: number; byStatus: Record<DeliveryStatus, number>; byChannel: Record<string, number> }> {
    const byStatus: Record<DeliveryStatus, number> = { pending: 0, accepted: 0, refused: 0, failed: 0, abandoned: 0 };
    const statusRows = await this.sql<Array<{ status: DeliveryStatus; n: string }>>`
      SELECT status, count(*)::text AS n FROM notify.deliveries GROUP BY status
    `;
    for (const row of statusRows) byStatus[row.status] = Number(row.n);
    const channelRows = await this.sql<Array<{ channel: string; n: string }>>`
      SELECT channel, count(*)::text AS n FROM notify.deliveries GROUP BY channel
    `;
    const byChannel: Record<string, number> = {};
    let total = 0;
    for (const row of channelRows) {
      const n = Number(row.n);
      byChannel[row.channel] = n;
      total += n;
    }
    return { total, byStatus, byChannel };
  }

  async reapExhausted(maxAttempts: number, opts: ReapExhaustedOptions = {}): Promise<number> {
    // One statement covering both arms of `shouldReapDelivery`. Two replicas
    // sweeping at once is harmless: `status` is in the WHERE clause, so the
    // second finds nothing left to retire.
    //
    // Arm 1 (attempts ceiling) matches what `claim` retires on a later
    // redelivery. Arm 2 (stuck pending past bus redelivery grace) is the
    // in_flight / max_deliver hole — see `STUCK_PENDING_GRACE_MS`.
    const graceSeconds = Math.max(1, Math.ceil((opts.stuckGraceMs ?? STUCK_PENDING_GRACE_MS) / 1000));
    // Arm 1 wins the CASE when both arms match: attempts spent is the true story.
    // Arm 2 alone writes channel.delivery_stuck so a row with attempts=1 of 3
    // does not claim "attempts exhausted".
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notify.deliveries
         SET status = 'abandoned',
             refusal_code = CASE
               WHEN attempts >= ${maxAttempts} THEN 'channel.attempts_exhausted'
               ELSE 'channel.delivery_stuck'
             END,
             lease_until = NULL,
             updated_at = now()
       WHERE NOT (status = 'pending' AND attempted_at IS NOT NULL)
         AND (
           -- Arm 1: attempts spent, nobody mid-send
           (
             attempts >= ${maxAttempts}
             AND (
               status = 'failed'
               OR (status = 'pending' AND (lease_until IS NULL OR lease_until <= now()))
             )
           )
           OR
           -- Arm 2: pending, claimed at least once, lease dead past bus window
           (
             status = 'pending'
             AND attempts >= 1
             AND attempts < ${maxAttempts}
             AND (
               (lease_until IS NOT NULL AND lease_until <= now() - (${graceSeconds}::text || ' seconds')::interval)
               OR (lease_until IS NULL AND updated_at <= now() - (${graceSeconds}::text || ' seconds')::interval)
             )
           )
         )
      RETURNING id
    `;
    return rows.length;
  }
}

type TargetPgRow = {
  user_id: string;
  channel: ChannelId;
  address: string;
  locale: string;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function fromTargetPg(row: TargetPgRow): ChannelTarget {
  return {
    userId: row.user_id,
    channel: row.channel,
    address: row.address,
    locale: row.locale,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresTargetStore implements TargetStore {
  constructor(private readonly sql: Sql) {}

  async upsert(input: UpsertTargetInput): Promise<ChannelTarget> {
    // `verified_at` resets whenever the address changes. Confirming one address
    // is not consent to be messaged at another.
    const rows = await this.sql<TargetPgRow[]>`
      INSERT INTO notify.channel_targets (user_id, channel, address, locale, verify_token_hash, verify_expires_at)
      VALUES (${input.userId}, ${input.channel}, ${input.address}, ${input.locale}, ${input.verifyTokenHash}, ${input.verifyExpiresAt})
      ON CONFLICT (user_id, channel) DO UPDATE
        SET address = EXCLUDED.address,
            locale = EXCLUDED.locale,
            verify_token_hash = EXCLUDED.verify_token_hash,
            verify_expires_at = EXCLUDED.verify_expires_at,
            verified_at = CASE
              WHEN notify.channel_targets.address = EXCLUDED.address THEN notify.channel_targets.verified_at
              ELSE NULL
            END,
            updated_at = now()
      RETURNING user_id, channel, address, locale, verified_at, created_at, updated_at
    `;
    return fromTargetPg(rows[0]!);
  }

  async list(userId: string): Promise<ChannelTarget[]> {
    const rows = await this.sql<TargetPgRow[]>`
      SELECT user_id, channel, address, locale, verified_at, created_at, updated_at FROM notify.channel_targets
       WHERE user_id = ${userId}
       ORDER BY channel ASC
    `;
    return rows.map(fromTargetPg);
  }

  async verified(userId: string): Promise<ChannelTarget[]> {
    const rows = await this.sql<TargetPgRow[]>`
      SELECT user_id, channel, address, locale, verified_at, created_at, updated_at FROM notify.channel_targets
       WHERE user_id = ${userId} AND verified_at IS NOT NULL
       ORDER BY channel ASC
    `;
    return rows.map(fromTargetPg);
  }

  async unverifiedChannels(userId: string): Promise<readonly ChannelId[]> {
    // `channel` and nothing else. This answers a labelling question, so it has
    // no reason to load an address the caller must not send to.
    const rows = await this.sql<{ channel: ChannelId }[]>`
      SELECT channel FROM notify.channel_targets
       WHERE user_id = ${userId} AND verified_at IS NULL
       ORDER BY channel ASC
    `;
    return rows.map((r) => r.channel);
  }

  async markVerified(userId: string, channel: ChannelId, tokenHash: string, now: Date): Promise<boolean> {
    // Single use: the token is cleared in the same statement that spends it, so
    // a replayed code finds nothing to match.
    const rows = await this.sql<Array<{ user_id: string }>>`
      UPDATE notify.channel_targets
         SET verified_at = ${now}, verify_token_hash = NULL, verify_expires_at = NULL, updated_at = now()
       WHERE user_id = ${userId}
         AND channel = ${channel}
         AND verify_token_hash = ${tokenHash}
         AND verify_expires_at > ${now}
      RETURNING user_id
    `;
    return rows.length > 0;
  }

  async remove(userId: string, channel: ChannelId): Promise<boolean> {
    const rows = await this.sql<Array<{ user_id: string }>>`
      DELETE FROM notify.channel_targets
       WHERE user_id = ${userId} AND channel = ${channel}
      RETURNING user_id
    `;
    return rows.length > 0;
  }
}
