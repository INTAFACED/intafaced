import { createHash } from 'node:crypto';
import { formatAmount, isNegative, isZero, sum, type Amount } from './money.js';
import {
  UnbalancedTransactionError,
  InvalidEntryError,
  OwnerIdentitySpaceError,
  accountPurpose,
  isValidOwnerId,
  LOCK_KIND_LIST,
  type AccountKind,
  type AccountRef,
  type Balance,
  type EntryInput,
  type LedgerTx,
  type PostRequest,
} from './types.js';

/**
 * THE LEDGER CLIENT.
 *
 * Doctrine §0.6: "No module holds its own balance. Every value movement
 * anywhere in the OS is a double-entry ledger transaction in the Core."
 *
 * §2: "Balance mutations go through packages/ledger-client only."
 *
 * Services depend on this interface, not on svc-ledger's implementation or —
 * ever — its tables. `custody-scan` (Doctrine 10) asserts that no Protocol
 * Plane service imports the write half of this module.
 */
export interface LedgerClient {
  /**
   * Post a double-entry transaction. Atomic, idempotent, and invariant-checked.
   * Re-posting the same `idempotencyKey` returns the original transaction.
   */
  post(request: PostRequest): Promise<LedgerTx>;

  /** Current balance of one account. Creates nothing. */
  balance(ref: AccountRef): Promise<Balance>;

  /** Every balance an owner holds, across assets and account kinds. */
  balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]>;

  /** Fetch a posted transaction. */
  getTx(txId: string): Promise<LedgerTx | null>;

  /** Look a transaction up by its idempotency key. */
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
}

/** Read-only view — what Protocol Plane services and dashboards may hold. */
export type ReadOnlyLedgerClient = Pick<LedgerClient, 'balance' | 'balances' | 'getTx' | 'getTxByKey'>;

export function readOnly(client: LedgerClient): ReadOnlyLedgerClient {
  return {
    balance: client.balance.bind(client),
    balances: client.balances.bind(client),
    getTx: client.getTx.bind(client),
    getTxByKey: client.getTxByKey.bind(client),
  };
}

// ── Invariants ───────────────────────────────────────────────────────────────

export function accountKey(ref: AccountRef): string {
  // `purpose` is part of account IDENTITY, not metadata (P0-3). Omitting it here
  // would collapse `order:a` and `withdraw:b` back into one balance in every
  // in-memory implementation, which is the bug with extra steps.
  return `${ref.ownerType}:${ref.ownerId}:${ref.assetId}:${ref.kind}:${accountPurpose(ref)}`;
}

/** Signed delta an entry applies to its account: debit adds, credit subtracts. */
export function signedDelta(entry: EntryInput): Amount {
  return entry.direction === 'debit' ? entry.amount : -entry.amount;
}

/**
 * INVARIANT 1 — every transaction sums to zero per asset.
 *
 * Enforced here so it holds identically in every implementation: the Postgres
 * one, the in-memory one, and any future port. A transaction that fails this
 * never reaches a database.
 */
export function assertBalanced(entries: readonly EntryInput[]): void {
  if (entries.length < 2) {
    throw new InvalidEntryError('A ledger transaction needs at least two entries — value moves between accounts, never from nowhere');
  }

  const perAsset = new Map<string, Amount>();

  for (const e of entries) {
    if (isNegative(e.amount)) {
      throw new InvalidEntryError(
        `Entry amounts are unsigned; direction carries the sign. Got ${formatAmount(e.amount)} on ${accountKey(e.account)}`,
      );
    }
    if (isZero(e.amount)) {
      throw new InvalidEntryError(`Zero-amount entry on ${accountKey(e.account)} — a movement of nothing is not a movement`);
    }
    perAsset.set(e.account.assetId, (perAsset.get(e.account.assetId) ?? 0n) + signedDelta(e));
  }

  const offenders: Record<string, string> = {};
  for (const [assetId, delta] of perAsset) {
    if (delta !== 0n) offenders[assetId] = formatAmount(delta);
  }

  if (Object.keys(offenders).length > 0) throw new UnbalancedTransactionError(offenders);
}

/**
 * Derived from `ACCOUNT_KIND_CLASS` in types.ts — the one place a kind is
 * classified. Typed `ReadonlySet<AccountKind>` rather than `ReadonlySet<string>`
 * so a kind that does not exist cannot be spelled here either.
 */
export const LOCK_KINDS: ReadonlySet<AccountKind> = new Set(LOCK_KIND_LIST);

