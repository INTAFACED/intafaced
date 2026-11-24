import { recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { ledgerRefusalCode } from './builder-fee-poster.js';

/**
 * COLLECT: THE BUILDER FEES THE VENUE PAYS US (J-derivatives-17; launch money model, rule 5; project-state OWNER.md item
 * 288). For every claim the venue itself records for our builder address, post one `builderFeeReceive`, keyed on the
 * venue's own id for that claim (`builder-fee-payout:<venueId>:<claimId>`), so a claim read twice posts once. What the
 * venue owes us comes down by the claim; our builder account at the venue (an own-funds place) goes up by it.
 *
 * The venue's own claim record is the only source. Nothing here infers a claim from our earned total, so "earned" and
 * "collected" stay two figures. The reader is the venue adapter's `builderClaims` (wire.ts `claimReader`); an adapter
 * without that read has no reader, and a run reports `waiting` with its reason: nothing is posted, and nothing is made up.
 *
 * - A claim for any builder address other than ours is never posted, and is counted as not ours.
 * - A crash after a post is safe: the next run reads the claim again and the ledger returns the same transaction.
 * - A refusal that belongs to the claim itself (an asset the ledger doesn't know, an entry it can't take) is listed with its
 *   code, and the next run tries it again. Any other failure (the posting freeze, an idempotency conflict, an outage) stops
 *   the run, as the fee poster does.
 */
export interface BuilderFeeClaim {
  /** The venue's own id for the claim. */
  readonly claimId: string;
  /** The builder address the venue paid. */
  readonly builder: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly claimedAt: Date;
}

/** The venue adapter's read of the claims it records for a builder address. */
export interface BuilderFeeClaimReader {
  readonly venueId: string;
  claims(builder: string): Promise<readonly BuilderFeeClaim[]>;
}

export interface BuilderFeeCollectDeps {
  /** `null` when the venue adapter does not read the builder's claim record. */
  readonly reader: BuilderFeeClaimReader | null;
  /** Our builder address at the venue (`TRADE_USER_VENUE_BUILDER_ADDRESS`); blank refuses to run. */
  readonly builder: string;
  readonly ledger: Pick<LedgerClient, 'post'>;
}

export type BuilderFeeCollectRun =
  | { readonly status: 'waiting'; readonly reason: 'trade.builder_fee_claim_read_missing' | 'trade.builder_address_unset' }
  | {
      readonly status: 'ran';
      readonly venueId: string;
      /** Claims the venue recorded, ours or not. */
      readonly read: number;
      readonly posted: number;
      readonly notOurs: number;
      readonly refused: readonly { readonly claimId: string; readonly code: string }[];
    };

export async function collectBuilderFees(deps: BuilderFeeCollectDeps): Promise<BuilderFeeCollectRun> {
  const builder = deps.builder.trim().toLowerCase();
  if (builder === '') return { status: 'waiting', reason: 'trade.builder_address_unset' };
  if (deps.reader === null) return { status: 'waiting', reason: 'trade.builder_fee_claim_read_missing' };
  const venueId = deps.reader.venueId;
  const claims = await deps.reader.claims(builder);
  let posted = 0;
  let notOurs = 0;
  const refused: { claimId: string; code: string }[] = [];
  for (const claim of claims) {
    if (claim.builder.trim().toLowerCase() !== builder) {
      notOurs += 1;
      continue;
    }
    try {
      await deps.ledger.post(recipes.builderFeeReceive({ venueId, claimId: claim.claimId, assetId: claim.assetId, amount: claim.amount }));
      posted += 1;
    } catch (error) {
      const code = ledgerRefusalCode(error);
      if (code === null) throw error;
      refused.push({ claimId: claim.claimId, code });
    }
  }
  return { status: 'ran', venueId, read: claims.length, posted, notOurs, refused };
}
