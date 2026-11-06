import type { Sql } from 'postgres';
import { z } from 'zod';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';
import type { Amount } from '@intafaced/ledger-client';
import { toAddress, type CardRecord, type CardService, type CardShippingAddress } from './card-service.js';
import { requireProgramme, termsTextHash, type CardProgrammeTerms, type DeliverySpeed } from './card-programme.js';

/**
 * GETTING A CARD (J-bank-13; BK-cissue-01 to -04): the card room's product list, the cardholder terms, the order, and a
 * physical card's delivery and its address history.
 *
 * No value moves here. An order is `CardService.issue` with the owner's eligibility, count limit and terms checked first,
 * and a physical card's delivery is a record of what a printer and courier said. Neither is connected (`hardware`): only
 * the test stack's stand-in printer, through its signed job door, moves a delivery past `ordered`.
 */

export interface CardCatalogue {
  programme: { id: string; simulated: boolean; displayName: string };
  network: string;
  country: string;
  eligible: boolean;
  /** Why not, as a typed code: `bank.card_not_eligible` for a country off the owner's list. */
  reason: string | null;
  countries: string[];
  products: Array<{ type: 'virtual' | 'physical'; held: number; limit: number }>;
  terms: { version: string; text: string; textHash: string; acceptance: { id: string; version: string; acceptedAt: Date } | null };
  designs: Array<{ id: string; name: string }>;
  speeds: Array<{ speed: DeliverySpeed; days: number }>;
  deliveryCountries: string[];
}

export interface CardDelivery {
  cardId: string;
  state: 'ordered' | 'produced' | 'shipped' | 'delivered';
  designId: string | null;
  designName: string | null;
  speed: string;
  estimateDays: number;
  orderedAt: Date;
  expectedBy: Date;
  carrier: string | null;
  trackingRef: string | null;
  address: CardShippingAddress;
  history: Array<{ address: CardShippingAddress; changedAt: Date }>;
}

export type ShipmentState = CardDelivery['state'];

/** The stand-in printer's job body (`/internal/jobs/card-sim/shipment`). */
export const cardShipmentJobBody = z
  .object({
    cardId: z.string().uuid(),
    state: z.enum(['ordered', 'produced', 'shipped', 'delivered']),
    carrier: z.string().min(1).max(80).optional(),
    trackingRef: z.string().min(1).max(80).optional(),
  })
  .strict();
const SHIPMENT_ORDER: readonly ShipmentState[] = ['ordered', 'produced', 'shipped', 'delivered'];

export interface CardOrderOptions {
  readonly terms: CardProgrammeTerms | null;
}

export class CardOrderService {
  private readonly terms: CardProgrammeTerms | null;

  constructor(
    private readonly sql: Sql,
    private readonly cards: CardService,
    options: CardOrderOptions,
  ) {
    this.terms = options.terms;
  }

  // ── The product list (BK-cissue-01) ──────────────────────────────────────

  async catalogue(userId: string, countryCode: string): Promise<CardCatalogue> {
    const terms = requireProgramme(this.terms);
    const country = countryCode.trim().toUpperCase();
    const eligible = terms.countries.includes(country);
    const [virtualHeld, physicalHeld, acceptance] = await Promise.all([
      this.cards.heldCount(userId, 'virtual'),
      this.cards.heldCount(userId, 'physical'),
      this.acceptanceOf(userId, terms.terms.version),
    ]);
    return {
      programme: this.cards.programme(),
      network: terms.network,
      country,
      eligible,
      reason: eligible ? null : 'bank.card_not_eligible',
      countries: [...terms.countries],
      products: [
        { type: 'virtual', held: virtualHeld, limit: terms.limits.virtual },
        { type: 'physical', held: physicalHeld, limit: terms.limits.physical },
      ],
      terms: { version: terms.terms.version, text: terms.terms.text, textHash: termsTextHash(terms.terms.text), acceptance },
      designs: terms.designs.map((d) => ({ ...d })),
      speeds: terms.speeds.map((s) => ({ ...s })),
      deliveryCountries: [...terms.deliveryCountries],
    };
  }