/**
 * INVARIANT 2 — locked funds are always funded from the owner's own available
 * balance, in the same transaction.
 *
 * hold / escrow / stake / collateral may only *increase* by what the same
 * owner's `available` account for that asset gives up. This is what makes
 * "locked" funds provably still the user's, and what stops a module inventing
 * collateral out of another account.
 *
 * Releasing a lock is unconstrained here — sum-to-zero already governs where
 * released value lands (back to available, to a counterparty, to house fees).
 */
export function assertPairedLocks(entries: readonly EntryInput[]): void {
  // Per (owner, asset): how much locked value was created, and how much
  // available balance the same owner gave up in this transaction.
  const lockGain = new Map<string, Amount>();
  const availableGiven = new Map<string, Amount>();

  for (const e of entries) {
    const key = `${e.account.ownerType}:${e.account.ownerId}:${e.account.assetId}`;
    const delta = signedDelta(e);

    if (LOCK_KINDS.has(e.account.kind)) {
      if (delta > 0n) lockGain.set(key, (lockGain.get(key) ?? 0n) + delta);
    } else if (e.account.kind === 'available') {
      if (delta < 0n) availableGiven.set(key, (availableGiven.get(key) ?? 0n) - delta);
    } else {
      throw new InvalidEntryError(
        `Unknown account kind "${e.account.kind}" on ${accountKey(e.account)} — a kind outside the lock list is not available ` +
          `and cannot fund a hold, escrow, stake, or collateral (§4.2)`,
      );
    }
  }

  for (const [key, gained] of lockGain) {
    const given = availableGiven.get(key) ?? 0n;
    if (given < gained) {
      throw new InvalidEntryError(
        `Unfunded lock for ${key}: ${formatAmount(gained)} moved into a locked account but only ` +
          `${formatAmount(given)} left the same owner's available balance — locks must be paired with an ` +
          `available counter-entry (§4.2)`,
      );
    }
  }
}

/**
 * Every `hold` entry names what it is holding for (P0-3).
 *
 * This is the invariant that stops the commingled bucket coming back. Before
 * it, `userHold(user, asset)` was one pot for order reservations and withdrawal
 * holds alike, so `withdrawSettle` could draw down value an open order was
 * relying on: both postings balance, the journal reconciles, and the order is
 * quietly unfunded. Nothing in the books could tell you it had happened,
 * because nothing in the books had recorded which hold was whose.
 *
 * Checked here rather than in each recipe so it also binds anything that
 * assembles entries directly — the recipes are the sanctioned path, not the
 * only physically possible one.
 *
 * Purpose is required on every *lock pot* that is not fungible with itself:
 * `hold` (P0-3), `escrow` (L3-4), `stake` (L1 / L3-5) and `collateral` (§8.1).
 * `available` stays unpurposed — it is fungible with itself.
 *
 * `collateral` was the last kind left open, on the stated grounds that no
 * futures claim key had been designed yet. §8.1's loans supplied one: a
 * collateral pot secures ONE loan, and its purpose is `loan:<id>`. Leaving it
 * open meant a borrower's second loan in the same asset shared the first's
 * collateral, so releasing one could unsecure the other with every posting
 * balancing — the `hold` bug again, on the one lock kind whose entire job is to
 * still be there when the position goes wrong. Futures positions take
 * `position:<id>` when they arrive; the shape is already right for them.
 */
export function assertPurposedHolds(entries: readonly EntryInput[]): void {
  assertPurposedLockKinds(entries, ['hold'], 'hold', 'P0-3, §4.2');
}

/** Every lock kind names its claim. `available` is the only unpurposed pot left. */
export function assertPurposedLocks(entries: readonly EntryInput[]): void {
  assertPurposedLockKinds(entries, LOCK_KIND_LIST, 'lock pot', 'P0-3 / L3-4 / L1-L3-5 / §8.1');
}

function assertPurposedLockKinds(entries: readonly EntryInput[], kinds: readonly string[], label: string, doctrine: string): void {
  for (const entry of entries) {
    if (!kinds.includes(entry.account.kind)) continue;
    // Trim: spaces-only is the same failure class as empty — two holds with
    // purpose "   " share one identity key and re-commingle (P0-3).
    const purpose = (entry.account.purpose ?? '').trim();
    if (purpose.length === 0) {
      throw new InvalidEntryError(
        `${label} account for ${entry.account.ownerType}:${entry.account.ownerId} in ${entry.account.assetId} has no purpose — ` +
          `a ${entry.account.kind} must name its claim (e.g. "order:<id>", "trade:<id>", "token:stake:<id>") so one claim cannot spend ` +
          `another's reservation (${doctrine})`,
      );
    }
    // Migration 0008 refuses `legacy:%` at the database. Refuse here too so a
    // MemoryLedger / pure-guard path cannot mint a stamp the DB would reject —
    // and so an adapter never learns the hard way that "legacy:uuid" is not a
    // claim name (0007's temporary backfill prefix, never a product purpose).
    if (purpose.startsWith('legacy:')) {
      throw new InvalidEntryError(
        `${label} account for ${entry.account.ownerType}:${entry.account.ownerId} in ${entry.account.assetId} ` +
          `uses forbidden purpose "${purpose}" — the legacy: prefix was a one-time migration stamp, not a claim ` +
          `(migration 0008 / ${doctrine})`,
      );
    }
  }
}

