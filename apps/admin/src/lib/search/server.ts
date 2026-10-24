import 'server-only';
import { accountSearchSpec } from '@/lib/account-search/search';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';
import { readLedgerLookup, type LedgerLookupOutcome } from '@/lib/ledger/lookup-server';
import { isModuleEnabled } from '@/lib/modules';
import { PAY_TRANSFER_DETAIL } from '@/lib/ops-desk/catalog';
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
  readonly ledger: Section<{ readonly kind: 'lookup'; readonly outcome: LedgerLookupOutcome; readonly readAt: string }>;
  readonly payments: Section<
    | { readonly kind: 'transfer'; readonly spec: ReadSpec; readonly outcome: ReadOutcome }
    | { readonly kind: 'not-asked'; readonly why: string }
  >;
}

/**
 * Asks every desk at once, as the signed-in founder. Each read settles on its own: `loadRead` and `readLedgerLookup` never
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
    const outcome = await readLedgerLookup(founder, plan.ledger.query);
    return { kind: 'lookup', outcome, readAt: new Date().toISOString() };
  };
  const payments = async (): Promise<SearchAnswer['payments']> => {
    if (!isModuleEnabled('pay-ops')) return { kind: 'module-off', module: 'pay-ops' };
    if (plan.payments.kind !== 'transfer') return plan.payments;
    const spec: ReadSpec = { ...PAY_TRANSFER_DETAIL, input: { id: plan.payments.id } };
    return { kind: 'transfer', spec, outcome: await loadRead(founder, spec) };
  };
  const [a, l, p] = await Promise.all([accounts(), ledger(), payments()]);
  return { plan, accounts: a, ledger: l, payments: p };
}
