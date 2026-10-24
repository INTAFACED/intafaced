/**
 * LINKED BANK ACCOUNTS (BK-acct-02, J-bank-02 #6): the customer's own accounts at other banks, to pay in from and to
 * cash out to.
 *
 * A linked account is kept as the customer typed it and starts `unverified`. Only a banking partner can prove that the
 * account exists and is in the customer's name (`rail.bank`): only the partner's signed call moves an account to
 * `verified` (`verify`, J-bank-03 #4), none is wired outside the local stack's TEST stand-in, and an unverified account is
 * never usable. The IBAN is the business key: one active link per
 * customer and IBAN, so linking the same IBAN again returns the account already linked and adds nothing. Removing keeps
 * the row with `removed_at`; linking that IBAN again later is a new account whose cooling-off starts again.
 *
 * Two owner values apply, the same ones the crypto address book uses, and neither is invented here:
 * - `BANK_ADDRESS_BOOK_CAP`: how many accounts one customer may link. Blank refuses `bank.address_book_cap_unset`.
 * - `BANK_OFFRAMP_COOLING_HOURS`: how long a new payout destination waits before money may leave to it. Blank lists the
 *   account with `bank.offramp_cooling_unset` and no end time.
 *
 * Nothing here moves value or holds an amount.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';
import { coolingOffEndsAt, readOfframpCoolingHours } from '../offramp-cooling.js';
import { isIbanRef, requireAddressBookCap } from '../withdraw-destination.js';

export const LINKED_ACCOUNT_STATES = ['unverified', 'verified'] as const;
export type LinkedAccountState = (typeof LINKED_ACCOUNT_STATES)[number];

/** Why an account cannot be used, in the order they are checked. */
export const LINKED_ACCOUNT_BLOCKERS = [
  'bank.linked_account_unverified',
  'bank.offramp_cooling_unset',
  'bank.offramp_cooling_active',
] as const;
export type LinkedAccountBlocker = (typeof LINKED_ACCOUNT_BLOCKERS)[number];

export type LinkedAccountView = {
  accountId: string;
  label: string;
  holderName: string;
  /** Country, check digits and the last four characters. The full IBAN is never sent back. */
  ibanMasked: string;
  country: string;
  state: LinkedAccountState;
  /** True only when the account is verified and its cooling-off has ended. */
  usable: boolean;
  /** Why it cannot be used, first reason first: unverified, then the owner's cooling-off. */
  blocker: LinkedAccountBlocker | null;
  /** What verifying it needs: a banking partner. Null once verified. */
  verificationRail: 'rail.bank' | null;
  linkedAt: string;
  /** When money may first leave to it. Null while the owner's window is blank. */
  coolingOffEndsAt: string | null;
};

export type LinkAccountInput = { label: string; holderName: string; iban: string };

export type LinkedAccountOptions = {
  /** Read on every call, so a change of the owner value applies without a restart. */
  addressBookCap?: () => string | undefined;
  offrampCoolingHours?: () => string | undefined;
  now?: () => Date;
};

type Row = {
  id: string;
  label: string;
  holder_name: string;
  iban: string;
  country: string;
  state: LinkedAccountState;
  created_at: Date;
};

const COLUMNS = 'id::text AS id, label, holder_name, iban, country, state, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (message: string) => new BankError(message, 'bank.linked_account_invalid');

/** The IBAN without spaces, in capitals, when it passes the mod-97 check. A pass does not prove the account exists. */
export function normalizeIban(raw: string): string {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact) || !isIbanRef(compact)) {
    throw invalid('Enter the IBAN as your bank shows it: two letters, two check digits and the account number');
  }
  return compact;
}

function typed(value: string, what: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max || CONTROL.test(trimmed)) {
    throw invalid(`The ${what} must be 1 to ${max} characters`);
  }
  return trimmed;
}

export function maskIban(iban: string): string {
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
}

export function viewOf(row: Row, coolingHours: number | null, now: Date): LinkedAccountView {
  const computed = coolingHours === null ? null : coolingOffEndsAt(coolingHours, row.created_at);
  // A window too large for a date reads as unset, so the account stays unusable rather than failing open.
  const ends = computed !== null && Number.isFinite(computed.getTime()) ? computed : null;
  const blocker: LinkedAccountBlocker | null =
    row.state !== 'verified'
      ? 'bank.linked_account_unverified'
      : ends === null
        ? 'bank.offramp_cooling_unset'
        : ends.getTime() > now.getTime()
          ? 'bank.offramp_cooling_active'
          : null;
  return {
    accountId: row.id,
    label: row.label,
    holderName: row.holder_name,
    ibanMasked: maskIban(row.iban),
    country: row.country,
    state: row.state,
    usable: blocker === null,
    blocker,
    verificationRail: row.state === 'verified' ? null : 'rail.bank',
    linkedAt: row.created_at.toISOString(),
    coolingOffEndsAt: ends === null ? null : ends.toISOString(),
  };
}