/**
 * `available` is fungible with itself — a purpose on it opens a second pot
 * beside the real available balance (same owner+asset, different purpose key).
 * Sum-to-zero and recon still green; the user simply has two balances and can
 * only see one. Lock pots carry purpose; available must not.
 */
export function assertAvailableUnpurposed(entries: readonly EntryInput[]): void {
  for (const entry of entries) {
    if (entry.account.kind !== 'available') continue;
    const purpose = entry.account.purpose;
    if (purpose != null && purpose.trim().length > 0) {
      throw new InvalidEntryError(
        `available account for ${entry.account.ownerType}:${entry.account.ownerId} in ${entry.account.assetId} ` +
          `must not carry purpose "${purpose}" — available is fungible; only lock pots name a claim (P0-3 / §4.2)`,
      );
    }
  }
}

/**
 * INVARIANT 4 — every `ownerId` is drawn from the space its `ownerType` declares.
 *
 * `post()` is the only path that opens an account: `upsertAccount` runs inside
 * it, and nothing else in the OS inserts into `ledger.accounts`. So refusing
 * here refuses the *creation*, not merely the movement — an owner whose
 * identifier space is undeclared never gets a row at all.
 *
 * The bug this exists to stop is silent by construction. Per the 2026-08-02
 * ADR, the vendored product's money controllers keep their business logic and
 * have only their balance writes redirected into this ledger through an
 * adapter. Their member ids are `bigint`; ours are `uuid`; `owner_id` is `text`
 * and took either. Hand `String(member.id)` to `userAvailable()` and the post
 * succeeds: a second `user` account opens for a human who already has one, and
 * because both rows are individually well-formed, sum-to-zero holds, the hash
 * chain verifies, reconciliation replays clean and every gate goes green. There
 * is no reading of the book from which you could tell. The user simply has two
 * balances and can only see one.
 *
 * Checked here rather than in `accounts.ts` for the same reason
 * `assertPurposedHolds` is: the named constructors are the sanctioned path, not
 * the only physically possible one, and an adapter assembling an `AccountRef`
 * inline must be bound by the same rule.
 */
export function assertOwnerIdentifierSpace(entries: readonly EntryInput[]): void {
  for (const entry of entries) {
    const { ownerType, ownerId } = entry.account;
    if (!isValidOwnerId(ownerType, ownerId)) throw new OwnerIdentitySpaceError(ownerType, ownerId);
  }
}

/**
 * The idempotency key alone, checked before anything looks a request up by it.
 *
 * Split out from `assertValidPost` because the two engines have to agree on ONE
 * order, and the only order that is defensible has this check first
 * (STOP §4.2b #4):
 *
 *   1. the key is a key — a lookup keyed on nothing is not a lookup
 *   2. idempotency — a key that already committed returns its transaction
 *   3. the body — validated only for a request that is actually going to post
 *
 * Step 2 must precede step 3, and the reason is written in `postgres-ledger.ts`
 * about the freeze check, where the same question was already settled: "a retry
 * of a transaction that ALREADY COMMITTED returns the original even while
 * frozen: the value moved, and telling a caller otherwise would have it retry a
 * movement that already happened."
 *
 * Validation is the same case. The first time a validation rule is tightened,
 * every uncommitted retry of an older body starts failing — and a caller told
 * "invalid" about money that has already moved will either retry forever or
 * compensate for a movement that was never lost. Returning the committed
 * transaction is the honest answer, and it is what the book actually contains.
 */
export function assertIdempotencyKey(idempotencyKey: string | undefined): void {
  if (!idempotencyKey || idempotencyKey.length < 8) {
    throw new InvalidEntryError('An idempotency key of at least 8 characters is required on every post');
  }
}

/** The refusal for a reused idempotency key whose body differs from what that key booked. */
export const IDEMPOTENCY_CONFLICT_CODE = 'ledger.idempotency_conflict' as const;

