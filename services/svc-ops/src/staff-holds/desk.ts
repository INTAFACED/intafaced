import { createHash } from 'node:crypto';
import {
  POST_IN_FLIGHT_BOUND_SECONDS,
  LedgerError,
  classifyPostOutcome,
  formatAmount,
  parseAmount,
  recipes,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import {
  STAFF_HOLD_TARGET_SERVICE,
  normaliseStaffHoldAmount,
  staffHoldConfirmFields,
  staffHoldReleaseFields,
  staffHoldTargetId,
  type StaffHold,
  type StaffHoldConfirmInput,
  type StaffHoldList,
  type StaffHoldPlaceInput,
  type StaffHoldReleaseInput,
  type StaffHoldResult,
  type StaffHoldState,
} from '@intafaced/contracts';
import {
  OPS_HOLD_ACCOUNT_ARCHIVED,
  OPS_HOLD_ACCOUNT_UNREADABLE,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
  STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING,
  STAFF_HOLD_CONFIRM_ACCOUNT_UNSET,
  STAFF_HOLD_EXPIRY_TOO_LONG,
  STAFF_HOLD_EXPIRY_UNSET,
  STAFF_HOLD_LEDGER_UNCONFIGURED,
  STAFF_HOLD_NOT_FOUND,
  STAFF_HOLD_STATE_ILLEGAL,
  STAFF_HOLD_STORAGE_UNCONFIGURED,
} from '../codes.js';
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import {
  expiryBlocked,
  retryDue,
  type AttemptOutcome,
  type HoldRow,
  type LockedHold,
  type MovementRow,
  type StaffHoldStore,
} from './store.js';

/** What the ledger's `txByKey` door says of a booked key: the transaction, and the module and reason that posted it. */
export interface StaffHoldLedgerKey {
  readonly txId: string;
  readonly module: string;
  readonly reason: string;
}

/**
 * The ledger calls this desk makes: one post per attempt (no transport retry) and the read by key. svc-ops reads the
 * `txByKey` door only, so the read answers who booked the key, never the entries (ADR 3.7 rule 5).
 */
export interface StaffHoldLedger extends Pick<LedgerClient, 'post'> {
  findByKey(idempotencyKey: string): Promise<StaffHoldLedgerKey | null>;
}

export interface StaffHoldSettings {
  /** Owner-named `ops:hold-confirm:<slug>` account. Blank: confirm refuses `owner.decision` and nothing posts. */
  readonly confirmAccount: string | null;
  /** Longest expiry in hours. Blank: no expiry is offered (`ops.hold_expiry_unset`); holds without one still work. */
  readonly expiryMaxHours: number | null;
}

/** Whether a customer record is archived, as identity says. `unreadable` for no answer: never taken as not archived. */
export interface HoldOwnerArchive {
  archived(userId: string): Promise<boolean | 'unreadable'>;
}

export interface StaffHoldDeskDeps {
  readonly store: StaffHoldStore | undefined;
  /** Identity's archive state of a hold's owner. Undefined: a place or a confirm refuses `ops.hold_account_unreadable`. */
  readonly ownerArchive: HoldOwnerArchive | undefined;
  readonly ledger: StaffHoldLedger | undefined;
  readonly approvals: ApprovalConsumer | undefined;
  readonly settings: StaffHoldSettings;
  readonly now: () => Date;
  /** Called when the expiry or settlement worker fails on one hold; the worker carries on with the next. */
  readonly onWorkerError?: (holdNo: string, err: unknown) => void;
}

/** A ledger refusal that was settled on the row, passed to the caller as the ledger typed it. */
const LEDGER_POST_LOST = 'ledger.post_lost' as const;
const LEDGER_POST_UNSENT = 'ledger.post_unsent' as const;
/** The key holds a post that is not this movement's (another module or reason): this body can never post under it. */
const LEDGER_KEY_TAKEN = 'ledger.idempotency_conflict' as const;

/**
 * `ledger.post_lost` rests on the in-flight bound, which is evidence, not proof. For a day after a movement is declared
 * lost, its key is read again every 10 minutes; a post found then is recorded, so funds it moved are never out of the
 * desk's reach.
 */
const LOST_RECHECK_FOR_MS = 24 * 3_600_000;
const LOST_RECHECK_EVERY_MS = 10 * 60_000;

const HOLDING: readonly StaffHoldState[] = ['active', 'partially_released'];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const inFlight = (movements: readonly MovementRow[]) => movements.some((m) => m.status === 'settling' || m.status === 'pending_retry');
/** A `settling` movement that was sent at least once may have posted: only the ledger's book settles it. */
const inDoubt = (m: MovementRow) => m.status === 'settling' && (m.uncertain || m.attempts > 0);
/** Declared lost by the in-flight bound (evidence, not proof), as opposed to a refusal the ledger gave. */
const isLost = (m: MovementRow) => m.status === 'refused' && m.code === LEDGER_POST_LOST && m.uncertain;
/** The booked key is this movement's post: the same module and reason (the door gives no entries to compare). */
const isOwnPost = (found: StaffHoldLedgerKey, request: PostRequest) => found.module === request.module && found.reason === request.reason;

function view(hold: HoldRow, movements: readonly MovementRow[]): StaffHold {
  return {
    holdNo: hold.holdNo,
    userId: hold.userId,
    assetId: hold.assetId,
    amount: hold.amount,
    remaining: hold.remaining,
    state: hold.state,
    reason: hold.reason,
    expiresAt: hold.expiresAt,
    placedBy: hold.placedBy,
    placedAt: hold.placedAt,
    movements: movements.map((m) => ({
      kind: m.kind,
      no: m.no,
      amount: m.amount,
      status: m.status,
      cause: m.cause,
      idempotencyKey: m.ledgerKey,
      requesterId: m.requesterId,
      approverId: m.approverId,
      txId: m.txId,
      code: m.code,
      at: m.at,
    })),
  };
}

/** The hold's remaining amount and state once a movement has posted (`late`: found after it was declared lost). */
function afterPosted(hold: HoldRow, movement: MovementRow, late = false): { remaining: string; state: StaffHoldState } {
  // A place found in the book after it was declared lost brings its refused hold back with everything it holds.
  if (movement.kind === 'place') return { remaining: late ? movement.amount : hold.remaining, state: 'active' };
  const left = parseAmount(hold.remaining) - parseAmount(movement.amount);
  const remaining = formatAmount(left < 0n ? 0n : left);
  if (movement.kind === 'confirm') return { remaining, state: 'confirmed' };
  if (left > 0n) return { remaining, state: 'partially_released' };
  return { remaining, state: movement.cause === 'expiry' ? 'expired' : 'released' };
}

/**
 * Staff holds on funds (OPS-accounts-desk-01; ops ENGINE LC-8, LC-9; ADR 2026-10-22 service-access-calls 3.7).
 *
 * Every ledger post is written down first: a movement row with its number and key is stored (and, for a release or a
 * confirm, the second founder's approval spent) under the hold's row lock, then the post is sent outside the lock, then its
 * answer is recorded under the lock again. A movement that is still `settling` or `pending_retry` blocks every other action
 * on the hold, so a release and a confirm asked for at once never both post: the second is refused
 * `ops.hold_state_illegal` and, once the first has settled, meets the amount that is left.
 *
 * What a post's answer proves follows `classifyPostOutcome`: only a named engine refusal on a key that was never sent
 * without an answer marks a movement refused (a place then leaves the hold `refused`, nothing held). The posting freeze
 * (`ledger.frozen`) and a request that never left this process keep the movement `pending_retry`; `resolve` sends the
 * same request again under the same key. Any other failure, or a crash after a post was sent, leaves the movement in
 * doubt: from then on nothing is re-sent and only the ledger's book decides. `resolve` reads the key: there means
 * posted; still missing once POST_IN_FLIGHT_BOUND_SECONDS have passed since the last send means it never will be
 * (`ledger.post_lost`). A key is never reused for a different body and a number is never allocated twice.
 *
 * Known limit, the same as every console-mode founder action: if this process dies after identity has spent a release
 * or confirm approval and before the movement row commits, the approval is spent and nothing is stored. A retry with
 * the same approval is refused `action_approval.not_founders` (identity's replay of a spent approval carries no founder
 * attestation), so the founders ask for a fresh approval; no value has moved.
 */
export class StaffHoldDesk {
  constructor(private readonly deps: StaffHoldDeskDeps) {}

  private store(): StaffHoldStore {
    if (!this.deps.store)
      throw new OpsError(
        STAFF_HOLD_STORAGE_UNCONFIGURED,
        'No durable storage is configured for staff holds, so none can be read or placed.',
      );
    return this.deps.store;
  }

  private ledger(): StaffHoldLedger {
    if (!this.deps.ledger)
      throw new OpsError(
        STAFF_HOLD_LEDGER_UNCONFIGURED,
        'The ledger is not wired to this service, so nothing can be held, released or confirmed.',
      );
    return this.deps.ledger;
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }

  async list(userId: string): Promise<StaffHoldList> {
    const rows = await this.store().list(userId);
    return {
      holds: rows.map((r) => view(r.hold, r.movements)),
      settings: { expiryMaxHours: this.deps.settings.expiryMaxHours, confirmAccountSet: this.deps.settings.confirmAccount !== null },
      asOf: this.iso(),
    };
  }

  async place(requesterId: string, input: StaffHoldPlaceInput): Promise<StaffHoldResult> {
    const store = this.store();
    this.ledger();
    const amount = normaliseStaffHoldAmount(input.amount);
    const hours = input.expiresInHours ?? null;
    const placeKey = `ops.hold.place:${input.idempotencyKey}`;
    const same = (h: HoldRow) =>
      h.userId === input.userId &&
      h.assetId === input.assetId &&
      h.amount === amount &&
      h.reason === input.reason &&
      h.placedBy === requesterId &&
      (h.expiresAt === null) === (hours === null);
    // A retry answers from the stored hold, even if the owner's longest expiry has changed since it was placed.
    const prior = await store.findByRequestKey(placeKey);
    if (prior) {
      if (!same(prior.hold)) throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this key already placed a different hold');
      return this.finish(prior.hold.holdNo, placeKey, true);
    }
    // An archived record takes no new staff action, so a new hold on it is refused before anything is stored or held.
    await this.refuseArchived(input.userId, 'placed');
    if (hours !== null) {
      const max = this.deps.settings.expiryMaxHours;
      if (max === null)
        throw new OpsError(STAFF_HOLD_EXPIRY_UNSET, 'The owner has set no longest hold expiry, so a hold cannot be given one.');
      if (hours > max) throw new OpsError(STAFF_HOLD_EXPIRY_TOO_LONG, `A hold may expire in at most ${max} hours.`);
    }
    const now = this.deps.now();
    const placed = await store.placeIntent({
      placeKey,
      userId: input.userId,
      assetId: input.assetId,
      amount,
      reason: input.reason,
      expiresAt: hours === null ? null : new Date(now.getTime() + hours * 3_600_000).toISOString(),
      placedBy: requesterId,
      at: now.toISOString(),
    });
    if (!placed.created && !same(placed.hold)) throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this key already placed a different hold');
    return this.finish(placed.hold.holdNo, placed.movement.requestKey, !placed.created);
  }

  async release(requesterId: string, input: StaffHoldReleaseInput): Promise<StaffHoldResult> {
    this.ledger();
    const amount = normaliseStaffHoldAmount(input.amount);
    const requestKey = `ops.hold.release:${input.approvalId.trim()}`;
    return this.act(
      input.holdNo,
      requestKey,
      (m) => m.kind === 'release' && m.amount === amount,
      async (locked) => {
        if (parseAmount(amount) > parseAmount(locked.hold.remaining))
          throw new OpsError(STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING, `Only ${locked.hold.remaining} ${locked.hold.assetId} is still held.`);
        const consumed = await consumeFounderApproval(this.deps.approvals, {
          approvalId: input.approvalId,
          operationId: input.operationId,
          requestId: `ops-hold:${sha(requestKey)}`,
          actionType: 'ops.hold.release',
          targetService: STAFF_HOLD_TARGET_SERVICE,
          targetId: staffHoldTargetId(input.holdNo),
          fields: staffHoldReleaseFields(input.holdNo, amount),
          requesterId,
        });
        return locked.addMovement({
          kind: 'release',
          amount,
          cause: 'approval',
          requestKey,
          approvalId: consumed.approvalId,
          requesterId: consumed.requesterId,
          approverId: consumed.approverId ?? null,
          expiresAt: null,
          confirmAccount: null,
          at: this.iso(),
          ledgerKey: (no) => `ops:hold-release:${input.holdNo}:${no}`,
        });
      },
    );
  }

  async confirm(requesterId: string, input: StaffHoldConfirmInput): Promise<StaffHoldResult> {
    this.ledger();
    const confirmAccount = this.deps.settings.confirmAccount;
    const requestKey = `ops.hold.confirm:${input.approvalId.trim()}`;
    // Identity is asked before the hold's row lock is taken, so a slow answer holds no lock or connection; the answer is
    // applied under the lock, and only to a new confirm (a replay answers as stored).
    const owner = await this.store().lock(input.holdNo, async (locked) => locked.hold.userId);
    const archived = owner === null ? null : await this.archivedOf(owner);
    return this.act(
      input.holdNo,
      requestKey,
      (m) => m.kind === 'confirm',
      async (locked) => {
        if (confirmAccount === null)
          throw new OpsError(
            STAFF_HOLD_CONFIRM_ACCOUNT_UNSET,
            'The owner has not named the account a confirmed hold moves to. Nothing was posted.',
          );
        // A confirm moves the held money onward, a new movement, so an archived (read-only) record refuses it before the
        // approval is spent (lead ruling 2026-10-31). Release stays open: it only gives back what is already held.
        this.refuseArchive(locked.hold.userId === owner ? archived : 'unreadable', 'confirmed');
        const consumed = await consumeFounderApproval(this.deps.approvals, {
          approvalId: input.approvalId,
          operationId: input.operationId,
          requestId: `ops-hold:${sha(requestKey)}`,
          actionType: 'ops.hold.confirm',
          targetService: STAFF_HOLD_TARGET_SERVICE,
          targetId: staffHoldTargetId(input.holdNo),
          fields: staffHoldConfirmFields(input.holdNo),
          requesterId,
        });
        return locked.addMovement({
          kind: 'confirm',
          amount: locked.hold.remaining,
          cause: 'approval',
          requestKey,
          approvalId: consumed.approvalId,
          requesterId: consumed.requesterId,
          approverId: consumed.approverId ?? null,
          expiresAt: null,
          confirmAccount,
          at: this.iso(),
          ledgerKey: (no) => `ops:hold-confirm:${input.holdNo}:${no}`,
        });
      },
    );
  }

  /** Whether the workers have anything to work with: storage and the ledger are both wired. */
  get active(): boolean {
    return this.deps.store !== undefined && this.deps.ledger !== undefined;
  }

  /**
   * Release what is left of each hold whose stored expiry has passed (LC-9). The release number is stored with the
   * movement before the post, so a retry after a crash reuses it; the stored expiry is checked against this clock again
   * under the lock. A hold whose expiry release the ledger refused is not tried again: it stays held, its refused
   * movement shows the ledger's code, and a founder release with an approval is the way out.
   */
  async expireDue(limit = 20): Promise<number> {
    const store = this.store();
    this.ledger();
    let released = 0;
    for (const holdNo of await store.expired(this.iso(), limit)) {
      try {
        const movement = await store.lock(holdNo, async (locked) => {
          const { hold } = locked;
          if (!HOLDING.includes(hold.state) || hold.expiresAt === null || hold.expiresAt > this.iso()) return null;
          if (inFlight(locked.movements) || parseAmount(hold.remaining) <= 0n) return null;
          if (expiryBlocked(locked.movements)) return null;
          const n = locked.movements.filter((m) => m.cause === 'expiry').length + 1;
          return locked.addMovement({
            kind: 'release',
            amount: hold.remaining,
            cause: 'expiry',
            requestKey: `expiry:${holdNo}:${n}`,
            approvalId: null,
            requesterId: null,
            approverId: null,
            expiresAt: hold.expiresAt,
            confirmAccount: null,
            at: this.iso(),
            ledgerKey: (no) => `ops:hold-release:${holdNo}:${no}`,
          });
        });
        if (movement) {
          await this.drive(holdNo, movement.requestKey);
          released += 1;
        }
      } catch (err) {
        // One hold's failure never stops the others; the next tick tries it again.
        this.deps.onWorkerError?.(holdNo, err);
      }
    }
    return released;
  }

  /**
   * Settle every movement still `settling` or `pending_retry`. One that is not in doubt (`pending_retry`, or never sent)
   * is sent again under its key. One in doubt is never re-sent: its key is read, and it settles from the ledger's book.
   */
  async resolve(limit = 20): Promise<number> {
    const store = this.store();
    this.ledger();
    let settled = 0;
    for (const holdNo of await store.unsettled(this.iso(), limit)) {
      try {
        const found = await store.lock(holdNo, async (locked) => {
          const open = locked.movements.find((m) => m.status === 'settling' || m.status === 'pending_retry');
          if (!open) return null;
          // Looked at now: the next tick starts with the movements looked at longest ago.
          await locked.check(open.requestKey, this.iso());
          return { hold: locked.hold, open };
        });
        if (!found) continue;
        const { hold, open } = found;
        if (inDoubt(open)) await this.readBack(hold, open);
        else if (retryDue(open, this.deps.now().getTime())) await this.drive(holdNo, open.requestKey);
        else continue;
        settled += 1;
      } catch (err) {
        this.deps.onWorkerError?.(holdNo, err);
      }
    }
    return settled;
  }

  /**
   * Read again the keys of movements declared `ledger.post_lost` in the last day, each at most every 10 minutes. A post
   * found in the book under its key, from this module with this movement's reason, is recorded as posted after all: a
   * refused place brings its hold back, and a release or confirm takes its amount off what is held. A key found holding
   * another post is recorded `ledger.idempotency_conflict` and not read again.
   *
   * Known limit: a post that commits more than a day after it was declared lost is not found here. The ledger has no way
   * yet to close a key so it can never post; until it does, this bounded read is the guard.
   */
  async recheckLost(limit = 20): Promise<number> {
    const store = this.store();
    const ledger = this.ledger();
    const now = this.deps.now().getTime();
    const due = await store.lost(
      new Date(now - LOST_RECHECK_FOR_MS).toISOString(),
      new Date(now - LOST_RECHECK_EVERY_MS).toISOString(),
      limit,
    );
    let found = 0;
    for (const { holdNo, requestKey } of due) {
      try {
        const read = await store.lock(holdNo, async (locked) => {
          const m = locked.movements.find((r) => r.requestKey === requestKey);
          if (!m || !isLost(m)) return null;
          await locked.check(requestKey, this.iso());
          return { request: this.request(locked.hold, m), m };
        });
        if (!read) continue;
        const booked = await ledger.findByKey(read.m.ledgerKey);
        if (!booked) continue;
        // Another post holds the key: this body can never post under it, so it is settled for good and not read again.
        const outcome: Omit<AttemptOutcome, 'at'> = isOwnPost(booked, read.request)
          ? { status: 'posted', uncertain: true, txId: booked.txId, code: null }
          : { status: 'refused', uncertain: true, txId: null, code: LEDGER_KEY_TAKEN };
        await this.record(holdNo, requestKey, outcome, undefined, true);
        if (outcome.status === 'posted') found += 1;
      } catch (err) {
        this.deps.onWorkerError?.(holdNo, err);
      }
    }
    return found;
  }

  /* ---------------------------------------------------------------- internals */

  private async archivedOf(userId: string): Promise<boolean | 'unreadable'> {
    return this.deps.ownerArchive ? this.deps.ownerArchive.archived(userId) : 'unreadable';
  }

  private refuseArchive(archived: boolean | 'unreadable' | null, verb: 'placed' | 'confirmed'): void {
    if (archived === false) return;
    if (archived === true)
      throw new OpsError(
        OPS_HOLD_ACCOUNT_ARCHIVED,
        verb === 'placed'
          ? 'This customer record is archived and read-only, so no hold can be placed on it. Nothing was held.'
          : 'This customer record is archived and read-only, so the hold cannot be confirmed; it can still be released. Nothing was posted.',
      );
    throw new OpsError(
      OPS_HOLD_ACCOUNT_UNREADABLE,
      verb === 'placed'
        ? 'Whether this customer record is archived could not be read, so no hold was placed. Nothing was held.'
        : 'Whether this customer record is archived could not be read, so the hold was not confirmed. Nothing was posted.',
    );
  }

  private async refuseArchived(userId: string, verb: 'placed' | 'confirmed'): Promise<void> {
    this.refuseArchive(await this.archivedOf(userId), verb);
  }

  private async act(
    holdNo: string,
    requestKey: string,
    sameRequest: (m: MovementRow) => boolean,
    write: (locked: LockedHold) => Promise<MovementRow>,
  ): Promise<StaffHoldResult> {
    const store = this.store();
    const stored = await store.lock(holdNo, async (locked) => {
      const prior = locked.movements.find((m) => m.requestKey === requestKey);
      if (prior) {
        if (!sameRequest(prior))
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this approval was already used for a different action on the hold');
        return { movement: prior, replay: true };
      }
      if (!HOLDING.includes(locked.hold.state))
        throw new OpsError(
          STAFF_HOLD_STATE_ILLEGAL,
          `The hold is ${locked.hold.state.replace(/_/g, ' ')}; nothing is left to release or confirm.`,
        );
      if (inFlight(locked.movements))
        throw new OpsError(STAFF_HOLD_STATE_ILLEGAL, 'Another action on this hold is still settling with the ledger. Read the hold again.');
      return { movement: await write(locked), replay: false };
    });
    if (stored === null) {
      // The key may be on another hold: a replay with a different hold number is a conflict, not a missing hold.
      if (await store.findByRequestKey(requestKey))
        throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this approval was already used on another hold');
      throw new OpsError(STAFF_HOLD_NOT_FOUND, `No hold has number ${holdNo}.`);
    }
    return this.finish(holdNo, stored.movement.requestKey, stored.replay);
  }

  /** Drive a movement that has not settled, then answer with the hold as stored. */
  private async finish(holdNo: string, requestKey: string, replay: boolean): Promise<StaffHoldResult> {
    const found = await this.store().findByRequestKey(requestKey);
    const open = found && (found.movement.status === 'settling' || found.movement.status === 'pending_retry');
    // A client asking again does not jump the retry wait: the worker sends it when it is due.
    if (open && !inDoubt(found.movement) && retryDue(found.movement, this.deps.now().getTime())) {
      await this.drive(holdNo, requestKey);
    }
    const after = await this.store().lock(holdNo, async (locked) => ({
      hold: locked.hold,
      movements: locked.movements,
      movement: locked.movements.find((m) => m.requestKey === requestKey)!,
    }));
    if (!after) throw new OpsError(STAFF_HOLD_NOT_FOUND, `No hold has number ${holdNo}.`);
    const { movement } = after;
    if (movement.status === 'refused')
      throw new OpsError((movement.code ?? LEDGER_POST_LOST) as `ledger.${string}`, `The ledger refused the post (${movement.code}).`);
    const outcome = movement.status === 'posted' ? (replay ? 'replayed' : 'done') : 'settling';
    return { hold: view(after.hold, after.movements), outcome };
  }

  private request(hold: HoldRow, m: MovementRow): PostRequest {
    const base = { holdNo: hold.holdNo, userId: hold.userId, assetId: hold.assetId, amount: parseAmount(m.amount) };
    if (m.kind === 'place') return recipes.staffHoldPlace(base);
    if (m.kind === 'release') {
      const cause =
        m.cause === 'expiry'
          ? { kind: 'expiry' as const, expiresAt: m.expiresAt ?? '' }
          : { kind: 'approval' as const, approvalId: m.approvalId ?? '' };
      return recipes.staffHoldRelease({ ...base, releaseNo: m.no, cause });
    }
    return recipes.staffHoldConfirm({
      ...base,
      attempt: m.no,
      approvalId: m.approvalId ?? '',
      confirmAccount: m.confirmAccount ?? '',
      heldRemaining: parseAmount(m.amount),
    });
  }

  /** One post under the movement's key, its answer recorded on the row. */
  private async drive(holdNo: string, requestKey: string): Promise<void> {
    const store = this.store();
    const ledger = this.ledger();
    const sent = await store.lock(holdNo, async (locked) => {
      const m = locked.movements.find((r) => r.requestKey === requestKey);
      if (!m || (m.status !== 'settling' && m.status !== 'pending_retry') || inDoubt(m)) return null;
      await locked.attempt(requestKey, this.iso());
      return { request: this.request(locked.hold, m), uncertain: m.uncertain };
    });
    if (!sent) return;
    let outcome: Omit<AttemptOutcome, 'at'>;
    try {
      const tx = await ledger.post(sent.request);
      outcome = { status: 'posted', uncertain: sent.uncertain, txId: tx.id, code: null };
    } catch (err) {
      const cls = classifyPostOutcome(err, { singleAttempt: true });
      if (sent.uncertain || cls === 'unknown') {
        outcome = { status: 'settling', uncertain: true, txId: null, code: null };
      } else if (cls === 'unsent' || (err instanceof LedgerError && err.code === 'ledger.frozen')) {
        outcome = { status: 'pending_retry', uncertain: false, txId: null, code: cls === 'unsent' ? LEDGER_POST_UNSENT : 'ledger.frozen' };
      } else {
        outcome = { status: 'refused', uncertain: false, txId: null, code: err instanceof LedgerError ? err.code : LEDGER_POST_LOST };
      }
    }
    await this.record(holdNo, requestKey, outcome);
  }

  /**
   * The ledger's book decides a movement in doubt: the key is there (posted), or it is still missing once the in-flight
   * bound has passed since the last send (it never will be: refused `ledger.post_lost`). Before the bound, a missing key
   * changes nothing.
   */
  private async readBack(hold: HoldRow, open: MovementRow): Promise<void> {
    const holdNo = hold.holdNo;
    const booked = await this.ledger().findByKey(open.ledgerKey);
    if (booked) {
      // A post from another module or for another reason is not this movement's.
      if (!isOwnPost(booked, this.request(hold, open))) {
        await this.record(
          holdNo,
          open.requestKey,
          { status: 'refused', uncertain: true, txId: null, code: LEDGER_KEY_TAKEN },
          open.attempts,
        );
        return;
      }
      await this.record(holdNo, open.requestKey, { status: 'posted', uncertain: true, txId: booked.txId, code: null });
      return;
    }
    const sentAt = Date.parse(open.lastAttemptAt ?? open.at);
    if (sentAt + POST_IN_FLIGHT_BOUND_SECONDS * 1000 > this.deps.now().getTime()) return;
    await this.record(holdNo, open.requestKey, { status: 'refused', uncertain: true, txId: null, code: LEDGER_POST_LOST }, open.attempts);
  }

  /**
   * `sentTimes`: a key read back as missing proves nothing if another send went out under it after the read began.
   * `late`: a movement declared lost may still become posted, and nothing else.
   */
  private async record(
    holdNo: string,
    requestKey: string,
    outcome: Omit<AttemptOutcome, 'at'>,
    sentTimes?: number,
    late = false,
  ): Promise<void> {
    await this.store().lock(holdNo, async (locked) => {
      const m = locked.movements.find((r) => r.requestKey === requestKey);
      if (!m) return;
      if (late ? !isLost(m) : m.status !== 'settling' && m.status !== 'pending_retry') return;
      if (sentTimes !== undefined && m.attempts !== sentTimes) return;
      const at = this.iso();
      if (outcome.status === 'posted') {
        await locked.settle(requestKey, { ...outcome, at }, afterPosted(locked.hold, m, late));
      } else if (outcome.status === 'refused' && m.kind === 'place' && !late) {
        await locked.settle(requestKey, { ...outcome, at }, { remaining: '0', state: 'refused' });
      } else {
        await locked.settle(requestKey, { ...outcome, at }, { remaining: locked.hold.remaining, state: locked.hold.state });
      }
    });
  }
}
