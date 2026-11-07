import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { InsufficientFundsError, formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { ListingError } from './errors.js';

/**
 * The express listing verification route and its fee (J-dex-protocol-24 #7, D-launch-listing-03).
 *
 * The fee is custodial money, so it is here and not in svc-protocol (the Protocol Plane posts nothing). It posts through
 * the ledger's `feeCharge` recipe, module `token`, under the business charge id `listing:<requestId>`, so the ledger key
 * is `fee:token:listing:<requestId>` (the recipe builds it).
 *
 * Money order (SAGA-1): the request row is written first with the price it will post at (`charging`), then the fee
 * posts, then the row moves to `submitted` with the ledger transaction id. One request per account, chain and token:
 *   - a press while the row is `submitted` returns the stored receipt and posts nothing;
 *   - a press while the row is `charging` (the last attempt crashed or timed out after the row) posts the SAME body
 *     again, so the ledger answers the original transaction if it applied, or applies it once if it did not;
 *   - a refusal for insufficient funds deletes the `charging` row (nothing posted), so the next press is a new attempt.
 * Any other failure keeps the row: the money may have moved, and only the same key may settle it.
 *
 * The price is the owner's: two founders publish it per route. Blank refuses `listing.price_unset` before any row is
 * written, so nothing is charged and nothing is recorded.
 */

export const LISTING_ROUTES = ['express'] as const;
export type ListingRoute = (typeof LISTING_ROUTES)[number];
export const LISTING_STATUSES = ['charging', 'submitted'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_PRICE_PUBLISH_ACTION = 'token.listing_price.publish';
/** The ledger module the fee posts under (svc-ledger's allowlist grants svc-token `feeCharge` with this module). */
export const LISTING_FEE_MODULE = 'token';
export const LISTING_FEE_REASON = 'listing.express_verification';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ASSET = /^[A-Z0-9]{2,12}$/;

export interface ListingPrice {
  route: ListingRoute;
  /** Null while blank. */
  price: Amount | null;
  assetId: string | null;
  /** 0 when never published. */
  revision: number;
}

export interface ListingRequest {
  id: string;
  userId: string;
  chainId: number;
  token: string;
  route: ListingRoute;
  price: Amount;
  assetId: string;
  status: ListingStatus;
  ledgerTxId: string | null;
  createdAt: Date;
}

type RequestRow = {
  id: string;
  user_id: string;
  chain_id: number;
  token_address: string;
  route: ListingRoute;
  price: string;
  asset_id: string;
  status: ListingStatus;
  ledger_tx_id: string | null;
  created_at: Date;
};

const toRequest = (r: RequestRow): ListingRequest => ({
  id: r.id,
  userId: r.user_id,
  chainId: r.chain_id,
  token: r.token_address,
  route: r.route,
  price: parseAmount(r.price),
  assetId: r.asset_id,
  status: r.status,
  ledgerTxId: r.ledger_tx_id,
  createdAt: r.created_at,
});

/** The ledger body one request posts: built only from the stored row, so a retry posts exactly the same body. */
export function listingFeeRequest(row: Pick<ListingRequest, 'id' | 'userId' | 'price' | 'assetId'>) {
  return recipes.feeCharge({
    chargeId: `listing:${row.id}`,
    userId: row.userId,
    module: LISTING_FEE_MODULE,
    reason: LISTING_FEE_REASON,
    mode: 'asset',
    assetId: row.assetId,
    amount: row.price,
  });
}

export function normaliseToken(token: string): string {
  if (!ADDRESS.test(token)) throw new ListingError(`${token} is not a token address`, 'listing.token_invalid');
  return token.toLowerCase();
}

export function isListingRoute(route: string): route is ListingRoute {
  return (LISTING_ROUTES as readonly string[]).includes(route);
}

export class ListingService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly newId: () => string = randomUUID,
  ) {}

  async price(route: ListingRoute, db: Sql = this.sql, { forUpdate = false } = {}): Promise<ListingPrice> {
    const rows = forUpdate
      ? await db<Array<{ price: string | null; asset_id: string | null; revision: number }>>`
          SELECT price::text, asset_id, revision FROM token.listing_prices WHERE route = ${route} FOR UPDATE
        `
      : await db<Array<{ price: string | null; asset_id: string | null; revision: number }>>`
          SELECT price::text, asset_id, revision FROM token.listing_prices WHERE route = ${route}
        `;
    const row = rows[0];
    if (!row) return { route, price: null, assetId: null, revision: 0 };
    return { route, price: row.price === null ? null : parseAmount(row.price), assetId: row.asset_id, revision: row.revision };
  }

  /**
   * Publish one route's price (or blank it), after the router consumed the two founders' approval of exactly this price
   * over exactly `expectedRevision`. Locked, compared and written in one transaction with its numbered move.
   */
  async publishPrice(input: {
    route: ListingRoute;
    price: Amount | null;
    assetId: string | null;
    expectedRevision: number;
    actorId: string;
    approverId: string;
  }): Promise<ListingPrice> {
    if ((input.price === null) !== (input.assetId === null))
      throw new ListingError('A price and its asset are set or blanked together', 'listing.price_invalid');
    if (input.price !== null && input.price <= 0n) throw new ListingError('A listing price is above zero', 'listing.price_invalid');
    if (input.assetId !== null && !ASSET.test(input.assetId))
      throw new ListingError(`${input.assetId} is not a ledger asset id`, 'listing.price_invalid');
    if (input.actorId === input.approverId)
      throw new ListingError('A price is asked for and approved by two people', 'listing.price_invalid');
    return transaction(this.sql, async (tx) => {
      const current = await this.price(input.route, tx as unknown as Sql, { forUpdate: true });
      if (current.revision !== input.expectedRevision) {
        throw new ListingError(
          `expectedRevision ${input.expectedRevision} is stale; the stored price is at ${current.revision}`,
          'listing.price_stale',
        );
      }
      const revision = current.revision + 1;
      const price = input.price === null ? null : formatAmount(input.price);
      await tx`
        INSERT INTO token.listing_prices (route, price, asset_id, revision, updated_at)
        VALUES (${input.route}, ${price}, ${input.assetId}, ${revision}, now())
        ON CONFLICT (route) DO UPDATE SET price = EXCLUDED.price, asset_id = EXCLUDED.asset_id,
          revision = EXCLUDED.revision, updated_at = now()
      `;
      await tx`
        INSERT INTO token.listing_price_moves (route, revision, price, asset_id, actor_id, approver_id)
        VALUES (${input.route}, ${revision}, ${price}, ${input.assetId}, ${input.actorId}, ${input.approverId})
      `;
      return { route: input.route, price: input.price, assetId: input.assetId, revision };
    });
  }

  async requests(input: { userId: string; chainId: number; token: string }): Promise<ListingRequest[]> {
    const token = normaliseToken(input.token);
    const rows = await this.sql<RequestRow[]>`
      SELECT id::text, user_id, chain_id, token_address, route, price::text, asset_id, status, ledger_tx_id, created_at
      FROM token.listing_requests
      WHERE user_id = ${input.userId} AND chain_id = ${input.chainId} AND token_address = ${token}
      ORDER BY created_at DESC
    `;
    return rows.map(toRequest);
  }

  private async find(userId: string, chainId: number, token: string, route: ListingRoute): Promise<ListingRequest | null> {
    const rows = await this.sql<RequestRow[]>`
      SELECT id::text, user_id, chain_id, token_address, route, price::text, asset_id, status, ledger_tx_id, created_at
      FROM token.listing_requests
      WHERE user_id = ${userId} AND chain_id = ${chainId} AND token_address = ${token} AND route = ${route}
    `;
    return rows[0] ? toRequest(rows[0]) : null;
  }

  /**
   * One press of "Request express verification". Returns the request with its receipt; posts the fee at most once.
   */
  async requestExpress(input: { userId: string; chainId: number; token: string }): Promise<ListingRequest> {
    const route: ListingRoute = 'express';
    const token = normaliseToken(input.token);
    if (!Number.isInteger(input.chainId) || input.chainId <= 0)
      throw new ListingError(`${input.chainId} is not a chain id`, 'listing.token_invalid');

    let row = await this.find(input.userId, input.chainId, token, route);
    if (row?.status === 'submitted') return row;

    if (!row) {
      // Blank price: refuse before anything is written, so nothing is charged and nothing is recorded.
      const price = await this.price(route);
      if (price.price === null || price.assetId === null)
        throw new ListingError('The express listing price is not published', 'listing.price_unset');
      // The intent row, before the post. A racing press inserts nothing and reads the winner's row.
      await this.sql`
        INSERT INTO token.listing_requests
          (id, user_id, chain_id, token_address, route, price, asset_id, price_revision, status)
        VALUES (${this.newId()}, ${input.userId}, ${input.chainId}, ${token}, ${route}, ${formatAmount(price.price)},
          ${price.assetId}, ${price.revision}, 'charging')
        ON CONFLICT (user_id, chain_id, token_address, route) DO NOTHING
      `;
      row = await this.find(input.userId, input.chainId, token, route);
      if (!row) throw new ListingError('The request was not recorded; nothing was charged', 'listing.request_missing');
      if (row.status === 'submitted') return row;
    }

    let txId: string;
    try {
      const posted = await this.ledger.post(listingFeeRequest(row));
      txId = posted.txId;
    } catch (err) {
      // Confirmed not applied: the row goes, so the request is as if never pressed. Anything else may have applied
      // under the key, so the row stays and the next press settles it with the same body.
      if (err instanceof InsufficientFundsError) {
        await this.sql`DELETE FROM token.listing_requests WHERE id = ${row.id} AND status = 'charging'`;
      }
      throw err;
    }

    const settled = await this.sql<RequestRow[]>`
      UPDATE token.listing_requests SET status = 'submitted', ledger_tx_id = ${txId}, updated_at = now()
      WHERE id = ${row.id} AND status = 'charging'
      RETURNING id::text, user_id, chain_id, token_address, route, price::text, asset_id, status, ledger_tx_id, created_at
    `;
    if (settled[0]) return toRequest(settled[0]);
    // A racing press settled it first; read what it stored.
    const stored = await this.find(input.userId, input.chainId, token, route);
    if (stored?.status === 'submitted') return stored;
    throw new ListingError(
      `Listing request ${row.id} vanished after its fee posted under fee:token:listing:${row.id}; press again to settle it`,
      'listing.request_missing',
    );
  }
}
