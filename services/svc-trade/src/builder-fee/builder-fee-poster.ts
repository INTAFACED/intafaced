import { recipes, type LedgerClient } from '@intafaced/ledger-client';
import { VenueRefusalError, type UserVenue } from '@intafaced/venue-contracts';
import type { BuilderFeeStore } from './builder-fee-store.js';

/**
 * THE BUILDER-FEE POSTER (D-venue-07; J-derivatives-17). It reads our users' fills from the venue and posts
 * `builderFeeEarn` for every fill whose builder fee is above zero, keyed on the venue's own fill id, so a fill read twice
 * posts once. It never posts a customer's fill, margin or balance: the venue is the record of those (OWNER 226, 237).
 *
 * - A crash after a post and before the store records it is safe: the next run reads the fill again and the ledger
 *   returns the same transaction under the key. A fill the store already holds as posted is not sent again.
 * - A fill with a zero builder fee posts nothing and is not recorded.
 * - A refusal that belongs to the fill itself (a fee asset the ledger doesn't know, an entry it can't take) is recorded
 *   as refused with its code, so the recon lists the fill as unposted; the next run tries it again. Any other failure
 *   (the posting freeze, an idempotency conflict, an outage) stops the run, to be retried whole on the next tick.
 * - An account the venue refuses to read is skipped and named in the run; the other accounts are still posted.
 */
export interface BuilderFeePosterDeps {
  readonly venue: () => Promise<UserVenue>;
  readonly ledger: Pick<LedgerClient, 'post'>;
  readonly store: BuilderFeeStore;
  readonly now: () => Date;
}

export interface BuilderFeePosterRun {
  readonly venueId: string;
  readonly accounts: number;
  readonly posted: number;
  readonly refused: number;
  /** Accounts the venue refused to read this run, with its refusal code. */
  readonly unread: readonly { readonly owner: string; readonly subAccount: string | null; readonly code: string }[];
}

/** The ledger refusals that belong to one fill. Anything else is about the ledger as a whole and stops the run. */
export const FILL_REFUSALS: ReadonlySet<string> = new Set(['ledger.asset_unknown', 'ledger.invalid_entry']);

/** The code of a refusal that belongs to the fill, or null for anything else, which must stop the run. */
export function ledgerRefusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FILL_REFUSALS.has(code) ? code : null;
}

const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export async function postBuilderFees(deps: BuilderFeePosterDeps): Promise<BuilderFeePosterRun> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const accounts = await deps.store.accounts(venueId);
  let posted = 0;
  let refused = 0;
  const unread: { owner: string; subAccount: string | null; code: string }[] = [];
  for (const { userId, account, since } of accounts) {
    let fills;
    try {
      fills = (await venue.fills(account, since)).value;
    } catch (error) {
      if (!(error instanceof VenueRefusalError) || error.refusal.code === 'venue_down') throw error;
      unread.push({ owner: account.owner, subAccount: account.subAccount, code: `venue.${error.refusal.code}` });
      continue;
    }
    const done = new Set(
      (await deps.store.inPeriod(venueId, since, FAR_FUTURE))
        .filter((r) => r.status === 'posted' && r.account.owner === account.owner && r.account.subAccount === account.subAccount)
        .map((r) => r.fillId),
    );
    for (const fill of fills) {
      if (fill.builderFee <= 0n || done.has(fill.fillId)) continue;
      const base = {
        venueId,
        fillId: fill.fillId,
        userId,
        account,
        assetId: fill.feeAsset,
        amount: fill.builderFee,
        filledAt: fill.filledAt,
      };
      try {
        const tx = await deps.ledger.post(
          recipes.builderFeeEarn({ venueId, fillId: fill.fillId, assetId: fill.feeAsset, amount: fill.builderFee, userId }),
        );
        await deps.store.record({ ...base, status: 'posted', refusalCode: null, ledgerTxId: tx.id }, deps.now());
        posted += 1;
      } catch (error) {
        const code = ledgerRefusalCode(error);
        if (code === null) throw error;
        await deps.store.record({ ...base, status: 'refused', refusalCode: code, ledgerTxId: null }, deps.now());
        refused += 1;
      }
    }
  }
  return { venueId, accounts: accounts.length, posted, refused, unread };
}
