import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { withMarketSpan } from './tracing.js';
import { decideVendorSlot, usableSlots, type SlotDecision } from './slot-access.js';
import type { SlotEntitlementSource } from './stake-source.js';

/**
 * THE VENDOR LIFECYCLE — APPLY, THEN VET (Stage 1), AND THE STAKE-GATED LISTING
 * SLOTS THAT SIT ON TOP OF IT (Stage 2) — §8.7, `market.vendors`.
 *
 * A user applies to be a marketplace vendor; an operator decides. Every decision
 * is recorded next to the state it produced, in one transaction, so "why was
 * this vendor rejected" is answerable from the database.
 *
 * ── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────
 *
 * IT DOES NOT DECIDE WHETHER AN APPLICATION IS GOOD. There is no criterion here,
 * no score, no automatic transition and nothing that calls this on a timer. No
 * vetting criterion exists anywhere in this repository — `market.vendors.md`
 * names it an open product question that belongs to the owner — so the API is
 * deliberately shaped like a log with a side effect rather than a decision
 * engine: an operator names the outcome and a reason, and this records it and
 * applies it. If a policy ever gets written, it CALLS this; it does not live in
 * it. Same posture, and mostly the same words, as
 * `services/svc-pay/src/merchant-state-service.ts` — which exists because
 * merchant state was enforced by a column nothing ever wrote.
 *
 * IT DOES NOT DECIDE WHEN TO SUSPEND EITHER, and Stage 2 does not change that.
 * A slot is released when a vendor stops being approved, but the TRANSITION is
 * still something an operator recorded through `vet`. Reacting to a state
 * somebody else wrote is not the same thing as deciding it, and nothing here
 * suspends a vendor on a timer, a threshold or an offence count.
 *
 * IT STILL RESTATES NO STAKE NUMBER. Stage 2 reads slot capacity from svc-token
 * at claim time (`stake-source.ts`); the tier schedule itself stays in
 * `economics/staking.ts`. No threshold, slot count or tier name is written down
 * in this service or its schema, and `docs/ops/trk/market.vendors.md:76` is why:
 * "market must not invent parallel stake numbers".
 *
 * IT MOVES NO VALUE. There is no import of `@intafaced/ledger-client` in this
 * service and no column in its schema could hold an amount (§0.6). Purchases,
 * subscriptions and house commission are `market.commerce`. Stage 2 deliberately
 * reads only `tier.vendorSlots` off svc-token and ignores the `staked` and
 * `minStake` amounts it also returns, so no money crosses into this process at
 * all.
 *
 * ── WHY THE TWO WRITES ARE ONE TRANSACTION ─────────────────────────────────
 *
 * `vendors.status` and the history row are written together or not at all. The
 * failure modes if they were not are asymmetric in an ugly way:
 *
 *   · status without history — a vendor is rejected and nobody can say why.
 *     Exactly the defect this table exists to prevent, reintroduced by a crash.
 *   · history without status — the log says a vendor was approved and they are
 *     not. The log is then WORSE than no log, because it looks like evidence and
 *     is false.
 *
 * The vendor row is locked FOR UPDATE first, so `from_status` is the status that
 * was actually in force when the change applied and not one read a moment
 * earlier by a different request.
 */

/**
 * The scope that authorises a vetting decision.
 *
 * Held here as well as on the procedure so the refusal survives a caller that
 * never goes through the router — an internal tool, a future policy engine, a
 * migration script. See `vet()`.
 */
export const MARKET_OPS_SCOPE = 'market:ops';

export class MarketError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}

/** Public `listed` page size unpublished. Blank is not 20. */
export const MARKET_LISTED_VENDORS_LIST_LIMIT_UNSET = 'market.listed_vendors_list_limit_unset' as const;

/** Operator `listApplications` page size unpublished. Blank is not 50. */
export const MARKET_APPLICATIONS_LIST_LIMIT_UNSET = 'market.applications_list_limit_unset' as const;

/** Operator `history` page size unpublished. Blank is not 50. */
export const MARKET_HISTORY_LIMIT_UNSET = 'market.history_limit_unset' as const;

/** Owner-published listed-vendors page size. Blank / non-finite / <1 refuses. Never invent 20. */
export function assertListedVendorsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_LISTED_VENDORS_LIST_LIMIT_UNSET, MARKET_LISTED_VENDORS_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_LISTED_VENDORS_LIST_LIMIT_UNSET, MARKET_LISTED_VENDORS_LIST_LIMIT_UNSET);
  }
  return Math.min(50, n);
}

/** Owner-published applications page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertApplicationsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_APPLICATIONS_LIST_LIMIT_UNSET, MARKET_APPLICATIONS_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_APPLICATIONS_LIST_LIMIT_UNSET, MARKET_APPLICATIONS_LIST_LIMIT_UNSET);
  }
  return Math.min(50, n);
}

/** Owner-published history page size. Blank / non-finite / <1 refuses. Never invent 50. Cap 200 (existing door max). */
export function assertHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_HISTORY_LIMIT_UNSET, MARKET_HISTORY_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_HISTORY_LIMIT_UNSET, MARKET_HISTORY_LIMIT_UNSET);
  }
  return Math.min(200, n);
}

export type VendorStatus = 'applied' | 'approved' | 'rejected' | 'suspended';

/**
 * The outcomes an operator may name.
 *
 * `applied` is absent: that is where a row starts, and moving one back to it
 * would erase that it was ever decided.
 */
export type VetDecision = Exclude<VendorStatus, 'applied'>;

