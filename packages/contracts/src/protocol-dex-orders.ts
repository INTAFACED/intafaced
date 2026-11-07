import { z } from 'zod';

/**
 * Wire types for wallet orders on the Protocol plane (D-limit-dca-01 to -04), version 1: svc-dex's `auth.*` order
 * session and the order vault's orders. The person may be signed out of INTAFACED: what proves they own the orders is a
 * signature from the wallet itself. `auth.challenge` writes an EIP-712 order session (its scope, expiry and the order cap
 * schedule, all shown before the wallet is asked), `auth.verify` checks the wallet signed it and spends its nonce once,
 * and every order call carries the access token it returns. The service reads the maker from the token it issued, never
 * from an address the caller names. Every call is a POST (a tRPC mutation), reads included, so a token travels in a
 * body and never in a URL an access log keeps.
 */
export const PROTOCOL_DEX_ORDERS_CONTRACT_VERSION = 1 as const;

export const DEX_AUTH_REFUSALS = [
  /** The session secret is blank (owner setting): no order session can be written. */
  'dex.auth.session_unset',
  /** The access or refresh lifetime is blank (owner setting). */
  'dex.auth.lifetime_unset',
  /** The challenge was not written by this service, is for another chain or wallet, or has expired. */
  'dex.auth.challenge_invalid',
  /** The challenge was already spent: a signature is good for one session only. */
  'dex.auth.challenge_replayed',
  /** The signature does not recover to the wallet the challenge was written for. */
  'dex.auth.signature_not_owner',
  /** The access or refresh token is missing, altered, expired or revoked: sign a new order session. */
  'dex.auth.unauthenticated',
  /** The token is good but does not reach what was asked (another wallet's order). */
  'dex.auth.forbidden',
] as const;
export type DexAuthRefusal = (typeof DEX_AUTH_REFUSALS)[number];

export const DEX_ORDER_CAP_REFUSALS = [
  /** The order cap schedule is blank (owner setting): no session is written, so no order can be placed. */
  'dex.order.cap_unset',
] as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().regex(/^\d+(\.\d+)?$/);

/** One row of the owner's order cap schedule: the most one session may keep open in orders that sell this token. */
export const dexOrderCapSchema = z.object({ token: address, symbol: z.string().min(1), max: decimal });
export type DexOrderCap = z.infer<typeof dexOrderCapSchema>;

/** The EIP-712 document the wallet signs: the same shape the wallet's `eth_signTypedData_v4` takes. */
export const dexTypedDataSchema = z.object({
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  domain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int() }),
  message: z.record(z.string(), z.unknown()),
});
export type DexTypedData = z.infer<typeof dexTypedDataSchema>;

export const dexAuthChallengeInputSchema = z.object({ address, chainId: z.number().int().positive() });
export const dexAuthChallengeOutputSchema = z.object({
  /** Sealed by the service; handed back with the signature. Not a session. */
  challenge: z.string(),
  typedData: dexTypedDataSchema,
  /** What the signature grants, in words, shown before the wallet prompt. */
  scope: z.string(),
  /** When the session it opens ends (ISO 8601). */
  sessionExpiresAt: z.string(),
  /** The order cap schedule the session is bound to. */
  cap: z.array(dexOrderCapSchema),
  /** When this challenge stops being signable (ISO 8601). */
  challengeExpiresAt: z.string(),
});
export type DexAuthChallenge = z.infer<typeof dexAuthChallengeOutputSchema>;

