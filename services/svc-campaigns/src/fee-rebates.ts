import type postgres from 'postgres';
import { transaction, type Queryable } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { CAMPAIGN_STATES, campaignLimitsSchema } from '@intafaced/contracts/campaigns-catalogue';
import { z } from 'zod';
import { effectiveState } from './campaigns.js';
import type { CompetitionFill, CompetitionFillSource } from './competitions.js';
import type { PayoutSaga } from './payouts.js';
import { drawnOf, limitRefusalOf } from './tasks.js';
import { voucherRewardKeyOf } from './vouchers.js';

/**
 * Fee rebate coupons (CM-vouchers-coupons-03, J-campaigns-09 #5 #6). A claimed fee rebate coupon pays `fee_rebate_bps`
 * of our builder fee back on each eligible venue fill, up to its face value, from its campaign's budget: INTAFACED's own
 * money, owed once per accrual and paid once to the holder's connected wallet after the coupon's delay, never credited to
 * a balance. Campaigns posts nothing for the fill itself: svc-trade books our builder fee against the venue's record.
 *
 * - Fills: read from the venue's own fills of the holder's orders placed through our door with our builder fee above
 *   zero (svc-trade `GET /internal/venue/our-fills`), as a competition reads volume. A read that fails accrues nothing
 *   and is tried again on the next pass: never "no fills".
 * - Eligible: filled at or after the claim and before the use-by, its builder fee above zero in the coupon's asset. A
 *   zero-fee fill accrues nothing, and nor does a fill whose rebate rounds to nothing in the paying token's decimals.
 * - Once: each fill accrues once per account, keyed by the venue's own fill (venue, venue account, fill id), under a lock
 *   on the account, so a fill read again (a redelivery, a restart, two passes at once) accrues nothing more.
 * - Never past the face: the accrual is cut to what is left on the coupon, read under its lock, and the campaign's budget
 *   and limits are checked as for any reward; with nothing left the fill accrues nothing.
 * - Paid: each accrual is the coupon's next redemption (`voucher:<voucher>:<account>:<n>`), a reward intent owed now by
 *   the saga and held until it accrued plus the delay; the reward payer pays it to the connected wallet noted on it (the
 *   holder's own read of their vouchers notes it), finds a send whose answer was lost on the chain, and books it once.
 */

export interface FeeRebateServiceOptions {
  sql: postgres.Sql;
  saga: PayoutSaga | null;
  fills: CompetitionFillSource | null;
  /** The paying token's decimals: a rebate is rounded down to them. Null: no accrual is made (nothing could be paid). */
  payDecimals: number | null;
  now?: () => Date;
  log?: (msg: string, detail: Record<string, unknown>) => void;
}

const HolderRow = z.object({ account_id: z.string(), since: z.date() });
const SeenRow = z.object({ seen: z.number() });
const Candidate = z.object({
  id: z.string(),
  campaign_id: z.string(),
  face_asset: z.string(),
  face_amount: z.string(),
  fee_rebate_bps: z.number().int(),
  fee_rebate_delay_seconds: z.number().int(),
});
type Candidate = z.infer<typeof Candidate>;
const UsageRow = z.object({ used: z.string(), n: z.number().int() });
const CampaignRow = z.object({
  state: z.enum(CAMPAIGN_STATES),
  starts_at: z.date().nullable(),
  ends_at: z.date().nullable(),
  budget_asset: z.string().nullable(),
  budget_limit: z.string().nullable(),
  limits: campaignLimitsSchema.nullable(),
});

/** One fill to accrue, on the venue that reported it, when it was filled. */
type FillOf = { accountId: string; venueId: string; fill: CompetitionFill; filledAt: Date };

/** The holders a pass reads: a coupon still claimable for fills, or past its use-by by less than this (a late read). */
const LATE_READ_MS = 86_400_000;