/**
 * What a ledger does when a key that already booked a movement is posted again with a DIFFERENT body.
 *
 *   `refuse` — throw `ledger.idempotency_conflict` (409). The caller cannot record success for money that never moved.
 *   `detect` — answer with the original transaction, as before, and report the mismatch (log line
 *              `ledger.idempotency_mismatch`). It is the rollout mode: several jobs rebuild their body from live state when
 *              re-run under the same key (liquidation rungs, funding legs, chargeback splits, daily interest), and refusing
 *              them before they are fixed would wedge crash recovery instead of healing it.
 */
export type IdempotencyConflictMode = 'refuse' | 'detect';

export interface IdempotencyMismatchInfo {
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
}

export interface IdempotencyConflictOptions {
  /** Default `refuse`. */
  readonly idempotencyConflict?: IdempotencyConflictMode;
  /** Called in `detect` mode for every mismatch. Must not throw. */
  readonly onIdempotencyMismatch?: (info: IdempotencyMismatchInfo) => void;
}

/**
 * What a post MOVES, as one digest: module, reason, and each entry's account, direction and amount (entries sorted, so
 * order does not matter). Meta and correlation id are deliberately out: they describe a post, they do not move money, and a
 * retry may legitimately carry a fresh trace id.
 *
 * It exists so a reused key can be told apart from a retry. Before it, "same key" meant "same post": a different body under
 * a booked key silently returned the OLD transaction while the caller recorded success for money that never moved (#4414
 * was exactly that). Never throws; a body that cannot be read (a JS number amount, a missing account) gets a digest nothing
 * else matches, so the caller is refused rather than told the old booking is its own.
 *
 * THE ENCODING IS PERMANENT. Stored digests outlive any code change, so this does not call `accountKey`/`accountPurpose`
 * (someone may edit those for their own reasons) and every field is JSON-encoded, never delimiter-joined. A test pins a
 * known digest; if it fails, you changed the encoding: version it (`ledger-post-body-v2`) and keep reading v1.
 */
export function postFingerprint(request: Pick<PostRequest, 'module' | 'reason' | 'entries'>): string {
  let canonical: string;
  try {
    const entries = request.entries
      .map((e) =>
        JSON.stringify([
          e.account.ownerType,
          e.account.ownerId,
          e.account.assetId,
          e.account.kind,
          (e.account.purpose ?? '').trim(),
          e.direction,
          typeof e.amount === 'bigint' ? e.amount.toString() : `!${String(e.amount)}`,
        ]),
      )
      .sort();
    canonical = JSON.stringify([request.module, request.reason, entries]);
  } catch {
    canonical = `unreadable:${Math.random()}`;
  }
  return createHash('sha256').update('ledger-post-body-v1\0').update(canonical).digest('hex');
}

/** Withdrawal posts whose meta binds a later step: the hold's `fee` and `rail` decide what its settle and reverse may be. */
const WITHDRAW_META_BOUND = new Set(['withdraw.held', 'withdraw.settled', 'withdraw.reversed']);

/**
 * True when a retry of a withdrawal post (same key, same entries) names another `fee` or `rail` in its meta than the posted
 * one. The body fingerprint covers entries, not meta, so without this a hold first posted with no fee and retried as amount
 * plus fee (the same total) would replay as a success while the book keeps no fee, and svc-ledger's door would later refuse
 * the settle after the rail had sent. Both engines check it inside their own replay, so concurrent retries are covered too.
 */
export function replayMetaDiffers(posted: Record<string, unknown>, request: Pick<PostRequest, 'module' | 'reason' | 'meta'>): boolean {
  if (request.module !== 'ledger' || !WITHDRAW_META_BOUND.has(request.reason)) return false;
  const asked = request.meta ?? {};
  return ['fee', 'rail'].some((field) => String(posted[field] ?? '') !== String(asked[field] ?? ''));
}

export function assertValidPost(request: PostRequest): void {
  assertIdempotencyKey(request.idempotencyKey);
  // FIRST. If the owner is the wrong one, everything below is a well-formed
  // answer to the wrong question — the entries balance perfectly, into the
  // wrong human's account.
  assertOwnerIdentifierSpace(request.entries);
  assertBalanced(request.entries);
  assertPairedLocks(request.entries);
  assertPurposedLocks(request.entries);
  assertAvailableUnpurposed(request.entries);
}

/** Total absolute value moved, per asset — used for metrics and fee reporting. */
export function volumeByAsset(entries: readonly EntryInput[]): Record<string, string> {
  const out: Record<string, Amount> = {};
  for (const e of entries) {
    if (e.direction !== 'debit') continue;
    out[e.account.assetId] = (out[e.account.assetId] ?? 0n) + e.amount;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, formatAmount(v)]));
}

export function totalDebits(entries: readonly EntryInput[]): Amount {
  return sum(entries.filter((e) => e.direction === 'debit').map((e) => e.amount));
}
