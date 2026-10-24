/**
 * SEND OVER A BANK RAIL (BK-xfer-02, J-bank-04 #1): send from a space to someone's bank account over ACH, a domestic
 * wire, a real-time payment, SEPA or a proxy id (a phone number or an email the payee's bank knows them by).
 *
 * Each rail has its own recipient form (`RAIL_FORMS`), checked here for format only: an ABA routing number's check
 * digit, an IBAN's mod-97, an E.164 phone. A form that passes proves nothing about the account. No banking partner
 * carries any of these rails in this build, so every send is answered with `rail.bank` and kept as an intent row,
 * `refused` with that code: nothing is held or posted, and money would leave a space only through the ledger's recipes
 * once a partner carries the rail. The request id is the customer's business key for one ask: the same id on the same
 * terms is the same intent, and on other terms, or from someone else, is `bank.rail_send_conflict`.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { SpaceRecord, SpaceService } from '../spaces/space-service.js';
import { isIbanRef } from '../withdraw-destination.js';
import type { PayeeService } from './payees.js';

export const BANK_RAILS = ['ach', 'wire', 'instant', 'sepa', 'proxy'] as const;
export type BankRail = (typeof BANK_RAILS)[number];

export interface RailField {
  readonly name: string;
  readonly required: boolean;
  /** The values a choice field takes; null for a typed field. */
  readonly choices: readonly string[] | null;
}

const text = (name: string, required = true): RailField => ({ name, required, choices: null });
const choice = (name: string, choices: readonly string[]): RailField => ({ name, required: true, choices });

/** Each rail's recipient form, in the order it is filled. */
export const RAIL_FORMS: Readonly<Record<BankRail, readonly RailField[]>> = {
  ach: [text('holderName'), text('routingNumber'), text('accountNumber'), choice('accountType', ['checking', 'savings'])],
  wire: [text('holderName'), text('routingNumber'), text('accountNumber'), text('bankName')],
  instant: [text('holderName'), text('routingNumber'), text('accountNumber')],
  sepa: [text('holderName'), text('iban'), text('bic', false), choice('transferType', ['standard', 'instant'])],
  proxy: [choice('aliasType', ['phone', 'email']), text('alias')],
};

export interface RailRequirement {
  readonly rail: BankRail;
  readonly fields: { name: string; required: boolean; choices: string[] | null }[];
  /** Who carries the rail. Null in this build: no banking partner carries any of them. */
  readonly partner: null;
  readonly blocker: 'rail.bank';
}

/** A send to details typed for this send, or to a saved recipient (`./payees.ts`) once its cooling-off has passed. */
export type RailSendAsk = {
  readonly fromSpaceId: string;
  readonly amount: string;
} & (
  | { readonly rail: BankRail; readonly recipient: Readonly<Record<string, string>>; readonly payeeId?: undefined }
  | { readonly payeeId: string; readonly rail?: undefined; readonly recipient?: undefined }
);

export interface RailSendCheck {
  readonly assetId: string;
  readonly amount: string;
  /** The space's available balance, read from the ledger for this check. */
  readonly available: string;
}

export interface RailSendView {
  readonly requestId: string;
  readonly fromSpaceId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly rail: BankRail;
  /** Who it was for, masked: the holder's name (or the alias type) and the last four characters of the account. */
  readonly recipient: string;
  readonly status: 'refused';
  readonly refusalCode: string;
  readonly createdAt: string;
}

interface IntentRow {
  id: string;
  user_id: string;
  from_space_id: string;
  asset_id: string;
  amount: string;
  rail: BankRail;
  recipient: Record<string, string>;
  status: 'refused';
  refusal_code: string;
  created_at: Date;
}

const invalid = (message: string) => new BankError(message, 'bank.rail_send_invalid');

/**
 * ABA routing number: nine digits, a Federal Reserve prefix (01-12, 21-32, 61-72, 80; 00 is the US government's), and a
 * weighted sum (3, 7, 1 repeating) that is a multiple of ten.
 */
export function isAbaRouting(value: string): boolean {
  if (!/^\d{9}$/.test(value) || /^0+$/.test(value)) return false;
  const prefix = Number(value.slice(0, 2));
  if (!(prefix <= 12 || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80)) return false;
  const d = [...value].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

const NAME_RE = /^[^\p{Cc}]{1,140}$/u;
const ACCOUNT_RE = /^\d{4,17}$/;
const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}\.[^\s@\p{Cc}]{2,63}$/u;

