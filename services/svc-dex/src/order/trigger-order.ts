/**
 * Price-trigger orders (D-limit-dca-02).
 *
 * Edge forwards the wallet session. This process does not issue one, does not
 * call another service, and does not hold a key. The signature is stored for the
 * fill the vault will check; it is not recovered here. Blank owner bounds refuse.
 */

import { z } from 'zod';
import { TRPCError, publicJurisdictionProcedure, router } from '@intafaced/contracts';
import { MoneyError, formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook, RESTING_ORDER_COPY, RATE_COPY, priceOrderHash, type OrderView } from './order-book.js';
import { TriggerOrderRefused, refuseTrigger, triggerOrderCodes, type TriggerOrderCode } from './trigger-error.js';
import { TRIGGER_VARIANTS, minOutForFill, percentString, triggerReached, type TriggerVariant } from './trigger-math.js';
import {
  FEED_UNWIRED_MESSAGE,
  RAIL_UNWIRED_MESSAGE,
  unwiredFillPort,
  unwiredPricePort,
  type FillPort,
  type PricePort,
} from './trigger-ports.js';
import type { TriggerSettings } from './trigger-settings.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/i;
const SIGNATURE = /^0x[0-9a-fA-F]{130,}$/;
const offsetInstant = z.string().datetime({ offset: true });

export const triggerOrderInput = z.object({
  typedOrder: z.object({
    variant: z.string(),
    maker: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountIn: z.string(),
    triggerPrice: z.string(),
    minOut: z.string(),
    expiry: z.string().optional(),
    slippageBps: z.string().optional(),
  }),
  signature: z.string().optional(),
});

export type TriggerOrderInput = z.infer<typeof triggerOrderInput>;

const warningSchema = z.object({
  code: z.string(),
  percentage: z.string().optional(),
  token: z.enum(['in', 'out']).optional(),
});

const notConnectedSchema = z.object({
  code: z.enum(['feed.market', 'rail.crypto']),
  message: z.string(),
});

const sheetSchema = z.object({
  rate: z.literal(RATE_COPY),
  minOut: z.string(),
  resting: z.literal(RESTING_ORDER_COPY),
});

const fillSchema = z.object({
  round: z.number().int(),
  key: z.string(),
  amountIn: z.string(),
  amountOut: z.string(),
  minOut: z.string(),
  txHash: z.string(),
});

const orderViewSchema = z.object({
  orderHash: z.string(),
  state: z.enum(['open', 'executing', 'filled', 'expired']),
  variant: z.enum(['buy_above', 'buy_below', 'sell_above', 'sell_below']),
  maker: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z.string(),
  remaining: z.string(),
  triggerPrice: z.string(),
  minOut: z.string(),
  expiry: z.string(),
  slippageBps: z.number().int(),
  version: z.literal(1),
  fills: z.array(fillSchema),
  pendingFill: z.object({ round: z.number().int(), key: z.string(), txHash: z.string().nullable() }).nullable(),
  sheet: sheetSchema,
});

const assessedSchema = z.object({
  ok: z.literal(true),
  orderHash: z.string(),
  slippageBps: z.number().int(),
  warnings: z.array(warningSchema),
  notConnected: z.array(notConnectedSchema),
  sheet: sheetSchema,
});

const createdSchema = orderViewSchema.extend({
  warnings: z.array(warningSchema),
  notConnected: z.array(notConnectedSchema),
  replayed: z.boolean(),
});

export interface TriggerWarning {
  readonly code: string;
  readonly percentage?: string;
  readonly token?: 'in' | 'out';
}

export interface TriggerNotConnected {
  readonly code: 'feed.market' | 'rail.crypto';
  readonly message: string;
}

export interface TriggerDeps {
  readonly settings: TriggerSettings;
  readonly price: PricePort;
  readonly fill: FillPort;
  readonly book: OrderBook;
  readonly now: () => Date;
}