export class FeeRebateService {
  private readonly sql: postgres.Sql;
  private readonly saga: PayoutSaga | null;
  private readonly fills: CompetitionFillSource | null;
  private readonly unit: bigint | null;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail: Record<string, unknown>) => void;

  constructor(options: FeeRebateServiceOptions) {
    this.sql = options.sql;
    this.saga = options.saga;
    this.fills = options.fills;
    this.unit = options.payDecimals === null ? null : 10n ** BigInt(18 - options.payDecimals);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  /** The rebate on one fill's builder fee: `bps` of it, rounded down to the paying token's decimals. */
  rebateOf(builderFee: string, bps: number): bigint {
    const raw = (parseAmount(builderFee) * BigInt(bps)) / 10_000n;
    return this.unit === null ? 0n : (raw / this.unit) * this.unit;
  }

  /** One pass: every holder of a live fee rebate coupon has their fills read and each new eligible one accrued once. */
  async tick(): Promise<void> {
    if (!this.fills || !this.saga || this.unit === null) return;
    const holders = HolderRow.array().parse(
      await this.sql`
      SELECT v.claimed_by AS account_id, min(v.claimed_at) AS since
      FROM campaigns.vouchers v
      WHERE v.kind = 'fee_rebate' AND v.state IN ('claimed', 'partially_used', 'expired') AND v.claimed_by IS NOT NULL
        AND v.use_by > ${new Date(this.now().getTime() - LATE_READ_MS)}
      GROUP BY v.claimed_by ORDER BY v.claimed_by LIMIT 200`,
    );
    for (const h of holders) {
      try {
        await this.accrueFor(h.account_id, h.since);
      } catch (err) {
        this.log('campaigns.fee_rebate.accrue_failed', {
          accountId: h.account_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Reads one holder's fills since `since` and accrues each new eligible one; returns the reward keys it made. */
  async accrueFor(accountId: string, since: Date): Promise<string[]> {
    if (!this.fills || !this.saga || this.unit === null) return [];
    const answer = await this.fills.ourFills(accountId, since);
    if ('unread' in answer) {
      this.log('campaigns.fee_rebate.fills_unread', { accountId, code: answer.unread });
      return [];
    }
    const made: string[] = [];
    for (const fill of answer.fills) {
      const key = await this.accrue(accountId, answer.venueId, fill);
      if (key) made.push(key);
    }
    for (const key of made) {
      try {
        await this.saga.attempt(key);
      } catch (err) {
        // Left `qualified`: the reconciler owes it under the same key.
        this.log('campaigns.fee_rebate.owe_failed', { key, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return made;
  }

  /** Accrues one fill once, on the holder's best coupon with room; returns its reward key, or null for none. */
  private async accrue(accountId: string, venueId: string, fill: CompetitionFill): Promise<string | null> {
    const fee = parseAmount(fill.builderFee);
    if (fee <= 0n) return null;
    const filledAt = new Date(fill.filledAt);
    if (Number.isNaN(filledAt.getTime())) return null;
    // The rebate is paid in the asset our builder fee was charged in; an older read that names none charged it in the quote.
    const feeAsset = fill.feeAsset ?? fill.quoteAsset;
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`fee-rebate:${accountId}`}))`;
      const [seen] = SeenRow.array().parse(
        await tx`
        SELECT 1 AS seen FROM campaigns.fee_rebate_accruals
        WHERE account_id = ${accountId} AND venue_id = ${venueId} AND venue_account = ${fill.venueAccount} AND fill_id = ${fill.fillId}`,
      );
      if (seen) return null;
      const candidates = Candidate.array().parse(
        await tx`
        SELECT v.id, v.campaign_id, v.face_asset, v.face_amount::text AS face_amount, v.fee_rebate_bps, v.fee_rebate_delay_seconds
        FROM campaigns.vouchers v
        WHERE v.kind = 'fee_rebate' AND v.claimed_by = ${accountId} AND v.state IN ('claimed', 'partially_used', 'expired')
          AND v.claimed_at <= ${filledAt} AND v.use_by > ${filledAt} AND v.face_asset = ${feeAsset}
        ORDER BY v.fee_rebate_bps DESC, v.use_by ASC, v.id ASC
        FOR UPDATE`,
      );
      for (const v of candidates) {
        const key = await this.accrueOn(tx, v, { accountId, venueId, fill, filledAt });
        if (key) return key;
      }
      return null;
    });
  }

  private async accrueOn(tx: Queryable, v: Candidate, { accountId, venueId, fill, filledAt }: FillOf): Promise<string | null> {
    const prefix = `voucher:${v.id}:`;
    // What the coupon has paid or holds for payment, read under its lock, as a cash voucher's redemptions are summed.
    const [usage] = UsageRow.array().parse(
      await tx`
      SELECT COALESCE(sum(amount) FILTER (WHERE state NOT IN ('failed', 'forfeited', 'withheld', 'cancelled')), 0)::text AS used,
        count(*)::int AS n
      FROM campaigns.reward_intents
      WHERE campaign_id = ${v.campaign_id} AND account_id = ${accountId} AND left(period, ${prefix.length}) = ${prefix}`,
    );
    if (!usage) return null;
    const left = parseAmount(v.face_amount) - parseAmount(usage.used);
    if (left <= 0n) return null;
    const rebate = this.rebateOf(fill.builderFee, v.fee_rebate_bps);
    const amount = rebate < left ? rebate : left;
    if (amount <= 0n) return null;
    const [campaign] = CampaignRow.array().parse(
      await tx`
      SELECT state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, limits
      FROM campaigns.campaigns WHERE id = ${v.campaign_id} FOR UPDATE`,
    );
    if (!campaign) return null;
    const live = effectiveState(campaign, this.now());
    // A claimed coupon is honoured until its use-by after its campaign ends, as a cash voucher is; a stopped one pays nothing.
    if (live !== 'active' && live !== 'ended') return null;
    if (campaign.budget_asset !== v.face_asset || campaign.budget_limit === null) return null;
    if (await limitRefusalOf(tx, v.campaign_id, accountId, campaign.limits)) return null;
    if ((await drawnOf(tx, v.campaign_id)) + amount > parseAmount(campaign.budget_limit)) return null;
    const sequence = usage.n + 1;
    const key = voucherRewardKeyOf(v.id, accountId, sequence);
    const payableAt = new Date(this.now().getTime() + v.fee_rebate_delay_seconds * 1000);
    const text = formatAmount(amount);
    await tx`
      INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, hold_until, form)
      VALUES (${key}, ${v.campaign_id}, ${accountId}, ${`${prefix}${sequence}`}, ${v.face_asset}, ${text}, 'qualified',
        ${payableAt}, 'paid')`;
    await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${key}, 'qualified')`;
    await tx`
      INSERT INTO campaigns.fee_rebate_accruals (account_id, venue_id, venue_account, fill_id, voucher_id, sequence, builder_fee,
        amount, filled_at, reward_key)
      VALUES (${accountId}, ${venueId}, ${fill.venueAccount}, ${fill.fillId}, ${v.id}, ${sequence}, ${formatAmount(parseAmount(fill.builderFee))},
        ${text}, ${filledAt}, ${key})`;
    await tx`
      UPDATE campaigns.vouchers SET state = ${amount === left ? 'used' : 'partially_used'}, updated_at = now()
      WHERE id = ${v.id} AND state IN ('claimed', 'partially_used')`;
    await tx`
      INSERT INTO campaigns.audit_log (actor, action, target, detail)
      VALUES ('svc-campaigns', 'campaign.voucher.fee_rebate_accrue', ${v.campaign_id},
        ${tx.json({ voucher: v.id, rewardKey: key, sequence, venueId, fillId: fill.fillId, builderFee: fill.builderFee, amount: text })})`;
    return key;
  }
}
