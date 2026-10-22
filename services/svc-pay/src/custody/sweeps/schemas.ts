import { z } from 'zod';

/** Sweeps to treasury (W-custody-ops-05). Amounts are decimal strings; nothing here is a customer balance. */
export const SWEEP_TRIGGERS = ['immediate', 'amount', 'count', 'schedule'] as const;
export const SWEEP_STATUSES = ['pending', 'unknown', 'failed', 'broadcast'] as const;

const id = z.string().trim().min(1).max(64);
const pair = { networkId: id, assetId: id };

export const sweepPairInputSchema = z.object(pair).strict();

export const sweepPolicySetInputSchema = z
  .object({
    ...pair,
    trigger: z.enum(SWEEP_TRIGGERS),
    thresholdAmount: z.string().max(60).nullable(),
    thresholdCount: z.number().int().nullable(),
    scheduleMinutes: z.number().int().nullable(),
    treasuryAddress: z.string().max(256),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type SweepPolicySetInput = z.infer<typeof sweepPolicySetInputSchema>;

export const sweepPolicyViewSchema = z.object({
  networkId: z.string(),
  assetId: z.string(),
  trigger: z.enum(SWEEP_TRIGGERS),
  thresholdAmount: z.string().nullable(),
  thresholdCount: z.number().int().nullable(),
  scheduleMinutes: z.number().int().nullable(),
  treasuryAddress: z.string(),
  reason: z.string(),
  setBy: z.string(),
  setAt: z.string(),
});
export type SweepPolicyView = z.infer<typeof sweepPolicyViewSchema>;

export const sweepDueViewSchema = z.object({
  networkId: z.string(),
  assetId: z.string(),
  trigger: z.enum(SWEEP_TRIGGERS),
  due: z.boolean(),
  /** Credited deposits on this pair with no sweep intent yet. */
  unsweptCount: z.number().int(),
  unsweptAmount: z.string(),
  lastSweepAt: z.string().nullable(),
});
export type SweepDueView = z.infer<typeof sweepDueViewSchema>;

export const sweepCreateInputSchema = z.object({ depositId: z.string().uuid() }).strict();
export const sweepExecuteInputSchema = z.object({ sweepId: z.string().uuid() }).strict();
export const sweepListInputSchema = z
  .object({ networkId: id.optional(), assetId: id.optional(), limit: z.number().int().min(1).max(200).default(50) })
  .strict();

export const sweepViewSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  depositId: z.string(),
  tier: z.literal('treasury'),
  networkId: z.string(),
  assetId: z.string(),
  fromAddress: z.string(),
  toAddress: z.string(),
  amount: z.string(),
  status: z.enum(SWEEP_STATUSES),
  txHash: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SweepView = z.infer<typeof sweepViewSchema>;