interface Draft {
  readonly variant: TriggerVariant;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly triggerPrice: bigint;
  readonly minOut: bigint;
  readonly expiry: string;
  readonly slippageBps: number;
  readonly signature: string;
  readonly orderHash: string;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function positive(raw: string | undefined, unset: TriggerOrderCode, invalid: TriggerOrderCode, label: string): bigint {
  if (blank(raw)) refuseTrigger(unset, `${label} is blank; it is not filled in`);
  let parsed: bigint;
  try {
    parsed = parseAmount(raw!.trim());
  } catch (err) {
    if (err instanceof MoneyError) refuseTrigger(invalid, `${label} must be a decimal string with at most 18 decimal places`);
    throw err;
  }
  if (parsed <= 0n) refuseTrigger(invalid, `${label} must be greater than zero`);
  return parsed;
}

function address(raw: string, code: TriggerOrderCode, label: string): string {
  const trimmed = raw.trim();
  if (!ADDRESS.test(trimmed)) refuseTrigger(code, `${label} must be a 20-byte hex address`);
  return trimmed.toLowerCase();
}

function slippageOf(raw: string | undefined, owner: number | undefined): number {
  if (blank(raw)) {
    if (owner === undefined) refuseTrigger(triggerOrderCodes.slippageUnset, 'the slippage default is blank; none is assumed');
    return owner;
  }
  const trimmed = raw!.trim();
  if (!/^\d+$/.test(trimmed)) refuseTrigger(triggerOrderCodes.slippageInvalid, 'slippage is an integer number of basis points');
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n > 10_000) {
    refuseTrigger(triggerOrderCodes.slippageInvalid, 'slippage is an integer from 0 to 10000 basis points');
  }
  if (owner === undefined) refuseTrigger(triggerOrderCodes.slippageUnset, 'the slippage default is blank; none is assumed');
  return n;
}

function expiryOf(raw: string | undefined, now: Date): string {
  if (blank(raw)) refuseTrigger(triggerOrderCodes.expiryRequired, 'a price order needs an expiry; none is preselected');
  const parsed = offsetInstant.safeParse(raw!.trim());
  if (!parsed.success) refuseTrigger(triggerOrderCodes.expiryInvalid, 'expiry is an instant with a timezone offset');
  const ms = Date.parse(parsed.data);
  if (!Number.isFinite(ms)) refuseTrigger(triggerOrderCodes.expiryInvalid, 'expiry is an instant with a timezone offset');
  if (ms <= now.getTime()) refuseTrigger(triggerOrderCodes.expiryInvalid, 'the expiry is not in the future');
  return new Date(ms).toISOString();
}

function variantOf(raw: string): TriggerVariant {
  const trimmed = raw.trim();
  if (!(TRIGGER_VARIANTS as readonly string[]).includes(trimmed)) {
    refuseTrigger(triggerOrderCodes.badRequest, 'variant is buy_above, buy_below, sell_above, or sell_below');
  }
  return trimmed as TriggerVariant;
}

function signatureOf(raw: string | undefined): string {
  if (blank(raw)) refuseTrigger(triggerOrderCodes.signatureRequired, 'the order signature is blank');
  const trimmed = raw!.trim();
  if (!SIGNATURE.test(trimmed) || trimmed.length % 2 !== 0) {
    refuseTrigger(triggerOrderCodes.signatureInvalid, 'the order signature is hex, at least 65 bytes');
  }
  return trimmed;
}

function requirePrincipal(principalUserId: string | null): string {
  if (blank(principalUserId ?? undefined)) {
    refuseTrigger(
      triggerOrderCodes.principalRequired,
      'a trigger order needs the edge-forwarded principal; this service does not issue a session',
    );
  }
  return principalUserId!.trim();
}

