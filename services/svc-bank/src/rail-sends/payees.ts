/**
 * THE RECIPIENT BOOK FOR BANK RAILS (BK-xfer-06, J-bank-04 #2): the bank accounts and aliases a customer sends to.
 *
 * A recipient is saved with a nickname, the country of the account and one rail's form (`RAIL_FORMS`), checked as a send
 * checks it. The country picks the forms: a US account takes ACH, a domestic wire or a real-time payment; an account in
 * a euro-area country takes SEPA, with an IBAN of that country; either can be found by a phone number or email.
 * Saving the same destination again is the same recipient, one row per `(user, destination)`. Details are never edited:
 * a changed account is a new recipient, so its cooling-off starts again.
 *
 * Cooling-off: a new recipient waits the owner's window (`BANK_PAYEE_COOLING_HOURS`) before money may go to it. The
 * window is an owner setting with no default: blank refuses every send to a saved recipient
 * (`bank.payee_cooling_unset`), inside it refuses with the end time (`bank.payee_cooling_active`), and zero is a real
 * owner choice (no wait). Name verification needs a banking partner, so every recipient reads "cannot check" with
 * `rail.bank`; an invite, which emails the recipient a link to enter their own details, is refused while no email
 * delivery is connected (`bank.payee_invite_unwired`). Nothing here holds or posts money.
 */
import type { Sql } from 'postgres';
import { BankError } from '../errors.js';
import { checkRecipient, maskRecipient, type BankRail } from './rail-sends.js';

export const BANK_PAYEE_COOLING_HOURS_ENV = 'BANK_PAYEE_COOLING_HOURS';

/** The euro-area countries (2026): SEPA from a euro account. A fact of the currency union, not an owner value. */
const EURO_AREA = [
  'AT',
  'BE',
  'BG',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
] as const;

/** Each country the book takes, with the rails its forms come from. */
export const PAYEE_COUNTRIES: Readonly<Record<string, readonly BankRail[]>> = {
  US: ['ach', 'wire', 'instant', 'proxy'],
  ...Object.fromEntries(EURO_AREA.map((country) => [country, ['sepa', 'proxy'] as const])),
};

export interface PayeeAsk {
  readonly nickname: string;
  readonly country: string;
  readonly rail: BankRail;
  readonly recipient: Readonly<Record<string, string>>;
}

export interface PayeeView {
  readonly payeeId: string;
  readonly nickname: string;
  readonly country: string;
  readonly rail: BankRail;
  /** Masked, as a send's row shows it. */
  readonly recipient: string;
  /** Name verification needs a banking partner: "cannot check", with the rail that is missing. */
  readonly verification: 'cannot_check';
  readonly verificationRail: 'rail.bank';
  readonly addedAt: string;
  /** `unset`: the owner has not published the window. `active`: money may go to it from `endsAt`. `open`: it may now. */
  readonly cooling: { readonly state: 'unset' | 'active' | 'open'; readonly endsAt: string | null };
}

export interface PayeeRow {
  id: string;
  user_id: string;
  nickname: string;
  country: string;
  rail: BankRail;
  recipient: Record<string, string>;
  destination_key: string;
  created_at: Date;
  removed_at: Date | null;
}

const invalid = (message: string) => new BankError(message, 'bank.rail_send_invalid');
const HOUR_MS = 3_600_000;

