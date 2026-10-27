import { randomUUID } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from './errors.js';

/**
 * User withdraw destination — the ref a later offramp must already have
 * BEFORE `withdrawHold`.
 *
 * Shape is IBAN / IFSC / EVM. This file does not invent a PSP and does not
 * live-wire a bank rail. Value still leaves through ledger-client recipes
 * after this ref is loaded.
 */

export const WITHDRAW_DESTINATION_KINDS = ['crypto', 'bank'] as const;
export type WithdrawDestinationKind = (typeof WITHDRAW_DESTINATION_KINDS)[number];

/**
 * The address-book vocabulary of ENGINE A-1. A saved address-book entry starts `pending` until the customer approves it
 * by an emailed link or from another signed-in device (W-withdraw-09), then `cooling`: its cooling-off runs from the
 * approval. Entries from before approvals existed, and the legacy slot, are `active`.
 */
export const DESTINATION_STATES = ['pending', 'cooling', 'active', 'blocked', 'archived'] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];

export type WithdrawDestination = {
  destinationId: string;
  kind: WithdrawDestinationKind;
  ref: string;
  label: string | null;
  /** Null on the legacy slot, which is not tied to an asset or network. */
  assetId: string | null;
  network: string | null;
  tag: string | null;
  /** `legacy` is the one-per-kind slot the offramp writes. `customer` is a saved address-book entry. */
  origin: 'legacy' | 'customer';
  state: DestinationState;
  addedAt: Date;
  updatedAt: Date;
  /**
   * Saved after the customer confirmed it is a different address from this saved entry it looks like (W-withdraw-03):
   * that entry's id, and when. Null for every other entry.
   */
  lookalikeOf: string | null;
  lookalikeConfirmedAt: Date | null;
  /** When and how the customer approved this new address (W-withdraw-09); null until then. */
  approvedAt: Date | null;
  approvedBy: DestinationApproval | null;
};

/** How a new address was approved: an emailed single-use link, or from another signed-in device. */
export type DestinationApproval = 'link' | 'device';

/**
 * The sign-in (`fam`, the access token's session family, the same across refreshes) and the trusted device (`dev`) an
 * entry was saved from, as the token named them. Null where the token named none: unknown, never a match.
 */
export type SavedOn = { fam: string | null; dev: string | null };

/** One saved address-book entry as the customer typed it. */
export type SaveDestinationInput = {
  userId: string;
  assetId: string;
  network: string;
  ref: string;
  tag?: string;
  label: string;
  /** The saved entry this address looks like, which the customer confirmed it is not. Recorded on the new entry. */
  lookalikeOf?: string;
  /** The sign-in and trusted device saving it (W-withdraw-09). Kept on a new entry only; omitted, both are unknown. */
  savedOn?: SavedOn;
};

export type UserWithdrawDestinations = {
  /** The legacy slot: one address per kind, overwritten by the next. Kept for the offramp and `setWithdrawDestination`. */
  persist(input: { userId: string; kind: string; ref: string; label?: string }): Promise<WithdrawDestination>;
  /** The address a withdrawal of this kind uses: the legacy slot only. A saved book entry is never picked for the customer. */
  require(input: { userId: string; kind: string }): Promise<WithdrawDestination>;
  list(userId: string): Promise<WithdrawDestination[]>;
  /** Save an address-book entry. The same (asset, network, address, tag) again returns the stored entry unchanged. */
  save(input: SaveDestinationInput): Promise<WithdrawDestination>;
  /** Rename. Never moves `updatedAt`: the cooling clock runs from the last change of the address itself. */
  rename(input: { userId: string; destinationId: string; label: string }): Promise<WithdrawDestination>;
  remove(input: { userId: string; destinationId: string; idempotencyKey: string }): Promise<{ destinationId: string; removed: true }>;
  /**
   * Approve a `pending` entry: it becomes `cooling` and its cooling-off starts now (`updatedAt`). An entry already approved
   * is returned unchanged, so a repeated approval changes nothing. A missing entry refuses `bank.withdraw_destination_missing`.
   */
  approve(input: { userId: string; destinationId: string; by: DestinationApproval }): Promise<WithdrawDestination>;
  /** The sign-in and device the entry was saved from, or null when the customer has no such entry. */
  savedOn(input: { userId: string; destinationId: string }): Promise<SavedOn | null>;
};

