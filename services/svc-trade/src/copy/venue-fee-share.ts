/**
 * THE LEAD'S SHARE OF OUR BUILDER FEE ON A VENUE COPY (J-copy-bots-otc-06 #1 #3; the launch money model: we pay lead traders
 * a share of our fee from our own money, never from a customer balance).
 *
 * A copy placed on the follower's own venue sub-account (venue-copy.ts) is an order of ours, so the venue charges our
 * builder fee on its fills (a spot sell, or either side of a perpetual) and the builder-fee poster books it earned
 * (`builderFeeEarn`, keyed by the venue, the sub-account and the venue's fill id). The lead is owed a share of that fee, at
 * the owner's rate (`TRADE_COPY_FEE_SHARE_LAW`). The share is INTAFACED's own liability to the lead: it is never charged
 * to the follower on top of the fees the venue reports, never a customer balance in our book, and never a share of profit.
 *
 * One run, with no call by anyone (svc-trade's job host, after the builder-fee poster and collect):
 *
 *   1 record  every copied venue fill carrying our builder fee whose Earn the ledger holds at the venue's amount gets one
 *             row in `copy_settled_fee_shares`: the fill, the lead, the asset, the fee and the share at the owner's rate
 *             (with its cap per follower and its decay), counted against the pair's cap in the same transaction. A fill
 *             whose Earn is not on the ledger yet waits for the poster.
 *   2 fund    each claim the venue records for our builder address whose Receive the ledger holds at the claim's amount
 *             sets aside, once (`feeShareBudgetFund`, keyed by the claim), the recorded shares of fills made by the claim's
 *             time that no claim has covered yet, oldest first, as many whole shares as the claim covers. The plan (its
 *             amount and its rows) is stored before the post, so a retry posts the same body under the same key.
 *   3 owe     each recorded share whose set-aside is posted is owed to the lead (`feeShareOwe`, keyed by the fill's Earn
 *             key and the lead), and the row is marked settled with the ledger's transaction.
 *
 * Paying what is owed to the lead's own wallet once per period (#7) reads the owed rows and posts `feeSharePayOut`; it is
 * not this run's.
 *
 * Whose funds are stranded if it crashes exactly here? Nobody's. Every leg is one of our own accounts (house builder-fee
 * revenue, the venue's fee-share budget, what we owe the lead). A crash after a post and before its row is marked repeats
 * the post next run under the same key, and the ledger returns the first transaction. A crash after a row is recorded and
 * before anything is posted leaves the row waiting, and the next run carries it on. A plan stored and not posted is posted
 * next run. A share the budget cannot cover (`ledger.insufficient_funds`) stays unowed and is tried again; nothing posts to
 * make it fit.
 *
 * Checks the recipes cannot make themselves (fee-share-owed.ts header): the claim a set-aside names was posted at that
 * amount (read from the ledger by its key), and what is shared on the fill so far: a copied fill's fee is shared with its
 * lead only (one row per fill, unique), so the lead's share is the first and only one on it.
 */
