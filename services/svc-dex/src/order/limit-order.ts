import { z } from 'zod';
import { TRPCError, publicJurisdictionProcedure } from '@intafaced/contracts';
import { MoneyError, parseAmount } from '@intafaced/ledger-client/money';

/**
 * Limit orders on svc-dex (D-limit-dca-01).
 *
 * The wallet session is issued by svc-identity. Edge forwards that principal.
 * This process does not issue a nonce, call svc-identity, hold a service key,
 * or store the order. A blank price, size, or window is refused. Nothing here
 * invents a price. A complete order is still not placed (`dex.order.not_placed`).
 */

export const limitOrderCodes = {
  principalRequired: 'dex.order.principal_required',
  symbolUnset: 'dex.order.symbol_unset',
  symbolInvalid: 'dex.order.symbol_invalid',
  priceUnset: 'dex.order.price_unset',
  priceInvalid: 'dex.order.price_invalid',
  sizeUnset: 'dex.order.size_unset',
  sizeInvalid: 'dex.order.size_invalid',
  windowUnset: 'dex.order.window_unset',
  windowInvalid: 'dex.order.window_invalid',
  notPlaced: 'dex.order.not_placed',
} as const;

export type LimitOrderCode = (typeof limitOrderCodes)[keyof typeof limitOrderCodes];

export class LimitOrderRefused extends Error {
  constructor(
    readonly code: LimitOrderCode,
    message: string,
  ) {
    super(message);
    this.name = 'LimitOrderRefused';
  }
}

const SYMBOL_MAX = 64;
const offsetInstant = z.string().datetime({ offset: true });

const windowObject = z.object({
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
});

export const limitOrderInput = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: z.string().optional(),
  size: z.string().optional(),
  /** Live interval. A string is only accepted so a blank is a typed refusal, not a duration we invent. */
  window: z.union([z.string(), windowObject]).optional(),
});

export type LimitOrderInput = z.infer<typeof limitOrderInput>;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function refuse(code: LimitOrderCode, message: string): never {
  throw new LimitOrderRefused(code, message);
}

function positiveAmount(raw: string, unset: LimitOrderCode, invalid: LimitOrderCode, label: string): bigint {
  const trimmed = raw.trim();
  if (trimmed === '') refuse(unset, `${label} is blank; it is not filled in`);
  let parsed: bigint;
  try {
    parsed = parseAmount(trimmed);
  } catch (err) {
    if (err instanceof MoneyError) refuse(invalid, `${label} must be a decimal string with at most 18 decimal places`);
    throw err;
  }
  if (parsed <= 0n) refuse(invalid, `${label} must be greater than zero; zero is not a price or a size this door invents`);
  return parsed;
}

function windowBounds(window: LimitOrderInput['window'], now: Date): { startsAt: string; endsAt: string } {
  if (window === undefined || window === null) {
    refuse(limitOrderCodes.windowUnset, 'the limit window is blank; no duration is assumed');
  }
  if (typeof window === 'string') {
    if (blank(window)) refuse(limitOrderCodes.windowUnset, 'the limit window is blank; no duration is assumed');
    refuse(limitOrderCodes.windowInvalid, 'the limit window is startsAt and endsAt, not a duration');
  }
  if (blank(window.startsAt) || blank(window.endsAt)) {
    refuse(limitOrderCodes.windowUnset, 'the limit window needs both bounds; neither is filled in');
  }
  const startsAt = offsetInstant.safeParse(window.startsAt!.trim());
  const endsAt = offsetInstant.safeParse(window.endsAt!.trim());
  if (!startsAt.success || !endsAt.success) {
    refuse(limitOrderCodes.windowInvalid, 'each window bound is an instant with a timezone offset');
  }
  const startMs = Date.parse(startsAt.data);
  const endMs = Date.parse(endsAt.data);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    refuse(limitOrderCodes.windowInvalid, 'the window ends before it starts');
  }
  if (endMs <= now.getTime()) refuse(limitOrderCodes.windowInvalid, 'the window has already ended');
  return { startsAt: startsAt.data, endsAt: endsAt.data };
}

/**
 * Check the forwarded principal and the order, then refuse placement.
 * Returns `never`: a resolved call would look like an order this service did not place.
 * Price and size are scaled bigint (`parseAmount`); they are not kept as numbers.
 */
export function placeLimitOrder(principalUserId: string | null, input: LimitOrderInput, now: Date): never {
  if (blank(principalUserId ?? undefined)) {
    refuse(limitOrderCodes.principalRequired, 'a limit order needs the edge-forwarded principal; this service does not issue a session');
  }
  const symbol = input.symbol.trim();
  if (symbol === '') refuse(limitOrderCodes.symbolUnset, 'the market symbol is blank');
  if (symbol.length > SYMBOL_MAX) refuse(limitOrderCodes.symbolInvalid, 'the market symbol is longer than 64 characters');
  if (blank(input.price)) refuse(limitOrderCodes.priceUnset, 'the limit price is blank; no price is invented');
  if (blank(input.size)) refuse(limitOrderCodes.sizeUnset, 'the size is blank; no size is invented');
  const price = positiveAmount(input.price!, limitOrderCodes.priceUnset, limitOrderCodes.priceInvalid, 'the limit price');
  const size = positiveAmount(input.size!, limitOrderCodes.sizeUnset, limitOrderCodes.sizeInvalid, 'the size');
  windowBounds(input.window, now);
  // Parsed to scaled bigint and then dropped. A number is never kept, and nothing is stored or sent.
  void price;
  void size;
  refuse(limitOrderCodes.notPlaced, 'svc-dex does not place the order, store it, or call another service');
}

export function limitOrderTrpcError(err: LimitOrderRefused): TRPCError {
  const code =
    err.code === limitOrderCodes.principalRequired
      ? 'UNAUTHORIZED'
      : err.code === limitOrderCodes.notPlaced
        ? 'SERVICE_UNAVAILABLE'
        : err.code.endsWith('_invalid')
          ? 'BAD_REQUEST'
          : 'PRECONDITION_FAILED';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

export function limitOrderProcedure(clock: { now?: () => Date } = {}) {
  return publicJurisdictionProcedure('dex', 'protocol')
    .input(limitOrderInput)
    .mutation(({ input, ctx }) => {
      const now = clock.now?.() ?? new Date();
      try {
        placeLimitOrder(ctx.principal?.userId ?? null, input, now);
      } catch (err) {
        if (err instanceof LimitOrderRefused) throw limitOrderTrpcError(err);
        throw err;
      }
    });
}
