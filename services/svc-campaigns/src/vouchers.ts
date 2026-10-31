import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  MY_VOUCHERS_LIMIT,
  type CampaignLimits,
  type MyVoucher,
  type MyVouchers,
  type ParticipationRules,
  type RewardRecord,
  type VoucherRedeemResult,
  type VoucherRedemption,
  type VoucherValidation,
} from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { ELIGIBILITY_REFUSAL, effectiveState, type CampaignService } from './campaigns.js';
import type { ParticipantSource } from './participants.js';
import type { PayoutSaga } from './payouts.js';
import { LIMIT_WORDS, drawnOf, limitRefusalOf } from './tasks.js';

/**
 * A customer's vouchers (J-campaigns-08, CM-vouchers-coupons-01): check a code, claim it for the caller's own account,
 * redeem part or all of what is left, and let it expire.
 *
 * - Every check and claim counts against the owner's attempt limits, per account and per source address over the owner's
 *   window (VC-3). Any blank refuses `campaigns.attempt_limit_unset`; over a limit, `campaigns.attempt_limit_reached`.
 *   The attempt is counted before the code is looked at, so a refused guess counts like any other.
 * - One answer for any code the caller may not claim: no such code, already claimed (by anyone, the caller included),
 *   past its claim-by, or its campaign not live all refuse `campaigns.voucher_invalid` with the same words, so a guess
 *   learns nothing about whether a code exists or who holds it (ENGINE EL-6). Only the caller's own eligibility under
 *   the campaign's rules is named, as a join names it.
 * - A claim is one conditional UPDATE from `published`: of two claims at once, one wins and the other gets the generic
 *   refusal. Checking a code changes nothing.
 * - The face value is a limit, not a balance, and what a voucher used is never stored: it is the sum of its redemption
 *   intents that hold or spent value (not failed, forfeited or withheld), as a campaign's budget is. The n-th
 *   redemption is a reward intent under `voucher:<voucher>:<account>:<n>` (the spec's key with the use number after
 *   it; the ledger key is `reward:` and that), written under a lock on the voucher once that sum and the campaign's budget leave room for it, and then
 *   paid by the reward saga (`rewardPay`) like any reward. The same redemption again returns the first; a voucher never
 *   pays more than its face value (`campaigns.voucher_exceeds_remaining`). Its state (claimed, partly used, used) is
 *   read from the same sum.
 * - A claimed voucher whose use-by has passed refuses every redemption (`campaigns.voucher_expired`) and is marked
 *   `expired` once, by a conditional UPDATE, by the sweep; a read shows it expired from its use-by on. What was redeemed
 *   stays redeemed: expiry moves no value.
 */

type Sql = postgres.Sql;

type VoucherCampaignRow = {
  id: string;
  campaign_id: string;
  code: string;
  state: MyVoucher['state'];
  face_asset: string;
  face_amount: string;
  used_amount: string;
  claim_by: Date | null;
  use_by: Date | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  expired_at: Date | null;
  campaign_name: string;
  campaign_state: Parameters<typeof effectiveState>[0]['state'];
  starts_at: Date | null;
  ends_at: Date | null;
  participation: ParticipationRules | null;
};

type RedemptionRow = {
  reward_key: string;
  period: string;
  amount: string;
  state: RewardRecord['state'];
  reason: string | null;
  ledger_tx_id: string | null;
  posted_at: Date | null;
  created_at: Date;
};

const INVALID = 'This code cannot be claimed. Check it and try again.';
const DECIMAL = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;

const decimalOf = (raw: string) => formatAmount(parseAmount(raw));
const periodOf = (voucherId: string, sequence: number) => `voucher:${voucherId}:${sequence}`;
const periodPrefix = (voucherId: string) => `voucher:${voucherId}:`;
/** The n-th redemption's business key (CM-vouchers-coupons-01); the ledger key is `reward:` and this. */
export const voucherRewardKeyOf = (voucherId: string, accountId: string, sequence: number) =>
  `voucher:${voucherId}:${accountId}:${sequence}`;

