/**
 * SIGNAL LISTINGS AND THE ONE PAYMENT FOR ACCESS (CB-bots-api-signal-04, J-copy-bots-otc-21 #1 #2).
 *
 * A provider publishes a signal listing: a title, a description, an asset and a price. A person buys access to it
 * once, by card through the card partner (card-partner.ts), and then may run a signal bot from it (svc-trade reads the
 * access through `GET /internal/signals/access/:listingId/:userId`, fail closed).
 *
 * The money (launch money model, OWNER 226): INTAFACED keeps no prepaid balance and holds none of the person's money.
 * The partner takes the payment; our ledger records our revenue once (`chargeEarn`, keyed by the payment row) and the
 * partner's settlement of it into our reserve there once (`chargeCollect`, keyed by the partner's settlement line).
 * The whole price is our revenue: a provider's share is CB-bots-api-signal-07, not built, and nothing is owed to them.
 *
 * In order, and what a crash at each point leaves (whose funds are stranded?):
 *   1. the payment row is written, `pending`, under `signal-payment:<listingId>:<buyerId>`, before the partner is asked.
 *      A crash after it: no money moved; a retry asks the partner under the same key.
 *   2. the partner is asked under that key. A lost answer leaves the row `pending`; the retry asks again with the same
 *      key and the partner answers its first answer (never a second charge). The person's money is at the partner.
 *   3. `approved` with the partner's ids, then the revenue is posted, then the settlement. A crash between them leaves
 *      the row `approved`: the next call (a retry, or a read of the listing) posts again under the same keys, which the
 *      ledger answers with the first post. The money is at the partner or in our reserve there; none is lost.
 *   4. `paid`: access is granted. Only `paid` grants access.
 * A declined payment is `declined` with the partner's code and posts nothing; it is final for that row.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { LedgerError, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { MarketError } from '../vendor-service.js';
import type { CardPartner } from './card-partner.js';

export const SIGNAL_MODULE = 'market';
export const SIGNAL_LISTINGS_MAX = 100;

export interface SignalListingView {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly description: string;
  readonly assetId: string;
  /** The provider's price; null when not set, and a purchase refuses. */
  readonly price: string | null;
  readonly createdAt: string;
}

export interface SignalPaymentView {
  readonly paymentId: string;
  readonly listingId: string;
  readonly method: 'card';
  readonly partner: string;
  readonly assetId: string;
  readonly amount: string;
  readonly status: 'pending' | 'approved' | 'paid' | 'declined';
  readonly code: string | null;
  /** True when the payment went through the TEST partner card. */
  readonly test: boolean;
  readonly createdAt: string;
}

export interface SignalListingForBuyer extends SignalListingView {
  /** The caller's own payment for this listing, if any. */
  readonly payment: SignalPaymentView | null;
  /** True only once the payment is `paid`. */
  readonly access: boolean;
}

interface ListingRow {
  id: string;
  provider_id: string;
  title: string;
  description: string;
  asset_id: string;
  price: string | null;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  listing_id: string;
  buyer_id: string;
  method: 'card';
  partner_id: string;
  asset_id: string;
  amount: string;
  status: SignalPaymentView['status'];
  partner_payment_id: string | null;
  partner_settlement_id: string | null;
  earned_tx_id: string | null;
  collected_tx_id: string | null;
  code: string | null;
  test: boolean;
  created_at: Date;
}

/** A stable id from a business key, so a retried write lands on the same row. */
function idFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const paymentKey = (listingId: string, buyerId: string) => `signal-payment:${listingId}:${buyerId}`;

const listingView = (r: ListingRow): SignalListingView => ({
  id: r.id,
  providerId: r.provider_id,
  title: r.title,
  description: r.description,
  assetId: r.asset_id,
  price: r.price,
  createdAt: r.created_at.toISOString(),
});

const paymentView = (r: PaymentRow): SignalPaymentView => ({
  paymentId: r.id,
  listingId: r.listing_id,
  method: r.method,
  partner: r.partner_id,
  assetId: r.asset_id,
  amount: r.amount,
  status: r.status,
  code: r.code,
  test: r.test,
  createdAt: r.created_at.toISOString(),
});

