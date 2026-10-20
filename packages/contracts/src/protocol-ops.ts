import { z } from 'zod';

/**
 * Wire types for the Protocol ops desk (D-order-controls-04): metrics, the label audit, and pool and market control.
 *
 * Browser-safe: zod only, so the admin app can import it through `@intafaced/contracts/protocol-ops`.
 *
 * Nothing here has a default magnitude. A count that could not be read is `could_not_load` with the time tried, never zero.
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
  'protocol.ops_source_unavailable',
] as const;
export const protocolOpsRefusalSchema = z.enum(PROTOCOL_OPS_REFUSALS);

// ---------------------------------------------------------------- metrics (founder scope)

/** One reading: a number with the window it covers, or "could not load" with when it was tried. Never a zero for a failure. */
const reading = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), value }),
    z.object({ status: z.literal('could_not_load'), triedAt: z.string().datetime(), code: z.string().min(1) }),
  ]);
const count = z.number().int().min(0);

export const protocolOpsMetricsInputSchema = z
  .object({
    windowSeconds: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 3600)
      .optional(),
  })
  .strict();
export const PROTOCOL_OPS_SECTIONS = ['chain', 'audit', 'indexer', 'dex', 'blockers', 'contracts', 'metrics', 'labels'] as const;
export const protocolOpsMetricsOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    window: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
    quotes: reading(count),
    wallets: reading(count),
    refusalsByCode: reading(z.record(z.string(), count)),
    indexerLagBlocks: reading(count.nullable()),
    sections: z.array(
      z.object({
        section: z.enum(PROTOCOL_OPS_SECTIONS),
        health: z.enum(['ok', 'degraded', 'down', 'unknown']),
        checkedAt: z.string().datetime(),
      }),
    ),
  })
  .strict();
export type ProtocolOpsMetricsOutput = z.infer<typeof protocolOpsMetricsOutputSchema>;

// ---------------------------------------------------------------- label audit (compliance scope)

export const labelEntrySchema = z.object({
  surface: z.enum(['service', 'customer_copy', 'admin_copy']),
  where: z.string().min(1),
  label: z.string(),
  audited: z.boolean(),
});
export type LabelEntry = z.infer<typeof labelEntrySchema>;

const MAINNET_CLAIM = /intachain[\s\S]{0,40}mainnet|mainnet[\s\S]{0,40}intachain/i;
/** PASS only when no entry claims INTACHAIN mainnet and none is audited true. Every offender is listed, never summarised away. */
export function labelVerdict(entries: readonly LabelEntry[]): {
  pass: boolean;
  violations: { where: string; reason: 'claims_mainnet' | 'audited_true' }[];
} {
  const violations: { where: string; reason: 'claims_mainnet' | 'audited_true' }[] = [];
  for (const entry of entries) {
    if (MAINNET_CLAIM.test(entry.label)) violations.push({ where: entry.where, reason: 'claims_mainnet' });
    if (entry.audited) violations.push({ where: entry.where, reason: 'audited_true' });
  }
  return { pass: violations.length === 0, violations };
}
export const protocolOpsLabelsOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    entries: z.array(labelEntrySchema),
    verdict: z.object({
      pass: z.boolean(),
      violations: z.array(z.object({ where: z.string().min(1), reason: z.enum(['claims_mainnet', 'audited_true']) })),
    }),
  })
  .strict();
export type ProtocolOpsLabelsOutput = z.infer<typeof protocolOpsLabelsOutputSchema>;

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
export const protocolOpsPoolHideInputSchema = z.object({ chainId, poolAddress: address, ...decisionFields }).strict();
export const protocolOpsPoolRestoreInputSchema = z
  .object({ chainId, poolAddress: address, approvalId: decisionFields.approvalId })
  .strict();
export const protocolOpsMarketDelistInputSchema = z.object({ symbol, ...decisionFields }).strict();
export const protocolOpsMarketRestoreInputSchema = z.object({ symbol, approvalId: decisionFields.approvalId }).strict();

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
