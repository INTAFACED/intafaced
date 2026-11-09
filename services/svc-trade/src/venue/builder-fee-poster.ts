import { recipes, type LedgerClient } from '@intafaced/ledger-client';
import type { UserVenue } from '@intafaced/venue-contracts';
import type { BuilderFeeStore } from './builder-fee-store.js';

/**
 * THE BUILDER-FEE POSTER (D-venue-07; J-derivatives-17). It reads our users' fills from the venue and posts
 * `builderFeeEarn` for every fill whose builder fee is above zero, keyed on the venue's own fill id, so a fill read twice
 * posts once. It never posts a customer's fill, margin or balance: the venue is the record of those (OWNER 226, 237).
 *
 * - A crash after a post and before the store records it is safe: the next run reads the fill again and the ledger
 *   returns the same transaction under the key.
 * - A fill with a zero builder fee posts nothing and is not recorded.
 * - A ledger refusal (a fee asset the ledger doesn't know, `ledger.asset_unknown`) is recorded as refused with its code,
 *   so the recon lists the fill as unposted; the next run tries it again. Any other failure stops the run, to be retried
 *   whole on the next tick.
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
}

const LEDGER_REFUSAL = /^ledger\.[a-z0-9_.]+$/;

/** A typed ledger refusal's code, or null for anything else (an outage, a bug), which must stop the run. */
export function ledgerRefusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && LEDGER_REFUSAL.test(code) ? code : null;
}

export async function postBuilderFees(deps: BuilderFeePosterDeps): Promise<BuilderFeePosterRun> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const accounts = await deps.store.accounts(venueId);
  let posted = 0;
  let refused = 0;
  for (const { userId, account, since } of accounts) {
    const fills = (await venue.fills(account, since)).value;
    for (const fill of fills) {
      if (fill.builderFee <= 0n) continue;
      const base = { venueId, fillId: fill.fillId, userId, account, assetId: fill.feeAsset, amount: fill.builderFee, filledAt: fill.filledAt };
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
  return { venueId, accounts: accounts.length, posted, refused };
}