import {
  builderFeePayoutKey,
  earnedBuilderFeeKey,
  mul,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import type { UserVenueAccount, UserVenueFill } from '@intafaced/venue-contracts';
import type { BuilderFeeClaimReader } from '../builder-fee/builder-fee-collect.js';
import { attributeCopyFeeShare, type FeeShareAttribution } from './fee-share.js';
import type { CopyFeeShareLaw } from './fee-share-law.js';

/** The one recipient of a copied fill's fee share. */
const LEAD_RECIPIENT_KIND = 'lead-trader' as const;

/** A fill one of our venue copies made on the follower's sub-account. */
export interface VenueCopyFill {
  readonly followId: string;
  readonly followerId: string;
  readonly leaderId: string;
  /** The lead's fill the copy was made for (venue-copy.ts `venueLeaderFillId`). */
  readonly leaderFillId: string;
  readonly feeShareKilled: boolean;
  readonly venueId: string;
  /** The earn key's account part (builder-fee-store.ts `builderFeeVenueAccount`): `<owner>/<subAccount>`. */
  readonly venueAccount: string;
  readonly account: UserVenueAccount;
  readonly fill: UserVenueFill;
}

/** The row id a venue fill's fee share is stored under (`copy_settled_fee_shares.fill_id`, unique). */
export function venueFeeShareRowId(venueId: string, venueAccount: string, venueFillId: string): string {
  return `${venueId}:${venueAccount}:${venueFillId}`;
}

/** The ledger key the lead's share on one venue fill is owed under (ledger-client `feeShareOwe`). */
export function venueFeeShareOweKey(fill: {
  readonly venueId: string;
  readonly venueAccount: string;
  readonly venueFillId: string;
  readonly leaderId: string;
}): string {
  return `fee-share:${earnedBuilderFeeKey(fill.venueId, fill.venueAccount, fill.venueFillId)}:${LEAD_RECIPIENT_KIND}:${fill.leaderId}`;
}

/** The ledger key of one claim's set-aside for fee shares (ledger-client `feeShareBudgetFund`). */
export function venueFeeShareFundKey(venueId: string, claimId: string): string {
  return `fee-share:budget-fund:${venueId}:${claimId}`;
}

/** One stored venue fee share, as the run reads it back. */
export interface VenueShareRow {
  readonly rowId: string;
  readonly followId: string;
  readonly leaderId: string;
  readonly venueId: string;
  readonly venueAccount: string;
  readonly venueFillId: string;
  readonly assetId: string;
  /** Our builder fee on the fill, as the venue charged it and the Earn booked it. */
  readonly feeEarned: Amount;
  readonly appliedShareBps: number;
  /** What the lead is owed on the fill. */
  readonly amount: Amount;
  readonly filledAt: Date;
  readonly claimId: string | null;
}

export interface FundPlan {
  readonly venueId: string;
  readonly claimId: string;
  readonly assetId: string;
  readonly claimAmount: Amount;
  readonly amount: Amount;
  readonly status: 'planned' | 'posted';
}

export interface NewVenueShare {
  readonly rowId: string;
  readonly followId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly leaderFillId: string;
  readonly venueId: string;
  readonly venueAccount: string;
  readonly venueFillId: string;
  readonly assetId: string;
  readonly filledAt: Date;
}

/** Where the run keeps its rows (venue-fee-share-store.ts). */
export interface VenueFeeShareStore {
  /** The row ids among `rowIds` that are already recorded. */
  recorded(rowIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * Records one share once: reads the pair's period figures under a lock, computes the share with them, inserts the row
   * and counts it against the pair's cap, in one transaction. `exists` when the row was already there (nothing counted).
   */
  record(
    share: NewVenueShare,
    compute: (period: { earningsPaid: Amount; roundTrips: number }) => FeeShareAttribution,
  ): Promise<'recorded' | 'exists'>;
  /** The claim's set-aside plan, if one was made. */
  fundPlan(venueId: string, claimId: string): Promise<FundPlan | null>;
  /** Owed-but-unfunded shares above zero of one venue and asset, of fills made by `through`, oldest first. */
  unfunded(venueId: string, assetId: string, through: Date): Promise<VenueShareRow[]>;
  /** Stores the plan and names it on its rows, in one transaction; the plan already stored when another run got there first. */
  planFund(plan: FundPlan, rowIds: readonly string[]): Promise<FundPlan>;
  markFundPosted(venueId: string, claimId: string, ledgerTxId: string): Promise<void>;
  /** Shares above zero whose set-aside is posted and that are not owed yet. */
  owing(): Promise<VenueShareRow[]>;
  markOwed(rowId: string, ledgerTxId: string): Promise<void>;
}

export interface VenueFeeShareDeps {
  readonly law: CopyFeeShareLaw;
  readonly ledger: Pick<LedgerClient, 'post' | 'getTxByKey'>;
  readonly store: VenueFeeShareStore;
  /** Every fill of our venue copies, as the venue reports them. */
  readonly copyFills: () => Promise<readonly VenueCopyFill[]>;
  /** The venue's claim record for our builder address; `null` when the adapter reads none (nothing is funded). */
  readonly claims: BuilderFeeClaimReader | null;
  /** Our builder address at the venue. Blank: nothing is funded. */
  readonly builder: string;
}

export type VenueFeeShareRun =
  | { readonly status: 'waiting'; readonly reason: 'trade.copy_fee_share_blank' }
  | {
      readonly status: 'ran';
      readonly recorded: number;
      /** Copied fills with our fee whose Earn the ledger does not hold (yet), or holds at another amount. */
      readonly earnNotBooked: number;
      readonly killed: number;
      readonly funded: number;
      /** Claims whose Receive the ledger does not hold at the claim's amount: nothing is set aside from them. */
      readonly claimNotBooked: number;
      readonly owed: number;
      /** Shares the venue's budget could not cover: left unowed, tried again. */
      readonly budgetShort: number;
    };

/** The one debit of a transaction in `assetId`: what a recipe moved. `null` when it is not exactly one. */
function debitOf(tx: LedgerTx, assetId: string): Amount | null {
  const [only, ...more] = tx.entries.filter((e) => e.direction === 'debit' && e.assetId === assetId);
  return only && more.length === 0 ? only.amount : null;
}

const ledgerCode = (err: unknown): string | null =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : null;

export async function runVenueFeeShares(deps: VenueFeeShareDeps): Promise<VenueFeeShareRun> {
  // The share rate is the owner's number. Blank: nothing is recorded, set aside or owed (AGENTS.md floor 8).
  if (deps.law.published !== true) return { status: 'waiting', reason: 'trade.copy_fee_share_blank' };
  const law = deps.law;

  // 1 record
  const fills = (await deps.copyFills())
    .filter((c) => c.fill.builderFee > 0n)
    .map((c) => ({ c, rowId: venueFeeShareRowId(c.venueId, c.venueAccount, c.fill.fillId) }));
  const done = await deps.store.recorded(fills.map((f) => f.rowId));
  let recorded = 0;
  let earnNotBooked = 0;
  let killed = 0;
  for (const { c, rowId } of fills) {
    if (done.has(rowId)) continue;
    if (c.feeShareKilled) {
      killed += 1;
      continue;
    }
    const earn = await deps.ledger.getTxByKey(earnedBuilderFeeKey(c.venueId, c.venueAccount, c.fill.fillId));
    if (!earn || earn.reason !== 'trade.builder_fee.earned' || debitOf(earn, c.fill.feeAsset) !== c.fill.builderFee) {
      earnNotBooked += 1;
      continue;
    }
    const outcome = await deps.store.record(
      {
        rowId,
        followId: c.followId,
        leaderId: c.leaderId,
        followerId: c.followerId,
        leaderFillId: c.leaderFillId,
        venueId: c.venueId,
        venueAccount: c.venueAccount,
        venueFillId: c.fill.fillId,
        assetId: c.fill.feeAsset,
        filledAt: c.fill.filledAt,
      },
      (period) =>
        attributeCopyFeeShare({
          law,
          fillId: rowId,
          leaderId: c.leaderId,
          followerId: c.followerId,
          assetId: c.fill.feeAsset,
          followerFillNotional: mul(c.fill.amount, c.fill.price, 'floor'),
          protocolFeeBps: 0,
          fillFeeAmount: c.fill.builderFee,
          roundTripsThisPeriod: period.roundTrips,
          earningsPaidThisPeriod: period.earningsPaid,
          feeShareKilled: false,
        }),
    );
    if (outcome === 'recorded') recorded += 1;
  }

  // 2 fund
  let funded = 0;
  let claimNotBooked = 0;
  const builder = deps.builder.trim().toLowerCase();
  if (deps.claims && builder !== '') {
    const venueId = deps.claims.venueId;
    const claims = [...(await deps.claims.claims(builder))]
      .filter((c) => c.builder.trim().toLowerCase() === builder)
      .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime() || (a.claimId < b.claimId ? -1 : 1));
    for (const claim of claims) {
      let plan = await deps.store.fundPlan(venueId, claim.claimId);
      if (plan?.status === 'posted') continue;
      if (!plan) {
        const receive = await deps.ledger.getTxByKey(builderFeePayoutKey(venueId, claim.claimId));
        if (!receive || receive.reason !== 'trade.builder_fee.received' || debitOf(receive, claim.assetId) !== claim.amount) {
          claimNotBooked += 1;
          continue;
        }
        const rows = await deps.store.unfunded(venueId, claim.assetId, claim.claimedAt);
        const covered: VenueShareRow[] = [];
        let sum = 0n;
        for (const row of rows) {
          if (sum + row.amount > claim.amount) break;
          sum += row.amount;
          covered.push(row);
        }
        if (covered.length === 0) continue;
        plan = await deps.store.planFund(
          { venueId, claimId: claim.claimId, assetId: claim.assetId, claimAmount: claim.amount, amount: sum, status: 'planned' },
          covered.map((r) => r.rowId),
        );
        if (plan.status === 'posted') continue;
      }
      const tx = await deps.ledger.post(
        recipes.feeShareBudgetFund({
          venueId,
          claimId: plan.claimId,
          assetId: plan.assetId,
          claimAmount: plan.claimAmount,
          amount: plan.amount,
        }),
      );
      await deps.store.markFundPosted(venueId, plan.claimId, tx.id);
      funded += 1;
    }
  }

  // 3 owe
  let owed = 0;
  let budgetShort = 0;
  for (const row of await deps.store.owing()) {
    let tx: LedgerTx;
    try {
      tx = await deps.ledger.post(
        recipes.feeShareOwe({
          venueId: row.venueId,
          venueAccount: row.venueAccount,
          fillId: row.venueFillId,
          recipient: { kind: LEAD_RECIPIENT_KIND, userId: row.leaderId },
          assetId: row.assetId,
          feeEarned: row.feeEarned,
          rate: { bps: row.appliedShareBps },
          amount: row.amount,
          // The lead is the only one a copied fill's fee is shared with (one row per fill), so nothing is shared before.
          sharedSoFarOnFill: 0n,
        }),
      );
    } catch (err) {
      if (ledgerCode(err) === 'ledger.insufficient_funds') {
        budgetShort += 1;
        continue;
      }
      throw err;
    }
    await deps.store.markOwed(row.rowId, tx.id);
    owed += 1;
  }

  return { status: 'ran', recorded, earnNotBooked, killed, funded, claimNotBooked, owed, budgetShort };
}
