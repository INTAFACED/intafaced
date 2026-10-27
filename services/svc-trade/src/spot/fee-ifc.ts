/**
 * Paying a spot fee in the platform token (RC-cex-spot-11, J-cex-spot-10 #9).
 *
 * An order placed with `feeCurrency` set to the token keeps two things on its row: that choice, and the token discount
 * its owner's stake earned at placement (svc-token `accessOf`, the owner-published decay ladder). The conversion is the
 * owner's own figure in the fee schedule version the order was placed under (`ifcFee.perUnit`): there is no index feed.
 *
 * At each fill, for each leg that chose the token, the fee the leg owes in the asset it receives is worked out as
 * always, converted (floored) and charged with `feeCharge` in token mode BEFORE the fill rows and `tradeFill`; the fill
 * then takes that side's fee as zero in the received asset. So a fill is charged in exactly one currency:
 *
 *   · token charged       → the leg row says fee asset = the token, amount = what was charged.
 *   · token balance short → nothing is charged in the token, the fill takes the fee in the received asset as before, and
 *                           the leg row says why (`trade.fee_ifc_insufficient`). The order never fails on a fee.
 *   · charge refused      → the same, when the ledger refuses this charge itself the same way on every retry
 *                           (`trade.fee_ifc_refused`). A refusal that is not about this charge (a freeze, an outage)
 *                           retries the fill, which the fill post would need anyway.
 *
 * If this crashes exactly here, whose funds are stranded? Nobody's:
 *   · after the token charge and before the rows: a redelivery finds no row, posts the same `fee:trade:ifc:<legId>` key
 *     (the ledger returns the first post) and writes the rows as charged.
 *   · after the rows: a redelivery reads the decision off the row and never charges the token again; the fill post is
 *     keyed as before.
 */
