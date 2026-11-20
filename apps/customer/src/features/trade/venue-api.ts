import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, formatAmount, parseAmount } from '../../shared/money';
import type { TypedDataDocument } from '../protocol';
import {
  type MaybeKnown,
  asOf,
  venueStatusSchema,
  type VenueTimeInForce,
  type VenueMarginMode,
  venueMarketSchema,
  venueMarketMarginSchema,
  venueScheduledCancelSchema,
  venueStatementJobSchema,
  venueFundingPaymentSchema,
  venueSettlementSchema,
  venueBestPricesReadSchema,
  venueBookReadSchema,
  venueTradesReadSchema,
  venueCandlesReadSchema,
  venueBalanceSchema,
  venueOrderSchema,
  venueHistoryPageSchema,
  type VenueHistoryQuery,
  venueOrderRecordSchema,
  venueOrderPageSchema,
  venueFillSchema,
  venuePositionSchema,
  venueLeverageChangeSchema,
  venueIsolatedMarginSchema,
  venueAccountSummarySchema,
  venueLiquidationSchema,
  venueLiquidationStatusSchema,
  venueInsuranceFundSchema,
  venueAdlDisclosureSchema,
  venueDeleverageSchema,
  venueLiquidationAlertSchema,
  venueWithdrawalSchema,
  venueLeverageSchema,
  venuePublicFeesSchema,
  venueFeeTierSchema,
  venuePreviewSchema,
  marketVenuesSchema,
  routePreviewSchema,
  type VenueOutcome,
  preparedAnswerSchema,
  type PreparedAnswer,
  submitAnswerSchema,
  protectionViewSchema,
  protectionCreatedSchema,
  protectionAgentSchema,
  type ProtectionRequest,
  type SpotOrderKind,
  spotConditionalSchema,
  spotConditionalCreatedSchema,
  venueGatedContractSchema,
  venueEligibleSchema,
  venueBuilderFeeRowSchema,
  agentAccountsReadSchema,
  venueSubAccountSchema,
  venueStatementFileSchema,
  protectionListSchema,
  spotConditionalListSchema,
  spotFeeReviewSchema,
} from '@intafaced/contracts/trade-venue-door';

/** The door's reply schemas live once in contracts; this file keeps the calls and the app's own helpers. */
export * from '@intafaced/contracts/trade-venue-door';

/**
 * The customer's own account on a user-signed venue, through svc-trade's user-venue door (B1). The venue is the record of
 * balances, locks, fills, positions and withdrawals: every figure here is the venue's, with the venue's as-of time, and
 * every Amount is a decimal string. A figure the venue does not publish is `known: false` and is shown as "not known".
 *
 * Prepare → the person's wallet signs → submit. The app keeps nothing but the business key of an action: the door stores
 * the prepared action and its first signature under that key, so a second prepare of the key returns the same action (one
 * wallet prompt), and an answer that is not definite is read back by its client id or nonce, never sent as a new action.
 */

/** The signature this page made for one prepared action, kept in memory only. */
export interface KeptSignature {
  digest: string;
  signature: string;
  signedBy: string;
}

/**
 * What to do with the door's answer to a prepare, given what this page itself knows about the key:
 * - a definite answer already recorded stands (`outcome`);
 * - a signed action with no definite answer is read back (`unknown`) and never sent again, unless this page's own last
 *   submit of it was refused definitely before it was sent (`resend` the same bytes);
 * - an unsigned action another tab or press is prompting for (`reused` and not this page's own prompt) waits for that
 *   prompt; a second press here prompts here (`sign`);
 * - otherwise the wallet signs (`sign`).
 */
export type PreparedStep =
  | { step: 'outcome'; outcome: Extract<VenueOutcome, { definite: true }> }
  | { step: 'unknown' }
  | { step: 'resend'; signature: KeptSignature }
  | { step: 'wait' }
  | { step: 'sign' };

