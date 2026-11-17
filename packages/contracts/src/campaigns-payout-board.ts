import { z } from 'zod';
import { asset, campaignDecimal, id, iso, signedDecimal } from './campaigns-base.js';
import { DISTRIBUTION_STANDINGS } from './campaigns-distribution.js';
import { REWARD_STATES, redemptionAttemptSchema } from './campaigns-rewards.js';

// ── The payout board (J-campaigns-19 #1 #2, CM-payouts-ledger-02) ─────────────────────────────────────────────────

/**
 * Where a reward intent stands on its way to the customer's own wallet, as finance reads it:
 *
 * - `owed`: owed from the campaign's budget, with no payment begun (it waits for its reason: a wallet, a hold, our wallet);
 * - `pending_funding`: the reward pot could not cover the budget it needs; the same key posts again once it is funded;
 * - `sending`: a payment to the wallet is recorded and not yet booked: sent and waiting for the chain, or its answer lost
 *   and looked for on the chain by its own facts, never sent again;
 * - `paid`: the chain confirmed the payment and the ledger booked it, with both references;
 * - `failed`: a definite refusal proved nothing was owed, or the chain reverted the payment; nothing is sent again;
 * - `other`: any other state (being posted, waiting on the posting freeze or the ceiling, held, locked, cancelled), named.
 */
export const PAYOUT_BOARD_STATES = ['owed', 'pending_funding', 'sending', 'paid', 'failed', 'other'] as const;
export type PayoutBoardState = (typeof PAYOUT_BOARD_STATES)[number];

/** A payment to the wallet: one per reward, recorded before it is sent (`campaigns.reward_payments`). */
export const PAYOUT_PAYMENT_STATES = ['sending', 'sent', 'booked', 'failed'] as const;

export const payoutBoardRowSchema = z
  .object({
    /** The business key: the ledger's keys are made from it, and the payment is looked for on the chain under it. */
    rewardKey: z.string(),
    campaignId: id,
    accountId: z.string(),
    asset,
    amount: campaignDecimal,
    board: z.enum(PAYOUT_BOARD_STATES),
    state: z.enum(REWARD_STATES),
    /** The typed reason it waits or failed; null when nothing holds it. */
    reason: z.string().nullable(),
    /** The ledger transaction that owed it from the campaign's budget. */
    owedTxId: z.string().nullable(),
    /** The ledger transaction that booked its payment (paid: the reservation moved to spent). */
    paidTxId: z.string().nullable(),
    payment: z
      .object({
        state: z.enum(PAYOUT_PAYMENT_STATES),
        toWallet: z.string(),
        /** The chain transaction that carried it; null while its send's answer is lost and it is looked for on the chain. */
        chainTx: z.string().nullable(),
        sentAt: iso,
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    attempts: z.array(redemptionAttemptSchema),
    updatedAt: iso,
  })
  .strict();
export type PayoutBoardRow = z.infer<typeof payoutBoardRowSchema>;

export const payoutBoardInputSchema = z.object({ campaignId: id.optional() }).strict();
export const payoutBoardSchema = z
  .object({
    /** How many intents stand in each state, over every intent (or the campaign's), not only the rows shown. */
    counts: z.record(z.enum(PAYOUT_BOARD_STATES), z.number().int().min(0)),
    /** The newest 200, most recently changed first. */
    rows: z.array(payoutBoardRowSchema),
    asOf: iso,
  })
  .strict();
export type PayoutBoard = z.infer<typeof payoutBoardSchema>;

// ── An airdrop's plan, account by account (J-campaigns-19 #5 #6, CM-airdrop-campaigns-01) ───────────────────────────

/**
 * One account at an airdrop's snapshot, as the operator reads it: counted with its equity and share, excluded for a
 * negative equity, or named and held out because its equity could not be read (`reason`, the venue's code).
 */
export const distributionPlanAccountSchema = z
  .object({
    accountId: z.string(),
    standing: z.enum(DISTRIBUTION_STANDINGS),
    equity: signedDecimal.nullable(),
    equityAsOf: iso.nullable(),
    reason: z.string().nullable(),
    share: campaignDecimal.nullable(),
    rewardKey: z.string().nullable(),
    /** The share's reward state and its payment's chain transaction once paid. */
    rewardState: z.enum(REWARD_STATES).nullable(),
    chainTx: z.string().nullable(),
    toWallet: z.string().nullable(),
  })
  .strict();
export type DistributionPlanAccount = z.infer<typeof distributionPlanAccountSchema>;

export const distributionPlanInputSchema = z.object({ campaignId: id }).strict();
export const distributionPlanSchema = z
  .object({
    campaignId: id,
    campaignName: z.string(),
    /** Null until the snapshot has been taken (the run has not started). */
    snapshotAt: iso.nullable(),
    state: z.enum(['not_started', 'reading', 'owed']),
    asset: asset.nullable(),
    pool: campaignDecimal.nullable(),
    totalEquity: campaignDecimal.nullable(),
    sharesTotal: campaignDecimal.nullable(),
    accounts: z.array(distributionPlanAccountSchema),
  })
  .strict();
export type DistributionPlan = z.infer<typeof distributionPlanSchema>;