async function assess(
  input: TriggerOrderInput,
  deps: TriggerDeps,
  now: Date,
): Promise<{
  draft: Draft;
  warnings: TriggerWarning[];
  notConnected: TriggerNotConnected[];
}> {
  const typed = input.typedOrder;
  const variant = variantOf(typed.variant);
  const maker = address(typed.maker, triggerOrderCodes.makerInvalid, 'the maker');
  const tokenIn = address(typed.tokenIn, triggerOrderCodes.tokenInvalid, 'tokenIn');
  const tokenOut = address(typed.tokenOut, triggerOrderCodes.tokenInvalid, 'tokenOut');
  if (tokenIn === tokenOut) refuseTrigger(triggerOrderCodes.badRequest, 'tokenIn and tokenOut are the same token');
  const amountIn = positive(typed.amountIn, triggerOrderCodes.amountUnset, triggerOrderCodes.amountInvalid, 'the amount');
  const triggerPrice = positive(typed.triggerPrice, triggerOrderCodes.triggerUnset, triggerOrderCodes.triggerInvalid, 'the trigger price');
  const minOut = positive(typed.minOut, triggerOrderCodes.minOutUnset, triggerOrderCodes.minOutInvalid, 'minOut');
  const expiry = expiryOf(typed.expiry, now);
  const signature = signatureOf(input.signature);
  const settings = deps.settings;
  if (settings.minSize === undefined) {
    refuseTrigger(triggerOrderCodes.minSizeUnset, 'the minimum order size is blank; none is invented');
  }
  if (settings.restrictedTokens === undefined) {
    refuseTrigger(triggerOrderCodes.restrictedListUnset, 'the restricted-token list is blank; it is not treated as empty');
  }
  const slippageBps = slippageOf(typed.slippageBps, settings.slippageBps);
  if (amountIn < settings.minSize) {
    refuseTrigger(
      triggerOrderCodes.belowMinSize,
      `the amount ${formatAmount(amountIn)} is below the minimum ${formatAmount(settings.minSize)}`,
    );
  }
  if (settings.restrictedTokens.includes(tokenIn) || settings.restrictedTokens.includes(tokenOut)) {
    refuseTrigger(triggerOrderCodes.restrictedToken, 'this token is on the owner restricted list');
  }

  const warnings: TriggerWarning[] = [];
  const warned = settings.warnTokens ?? [];
  if (warned.includes(tokenIn)) warnings.push({ code: 'dex.order.token_warned', token: 'in' });
  if (warned.includes(tokenOut)) warnings.push({ code: 'dex.order.token_warned', token: 'out' });
  const orderHash = priceOrderHash({ variant, maker, tokenIn, tokenOut, amountIn, triggerPrice, minOut, expiry, slippageBps });

  const notConnected: TriggerNotConnected[] = [];
  const price = await deps.price.read({ tokenIn, tokenOut, at: now });
  if (price.status === 'unwired') {
    notConnected.push({ code: 'feed.market', message: FEED_UNWIRED_MESSAGE });
  } else if (price.status === 'disagree') {
    warnings.push({ code: 'oracle_disagree' });
  } else if (price.status === 'stale') {
    warnings.push({ code: 'oracle_stale' });
  } else if (settings.oracleMaxAgeMs === undefined) {
    warnings.push({ code: triggerOrderCodes.oracleMaxAgeUnset });
  } else {
    const observed = Date.parse(price.observedAt);
    const age = now.getTime() - observed;
    if (!Number.isFinite(observed) || age < 0 || age > settings.oracleMaxAgeMs) {
      warnings.push({ code: 'oracle_stale' });
    } else if (triggerReached(variant, price.price, triggerPrice)) {
      const distance = price.price > triggerPrice ? price.price - triggerPrice : triggerPrice - price.price;
      warnings.push({
        code: 'dex.order.would_fill_immediately',
        percentage: percentString(distance, triggerPrice),
      });
    }
  }

  const quote = await deps.fill.quote({ orderHash, maker, tokenIn, tokenOut, amountIn });
  if (quote.status === 'unwired') {
    notConnected.push({ code: 'rail.crypto', message: RAIL_UNWIRED_MESSAGE });
  } else if (quote.status === 'ok' && quote.take > 0n && quote.take <= amountIn) {
    const floor = minOutForFill(quote.take, amountIn, minOut);
    if (quote.out < floor && floor > 0n) {
      warnings.push({
        code: 'dex.order.uneconomic',
        percentage: percentString(floor - quote.out, floor),
      });
    }
  }

  return {
    draft: { variant, maker, tokenIn, tokenOut, amountIn, triggerPrice, minOut, expiry, slippageBps, signature, orderHash },
    warnings,
    notConnected,
  };
}

function owned(book: OrderBook, orderHash: string, principal: string): OrderView {
  const owner = book.principalOf(orderHash);
  if (!owner || owner !== principal) refuseTrigger(triggerOrderCodes.notFound, 'no such order for this session');
  const view = book.view(orderHash);
  if (!view) refuseTrigger(triggerOrderCodes.notFound, 'no such order for this session');
  return view;
}

