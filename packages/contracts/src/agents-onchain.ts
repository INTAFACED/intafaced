/**
 * THE NAVIGATOR'S ON-CHAIN ACCESS (RC-agents-01) and the trades it makes inside the cap the person signed — what
 * svc-agents `navigator.onchain.*`, `navigator.ask`, `navigator.orders` and `navigator.trading` take and answer. Browser-safe: zod only.
 *
 * svc-agents never moves value and never claims chain state. A binding records only what the person prepared (the
 * session key's scope, cap and expiry, and the scope's hash) and whether they asked to revoke it; whether the key is
 * granted, live, spent or revoked is read from the chain, never from here. Amounts are decimal strings of wei, never a
 * `number`.
 */

import { z } from 'zod';

/** The chain the Navigator may hold a session key on today: the test network, labelled TESTNET. */
export const NAVIGATOR_ONCHAIN_TEST_CHAIN_ID = 84532 as const;
/** A mainnet the Navigator refuses with `audit.external`: no external audit of the smart account exists. */
export const NAVIGATOR_ONCHAIN_MAINNET_CHAIN_IDS = [8453] as const;

/** The refusal codes of the on-chain routes, as the message of their typed error. */
export const NAVIGATOR_ONCHAIN_REFUSALS = [
  'agents.session_key_cap_unset',
  'agents.session_key_expiry_unset',
  'agents.session_key_selector_forbidden',
  'agents.onchain_chain_unsupported',
  'agents.onchain_binding_not_found',
  'rail.crypto',
  'audit.external',
] as const;
export type NavigatorOnchainRefusal = (typeof NAVIGATOR_ONCHAIN_REFUSALS)[number];

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const selector = z.string().regex(/^0x[0-9a-fA-F]{8}$/);
const chainId = z.number().int().positive();

export const navigatorOnchainSignerInputSchema = z.object({ chainId });
/** The Navigator's on-chain signer: a public address only. The key itself is never in this service or this answer. */
export const navigatorOnchainSignerSchema = z.object({
  signer: address,
  chainId,
  network: z.literal('testnet'),
  /**
   * The pools the Navigator trades in (J-agents-19 #4): a grant names them with the router, since the account lets a
   * session key reach only pools in its own targets. Empty when no market is set: the key can then trade nothing.
   */
  pools: z.array(address).max(16),
  /** The router the Navigator trades through, which a grant names; null when no market is set. */
  router: address.nullable(),
});
export type NavigatorOnchainSigner = z.infer<typeof navigatorOnchainSignerSchema>;

/**
 * What the person prepared. The cap and the expiry may arrive blank so the service can refuse them by name
 * (`agents.session_key_cap_unset`, `agents.session_key_expiry_unset`); the session key is never in the body.
 */
export const navigatorOnchainBindInputSchema = z.object({
  chainId,
  account: address,
  specHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  spendLimitWei: z.string().max(80).nullable().optional(),
  validUntil: z.number().int().positive().nullable().optional(),
  targets: z.array(address).min(1).max(16),
  selectors: z.array(selector).min(1).max(32),
});
export type NavigatorOnchainBindInput = z.infer<typeof navigatorOnchainBindInputSchema>;

export const navigatorOnchainBindingSchema = z.object({
  id: z.string().uuid(),
  chainId,
  account: z.string(),
  sessionKey: z.string(),
  /** Wei, as a decimal string. */
  spendLimitWei: z.string().regex(/^\d+$/),
  /** Unix seconds. */
  validUntil: z.number().int(),
  targets: z.array(z.string()),
  selectors: z.array(z.string()),
  specHash: z.string(),
  bindKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When the person asked to revoke it; null while they have not. Never a claim that the chain revoked it. */
  revokeRequestedAt: z.string().nullable(),
});
export type NavigatorOnchainBinding = z.infer<typeof navigatorOnchainBindingSchema>;

export const navigatorOnchainAccountInputSchema = z.object({ chainId, account: address });
export const navigatorOnchainBindingReadSchema = z.object({ binding: navigatorOnchainBindingSchema.nullable() });

/**
 * The words that make an ask a trade (whole words, any case). A person who signed a cap for the Navigator's session key
 * has consented to trades inside it: inside the cap the Navigator does not ask, above it the trade is refused before
 * anything is signed, and it never moves money out (J-agents-19 #4).
 * A question about trading ("where do I place a limit order?") asks for an answer, not a trade, so it goes to the
 * ordinary run, which only answers in words; a request put as a question ("can you buy ...?") is still a trade.
 */