/** Owner-set number of entries one address book may hold. */
export const BANK_ADDRESS_BOOK_CAP_ENV = 'BANK_ADDRESS_BOOK_CAP';

/** Unset, blank, zero or not a whole number refuses `bank.address_book_cap_unset`. No default. */
export function requireAddressBookCap(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]{0,5}$/.test(trimmed)) {
    throw new BankError(
      `${BANK_ADDRESS_BOOK_CAP_ENV} is unset or not a positive whole number. Saving an address refuses rather than inventing a limit`,
      'bank.address_book_cap_unset',
    );
  }
  return Number.parseInt(trimmed, 10);
}

export type DestinationStoreOptions = {
  /** Reads the owner cap each time, so a change takes effect without a restart. */
  addressBookCap?: () => string | undefined;
  now?: () => Date;
};

/** Normalise and check one address-book entry. Crypto only: a bank account stays in the legacy slot. */
export function assertBookEntry(input: SaveDestinationInput): {
  assetId: string;
  network: string;
  ref: string;
  tag: string | null;
  label: string;
  lookalikeOf: string | null;
} {
  const assetId = input.assetId.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,16}$/.test(assetId)) {
    throw new BankError('Saved address needs an asset code of 1 to 16 letters or digits', 'bank.ramp_invalid_destination');
  }
  const network = input.network.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(network)) {
    throw new BankError(
      'Saved address needs a network name of 2 to 32 letters, digits, dashes or underscores',
      'bank.ramp_invalid_destination',
    );
  }
  const { ref } = assertPersistableWithdrawDestination({ kind: 'crypto', ref: input.ref });
  let tag: string | null = null;
  if (input.tag !== undefined) {
    if (input.tag.trim() !== input.tag || input.tag.length < 1 || input.tag.length > 64 || /[\u0000-\u001f]/.test(input.tag)) {
      throw new BankError('Memo or tag must be 1 to 64 characters with no surrounding whitespace', 'bank.ramp_invalid_destination');
    }
    tag = input.tag;
  }
  let lookalikeOf: string | null = null;
  if (input.lookalikeOf !== undefined) {
    if (!UUID_RE.test(input.lookalikeOf)) {
      throw new BankError('The look-alike confirmation must name a saved entry by its id', 'bank.ramp_invalid_destination');
    }
    lookalikeOf = input.lookalikeOf.toLowerCase();
  }
  return { assetId, network, ref, tag, label: assertDestinationLabel(input.label), lookalikeOf };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Any 8-4-4-4-12 hex id, as the access token's claims allow (`z.guid()`), so every id identity mints is kept. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The saving sign-in and device as stored: each a uuid or null. Anything else is a caller bug, refused, never stored. */
export function assertSavedOn(input: SavedOn | undefined): SavedOn {
  const one = (value: string | null | undefined): string | null => {
    if (value === undefined || value === null) return null;
    if (!GUID_RE.test(value)) throw new BankError('The saving sign-in or device is not a uuid', 'bank.ramp_invalid_destination');
    return value.toLowerCase();
  };
  return { fam: one(input?.fam), dev: one(input?.dev) };
}

/** A label the customer typed. Omit means "leave the stored label". */
export function assertDestinationLabel(label: string): string {
  if (label.trim() !== label || label.length < 1 || label.length > 64 || /[\u0000-\u001f]/.test(label)) {
    throw new BankError(
      'Withdraw destination label must be 1–64 characters with no surrounding whitespace or control characters',
      'bank.ramp_invalid_destination',
    );
  }
  return label;
}

type PersistableWithdrawDestination = { kind: WithdrawDestinationKind; ref: string };

/** EVM address: 0x + 40 hex digits. Checksum optional (structural only). */
export function isEvmAddressRef(ref: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(ref.trim());
}

/**
 * EIP-55: a mixed-case EVM address carries a checksum in its letter case, so a changed character shows. All lower or
 * all upper case carries none and passes. Only meaningful on an `isEvmAddressRef` shape.
 */