export class LinkedAccountService {
  constructor(
    private readonly sql: Sql,
    private readonly options: LinkedAccountOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private coolingHours(): number | null {
    return readOfframpCoolingHours(this.options.offrampCoolingHours?.());
  }

  async list(userId: string): Promise<LinkedAccountView[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
        FROM bank.linked_bank_accounts
       WHERE user_id = ${userId} AND removed_at IS NULL
       ORDER BY created_at ASC, id ASC
    `;
    const hours = this.coolingHours();
    const now = this.now();
    return rows.map((row) => viewOf(row, hours, now));
  }

  /**
   * Link an account, stored `unverified`. The same IBAN already linked returns that account unchanged (`created: false`),
   * so a retry after a lost answer links nothing twice. Links of one customer queue on a per-customer advisory lock taken
   * before anything is read, in a read-committed transaction, so each read after it sees every link committed before it:
   * that is what holds the cap and the one-link-per-IBAN rule (the unique index backs the second).
   */
  async link(userId: string, input: LinkAccountInput): Promise<{ account: LinkedAccountView; created: boolean }> {
    const iban = normalizeIban(input.iban);
    const label = typed(input.label, 'name for this account', 64);
    const holderName = typed(input.holderName, "account holder's name", 140);
    const result = await transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`linked-bank-accounts:${userId}`}))`;
        const same = await tx<Row[]>`
        SELECT ${tx.unsafe(COLUMNS)}
          FROM bank.linked_bank_accounts
         WHERE user_id = ${userId} AND iban = ${iban} AND removed_at IS NULL
      `;
        if (same[0]) return { row: same[0], created: false };
        const cap = linkCap(this.options.addressBookCap?.());
        const count = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bank.linked_bank_accounts WHERE user_id = ${userId} AND removed_at IS NULL
      `;
        if ((count[0]?.n ?? 0) >= cap) {
          throw new BankError(
            `You have linked ${cap} bank accounts, the most allowed. Remove one to link another`,
            'bank.linked_accounts_full',
          );
        }
        const rows = await tx<Row[]>`
        INSERT INTO bank.linked_bank_accounts (id, user_id, label, holder_name, iban, country)
        VALUES (${randomUUID()}, ${userId}, ${label}, ${holderName}, ${iban}, ${iban.slice(0, 2)})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
        return { row: rows[0]!, created: true };
      },
      { isolation: 'read committed' },
    );
    return { account: viewOf(result.row, this.coolingHours(), this.now()), created: result.created };
  }

  /** One active account of this customer, as the list shows it. Someone else's, a removed one, or none is not found. */
  async get(userId: string, accountId: string): Promise<LinkedAccountView> {
    const id = accountId.trim();
    if (!UUID_RE.test(id)) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
        FROM bank.linked_bank_accounts
       WHERE id = ${id}::uuid AND user_id = ${userId} AND removed_at IS NULL
    `;
    if (!rows[0]) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    return viewOf(rows[0], this.coolingHours(), this.now());
  }

  /**
   * The banking partner proved the account exists and is in the customer's name (J-bank-03 #4). Only the partner's
   * signed call reaches this, through the cash-out service, which refuses `rail.bank` when no partner is wired. Verifying
   * one already verified answers the same; the cooling-off still runs from when the customer linked it.
   */
  async verify(accountId: string): Promise<LinkedAccountView> {
    const id = accountId.trim();
    if (!UUID_RE.test(id)) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    // The partner names the account by the bank's own id for it, which is what it was given when asked to verify.
    const rows = await this.sql<Row[]>`
      UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = coalesce(verified_at, now())
       WHERE id = ${id}::uuid AND removed_at IS NULL
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!rows[0]) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    return viewOf(rows[0], this.coolingHours(), this.now());
  }

  /** The holder and masked IBAN a payout went to, for its receipt, even if the account was unlinked since. */
  async payoutDetails(userId: string, accountId: string): Promise<{ holderName: string; ibanMasked: string }> {
    const rows = await this.sql<Array<{ holder_name: string; iban: string }>>`
      SELECT holder_name, iban FROM bank.linked_bank_accounts WHERE id = ${accountId}::uuid AND user_id = ${userId}
    `;
    if (!rows[0]) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    return { holderName: rows[0].holder_name, ibanMasked: maskIban(rows[0].iban) };
  }

  /** Unlink. Removing one already removed answers the same; someone else's account, or none, is not found. */
  async remove(userId: string, accountId: string): Promise<{ accountId: string; removed: true }> {
    const id = accountId.trim();
    if (!UUID_RE.test(id)) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE bank.linked_bank_accounts SET removed_at = coalesce(removed_at, now())
       WHERE id = ${id}::uuid AND user_id = ${userId}
      RETURNING id::text AS id
    `;
    if (!rows[0]) throw new BankError('No linked bank account with this id', 'bank.linked_account_not_found');
    return { accountId: rows[0].id, removed: true };
  }
}

/** The address book's owner cap, which also bounds linked accounts. Blank refuses with the same code; no number is invented. */
function linkCap(raw: string | undefined): number {
  try {
    return requireAddressBookCap(raw);
  } catch {
    throw new BankError(
      'BANK_ADDRESS_BOOK_CAP is unset or not a positive whole number. Linking an account refuses rather than inventing a limit',
      'bank.address_book_cap_unset',
    );
  }
}