export function triggerOrderTrpcError(err: TriggerOrderRefused): TRPCError {
  const code =
    err.code === triggerOrderCodes.principalRequired
      ? 'UNAUTHORIZED'
      : err.code === triggerOrderCodes.notFound
        ? 'NOT_FOUND'
        : err.code === triggerOrderCodes.conflict
          ? 'CONFLICT'
          : err.code.endsWith('_invalid') || err.code === triggerOrderCodes.badRequest || err.code === triggerOrderCodes.signatureRequired
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

function hashShape(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? trimmed : undefined;
}

export function triggerOrderRouter(deps: TriggerDeps) {
  const now = () => deps.now();
  return router({
    validate: publicJurisdictionProcedure('dex', 'protocol')
      .input(triggerOrderInput)
      .output(assessedSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          requirePrincipal(ctx.principal?.userId ?? null);
          const assessed = await assess(input, deps, now());
          return {
            ok: true as const,
            orderHash: assessed.draft.orderHash,
            slippageBps: assessed.draft.slippageBps,
            warnings: assessed.warnings,
            notConnected: assessed.notConnected,
            sheet: { rate: RATE_COPY, minOut: formatAmount(assessed.draft.minOut), resting: RESTING_ORDER_COPY },
          };
        } catch (err) {
          if (err instanceof TriggerOrderRefused) throw triggerOrderTrpcError(err);
          throw err;
        }
      }),

    createTrigger: publicJurisdictionProcedure('dex', 'protocol')
      .input(triggerOrderInput)
      .output(createdSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const principal = requirePrincipal(ctx.principal?.userId ?? null);
          const assessed = await assess(input, deps, now());
          return await deps.book.exclusive(assessed.draft.orderHash, async () => {
            if (deps.book.has(assessed.draft.orderHash)) {
              if (deps.book.principalOf(assessed.draft.orderHash) !== principal) {
                refuseTrigger(triggerOrderCodes.conflict, 'this order is already registered to another session');
              }
              return {
                ...owned(deps.book, assessed.draft.orderHash, principal),
                warnings: assessed.warnings,
                notConnected: assessed.notConnected,
                replayed: true,
              };
            }
            const view = deps.book.insert({ ...assessed.draft, principalUserId: principal });
            return { ...view, warnings: assessed.warnings, notConnected: assessed.notConnected, replayed: false };
          });
        } catch (err) {
          if (err instanceof TriggerOrderRefused) throw triggerOrderTrpcError(err);
          throw err;
        }
      }),

    get: publicJurisdictionProcedure('dex', 'protocol')
      .input(z.object({ orderHash: z.string() }))
      .output(orderViewSchema)
      .query(async ({ input, ctx }) => {
        try {
          const principal = requirePrincipal(ctx.principal?.userId ?? null);
          const hash = hashShape(input.orderHash);
          if (!hash) refuseTrigger(triggerOrderCodes.badRequest, 'orderHash is not a 32-byte hex id');
          return await deps.book.exclusive(hash, async () => owned(deps.book, hash, principal));
        } catch (err) {
          if (err instanceof TriggerOrderRefused) throw triggerOrderTrpcError(err);
          throw err;
        }
      }),

    attempts: publicJurisdictionProcedure('dex', 'protocol')
      .input(z.object({ orderHash: z.string() }))
      .output(
        z.object({
          orderHash: z.string(),
          attempts: z.array(z.object({ key: z.string(), orderHash: z.string(), tick: z.string(), reason: z.string(), at: z.string() })),
        }),
      )
      .query(async ({ input, ctx }) => {
        try {
          const principal = requirePrincipal(ctx.principal?.userId ?? null);
          const hash = hashShape(input.orderHash);
          if (!hash) refuseTrigger(triggerOrderCodes.badRequest, 'orderHash is not a 32-byte hex id');
          return await deps.book.exclusive(hash, async () => {
            owned(deps.book, hash, principal);
            return { orderHash: hash, attempts: [...deps.book.attempts(hash)] };
          });
        } catch (err) {
          if (err instanceof TriggerOrderRefused) throw triggerOrderTrpcError(err);
          throw err;
        }
      }),
  });
}

export function triggerDepsFrom(partial: {
  readonly settings?: TriggerSettings;
  readonly price?: PricePort;
  readonly fill?: FillPort;
  readonly book?: OrderBook;
  readonly now?: () => Date;
}): TriggerDeps {
  return {
    settings: partial.settings ?? {},
    price: partial.price ?? unwiredPricePort,
    fill: partial.fill ?? unwiredFillPort,
    book: partial.book ?? createDefaultBook(),
    now: partial.now ?? (() => new Date()),
  };
}

function createDefaultBook(): OrderBook {
  return new OrderBook();
}