export function evmChecksumMatches(ref: string): boolean {
  const hex = ref.trim().slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = keccak_256(new TextEncoder().encode(hex.toLowerCase()));
  for (let i = 0; i < hex.length; i++) {
    const char = hex[i]!;
    if (char >= '0' && char <= '9') continue;
    // The i-th nibble of the hash: upper case when it is 8 or more.
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    if (nibble >= 8 !== (char >= 'A' && char <= 'F')) return false;
  }
  return true;
}

/**
 * Address poisoning sends a customer dust from an address made to start and end like one they use, so that the copy
 * from their history is the wrong one. Two addresses look the same here when they agree on what the address book shows
 * (`0x` and the first four characters, then the last four, ignoring case; the customer app's `shortenAddress` and the
 * bank's `maskRef` show the same) and differ anywhere else. Returns the first saved entry the address could be mistaken
 * for, or null. An address already in the book is not new, so it is never a look-alike: the customer saved it already
 * (after confirming, when it was one), and saving it again on another network or as the same entry asks nothing more.
 */
export function lookalikeOf<T extends { ref: string }>(ref: string, saved: readonly T[]): T | null {
  const address = ref.trim().toLowerCase();
  if (!isEvmAddressRef(address)) return null;
  if (saved.some((row) => row.ref.trim().toLowerCase() === address)) return null;
  const shown = (value: string) => `${value.slice(0, 6)}${value.slice(-4)}`;
  return (
    saved.find((row) => {
      const other = row.ref.trim().toLowerCase();
      return isEvmAddressRef(other) && other !== address && shown(other) === shown(address);
    }) ?? null
  );
}

/**
 * IBAN structural check: country + check digits + BBAN, length 15–34, mod-97 = 1.
 * Spaces ignored. Does not prove the account exists or is reachable.
 */
export function isIbanRef(ref: string): boolean {
  const compact = ref.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) {
    if (ch >= 'A' && ch <= 'Z') expanded += String(ch.charCodeAt(0) - 55);
    else expanded += ch;
  }
  let remainder = 0;
  for (const d of expanded) {
    remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * IFSC structural check (India): 4 letters + 0 + 6 alphanumeric = 11 chars.
 * Does not prove the bank branch exists or a partner rail is live.
 */
export function isIfscRef(ref: string): boolean {
  const compact = ref.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact);
}

export function isBankDestinationRef(ref: string): boolean {
  return isIbanRef(ref) || isIfscRef(ref);
}

export function destKindForRamp(rampKind: 'crypto' | 'fiat'): WithdrawDestinationKind {
  return rampKind === 'fiat' ? 'bank' : 'crypto';
}

function asKind(kind: string): WithdrawDestinationKind {
  const trimmed = kind.trim();
  if (trimmed === 'crypto' || trimmed === 'bank') return trimmed;
  throw new BankError(
    `Withdraw destination kind must be crypto (EVM) or bank (IBAN/IFSC), got '${trimmed}'`,
    'bank.ramp_invalid_destination',
  );
}

/** Assert kind+shape. Does not register or enable any rail. Clock is the store's. */
export function assertPersistableWithdrawDestination(destination: { kind: string; ref: string }): PersistableWithdrawDestination {
  const kind = asKind(destination.kind);
  const ref = destination.ref?.trim() ?? '';
  if (!ref) {
    throw new BankError('Withdraw destination requires a non-empty ref', 'bank.ramp_invalid_destination');
  }
  if (kind === 'crypto') {
    if (!isEvmAddressRef(ref)) {
      throw new BankError(
        `Crypto withdraw dest must be a 20-byte EVM address (0x + 40 hex), got '${ref.slice(0, 24)}${ref.length > 24 ? '…' : ''}'`,
        'bank.ramp_invalid_destination',
      );
    }
    if (!evmChecksumMatches(ref)) {
      throw new BankError(
        "This address's upper and lower case letters do not match its checksum, so a character may have been changed. Copy it again from where it came from",
        'bank.address_checksum_mismatch',
      );
    }
    return { kind, ref };
  }
  if (!isBankDestinationRef(ref)) {
    throw new BankError(
      'Bank withdraw dest must be a structural IBAN (mod-97) or IFSC (11-char India scheme).',
      'bank.ramp_invalid_destination',
    );
  }
  return { kind, ref };
}

const MISSING = (userId: string, what: string) =>
  new BankError(`User ${userId} has no persisted withdraw destination ${what}`, 'bank.withdraw_destination_missing');