/** The recipient as the rail's form takes it, normalised, or a refusal naming the first field it refuses. */
export function checkRecipient(rail: BankRail, given: Readonly<Record<string, string>>): Record<string, string> {
  const form = RAIL_FORMS[rail];
  const known = new Set(form.map((field) => field.name));
  for (const name of Object.keys(given)) if (!known.has(name)) throw invalid(`The ${rail} form has no field ${name}`);
  const out: Record<string, string> = {};
  for (const field of form) {
    const raw = (given[field.name] ?? '').trim();
    if (!raw) {
      if (field.required) throw invalid(`Fill in ${field.name}`);
      continue;
    }
    if (field.choices && !field.choices.includes(raw)) throw invalid(`Choose ${field.name}: ${field.choices.join(' or ')}`);
    out[field.name] = raw;
  }
  const field = (name: string) => out[name] ?? '';
  if ('holderName' in out && !NAME_RE.test(field('holderName'))) throw invalid('The holder name is up to 140 characters');
  if ('bankName' in out && !NAME_RE.test(field('bankName'))) throw invalid('The bank name is up to 140 characters');
  if ('routingNumber' in out) {
    out.routingNumber = field('routingNumber').replace(/[\s-]/g, '');
    if (!isAbaRouting(out.routingNumber)) throw invalid('The routing number is nine digits with a valid check digit');
  }
  if ('accountNumber' in out) {
    out.accountNumber = field('accountNumber').replace(/[\s-]/g, '');
    if (!ACCOUNT_RE.test(out.accountNumber)) throw invalid('The account number is 4 to 17 digits');
  }
  if ('iban' in out) {
    out.iban = field('iban').replace(/\s+/g, '').toUpperCase();
    if (!isIbanRef(out.iban)) throw invalid('The IBAN does not check out');
  }
  if ('bic' in out) {
    out.bic = field('bic').replace(/\s+/g, '').toUpperCase();
    if (!BIC_RE.test(out.bic)) throw invalid('The BIC is 8 or 11 letters and digits');
  }
  if (rail === 'proxy') {
    if (field('aliasType') === 'phone') {
      out.alias = field('alias').replace(/[\s()-]/g, '');
      if (!PHONE_RE.test(out.alias)) throw invalid('The phone number starts with + and the country code');
    } else {
      out.alias = field('alias').toLowerCase();
      if (!EMAIL_RE.test(out.alias)) throw invalid('The email address does not look right');
    }
  }
  return out;
}

/** The recipient as a list row shows it: never the full account. */
export function maskRecipient(rail: BankRail, recipient: Readonly<Record<string, string>>): string {
  if (rail === 'proxy') {
    const alias = recipient.alias ?? '';
    const shown = recipient.aliasType === 'email' ? `${alias.slice(0, 1)}…${alias.slice(alias.indexOf('@'))}` : `…${alias.slice(-4)}`;
    return `${recipient.aliasType ?? ''} ${shown}`;
  }
  const account = recipient.iban ?? recipient.accountNumber ?? '';
  return `${recipient.holderName ?? ''} · …${account.slice(-4)}`;
}

/** Key order does not change a recipient: jsonb keeps its own order. */
function canonical(recipient: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(recipient)
      .sort()
      .map((key) => [key, recipient[key]]),
  );
}

export class RailSendService {
  constructor(
    private readonly sql: Sql,
    private readonly spaces: Pick<SpaceService, 'find' | 'balanceOf'>,
    private readonly payees: Pick<PayeeService, 'find' | 'assertCooled'>,
  ) {}

  requirements(): RailRequirement[] {
    return BANK_RAILS.map((rail) => ({
      rail,
      fields: RAIL_FORMS[rail].map((field) => ({ ...field, choices: field.choices ? [...field.choices] : null })),
      partner: null,
      blocker: 'rail.bank',
    }));
  }

  /**
   * Every check a send makes, without keeping anything: the amount, the rail's form, the space and its available balance.
   * The screen asks this before the person spends a code, so a typo is answered on the form.
   */
  async check(userId: string, ask: RailSendAsk): Promise<RailSendCheck> {
    const { space, amount, rail, recipient } = await this.entry(userId, ask);
    await this.payees.assertCooled(userId, rail, recipient);
    const available = await this.available(space, amount);
    return { assetId: space.assetId, amount: formatAmount(amount), available: formatAmount(available) };
  }