export interface VendorRecord {
  id: string;
  userId: string;
  displayName: string;
  description: string;
  status: VendorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VendorStatusEventRecord {
  id: string;
  seq: string;
  vendorId: string;
  fromStatus: VendorStatus;
  toStatus: VendorStatus;
  reason: string;
  actorId: string;
  actorScope: string;
  createdAt: string;
}

interface VendorRow {
  id: string;
  user_id: string;
  display_name: string;
  description: string;
  status: VendorStatus;
  created_at: Date;
  updated_at: Date;
}

interface StatusEventRow {
  id: string;
  seq: string;
  vendor_id: string;
  from_status: VendorStatus;
  to_status: VendorStatus;
  reason: string;
  actor_id: string;
  actor_scope: string;
  created_at: Date;
}

/** One listing slot a vendor has taken up. Holds no amount and no capacity. */
export interface VendorSlotRecord {
  id: string;
  vendorId: string;
  ref: string;
  claimedAt: string;
  releasedAt: string | null;
}

/**
 * What a vendor's slot position actually is, right now.
 *
 * `capacity` and `tier` are re-read from svc-token on every call rather than
 * stored — see `slot-access.ts` `usableSlots` for why that re-derivation is the
 * mechanism behind "under-staked vendors cannot present as listed" (DoD clause
 * 5) rather than a subscription to an unstake event that does not exist.
 */
export interface VendorSlotStatus {
  vendorId: string;
  status: VendorStatus;
  /** svc-token's tier name, for display. Never computed here. */
  tier: string;
  /** `AccessTier.vendorSlots` as svc-token reported it this second. */
  capacity: number;
  /** Slots held and not released. */
  held: number;
  /** Of those, how many the CURRENT tier and status actually cover. */
  usable: number;
  slots: VendorSlotRecord[];
}

interface SlotRow {
  id: string;
  vendor_id: string;
  ref: string;
  claimed_at: Date;
  released_at: Date | null;
}

/**
 * WHAT A STRANGER SEES (Stage 3).
 *
 * Four fields, and the omissions are the design. Everything left out was left
 * out for a reason worth writing down, because the next person to add a field
 * here will be adding it to an UNAUTHENTICATED response:
 *
 *   · `userId` — the platform account id behind the vendor. Publishing it joins
 *     a marketplace storefront to a person's account across every other module.
 *     `market.commerce` references a VENDOR, and that is the id it gets.
 *   · `status` — redundant and dangerous at once. A profile only exists when the
 *     vendor is listed, so it would always read `approved`; the only thing it
 *     could ever carry is the information that somebody ELSE was suspended.
 *   · the vetting reason, `actorId`, `actorScope`, and anything at all from
 *     `market.vendor_status_events` — operator-internal. "Rejected: suspected
 *     counterfeit stock" is a defamation-shaped disclosure and Stage 1 put that
 *     table behind `market:ops` deliberately. `history` stays the only reader.
 *   · the stake TIER, capacity, and held/usable slot counts — a tier name is a
 *     public statement about the size of someone's holdings. svc-market reads
 *     `vendorSlots` to decide, and then does not repeat what it learned.
 *   · slot `ref`s — Stage 2 reserved those for `market.commerce` listing ids.
 *     Which of a vendor's listings are live is commerce's surface to publish.
 *
 * `createdAt` is when the APPLICATION was made, not when it was approved. The
 * approval date is only derivable from the operator event log, and reading that
 * table to render a public page is the first step towards leaking it.
 */
export interface PublicVendorProfile {
  id: string;
  displayName: string;
  description: string;
  createdAt: string;
}

/** Why a vendor is not listed. `market.stake_unavailable` is never one of these — see `listingEligibility`. */
export type ListingRefusalCode =
  'market.vendor_not_found' | 'market.vendor_not_approved' | 'market.slot_required' | 'market.stake_required';

/**
 * Whether a vendor may present as listed, and why not when they may not.
 *
 * A returned verdict rather than a thrown error because the caller this exists
 * for — `market.commerce`'s listing create — needs to BRANCH on it, and a
 * refusal that arrives as an exception gets caught by a generic handler and
 * turned into a 500 that tells the vendor nothing they can act on.
 */
export interface VendorListingEligibility {
  /** `null` only when no vendor matched the lookup. */
  vendorId: string | null;
  listed: boolean;
  code?: ListingRefusalCode;
  reason?: string;
}

function toPublicProfile(vendor: VendorRecord): PublicVendorProfile {
  return {
    id: vendor.id,
    displayName: vendor.displayName,
    description: vendor.description,
    createdAt: vendor.createdAt,
  };
}

function toSlot(row: SlotRow): VendorSlotRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    ref: row.ref,
    claimedAt: row.claimed_at.toISOString(),
    releasedAt: row.released_at ? row.released_at.toISOString() : null,
  };
}