const LABEL_TAKEN = () => new BankError('You already have a saved address with this name', 'bank.destination_label_taken');

const BOOK_FULL = (cap: number) =>
  new BankError(`Your address book is full at ${cap} addresses. Remove one to save a new one`, 'bank.address_book_full');

/**
 * Router-test default: assert on persist, never invent a stored ref.
 * A later withdraw without a dest refuses closed — no invented ref.
 */
export function assertOnlyWithdrawDestinations(): UserWithdrawDestinations {
  return {
    async persist(input) {
      const dest = assertPersistableWithdrawDestination(input);
      const label = input.label === undefined ? null : assertDestinationLabel(input.label);
      return {
        ...dest,
        destinationId: '00000000-0000-4000-8000-000000000000',
        label,
        assetId: null,
        network: null,
        tag: null,
        origin: 'legacy',
        state: 'active',
        addedAt: new Date(0),
        updatedAt: new Date(0),
        lookalikeOf: null,
        lookalikeConfirmedAt: null,
        approvedAt: null,
        approvedBy: null,
      };
    },
    async require(input) {
      throw MISSING(input.userId, `for kind ${input.kind}`);
    },
    async list() {
      return [];
    },
    async save(input) {
      assertBookEntry(input);
      throw new BankError('This test double stores no address book', 'bank.address_book_cap_unset');
    },
    async rename(input) {
      throw MISSING(input.userId, input.destinationId);
    },
    async remove(input) {
      throw MISSING(input.userId, input.destinationId);
    },
    async approve(input) {
      throw MISSING(input.userId, input.destinationId);
    },
    async savedOn() {
      return null;
    },
  };
}

