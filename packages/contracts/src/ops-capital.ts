import { z } from 'zod';

/**
 * THE CAPITAL MONITOR (RC-ops-console-06, J-ops-console-24 #1): INTAFACED's own funds beside its buffer thresholds.
 *
 * Four sources, each named on every figure, and none turned into a zero when it cannot be read:
 *   · INTAFACED's own funds, from svc-ledger's `ownFunds` read: house and module accounts only. Every account that holds a
 *     customer's money (`isCustomerBalanceAccount` in `packages/ledger-client/src/custody-layer.ts`) is left out in the
 *     ledger's query, so customer money is never counted as ours (OWNER 226), and so are the pots holding someone else's
 *     money outside that split (a confirmed staff hold, a locked campaign reward, the futures clearing pot). Treasury
 *     boundary accounts are the outside world's side of a rail, not funds, and the burn account holds tokens out of supply.
 *   · The builder account at each venue, as the venue reports it with its as-of time, beside the venue's published minimum
 *     for collecting builder fees, or "not published". Until a venue adapter reports one to svc-ops, the part says
 *     `ops.capital.venue_not_connected`.
 *   · Any reserve a partner holds of ours, as svc-bank's partner adapters report it: an amount, none, or "not known",
 *     never zero.
 *   · The buffer thresholds founders set, one per asset, with a second founder's approval. A blank threshold is
 *     `ops.capital.threshold_unset` and "not monitored", never "ok". A buffer below a set minimum opens one breach alert per
 *     asset and UTC day (`capital-breach:{asset}:{day}`), escalated to the contact the threshold names.
 *
 * Nothing here moves money: no ledger-client recipe is called and no entry is assembled.
 *
 * Browser-safe: zod only.
 */

export const OPS_CAPITAL_THRESHOLD_UNSET = 'ops.capital.threshold_unset' as const;
export const OPS_CAPITAL_SOURCE_UNAVAILABLE = 'ops.capital.source_unavailable' as const;
export const OPS_CAPITAL_SCENARIO_INPUT_MISSING = 'ops.capital.scenario_input_missing' as const;
export const OPS_CAPITAL_VENUE_NOT_CONNECTED = 'ops.capital.venue_not_connected' as const;
export const OPS_CAPITAL_THRESHOLD_INVALID = 'ops.capital.threshold_invalid' as const;
export const OPS_CAPITAL_STORAGE_UNCONFIGURED = 'ops.capital.storage_unconfigured' as const;

/** The two-founder action that sets or clears one asset's minimum buffer. */
export const OPS_CAPITAL_THRESHOLD_ACTION = 'ops.capital.threshold.set' as const;
export const OPS_CAPITAL_TARGET_SERVICE = 'svc-ops' as const;

const decimal = /^\d+(\.\d{1,18})?$/;
const signedDecimal = /^-?\d+(\.\d{1,18})?$/;
export const OPS_CAPITAL_ASSET = /^[A-Z0-9]{2,16}$/;
/** A minimum as a founder may type it: no leading zeros, at most 20 whole digits and 18 decimals (numeric(38,18)). */
export const OPS_CAPITAL_MINIMUM = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
export const OPS_CAPITAL_CONTACT_MAX = 200;

// ── svc-ledger's `ownFunds` read (svc-ops alone) ─────────────────────────────

export const ledgerOwnFundsAccountSchema = z.object({
  ownerType: z.enum(['house', 'module']),
  ownerId: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.string().min(1),
  purpose: z.string(),
  /** The account's balance now, as the ledger holds it. Decimal string, never negative (house and module pots are hard non-negative). */
  balance: z.string().regex(decimal),
});
export type LedgerOwnFundsAccount = z.infer<typeof ledgerOwnFundsAccountSchema>;

export const ledgerOwnFundsSchema = z.object({
  /** When the ledger read its balances, in one snapshot. */
  asOf: z.string().datetime({ offset: true }),
  /** Every house and module account with a balance, customer money left out. An account at zero is absent. */
  accounts: z.array(ledgerOwnFundsAccountSchema),
});
export type LedgerOwnFunds = z.infer<typeof ledgerOwnFundsSchema>;

// ── The snapshot ─────────────────────────────────────────────────────────────

const unknownPart = z.object({ status: z.literal('unknown'), code: z.string().min(1), message: z.string().min(1) });

