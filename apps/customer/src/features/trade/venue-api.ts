// hand-declared-ok: svc-trade's user-venue door (/api/v1/venue/*) has no browser-safe zod schema in packages/contracts yet; packages/venue-contracts holds its TypeScript types only, so these schemas follow services/svc-trade/src/venue/user-venue-rest.ts and packages/venue-contracts/src/user-venue.ts field for field
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, formatAmount, parseAmount, signedDecimalSchema } from '../../shared/money';
import type { TypedDataDocument } from '../protocol/wallet/eip1193';

/**
 * The customer's own account on a user-signed venue, through svc-trade's user-venue door (B1). The venue is the record of
 * balances, locks, fills, positions and withdrawals: every figure here is the venue's, with the venue's as-of time, and
 * every Amount is a decimal string. A figure the venue does not publish is `known: false` and is shown as "not known".
 *
 * Prepare → the person's wallet signs → submit. The app keeps nothing but the business key of an action: the door stores
 * the prepared action and its first signature under that key, so a second prepare of the key returns the same action (one
 * wallet prompt), and an answer that is not definite is read back by its client id or nonce, never sent as a new action.
 */

const isoTime = z.string().datetime({ offset: true });
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** A figure the venue may not publish. */
export const maybeKnown = <T extends z.ZodTypeAny>(value: T) =>
  z.union([z.object({ known: z.literal(true), value }), z.object({ known: z.literal(false) })]);
export type MaybeKnown<T> = { known: true; value: T } | { known: false };

const asOf = <T extends z.ZodTypeAny>(value: T) => z.object({ venueId: z.string(), value, asOf: isoTime });
export type AsOf<T> = { venueId: string; value: T; asOf: string };

const refusalSchema = z.object({ venueId: z.string(), code: z.string(), detail: z.string() });
export type VenueRefusal = z.infer<typeof refusalSchema>;

/** `/venue/status`: `{ enabled: false }` when the door is off; else whether the venue answers, and who it is. */
export const venueStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), available: z.literal(false), refusal: z.object({ code: z.string(), detail: z.string() }) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(true),
    venue: z.object({ id: z.string(), displayName: z.string(), proofLevel: z.enum(['simulator', 'partner-sandbox', 'live']) }),
    test: z.boolean(),
    label: z.literal('TEST').optional(),
    chainId: z.number().int().positive().nullable(),
    builder: z.object({ address, feeBps: decimalSchema }).nullable(),
  }),
]);
export type VenueStatus = z.infer<typeof venueStatusSchema>;
export type VenueUp = Extract<VenueStatus, { available: true }>;

const timeInForce = z.enum(['GTC', 'IOC', 'ALO']);
const marginMode = z.enum(['cross', 'isolated']);
export type VenueTimeInForce = z.infer<typeof timeInForce>;
export type VenueMarginMode = z.infer<typeof marginMode>;

export const venueMarketSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  orderTypes: z.array(z.string()),
  timeInForce: z.array(timeInForce),
  marginModes: z.array(marginMode),
  maxLeverageBps: z.number().int().positive().nullable(),
  tickSize: decimalSchema,
  lotSize: decimalSchema,
  makerFeeBps: maybeKnown(signedDecimalSchema),
  takerFeeBps: maybeKnown(signedDecimalSchema),
});
export type VenueMarket = z.infer<typeof venueMarketSchema>;

export const venueBalanceSchema = z.object({ asset: z.string(), free: decimalSchema, locked: decimalSchema, total: decimalSchema });
export type VenueBalance = z.infer<typeof venueBalanceSchema>;

export const venueOrderSchema = z.object({
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.string(),
  timeInForce,
  price: decimalSchema,
  amount: decimalSchema,
  filled: decimalSchema,
  remaining: decimalSchema,
  averagePrice: decimalSchema.nullable(),
  status: z.string(),
  locked: decimalSchema,
  lockedAsset: z.string(),
  reduceOnly: z.boolean(),
});
export type VenueOrder = z.infer<typeof venueOrderSchema>;

export const venueFillSchema = z.object({
  fillId: z.string(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimalSchema,
  amount: decimalSchema,
  role: z.enum(['maker', 'taker']),
  venueFee: signedDecimalSchema,
  builderFee: decimalSchema,
  feeAsset: z.string(),
  realisedPnl: signedDecimalSchema.nullable(),
  filledAt: isoTime,
});
export type VenueFill = z.infer<typeof venueFillSchema>;

export const venuePositionSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  entryPrice: decimalSchema,
  markPrice: decimalSchema,
  unrealisedPnl: signedDecimalSchema,
  marginMode,
  margin: decimalSchema,
  leverageBps: z.number().int().positive(),
  liquidationPrice: maybeKnown(decimalSchema),
});
export type VenuePosition = z.infer<typeof venuePositionSchema>;