/** In-memory store for tests. Same rules as the Postgres store, including the label and cap rules. */
export function memoryWithdrawDestinations(options: DestinationStoreOptions = {}): UserWithdrawDestinations {
  const rows = new Map<string, WithdrawDestination & { userId: string }>();
  const removals = new Map<string, string>();
  const savedFrom = new Map<string, SavedOn>();
  const clock = options.now ?? (() => new Date());
  const of = (userId: string) => [...rows.values()].filter((row) => row.userId === userId);
  const labelTaken = (userId: string, label: string, exceptId?: string) =>
    of(userId).some((row) => row.destinationId !== exceptId && row.label !== null && row.label.toLowerCase() === label.toLowerCase());
  const strip = ({ userId: _userId, ...row }: WithdrawDestination & { userId: string }): WithdrawDestination => row;
  return {
    async persist(input) {
      const dest = assertPersistableWithdrawDestination(input);
      const existing = of(input.userId).find((row) => row.origin === 'legacy' && row.kind === dest.kind);
      const label = input.label === undefined ? (existing?.label ?? null) : assertDestinationLabel(input.label);
      if (label !== null && labelTaken(input.userId, label, existing?.destinationId)) throw LABEL_TAKEN();
      const stored = {
        userId: input.userId,
        destinationId: existing?.destinationId ?? randomUUID(),
        ...dest,
        label,
        assetId: null,
        network: null,
        tag: null,
        origin: 'legacy' as const,
        state: 'active' as const,
        addedAt: existing?.addedAt ?? clock(),
        updatedAt: clock(),
        lookalikeOf: null,
        lookalikeConfirmedAt: null,
        approvedAt: null,
        approvedBy: null,
      };
      rows.set(stored.destinationId, stored);
      return strip(stored);
    },
    async require(input) {
      const kind = asKind(input.kind);
      const legacy = of(input.userId).find((row) => row.origin === 'legacy' && row.kind === kind);
      if (!legacy) throw MISSING(input.userId, `for kind ${kind}`);
      return strip(legacy);
    },
    async list(userId) {
      return of(userId)
        .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())
        .map(strip);
    },
    async save(input) {
      const entry = assertBookEntry(input);
      const savedOn = assertSavedOn(input.savedOn);
      const cap = requireAddressBookCap(options.addressBookCap?.());
      const saved = of(input.userId).filter((row) => row.origin === 'customer');
      const same = saved.find(
        (row) =>
          row.assetId === entry.assetId &&
          row.network === entry.network &&
          row.ref.toLowerCase() === entry.ref.toLowerCase() &&
          (row.tag ?? '') === (entry.tag ?? ''),
      );
      if (same) return strip(same);
      if (saved.length >= cap) throw BOOK_FULL(cap);
      if (labelTaken(input.userId, entry.label)) throw LABEL_TAKEN();
      // One reading of the clock for the whole row, as the Postgres store's single now().
      const now = clock();
      const stored = {
        userId: input.userId,
        destinationId: randomUUID(),
        kind: 'crypto' as const,
        ref: entry.ref,
        label: entry.label,
        assetId: entry.assetId,
        network: entry.network,
        tag: entry.tag,
        origin: 'customer' as const,
        state: 'pending' as DestinationState,
        addedAt: now,
        updatedAt: now,
        lookalikeOf: entry.lookalikeOf,
        lookalikeConfirmedAt: entry.lookalikeOf ? now : null,
        approvedAt: null as Date | null,
        approvedBy: null as DestinationApproval | null,
      };
      rows.set(stored.destinationId, stored);
      savedFrom.set(stored.destinationId, savedOn);
      return strip(stored);
    },
    async rename(input) {
      const label = assertDestinationLabel(input.label);
      const row = rows.get(input.destinationId);
      if (!row || row.userId !== input.userId) throw MISSING(input.userId, input.destinationId);
      if (labelTaken(input.userId, label, row.destinationId)) throw LABEL_TAKEN();
      const renamed = { ...row, label };
      rows.set(row.destinationId, renamed);
      return strip(renamed);
    },
    async remove(input) {
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new BankError('Destination removal needs an idempotency key', 'bank.ramp_invalid_destination');
      }
      const removalKey = `${input.userId}:${idempotencyKey}`;
      const prior = removals.get(removalKey);
      if (prior) {
        if (prior !== input.destinationId) {
          throw new BankError('Idempotency key was already used for a different destination', 'bank.ramp_conflict');
        }
        return { destinationId: input.destinationId, removed: true as const };
      }
      const row = rows.get(input.destinationId);
      if (!row || row.userId !== input.userId) throw MISSING(input.userId, input.destinationId);
      rows.delete(input.destinationId);
      savedFrom.delete(input.destinationId);
      removals.set(removalKey, input.destinationId);
      return { destinationId: input.destinationId, removed: true as const };
    },
    async approve(input) {
      const row = rows.get(input.destinationId);
      if (!row || row.userId !== input.userId) throw MISSING(input.userId, input.destinationId);
      if (row.state !== 'pending') return strip(row);
      const now = clock();
      const approved = { ...row, state: 'cooling' as const, updatedAt: now, approvedAt: now, approvedBy: input.by };
      rows.set(row.destinationId, approved);
      return strip(approved);
    },
    async savedOn(input) {
      const row = rows.get(input.destinationId);
      if (!row || row.userId !== input.userId) return null;
      return savedFrom.get(row.destinationId) ?? { fam: null, dev: null };
    },
  };
}

const COLUMNS = `destination_id, kind, ref, label, asset_id, network, tag, origin, state, created_at, updated_at, lookalike_of, lookalike_confirmed_at, approved_at, approved_by`;

function isUniqueViolation(err: unknown, constraintSuffix: string): boolean {
  const e = err as { code?: string; constraint_name?: string } | null;
  return e?.code === '23505' && (e.constraint_name ?? '').endsWith(constraintSuffix);
}

export class UserWithdrawDestinationStore implements UserWithdrawDestinations {
  constructor(
    private readonly sql: Sql,
    private readonly options: DestinationStoreOptions = {},
  ) {}

