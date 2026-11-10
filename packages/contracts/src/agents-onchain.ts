/**
 * THE NAVIGATOR'S ON-CHAIN ACCESS (RC-agents-01) and its trade approvals (AG-approvals-01) — what svc-agents
 * `navigator.onchain.*`, `navigator.ask` and `navigator.approvals` take and answer. Browser-safe: zod only.
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
export const navigatorOnchainSignerSchema = z.object({ signer: address, chainId, network: z.literal('testnet') });
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
 * The words that make an ask a trade (whole words, any case). The Navigator never trades unasked: any ask that names a
 * trade becomes an approval request for the person, and nothing runs. A session key is a ceiling, not consent.
 */
export const NAVIGATOR_TRADE_WORDS = ['swap', 'buy', 'sell', 'trade', 'order'] as const;
const TRADE_RULE = new RegExp(`\\b(?:${NAVIGATOR_TRADE_WORDS.join('|')})\\b`, 'i');
export function navigatorAskIsTrade(text: string): boolean {
  return TRADE_RULE.test(text);
}

export const navigatorAskInputSchema = z.object({
  sessionId: z.string().uuid(),
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(200_000),
});

export const NAVIGATOR_APPROVAL_STATUSES = ['waiting', 'expired'] as const;
export const navigatorApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  requestKey: z.string(),
  tool: z.literal('trade'),
  text: z.string(),
  status: z.enum(NAVIGATOR_APPROVAL_STATUSES),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type NavigatorApprovalRequest = z.infer<typeof navigatorApprovalRequestSchema>;

export const navigatorAskResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    request: navigatorApprovalRequestSchema,
    /** True when the person's Navigator holds a session key binding they have not asked to revoke: it still asks. */
    ceiling: z.boolean(),
  }),
  z.object({ kind: z.literal('none') }),
]);
export type NavigatorAskResult = z.infer<typeof navigatorAskResultSchema>;

export const navigatorApprovalsInputSchema = z.object({ sessionId: z.string().uuid() });
export const navigatorApprovalsSchema = z.object({ requests: z.array(navigatorApprovalRequestSchema) });