/** Owner limits on code checks and claims (CM-eligibility-rules-04); null while any of them is blank. */
export type AttemptLimits = { perAccount: number; perAddress: number; windowSeconds: number };

/** What a voucher used: its redemption intents that hold or spent value, as the campaign budget counts them. */
const USED = (sql: Sql) => sql`
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = v.campaign_id AND i.account_id = v.claimed_by
      AND left(i.period, length('voucher:' || v.id || ':')) = 'voucher:' || v.id || ':'
      AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text`;

const SELECT_VOUCHER = (sql: Sql) => sql`
  SELECT v.id, v.campaign_id, v.code, v.state, v.face_asset, v.face_amount::text AS face_amount,
    ${USED(sql)} AS used_amount, v.claim_by, v.use_by, v.claimed_by, v.claimed_at, v.expired_at,
    c.name AS campaign_name, c.state AS campaign_state, c.starts_at, c.ends_at, c.participation
  FROM campaigns.vouchers v JOIN campaigns.campaigns c ON c.id = v.campaign_id`;

export interface VoucherServiceOptions {
  sql: Sql;
  /** svc-identity's participant read: a redemption is paid to an active account only. */
  participants: ParticipantSource;
  /** The campaign's participation rules, read the way a join reads them. */
  campaigns: Pick<CampaignService, 'eligibility'>;
  /** Null while the ledger is not connected: every redemption refuses `campaigns.reward_saga_unwired`. */
  saga: PayoutSaga | null;
  /** The owner's attempt limits, read per call; null refuses every check and claim `campaigns.attempt_limit_unset`. */
  attemptLimits: () => AttemptLimits | null;
  now?: () => Date;
}

export class VoucherService {
  private readonly sql: Sql;
  private readonly participants: ParticipantSource;
  private readonly campaigns: Pick<CampaignService, 'eligibility'>;
  private readonly saga: PayoutSaga | null;
  private readonly attemptLimits: () => AttemptLimits | null;
  private readonly now: () => Date;

  constructor(options: VoucherServiceOptions) {
    this.sql = options.sql;
    this.participants = options.participants;
    this.campaigns = options.campaigns;
    this.saga = options.saga;
    this.attemptLimits = options.attemptLimits;
    this.now = options.now ?? (() => new Date());
  }

  /** What a code would give the caller, once every claim check passes. Nothing is written. */
  async validate(input: { code: string; accountId: string; source: string | null }): Promise<VoucherValidation> {
    await this.attempt(input.accountId, input.source);
    const v = await this.claimable(input.code, input.accountId);
    return {
      claimable: true,
      campaignName: v.campaign_name,
      face: { asset: v.face_asset, amount: decimalOf(v.face_amount) },
      claimBy: v.claim_by!.toISOString(),
      useBy: v.use_by!.toISOString(),
    };
  }