  private async acceptanceOf(userId: string, version: string) {
    const rows = await this.sql<Array<{ id: string; terms_version: string; accepted_at: Date }>>`
      SELECT id, terms_version, accepted_at FROM bank.card_terms_acceptances WHERE user_id = ${userId} AND terms_version = ${version}
    `;
    const row = rows[0];
    return row ? { id: row.id, version: row.terms_version, acceptedAt: row.accepted_at } : null;
  }

  /**
   * The person accepts the terms they were shown (`consent:<userId>:<termsVersion>`). The version and the hash of the text
   * must be the ones published now; accepting the same version again returns the first acceptance and writes nothing.
   */
  async acceptTerms(userId: string, input: { termsVersion: string; textHash: string }) {
    const terms = requireProgramme(this.terms);
    if (input.termsVersion !== terms.terms.version || input.textHash !== termsTextHash(terms.terms.text)) {
      throw new BankError('These are not the cardholder terms published now; read them again before accepting', 'bank.card_terms_changed');
    }
    await this.sql`
      INSERT INTO bank.card_terms_acceptances (user_id, terms_version, text_hash)
      VALUES (${userId}, ${terms.terms.version}, ${input.textHash})
      ON CONFLICT (user_id, terms_version) DO NOTHING
    `;
    return (await this.acceptanceOf(userId, terms.terms.version))!;
  }

  // ── The order (BK-cissue-02, -03) ────────────────────────────────────────

  /**
   * Order one card. Eligibility is checked here at the order, not only on the product list; then the terms, the design,
   * speed and delivery country of a physical card; then `CardService.issue`, which checks the count limit under the
   * person's lock. `cardId` is the request: a retry is the same card and the same delivery, never a second one.
   */
  async order(input: {
    cardId: string;
    userId: string;
    country: string;
    termsVersion: string;
    assetId: string;
    perAuthorizationLimit: Amount;
    cardType: 'virtual' | 'physical';
    usesAllowed?: number | null;
    designId?: string;
    deliverySpeed?: DeliverySpeed;
    shippingAddress?: CardShippingAddress;
  }): Promise<CardRecord> {
    const terms = requireProgramme(this.terms);
    const country = input.country.trim().toUpperCase();
    if (!terms.countries.includes(country)) {
      throw new BankError(`Cards are not offered to residents of ${country}`, 'bank.card_not_eligible');
    }
    if (input.termsVersion !== terms.terms.version) {
      throw new BankError('These are not the cardholder terms published now; read them again', 'bank.card_terms_changed');
    }
    if (!(await this.acceptanceOf(input.userId, terms.terms.version))) {
      throw new BankError('Accept the cardholder terms before ordering a card', 'bank.card_terms_not_accepted');
    }
    let speed: { speed: DeliverySpeed; days: number } | null = null;
    if (input.cardType === 'physical') {
      if (!input.designId || !terms.designs.some((d) => d.id === input.designId)) {
        throw new BankError('Choose one of the programme’s card designs', 'bank.card_design_unknown');
      }
      speed = terms.speeds.find((s) => s.speed === input.deliverySpeed) ?? null;
      if (!speed) throw new BankError('Choose one of the programme’s delivery speeds', 'bank.card_delivery_speed_unknown');
      const to = input.shippingAddress?.country.trim().toUpperCase();
      if (to && !terms.deliveryCountries.includes(to)) {
        throw new BankError(`A physical card is not delivered to ${to}`, 'bank.card_delivery_country');
      }
    } else if (input.designId !== undefined || input.deliverySpeed !== undefined || input.shippingAddress !== undefined) {
      throw new BankError('A virtual card has no design, delivery speed or address', 'bank.card_not_physical');
    }
    const card = await this.cards.issue({
      cardId: input.cardId,
      userId: input.userId,
      assetId: input.assetId,
      perAuthorizationLimit: input.perAuthorizationLimit,
      cardType: input.cardType,
      ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
      // A virtual card works at once; a physical card is activated when it arrives (BK-cissue-04).
      activated: input.cardType === 'virtual',
      usesAllowed: input.cardType === 'virtual' ? (input.usesAllowed ?? null) : null,
      designId: input.designId ?? null,
      deliverySpeed: speed?.speed ?? null,
      residenceCountry: country,
    });
    if (card.userId !== input.userId) throw new BankError('This card id already belongs to another card', 'bank.card_issue_conflict');
    if (card.cardType === 'physical') await this.ensureShipment(card);
    return card;
  }