  /** Ask to send. Kept `refused` with `rail.bank`; nothing is held or posted. */
  async send(userId: string, ask: RailSendAsk & { readonly requestId: string }): Promise<RailSendView> {
    const { space, amount, rail, recipient } = await this.entry(userId, ask);
    const fromSpaceId = space.id;
    const prior = await this.row(ask.requestId);
    // A send already kept is answered as kept: a later change to the recipient or the window does not undo it.
    if (prior) return view(same(prior, userId, { fromSpaceId, amount, rail, recipient }));
    await this.payees.assertCooled(userId, rail, recipient);
    await this.available(space, amount);
    const rows = await this.sql<IntentRow[]>`
      INSERT INTO bank.rail_send_intents (id, user_id, from_space_id, asset_id, amount, rail, recipient, status, refusal_code)
      VALUES (
        ${ask.requestId}::uuid, ${userId}, ${fromSpaceId}::uuid, ${space.assetId}, ${formatAmount(amount)}::numeric,
        ${rail}, ${this.sql.json(recipient)}, 'refused', 'rail.bank'
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const row = rows[0] ?? (await this.row(ask.requestId));
    if (!row) throw new BankError('The send was not kept', 'bank.rail_send_conflict');
    return view(same(row, userId, { fromSpaceId, amount, rail, recipient }));
  }

  /** The customer's own sends over a bank rail, newest first. */
  async list(userId: string, limit: number): Promise<RailSendView[]> {
    const rows = await this.sql<IntentRow[]>`
      SELECT * FROM bank.rail_send_intents WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(view);
  }

  /**
   * The amount, the rail's form (or the saved recipient's), then the space: not found and not yours read the same, as
   * every space door does. The recipient's cooling-off comes after, in `check` and `send`.
   */
  private async entry(userId: string, ask: RailSendAsk) {
    let amount: Amount;
    try {
      amount = parseAmount(ask.amount.trim());
    } catch {
      throw invalid('Enter an amount with up to 18 decimals');
    }
    if (amount <= 0n) throw invalid('The amount to send must be above zero');
    let rail: BankRail;
    let recipient: Record<string, string>;
    if (ask.payeeId !== undefined) {
      const payee = await this.payees.find(userId, ask.payeeId);
      rail = payee.rail;
      recipient = checkRecipient(payee.rail, payee.recipient);
    } else {
      rail = ask.rail;
      recipient = checkRecipient(ask.rail, ask.recipient);
    }
    const fromSpaceId = ask.fromSpaceId.trim().toLowerCase();
    const space = await this.spaces.find(fromSpaceId);
    if (!space || space.userId !== userId) throw new BankError(`Space ${fromSpaceId} not found`, 'bank.space_not_found');
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    return { space, amount, rail, recipient };
  }

  /** The space's available balance from the ledger, refusing an amount above it. */
  private async available(space: SpaceRecord, amount: Amount): Promise<Amount> {
    const available = await this.spaces.balanceOf(space);
    if (amount > available) {
      throw new BankError(
        `You can send up to ${formatAmount(available)} ${space.assetId}, the balance available in this space now`,
        'bank.rail_send_over_available',
      );
    }
    return available;
  }

  private async row(id: string): Promise<IntentRow | undefined> {
    const rows = await this.sql<IntentRow[]>`SELECT * FROM bank.rail_send_intents WHERE id = ${id}::uuid`;
    return rows[0];
  }
}

function view(row: IntentRow): RailSendView {
  return {
    requestId: row.id,
    fromSpaceId: row.from_space_id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    rail: row.rail,
    recipient: maskRecipient(row.rail, row.recipient),
    status: row.status,
    refusalCode: row.refusal_code,
    createdAt: row.created_at.toISOString(),
  };
}

/** The kept intent, if it is this customer's and was asked on the same terms. Anything else is a conflict. */
function same(
  row: IntentRow,
  userId: string,
  asked: { fromSpaceId: string; amount: Amount; rail: BankRail; recipient: Record<string, string> },
): IntentRow {
  const matches =
    row.user_id === userId &&
    row.from_space_id === asked.fromSpaceId &&
    parseAmount(row.amount) === asked.amount &&
    row.rail === asked.rail &&
    canonical(row.recipient) === canonical(asked.recipient);
  if (!matches) throw new BankError('This request id is already used on other terms', 'bank.rail_send_conflict');
  return row;
}