  /** Claims a code for the caller's own account. Of two claims at once, one wins; the other is the generic refusal. */
  async claim(input: { code: string; accountId: string; source: string | null }): Promise<MyVoucher> {
    await this.attempt(input.accountId, input.source);
    const v = await this.claimable(input.code, input.accountId);
    const now = this.now();
    const claimed = await transaction(this.sql, async (tx) => {
      const moved = await tx`
        UPDATE campaigns.vouchers SET state = 'claimed', claimed_by = ${input.accountId}, claimed_at = ${now}, updated_at = now()
        WHERE id = ${v.id} AND state = 'published' AND claimed_by IS NULL AND claim_by > ${now}
          -- The campaign is still live at the claim itself, not only when it was read.
          AND EXISTS (SELECT 1 FROM campaigns.campaigns c WHERE c.id = vouchers.campaign_id
            AND c.state IN ('scheduled', 'active') AND c.starts_at <= ${now} AND c.ends_at > ${now})`;
      if (moved.count === 0) return false;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.accountId}, 'campaign.voucher.claim', ${v.campaign_id}, ${tx.json({ voucher: v.id })})`;
      return true;
    });
    if (!claimed) throw new CampaignsError('campaigns.voucher_invalid', INVALID);
    return (await this.own(v.id, input.accountId))!;
  }

  /**
   * The n-th redemption of the caller's voucher. Its intent is written under a lock on the voucher and then on its
   * campaign, then the saga posts it with no transaction open. The same voucher and sequence again returns the first
   * answer (`created: false`); a different amount under it refuses `campaigns.voucher_sequence_invalid`. A paused,
   * archived or otherwise stopped campaign pays nothing (`campaign.not_active`); an ended one honours a claimed voucher
   * until its use-by. The caller is checked against the campaign's rules again, as at the claim.
   */
  async redeem(input: { voucherId: string; amount: string; sequence: number; accountId: string }): Promise<VoucherRedeemResult> {
    if (!this.saga) throw new CampaignsError('campaigns.reward_saga_unwired', 'Vouchers cannot be redeemed: the ledger is not connected');
    const raw = input.amount.trim();
    if (!DECIMAL.test(raw) || parseAmount(raw) <= 0n) {
      throw new CampaignsError('campaigns.voucher_amount_invalid', 'The amount must be a positive decimal');
    }
    const units = parseAmount(raw);
    const period = periodOf(input.voucherId, input.sequence);
    // Identity is read before any write, and nothing it answers is stored.
    const who = await this.participants.read(input.accountId);
    if (!who) throw new CampaignsError('campaigns.participant_unread', 'Your account could not be checked for this redemption');
    // An account that is not active gets its redemption withheld before any ledger call (svc-identity owns the freeze).
    const withheld = who.status !== 'active' ? `account.${who.status}` : null;
    const [rules] = await this.sql<{ participation: ParticipationRules | null }[]>`
      SELECT c.participation FROM campaigns.vouchers v JOIN campaigns.campaigns c ON c.id = v.campaign_id
      WHERE v.id = ${input.voucherId} AND v.claimed_by = ${input.accountId}`;
    if (rules?.participation) await this.refuseIneligible(rules.participation, input.accountId);
    const outcome = await transaction(this.sql, async (tx) => {
      const [v] = await tx<VoucherCampaignRow[]>`
        SELECT v.id, v.campaign_id, v.state, v.face_asset, v.face_amount::text AS face_amount, v.use_by, v.claimed_by
        FROM campaigns.vouchers v WHERE v.id = ${input.voucherId} FOR UPDATE`;
      if (!v || v.claimed_by !== input.accountId) throw new CampaignsError('campaigns.voucher_invalid', INVALID);
      // Read under the voucher's lock: every redemption of it takes that lock first, so the sum cannot move under us.
      const [usage] = await tx<{ used_amount: string }[]>`
        SELECT ${USED(tx)} AS used_amount FROM campaigns.vouchers v WHERE v.id = ${v.id}`;
      v.used_amount = usage!.used_amount;
      const key = voucherRewardKeyOf(v.id, input.accountId, input.sequence);
      const [first] = await tx<{ amount: string }[]>`
        SELECT amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${key}`;
      if (first) {
        if (parseAmount(first.amount) !== units) {
          throw new CampaignsError('campaigns.voucher_sequence_invalid', `Redemption ${input.sequence} of this voucher was another amount`);
        }
        return { key, created: false, withheld: false };
      }
      if (v.state === 'expired' || !v.use_by || v.use_by <= this.now()) {
        throw new CampaignsError('campaigns.voucher_expired', 'This voucher’s use-by has passed');
      }
      const [count] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campaigns.reward_intents
        WHERE campaign_id = ${v.campaign_id} AND account_id = ${input.accountId}
          AND left(period, ${periodPrefix(v.id).length}) = ${periodPrefix(v.id)}`;
      const n = count!.n;
      if (input.sequence !== n + 1) {
        throw new CampaignsError('campaigns.voucher_sequence_invalid', `The next redemption of this voucher is number ${n + 1}`);
      }
      const left = parseAmount(v.face_amount) - parseAmount(v.used_amount);
      if (units > left) {
        throw new CampaignsError(
          'campaigns.voucher_exceeds_remaining',
          `Only ${formatAmount(left)} ${v.face_asset} is left on this voucher`,
        );
      }
      // The campaign is locked after the voucher, as every redemption takes them, so its budget cannot move under us.
      const [campaign] = await tx<
        {
          state: string;
          starts_at: Date | null;
          ends_at: Date | null;
          budget_asset: string | null;
          budget_limit: string | null;
          limits: CampaignLimits | null;
        }[]
      >`
        SELECT state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, limits
        FROM campaigns.campaigns WHERE id = ${v.campaign_id} FOR UPDATE`;
      const live = effectiveState(campaign as Parameters<typeof effectiveState>[0], this.now());
      if (live !== 'active' && live !== 'ended') {
        throw new CampaignsError('campaign.not_active', `This voucher’s campaign is ${live}, so it pays nothing now`);
      }
      if (!campaign!.budget_asset || campaign!.budget_limit === null) {
        throw new CampaignsError('campaigns.budget_unset', 'This campaign has no budget set, so nothing can be redeemed');
      }
      if (campaign!.budget_asset !== v.face_asset) {
        throw new CampaignsError('campaigns.budget_asset_mismatch', 'The budget and the voucher are in different assets');
      }
      // The campaign's limits, as for any reward; a withheld redemption holds nothing, so it is not limited.
      const over = withheld ? null : await limitRefusalOf(tx, v.campaign_id, input.accountId, campaign!.limits, this.now());
      if (over) throw new CampaignsError(over, LIMIT_WORDS[over]);
      // The budget, as a task reward reads it: the limit less every intent that holds or spent part of it.
      if (!withheld && (await drawnOf(tx, v.campaign_id)) + units > parseAmount(campaign!.budget_limit)) {
        throw new CampaignsError('campaigns.budget_exhausted', 'This campaign’s budget has no room for this redemption');
      }
      const amount = formatAmount(units);
      await tx`
        INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, reason, form)
        VALUES (${key}, ${v.campaign_id}, ${input.accountId}, ${period}, ${v.face_asset}, ${amount},
          ${withheld ? 'withheld' : 'qualified'}, ${withheld}, 'paid')`;
      await tx`
        INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason)
        VALUES (${key}, ${withheld ? 'withheld' : 'qualified'}, ${withheld})`;
      // A withheld redemption uses nothing of the voucher: it is not in the sum.
      if (!withheld) {
        await tx`
          UPDATE campaigns.vouchers SET state = ${units === left ? 'used' : 'partially_used'}, updated_at = now()
          WHERE id = ${v.id}`;
      }
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.accountId}, 'campaign.voucher.redeem', ${v.campaign_id},
          ${tx.json({ voucher: v.id, rewardKey: key, sequence: input.sequence, amount })})`;
      return { key, created: true, withheld: withheld !== null };
    });
    if (outcome.created && !outcome.withheld) await this.saga.attempt(outcome.key);
    const voucher = (await this.own(input.voucherId, input.accountId))!;
    const redemption = voucher.redemptions.find((r) => r.sequence === input.sequence)!;
    return { redemption, voucher, created: outcome.created };
  }

  /**
   * The caller's vouchers, newest claim first, each with its redemptions. A read writes nothing: one past its use-by with
   * something left reads expired before the sweep marks it, and `expiredAt` is set once the sweep has.
   */
  async mine(input: { accountId: string }): Promise<MyVouchers> {
    const rows = await this.sql<VoucherCampaignRow[]>`
      ${SELECT_VOUCHER(this.sql)}
      WHERE v.claimed_by = ${input.accountId}
      ORDER BY v.claimed_at DESC, v.id LIMIT ${MY_VOUCHERS_LIMIT}`;
    const redemptions = await this.redemptionsOf(rows, input.accountId);
    const now = this.now();
    return { vouchers: rows.map((r) => toMine(r, redemptions.get(r.id) ?? [], now)) };
  }

  /**
   * Marks every claimed voucher with something left whose use-by has passed `expired`, once each (a conditional UPDATE;
   * a second pass finds nothing), with its audit row. A voucher used in full stays used. Moves no value. `accountId` limits it to one account's vouchers.
   */
  async expire(input: { accountId?: string; limit?: number } = {}): Promise<number> {
    return transaction(this.sql, async (tx) => {
      const gone = await tx<{ id: string; campaign_id: string; claimed_by: string }[]>`
        UPDATE campaigns.vouchers SET state = 'expired', expired_at = ${this.now()}, updated_at = now()
        WHERE id IN (
          SELECT v.id FROM campaigns.vouchers v
          WHERE v.state IN ('claimed', 'partially_used', 'used') AND v.use_by <= ${this.now()}
            ${input.accountId ? tx`AND v.claimed_by = ${input.accountId}` : tx``}
            AND ${USED(tx)}::numeric < v.face_amount
          ORDER BY v.use_by LIMIT ${input.limit ?? 500} FOR UPDATE SKIP LOCKED)
        AND state IN ('claimed', 'partially_used', 'used')
        RETURNING id, campaign_id, claimed_by`;
      for (const g of gone) {
        await tx`
          INSERT INTO campaigns.audit_log (actor, action, target, detail)
          VALUES ('svc-campaigns', 'campaign.voucher.expire', ${g.campaign_id}, ${tx.json({ voucher: g.id, account: g.claimed_by })})`;
      }
      return gone.length;
    });
  }

  /**
   * Deletes attempt rows older than the owner's window: nothing counts them any more, and they hold no value. With the
   * limits blank nothing is counted, so nothing is pruned. Returns how many went.
   */
  async pruneAttempts(limit = 5000): Promise<number> {
    const limits = this.attemptLimits();
    if (!limits) return 0;
    const before = new Date(this.now().getTime() - limits.windowSeconds * 1000);
    const gone = await this.sql`
      DELETE FROM campaigns.voucher_attempts WHERE id IN (
        SELECT id FROM campaigns.voucher_attempts WHERE at <= ${before} ORDER BY at LIMIT ${limit})`;
    return gone.count;
  }

  /**
   * Counts one check or claim against the owner's limits, per account and per source address in the window, under a lock
   * on the account so two at once never both take the last one. No address (a call that did not come through the edge)
   * counts against the account limit only.
   */
  private async attempt(accountId: string, source: string | null): Promise<void> {
    const limits = this.attemptLimits();
    if (!limits) {
      throw new CampaignsError('campaigns.attempt_limit_unset', 'Voucher code checks are closed: the attempt limit is not set');
    }
    const since = new Date(this.now().getTime() - limits.windowSeconds * 1000);
    await transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`voucher:attempts:${accountId}`}))`;
      if (source) await tx`SELECT pg_advisory_xact_lock(hashtext(${`voucher:attempts:source:${source}`}))`;
      const [counts] = await tx<{ account: number; address: number }[]>`
        SELECT
          (SELECT count(*)::int FROM campaigns.voucher_attempts WHERE account_id = ${accountId} AND at > ${since}) AS account,
          (SELECT count(*)::int FROM campaigns.voucher_attempts WHERE source = ${source} AND at > ${since}) AS address`;
      if (counts!.account >= limits.perAccount || (source !== null && counts!.address >= limits.perAddress)) {
        throw new CampaignsError('campaigns.attempt_limit_reached', 'Too many voucher code checks; try again later');
      }
      await tx`INSERT INTO campaigns.voucher_attempts (account_id, source, at) VALUES (${accountId}, ${source}, ${this.now()})`;
    });
  }

  /** Every claim check, in order; anything about a code the caller may not claim is the one generic refusal. */
  private async claimable(raw: string, accountId: string): Promise<VoucherCampaignRow> {
    const code = raw.trim().toUpperCase();
    const rows = await this.sql<VoucherCampaignRow[]>`${SELECT_VOUCHER(this.sql)} WHERE v.code = ${code} LIMIT 2`;
    const now = this.now();
    const [v] = rows;
    if (!v || rows.length > 1 || v.state !== 'published' || effectiveState({ ...v, state: v.campaign_state }, now) !== 'active') {
      throw new CampaignsError('campaigns.voucher_invalid', INVALID);
    }
    if (!v.claim_by || !v.use_by) {
      throw new CampaignsError('campaigns.voucher_window_unset', 'This voucher’s claim-by or use-by is not set, so it cannot be claimed');
    }
    if (v.claim_by <= now) throw new CampaignsError('campaigns.voucher_invalid', INVALID);
    if (v.participation) await this.refuseIneligible(v.participation, accountId);
    return v;
  }

  /** The caller under the campaign's rules, refused as a join refuses: about the caller only. */
  private async refuseIneligible(rules: ParticipationRules, accountId: string): Promise<void> {
    const answer = await this.campaigns.eligibility(rules, accountId);
    if (answer === 'eligible') return;
    const [code, message] = ELIGIBILITY_REFUSAL[answer];
    throw new CampaignsError(code, message);
  }

  private async own(voucherId: string, accountId: string): Promise<MyVoucher | null> {
    const [row] = await this.sql<VoucherCampaignRow[]>`
      ${SELECT_VOUCHER(this.sql)} WHERE v.id = ${voucherId} AND v.claimed_by = ${accountId}`;
    if (!row) return null;
    return toMine(row, (await this.redemptionsOf([row], accountId)).get(row.id) ?? [], this.now());
  }

  private async redemptionsOf(rows: readonly VoucherCampaignRow[], accountId: string): Promise<Map<string, VoucherRedemption[]>> {
    const out = new Map<string, VoucherRedemption[]>();
    if (rows.length === 0) return out;
    const found = await this.sql<RedemptionRow[]>`
      SELECT reward_key, period, amount::text AS amount, state, reason, ledger_tx_id, posted_at, created_at
      FROM campaigns.reward_intents
      WHERE account_id = ${accountId} AND campaign_id IN ${this.sql([...new Set(rows.map((r) => r.campaign_id))])}
        AND left(period, 8) = 'voucher:'`;
    for (const r of found) {
      const [, voucherId, n] = r.period.split(':') as [string, string, string];
      const list = out.get(voucherId) ?? [];
      list.push({
        sequence: Number(n),
        amount: decimalOf(r.amount),
        createdAt: r.created_at.toISOString(),
        reward: {
          rewardKey: r.reward_key,
          state: r.state,
          reason: r.reason,
          ledgerTxId: r.ledger_tx_id,
          postedAt: r.posted_at ? r.posted_at.toISOString() : null,
        },
      });
      out.set(voucherId, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.sequence - b.sequence);
    return out;
  }
}

function toMine(v: VoucherCampaignRow, redemptions: VoucherRedemption[], now: Date): MyVoucher {
  const face = parseAmount(v.face_amount);
  const used = parseAmount(v.used_amount);
  const expired = v.state === 'expired' || (used < face && v.use_by !== null && v.use_by <= now);
  return {
    id: v.id,
    code: v.code,
    campaignId: v.campaign_id,
    campaignName: v.campaign_name,
    // Read from the sum, so a redemption the ledger refused gives its part back to the voucher.
    state: expired ? 'expired' : used === 0n ? 'claimed' : used >= face ? 'used' : 'partially_used',
    face: { asset: v.face_asset, amount: formatAmount(face) },
    used: formatAmount(used),
    remaining: formatAmount(face - used),
    claimedAt: v.claimed_at!.toISOString(),
    useBy: v.use_by!.toISOString(),
    expiredAt: v.expired_at ? v.expired_at.toISOString() : null,
    redemptions,
  };
}
