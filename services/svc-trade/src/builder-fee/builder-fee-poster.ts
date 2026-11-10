import { recipes, type LedgerClient } from '@intafaced/ledger-client';
import { VenueRefusalError, type UserVenue, type UserVenueAccount } from '@intafaced/venue-contracts';
import { builderFeeVenueAccount, type BuilderFeeStop, type BuilderFeeStore } from './builder-fee-store.js';

/**
 * THE BUILDER-FEE POSTER (D-venue-07; J-derivatives-17; OWNER 288 changes 1a to 1c). It reads our users' fills from the
 * venue and posts `builderFeeEarn` for every fill of an order of ours whose builder fee is above zero, keyed on the venue,
 * the venue account and the venue's own fill id, so a fill read twice posts once, and the two sides of one trade, each
 * one of our accounts, post twice. It never posts a customer's fill, margin or balance: the venue is the record of those
 * (OWNER 226, 237).
 *
 * - A crash after a post and before the store records it is safe: the next run reads the fill again and the ledger
 *   returns the same transaction under the key. A fill the store already holds as posted is not sent again.
 * - A fill with a zero builder fee posts nothing and is not recorded.
 * - A fill with a builder fee on an order our door did not store and sign for that account (the customer also trades
 *   through another front end, whose fee the venue reports the same way) is recorded as `not_our_order` and never posted.
 * - A refusal that belongs to the fill itself (a fee asset the ledger doesn't know, an entry it can't take) is recorded
 *   as refused with its code, so the recon lists the fill as unposted; the next run tries it again. Any other failure
 *   (the posting freeze, an idempotency conflict, an outage) stops the run, to be retried whole on the next tick. The stop
 *   is recorded and handed to `onStop` with the venue, the account and the fill it stopped at, then thrown.
 * - An account the venue refuses to read is skipped and named in the run; the other accounts are still posted. A run
 *   that read every account is complete, and its time is recorded for the operations desk.
 */
export interface BuilderFeePosterDeps {
  readonly venue: () => Promise<UserVenue>;
  readonly ledger: Pick<LedgerClient, 'post'>;
  readonly store: BuilderFeeStore;
  /** Among these client order ids, the orders our door stored for this account with our fee and signed (prepared-action-store.ts). */
  readonly ourOrders: (venueId: string, account: UserVenueAccount, venueClientOrderIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Raised once per stopped run: the alert (OWNER 288 change 1c). Must not throw. */
  readonly onStop?: (stop: BuilderFeeStop) => void;
  readonly now: () => Date;
}

export interface BuilderFeePosterRun {
  readonly venueId: string;
  readonly accounts: number;
  readonly posted: number;
  readonly refused: number;
  /** Fills with a builder fee on an order that is not ours: recorded, never posted. */
  readonly notOurOrder: number;
  /** Accounts the venue refused to read this run, with its refusal code. */
  readonly unread: readonly { readonly owner: string; readonly subAccount: string | null; readonly code: string }[];
  /** True when every account was read and every fill posted or recorded. */
  readonly complete: boolean;
}

/** The ledger refusals that belong to one fill. Anything else is about the ledger as a whole and stops the run. */
export const FILL_REFUSALS: ReadonlySet<string> = new Set(['ledger.asset_unknown', 'ledger.invalid_entry']);

/** The code of a refusal that belongs to the fill, or null for anything else, which must stop the run. */
export function ledgerRefusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FILL_REFUSALS.has(code) ? code : null;
}

/** A poster run that stopped, with where it stopped. The original failure is its `cause`. */
export class BuilderFeePosterStopped extends Error {
  constructor(
    readonly stop: BuilderFeeStop,
    options: { cause: unknown },
  ) {
    super(
      `builder-fee poster stopped on ${stop.venueId}` +
        (stop.venueAccount ? ` at account ${stop.venueAccount}` : '') +
        (stop.fillId ? `, fill ${stop.fillId}` : '') +
        `: ${stop.code}: ${stop.message}`,
      options,
    );
    this.name = 'BuilderFeePosterStopped';
  }
}

function stopCode(error: unknown): string {
  if (error instanceof VenueRefusalError) return `venue.${error.refusal.code}`;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export async function postBuilderFees(deps: BuilderFeePosterDeps): Promise<BuilderFeePosterRun> {
  // Where the run is, so a stop names the venue, the account and the fill it reached.
  const at: { venueId: string | null; venueAccount: string | null; fillId: string | null } = {
    venueId: null,
    venueAccount: null,
    fillId: null,
  };
  try {
    const run = await postAll(deps, at);
    if (run.complete) await deps.store.markComplete(run.venueId, deps.now());
    return run;
  } catch (error) {
    const stop: BuilderFeeStop = {
      venueId: at.venueId ?? 'unknown',
      venueAccount: at.venueAccount,
      fillId: at.fillId,
      code: stopCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
    // The stop is the alert; recording it is best effort, and never hides the failure that stopped the run.
    if (at.venueId !== null) {
      try {
        await deps.store.markStopped(stop, deps.now());
      } catch {
        // The alert below still names the stop.
      }
    }
    deps.onStop?.(stop);
    throw new BuilderFeePosterStopped(stop, { cause: error });
  }
}

async function postAll(
  deps: BuilderFeePosterDeps,
  at: { venueId: string | null; venueAccount: string | null; fillId: string | null },
): Promise<BuilderFeePosterRun> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  at.venueId = venueId;
  const accounts = await deps.store.accounts(venueId);
  let posted = 0;
  let refused = 0;
  let notOurOrder = 0;
  const unread: { owner: string; subAccount: string | null; code: string }[] = [];
  for (const { userId, account, since } of accounts) {
    const venueAccount = builderFeeVenueAccount(account);
    at.venueAccount = venueAccount;
    at.fillId = null;
    let fills;
    try {
      fills = (await venue.fills(account, since)).value;
    } catch (error) {
      if (!(error instanceof VenueRefusalError) || error.refusal.code === 'venue_down') throw error;
      unread.push({ owner: account.owner, subAccount: account.subAccount, code: `venue.${error.refusal.code}` });
      continue;
    }
    // Posted and not-our-order fills of this account are settled; a refused one is tried again.
    const done = new Set(
      (await deps.store.inPeriod(venueId, since, FAR_FUTURE))
        .filter(
          (r) =>
            (r.status === 'posted' || r.status === 'not_our_order') &&
            r.account.owner === account.owner &&
            r.account.subAccount === account.subAccount,
        )
        .map((r) => r.fillId),
    );
    const todo = fills.filter((fill) => fill.builderFee > 0n && !done.has(fill.fillId));
    const clientIds = [...new Set(todo.map((f) => f.venueClientOrderId).filter((id): id is string => id !== null))];
    const ours = await deps.ourOrders(venueId, account, clientIds);
    for (const fill of todo) {
      at.fillId = fill.fillId;
      const base = {
        venueId,
        fillId: fill.fillId,
        userId,
        account,
        assetId: fill.feeAsset,
        amount: fill.builderFee,
        filledAt: fill.filledAt,
      };
      if (fill.venueClientOrderId === null || !ours.has(fill.venueClientOrderId)) {
        await deps.store.record({ ...base, status: 'not_our_order', refusalCode: null, ledgerTxId: null }, deps.now());
        notOurOrder += 1;
        continue;
      }
      try {
        const tx = await deps.ledger.post(
          recipes.builderFeeEarn({ venueId, venueAccount, fillId: fill.fillId, assetId: fill.feeAsset, amount: fill.builderFee, userId }),
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
  return { venueId, accounts: accounts.length, posted, refused, notOurOrder, unread, complete: unread.length === 0 };
}