export const opsCapitalOwnFundsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('read'),
    asOf: z.string(),
    /** Per asset: the sum over the accounts below, and how many accounts it sums. */
    assets: z.array(z.object({ assetId: z.string(), amount: z.string().regex(decimal), accounts: z.number().int().positive() })),
    accounts: z.array(ledgerOwnFundsAccountSchema),
  }),
  unknownPart,
]);
export type OpsCapitalOwnFunds = z.infer<typeof opsCapitalOwnFundsSchema>;

/** One venue's builder account, as that venue reports it. */
export const opsCapitalVenueSchema = z.object({
  venueId: z.string().min(1),
  displayName: z.string().min(1),
  /** True for a TEST venue (simulator or sandbox): every figure from it says TEST. */
  test: z.boolean(),
  /** The builder account's address at the venue. Public on-chain, never a key. */
  builderAccount: z.string().min(1),
  balance: z.discriminatedUnion('status', [
    z.object({ status: z.literal('read'), assetId: z.string(), amount: z.string().regex(decimal), asOf: z.string() }),
    unknownPart,
  ]),
  minimum: z.discriminatedUnion('status', [
    z.object({ status: z.literal('published'), assetId: z.string(), amount: z.string().regex(decimal) }),
    z.object({ status: z.literal('not_published') }),
  ]),
});
export type OpsCapitalVenue = z.infer<typeof opsCapitalVenueSchema>;

export const opsCapitalVenuesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('read'), venues: z.array(opsCapitalVenueSchema) }),
  z.object({ status: z.literal('not_connected'), code: z.literal(OPS_CAPITAL_VENUE_NOT_CONNECTED), message: z.string().min(1) }),
]);
export type OpsCapitalVenues = z.infer<typeof opsCapitalVenuesSchema>;

export const OPS_CAPITAL_PARTNERS = ['bank', 'card'] as const;

/** A reserve one partner holds of ours. `not_known` is the partner not saying how much: never read as zero. */
export const opsCapitalReserveSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('not_known') }),
  z.object({ status: z.literal('reported'), assetId: z.string().regex(OPS_CAPITAL_ASSET), amount: z.string().regex(decimal) }),
]);
export type OpsCapitalReserve = z.infer<typeof opsCapitalReserveSchema>;

/** svc-bank's `/internal/capital/partner-reserves` answer, for svc-ops alone. */
export const bankPartnerReservesSchema = z.object({
  asOf: z.string().datetime({ offset: true }),
  partners: z.array(
    z.object({
      partner: z.enum(OPS_CAPITAL_PARTNERS),
      /** What the partner adapter calls itself, e.g. "TEST partner bank". Never a real partner's name. */
      label: z.string().min(1),
      test: z.boolean(),
      reserve: opsCapitalReserveSchema,
    }),
  ),
});
export type BankPartnerReserves = z.infer<typeof bankPartnerReservesSchema>;

export const opsCapitalReservesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('read'), asOf: z.string(), partners: bankPartnerReservesSchema.shape.partners }),
  unknownPart,
]);
export type OpsCapitalReserves = z.infer<typeof opsCapitalReservesSchema>;

export const opsCapitalThresholdSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(OPS_CAPITAL_THRESHOLD_UNSET) }),
  z.object({
    status: z.literal('set'),
    minimum: z.string().regex(decimal),
    contact: z.string().min(1),
    version: z.number().int().positive(),
    reason: z.string(),
    setAt: z.string(),
    setBy: z.string(),
    approvedBy: z.string(),
  }),
]);
export type OpsCapitalThreshold = z.infer<typeof opsCapitalThresholdSchema>;

export const OPS_CAPITAL_BUFFER_STATES = ['not_monitored', 'ok', 'below_minimum', 'unknown'] as const;
export type OpsCapitalBufferState = (typeof OPS_CAPITAL_BUFFER_STATES)[number];

export const opsCapitalBufferSchema = z.object({
  assetId: z.string(),
  /** INTAFACED's own funds in this asset, or null when the ledger could not be read. */
  buffer: z.string().regex(decimal).nullable(),
  threshold: opsCapitalThresholdSchema,
  state: z.enum(OPS_CAPITAL_BUFFER_STATES),
});
export type OpsCapitalBuffer = z.infer<typeof opsCapitalBufferSchema>;