function toVendor(row: VendorRow): VendorRecord {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvent(row: StatusEventRow): VendorStatusEventRecord {
  return {
    id: row.id,
    // `bigserial` arrives as a string from postgres.js and stays one. It is an
    // ordering key, never arithmetic, and turning it into a `number` would put a
    // 2^53 ceiling on an append-only log for no benefit at all.
    seq: String(row.seq),
    vendorId: row.vendor_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorId: row.actor_id,
    actorScope: row.actor_scope,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ApplyInput {
  /** The applicant, from the authenticated principal. Never from a request body. */
  userId: string;
  displayName: string;
  description: string;
}

export interface VetInput {
  vendorId: string;
  /** The operator's decision. Nothing in this service computes it. */
  decision: VetDecision;
  /** Free text, required, and refused when blank. */
  reason: string;
  /** The authenticated operator. Never taken from a request body. */
  actorId: string;
  /** The scope the caller actually held when this was applied. */
  actorScope: string;
}

export class VendorService {
  /**
   * `stakes` is REQUIRED, not optional with a permissive default. An optional
   * entitlement source is a production fallback by another name: the day
   * somebody constructs this service without one, every slot claim would be
   * decided by whatever the default said, and the default would be wrong in the
   * generous direction. Tests pass `FixedEntitlement` explicitly (stake-source.ts).
   */
  constructor(
    private readonly sql: Sql,
    private readonly stakes: SlotEntitlementSource,
  ) {}

  /**
   * Create the caller's own application, in `applied`.
   *
   * ONE PER USER, and the uniqueness is the database's rather than a read
   * followed by a write: two clicks a millisecond apart would both see "no
   * existing application" and both insert. `ON CONFLICT DO NOTHING` makes the
   * second one return no row, which is what the refusal below is built on.
   *
   * The status is not a parameter. An application that could be born approved is
   * an application nobody vetted.
   */
  async applyAsVendor(input: ApplyInput): Promise<VendorRecord> {
    const displayName = input.displayName.trim();
    const description = input.description.trim();
    if (displayName.length === 0) {
      throw new MarketError('A vendor application needs a display name', 'market.vendor_display_name_required');
    }
    if (description.length === 0) {
      throw new MarketError('A vendor application needs a description an operator can read', 'market.vendor_description_required');
    }

    return withMarketSpan('market.apply', { op: 'apply' }, async () => {
      const [row] = await this.sql<VendorRow[]>`
        INSERT INTO market.vendors (user_id, display_name, description)
        VALUES (${input.userId}, ${displayName}, ${description})
        ON CONFLICT (user_id) DO NOTHING
        RETURNING id, user_id, display_name, description, status, created_at, updated_at
      `;

      if (!row) {
        throw new MarketError(
          'This account already has a vendor application. Read it back rather than applying twice.',
          'market.vendor_already_applied',
        );
      }
      return toVendor(row);
    });
  }

  /** The caller's own application, or null if they have never made one. */
  async myVendor(userId: string): Promise<VendorRecord | null> {
    const [row] = await this.sql<VendorRow[]>`
      SELECT id, user_id, display_name, description, status, created_at, updated_at
        FROM market.vendors
       WHERE user_id = ${userId}
    `;
    return row ? toVendor(row) : null;
  }

  /**
   * The operator queue — oldest first, because the oldest undecided application
   * is the one that has been waiting longest and is the reason a queue exists.
   *
   * Page size is owner-published — omit is not 50.
   */
  async listApplications(options: { status?: VendorStatus; limit?: number } = {}): Promise<VendorRecord[]> {
    const limit = assertApplicationsListLimit(options.limit);
    const status = options.status ?? null;
    const rows = await this.sql<VendorRow[]>`
      SELECT id, user_id, display_name, description, status, created_at, updated_at
        FROM market.vendors
       WHERE ${status === null ? this.sql`true` : this.sql`status = ${status}::market.vendor_status`}
       ORDER BY created_at ASC
       LIMIT ${limit}
    `;
    return rows.map(toVendor);
  }

  /**
   * Apply an operator's decision, and record who made it, when, and why.
   *
   * ── WHAT IT REFUSES ────────────────────────────────────────────────────────
   *
   * A CALLER THAT IS NOT AN OPERATOR — `market.vet_operator_required`. The
   * router already gates the procedure on the scope, so this looks redundant and
   * is not: the point of the refusal is that NOTHING in this codebase may decide
   * an application. A future policy engine, an internal tool or a script that
   * reached this method directly would otherwise write an approval with no human
   * behind it, and the audit row would record a scope that never authorised
   * anything. The precedent is `payment-service.ts`'s `decideKybStub`, which
   * refuses under live-only with `pay.kyb_operator_required` rather than
   * inventing an external vendor's answer.
   *
   * A BLANK REASON. Enforced here so the operator gets a sentence rather than a
   * constraint-violation string, and enforced again by a CHECK in the database
   * so it holds for anything that ever writes that table without coming through
   * here. Two checks: the first is for the operator, the second is for the
   * guarantee.
   *
   * A NO-OP. Setting a vendor to the status they already hold appends nothing
   * and changes nothing. It is not an error — an operator clicking twice is not
   * a fault — but it must not write a row, because a history full of
   * `approved → approved` is a history nobody reads, and a history nobody reads
   * is how the real rows get missed.
   *
   * ── WHAT IT DOES NOT REFUSE, AND WHY ───────────────────────────────────────
   *
   * ANY TRANSITION BETWEEN ANY TWO DECIDED STATES. Suspending an approved
   * vendor, reinstating a suspended one, approving a previously rejected
   * application — all permitted. That looks lax and is the deliberate half of
   * "do not invent a suspension policy": a transition map is a policy. It would
   * decide that rejection is final, that a suspension cannot be lifted, and half
   * a dozen other things nobody has ruled on. What the history buys is that
   * every transition, including a strange one, is attributable and dated.
   */
  async vet(input: VetInput): Promise<{ changed: boolean; vendor: VendorRecord; event: VendorStatusEventRecord | null }> {
    if (input.actorScope !== MARKET_OPS_SCOPE) {
      throw new MarketError(
        `Vetting a vendor application requires an operator holding "${MARKET_OPS_SCOPE}". ` +
          'Nothing in svc-market decides whether an application is good — there is no criterion to decide it with.',
        'market.vet_operator_required',
        { held: input.actorScope, required: MARKET_OPS_SCOPE },
      );
    }

    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new MarketError(
        'A vetting decision requires a reason. "Why was this vendor rejected" must be answerable from the database, ' +
          'and it is not answerable from an empty string.',
        'market.vet_reason_required',
      );
    }

    return withMarketSpan('market.vet', { op: 'vet', vendorId: input.vendorId }, async () =>
      transaction(
        this.sql,
        async (tx) => {
          // FOR UPDATE: `from_status` has to be the status that was in force when
          // this change applied, not one read a moment earlier by another
          // request. Two operators approving and suspending at the same instant
          // would otherwise both record the same `from`, and the log would show
          // two changes out of one state.
          const [vendor] = await tx<VendorRow[]>`
            SELECT id, user_id, display_name, description, status, created_at, updated_at
              FROM market.vendors
             WHERE id = ${input.vendorId}
             FOR UPDATE
          `;
          if (!vendor) {
            throw new MarketError(`No vendor application ${input.vendorId}`, 'market.vendor_not_found');
          }

          if (vendor.status === input.decision) {
            return { changed: false, vendor: toVendor(vendor), event: null };
          }

          const [updated] = await tx<VendorRow[]>`
            UPDATE market.vendors
               SET status = ${input.decision}::market.vendor_status, updated_at = now()
             WHERE id = ${input.vendorId}
             RETURNING id, user_id, display_name, description, status, created_at, updated_at
          `;

          /**
           * RELEASE ON SUSPENSION — DoD "release on unstake / offence /
           * suspension", in the SAME TRANSACTION as the transition that caused it.
           *
           * Not a separate call, and the reason is the one three paragraphs of
           * this file's header already make about status and history: two writes
           * that must both happen, split across two transactions, means a crash
           * in between leaves a suspended vendor still holding every slot they
           * had. That is the exact failure clause 5 exists to prevent, and it
           * would be invisible — the vendor row would read `suspended` and look
           * correct.
           *
           * `!== 'approved'` rather than `=== 'suspended'`: a REJECTED vendor
           * must not keep slots either, and a status added later should default
           * to releasing rather than to keeping. Fail closed on the enum too.
           *
           * This is not a suspension POLICY. Nothing here decides that a vendor
           * should be suspended; an operator already did, and this reacts to what
           * they recorded.
           */
          if (input.decision !== 'approved') {
            await tx`
              UPDATE market.vendor_slots SET released_at = now()
               WHERE vendor_id = ${input.vendorId} AND released_at IS NULL
            `;
          }

          const [row] = await tx<StatusEventRow[]>`
            INSERT INTO market.vendor_status_events (vendor_id, from_status, to_status, reason, actor_id, actor_scope)
            VALUES (
              ${input.vendorId},
              ${vendor.status}::market.vendor_status,
              ${input.decision}::market.vendor_status,
              ${reason},
              ${input.actorId},
              ${input.actorScope}
            )
            RETURNING id, seq, vendor_id, from_status, to_status, reason, actor_id, actor_scope, created_at
          `;

          if (!updated || !row) {
            // Unreachable through this path — both statements either return a
            // row or throw. Stated rather than asserted away with `!`, because a
            // silent `undefined` here would return `event: null`, which is the
            // shape of a NO-OP: the status would have changed and the caller
            // would be told nothing was recorded.
            throw new MarketError(
              `Vendor ${input.vendorId} was decided but the history row was not returned. The change has been rolled back.`,
              'market.vet_history_not_written',
            );
          }

          return { changed: true, vendor: toVendor(updated), event: toEvent(row) };
        },
        { isolation: 'read committed', maxAttempts: 5 },
      ),
    );
  }

  /**
   * The history, newest first — the answer to "why was this vendor rejected".
   *
   * Newest first because the question is almost always about the CURRENT state,
   * and the row that explains it is the last one written.
   *
   * Page size is owner-published — omit is not 50.
   */
  async history(vendorId: string, limit?: number): Promise<VendorStatusEventRecord[]> {
    const page = assertHistoryLimit(limit);
    const rows = await this.sql<StatusEventRow[]>`
      SELECT id, seq, vendor_id, from_status, to_status, reason, actor_id, actor_scope, created_at
        FROM market.vendor_status_events
       WHERE vendor_id = ${vendorId}
       ORDER BY seq DESC
       LIMIT ${page}
    `;
    return rows.map(toEvent);
  }

  // ── Stage 2: stake-gated listing slots ─────────────────────────────────────

  /** Slots held and not released. A COUNT, never a maintained counter. */
  async openSlotCount(vendorId: string, tx: Sql = this.sql): Promise<number> {
    const rows = await tx<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM market.vendor_slots WHERE vendor_id = ${vendorId} AND released_at IS NULL
    `;
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Take a listing slot.
   *
   * ── WHY THE SLOT IS CLAIMED UNDER A LOCK ───────────────────────────────────
   *
   * A capacity is only a capacity if two requests racing for the last slot
   * cannot both get it. The insert runs inside a transaction that locks the
   * VENDOR row first, so the occupancy count and the insert cannot interleave —
   * which is what makes `read committed` correct here (packages/db/src/
   * connection.ts explains when it is and when it is not). Same pattern, and
   * mostly the same words, as `svc-academy`'s seat claim.
   *
   * ── WHY THE LOCKED STATUS IS READ BEFORE THE STAKE CALL ────────────────────
   *
   * An applied, rejected, or suspended vendor is decidable from that row.
   * `listingEligibility` already answers those statuses without svc-token.
   * Calling `entitlementOf` first turns the refusal into `market.stake_unavailable`
   * whenever the gate is down or `vendorSlots` is not an integer, and the router
   * maps that code to HTTP 500. The status that gates the call is the locked
   * row, not `myVendor` above: a suspension recorded between those reads must
   * win.
   *
   * The stake read still does not hold the lock. Once the locked status can
   * still be allowed, that transaction ends and `entitlementOf` runs. Holding
   * FOR UPDATE across the network call would serialise every claim behind
   * svc-token, and an outage would hold the lock for the full fetch timeout.
   * The claim then locks again, re-reads status, and only then counts occupancy
   * and inserts. A stale entitlement can only admit a claim the vendor was
   * entitled to moments ago. If the status is no longer allowable, `vendorSlots`
   * is not consulted — including when it is not an integer. What must not be
   * stale is the OCCUPANCY, and that is counted inside the second lock.
   *
   * ── AND WHY IT IS IDEMPOTENT ───────────────────────────────────────────────
   *
   * A retried request must not consume a second slot for the same listing. The
   * already-held check runs inside the lock, so two simultaneous retries of one
   * claim resolve to one slot rather than racing each other — which is the same
   * oversell this method exists to prevent, arriving by the back door.
   */
  async claimSlot(input: { userId: string; ref: string }): Promise<{ claimed: boolean; slot: VendorSlotRecord }> {
    const ref = input.ref.trim();
    if (ref.length === 0) {
      throw new MarketError('A slot claim needs a reference naming what the slot is for', 'market.slot_ref_required');
    }

    const vendor = await this.myVendor(input.userId);
    if (!vendor) {
      throw new MarketError('You have not applied to be a vendor', 'market.vendor_not_found');
    }

    return withMarketSpan('market.slot.claim', { op: 'slot.claim', vendorId: vendor.id }, async (span) => {
      /**
       * Local facts under the lock, before any stake call. An already-held ref
       * and a status that cannot be allowed are both answers without svc-token.
       */
      const preview = await transaction(
        this.sql,
        async (tx) => {
          const locked = await this.lockedSlotClaim(tx, vendor.id, ref);
          if (locked.existing) return { kind: 'held' as const, slot: toSlot(locked.existing) };
          if (locked.status !== 'approved') {
            return { kind: 'refused' as const, decision: this.refuseUnapproved(locked.status) };
          }
          return { kind: 'approved' as const };
        },
        { isolation: 'read committed', maxAttempts: 5 },
      );

      if (preview.kind === 'held') {
        span.setAttribute('intafaced.decision', 'allowed');
        return { claimed: false, slot: preview.slot };
      }
      if (preview.kind === 'refused') {
        span.setAttribute('intafaced.decision', preview.decision.code);
        throw new MarketError(preview.decision.reason, preview.decision.code);
      }

      // The locked status could still be allowed. The network call stays outside the lock.
      const entitlement = await this.stakes.entitlementOf(input.userId);
      span.setAttribute('intafaced.market.slot_capacity', entitlement.vendorSlots);

      const outcome = await transaction(
        this.sql,
        async (tx) => {
          const locked = await this.lockedSlotClaim(tx, vendor.id, ref);
          if (locked.existing) return { decision: { allowed: true } as const, claimed: false, slot: toSlot(locked.existing), open: -1 };

          // Status may have changed while svc-token was being read. Do not use vendorSlots.
          if (locked.status !== 'approved') {
            return { decision: this.refuseUnapproved(locked.status), claimed: false, slot: null, open: -1 };
          }

          const open = await this.openSlotCount(vendor.id, tx);
          const decision = decideVendorSlot({ status: locked.status, capacity: entitlement.vendorSlots }, { open });
          if (!decision.allowed) return { decision, claimed: false, slot: null, open };

          const [row] = await tx<SlotRow[]>`
            INSERT INTO market.vendor_slots (vendor_id, ref)
            VALUES (${vendor.id}, ${ref})
            RETURNING id, vendor_id, ref, claimed_at, released_at
          `;
          if (!row) {
            // Unreachable: the insert either returns a row or throws. Stated
            // rather than asserted away, because a silent undefined here would
            // report a claim that did not happen.
            throw new MarketError('The slot was claimed but not returned. The claim has been rolled back.', 'market.slot_not_written');
          }
          return { decision, claimed: true, slot: toSlot(row), open };
        },
        { isolation: 'read committed', maxAttempts: 5 },
      );

      if (outcome.open >= 0) span.setAttribute('intafaced.market.slots_open', outcome.open);
      // A refusal is invisible from the outside — nobody files a ticket for a
      // slot they could not take. This attribute is the only place "how many
      // bounced off the stake gate" is a number.
      span.setAttribute('intafaced.decision', outcome.decision.allowed ? 'allowed' : outcome.decision.code);

      if (!outcome.decision.allowed) throw new MarketError(outcome.decision.reason, outcome.decision.code);
      return { claimed: outcome.claimed, slot: outcome.slot! };
    });
  }

  /**
   * The vendor row under `FOR UPDATE`, plus the open slot for this ref if one
   * is already held. Status comes from this read, not from `myVendor`.
   */
  private async lockedSlotClaim(tx: Sql, vendorId: string, ref: string): Promise<{ status: VendorStatus; existing: SlotRow | undefined }> {
    const [locked] = await tx<Array<{ id: string; status: VendorStatus }>>`
      SELECT id, status FROM market.vendors WHERE id = ${vendorId} FOR UPDATE
    `;
    if (!locked) throw new MarketError(`No vendor application ${vendorId}`, 'market.vendor_not_found');

    const [existing] = await tx<SlotRow[]>`
      SELECT id, vendor_id, ref, claimed_at, released_at
        FROM market.vendor_slots
       WHERE vendor_id = ${vendorId} AND ref = ${ref} AND released_at IS NULL
    `;
    return { status: locked.status, existing };
  }

  /**
   * Refusal for a status that cannot hold a slot. `capacity` is unread — NaN
   * is not a slot count. `decideVendorSlot` answers from status alone.
   */
  private refuseUnapproved(status: VendorStatus): Extract<SlotDecision, { allowed: false }> {
    const decision = decideVendorSlot({ status, capacity: Number.NaN }, { open: 0 });
    if (!decision.allowed) return decision;
    return {
      allowed: false,
      code: 'market.vendor_not_approved',
      reason: 'Only an approved vendor may hold a listing slot.',
    };
  }

  /**
   * Give a slot back.
   *
   * NO LOCK, and that is not an oversight: releasing only ever FREES capacity.
   * Two concurrent releases of the same slot both land on the same row and the
   * second updates nothing, because the `released_at IS NULL` predicate has
   * already stopped matching. There is no interleaving here that could oversell
   * anything, and taking the vendor's row would put every release in the queue
   * behind every claim for no gain.
   *
   * No stake read either. A vendor who has lost their stake must still be able
   * to tidy up, and refusing a release because svc-token is unreachable would
   * fail closed in the direction that helps nobody.
   */
  async releaseSlot(input: { userId: string; ref: string }): Promise<{ released: boolean }> {
    const vendor = await this.myVendor(input.userId);
    if (!vendor) throw new MarketError('You have not applied to be a vendor', 'market.vendor_not_found');

    return withMarketSpan('market.slot.release', { op: 'slot.release', vendorId: vendor.id }, async () => {
      const rows = await this.sql<SlotRow[]>`
        UPDATE market.vendor_slots SET released_at = now()
         WHERE vendor_id = ${vendor.id} AND ref = ${input.ref.trim()} AND released_at IS NULL
         RETURNING id, vendor_id, ref, claimed_at, released_at
      `;
      // `false` rather than a 404: "that slot is not held" is an answer, and it
      // is the same answer a retried release should get.
      return { released: rows.length > 0 };
    });
  }

  /**
   * A vendor's slot position, with entitlement re-read from svc-token.
   *
   * ── THIS READ IS WHERE DoD CLAUSE 5 IS ENFORCED ────────────────────────────
   *
   * "Suspended / under-staked vendors cannot present as listed." A suspended
   * vendor's slots were released by `vet` in the same transaction as the
   * suspension — but an under-staked one's were not, because svc-market never
   * learns that somebody unstaked. There is no bus subject for it, and inventing
   * one with no publisher is what `tooling/ci/event-wiring.mjs` correctly reds
   * on; polling svc-token on a timer would be a second source of truth that is
   * wrong between ticks.
   *
   * So entitlement is re-derived HERE, on every read, against the tier svc-token
   * reports this second. `usable` is what Stage 3's public profile consumes; a
   * vendor who has dropped to Base reads `usable: 0` immediately, whether or not
   * any release ever happened.
   *
   * FAILS CLOSED. If svc-token cannot be reached this throws
   * `market.stake_unavailable` rather than returning the held count with a
   * guessed capacity — a read that cannot verify entitlement must not report a
   * vendor as listable.
   */
  async slotStatus(userId: string): Promise<VendorSlotStatus> {
    const vendor = await this.myVendor(userId);
    if (!vendor) throw new MarketError('You have not applied to be a vendor', 'market.vendor_not_found');

    const entitlement = await this.stakes.entitlementOf(userId);

    const rows = await this.sql<SlotRow[]>`
      SELECT id, vendor_id, ref, claimed_at, released_at
        FROM market.vendor_slots
       WHERE vendor_id = ${vendor.id} AND released_at IS NULL
       ORDER BY claimed_at ASC
    `;

    const facts = { status: vendor.status, capacity: entitlement.vendorSlots };
    return {
      vendorId: vendor.id,
      status: vendor.status,
      tier: entitlement.tierName,
      capacity: entitlement.vendorSlots,
      held: rows.length,
      usable: usableSlots(facts, { open: rows.length }),
      slots: rows.map(toSlot),
    };
  }

  // ── Stage 3: public list eligibility ───────────────────────────────────────

  /**
   * Is this vendor listed, right now?
   *
   * ── THE SEAM `market.commerce` CALLS ───────────────────────────────────────
   *
   * A service METHOD and not only a router procedure, because the consumer named
   * by the DoD ("feeds `market.commerce` listing create — refuse if not
   * listed/eligible") is another service's write path, not a browser. Commerce
   * asks by `userId` — a vendor creating a listing arrives as a principal, and
   * `market.commerce` has no reason to know svc-market's vendor id. The public
   * profile asks by `vendorId`. Both keys, one rule.
   *
   * ── ELIGIBILITY IS COMPUTED, NEVER STORED ──────────────────────────────────
   *
   * There is no `is_listed` column and there must not be one, for the reason
   * `services/svc-p2p/src/reputation.ts:71-75` already gives about badges: "a
   * badge that can only be granted is a badge that lies". A stored flag is
   * correct exactly until the fact under it changes and nothing runs — which for
   * unstaking is ALWAYS, because svc-market never learns that somebody unstaked
   * (no bus subject, no publisher, and polling would be a second source of truth
   * that is wrong between ticks). The flag would then say `listed` about a vendor
   * whose entitlement is gone, which is DoD clause 5 failing while looking fine.
   *
   * ── THE ORDER OF THE CHECKS IS LOAD-BEARING TWICE ──────────────────────────
   *
   * Every cheap local fact is settled before the network call. That is not only
   * a latency choice: it means a suspended vendor, a rejected one, an unknown id
   * and a vendor holding no slot are all answered WITHOUT svc-token, so an
   * svc-token outage cannot turn those into a 500. The only callers who reach the
   * stake read are the ones whose answer genuinely depends on it.
   *
   * ── WHAT IT THROWS RATHER THAN RETURNS, AND WHY THAT IS THE POINT ──────────
   *
   * Every finding ABOUT THE VENDOR is a returned value. `market.stake_unavailable`
   * is THROWN, because "we could not check" is not a finding about the vendor and
   * must never be recorded as one: a caller handed `{ listed: false, code:
   * 'market.stake_required' }` during an svc-token outage would tell an honest
   * vendor to go and stake, and a caller that logged it would log a mass
   * unstaking that never happened. Callers still fail CLOSED on it — the profile
   * read below shows a vendor nothing, and the directory drops them — but they do
   * it knowing the difference.
   */
  async listingEligibility(target: { vendorId: string } | { userId: string }): Promise<VendorListingEligibility> {
    const [row] =
      'vendorId' in target
        ? await this.sql<VendorRow[]>`
            SELECT id, user_id, display_name, description, status, created_at, updated_at
              FROM market.vendors WHERE id = ${target.vendorId}
          `
        : await this.sql<VendorRow[]>`
            SELECT id, user_id, display_name, description, status, created_at, updated_at
              FROM market.vendors WHERE user_id = ${target.userId}
          `;

    if (!row) {
      return {
        vendorId: null,
        listed: false,
        code: 'market.vendor_not_found',
        reason: 'No vendor application for that id.',
      };
    }
    return this.eligibilityFor(toVendor(row));
  }

  /**
   * The rule itself, over a vendor row already read.
   *
   * Private so that no caller can hand it a row it did not read from this
   * service and get an eligibility verdict about a vendor that does not exist.
   */
  private async eligibilityFor(vendor: VendorRecord): Promise<VendorListingEligibility> {
    if (vendor.status !== 'approved') {
      /**
       * Suspended, rejected and still-undecided collapse into ONE code on
       * purpose. This value reaches a public surface, and "suspended" is an
       * operator's finding about a person: a public read that distinguished it
       * from "never applied" would let anyone enumerate who had been thrown off
       * the marketplace. `vet`'s reason, the actor and the event log stay behind
       * `market:ops` where Stage 1 put them.
       */
      return {
        vendorId: vendor.id,
        listed: false,
        code: 'market.vendor_not_approved',
        reason: 'Only an approved vendor can be listed.',
      };
    }

    const open = await this.openSlotCount(vendor.id);
    if (open === 0) {
      return {
        vendorId: vendor.id,
        listed: false,
        code: 'market.slot_required',
        reason: 'An approved vendor is listed once they hold a listing slot. Claim one.',
      };
    }

    /**
     * The live tier, every time — the whole mechanism behind "under-staked
     * vendors cannot present as listed". A vendor who claimed three slots at
     * Operator and then unstaked to Base still HOLDS three rows, because nothing
     * released them and nothing was ever going to. `usableSlots` clamps them to
     * what the tier svc-token reports THIS SECOND actually covers, which is zero.
     *
     * Status and the open count above are only the reason this call is allowed.
     * `vet` can suspend, and `releaseSlot` can free the last slot, while
     * svc-token is in flight. Those pre-await values must not decide `listed`.
     * The reads below are plain selects: a lock held across this call would
     * deadlock the suspension that has to commit during it.
     */
    const entitlement = await this.stakes.entitlementOf(vendor.userId);
    const [fresh] = await this.sql<Array<{ status: VendorStatus }>>`
      SELECT status FROM market.vendors WHERE id = ${vendor.id}
    `;
    if (!fresh) {
      return {
        vendorId: null,
        listed: false,
        code: 'market.vendor_not_found',
        reason: 'No vendor application for that id.',
      };
    }
    const openNow = await this.openSlotCount(vendor.id);
    if (fresh.status !== 'approved') {
      return {
        vendorId: vendor.id,
        listed: false,
        code: 'market.vendor_not_approved',
        reason: 'Only an approved vendor can be listed.',
      };
    }
    if (openNow === 0) {
      return {
        vendorId: vendor.id,
        listed: false,
        code: 'market.slot_required',
        reason: 'An approved vendor is listed once they hold a listing slot. Claim one.',
      };
    }
    if (usableSlots({ status: fresh.status, capacity: entitlement.vendorSlots }, { open: openNow }) === 0) {
      return {
        vendorId: vendor.id,
        listed: false,
        // `stake_required` rather than `slots_exhausted`: the slots are held, it
        // is the entitlement that went away, and re-staking is the thing that
        // fixes it. Same code and same instruction as the claim path's stake gate.
        code: 'market.stake_required',
        reason: 'Your stake no longer covers a listing slot. Stake IFC to be listed again.',
      };
    }

    return { vendorId: vendor.id, listed: true };
  }

  /**
   * Which open listing slots still count under the CURRENT stake capacity.
   *
   * Stage 3 deliberately leaves over-held rows open after unstake (no bus).
   * Vendor-level listed stays true while usable ≥ 1. Commerce must decide
   * which listings stay sellable: oldest open slot first (`claimed_at ASC`),
   * cap = usable. Excess refs refuse with `market.listing_over_capacity`.
   *
   * Throws `market.stake_unavailable` the same way `listingEligibility` does —
   * "we could not check" is not a vendor finding.
   */
  async entitledListingRefs(vendorId: string): Promise<Set<string>> {
    const [row] = await this.sql<VendorRow[]>`
      SELECT id, user_id, display_name, description, status, created_at, updated_at
        FROM market.vendors WHERE id = ${vendorId}
    `;
    if (!row || row.status !== 'approved') return new Set();

    const entitlement = await this.stakes.entitlementOf(row.user_id);
    const slots = await this.sql<Array<{ ref: string | null }>>`
      SELECT ref FROM market.vendor_slots
       WHERE vendor_id = ${vendorId} AND released_at IS NULL
       ORDER BY claimed_at ASC
    `;
    const usable = usableSlots({ status: row.status, capacity: entitlement.vendorSlots }, { open: slots.length });
    const out = new Set<string>();
    for (const s of slots) {
      if (out.size >= usable) break;
      if (s.ref) out.add(s.ref);
    }
    return out;
  }

  /**
   * What an unauthenticated visitor sees — `null` unless the vendor is listed.
   *
   * ONE `null` FOR EVERY REASON. Unknown id, never approved, suspended, holds no
   * slot, unstaked — all the same answer, because the alternative is a probe: a
   * caller that could tell "suspended" from "no such vendor" could enumerate
   * every vendor an operator has thrown off the marketplace, without holding
   * `market:ops` and without leaving a trace. The distinguishing detail lives in
   * `listingEligibility` for the services that are entitled to it.
   *
   * Fails closed by construction: an unreadable stake source throws out of
   * `listingEligibility`, so it is never mistaken for `listed: false`.
   */
  async publicProfile(vendorId: string): Promise<PublicVendorProfile | null> {
    const [row] = await this.sql<VendorRow[]>`
      SELECT id, user_id, display_name, description, status, created_at, updated_at
        FROM market.vendors WHERE id = ${vendorId}
    `;
    if (!row) return null;

    const vendor = toVendor(row);
    const eligibility = await this.eligibilityFor(vendor);
    return eligibility.listed ? toPublicProfile(vendor) : null;
  }

  /**
   * The public directory — every vendor who is listed right now.
   *
   * ── THE ORDER IS DELIBERATELY BORING ───────────────────────────────────────
   *
   * `created_at ASC`, tie-broken by id. Registration order: a fact the database
   * already holds, stable under pagination, and it says nothing about how good
   * anybody is. Ranking, quality scoring and featured placement are reserved to
   * the owner by `docs/DIRECTION-2026-07-31.md:186-199` §8, and picking one here
   * — even "newest first", which is a growth choice — would be this service
   * deciding listing policy. A public list is not a ranked list.
   *
   * ── FAILS CLOSED PER VENDOR ────────────────────────────────────────────────
   *
   * A vendor whose stake cannot be read is DROPPED, not shown. One flaky lookup
   * therefore costs one vendor rather than blanking the marketplace, and a total
   * svc-token outage returns an empty page — nobody appears, rather than
   * everybody. That empty page is the honest answer: it is not "there are no
   * vendors", it is "nobody whose entitlement we can currently prove", and the
   * span attribute below is where that difference is a number rather than a
   * silence nobody can see.
   *
   * Candidate rows are bounded by the requested page size and checked in
   * parallel, preserving registration order regardless of lookup completion.
   * After `entitlementOf`, `eligibilityFor` decides from fresh status and slot
   * facts. A short page remains possible: refilling through more candidates
   * would multiply stake calls without a whole-request cancellation contract.
   *
   * ponytail: one stake read per candidate, at most the page size. Page size is
   * owner-published — omit is not 20. The upgrade path when the directory gets
   * real traffic is a BATCH entitlement read on svc-token — never a cached
   * `is_listed`, which is the exact lie this method exists to avoid.
   */
  async listedVendors(options: { limit?: number } = {}): Promise<PublicVendorProfile[]> {
    const limit = assertListedVendorsListLimit(options.limit);

    /**
     * Both cheap gates are the database's: approved, and holding at least one
     * open slot. Only the survivors cost a network call, so the common case —
     * most rows in this table are applications nobody has decided yet — reaches
     * svc-token zero times. An open slot is not a listed vendor.
     */
    const rows = await this.sql<VendorRow[]>`
      SELECT v.id, v.user_id, v.display_name, v.description, v.status, v.created_at, v.updated_at
        FROM market.vendors v
       WHERE v.status = 'approved'::market.vendor_status
         AND EXISTS (SELECT 1 FROM market.vendor_slots s WHERE s.vendor_id = v.id AND s.released_at IS NULL)
       ORDER BY v.created_at ASC, v.id ASC
       LIMIT ${limit}
    `;

    return withMarketSpan('market.listed', { op: 'listed' }, async (span) => {
      let unreadable = 0;
      const checked = await Promise.all(
        rows.map(async (row) => {
          const vendor = toVendor(row);
          try {
            const eligibility = await this.eligibilityFor(vendor);
            return eligibility.listed ? toPublicProfile(vendor) : null;
          } catch {
            // Fail closed per vendor, with no further candidate lookups.
            unreadable += 1;
            return null;
          }
        }),
      );

      span.setAttribute('intafaced.market.listed_candidates', rows.length);
      span.setAttribute('intafaced.market.listed_stake_unreadable', unreadable);
      return checked.filter((profile): profile is PublicVendorProfile => profile !== null);
    });
  }
}