import {
  InsufficientFundsError,
  LedgerError,
  mul,
  mulBps,
  parseAmount,
  recipes,
  sub,
  type Amount,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { IfcFeeTerms } from './fee-schedule.js';
import { TradeError, type OrderRecord } from './types.js';

/** The ledger reason of a fee paid in the token. */
export const IFC_FEE_REASON = 'trade.fill.fee_ifc';

/** Why a leg that chose the token paid in the received asset. Shown on the fill, never an error. */
export type IfcFeeFallback =
  /** The token balance was short when the fill settled. */
  | 'trade.fee_ifc_insufficient'
  /** The maker on this fill earns a rebate paid out of this taker fee, so it stays in the received asset. */
  | 'trade.fee_ifc_rebate_fill'
  /** The fee converts to less than one unit of the token. */
  | 'trade.fee_ifc_dust'
  /** The schedule version the order was placed under names no conversion for this fee asset. */
  | 'trade.fee_ifc_index_unset'
  /** The ledger refused this charge itself (an entry or a grant it will refuse on every retry). */
  | 'trade.fee_ifc_refused';

/** The token discount the owner's stake earns now, in bps off the token fee (svc-token `accessOf`). */
export interface IfcDiscountSource {
  discountBps(userId: string): Promise<number>;
}

/** How long the discount read may take before the order refuses: it sits on the order path. */
const DISCOUNT_READ_MS = 2_000;

/** svc-token's `GET /internal/stake/:userId`, signed as svc-trade. Fails closed: a discount is never invented. */
export function createIfcDiscountSource(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): IfcDiscountSource {
  const url = baseUrl.replace(/\/$/, '');
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-token', legacySecret: internalSecret, s2s });
  return {
    async discountBps(userId: string): Promise<number> {
      const target = `${url}/internal/stake/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'GET',
          signal: AbortSignal.timeout(DISCOUNT_READ_MS),
          headers: {
            'content-type': 'application/json',
            ...authHeaders('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch (err) {
        throw unavailable(`the token discount could not be read: ${(err as Error).message}`);
      }
      const body = (await response.json().catch(() => null)) as { feeDiscountBps?: unknown; message?: unknown } | null;
      if (!response.ok) {
        // svc-token answers a blank decay ladder as `token_params.fee_discount_schedule is unset`.
        const said = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
        throw unavailable(`the token discount could not be read: ${said}`);
      }
      const bps = body?.feeDiscountBps;
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
        throw unavailable('the token discount reply carried no discount');
      }
      return bps;
    },
  };
}

function unavailable(message: string): TradeError {
  return new TradeError(message, 'trade.fee_ifc_discount_unavailable');
}

/** No source wired: every token-fee order refuses, naming why. */
export const UNWIRED_IFC_DISCOUNT: IfcDiscountSource = {
  async discountBps() {
    throw unavailable('paying fees in the token is not wired: svc-token is not configured for svc-trade');
  },
};

/**
 * Whether `feeCurrency` on a new order asks for the token, the asset it receives anyway (nothing to do), or something
 * that cannot be paid. `terms` is the schedule in force now; a blank one refuses a token request by name.
 */
export function ifcFeeChoice(
  feeCurrency: string | undefined,
  received: string,
  terms: IfcFeeTerms | null | undefined,
): { readonly tokenAsset: string } | null {
  if (feeCurrency === undefined) return null;
  const asked = feeCurrency.trim().toUpperCase();
  if (asked === received.toUpperCase()) return null;
  if (!terms) {
    throw new TradeError(
      `fees are taken in ${received}; paying them in ${feeCurrency} needs the owner's token fee terms, which are not set`,
      asked === 'IFC' ? 'trade.fee_currency_ifc_unset' : 'trade.fee_currency_unsupported',
    );
  }
  if (asked !== terms.tokenAsset) {
    throw new TradeError(
      `fees are taken in ${received} or in ${terms.tokenAsset}; there is no paying them in ${feeCurrency}`,
      'trade.fee_currency_unsupported',
    );
  }
  if (terms.perUnit[received] === undefined) {
    throw new TradeError(
      `the owner has not published what one ${received} is worth in ${terms.tokenAsset}, so this fee cannot be paid in it`,
      'trade.fee_ifc_index_unset',
    );
  }
  return { tokenAsset: terms.tokenAsset };
}

/** A new order's token choice as its row keeps it. */
export interface IfcPlacement {
  readonly tokenAsset: string;
  readonly discountBps: number;
}

/**
 * Read once at placement, like the fee tier. Only a person's own spot order pays its fees in the token: an order placed
 * for them (copy trading, an algorithm, an execution child), a sub-account's (its token balance is not theirs), the
 * house market maker's, a paper or a futures order asks only for the asset it receives. The discount is svc-token's
 * answer for the stake now; it fails closed, before anything is held.
 */
export async function ifcFeeAtPlacement(
  feeCurrency: string | undefined,
  received: string,
  ownSpotOrder: boolean,
  terms: () => Promise<IfcFeeTerms | null | undefined>,
  discount: IfcDiscountSource,
  userId: string,
): Promise<IfcPlacement | null> {
  if (feeCurrency === undefined || feeCurrency.trim().toUpperCase() === received.toUpperCase()) return null;
  if (!ownSpotOrder) {
    throw new TradeError(
      `fees on this order are taken in ${received}; only a spot order you place yourself can pay them in ${feeCurrency}`,
      'trade.fee_currency_unsupported',
    );
  }
  const choice = ifcFeeChoice(feeCurrency, received, await terms());
  if (!choice) return null;
  return { tokenAsset: choice.tokenAsset, discountBps: await discount.discountBps(userId) };
}

/** The token a fee converts to, before the stake discount: floored, so the payer never pays a rounding unit more. */
export function ifcGross(fee: Amount, perUnit: string): Amount {
  return mul(fee, parseAmount(perUnit), 'floor');
}

/**
 * What `feeCharge` takes for `gross` at `discountBps` (its rounding: the discount rounds up, in the payer's favour). Used
 * only to tell dust before building the charge, which refuses a zero net; the amount charged is read off the charge.
 */
export function ifcNet(gross: Amount, discountBps: number): Amount {
  return sub(gross, mulBps(gross, discountBps, 'ceil'));
}

export interface IfcLegDecision {
  /** The token charged on this leg (net of the stake discount), or null when the leg paid in its received asset. */
  readonly charged: { readonly tokenAsset: string; readonly net: Amount } | null;
  readonly fallback: IfcFeeFallback | null;
}

export const PAID_IN_RECEIVED: IfcLegDecision = { charged: null, fallback: null };

/** The ledger as one token charge needs it: post, and read a key back when the post is refused for funds. */
export interface IfcLedger {
  post(req: PostRequest): Promise<unknown>;
  getTxByKey(idempotencyKey: string): Promise<unknown | null>;
}

/**
 * Charge one leg's fee in the token, or say why it stays in the received asset. Called before the leg's row exists:
 * a leg already written keeps the decision on its row (`settleIfcLeg` reads it first).
 */
export async function chargeIfcLeg(
  ledger: IfcLedger,
  leg: {
    readonly legId: string;
    readonly userId: string;
    readonly feeAsset: string;
    readonly fee: Amount;
    readonly discountBps: number;
    readonly terms: IfcFeeTerms | null | undefined;
    readonly rebateFill: boolean;
  },
): Promise<IfcLegDecision> {
  if (leg.fee <= 0n) return PAID_IN_RECEIVED;
  if (leg.rebateFill) return { charged: null, fallback: 'trade.fee_ifc_rebate_fill' };
  const perUnit = leg.terms?.perUnit[leg.feeAsset];
  if (!leg.terms || perUnit === undefined) return { charged: null, fallback: 'trade.fee_ifc_index_unset' };
  const gross = ifcGross(leg.fee, perUnit);
  if (ifcNet(gross, leg.discountBps) <= 0n) return { charged: null, fallback: 'trade.fee_ifc_dust' };
  const charge = recipes.feeCharge({
    chargeId: ifcChargeId(leg.legId),
    userId: leg.userId,
    module: 'trade',
    reason: IFC_FEE_REASON,
    mode: 'token',
    tokenAssetId: leg.terms.tokenAsset,
    grossTokenAmount: gross,
    discountBps: leg.discountBps,
  });
  // The amount the charge moves, as the recipe built it.
  const charged = { charged: { tokenAsset: leg.terms.tokenAsset, net: charge.entries[0]!.amount }, fallback: null };
  try {
    await ledger.post(charge);
  } catch (err) {
    const fallback = fallbackFor(err);
    if (fallback === null) throw err;
    // A redelivery whose first attempt was charged posts the same key: the ledger may answer the balance before the
    // key. The key decides, so the token is never charged without the row saying so.
    if (await ledger.getTxByKey(charge.idempotencyKey)) return charged;
    return { charged: null, fallback };
  }
  return charged;
}

/**
 * Ledger refusals of this charge itself, the same on every retry: retrying would hold the counterparty's side of the
 * fill too, so the leg pays in what it receives and says why. Every other failure (a freeze, an outage, a key reused
 * with another body, an unknown code) is not about this charge, and the fill retries.
 */
const REFUSED_CHARGE_CODES = new Set([
  'ledger.invalid_entry',
  'ledger.unbalanced',
  'ledger.owner_identity_space',
  'ledger.caller_forbidden',
]);

function fallbackFor(err: unknown): IfcFeeFallback | null {
  if (err instanceof InsufficientFundsError) return 'trade.fee_ifc_insufficient';
  if (!(err instanceof LedgerError)) return null;
  if (err.code === 'ledger.insufficient_funds') return 'trade.fee_ifc_insufficient';
  return REFUSED_CHARGE_CODES.has(err.code) ? 'trade.fee_ifc_refused' : null;
}

/** `feeCharge` keys on `fee:trade:<chargeId>`: one token charge per fill leg, ever. */
export function ifcChargeId(legId: string): string {
  return `ifc:${legId}`;
}

/** What a written leg row says its order's token choice came to. */
export function ifcDecisionFromRow(
  row: { readonly fee_asset: string; readonly fee_amount: string; readonly fee_fallback?: string | null },
  received: string,
  tokenAsset: string,
): IfcLegDecision {
  if (row.fee_asset === tokenAsset && row.fee_asset !== received) {
    return { charged: { tokenAsset, net: parseAmount(row.fee_amount) }, fallback: null };
  }
  return { charged: null, fallback: (row.fee_fallback ?? null) as IfcFeeFallback | null };
}

/**
 * One fill leg whose order chose the token: decide and write its row under a lock on the leg, so a concurrent settle
 * of the same fill (the inline settle and a redelivery) reads the first one's row and never decides twice. Without the
 * lock one could fall back for funds and the other, after a deposit, charge the token: the fee would be taken twice.
 *
 * A row already there is the decision. A row held by another order is a reused engine sequence: nothing is charged,
 * and writing the row refuses it as before. The row is read and written on the connection that holds the lock.
 */
export async function settleIfcLeg(
  deps: {
    readonly sql: Sql;
    readonly ledger: IfcLedger;
    /** The owner's token terms in the schedule version the order was placed under. */
    readonly termsAt: (at: Date) => Promise<IfcFeeTerms | null>;
  },
  leg: {
    readonly legId: string;
    readonly marketId: string;
    readonly sequence: number;
    readonly role: 'maker' | 'taker';
    readonly order: Pick<OrderRecord, 'id' | 'userId' | 'createdAt' | 'feeCurrency' | 'feeIfcDiscountBps'>;
    readonly feeAsset: string;
    readonly fee: Amount;
    readonly rebateFill: boolean;
  },
  writeRow: (decision: IfcLegDecision, sql: Sql) => Promise<void>,
): Promise<IfcLegDecision> {
  const tokenAsset = leg.order.feeCurrency ?? null;
  if (tokenAsset === null || tokenAsset === leg.feeAsset) return PAID_IN_RECEIVED;
  return withLegLock(deps.sql, `trade.fill_fee_ifc:${leg.legId}`, async (sql) => {
    const [row] = await sql<Array<{ order_id: string; fee_asset: string; fee_amount: string; fee_fallback: string | null }>>`
      SELECT order_id, fee_asset, fee_amount::text AS fee_amount, fee_fallback FROM trade.fills
       WHERE market_id = ${leg.marketId} AND sequence = ${leg.sequence} AND liquidity = ${leg.role}
       LIMIT 1
    `;
    if (row) return row.order_id === leg.order.id ? ifcDecisionFromRow(row, leg.feeAsset, tokenAsset) : PAID_IN_RECEIVED;
    const decision = await chargeIfcLeg(deps.ledger, {
      legId: leg.legId,
      userId: leg.order.userId,
      feeAsset: leg.feeAsset,
      fee: leg.fee,
      discountBps: leg.order.feeIfcDiscountBps ?? 0,
      terms: await deps.termsAt(leg.order.createdAt),
      rebateFill: leg.rebateFill,
    });
    await writeRow(decision, sql);
    return decision;
  });
}

/**
 * A session lock on one reserved connection, and the leg's read and write on that same connection, each committed
 * before the lock goes. Holding the lock on one pool connection while the work waits for another could exhaust the
 * pool when many fills settle at once (follow-store.ts `runFollowExclusive`).
 */
async function withLegLock<T>(sql: Sql, key: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  const connection = await sql.reserve();
  let locked = false;
  try {
    await connection`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    locked = true;
    return await run(connection);
  } finally {
    try {
      if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      connection.release();
    }
  }
}

/** Whether a retry asks for the same fee currency its stored order was placed with. */
export function sameFeeCurrency(stored: string | null | undefined, asked: string | undefined, received: string): boolean {
  const wanted = asked === undefined ? null : asked.trim().toUpperCase();
  return (stored ?? null) === (wanted === null || wanted === received.toUpperCase() ? null : wanted);
}
