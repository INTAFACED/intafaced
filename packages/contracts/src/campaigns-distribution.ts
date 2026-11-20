import { z } from 'zod';
import { asset, campaignDecimal, id, iso, signedDecimal } from './campaigns-base.js';

/** The refusals an airdrop distribution (J-campaigns-13 #1 to #3) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const DISTRIBUTION_REFUSAL_CODES = [
  'campaigns.distribution_invalid',
  'campaigns.distribution_unset',
  'campaigns.not_distribution',
  'campaigns.snapshot_not_due',
  'campaigns.equity_unread',
] as const;

// ── Airdrop distributions and dividends (CM-airdrop-campaigns-01, J-campaigns-13 #1 to #3) ─────────────────────────

/** What a distribution pays out: an airdrop of INTAFACED's own pool is built; a dividend waits for the owner. */
export const DISTRIBUTION_KINDS = ['airdrop', 'dividend'] as const;
export type DistributionKind = (typeof DISTRIBUTION_KINDS)[number];

/**
 * A `distribution` campaign's terms. The pool is the campaign's budget, INTAFACED's own money. At `snapshotAt` each
 * account that joined by then is read once from the venue: its equity there in `equityAsset`. Each account's share is
 * the pool times its equity over the equity of every account counted, the shares summing exactly to the pool; an
 * account whose equity is negative is excluded, and one whose equity cannot be read is named and held out, never
 * counted as zero. Blank fields refuse activation `campaigns.distribution_unset`; a `dividend` refuses `owner.decision`.
 */
export const campaignDistributionSchema = z
  .object({
    kind: z.enum(DISTRIBUTION_KINDS),
    snapshotAt: iso.nullable(),
    equityAsset: asset.nullable(),
  })
  .strict();
export type CampaignDistribution = z.infer<typeof campaignDistributionSchema>;

/** The question a dividend waits on, named in plain words wherever it refuses. */
export const DIVIDEND_OWNER_QUESTION =
  'Does INTAFACED pay dividends to holders of its token, from which revenue, and under what legal form?';

/**
 * How one account stood at a snapshot. `counted`: its equity is in the total and its share is `share` (null when it
 * rounds to nothing). `excluded_negative`: its equity was below zero. `held_out`: its equity could not be read
 * (`heldOut` names why); it is not in the total and is owed nothing from this run. `waiting`: the snapshot is being taken.
 */
export const DISTRIBUTION_STANDINGS = ['counted', 'excluded_negative', 'held_out', 'waiting'] as const;

/** One distribution as the account that took part sees it, with its payout once the share is paid. */
export const distributionRecordSchema = z
  .object({
    campaignId: id,
    campaignName: z.string(),
    kind: z.literal('airdrop'),
    snapshotAt: iso,
    asset,
    pool: campaignDecimal,
    standing: z.enum(DISTRIBUTION_STANDINGS),
    equity: signedDecimal.nullable(),
    equityAsset: asset,
    equityAsOf: iso.nullable(),
    heldOut: z.string().nullable(),
    share: campaignDecimal.nullable(),
    rewardKey: z.string().nullable(),
    /** The share's reward state: owed until it is paid to the connected wallet, then `paid`. Null with no share. */
    state: z.string().nullable(),
    /** The chain transaction that paid the share to the connected wallet; null until paid. */
    chainTx: z.string().nullable(),
    toWallet: z.string().nullable(),
  })
  .strict();
export type DistributionRecord = z.infer<typeof distributionRecordSchema>;
export const distributionsMineInputSchema = z.object({ kind: z.enum(DISTRIBUTION_KINDS) }).strict();
export const distributionsMineSchema = z.object({ records: z.array(distributionRecordSchema) }).strict();
export type DistributionsMine = z.infer<typeof distributionsMineSchema>;

/** `ops.campaigns.distribution.run`: takes the snapshot now if it is due, or resumes a run that stopped part way. */
export const distributionRunInputSchema = z.object({ campaignId: id, reason: z.string().trim().min(3).max(500) }).strict();
export const distributionRunSchema = z
  .object({
    campaignId: id,
    snapshotAt: iso,
    state: z.enum(['reading', 'owed']),
    pool: campaignDecimal,
    totalEquity: campaignDecimal.nullable(),
    counted: z.number().int().min(0),
    excludedNegative: z.number().int().min(0),
    heldOut: z.number().int().min(0),
    sharesTotal: campaignDecimal.nullable(),
  })
  .strict();
export type DistributionRun = z.infer<typeof distributionRunSchema>;