const PRICE = /^[0-9]+(\.[0-9]+)?$/;

export class SignalMarket {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'post'>,
    /** Null: no card partner is set, and every purchase refuses `market.signal_payment_partner_unset`. */
    private readonly partner: CardPartner | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A provider publishes a listing. The same client id again returns the same listing. */
  async publish(
    providerId: string,
    input: { clientListingId: string; title: string; description: string; assetId: string; price: string | null },
  ): Promise<SignalListingView> {
    if (input.price !== null && (!PRICE.test(input.price) || parseAmount(input.price) <= 0n)) {
      throw new MarketError('A signal price must be an amount above zero, or blank', 'market.signal_price_invalid');
    }
    const id = idFor(`signal-listing:${providerId}:${input.clientListingId}`);
    await this.sql`
      INSERT INTO market.signal_listings (id, provider_id, client_listing_id, title, description, asset_id, price, created_at)
      VALUES (${id}, ${providerId}, ${input.clientListingId}, ${input.title}, ${input.description}, ${input.assetId}, ${input.price}, ${this.now()})
      ON CONFLICT (provider_id, client_listing_id) DO NOTHING`;
    const [row] = await this.sql<ListingRow[]>`
      SELECT * FROM market.signal_listings WHERE provider_id = ${providerId} AND client_listing_id = ${input.clientListingId}`;
    return listingView(row!);
  }

  /** Every listing, oldest first (registration order, never ranked by return), with the caller's own payment. */
  async listings(buyerId: string): Promise<SignalListingForBuyer[]> {
    const rows = await this.sql<ListingRow[]>`
      SELECT * FROM market.signal_listings ORDER BY created_at, id LIMIT ${SIGNAL_LISTINGS_MAX}`;
    const payments = await this.sql<PaymentRow[]>`
      SELECT * FROM market.signal_payments WHERE buyer_id = ${buyerId}`;
    const out: SignalListingForBuyer[] = [];
    for (const row of rows) {
      let payment = payments.find((p) => p.listing_id === row.id) ?? null;
      // A payment a crash left approved is finished here, under its own keys (step 3).
      if (payment?.status === 'approved') payment = await this.finish(payment).catch(() => payment);
      out.push({ ...listingView(row), payment: payment ? paymentView(payment) : null, access: payment?.status === 'paid' });
    }
    return out;
  }

  /** The caller's own signal payments, newest first. */
  async payments(buyerId: string): Promise<SignalPaymentView[]> {
    const rows = await this.sql<PaymentRow[]>`
      SELECT * FROM market.signal_payments WHERE buyer_id = ${buyerId} ORDER BY created_at DESC, id`;
    return rows.map(paymentView);
  }

  /** Whether this person holds paid access to the listing. Unknown listing: null. */
  async access(listingId: string, buyerId: string): Promise<{ access: boolean; title: string } | null> {
    const [listing] = await this.sql<ListingRow[]>`SELECT * FROM market.signal_listings WHERE id = ${listingId}`;
    if (!listing) return null;
    const [payment] = await this.sql<PaymentRow[]>`
      SELECT * FROM market.signal_payments WHERE listing_id = ${listingId} AND buyer_id = ${buyerId}`;
    return { access: payment?.status === 'paid', title: listing.title };
  }