export function preparedStep(
  answer: Pick<PreparedAnswer, 'signed' | 'reused' | 'lastOutcome'>,
  local: { kept: KeptSignature | undefined; refusedBeforeSend: boolean; promptedHere: boolean },
): PreparedStep {
  const last = answer.lastOutcome;
  if (answer.signed) {
    if (last?.definite) return { step: 'outcome', outcome: last };
    if (!last && local.kept && local.refusedBeforeSend) return { step: 'resend', signature: local.kept };
    return { step: 'unknown' };
  }
  if (answer.reused && !local.promptedHere) return { step: 'wait' };
  return { step: 'sign' };
}

// ── A position's protections (J-derivatives-03; svc-trade src/venue/protections.ts) ─────────────────────────────

/** One conditional spot order: only the price fields its kind takes are sent. Amounts are decimal strings. */
export interface SpotConditionalRequest {
  owner: string;
  symbol: string;
  kind: SpotOrderKind;
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice?: string;
  limitPrice?: string;
  takeProfitPrice?: string;
  entryPrice?: string;
  entryTif?: 'GTC' | 'IOC';
  closePrice?: string;
  /** A good-till-date order's expiry, an ISO time (J-cex-spot-03 #7). */
  expireAt?: string;
  clientOrderId: string;
}

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
  // Orders the venue takes in one signed action (J-derivatives-03 #9), each keyed `<actionKey>:<part>`.
  | { kind: 'place_orders'; actionKey: string; orders: OrderIntent[] }
  | { kind: 'cancel_order'; symbol: string; clientOrderKey: string }
  // J-cex-spot-05: a resting order lowered in place, replaced in one signed action, or several cancelled in one, each
  // named by the venue's own client id, so an order placed from any page can be changed.
  | { kind: 'amend_order'; symbol: string; venueClientOrderId: string; amount: string; price: string }
  | { kind: 'replace_order'; symbol: string; venueClientOrderId: string; order: OrderIntent }
  | { kind: 'cancel_orders'; orders: Array<{ symbol: string; venueClientOrderId: string }> }
  // J-cex-spot-07: the venue's own scheduled cancel; the door times it from now (`time` is set there), timeout 0 removes it.
  | { kind: 'schedule_cancel'; timeoutSec: number; time: null }
  | { kind: 'update_leverage'; symbol: string; leverageBps: number; marginMode: VenueMarginMode }
  | { kind: 'approve_builder_fee'; builder: string; maxFeeBps: string }
  | { kind: 'withdraw'; asset: string; amount: string; destination: string; withdrawalKey: string }
  // The person's own sub-account (J-portfolio-04 #2): opened and moved into, each signed on the main account.
  | { kind: 'create_sub_account'; name: string; subAccountKey: string }
  | {
      kind: 'sub_account_transfer';
      subAccount: string;
      direction: 'into_sub_account' | 'out_of_sub_account';
      asset: string;
      amount: string;
      moveKey: string;
    }
  | {
      kind: 'market_margin_transfer';
      symbol: string;
      direction: 'into_market' | 'out_of_market';
      asset: string;
      amount: string;
      moveKey: string;
    }
  // J-derivatives-06 #2 #3: margin added to or removed from an open isolated position, one signed venue change.
  | { kind: 'update_isolated_margin'; symbol: string; direction: 'add' | 'remove'; amount: string; changeKey: string };

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
  /** One reverse of a position: its close is `<key>:close` and its open `<key>:open`, each under the one reverse key. */
  reverse: (owner: string, draft: string) => `order:${part(owner)}:reverse:${draft}`,
  /** The person's own sub-account, by its name: a second press opens the same one (user-venue-door.ts OWN_SUB_ACCOUNT_PREFIX). */
  ownSubAccount: (owner: string, name: string) => `own:sub-account:${part(owner)}:${part(name.trim())}`,
  /** One move between the main account and an own sub-account, by its reviewed draft (OWN_MOVE_PREFIX). */
  ownMove: (owner: string, draft: string) => `own:move:${part(owner)}:${draft}`,
  leverage: (owner: string, symbol: string, mode: VenueMarginMode, leverageBps: number, draft: string) =>
    `leverage:${part(owner)}:${part(symbol)}:${mode}:${leverageBps}:${draft}`,
  builderApproval: (owner: string, builder: string, maxFeeBps: string, venueId?: string) =>
    venueId
      ? `builder-approval:${part(owner)}:${part(venueId)}:${part(builder)}:${maxFeeBps}`
      : `builder-approval:${part(owner)}:${part(builder)}:${maxFeeBps}`,
  withdraw: (owner: string, draft: string) => `withdraw:${part(owner)}:${draft}`,
  /** One lowering of a resting order, by the venue's client id and the amount left: the same change asked twice is one. */
  amend: (owner: string, venueClientOrderId: string, amount: string) =>
    `amend:${part(owner)}:${part(venueClientOrderId)}:${canonicalDecimal(amount)}`,
  /** One reviewed cancel-and-replace; its replacement is placed under `<key>:new`'s own client id. */
  replace: (owner: string, draft: string) => `replace:${part(owner)}:${draft}`,
  replacement: (owner: string, symbol: string, draft: string) => `order:${part(owner)}:${part(symbol)}:replace-${draft}`,
  /** One confirmed batch cancel. */
  cancelBatch: (owner: string, draft: string) => `cancel-batch:${part(owner)}:${draft}`,
  /** One press of the dead-man switch: arming, refreshing or removing the venue's scheduled cancel (J-cex-spot-07). */
  scheduleCancel: (owner: string, draft: string) => `schedule-cancel:${part(owner)}:${draft}`,
  /** One reviewed margin change on an isolated position (J-derivatives-06 #2 #3). */
  isolatedMargin: (owner: string, symbol: string, direction: 'add' | 'remove', draft: string) =>
    `margin:${part(owner)}:${part(symbol)}:${direction}:${draft}`,
  marketMargin: (owner: string, symbol: string, direction: 'into_market' | 'out_of_market', draft: string) =>
    `market-margin:${part(owner)}:${part(symbol)}:${direction === 'into_market' ? 'in' : 'out'}:${draft}`,
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
    markets: (signal?: AbortSignal, venueId?: string) => read('/markets', asOf(z.array(venueMarketSchema)), { venueId }, signal),
    bestPrices: (symbol: string, signal?: AbortSignal) => read('/best-prices', venueBestPricesReadSchema, { symbol }, signal),
    book: (symbol: string, depth: number, signal?: AbortSignal) =>
      read('/book', venueBookReadSchema, { symbol, depth: String(depth) }, signal),
    trades: (symbol: string, limit: number, signal?: AbortSignal) =>
      read('/trades', venueTradesReadSchema, { symbol, limit: String(limit) }, signal),
    candles: (symbol: string, interval: string, limit: number, signal?: AbortSignal) =>
      read('/candles', venueCandlesReadSchema, { symbol, interval, limit: String(limit) }, signal),
    gatedList: (signal?: AbortSignal) => read('/gated-list', asOf(z.array(venueGatedContractSchema)), {}, signal),
    balances: (owner: string, signal?: AbortSignal, subAccount?: string, venueId?: string) =>
      read('/balances', asOf(z.array(venueBalanceSchema)), { owner, subAccount, venueId }, signal),
    openOrders: (owner: string, signal?: AbortSignal) => read('/orders/open', asOf(z.array(venueOrderSchema)), { owner }, signal),
    /** The orders this person's door kept on the owner's accounts, oldest first, a page at a time (J-agents-21 #7). */
    keptOrders: (owner: string, cursor?: string, signal?: AbortSignal) => read('/orders', venueOrderPageSchema, { owner, cursor }, signal),
    /** The person's agent accounts, each with its owner wallet and venue sub-account (J-agents-21). */
    agentAccounts: (signal?: AbortSignal) => read('/agent-accounts', agentAccountsReadSchema, {}, signal),
    /** The account's orders in every state as the venue keeps them, filtered and a page at a time (J-cex-spot-06 #1). */
    orderHistory: (owner: string, query: VenueHistoryQuery, signal?: AbortSignal) =>
      read('/orders/history', venueHistoryPageSchema, { owner, ...query }, signal),
    /** Our record of one order: amendments the venue accepted, and our builder fee on it (J-cex-spot-06 #5 #10). */
    orderRecord: (owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/record', venueOrderRecordSchema, { owner, clientOrderId }, signal),
    orderByClientId: (owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/by-client-id', asOf(venueOrderSchema.nullable()), { owner, clientOrderId }, signal),
    fills: (owner: string, since: string, signal?: AbortSignal, at: { venueId?: string; subAccount?: string } = {}) =>
      read('/fills', asOf(z.array(venueFillSchema)), { owner, since, ...at }, signal),
    /** The positions on one account: the main account, or one of the owner's sub-accounts, on a venue (J-derivatives-05). */
    positions: (owner: string, signal?: AbortSignal, at: { venueId?: string; subAccount?: string } = {}) =>
      read('/positions', asOf(z.array(venuePositionSchema)), { owner, ...at }, signal),
    /** The owner's own sub-accounts, as the venue lists them on the main account (J-agents-08 #2). */
    subAccounts: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/sub-accounts', asOf(z.array(venueSubAccountSchema)), { owner, venueId }, signal),
    /** What a leverage change would do to the open position's margin, read before anything is signed (J-derivatives-05 #4). */
    leverageChange: (
      owner: string,
      q: { symbol: string; leverageBps: number; marginMode: VenueMarginMode; venueId?: string },
      signal?: AbortSignal,
    ) =>
      read(
        '/leverage-change',
        asOf(venueLeverageChangeSchema),
        { owner, symbol: q.symbol, leverageBps: String(q.leverageBps), marginMode: q.marginMode, venueId: q.venueId },
        signal,
      ),
    /** An open isolated position's margin and the venue's removal limit, read before anything is signed (J-derivatives-06 #2 #3). */
    isolatedMargin: (owner: string, q: { symbol: string; venueId?: string }, signal?: AbortSignal) =>
      read('/isolated-margin', asOf(venueIsolatedMarginSchema), { owner, symbol: q.symbol, venueId: q.venueId }, signal),
    /** The account's equity, free, used margin, maintenance and margin ratio as the venue reports them (J-derivatives-06 #1). */
    accountSummary: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/account-summary', asOf(venueAccountSummarySchema), { owner, venueId }, signal),
    /** The position's liquidation state on one market and the venue's rules (J-derivatives-07 #1 #3). */
    liquidation: (owner: string, q: { symbol: string; venueId?: string }, signal?: AbortSignal) =>
      read('/liquidation', asOf(venueLiquidationStatusSchema), { owner, symbol: q.symbol, venueId: q.venueId }, signal),
    /** Each liquidation the venue reports on the account, every part listed (J-derivatives-07 #2). */
    liquidations: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/liquidations', asOf(z.array(venueLiquidationSchema)), { owner, venueId }, signal),
    /** Each auto-deleveraging of the account's positions, with the venue's notice (J-derivatives-07 #6). */
    deleverages: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/deleverages', asOf(z.array(venueDeleverageSchema)), { owner, venueId }, signal),
    /** The venue's insurance fund, or not published; signed in or not (J-derivatives-07 #4). */
    insuranceFund: (signal?: AbortSignal, venueId?: string) => read('/insurance-fund', venueInsuranceFundSchema, { venueId }, signal),
    /** The venue's public liquidation and auto-deleveraging alerts, newest first (J-derivatives-07 #7). */
    liquidationAlerts: (q: { symbol?: string; limit?: number; venueId?: string }, signal?: AbortSignal) =>
      read(
        '/liquidation-alerts',
        asOf(z.array(venueLiquidationAlertSchema)),
        { symbol: q.symbol, limit: q.limit === undefined ? undefined : String(q.limit), venueId: q.venueId },
        signal,
      ),
    /** The venue's auto-deleveraging rules and whether this person acknowledged their version (J-derivatives-07 #5). */
    adlDisclosure: (signal?: AbortSignal, venueId?: string) => read('/adl-disclosure', venueAdlDisclosureSchema, { venueId }, signal),
    /** "I have read this": stores the version read; a version the venue replaced is refused. */
    acknowledgeAdl: (version: string, venueId?: string) =>
      write('/adl-disclosure/ack', venueAdlDisclosureSchema, { version, ...(venueId ? { venueId } : {}) }),
    /** The owner's balance in the margin account a market's deployer keeps for it (J-derivatives-27 #7). */
    marketMargin: (owner: string, symbol: string, signal?: AbortSignal) =>
      read('/market-margin', asOf(venueMarketMarginSchema), { owner, symbol }, signal),
    /** The owner's settlements in a deployer's halt or a split since `since` (J-derivatives-27 #9 #10). */
    settlements: (owner: string, since: string, signal?: AbortSignal) =>
      read('/settlements', asOf(z.array(venueSettlementSchema)), { owner, since }, signal),
    /** The funding the venue charged or paid on the owner's positions since `since` (J-derivatives-08 #3 #4 #5). */
    fundingPayments: (owner: string, since: string, signal?: AbortSignal, venueId?: string) =>
      read('/funding-payments', asOf(z.array(venueFundingPaymentSchema)), { owner, since, venueId }, signal),
    /** Our builder fee on each fill of the person's own orders on the account, with its ledger transaction (J-derivatives-12 #4). */
    builderFees: (owner: string, since: string, signal?: AbortSignal, venueId?: string) =>
      read('/builder-fees', asOf(z.array(venueBuilderFeeRowSchema)), { owner, since, venueId }, signal),
    /** The perpetuals this account is eligible for, each with its settle asset, or none with the reason (J-derivatives-12 #5). */
    eligibleInstruments: (signal?: AbortSignal, venueId?: string) =>
      read('/eligible-instruments', asOf(venueEligibleSchema), { venueId }, signal),
    /** The venue's scheduled cancel on the owner's account: when it cancels, and when it last did (J-cex-spot-07). */
    scheduledCancel: (owner: string, signal?: AbortSignal) =>
      read('/scheduled-cancel', asOf(venueScheduledCancelSchema), { owner }, signal),
    /** The statement job for this request key: created once and built once from the venue's own records (J-cex-spot-07 #5). */
    statement: (input: { owner: string; from: string; to: string; requestKey: string }) =>
      write('/statements', venueStatementJobSchema, input),
    statementFile: (id: string) => api.rest(`/venue/statements/${encodeURIComponent(id)}/file`, venueStatementFileSchema, {}),
    leverage: (owner: string, symbol: string, signal?: AbortSignal, venueId?: string) =>
      read('/leverage', asOf(venueLeverageSchema.nullable()), { owner, symbol, venueId }, signal),
    builderFeeApproval: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/builder-fee-approval', asOf(decimalSchema), { owner, venueId }, signal),
    /** The venue's published fees, its builder-fee caps and ours, signed in or not (J-cex-spot-10 #2). */
    publicFees: (signal?: AbortSignal, venueId?: string) => read('/fees', venuePublicFeesSchema, { venueId }, signal),
    /** The owner's own fee tier as the venue reports it (J-cex-spot-10 #6). */
    feeTier: (owner: string, signal?: AbortSignal, venueId?: string) => read('/fee-tier', venueFeeTierSchema, { owner, venueId }, signal),
    marketVenues: (symbol: string, owner: string, side: 'buy' | 'sell', signal?: AbortSignal) =>
      api.rest(`/venue/markets/${encodeURIComponent(symbol)}/venues`, marketVenuesSchema, { query: { owner, side }, signal }),
    routePreview: (owner: string, intent: OrderIntent) => write('/route-preview', routePreviewSchema, { owner, intent }),
    ordersByClientIdOn: (venueId: string, owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/by-client-id', asOf(venueOrderSchema.nullable()), { owner, clientOrderId, venueId }, signal),
    withdrawal: (owner: string, nonce: string, signal?: AbortSignal) =>
      api.rest(`/venue/withdrawals/${encodeURIComponent(nonce)}`, asOf(venueWithdrawalSchema.nullable()), { query: { owner }, signal }),
    preview: (owner: string, intent: OrderIntent) => write('/preview', asOf(venuePreviewSchema), { owner, intent }),
    prepare: (input: {
      owner: string;
      /** One of the person's own sub-accounts under `owner`, which the wallet signs for as its owner; omitted is the main account. */
      subAccount?: string | null;
      intent: VenueIntent;
      actionKey?: string;
      stepUpApprovalId?: string | null;
      venueId?: string;
    }) =>
      write('/prepare', preparedAnswerSchema, {
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.subAccount ? { subAccount: input.subAccount } : {}),
        owner: input.owner,
        signer: { role: 'owner', address: input.owner },
        intent: input.intent,
        actionKey: input.actionKey ?? null,
        stepUpApprovalId: input.stepUpApprovalId ?? null,
      }),
    submit: (actionKey: string, signature: { digest: string; signature: string; signedBy: string }) =>
      write('/submit', submitAnswerSchema, { actionKey, signature }),
    /** The person's protections: the venue's trigger orders our door sent and our engine's stops (J-derivatives-03). */
    protections: (owner: string, signal?: AbortSignal) => read('/protections', protectionListSchema, { owner }, signal),
    createProtection: (input: ProtectionRequest) => write('/protections', protectionCreatedSchema, input),
    cancelProtection: (id: string) => api.rest(`/venue/protections/${encodeURIComponent(id)}`, protectionViewSchema, { method: 'DELETE' }),
    protectionAgent: (owner: string, signal?: AbortSignal) => read('/protection-agent', protectionAgentSchema, { owner }, signal),
    prepareProtectionAgent: (owner: string) => write('/protection-agent/prepare', preparedAnswerSchema, { owner }),
    /** The person's conditional spot orders: stops, OCOs, brackets and linked closes (J-cex-spot-08). */
    spotOrders: (owner: string, signal?: AbortSignal) => read('/spot-orders', spotConditionalListSchema, { owner }, signal),
    createSpotOrder: (input: SpotConditionalRequest) => write('/spot-orders', spotConditionalCreatedSchema, input),
    reviewSpotOrder: (input: SpotConditionalRequest) => write('/spot-orders/review', spotFeeReviewSchema, input),
    modifySpotOrder: (id: string, body: { triggerPrice: string; limitPrice?: string }) =>
      api.rest(`/venue/spot-orders/${encodeURIComponent(id)}`, spotConditionalSchema, { method: 'PATCH', body }),
    cancelSpotOrder: (id: string) => api.rest(`/venue/spot-orders/${encodeURIComponent(id)}`, spotConditionalSchema, { method: 'DELETE' }),
    spotAgent: (owner: string, signal?: AbortSignal) => read('/spot-agent', protectionAgentSchema, { owner }, signal),
    prepareSpotAgent: (owner: string) => write('/spot-agent/prepare', preparedAnswerSchema, { owner }),
  };
}
export type VenueApi = ReturnType<typeof venueApi>;
