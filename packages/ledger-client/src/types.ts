import { z } from 'zod';
import type { Amount, AmountString } from './money.js';

/**
 * The shapes of the balance graph (§4.2).
 *
 * `owner_type` + `owner_id` + `asset_id` + `kind` is unique — one account per
 * purpose, per asset, per owner. Balances only ever change through `post()`.
 */

export const OWNER_TYPES = ['user', 'subaccount', 'module', 'house', 'treasury'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/**
 * THE IDENTIFIER SPACE OF `ownerId` (§4.2).
 *
 * `owner_type` has always said what *role* an owner plays. It has never said
 * which *identifier space* `owner_id` is drawn from, and `owner_id` is `text`,
 * so it accepted anything.
 *
 * That mattered the moment the 2026-08-02 ADR accepted keeping the vendored
 * product's money controllers and redirecting their balance writes into this
 * ledger through an adapter. `identity.users.id` is a `uuid`; the vendored
 * `member.id` is a `bigint`. An adapter that hands over the wrong one does not
 * fail — it opens a SECOND perfectly conformant account for the same human.
 * Both accounts sum to zero, both hash-chain, both reconcile, both are
 * non-negative. Every gate reports clean and the book is quietly dual. That is
 * the exact failure the ADR was written to close, walking back in through the
 * adapter.
 *
 * So the ledger declares the space rather than inferring it from the caller:
 *
 *   user, subaccount            → a lowercase canonical UUID
 *   module, house, treasury     → a platform slug, e.g. `fees:trade`
 *
 * Deliberately NOT a separate `owner_ns` column. A namespace column is supplied
 * by the same caller that supplies the id, so an adapter passing a bigint would
 * pass `ns='member'` alongside it and the pair would be accepted. It relocates
 * the hole. The space has to be a function of something the ledger already
 * knows, and `owner_type` is that thing.
 *
 * Mirrored EXACTLY by `accounts_owner_id_space_ck`
 * (svc-ledger/drizzle/0005_owner_identifier_space.sql). The database is the
 * enforcement; this is the early, legible failure. Equivalence between the two
 * is asserted case-for-case in svc-ledger/src/ledger/owner-identity.pg.test.ts.
 */
export type OwnerIdSpace = 'uuid' | 'platform';

/** Owner types whose `ownerId` is a natural person's (or sub-identity's) UUID. */
export const UUID_OWNER_TYPES: readonly OwnerType[] = ['user', 'subaccount'];

/**
 * Lowercase only, on purpose.
 *
 * `550E8400-…` and `550e8400-…` are the same human and two different rows under
 * `accounts_identity_purpose_idx` — the same dual-book failure in different
 * clothing. Postgres renders `uuid` lowercase, `crypto.randomUUID()` emits
 * lowercase and Java's `UUID.toString()` emits lowercase, so the canonical form
 * is the only form anything legitimately produces. Version and variant nibbles
 * are not pinned: rows predating this constraint are not all v4, and refusing
 * them would strand real balances for no safety gain.
 */
export const UUID_OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A platform account's namespaced slug: `fees:trade`, `rail:card-sandbox`,
 * `bank:earn:<poolId>`, `pay:clearing:<merchantId>`, `insurance-fund`, `mint`.
 *
 * It must START with a lowercase letter, which is what makes a bare `1042` —
 * a vendored `member.id` — impossible here too. Later segments stay permissive
 * because they legitimately carry UUIDs and venue codes
 * (`pay:clearing:550e8400-…`, `venue:BINANCE`).
 */
export const PLATFORM_OWNER_ID_PATTERN = /^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$/;

/** Which identifier space this owner type's `ownerId` must be drawn from. */
export function ownerIdSpace(ownerType: OwnerType): OwnerIdSpace {
  return UUID_OWNER_TYPES.includes(ownerType) ? 'uuid' : 'platform';
}

/**
 * Does `ownerId` belong to the space `ownerType` declares?
 *
 * The `platform` branch also refuses a bare UUID. A UUID matches the slug
 * grammar whenever it happens to start with a hex letter (`a50e8400-…`), so
 * without this a user id could still land in a `house` or `treasury` account —
 * the same confusion running the other way.
 */
export function isValidOwnerId(ownerType: OwnerType, ownerId: string): boolean {
  if (ownerIdSpace(ownerType) === 'uuid') return UUID_OWNER_ID_PATTERN.test(ownerId);
  return PLATFORM_OWNER_ID_PATTERN.test(ownerId) && !UUID_OWNER_ID_PATTERN.test(ownerId);
}

/** Human-readable description of a space, for error messages. */
export function describeOwnerIdSpace(ownerType: OwnerType): string {
  return ownerIdSpace(ownerType) === 'uuid'
    ? 'a lowercase canonical UUID (identity.users.id / identity.sub_accounts.id)'
    : 'a namespaced platform slug starting with a lowercase letter, e.g. "fees:trade" or "rail:card-sandbox"';
}

export const ACCOUNT_KINDS = ['available', 'hold', 'escrow', 'stake', 'collateral'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * Is this pot spendable value, or value already claimed by something?
 *
 * INVARIANT 2 — "locked funds are always funded from the owner's own available
 * balance" — is what makes locked value provably still the user's. It was
 * enforced against a hand-written list of lock kinds, kept in two places, with
 * this enum as a silent third. Nothing checked that the three agreed and
 * nothing could: the list was typed `ReadonlySet<string>`, so adding a kind
 * here produced no type error, no test failure and no gate failure.
 *
 * A kind missing from the list is not treated as unclassified — it falls into
 * the `else if (delta < 0n)` branch of `assertPairedLocks` and is read as
 * *available* balance. So the drift does not fail loudly: it creates locked
 * value funded by nobody, while the post still sums to zero per asset, the
 * hash chain still verifies and reconciliation still replays clean. There is no
 * reading of the book from which you could tell.
 *
 * Demonstrated against the real `assertValidPost` on 2026-08-07:
 *
 *     kind 'collateral'  (classified)    refused   "Unfunded lock for user:…"
 *     kind 'margin'      (unclassified)  ACCEPTED  1,000,000 USDT out of thin air
 *
 * This record is the single source. It is `satisfies Record<AccountKind, …>`,
 * so adding a kind to ACCOUNT_KINDS without classifying it **fails to compile**
 * — the decision is forced at the one moment somebody is thinking about it.
 * That matters now rather than later: `client.ts` already anticipates the next
 * lock kind ("Futures positions take `position:<id>` when they arrive"), so the
 * trigger is on the roadmap.
 */
export const ACCOUNT_KIND_CLASS = {
  available: 'spendable',
  hold: 'locked',
  escrow: 'locked',
  stake: 'locked',
  collateral: 'locked',
} as const satisfies Record<AccountKind, 'spendable' | 'locked'>;

/**
 * The lock kinds, derived — never written out a second time.
 *
 * Ordered by ACCOUNT_KINDS so the sequence is the enum's, not this record's.
 */
export const LOCK_KIND_LIST: readonly AccountKind[] = ACCOUNT_KINDS.filter((kind) => ACCOUNT_KIND_CLASS[kind] === 'locked');

/**
 * Must match `ledger.asset_kind` exactly (svc-ledger/drizzle/0003).
 *
 * `commodity` covers the metals and energies the instrument catalogue lists —
 * XAU, XAG, WTI, BRENT, NATGAS. It is a distinct kind rather than a reuse of
 * `fiat` because gold is not a currency: nothing issues it, no jurisdiction
 * redenominates it, and the two behave differently everywhere that branches on
 * an asset's kind.
 */
export const ASSET_KINDS = ['crypto', 'fiat', 'native', 'commodity'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export type Direction = 'debit' | 'credit';

export interface AccountRef {
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly assetId: string;
  readonly kind: AccountKind;
  /**
   * Sub-identity within (owner, asset, kind) — P0-3.
   *
   * A `hold` is not fungible with another `hold`. Value reserved for order
   * `abc` and value held for withdrawal `xyz` are both "held for this user in
   * this asset", and before this field they were the same account: a withdrawal
   * could settle out of an open order's reservation and the books would balance
   * perfectly while the order became unfunded.
   *
   * `order:<id>` / `withdraw:<id>` and so on. Empty for accounts where the
   * question does not arise — an `available` balance is fungible with itself by
   * definition, and giving it a purpose would fragment it for no reason.
   *
   * `hold` accounts MUST carry one; `assertPurposedHolds` refuses the post
   * otherwise, so the commingled bucket cannot come back by omission.
   */
  readonly purpose?: string;
}

/**
 * The empty-string normal form. Absent, `''`, and whitespace-only are the same
 * account. Trim is load-bearing: constructors trim before stamping a purpose,
 * but an adapter assembling an `AccountRef` inline can still pass `"order:x "`,
 * `"order:x\t"`, or `"   "`. Without trim here, `accountKey` and the Postgres
 * upsert open a second pot beside the real one (P0-3 dual book, recon still green).
 *
 * DB belt: migration 0012 refuses the same dual-book pads on raw SQL
 * (space/tab/CR/LF/VT/FF/NBSP). JS `.trim()` may strip a broader Unicode set;
 * that is fine — client remains the stricter door on the TypeScript path.
 */
export function accountPurpose(ref: AccountRef): string {
  return (ref.purpose ?? '').trim();
}

export interface Account extends AccountRef {
  readonly id: string;
  readonly createdAt: Date;
}

export interface EntryInput {
  readonly account: AccountRef;
  readonly direction: Direction;
  readonly amount: Amount;
}

export interface PostedEntry {
  readonly id: string;
  readonly txId: string;
  readonly accountId: string;
  readonly assetId: string;
  readonly direction: Direction;
  readonly amount: Amount;
  readonly balanceAfter: Amount;
}

export interface PostRequest {
  /**
   * The dedupe key. Two posts with the same key are the same post; the second
   * returns the first one's result rather than doubling the money.
   */
  readonly idempotencyKey: string;
  /** Which module initiated this movement — for reconciliation and freezes. */
  readonly module: string;
  /** Machine-readable reason, e.g. 'trade.fill', 'p2p.escrow.lock'. */
  readonly reason: string;
  readonly entries: readonly EntryInput[];
  readonly meta?: Record<string, unknown>;
  /** Trace correlation (§9) — the request that caused the movement. */
  readonly correlationId?: string;
}

export interface LedgerTx {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
  readonly meta: Record<string, unknown>;
  readonly postedAt: Date;
  /** H(previousHash ‖ canonical(tx)) — tamper-evident book (§4.2). */
  readonly hash: string;
  readonly previousHash: string | null;
  readonly entries: readonly PostedEntry[];
  /** Per-asset links used by the ledger-sharding socket when enabled. */
  readonly assetHashes?: Readonly<Record<string, string>>;
  readonly previousAssetHashes?: Readonly<Record<string, string | null>>;
  /** Deterministic digest of the complete per-asset tip set after this tx. */
  readonly crossShardAnchor?: string;
}

export interface Balance {
  readonly account: AccountRef;
  readonly accountId: string;
  readonly amount: Amount;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** Σ debits ≠ Σ credits for some asset. The cardinal sin. */
export class UnbalancedTransactionError extends LedgerError {
  constructor(readonly perAsset: Record<string, AmountString>) {
    super(
      `Transaction does not sum to zero per asset: ${Object.entries(perAsset)
        .map(([asset, delta]) => `${asset} off by ${delta}`)
        .join(', ')}`,
      'ledger.unbalanced',
    );
    this.name = 'UnbalancedTransactionError';
  }
}

/** An `available` account would have gone below zero. */
export class InsufficientFundsError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly assetId: string,
    readonly requested: AmountString,
    readonly availableBalance: AmountString,
  ) {
    super(`Insufficient ${assetId}: requested ${requested}, available ${availableBalance}`, 'ledger.insufficient_funds');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidEntryError extends LedgerError {
  constructor(message: string) {
    super(message, 'ledger.invalid_entry');
    this.name = 'InvalidEntryError';
  }
}

/**
 * An `ownerId` was not drawn from the space its `ownerType` declares.
 *
 * Its own error code rather than a generic `invalid_entry`, because the caller
 * that trips it is almost always an adapter translating between two identifier
 * spaces, and "you passed the other system's id" is a completely different fix
 * from "your entries do not balance". `svc-ledger` maps it to a 400.
 */
export class OwnerIdentitySpaceError extends LedgerError {
  constructor(
    readonly ownerType: OwnerType,
    readonly ownerId: string,
  ) {
    super(
      `owner_type "${ownerType}" requires ${describeOwnerIdSpace(ownerType)}, but got "${ownerId}". ` +
        `An account is never opened for an owner whose identifier space is undeclared: a bigint member id ` +
        `where a user UUID belongs would open a SECOND conformant account for the same human, and every ` +
        `invariant would still report clean (§4.2, ADR 2026-08-02).`,
      'ledger.owner_identity_space',
    );
    this.name = 'OwnerIdentitySpaceError';
  }
}

// ── Wire schemas (used by svc-ledger's tRPC surface) ─────────────────────────

export const accountRefSchema = z
  .object({
    ownerType: z.enum(OWNER_TYPES),
    ownerId: z.string().min(1),
    assetId: z.string().min(1).max(16),
    kind: z.enum(ACCOUNT_KINDS),
    /** Bounded because it is part of an index key, not free-form metadata. */
    purpose: z.string().max(128).optional(),
  })
  /**
   * The identifier space, checked at the wire edge as well as in `post()` and in
   * Postgres. Three layers is not belt-and-braces theatre here: this one turns a
   * cross-system id mix-up into a 400 naming the field, instead of a 500 from a
   * CHECK violation that an adapter author has to reverse-engineer.
   */
  .superRefine((ref, ctx) => {
    if (isValidOwnerId(ref.ownerType, ref.ownerId)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ownerId'],
      message: `owner_type "${ref.ownerType}" requires ${describeOwnerIdSpace(ref.ownerType)} — got "${ref.ownerId}"`,
    });
  });

export const entryInputSchema = z.object({
  account: accountRefSchema,
  direction: z.enum(['debit', 'credit']),
  /**
   * Twenty digits is the whole-part width `numeric(38,18)` already stores.
   * Applied here as a string length, so a longer digit run — a multi-megabyte
   * one included — is refused by this schema before `parseAmount` builds a bigint.
   */
  amount: z.string().regex(/^\d{1,20}(\.\d{1,18})?$/, 'entry amounts are unsigned decimal strings'),
});

export const postRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  module: z.string().min(1),
  reason: z.string().min(1),
  entries: z.array(entryInputSchema).min(2),
  meta: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
});