  /** Buy access to one listing by card, once. A second call returns the same payment and charges nothing more. */
  async buy(buyerId: string, listingId: string): Promise<SignalPaymentView> {
    const [listing] = await this.sql<ListingRow[]>`SELECT * FROM market.signal_listings WHERE id = ${listingId}`;
    if (!listing) throw new MarketError('No signal listing has that id', 'market.listing_not_found');
    const key = paymentKey(listingId, buyerId);
    let [row] = await this.sql<PaymentRow[]>`SELECT * FROM market.signal_payments WHERE business_key = ${key}`;
    if (!row) {
      if (listing.provider_id === buyerId) throw new MarketError('A provider cannot buy their own signal', 'market.purchase_self');
      if (listing.price === null) {
        throw new MarketError('The provider has not set a price for this signal, so it cannot be bought', 'market.signal_price_unset');
      }
      if (!this.partner) {
        throw new MarketError('No card partner is set, so a signal cannot be paid for', 'market.signal_payment_partner_unset');
      }
      const at = this.now();
      await this.sql`
        INSERT INTO market.signal_payments
          (id, listing_id, buyer_id, business_key, method, partner_id, asset_id, amount, status, test, created_at, updated_at)
        VALUES (${idFor(key)}, ${listingId}, ${buyerId}, ${key}, 'card', ${this.partner.id}, ${listing.asset_id}, ${listing.price},
                'pending', ${this.partner.test}, ${at}, ${at})
        ON CONFLICT (business_key) DO NOTHING`;
      [row] = await this.sql<PaymentRow[]>`SELECT * FROM market.signal_payments WHERE business_key = ${key}`;
    }
    if (row!.status === 'pending') row = await this.ask(row!, key);
    if (row!.status === 'approved') row = await this.finish(row!);
    return paymentView(row!);
  }

  /** Step 2: ask the partner under our key. The partner of record is the row's, so a retry never changes partner. */
  private async ask(row: PaymentRow, key: string): Promise<PaymentRow> {
    const partner = this.partner;
    if (!partner || partner.id !== row.partner_id) {
      throw new MarketError('The card partner this payment was started with is not set', 'market.signal_payment_partner_unset');
    }
    let answer;
    try {
      answer = await partner.pay({ key, buyerId: row.buyer_id, assetId: row.asset_id, amount: row.amount });
    } catch {
      throw new MarketError(
        'The card partner has not answered; try again and the same payment is asked for',
        'market.signal_payment_unknown',
      );
    }
    const at = this.now();
    const [next] =
      answer.status === 'approved'
        ? await this.sql<PaymentRow[]>`
            UPDATE market.signal_payments
               SET status = 'approved', partner_payment_id = ${answer.paymentId}, partner_settlement_id = ${answer.settlementId}, updated_at = ${at}
             WHERE id = ${row.id} AND status = 'pending' RETURNING *`
        : await this.sql<PaymentRow[]>`
            UPDATE market.signal_payments SET status = 'declined', code = ${answer.code}, updated_at = ${at}
             WHERE id = ${row.id} AND status = 'pending' RETURNING *`;
    if (next) return next;
    const [current] = await this.sql<PaymentRow[]>`SELECT * FROM market.signal_payments WHERE id = ${row.id}`;
    return current!;
  }

  /** Step 3: our revenue, then the partner's settlement, each once under its own key; then `paid`. */
  private async finish(row: PaymentRow): Promise<PaymentRow> {
    const amount = parseAmount(row.amount);
    const post = async (build: () => Parameters<LedgerClient['post']>[0]) => {
      try {
        return await this.ledger.post(build());
      } catch (err) {
        if (err instanceof LedgerError) throw new MarketError(err.message, err.code);
        throw new MarketError(
          'The ledger has not answered; try again and the same entries are posted once',
          'market.signal_payment_unknown',
        );
      }
    };
    const earned = await post(() =>
      recipes.chargeEarn({
        module: SIGNAL_MODULE,
        saleId: row.id,
        userId: row.buyer_id,
        assetId: row.asset_id,
        price: { perUnit: amount },
        units: 1n,
      }),
    );
    const collected = await post(() =>
      recipes.chargeCollect({
        module: SIGNAL_MODULE,
        userId: row.buyer_id,
        to: { kind: 'partner-reserve', partnerId: row.partner_id },
        paymentId: row.partner_settlement_id!,
        assetId: row.asset_id,
        amount,
      }),
    );
    const [next] = await this.sql<PaymentRow[]>`
      UPDATE market.signal_payments
         SET status = 'paid', earned_tx_id = ${earned.id}, collected_tx_id = ${collected.id}, updated_at = ${this.now()}
       WHERE id = ${row.id} AND status = 'approved' RETURNING *`;
    if (next) return next;
    const [current] = await this.sql<PaymentRow[]>`SELECT * FROM market.signal_payments WHERE id = ${row.id}`;
    return current!;
  }
}
