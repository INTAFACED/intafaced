import 'server-only';
import { accountSearchSpec } from '@/lib/account-search/search';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';
import { readLedgerLookup, type LedgerLookupOutcome } from '@/lib/ledger/lookup-server';
import { isModuleEnabled } from '@/lib/modules';
import { loadRead } from '@/lib/ops-desk/server';
import type { ReadOutcome, ReadSpec } from '@/lib/ops-desk/types';
import type { SearchPlan } from './cross-search';

/** A section whose console module is switched off on this deployment is not asked, and says so. */
export type Section<T> = T | { readonly kind: 'module-off'; readonly module: string };

export interface SearchAnswer {
  readonly plan: SearchPlan;
  readonly accounts: Section<
    | { readonly kind: 'search'; readonly spec: ReadSpec; readonly outcome: ReadOutcome }
    | { readonly kind: 'record'; readonly userId: string }
    | { readonly kind: 'not-asked'; readonly why: string }
  >;
  readonly ledger: Section<
    | { readonly kind: 'lookup'; readonly outcome: LedgerLookupOutcome; readonly readAt: string }
    | { readonly kind: 'not-asked'; readonly why: string }
  >;
  /** Not read here: svc-bank logs every transfer record it hands out, so the page reads one only when the founder asks. */
  readonly payments: Section<SearchPlan['payments']>;
}

/**
 * Asks identity and the ledger at once, as the signed-in founder. Each read settles on its own: `loadRead` and `readLedgerLookup` never
 * throw, so one service down or refusing never blanks another section.
 */
export async function crossSearch(
  founder: { readonly session: FounderSession; readonly config: AdminSessionConfig },
  plan: SearchPlan,
): Promise<SearchAnswer> {
  const accounts = async (): Promise<SearchAnswer['accounts']> => {
    if (!isModuleEnabled('accounts')) return { kind: 'module-off', module: 'accounts' };
    if (plan.accounts.kind !== 'search') return plan.accounts;
    const spec = accountSearchSpec(plan.accounts.term, null);
    return { kind: 'search', spec, outcome: await loadRead(founder, spec) };
  };
  const ledger = async (): Promise<SearchAnswer['ledger']> => {
    if (!isModuleEnabled('ledger')) return { kind: 'module-off', module: 'ledger' };
    if (plan.ledger.kind !== 'lookup') return plan.ledger;
    const outcome = await readLedgerLookup(founder, plan.ledger.query);
    return { kind: 'lookup', outcome, readAt: new Date().toISOString() };
  };
  const payments: SearchAnswer['payments'] = isModuleEnabled('pay-ops') ? plan.payments : { kind: 'module-off', module: 'pay-ops' };
  const [a, l] = await Promise.all([accounts(), ledger()]);
  return { plan, accounts: a, ledger: l, payments };
}
