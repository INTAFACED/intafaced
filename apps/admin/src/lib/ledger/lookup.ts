/**
 * The ledger object lookup on the console (J-ops-console-03, OPS-rules-monitoring-12): one booked transaction by its id,
 * or the transaction a business key booked. Plain data and parsers, safe in server and browser code.
 *
 * svc-ledger answers as the founder (`admin:read` with a second factor, owner decision 2026-10-23) and records the lookup
 * under the founder before it reads. Amounts stay decimal strings end to end: nothing here turns money into a number.
 */

/** Any UUID, as svc-edge and svc-ledger check it (zod `uuid()`), so no id the ledger accepts is refused here. */
export const LOOKUP_TX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LOOKUP_KEY_MAX = 512;
const DECIMAL = /^-?\d+(\.\d{1,18})?$/;

export interface LedgerPosting {
  readonly entryId: string;
  readonly accountId: string;
  readonly assetId: string;
  readonly direction: 'debit' | 'credit';
  /** Decimal string, as svc-ledger booked it. */
  readonly amount: string;
  /** The account's balance after this posting, decimal string. */
  readonly balanceAfter: string;
}

export interface LedgerTransaction {
  readonly txId: string;
  readonly businessKey: string;
  readonly module: string;
  readonly reason: string;
  readonly postedAt: string;
  readonly hash: string;
  readonly previousHash: string | null;
  readonly postings: readonly LedgerPosting[];
}

export type LedgerLookupAnswer =
  { readonly found: true; readonly transaction: LedgerTransaction } | { readonly found: false; readonly businessKey: string };

export type LedgerLookupQuery = { readonly txId: string } | { readonly businessKey: string };

const str = (value: unknown): value is string => typeof value === 'string';

function parsePosting(raw: unknown): LedgerPosting | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!str(p.entryId) || !str(p.accountId) || !str(p.assetId)) return null;
  if (p.direction !== 'debit' && p.direction !== 'credit') return null;
  if (!str(p.amount) || !DECIMAL.test(p.amount) || !str(p.balanceAfter) || !DECIMAL.test(p.balanceAfter)) return null;
  return {
    entryId: p.entryId,
    accountId: p.accountId,
    assetId: p.assetId,
    direction: p.direction,
    amount: p.amount,
    balanceAfter: p.balanceAfter,
  };
}

/** One booked transaction as svc-ledger's lookup answers it, or null when the body is not that shape. */
export function parseLedgerTransaction(raw: unknown): LedgerTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!str(t.txId) || !str(t.businessKey) || !str(t.module) || !str(t.reason) || !str(t.hash)) return null;
  if (!str(t.postedAt) || Number.isNaN(Date.parse(t.postedAt))) return null;
  if (t.previousHash !== null && !str(t.previousHash)) return null;
  if (!Array.isArray(t.postings) || t.postings.length === 0) return null;
  const postings = t.postings.map(parsePosting);
  if (postings.some((p) => p === null)) return null;
  return {
    txId: t.txId,
    businessKey: t.businessKey,
    module: t.module,
    reason: t.reason,
    postedAt: t.postedAt,
    hash: t.hash,
    previousHash: t.previousHash,
    postings: postings as LedgerPosting[],
  };
}

/**
 * svc-ledger's answer to a query: a transaction by id must be that id; a trace is `found: false` for a key that never
 * booked, or the transaction booked under exactly that key. Anything else is null, so nothing is shown rather than a guess.
 */
export function parseLookupAnswer(query: LedgerLookupQuery, raw: unknown): LedgerLookupAnswer | null {
  if ('txId' in query) {
    const transaction = parseLedgerTransaction(raw);
    return transaction && transaction.txId.toLowerCase() === query.txId.toLowerCase() ? { found: true, transaction } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.found === false) return r.businessKey === query.businessKey ? { found: false, businessKey: query.businessKey } : null;
  if (r.found !== true) return null;
  const transaction = parseLedgerTransaction(raw);
  return transaction && transaction.businessKey === query.businessKey ? { found: true, transaction } : null;
}

/** The query a founder typed, checked the way svc-ledger checks it, or null with nothing sent. */
export function lookupQuery(mode: 'txId' | 'businessKey', typed: string): LedgerLookupQuery | null {
  if (mode === 'txId') {
    const id = typed.trim().toLowerCase();
    return LOOKUP_TX_ID.test(id) ? { txId: id } : null;
  }
  const key = typed.trim();
  return key.length > 0 && key.length <= LOOKUP_KEY_MAX ? { businessKey: key } : null;
}

/** What a refused lookup means, in words. The code is shown beside it. */
export function lookupRefusal(code: string | null, status: number): string {
  switch (code) {
    case 'ledger.tx_not_found':
      return 'No transaction has that id.';
    case 'ledger.lookup_unrecorded':
      return 'The ledger could not record this lookup, so it did not read it. Nothing was shown.';
    case 'ledger.lookup_unavailable':
      return 'The lookup was recorded, but the ledger could not answer it. Try again.';
    case 'ledger.lookup_input_invalid':
    case 'edge.invalid_ledger_lookup':
      return 'A transaction id is a UUID; a business key is 1 to 512 characters.';
    case 'edge.ledger_unreachable':
      return 'This console’s edge has no ledger address, so no lookup can be made.';
    case 'mfa.required':
      return 'A lookup needs a sign-in with a second factor. Sign in again.';
    case 'scope.denied':
    case 'admin.authority_refused':
      return 'This sign-in does not carry what a ledger lookup needs: a founder’s read permission with a second factor.';
    case 'admin.upstream_invalid':
      return 'The ledger answered with a shape this console does not recognise, so nothing is shown rather than a guess.';
    case 'admin.upstream_unavailable':
      return 'The ledger did not answer in time. Nothing is shown.';
    default:
      return `The lookup was refused (${status}).`;
  }
}