  /** The delivery row of a physical card, written once from the card (a retried order or a replacement finds it). */
  private async ensureShipment(card: CardRecord): Promise<void> {
    if (card.cardType !== 'physical' || !card.shippingAddress) return;
    const speed = card.deliverySpeed ?? 'standard';
    const days = this.terms?.speeds.find((s) => s.speed === speed)?.days;
    if (!days)
      throw new BankError('The delivery speed of this card is not one the programme offers now', 'bank.card_delivery_speed_unknown');
    await this.sql`
      INSERT INTO bank.card_shipments (card_id, user_id, speed, estimate_days, address)
      VALUES (${card.id}, ${card.userId}, ${speed}, ${days}, ${JSON.stringify(card.shippingAddress)}::jsonb)
      ON CONFLICT (card_id) DO NOTHING
    `;
  }

  private async ownedPhysical(userId: string, cardId: string): Promise<CardRecord> {
    const card = await this.cards.card(cardId);
    if (card.userId !== userId) throw new BankError(`Card ${cardId} not found`, 'bank.card_not_found');
    if (card.cardType !== 'physical') throw new BankError('A virtual card has no delivery', 'bank.card_not_physical');
    return card;
  }

  // ── Delivery (BK-cissue-03) ──────────────────────────────────────────────

  async delivery(userId: string, cardId: string): Promise<CardDelivery> {
    const card = await this.ownedPhysical(userId, cardId);
    await this.ensureShipment(card);
    return this.readDelivery(card);
  }

  private async readDelivery(card: CardRecord, sql: Sql = this.sql): Promise<CardDelivery> {
    const [row] = await sql<
      Array<{
        state: ShipmentState;
        speed: string;
        estimate_days: number;
        ordered_at: Date;
        carrier: string | null;
        tracking_ref: string | null;
        address: unknown;
      }>
    >`SELECT state, speed, estimate_days, ordered_at, carrier, tracking_ref, address FROM bank.card_shipments WHERE card_id = ${card.id}`;
    if (!row) throw new BankError(`Card ${card.id} has no delivery record`, 'bank.card_not_found');
    const history = await sql<Array<{ previous_address: unknown; changed_at: Date }>>`
      SELECT previous_address, changed_at FROM bank.card_address_changes WHERE card_id = ${card.id} ORDER BY changed_at, id
    `;
    const designName = card.designId ? (this.terms?.designs.find((d) => d.id === card.designId)?.name ?? null) : null;
    return {
      cardId: card.id,
      state: row.state,
      designId: card.designId ?? null,
      designName,
      speed: row.speed,
      estimateDays: Number(row.estimate_days),
      orderedAt: row.ordered_at,
      expectedBy: new Date(row.ordered_at.getTime() + Number(row.estimate_days) * 86_400_000),
      carrier: row.carrier,
      trackingRef: row.tracking_ref,
      address: toAddress(row.address)!,
      history: history.map((h) => ({ address: toAddress(h.previous_address)!, changedAt: h.changed_at })),
    };
  }