export const venueWithdrawalSchema = z.object({
  nonce: z.string(),
  asset: z.string(),
  amount: decimalSchema,
  destination: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  fee: maybeKnown(decimalSchema),
});
export type VenueWithdrawal = z.infer<typeof venueWithdrawalSchema>;

export const venueLeverageSchema = z.object({ symbol: z.string(), leverageBps: z.number().int().positive(), marginMode });
export type VenueLeverage = z.infer<typeof venueLeverageSchema>;

const assetAmount = z.object({ asset: z.string(), amount: signedDecimalSchema });
export const venuePreviewSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  lock: assetAmount,
  role: z.enum(['maker', 'taker']),
  venueFee: maybeKnown(assetAmount),
  builderFee: maybeKnown(assetAmount),
  perpetual: z
    .object({
      leverageBps: z.number().int().positive(),
      marginMode,
      initialMargin: maybeKnown(decimalSchema),
      liquidationPrice: maybeKnown(decimalSchema),
    })
    .nullable(),
});
export type VenuePreview = z.infer<typeof venuePreviewSchema>;

const orderOutcome = z.union([
  z.object({
    definite: z.literal(true),
    accepted: z.literal(true),
    venueRef: z.string().nullable(),
    order: venueOrderSchema.nullable(),
    asOf: isoTime,
  }),
  z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: isoTime }),
  z.object({ definite: z.literal(false), reason: z.enum(['timeout', 'connection_lost', 'venue_error_after_send', 'already_submitted']) }),
]);
export type VenueOutcome = z.infer<typeof orderOutcome>;

