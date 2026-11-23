import { z } from 'zod';

/**
 * Wire types for the Protocol ops desk (D-order-controls-04): pool and market control.
 *
 * Browser-safe: zod only, so the admin app can import it through `@intafaced/contracts/protocol-ops`.
 *
 * A hide is a LISTING decision, not an on-chain pause: pools have no admin and no pause by design. The four actions are
 * four-eyes approvals consumed through the existing action approval (`action-approval.ts`); this file names them and binds
 * their target ids and idempotency keys so both founders sign the same thing.
 */

/**
 * The hide, delist and restore writes are consumed by svc-ops, which holds identity's four-eyes role. The Protocol Plane
 * holds no platform credential, so svc-protocol and svc-dex only READ the resulting hide list (`protocolOpsHiddenOutputSchema`).
 */
export const PROTOCOL_OPS_TARGET_SERVICE = 'svc-ops' as const;
export const PROTOCOL_OPS_ACTIONS = [
  'protocol.pool.hide',
  'protocol.pool.restore',
  'protocol.market.delist',
  'protocol.market.restore',
] as const;
export type ProtocolOpsAction = (typeof PROTOCOL_OPS_ACTIONS)[number];
export const protocolOpsActionSchema = z.enum(PROTOCOL_OPS_ACTIONS);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const chainId = z.number().int().positive();
const symbol = z.string().min(1).max(64);

/** A pool is named by chain and address; the address is compared lower-cased so one pool has one target id. */
export function poolTargetId(chain: number, poolAddress: string): string {
  return `${chain}:${poolAddress.toLowerCase()}`;
}
export function marketTargetId(marketSymbol: string): string {
  return marketSymbol.trim().toUpperCase();
}
/** `protocol.pool.hide:<chainId>:<poolAddress>:<approvalId>`: a retry with the same approval returns the stored result. */
export function protocolOpsIdempotencyKey(action: ProtocolOpsAction, targetId: string, approvalId: string): string {
  return `${action}:${targetId}:${approvalId}`;
}

/** Every refusal code the ops desk can answer. `owner.decision` is the blank reason-code list. */
export const PROTOCOL_OPS_REFUSALS = [
  'owner.decision',
  'protocol.ops_reason_code_unknown',
  'protocol.ops_target_unknown',
  'protocol.ops_approval_required',
  'action_approval.names_are_not_authority',
] as const;
export const protocolOpsRefusalSchema = z.enum(PROTOCOL_OPS_REFUSALS);

// ---------------------------------------------------------------- pool and market control (four-eyes)

export const listingStateSchema = z.enum(['visible', 'hidden', 'applying']);
export type ListingState = z.infer<typeof listingStateSchema>;
const hidden = z.object({
  reasonCode: z.string().min(1),
  reason: z.string().min(1),
  approvalId: z.string().min(1),
  policyVersion: z.string().min(1),
  at: z.string().datetime(),
});

export const protocolOpsPoolRowSchema = z.object({
  chainId,
  poolAddress: address,
  state: listingStateSchema,
  hidden: hidden.nullable(),
});
export const protocolOpsMarketRowSchema = z.object({ symbol, state: listingStateSchema, hidden: hidden.nullable() });
export const protocolOpsPoolsListOutputSchema = z
  .object({ asOf: z.string().datetime(), pools: z.array(protocolOpsPoolRowSchema) })
  .strict();
export const protocolOpsMarketsListOutputSchema = z
  .object({ asOf: z.string().datetime(), markets: z.array(protocolOpsMarketRowSchema) })
  .strict();

/** The reason is a code from the owner-published list plus free text; the approval id names the second founder's signature. */
const decisionFields = {
  reasonCode: z.string().min(1).max(64),
  reason: z.string().min(1).max(500),
  approvalId: z.string().min(1).max(128),
};
/**
 * The operation id identity issued when the approval was proposed. Consume refuses any other (`target_mismatch`), so the
 * caller carries it from the approval it is spending. It is not the business idempotency key: that is derived from the
 * action, the target and the approval id (`protocolOpsIdempotencyKey`).
 */
const operationId = z.string().min(1).max(128);
export const protocolOpsPoolHideInputSchema = z.object({ chainId, poolAddress: address, ...decisionFields, operationId }).strict();
export const protocolOpsPoolRestoreInputSchema = z
  .object({ chainId, poolAddress: address, approvalId: decisionFields.approvalId, operationId })
  .strict();
export const protocolOpsMarketDelistInputSchema = z.object({ symbol, ...decisionFields, operationId }).strict();
export const protocolOpsMarketRestoreInputSchema = z.object({ symbol, approvalId: decisionFields.approvalId, operationId }).strict();

// ---------------------------------------------------------------- reason codes (admin-editable)

/** A reason code is lower snake case so a list reads the same everywhere and a typo cannot pass as a second code. */
export const PROTOCOL_OPS_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const reasonCode = z.string().regex(PROTOCOL_OPS_REASON_CODE_PATTERN);

/**
 * The reasons a hide or delist may name. `source` says where the list comes from: the built-in default, the deployment's
 * setting, or an admin edit. Every edit is logged with who made it, and a hide checks the list in force at that moment.
 */
export const protocolOpsReasonCodesOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    source: z.enum(['default', 'env', 'admin']),
    codes: z.array(reasonCode).min(1),
    updatedAt: z.string().datetime().nullable(),
    updatedBy: z.string().min(1).nullable(),
  })
  .strict();
export type ProtocolOpsReasonCodesOutput = z.infer<typeof protocolOpsReasonCodesOutputSchema>;

/** The whole new list, replacing the old one. Never empty: a hide with no valid reason would be unusable. */
export const protocolOpsReasonCodesSetInputSchema = z
  .object({
    codes: z
      .array(reasonCode)
      .min(1)
      .max(50)
      .refine((codes) => new Set(codes).size === codes.length, 'reason codes must be unique'),
  })
  .strict();

/**
 * The public hide list: which pools and markets INTAFACED does not list. svc-dex drops them from routing and the default
 * list, svc-protocol shows the "Hidden by INTAFACED" badge. It carries no reason text and no signer; those are the desk's.
 * `asOf` lets a reader refuse a stale list rather than treat a missing entry as visible.
 */
export const protocolOpsHiddenOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    pools: z.array(z.object({ chainId, poolAddress: address }).strict()),
    markets: z.array(z.object({ symbol }).strict()),
  })
  .strict();
export type ProtocolOpsHiddenOutput = z.infer<typeof protocolOpsHiddenOutputSchema>;

/** `noop` is a second approval applied to a target already in that state: it returns the stored result with a note. */
export const protocolOpsActionResultSchema = z
  .object({
    action: protocolOpsActionSchema,
    targetId: z.string().min(1),
    state: listingStateSchema,
    outcome: z.enum(['applied', 'noop']),
    note: z.string().nullable(),
    idempotencyKey: z.string().min(1),
  })
  .strict();
export type ProtocolOpsActionResult = z.infer<typeof protocolOpsActionResultSchema>;
