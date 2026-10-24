import { searchTerm, type AccountSearchTerm } from '@/lib/account-search/search';
import { LOOKUP_KEY_MAX, LOOKUP_TX_ID, type LedgerLookupQuery } from '@/lib/ledger/lookup';
import { transferIdOf } from '@/lib/ops-desk/transfer-id';

/**
 * The console's cross-desk search (OPS-payments-desk-01, ops-console-payments-desk-016): one box that asks each desk that can
 * answer, as the signed-in founder, and shows each desk's answer on its own. Nothing here reads another service's tables or
 * keeps a copy: every section is that service's own operator read, and a desk that cannot answer refuses in its own section
 * while the others still show. Plain data, safe in server and browser code.
 *
 * What one term asks:
 * - Accounts (identity): a whole email or the start of a handle goes to identity's account search; an account id opens that
 *   customer's record. Anything else is not something identity searches, and the section says so.
 * - Ledger: a UUID is a transaction id; anything else of 1 to 512 characters is traced as a business key.
 * - Payments: a term that could be a transfer id reads that transfer's record from svc-bank. Search by payment reference has
 *   no source yet (svc-pay has no founder-wide payment search), and the section names that blocker.
 */

export const SEARCH_MAX = LOOKUP_KEY_MAX;
const UUID = LOOKUP_TX_ID;

/** The code each section that cannot answer carries, beside the service's own code when it gave one. */
export const SEARCH_SOURCE_UNAVAILABLE = 'ops.search_source_unavailable';

export type AccountsPlan =
  | { readonly kind: 'search'; readonly term: AccountSearchTerm }
  | { readonly kind: 'record'; readonly userId: string }
  | { readonly kind: 'not-asked'; readonly why: string };

export type LedgerPlan = { readonly kind: 'lookup'; readonly query: LedgerLookupQuery };

export type PaymentsPlan = { readonly kind: 'transfer'; readonly id: string } | { readonly kind: 'not-asked'; readonly why: string };

export interface SearchPlan {
  readonly q: string;
  readonly accounts: AccountsPlan;
  readonly ledger: LedgerPlan;
  readonly payments: PaymentsPlan;
}

/** Search by payment reference, which no service can answer yet. Shown on every search, never hidden. */
export const PAYMENT_REFERENCE_UNWIRED = {
  id: 'payments.reference',
  label: 'Payments by reference',
  reason:
    'svc-pay has no founder-wide payment search (pay.payments.search, OPS-payments-desk-01), so a provider reference, an email or a key is not looked up across payments. A transfer id is read from svc-bank below.',
} as const;

/** The term as typed, trimmed, or an error in words when there is nothing to search. */
export function searchQuery(raw: string | null | undefined): { readonly q: string } | { readonly error: string } {
  const q = (raw ?? '').trim();
  if (q === '') return { error: 'Type an email, a handle, an account or transaction id, or a business key.' };
  if (q.length > SEARCH_MAX) return { error: `A search is at most ${SEARCH_MAX} characters.` };
  if (/\p{Cc}/u.test(q)) return { error: 'A search has no control characters.' };
  return { q };
}

/** What each desk is asked for one term. */
export function searchPlan(q: string): SearchPlan {
  const uuid = UUID.test(q);
  const term = uuid ? null : searchTerm(q);
  const accounts: AccountsPlan = uuid
    ? { kind: 'record', userId: q.toLowerCase() }
    : term && !('error' in term)
      ? { kind: 'search', term }
      : {
          kind: 'not-asked',
          why: `Identity was not asked: it searches a whole email or the start of a handle. ${term && 'error' in term ? term.error : ''}`.trim(),
        };
  const ledger: LedgerPlan = { kind: 'lookup', query: uuid ? { txId: q.toLowerCase() } : { businessKey: q } };
  const transfer = accounts.kind === 'search' && accounts.term.kind === 'email' ? null : transferIdOf(q);
  const payments: PaymentsPlan = transfer
    ? { kind: 'transfer', id: transfer }
    : {
        kind: 'not-asked',
        why:
          accounts.kind === 'search' && accounts.term.kind === 'email'
            ? 'An email address is not a transfer id, so svc-bank was not asked for a transfer record.'
            : 'A transfer id is 8 to 64 characters, so this is not one and svc-bank was not asked for a transfer record.',
      };
  return { q, accounts, ledger, payments };
}

/** Where a found ledger transaction opens on the ledger desk, with the lookup run again there (a new, recorded read). */
export function ledgerHref(query: LedgerLookupQuery): string {
  return 'txId' in query
    ? `/ledger?txId=${encodeURIComponent(query.txId)}`
    : `/ledger?businessKey=${encodeURIComponent(query.businessKey)}`;
}

/** The ledger desk's lookup to run on opening, from `/ledger?txId=` or `/ledger?businessKey=`; null when none is asked. */
export function ledgerQueryFromParams(params: Readonly<Record<string, string | string[] | undefined>>): LedgerLookupQuery | null {
  const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value.trim() : null);
  const txId = one(params.txId);
  if (txId && UUID.test(txId)) return { txId: txId.toLowerCase() };
  const key = one(params.businessKey);
  if (key && key.length <= LOOKUP_KEY_MAX) return { businessKey: key };
  return null;
}