/** The wallet's payload, passed through as the door sent it (the venue rebuilds and checks it at submit). */
const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const preparedAnswerSchema = z.object({
  actionKey: z.string(),
  prepared: z.object({
    venueId: z.string(),
    signer: z.object({ role: z.enum(['owner', 'agent']), address: z.string() }),
    nonce: z.string(),
    venueClientOrderId: z.string().nullable(),
    typedData: typedDataSchema,
    digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
  reused: z.boolean(),
  signed: z.boolean(),
  lastOutcome: orderOutcome.nullable(),
});
export type PreparedAnswer = z.infer<typeof preparedAnswerSchema>;

export const submitAnswerSchema = z.object({
  actionKey: z.string(),
  outcome: orderOutcome,
  readBack: z.union([z.object({ venueClientOrderId: z.string() }), z.object({ nonce: z.string() })]).nullable(),
});
export type SubmitAnswer = z.infer<typeof submitAnswerSchema>;

// ── Intents, as the door takes them: every Amount a decimal string ─────────────────────────────────────────────────

export interface OrderIntent {
  kind: 'place_order';
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  amount: string;
  /** A limit's price, or a market order's worst accepted price (its slippage limit). */
  price: string;
  timeInForce: VenueTimeInForce;
  reduceOnly: boolean;
  clientOrderKey: string;
  /** Our builder fee is the door's (the owner value), never the browser's. */
  builderFee: null;
}
export type VenueIntent =
  | OrderIntent
  | { kind: 'cancel_order'; symbol: string; clientOrderKey: string }
  | { kind: 'update_leverage'; symbol: string; leverageBps: number; marginMode: VenueMarginMode }
  | { kind: 'approve_builder_fee'; builder: string; maxFeeBps: string }
  | { kind: 'withdraw'; asset: string; amount: string; destination: string; withdrawalKey: string };

// ── Business keys ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A key part: lowercase, no separators the door's key shape reserves. */
const part = (value: string) => value.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

/**
 * The id of one reviewed draft: minted once when Review is pressed and held for every retry of that draft, so a double
 * press, a lost answer or a reload sends the same client order id. A new draft gets a new one.
 */
export function draftId(now: number = Date.now(), counter: number = 0): string {
  return `${now.toString(36)}${counter.toString(36)}`;
}

export const keys = {
  order: (owner: string, symbol: string, draft: string) => `order:${part(owner)}:${part(symbol)}:${draft}`,
  close: (owner: string, symbol: string, draft: string) => `close:${part(owner)}:${part(symbol)}:${draft}`,
  cancel: (clientOrderKey: string) => `cancel:${clientOrderKey}`,
  leverage: (owner: string, symbol: string, mode: VenueMarginMode, leverageBps: number, draft: string) =>
    `leverage:${part(owner)}:${part(symbol)}:${mode}:${leverageBps}:${draft}`,
  builderApproval: (owner: string, builder: string, maxFeeBps: string) => `builder-approval:${part(owner)}:${part(builder)}:${maxFeeBps}`,
  withdraw: (owner: string, draft: string) => `withdraw:${part(owner)}:${draft}`,
};

// ── Figures ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The canonical decimal a service hashes (`formatAmount`): no trailing zeros, no plus sign. */
export function canonicalDecimal(value: string): string {
  return formatAmount(parseAmount(value.trim()));
}

/** A sum of the venue's own figures; `null` when any of them is not known. */
export function sumKnown(values: ReadonlyArray<MaybeKnown<string>>): string | null {
  let total = 0n;
  for (const v of values) {
    if (!v.known) return null;
    total += parseAmount(v.value);
  }
  return formatAmount(total);
}

export function sumDecimals(values: readonly string[]): string {
  return formatAmount(values.reduce((total, v) => total + parseAmount(v), 0n));
}

/** True when `value` is a whole multiple of `step` (tick or lot), compared exactly. */
export function onStep(value: string, step: string): boolean {
  try {
    const v = parseAmount(value);
    const s = parseAmount(step);
    return s > 0n && v > 0n && v % s === 0n;
  } catch {
    return false;
  }
}

/** `percent` (whole number) of `size`, rounded down to the lot. */
export function partOf(size: string, percent: number, lot: string): string {
  const s = parseAmount(size);
  const l = parseAmount(lot);
  const raw = (s * BigInt(percent)) / 100n;
  return formatAmount(l > 0n ? (raw / l) * l : raw);
}

/** Basis points of 1x, as the venue keeps leverage (`100_000` is 10x). */
export const leverageBpsOf = (times: number) => Math.round(times * 10_000);
export const leverageTimes = (bps: number) => bps / 10_000;

/**
 * The venue's typed data as the wallet signs it. The venue's payload leaves `EIP712Domain` implicit; a wallet request
 * declares it, field for field from the domain in the order EIP-712 hashes them, so the wallet signs the same digest.
 */
export function walletTypedData(typedData: PreparedAnswer['prepared']['typedData']): TypedDataDocument {
  const order = ['name', 'version', 'chainId', 'verifyingContract', 'salt'] as const;
  const kind: Record<(typeof order)[number], string> = {
    name: 'string',
    version: 'string',
    chainId: 'uint256',
    verifyingContract: 'address',
    salt: 'bytes32',
  };
  const domain = typedData.domain;
  const declared = order.filter((name) => domain[name] !== undefined).map((name) => ({ name, type: kind[name] }));
  return {
    types: { EIP712Domain: declared, ...typedData.types },
    primaryType: typedData.primaryType,
    domain: domain as TypedDataDocument['domain'],
    message: typedData.message,
  };
}

// ── The door ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function venueApi(api: ApiClient) {
  const read = <T>(path: string, schema: z.ZodType<T>, query: Record<string, string | undefined>, signal?: AbortSignal) =>
    api.rest(`/venue${path}`, schema, { query, signal });
  const write = <T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<ApiResult<T>> =>
    api.rest(`/venue${path}`, schema, { method: 'POST', body });
  return {
    status: (signal?: AbortSignal) => api.rest('/venue/status', venueStatusSchema, { signal }),
    markets: (signal?: AbortSignal) => read('/markets', asOf(z.array(venueMarketSchema)), {}, signal),
    balances: (owner: string, signal?: AbortSignal) => read('/balances', asOf(z.array(venueBalanceSchema)), { owner }, signal),
    openOrders: (owner: string, signal?: AbortSignal) => read('/orders/open', asOf(z.array(venueOrderSchema)), { owner }, signal),
    orderByClientId: (owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/by-client-id', asOf(venueOrderSchema.nullable()), { owner, clientOrderId }, signal),
    fills: (owner: string, since: string, signal?: AbortSignal) => read('/fills', asOf(z.array(venueFillSchema)), { owner, since }, signal),
    positions: (owner: string, signal?: AbortSignal) => read('/positions', asOf(z.array(venuePositionSchema)), { owner }, signal),
    leverage: (owner: string, symbol: string, signal?: AbortSignal) =>
      read('/leverage', asOf(venueLeverageSchema.nullable()), { owner, symbol }, signal),
    builderFeeApproval: (owner: string, signal?: AbortSignal) => read('/builder-fee-approval', asOf(decimalSchema), { owner }, signal),
    withdrawal: (owner: string, nonce: string, signal?: AbortSignal) =>
      api.rest(`/venue/withdrawals/${encodeURIComponent(nonce)}`, asOf(venueWithdrawalSchema.nullable()), { query: { owner }, signal }),
    preview: (owner: string, intent: OrderIntent) => write('/preview', asOf(venuePreviewSchema), { owner, intent }),
    prepare: (input: { owner: string; intent: VenueIntent; actionKey?: string; stepUpApprovalId?: string | null }) =>
      write('/prepare', preparedAnswerSchema, {
        owner: input.owner,
        signer: { role: 'owner', address: input.owner },
        intent: input.intent,
        actionKey: input.actionKey ?? null,
        stepUpApprovalId: input.stepUpApprovalId ?? null,
      }),
    submit: (actionKey: string, signature: { digest: string; signature: string; signedBy: string }) =>
      write('/submit', submitAnswerSchema, { actionKey, signature }),
  };
}
export type VenueApi = ReturnType<typeof venueApi>;
