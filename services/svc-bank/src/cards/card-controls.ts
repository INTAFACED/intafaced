import type { Sql } from 'postgres';
import { BankError } from '../errors.js';

/**
 * A CARDHOLDER'S CARD CONTROLS AND THE CARD'S LOCK HISTORY (BK-cctl-01, J-bank-14 #1).
 *
 * The person blocks merchant categories, single merchants and countries on one card. An authorisation that names a
 * blocked one declines before anything is quoted against a balance or held, with its own code:
 * `bank.card_category_blocked`, `bank.card_merchant_blocked` or `bank.card_country_blocked`. The issuer's message names
 * the category, merchant and country; one it leaves out is never blocked by a guess. The channel switches (online,
 * contactless, ATM, abroad) stay on the card row (`cards.setChannels`).
 *
 * The temporary lock is the card's freeze. Each change of status is a row here with who made it, so the person reads
 * the lock's history. Nothing here moves value.
 */

/** The merchant categories a person can block, as the issuer names them on an authorisation. */
export const CARD_CATEGORIES = [
  'gambling',
  'cash_like',
  'adult',
  'travel',
  'entertainment',
  'online_shopping',
  'groceries',
  'fuel',
] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

export const CARD_CONTROL_KINDS = ['category', 'merchant', 'country'] as const;
export type CardControlKind = (typeof CARD_CONTROL_KINDS)[number];

export interface CardControl {
  readonly id: string;
  readonly kind: CardControlKind;
  readonly value: string;
  readonly createdAt: string;
}

/** Who changed the status: the card's owner, a holder of a shared card, an operator, or the card's own rule. */
export type CardStatusActor = 'owner' | 'holder' | 'operator' | 'system';
export interface CardStatusEvent {
  readonly id: string;
  readonly status: 'active' | 'frozen' | 'closed';
  readonly actor: CardStatusActor;
  readonly at: string;
}

const MERCHANT_MAX = 64;

/** A control's value as stored: a listed category, a merchant name (compared without case), or a two-letter country. */
export function controlValue(kind: CardControlKind, raw: string): string {
  const value = raw.trim();
  if (kind === 'category') {
    if (!(CARD_CATEGORIES as readonly string[]).includes(value))
      throw new BankError(`Unknown card category ${value} (bank.card_control_invalid)`, 'bank.card_control_invalid');
    return value;
  }
  if (kind === 'country') {
    const country = value.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country))
      throw new BankError('A blocked country is its two-letter code (bank.card_control_invalid)', 'bank.card_control_invalid');
    return country;
  }
  if (!value || value.length > MERCHANT_MAX || /[\u0000-\u001f]/.test(value))
    throw new BankError(
      `A blocked merchant is a name of 1 to ${MERCHANT_MAX} characters (bank.card_control_invalid)`,
      'bank.card_control_invalid',
    );
  return value.toLowerCase();
}

/** What an authorisation names, as the issuer sent it; a part it left out is absent, never guessed. */
export interface AuthorizationMerchant {
  readonly merchantCategory?: string | undefined;
  readonly merchant?: string | undefined;
  readonly merchantCountry?: string | undefined;
}

/** The decline a live control gives this authorisation, or null. Category first, then merchant, then country. */
export function blockedBy(controls: readonly Pick<CardControl, 'kind' | 'value'>[], at: AuthorizationMerchant): string | null {
  const live = (kind: CardControlKind, value: string | undefined) =>
    value !== undefined && value.trim() !== '' && controls.some((c) => c.kind === kind && c.value === value);
  if (live('category', at.merchantCategory?.trim())) return 'bank.card_category_blocked';
  if (live('merchant', at.merchant?.trim().toLowerCase())) return 'bank.card_merchant_blocked';
  if (live('country', at.merchantCountry?.trim().toUpperCase())) return 'bank.card_country_blocked';
  return null;
}

interface ControlRow {
  id: string;
  kind: CardControlKind;
  value: string;
  created_at: Date;
}
const controlView = (row: ControlRow): CardControl => ({
  id: row.id,
  kind: row.kind,
  value: row.value,
  createdAt: row.created_at.toISOString(),
});

/** The controls of one card. The caller has already read the card as the person's own. */
export class CardControlStore {
  constructor(private readonly sql: Sql) {}

  async list(cardId: string): Promise<CardControl[]> {
    const rows = await this.sql<ControlRow[]>`
      SELECT id, kind, value, created_at FROM bank.card_controls
       WHERE card_id = ${cardId} AND lifted_at IS NULL
       ORDER BY created_at, id
    `;
    return rows.map(controlView);
  }

  /** Blocking what is already blocked returns the live control: a retry never makes a second one. */
  async block(cardId: string, kind: CardControlKind, raw: string): Promise<CardControl> {
    const value = controlValue(kind, raw);
    const inserted = await this.sql<ControlRow[]>`
      INSERT INTO bank.card_controls (card_id, kind, value) VALUES (${cardId}, ${kind}, ${value})
      ON CONFLICT (card_id, kind, value) WHERE lifted_at IS NULL DO NOTHING
      RETURNING id, kind, value, created_at
    `;
    if (inserted[0]) return controlView(inserted[0]);
    const live = await this.sql<ControlRow[]>`
      SELECT id, kind, value, created_at FROM bank.card_controls
       WHERE card_id = ${cardId} AND kind = ${kind} AND value = ${value} AND lifted_at IS NULL
    `;
    // Lifted between the two statements: the block is the person's newer word, so it is made again.
    return live[0] ? controlView(live[0]) : this.block(cardId, kind, raw);
  }

  /** Lifts a live control; lifting it again answers the same. One not on this card is not found. */
  async lift(cardId: string, controlId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE bank.card_controls SET lifted_at = COALESCE(lifted_at, now())
       WHERE card_id = ${cardId} AND id = ${controlId}
      RETURNING id
    `;
    if (!rows[0]) throw new BankError('That is not a control of this card (bank.card_control_not_found)', 'bank.card_control_not_found');
  }

  async history(cardId: string): Promise<CardStatusEvent[]> {
    const rows = await this.sql<Array<{ id: string; status: CardStatusEvent['status']; actor: CardStatusActor; at: Date }>>`
      SELECT id, status, actor, at FROM bank.card_status_events WHERE card_id = ${cardId} ORDER BY at DESC, id DESC LIMIT 50
    `;
    return rows.map((row) => ({ id: row.id, status: row.status, actor: row.actor, at: row.at.toISOString() }));
  }
}

/** Writes one change of a card's status, inside the transaction that made it. */
export async function noteStatusEvent(tx: Sql, cardId: string, status: CardStatusEvent['status'], actor: CardStatusActor): Promise<void> {
  await tx`INSERT INTO bank.card_status_events (card_id, status, actor) VALUES (${cardId}, ${status}, ${actor})`;
}