/** The owner's window in whole hours, or null when blank or not a whole number. */
export function readPayeeCoolingHours(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  return /^[0-9]+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/** Who the money reaches: the account (or alias) without the name, so a new holder name is the same destination. */
export function destinationKey(rail: BankRail, recipient: Readonly<Record<string, string>>): string {
  if (rail === 'sepa') return `iban:${recipient.iban}`;
  if (rail === 'proxy') return `${recipient.aliasType}:${recipient.alias}`;
  // ACH, a wire and a real-time payment reach the same US account: one destination, one window.
  return `aba:${recipient.routingNumber}:${recipient.accountNumber}`;
}

function cooling(hours: number | null, addedAt: Date, now: Date): PayeeView['cooling'] {
  const ends = hours === null ? null : new Date(addedAt.getTime() + hours * HOUR_MS);
  // A window past what a date can hold is not a window anyone published: it reads as unset, never as a crash.
  if (ends === null || !Number.isFinite(ends.getTime())) return { state: 'unset', endsAt: null };
  return { state: ends > now ? 'active' : 'open', endsAt: ends.toISOString() };
}

export class PayeeService {
  constructor(
    private readonly sql: Sql,
    private readonly coolingHours: () => string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  countries(): { country: string; rails: BankRail[] }[] {
    return Object.entries(PAYEE_COUNTRIES).map(([country, rails]) => ({ country, rails: [...rails] }));
  }

  /** Every check saving makes, keeping nothing: asked before the person spends a code on the confirmation. */
  check(ask: PayeeAsk): { nickname: string; country: string; rail: BankRail; recipient: string } {
    const { nickname, country, recipient } = this.entry(ask);
    return { nickname, country, rail: ask.rail, recipient: maskRecipient(ask.rail, recipient) };
  }

  /** Save a recipient. The same destination again is the same recipient, its cooling-off unchanged. */
  async add(userId: string, ask: PayeeAsk): Promise<PayeeView> {
    const { nickname, country, recipient } = this.entry(ask);
    const key = destinationKey(ask.rail, recipient);
    const rows = await this.sql<PayeeRow[]>`
      INSERT INTO bank.rail_payees (user_id, nickname, country, rail, recipient, destination_key)
      VALUES (${userId}, ${nickname}, ${country}, ${ask.rail}, ${this.sql.json(recipient)}, ${key})
      ON CONFLICT (user_id, destination_key) WHERE removed_at IS NULL DO NOTHING
      RETURNING *
    `;
    const row =
      rows[0] ??
      (
        await this.sql<PayeeRow[]>`
          SELECT * FROM bank.rail_payees WHERE user_id = ${userId} AND destination_key = ${key} AND removed_at IS NULL
        `
      )[0];
    if (!row) throw new BankError('The recipient was not saved', 'bank.rail_send_conflict');
    return this.view(row);
  }

  /** The nickname, the country, a rail that country takes, and that rail's form. */
  private entry(ask: PayeeAsk) {
    const nickname = ask.nickname.trim();
    if (!/^[^\p{Cc}]{1,60}$/u.test(nickname)) throw invalid('The nickname is 1 to 60 characters');
    const country = ask.country.trim().toUpperCase();
    const rails = PAYEE_COUNTRIES[country];
    if (!rails) throw invalid(`The book takes accounts in ${Object.keys(PAYEE_COUNTRIES).join(', ')}`);
    if (!rails.includes(ask.rail)) throw invalid(`An account in ${country} takes ${rails.join(', ')}`);
    const recipient = checkRecipient(ask.rail, ask.recipient);
    if (ask.rail === 'sepa' && recipient.iban!.slice(0, 2) !== country) throw invalid(`The IBAN is not an account in ${country}`);
    return { nickname, country, recipient };
  }

  /** The customer's saved recipients, newest first. */
  async list(userId: string, limit: number): Promise<PayeeView[]> {
    const rows = await this.sql<PayeeRow[]>`
      SELECT * FROM bank.rail_payees WHERE user_id = ${userId} AND removed_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map((row) => this.view(row));
  }

  /** Remove one of the customer's recipients, waiting or not. Not found and not yours read the same. */
  async remove(userId: string, payeeId: string): Promise<{ payeeId: string; removed: true }> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE bank.rail_payees SET removed_at = now()
       WHERE id = ${payeeId}::uuid AND user_id = ${userId} AND removed_at IS NULL
      RETURNING id
    `;
    if (!rows[0]) throw new BankError(`Recipient ${payeeId} not found`, 'bank.payee_not_found');
    return { payeeId: rows[0].id, removed: true };
  }

  /** An invite emails the recipient a link to enter their own details: no email delivery is connected here. */
  invite(email: string): never {
    if (!/^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}\.[^\s@\p{Cc}]{2,63}$/u.test(email.trim())) {
      throw invalid('The email address does not look right');
    }
    throw new BankError(
      'Inviting a recipient emails them a link, and no email delivery is connected in this build',
      'bank.payee_invite_unwired',
    );
  }

  /** A live saved recipient of this customer. Not found, not yours and removed read the same. */
  async find(userId: string, payeeId: string): Promise<PayeeRow> {
    const rows = await this.sql<PayeeRow[]>`
      SELECT * FROM bank.rail_payees WHERE id = ${payeeId}::uuid AND user_id = ${userId} AND removed_at IS NULL
    `;
    if (!rows[0]) throw new BankError(`Recipient ${payeeId} not found`, 'bank.payee_not_found');
    return rows[0];
  }

  /**
   * The cooling-off on a destination, whether the send names the saved recipient or types its details: the newest
   * recipient this customer saved for that destination (removed or not) sets the window. Blank window and inside the
   * window each refuse by name; nothing is kept. A destination never saved is a one-off send, which its own fresh
   * confirmation guards.
   */
  async assertCooled(userId: string, rail: BankRail, recipient: Readonly<Record<string, string>>): Promise<void> {
    const rows = await this.sql<PayeeRow[]>`
      SELECT * FROM bank.rail_payees WHERE user_id = ${userId} AND destination_key = ${destinationKey(rail, recipient)}
       ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return;
    const state = cooling(readPayeeCoolingHours(this.coolingHours()), row.created_at, this.now());
    if (state.state === 'unset') {
      throw new BankError(
        `${BANK_PAYEE_COOLING_HOURS_ENV} is unset: a new recipient's waiting time is not published, so nothing is sent to one`,
        'bank.payee_cooling_unset',
      );
    }
    if (state.state === 'active') {
      throw new BankError(`This recipient is new: money can go to it from ${state.endsAt}`, 'bank.payee_cooling_active');
    }
  }

  private view(row: PayeeRow): PayeeView {
    return {
      payeeId: row.id,
      nickname: row.nickname,
      country: row.country,
      rail: row.rail,
      recipient: maskRecipient(row.rail, row.recipient),
      verification: 'cannot_check',
      verificationRail: 'rail.bank',
      addedAt: row.created_at.toISOString(),
      cooling: cooling(readPayeeCoolingHours(this.coolingHours()), row.created_at, this.now()),
    };
  }
}