export const dexAuthVerifyInputSchema = z.object({
  challenge: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export const dexAuthSessionOutputSchema = z.object({
  wallet: address,
  accessToken: z.string(),
  accessExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshExpiresAt: z.string(),
  scope: z.string(),
  cap: z.array(dexOrderCapSchema),
});
export type DexAuthSession = z.infer<typeof dexAuthSessionOutputSchema>;

export const dexAuthRefreshInputSchema = z.object({ refreshToken: z.string().min(1).max(4096) });
export const dexAuthLogoutInputSchema = z.object({ accessToken: z.string().min(1).max(4096) });
export const dexAuthLogoutOutputSchema = z.object({ revoked: z.literal(true), wallet: address });

export const dexOrdersCountInputSchema = z.object({ wallet: address });
/** How many orders a wallet has, in any state: a count only, so a page can say "no orders yet" before a session. */
export const dexOrdersCountOutputSchema = z.object({ wallet: address, count: z.number().int().nonnegative() });

// ── Wallet orders (D-limit-dca-01 to -04) ────────────────────────────────────────────────────────────────────────────

export const DEX_ORDER_REFUSALS = [
  'dex.order.bad_request',
  'dex.order.not_found',
  'dex.order.conflict',
  'dex.internal',
  'dex.order.pair_unset',
  'rail.crypto',
  'dex.order.amount_invalid',
  'dex.order.min_size_unset',
  'dex.order.below_min_size',
  'dex.order.expiry_required',
  'dex.order.expiry_invalid',
  'dex.order.slippage_unset',
  'dex.order.restricted_list_unset',
  'dex.order.restricted_token',
  'dex.order.trigger_invalid',
  'dex.order.tp_not_above_sl',
  'dex.order.tp_not_below_sl',
  'dex.order.trigger_not_allowed_on_trailing',
  'dex.order.trail_bounds_unset',
  'dex.order.trail_out_of_bounds',
  'dex.order.insufficient_credit',
  'dex.order.cap_exceeded',
  'dex.order.draft_expired',
  'dex.order.signature_invalid',
  'dex.order.not_editable',
  'dex.order.not_cancellable',
  'dex.order.nothing_to_sweep',
  'dex.order.nothing_to_withdraw',
  'dex.order.price_unavailable',
] as const;
export type DexOrderRefusal = (typeof DEX_ORDER_REFUSALS)[number];

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const orderIdShape = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const token = z.object({ address, symbol: z.string(), decimals: z.number().int() });
const session = z.string().min(1).max(4096);

/** One call the person's wallet sends: the service builds it, the wallet signs it. */
export const dexUnsignedCallSchema = z.object({ label: z.string(), to: address, data: hex });
export type DexUnsignedCall = z.infer<typeof dexUnsignedCallSchema>;

export const DEX_ORDER_CREATE_KINDS = [
  'sell_above',
  'sell_below',
  'buy_above',
  'buy_below',
  'take_profit_and_stop',
  'bracket',
  'trailing_stop',
] as const;
export const DEX_ORDER_STATES = ['open', 'waiting', 'executing', 'filled', 'cancelled', 'cancelled_by_link', 'expired'] as const;
export type DexOrderState = (typeof DEX_ORDER_STATES)[number];

export const dexVaultInputSchema = z.object({ wallet: address, token: address.optional() });
export const dexVaultOutputSchema = z.object({ vault: address, token, tokens: z.array(token), credit: decimal, strays: decimal });
export const dexDepositInputSchema = z.object({ wallet: address, token: address, amount: z.string().max(64) });
export const dexCallsOutputSchema = z.object({ calls: z.array(dexUnsignedCallSchema) });
export const dexWithdrawOutputSchema = z.object({ amount: decimal, symbol: z.string(), call: dexUnsignedCallSchema });
export const dexSweepInputSchema = z.object({ accessToken: session, token: address.optional() });
export const dexSweepOutputSchema = z.object({
  returned: decimal,
  symbol: z.string(),
  to: address,
  txHash: hex,
  pending: z.boolean().optional(),
});

export const dexOrderPrepareInputSchema = z.object({
  accessToken: session,
  kind: z.enum(DEX_ORDER_CREATE_KINDS),
  side: z.enum(['buy', 'sell']),
  amount: z.string().max(64),
  trigger: z.string().max(64).optional(),
  takeProfit: z.string().max(64).optional(),
  stop: z.string().max(64).optional(),
  trailPercent: z.string().max(16).optional(),
  expiryHours: z.string().max(16).optional(),
});
export const dexOrderPrepareOutputSchema = z.object({
  draftId: z.string(),
  orders: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      typedData: dexTypedDataSchema.extend({ domain: z.record(z.string(), z.unknown()) }),
      minOut: decimal,
      minOutSymbol: z.string(),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), percentage: z.string() })),
  sheet: z.object({ rate: z.string(), resting: z.string() }),
});
export type DexOrderPrepared = z.infer<typeof dexOrderPrepareOutputSchema>;
export const dexOrderCreateInputSchema = z.object({
  accessToken: session,
  draftId: z.string().max(64),
  signatures: z.array(hex).min(1).max(3),
});

export const dexOrderViewSchema = z.object({
  id: orderIdShape,
  kind: z.string(),
  kindName: z.string(),
  side: z.enum(['buy', 'sell']),
  state: z.enum(DEX_ORDER_STATES),
  stateName: z.string(),
  amount: decimal,
  filled: decimal,
  open: decimal,
  baseSymbol: z.string(),
  quoteSymbol: z.string(),
  trigger: z.string().nullable(),
  trailPercent: z.string().nullable(),
  mark: z.string().nullable(),
  minOut: decimal,
  minOutSymbol: z.string(),
  cover: decimal.nullable(),
  version: z.number().int(),
  expiresAt: z.string(),
  createdAt: z.string(),
  editable: z.boolean(),
  cancellable: z.boolean(),
  siblings: z.array(orderIdShape),
  parentId: orderIdShape.nullable(),
  sheet: z.object({ rate: z.string(), resting: z.string() }),
});
export type DexOrderView = z.infer<typeof dexOrderViewSchema>;
export const dexOrderCreateOutputSchema = z.object({ orders: z.array(dexOrderViewSchema) });