  /**
   * Change the delivery address of a card not yet produced (`ship-update:<cardId>:<requestId>`). The address it replaces is
   * kept in the history. Once the printer has produced the card it refuses `bank.card_address_locked`; a retried request
   * that already landed changes nothing.
   */
  async updateShipping(input: { userId: string; cardId: string; requestId: string; address: CardShippingAddress }): Promise<CardDelivery> {
    const card = await this.ownedPhysical(input.userId, input.cardId);
    const terms = requireProgramme(this.terms);
    const to = input.address.country.trim().toUpperCase();
    if (!terms.deliveryCountries.includes(to))
      throw new BankError(`A physical card is not delivered to ${to}`, 'bank.card_delivery_country');
    await this.ensureShipment(card);
    const address = { ...input.address, country: to };
    await transaction(this.sql, async (tx) => {
      const [row] = await tx<Array<{ state: ShipmentState; address: unknown }>>`
        SELECT state, address FROM bank.card_shipments WHERE card_id = ${card.id} FOR UPDATE
      `;
      const done = await tx`SELECT 1 FROM bank.card_address_changes WHERE card_id = ${card.id} AND request_id = ${input.requestId}`;
      if (done.length > 0) return;
      if (!row || row.state !== 'ordered') {
        throw new BankError('This card is already produced, so its delivery address can no longer change', 'bank.card_address_locked');
      }
      await tx`
        INSERT INTO bank.card_address_changes (card_id, request_id, previous_address, address)
        VALUES (${card.id}, ${input.requestId}, ${JSON.stringify(toAddress(row.address))}::jsonb, ${JSON.stringify(address)}::jsonb)
      `;
      await tx`UPDATE bank.card_shipments SET address = ${JSON.stringify(address)}::jsonb, updated_at = now() WHERE card_id = ${card.id}`;
      await tx`UPDATE bank.cards SET shipping_address = ${JSON.stringify(address)}::jsonb, updated_at = now() WHERE id = ${card.id}`;
    });
    return this.readDelivery(await this.cards.card(card.id));
  }

  /**
   * What the printer or courier says happened to a card (the test stack's stand-in printer, `card-sim/shipment`). Forward
   * only and idempotent: the same state again changes nothing, an earlier one refuses `bank.card_shipment_order`. Only the
   * simulator has a stand-in printer; any other programme refuses `bank.card_printer_unset`, as no printer is connected.
   */
  async recordShipment(input: { cardId: string; state: ShipmentState; carrier?: string; trackingRef?: string }): Promise<CardDelivery> {
    if (this.cards.programme().id !== 'card-sim') {
      throw new BankError('Printing and delivery need hardware; no printer or courier is connected', 'bank.card_printer_unset');
    }
    const card = await this.cards.card(input.cardId);
    if (card.cardType !== 'physical') throw new BankError('A virtual card has no delivery', 'bank.card_not_physical');
    await this.ensureShipment(card);
    await transaction(this.sql, async (tx) => {
      const [row] = await tx<Array<{ state: ShipmentState }>>`SELECT state FROM bank.card_shipments WHERE card_id = ${card.id} FOR UPDATE`;
      const from = SHIPMENT_ORDER.indexOf(row!.state);
      const to = SHIPMENT_ORDER.indexOf(input.state);
      if (to === from) return;
      if (to < from) throw new BankError(`A ${row!.state} card cannot go back to ${input.state}`, 'bank.card_shipment_order');
      await tx`
        UPDATE bank.card_shipments
           SET state = ${input.state},
               carrier = COALESCE(${input.carrier ?? null}, carrier),
               tracking_ref = COALESCE(${input.trackingRef ?? null}, tracking_ref),
               produced_at = CASE WHEN ${to} >= 1 THEN COALESCE(produced_at, now()) ELSE produced_at END,
               shipped_at = CASE WHEN ${to} >= 2 THEN COALESCE(shipped_at, now()) ELSE shipped_at END,
               delivered_at = CASE WHEN ${to} >= 3 THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
               updated_at = now()
         WHERE card_id = ${card.id}
      `;
    });
    return this.readDelivery(card);
  }

  /** A replacement physical card gets its own delivery at the same address and speed (BK-cissue-04). */
  async afterReplace(replacement: CardRecord): Promise<void> {
    if (replacement.cardType === 'physical' && this.terms) await this.ensureShipment(replacement);
  }
}
