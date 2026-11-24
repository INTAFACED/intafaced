import { z } from 'zod';
import { REWARD_STATES } from './campaigns-rewards.js';

/**
 * The risk review desk for campaign rewards (J-campaigns-18, CM-abuse-fraud-01, CM-abuse-fraud-02). Shared by svc-campaigns
 * and the founder console. Browser-safe: zod only.
 *
 * - A signal names one account and what it shares or did: `duplicate_account` (another account that looks like the same
 *   person), `device` (a device seen on more than one account) or `anti_churn` (joining, taking a reward and leaving). It
 *   is stored once by (kind, subject, account): the same signal sent twice is one row.
 * - The owner's threshold is how many distinct signals one account may have before its new rewards are held for review
 *   (`review`): each account is judged on its own signals only, so an account that shares a device with another is
 *   untouched until its own pass it. A blank threshold refuses: a reward of an account with any signal stays open with
 *   `campaigns.risk_threshold_unset`, never paid as if the control were off.
 * - Withholding a reward held for review keeps it held with its budget reservation and calls no ledger.
 * - Revoking an account's rewards (a disqualification) needs the owner's appeal window: blank refuses
 *   `campaigns.appeal_window_unset`. An owed reward not yet sent to the wallet is cancelled once (`campaigns:reclaim:`);
 *   a reward already paid to the customer's own wallet is never pulled back, and the case records its amount; the account
 *   is flagged.
 * - An appeal is filed by the customer inside the window; it is decided by a person other than the one who revoked.
 * - A reward withheld because the account is not active (frozen by identity) is listed on the account's case with that
 *   cause; the freeze itself is svc-identity's.
 */

/** The risk review's refusals, spread into `CAMPAIGN_REFUSAL_CODES` (campaigns-catalogue.ts). */
export const RISK_REFUSAL_CODES = [
  'campaigns.risk_threshold_unset',
  'campaigns.appeal_window_unset',
  'campaigns.appeal_window_closed',
  'campaigns.appeal_not_open',
  'campaigns.appeal_same_person',
  'campaigns.risk_case_unknown',
  'campaigns.risk_reward_not_held',
] as const;

const id = z.string().min(1).max(128);
const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const decimal = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
const reason = z.string().trim().min(3).max(500);

export const RISK_SIGNAL_KINDS = ['duplicate_account', 'device', 'anti_churn'] as const;
export type RiskSignalKind = (typeof RISK_SIGNAL_KINDS)[number];

/** A signal's subject: the shared device's fingerprint, the other account, or the churn pattern's reference. */
const subject = z.string().regex(/^[A-Za-z0-9_.:-]{3,128}$/);

export const riskSignalInputSchema = z.object({
  kind: z.enum(RISK_SIGNAL_KINDS),
  subject,
  accountIds: z.array(uuid).min(1).max(20),
  note: z.string().trim().max(500).optional(),
});
export type RiskSignalInput = z.infer<typeof riskSignalInputSchema>;

export const riskSignalSchema = z.object({
  kind: z.enum(RISK_SIGNAL_KINDS),
  subject: z.string(),
  accountId: uuid,
  /** Every other account the same signal names. */
  sharedWith: z.array(uuid),
  note: z.string().nullable(),
  recordedBy: z.string(),
  at: iso,
});
export type RiskSignal = z.infer<typeof riskSignalSchema>;

export const riskSignalResultSchema = z.object({
  /** One per account: true when this call stored it, false when the same signal was already on file. */
  recorded: z.array(z.object({ accountId: uuid, created: z.boolean() })),
});
export type RiskSignalResult = z.infer<typeof riskSignalResultSchema>;

/** `held`: the account's signals passed the threshold. `watching`: below it, untouched. `unset`: the threshold is blank. */
export const RISK_STANDINGS = ['held', 'watching', 'unset'] as const;
export type RiskStanding = (typeof RISK_STANDINGS)[number];

export const riskRewardSchema = z.object({
  rewardKey: z.string(),
  campaignId: id,
  asset: z.string(),
  amount: decimal,
  state: z.enum(REWARD_STATES),
  reason: z.string().nullable(),
  /** The chain transaction that paid it to the customer's own wallet, once paid. */
  paidChainTx: z.string().nullable(),
});
export type RiskReward = z.infer<typeof riskRewardSchema>;

export const riskActionSchema = z.object({
  action: z.enum(['withhold', 'revoke', 'cancel', 'record_paid', 'appeal', 'appeal_decided']),
  rewardKey: z.string().nullable(),
  amount: decimal.nullable(),
  actor: z.string(),
  reason: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  at: iso,
});
export type RiskAction = z.infer<typeof riskActionSchema>;

export const APPEAL_OUTCOMES = ['upheld', 'overturned'] as const;

export const riskAppealSchema = z.object({
  filedAt: iso,
  text: z.string(),
  decidedBy: z.string().nullable(),
  outcome: z.enum(APPEAL_OUTCOMES).nullable(),
  decisionReason: z.string().nullable(),
  decidedAt: iso.nullable(),
});

export const riskCaseSchema = z.object({
  accountId: uuid,
  standing: z.enum(RISK_STANDINGS),
  /** The owner's threshold; null while blank. */
  threshold: z.number().int().positive().nullable(),
  signals: z.array(riskSignalSchema),
  /** Why rewards of this account are withheld when it is not the signals: `account.frozen` and the like (identity's). */
  causes: z.array(z.string()),
  rewards: z.array(riskRewardSchema),
  flagged: z.boolean(),
  /** Who revoked the account's rewards and when; null until revoked. */
  revokedBy: z.string().nullable(),
  revokedAt: iso.nullable(),
  /** The end of the appeal window, from the revocation; null until revoked. */
  appealUntil: iso.nullable(),
  /** What was paid to the customer's own wallet before the revocation and can't be pulled back, by asset. */
  paidUnrecoverable: z.array(z.object({ asset: z.string(), amount: decimal })),
  appeal: riskAppealSchema.nullable(),
  actions: z.array(riskActionSchema),
});
export type RiskCase = z.infer<typeof riskCaseSchema>;

export const riskQueueRowSchema = z.object({
  accountId: uuid,
  standing: z.enum(RISK_STANDINGS),
  kinds: z.array(z.enum(RISK_SIGNAL_KINDS)),
  signals: z.number().int().min(0),
  causes: z.array(z.string()),
  flagged: z.boolean(),
  lastAt: iso,
});
export const riskQueueSchema = z.object({
  threshold: z.number().int().positive().nullable(),
  appealWindowSeconds: z.number().int().positive().nullable(),
  rows: z.array(riskQueueRowSchema),
});
export type RiskQueue = z.infer<typeof riskQueueSchema>;

export const riskCaseInputSchema = z.object({ accountId: uuid });
export const riskWithholdInputSchema = z.object({ rewardKey: z.string().min(1).max(300), reason });
export const riskRevokeInputSchema = z.object({ accountId: uuid, reason });
export const riskAppealInputSchema = z.object({ text: z.string().trim().min(10).max(2000) });
export const riskAppealDecideInputSchema = z.object({ accountId: uuid, outcome: z.enum(APPEAL_OUTCOMES), reason });

/** What the signed-in customer sees of their own case: whether rewards were revoked, and their appeal. */
export const myRiskCaseSchema = z.object({
  flagged: z.boolean(),
  revokedAt: iso.nullable(),
  appealUntil: iso.nullable(),
  appeal: riskAppealSchema.nullable(),
});
export type MyRiskCase = z.infer<typeof myRiskCaseSchema>;