export const opsCapitalAlertSchema = z.object({
  /** `capital-breach:{asset}:{day}`: one alert per asset and UTC day. */
  key: z.string(),
  assetId: z.string(),
  period: z.string(),
  buffer: z.string().regex(decimal),
  minimum: z.string().regex(decimal),
  /** The contact the threshold named when the alert opened. */
  escalatedTo: z.string(),
  openedAt: z.string(),
});
export type OpsCapitalAlert = z.infer<typeof opsCapitalAlertSchema>;

export const opsCapitalSnapshotSchema = z.object({
  asOf: z.string(),
  /** The UTC day breach alerts are counted in. */
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownFunds: opsCapitalOwnFundsSchema,
  venues: opsCapitalVenuesSchema,
  reserves: opsCapitalReservesSchema,
  buffers: z.array(opsCapitalBufferSchema),
  /** Breach alerts, newest first. */
  alerts: z.array(opsCapitalAlertSchema),
});
export type OpsCapitalSnapshot = z.infer<typeof opsCapitalSnapshotSchema>;

// ── Setting a threshold (two founders) ───────────────────────────────────────

export const opsCapitalThresholdSetInputSchema = z.object({
  assetId: z.string(),
  /** The minimum buffer, or `''` to clear the threshold (the asset is then not monitored). */
  minimum: z.string(),
  /** Who a breach is escalated to. Required with a minimum; `''` when clearing. */
  contact: z.string(),
  /** Why, stored with the change and signed by the approver. */
  reason: z.string(),
  approvalId: z.string(),
  operationId: z.string(),
  idempotencyKey: z.string(),
});
export type OpsCapitalThresholdSetInput = z.infer<typeof opsCapitalThresholdSetInputSchema>;

export const opsCapitalThresholdSetOutputSchema = z.object({
  assetId: z.string(),
  minimum: z.string(),
  contact: z.string(),
  version: z.number().int().positive(),
  outcome: z.enum(['set', 'cleared', 'replayed']),
});
export type OpsCapitalThresholdSetOutput = z.infer<typeof opsCapitalThresholdSetOutputSchema>;

/** The approval target: one asset's threshold. */
export function opsCapitalThresholdTargetId(assetId: string): string {
  return `capital-threshold:${assetId}`;
}

/** What both founders sign, in this key order: the asset, the minimum (`''` clears), the contact and the reason. */
export function opsCapitalThresholdFields(assetId: string, minimum: string, contact: string, reason: string): Record<string, string> {
  return { targetId: opsCapitalThresholdTargetId(assetId), assetId, minimum, contact, reason };
}

export const OPS_CAPITAL_REASON_MIN = 12;
export const OPS_CAPITAL_REASON_MAX = 500;

/** The breach alert's business key. */
export function opsCapitalBreachKey(assetId: string, day: string): string {
  return `capital-breach:${assetId}:${day}`;
}

// ── A scenario ───────────────────────────────────────────────────────────────

export const OPS_CAPITAL_SCENARIO_KINDS = ['counterparty_default'] as const;

/** Every field optional on the wire, so a missing one reaches `ops.capital.scenario_input_missing` by name. */
export const opsCapitalScenarioInputSchema = z.object({
  kind: z.enum(OPS_CAPITAL_SCENARIO_KINDS),
  counterparty: z.string().optional(),
  assetId: z.string().optional(),
  /** What the counterparty owes or holds of ours. Decimal string. */
  exposure: z.string().optional(),
  /** The share of the exposure lost, from 0 to 1. Decimal string. */
  lossShare: z.string().optional(),
});
export type OpsCapitalScenarioInput = z.infer<typeof opsCapitalScenarioInputSchema>;

export const opsCapitalScenarioSchema = z.object({
  asOf: z.string(),
  kind: z.enum(OPS_CAPITAL_SCENARIO_KINDS),
  counterparty: z.string(),
  assetId: z.string(),
  exposure: z.string().regex(decimal),
  lossShare: z.string().regex(decimal),
  /** `exposure × lossShare`, exact. */
  loss: z.string().regex(decimal),
  /** Own funds in the asset from a fresh ledger read, and after the loss (negative when the loss is larger). */
  ownFundsBefore: z.string().regex(decimal),
  ownFundsAfter: z.string().regex(signedDecimal),
  threshold: opsCapitalThresholdSchema,
  /** Against the threshold after the loss: `not_monitored` while it is blank. */
  stateAfter: z.enum(['not_monitored', 'ok', 'below_minimum']),
});
export type OpsCapitalScenario = z.infer<typeof opsCapitalScenarioSchema>;