export const NAVIGATOR_TRADE_WORDS = ['swap', 'buy', 'sell', 'trade', 'order'] as const;
const TRADE_RULE = new RegExp(`\\b(?:${NAVIGATOR_TRADE_WORDS.join('|')})\\b`, 'i');
/**
 * An ask to move money out of the person's account: a withdrawal, or a send, transfer or payment to an address. The
 * Navigator never does: such an ask is refused by name before anything is signed, and the session key could not do it
 * anyway (no transfer, approve or permit selector can be granted, and a trade's output always goes back to the account).
 */
const MONEY_OUT_RULE = /\bwithdraw(?:al)?\b|\b(?:send|transfer|pay)\b[^]*\b0x[0-9a-f]{40}\b/i;
const QUESTION = /\?\s*$/;
const REQUEST_AS_QUESTION = /^\s*(?:TEST:\s*)?(?:please\s+)?(?:can|could|would|will)\s+you\b/i;
const isRequest = (text: string) => !QUESTION.test(text) || REQUEST_AS_QUESTION.test(text);
export function navigatorAskIsTrade(text: string): boolean {
  return TRADE_RULE.test(text) && isRequest(text);
}
export function navigatorAskMovesMoneyOut(text: string): boolean {
  return MONEY_OUT_RULE.test(text) && isRequest(text);
}

/** The refusal codes of a trade ask, as the message of the typed error `navigator.ask` answers with. */
export const NAVIGATOR_TRADE_REFUSALS = [
  /** The ask moves money out of the account: the Navigator never does. */
  'agents.navigator_money_out_forbidden',
  /** The trade is above what is left of the cap the person signed. Nothing was signed. */
  'agents.navigator_trade_over_cap',
  /** No live session key: none was granted, it expired, or it is revoked or being revoked. */
  'agents.navigator_no_live_key',
  /** The ask names no amount and pair the Navigator can trade: "swap <amount> <token> for <token>". */
  'agents.navigator_trade_unparsed',
  /** The trade spends a token the cap does not measure: the cap is in TEST ETH, so only wrapped TEST ETH is spent. */
  'agents.navigator_trade_cap_unit',
  /** The pool or the call is not in the scope the key was granted. */
  'agents.navigator_trade_out_of_scope',
  /** No market is configured for the Navigator (router, pools, the token it spends, the slippage bound). */
  'agents.navigator_market_unset',
  /** The pool quotes nothing for this trade, so no minimum out can be set. Nothing was signed. */
  'agents.navigator_trade_unquoted',
] as const;
export type NavigatorTradeRefusal = (typeof NAVIGATOR_TRADE_REFUSALS)[number];

export const navigatorAskInputSchema = z.object({
  sessionId: z.string().uuid(),
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(200_000),
});

/**
 * An order the Navigator sent through its session key: sending (held against the cap, not yet handed to the network),
 * sent (handed over, the chain has not mined it), filled or reverted (as the chain's receipt says), or failed (the
 * network refused it; nothing reached the chain). Sending, sent and filled count against the cap.
 */
export const NAVIGATOR_ORDER_STATUSES = ['sending', 'sent', 'filled', 'reverted', 'failed'] as const;
const wei = z.string().regex(/^\d+$/);
export const navigatorOrderSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  orderKey: z.string(),
  /** Always "assistant": the order was placed by the Navigator, never by the person's own hand. */
  placedBy: z.literal('assistant'),
  text: z.string(),
  chainId,
  account: z.string(),
  pool: z.string(),
  tokenIn: z.string(),
  tokenInSymbol: z.string(),
  tokenOut: z.string(),
  tokenOutSymbol: z.string(),
  /** Wei of the spent token, as a decimal string. */
  amountInWei: wei,
  minOutWei: wei,
  status: z.enum(NAVIGATOR_ORDER_STATUSES),
  txHash: z.string().nullable(),
  createdAt: z.string(),
});
export type NavigatorOrder = z.infer<typeof navigatorOrderSchema>;

export const navigatorAskResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order'), order: navigatorOrderSchema }),
  z.object({ kind: z.literal('none') }),
]);
export type NavigatorAskResult = z.infer<typeof navigatorAskResultSchema>;

export const navigatorOrdersInputSchema = z.object({ sessionId: z.string().uuid() });
export const navigatorOrdersSchema = z.object({ orders: z.array(navigatorOrderSchema) });

/**
 * The Navigator's live key as the person's workspace shows it: the cap they signed, read from the chain, and what the
 * Navigator's orders hold against it. Null when there is no live key.
 */
export const navigatorTradingSchema = z.object({
  key: z
    .object({
      chainId,
      account: z.string(),
      capWei: wei,
      spentWei: wei,
      leftWei: wei,
      validUntil: z.number().int(),
    })
    .nullable(),
});
export type NavigatorTrading = z.infer<typeof navigatorTradingSchema>;