  async persist(input: { userId: string; kind: string; ref: string; label?: string }): Promise<WithdrawDestination> {
    const dest = assertPersistableWithdrawDestination(input);
    const label = input.label === undefined ? null : assertDestinationLabel(input.label);
    const keepLabel = input.label === undefined;
    try {
      const rows = await this.sql<DestinationRow[]>`
        INSERT INTO bank.user_withdraw_destinations (user_id, kind, ref, label, origin)
        VALUES (${input.userId}, ${dest.kind}, ${dest.ref}, ${label}, 'legacy')
        ON CONFLICT (user_id, kind) WHERE origin = 'legacy'
        DO UPDATE SET
          ref = excluded.ref,
          label = CASE WHEN ${keepLabel} THEN bank.user_withdraw_destinations.label ELSE excluded.label END,
          updated_at = now()
        RETURNING ${this.sql.unsafe(COLUMNS)}
      `;
      return toDestination(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'label_idx')) throw LABEL_TAKEN();
      throw err;
    }
  }

  /**
   * Legacy slot only, exactly as before the address book. A saved entry needs its own asset, network and memo to be
   * paid correctly, and the offramp names none of them, so it is never chosen for the customer here.
   */
  async require(input: { userId: string; kind: string }): Promise<WithdrawDestination> {
    const kind = asKind(input.kind);
    const rows = await this.sql<DestinationRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
        FROM bank.user_withdraw_destinations
       WHERE user_id = ${input.userId} AND kind = ${kind} AND origin = 'legacy'
    `;
    if (!rows[0]) throw MISSING(input.userId, `for kind ${kind}`);
    return toDestination(rows[0]);
  }

  async list(userId: string): Promise<WithdrawDestination[]> {
    const rows = await this.sql<DestinationRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
        FROM bank.user_withdraw_destinations
       WHERE user_id = ${userId}
       ORDER BY created_at ASC, destination_id ASC
    `;
    return rows.map(toDestination);
  }

  async save(input: SaveDestinationInput): Promise<WithdrawDestination> {
    const entry = assertBookEntry(input);
    const savedOn = assertSavedOn(input.savedOn);
    const cap = requireAddressBookCap(this.options.addressBookCap?.());
    try {
      return await transaction(this.sql, async (tx) => {
        // Serialising saves per customer; the transaction is SERIALIZABLE and retried, which is what holds the cap when
        // two saves race. The unique label index backs the label rule.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`withdraw-address-book:${input.userId}`}))`;
        const same = await tx<DestinationRow[]>`
          SELECT ${tx.unsafe(COLUMNS)}
            FROM bank.user_withdraw_destinations
           WHERE user_id = ${input.userId} AND origin = 'customer' AND kind = 'crypto'
             AND asset_id = ${entry.assetId} AND network = ${entry.network}
             AND lower(ref) = lower(${entry.ref}) AND coalesce(tag, '') = ${entry.tag ?? ''}
        `;
        if (same[0]) return toDestination(same[0]);
        const count = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM bank.user_withdraw_destinations WHERE user_id = ${input.userId} AND origin = 'customer'
        `;
        if ((count[0]?.n ?? 0) >= cap) throw BOOK_FULL(cap);
        const rows = await tx<DestinationRow[]>`
          INSERT INTO bank.user_withdraw_destinations
            (user_id, kind, ref, label, asset_id, network, tag, origin, state, lookalike_of, lookalike_confirmed_at,
             saved_fam, saved_dev)
          VALUES (${input.userId}, 'crypto', ${entry.ref}, ${entry.label}, ${entry.assetId}, ${entry.network}, ${entry.tag}, 'customer',
                  'pending',
                  ${entry.lookalikeOf}::uuid, CASE WHEN ${entry.lookalikeOf}::uuid IS NULL THEN NULL ELSE now() END,
                  ${savedOn.fam}::uuid, ${savedOn.dev}::uuid)
          RETURNING ${tx.unsafe(COLUMNS)}
        `;
        return toDestination(rows[0]!);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'label_idx')) throw LABEL_TAKEN();
      throw err;
    }
  }

  async rename(input: { userId: string; destinationId: string; label: string }): Promise<WithdrawDestination> {
    const label = assertDestinationLabel(input.label);
    if (!UUID_RE.test(input.destinationId.trim())) {
      throw new BankError('destinationId must be a uuid', 'bank.ramp_invalid_destination');
    }
    try {
      // `updated_at` is left alone on purpose: it starts the cooling window, and a label does not change where money goes.
      const rows = await this.sql<DestinationRow[]>`
        UPDATE bank.user_withdraw_destinations SET label = ${label}
         WHERE user_id = ${input.userId} AND destination_id = ${input.destinationId.trim()}::uuid
        RETURNING ${this.sql.unsafe(COLUMNS)}
      `;
      if (!rows[0]) throw MISSING(input.userId, input.destinationId);
      return toDestination(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err, 'label_idx')) throw LABEL_TAKEN();
      throw err;
    }
  }

  async remove(input: {
    userId: string;
    destinationId: string;
    idempotencyKey: string;
  }): Promise<{ destinationId: string; removed: true }> {
    const destinationId = input.destinationId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(destinationId)) {
      throw new BankError('destinationId must be a uuid', 'bank.ramp_invalid_destination');
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new BankError('Destination removal needs an idempotency key', 'bank.ramp_invalid_destination');
    }
    return transaction(this.sql, async (tx) => {
      const prior = await tx<Array<{ destination_id: string }>>`
        SELECT destination_id FROM bank.withdraw_destination_removals
         WHERE user_id = ${input.userId} AND idempotency_key = ${idempotencyKey}
         FOR UPDATE
      `;
      if (prior[0]) {
        if (prior[0].destination_id !== destinationId) {
          throw new BankError('Idempotency key was already used for a different destination', 'bank.ramp_conflict');
        }
        return { destinationId, removed: true as const };
      }
      const deleted = await tx<Array<{ destination_id: string }>>`
        DELETE FROM bank.user_withdraw_destinations
         WHERE user_id = ${input.userId} AND destination_id = ${destinationId}::uuid
         RETURNING destination_id
      `;
      if (!deleted[0]) {
        throw new BankError(
          `User ${input.userId} has no persisted withdraw destination ${destinationId}`,
          'bank.withdraw_destination_missing',
        );
      }
      await tx`
        INSERT INTO bank.withdraw_destination_removals (user_id, idempotency_key, destination_id)
        VALUES (${input.userId}, ${idempotencyKey}, ${destinationId}::uuid)
      `;
      return { destinationId, removed: true as const };
    });
  }

  async approve(input: { userId: string; destinationId: string; by: DestinationApproval }): Promise<WithdrawDestination> {
    const destinationId = input.destinationId.trim();
    if (!UUID_RE.test(destinationId)) {
      throw new BankError('destinationId must be a uuid', 'bank.ramp_invalid_destination');
    }
    // Only a pending entry moves, once: the cooling-off starts at the approval, so `updated_at` is the approval time.
    const rows = await this.sql<DestinationRow[]>`
      UPDATE bank.user_withdraw_destinations
         SET state = 'cooling', approved_at = now(), approved_by = ${input.by}, updated_at = now()
       WHERE user_id = ${input.userId} AND destination_id = ${destinationId}::uuid AND state = 'pending'
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (rows[0]) return toDestination(rows[0]);
    const current = await this.sql<DestinationRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.user_withdraw_destinations
       WHERE user_id = ${input.userId} AND destination_id = ${destinationId}::uuid
    `;
    if (!current[0]) throw MISSING(input.userId, destinationId);
    return toDestination(current[0]);
  }

  async savedOn(input: { userId: string; destinationId: string }): Promise<SavedOn | null> {
    const destinationId = input.destinationId.trim();
    if (!UUID_RE.test(destinationId)) return null;
    const rows = await this.sql<Array<{ saved_fam: string | null; saved_dev: string | null }>>`
      SELECT saved_fam, saved_dev FROM bank.user_withdraw_destinations
       WHERE user_id = ${input.userId} AND destination_id = ${destinationId}::uuid
    `;
    return rows[0] ? { fam: rows[0].saved_fam, dev: rows[0].saved_dev } : null;
  }
}

interface DestinationRow {
  destination_id: string;
  kind: string;
  ref: string;
  label: string | null;
  asset_id: string | null;
  network: string | null;
  tag: string | null;
  origin: string;
  state: string;
  created_at: Date;
  updated_at: Date;
  lookalike_of: string | null;
  lookalike_confirmed_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
}

function toDestination(row: DestinationRow): WithdrawDestination {
  return {
    destinationId: row.destination_id,
    kind: asKind(row.kind),
    ref: row.ref,
    label: row.label,
    assetId: row.asset_id,
    network: row.network,
    tag: row.tag,
    origin: row.origin === 'customer' ? 'customer' : 'legacy',
    state: (DESTINATION_STATES as readonly string[]).includes(row.state) ? (row.state as DestinationState) : 'blocked',
    addedAt: row.created_at,
    updatedAt: row.updated_at,
    lookalikeOf: row.lookalike_of,
    lookalikeConfirmedAt: row.lookalike_confirmed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by === 'link' || row.approved_by === 'device' ? row.approved_by : null,
  };
}
