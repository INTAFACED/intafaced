import type { Column, ReadSpec } from '@/lib/ops-desk/types';

/**
 * Operator customer search (OPS-rules-monitoring-11, ops-console-rules-monitoring-056), over identity's own
 * `accountDirectory.search`: an exact email or the start of a handle, a page at a time with identity's page marker. Identity
 * audits every search (as a hash of the term) and masks every email; this console keeps nothing.
 */

export type AccountSearchTerm = { readonly kind: 'email'; readonly value: string } | { readonly kind: 'handle'; readonly value: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Identity's own handle shape (`users_handle_check`); a prefix outside it could never match. */
const HANDLE = /^[A-Za-z0-9_]{3,32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** What the operator typed, as identity takes it: an address is an exact email, anything else the start of a handle. */
export function searchTerm(raw: string): AccountSearchTerm | { readonly error: string } {
  const value = raw.trim();
  if (value.includes('@')) {
    return value.length <= 320 && EMAIL.test(value)
      ? { kind: 'email', value: value.toLowerCase() }
      : { error: 'That is not a whole email address.' };
  }
  if ([...value].length < 3) return { error: 'Type at least the first three characters of a handle, or a whole email address.' };
  return HANDLE.test(value) ? { kind: 'handle', value } : { error: 'A handle has only letters, digits and underscores.' };
}

export function searchCursor(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  return CURSOR.test(raw) ? raw : undefined;
}

const col = (key: string, label: string, kind: Column['kind'], extra: Partial<Column> = {}): Column => ({ key, label, kind, ...extra });

export function accountSearchSpec(term: AccountSearchTerm, cursor: string | null): ReadSpec {
  return {
    id: 'identity.account-search',
    title: term.kind === 'email' ? 'Accounts with this email' : `Handles starting with “${term.value}”`,
    note:
      term.kind === 'email'
        ? 'Matched on the whole email address. Identity shows the email masked and logs that you searched.'
        : 'Matched on the start of the handle, oldest account first. Identity logs that you searched.',
    module: 'identity',
    plainName: 'identity’s account search',
    procedure: 'accountDirectory.search',
    input: { [term.kind]: term.value, ...(cursor === null ? {} : { cursor }) },
    shape: 'list',
    rowsKey: 'rows',
    idKey: 'id',
    cursorKey: 'nextCursor',
    columns: [
      col('handle', 'Handle', 'text'),
      col('emailMasked', 'Email (masked)', 'text'),
      col('status', 'Status', 'text'),
      col('kycTier', 'Verification', 'text'),
      col('restrictedAreas', 'Restricted', 'list'),
      col('created', 'Signed up', 'time'),
      col('id', 'Account id', 'text', { detail: true }),
    ],
    emptyText: term.kind === 'email' ? 'No account has this email address.' : 'No handle starts with these characters.',
    forbiddenText: 'Identity did not accept your founder session for this search (it needs admin:compliance on a signed-in session).',
    refusals: {
      'identity.handle_prefix_short': 'Identity needs at least the first three characters of a handle.',
      'identity.account_search_unset': 'Identity needs either an email or the start of a handle, not both.',
      'identity.search_cursor_invalid': 'Identity did not issue this page marker. Search again from the first page.',
    },
  };
}