export const dexOrderListInputSchema = z.object({
  accessToken: session,
  state: z.enum(DEX_ORDER_STATES).optional(),
  cursor: z.string().max(16).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const dexOrderListOutputSchema = z.object({
  orders: z.array(dexOrderViewSchema),
  total: z.number().int(),
  pageSize: z.number().int(),
  next: z.string().nullable(),
});

export const dexOrderRefInputSchema = z.object({ accessToken: session, id: orderIdShape });
export const dexOrderHistoryOutputSchema = z.object({
  id: orderIdShape,
  events: z.array(
    z.object({
      at: z.string(),
      type: z.string(),
      amountIn: z.string().optional(),
      amountOut: z.string().optional(),
      minOut: z.string().optional(),
      price: z.string().optional(),
      label: z.string().optional(),
      txHash: z.string().optional(),
      version: z.number().int().optional(),
      trigger: z.string().optional(),
    }),
  ),
  attempts: z.array(
    z.object({
      at: z.string(),
      reason: z.string(),
      version: z.number().int(),
      trigger: z.string().optional(),
      price: z.string().optional(),
    }),
  ),
});
export type DexOrderHistory = z.infer<typeof dexOrderHistoryOutputSchema>;

export const dexOrderEditInputSchema = dexOrderRefInputSchema.extend({ trigger: z.string().max(64) });
export const dexOrderEditPreparedSchema = z.object({
  draftId: z.string(),
  typedData: dexTypedDataSchema.extend({ domain: z.record(z.string(), z.unknown()) }),
  version: z.number().int(),
  replaceOnChain: z.boolean(),
  sheet: z.string(),
  call: dexUnsignedCallSchema.nullable(),
});
export const dexOrderUpdateInputSchema = z.object({ accessToken: session, draftId: z.string().max(64), signature: hex });
export const dexOrderCancelOutputSchema = z.object({ order: dexOrderViewSchema, copy: z.string(), calls: z.array(dexUnsignedCallSchema) });

// ── Recurring buys (D-limit-dca-05, J-dex-protocol-11) ─────────────────────────────────────────────────────────────────

/** Codes a recurring buy refuses with, so a person can quote one. */
export const DEX_RECURRING_REFUSALS = [
  'dex.recurring.unwired',
  'dex.recurring.retry_window_unset',
  'dex.recurring.bad_request',
  'dex.recurring.not_found',
  'dex.recurring.not_editable',
  'dex.recurring.closed',
  'dex.recurring.insufficient_balance',
] as const;

export const dexRecurringIntervalSchema = z.enum(['hour', 'day', 'week']);
export type DexRecurringInterval = z.infer<typeof dexRecurringIntervalSchema>;

/** The form's choices: the tokens a plan can spend and buy, the intervals, the retry window and the pair's price. */
export const dexRecurringOptionsInputSchema = z.object({ wallet: address });
export const dexRecurringOptionsOutputSchema = z.object({
  tokens: z.array(token),
  intervals: z.array(dexRecurringIntervalSchema),
  retryWindowSeconds: z.number().int(),
  /** One whole buy token in the spend token ("TEST Token A per TEST Token B"), from the oracle; null when unread. */
  price: decimal.nullable(),
  priceUnit: z.string(),
  /** Idle-deposit yield: off until its owner decision and lending contract exist; the reason names both. */
  idleYield: z.object({ available: z.boolean(), reason: z.string() }),
});

export const dexRecurringPrepareInputSchema = z.object({
  accessToken: session,
  spend: address,
  buy: address,
  amountEachRound: decimal,
  rounds: z.number().int().min(1).max(1000),
  every: dexRecurringIntervalSchema,
  lowestPrice: decimal.optional(),
  highestPrice: decimal.optional(),
});
export const dexRecurringPrepareOutputSchema = z.object({
  total: decimal,
  symbol: z.string(),
  calls: z.array(dexUnsignedCallSchema),
});

export const dexRecurringRoundSchema = z.object({
  n: z.number().int(),
  due: z.string(),
  state: z.enum(['filled', 'scheduled', 'waiting', 'due', 'cancelled']),
  txHash: hex.nullable(),
  amountOut: decimal.nullable(),
});
export const dexRecurringPlanSchema = z.object({
  id: orderIdShape,
  spend: token,
  buy: token,
  amountEachRound: decimal,
  rounds: z.number().int(),
  filled: z.number().int(),
  every: dexRecurringIntervalSchema,
  lowestPrice: decimal.nullable(),
  highestPrice: decimal.nullable(),
  retryWindowSeconds: z.number().int(),
  nextFill: z.string().nullable(),
  state: z.enum(['open', 'done', 'cancelled']),
  refund: decimal.nullable(),
  roundsList: z.array(dexRecurringRoundSchema),
  log: z.array(z.object({ at: z.string(), text: z.string() })),
});
export type DexRecurringPlan = z.infer<typeof dexRecurringPlanSchema>;

/** A plan is public on chain, so its record is read by the wallet's address; only starting one needs the session. */
export const dexRecurringListInputSchema = z.object({
  wallet: address,
  /** True when the page opens: the service first reads the chain by each plan's stored hash and records what it finds. */
  fresh: z.boolean().optional(),
});
export const dexRecurringListOutputSchema = z.object({ plans: z.array(dexRecurringPlanSchema) });

export const dexRecurringRefInputSchema = z.object({ wallet: address, id: orderIdShape });
export const dexRecurringCancelOutputSchema = z.object({ refund: decimal, symbol: z.string(), calls: z.array(dexUnsignedCallSchema) });
