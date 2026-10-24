/**
 * The ledger desk's browsing reads on the console (J-ops-console-03 #1, #4, #5, OPS-ledger-desk-01): the transaction list
 * by asset and time with svc-ledger's own total and a cursor, the account address search with volumes and the balance
 * derived from them, and the book's counts. Plain data and parsers, safe in server and browser code.
 *
 * svc-ledger answers as the signed-in founder (`admin:read` with a second factor) and records each page of the list and of
 * the search under the founder before it reads. Every number here is the ledger's: counts and amounts stay strings end to
 * end, nothing is summed or counted in the browser, and an answer that is not the shape asked for is refused, not shown.
 */

export type LedgerDeskRead = 'transactions' | 'accounts' | 'stats';
export const LEDGER_DESK_READS: readonly LedgerDeskRead[] = ['transactions', 'accounts', 'stats'];

/** The query keys each read takes, as svc-edge forwards them. */
export const DESK_KEYS: Record<LedgerDeskRead, readonly string[]> = {
  transactions: ['assetId', 'from', 'to', 'before'],
  accounts: ['prefix', 'after'],
  stats: [],
};

const DECIMAL = /^-?\d+(\.\d{1,18})?$/;
const COUNT = /^\d+$/;
const SEQ_CURSOR = /^[1-9]\d{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OWNER_TYPES = ['user', 'subaccount', 'module', 'house', 'treasury'] as const;
/** `<owner type>:<first 1 to 128 characters of the owner id>`, as svc-ledger checks it. */
export const ADDRESS_PREFIX = new RegExp(`^(${OWNER_TYPES.join('|')}):(.{1,128})$`);

export interface DeskTransactionRow {
  readonly txId: string;
  readonly seq: string;
  readonly businessKey: string;
  readonly module: string;
  readonly reason: string;
  readonly postedAt: string;
  readonly assets: readonly string[];
  readonly postings: string;
}

export interface DeskTransactionPage {
  readonly total: string;
  readonly rows: readonly DeskTransactionRow[];
  readonly nextCursor: string | null;
}

export interface DeskAccountRow {
  readonly accountId: string;
  readonly address: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly assetId: string;
  readonly kind: string;
  readonly purpose: string;
  readonly debits: string;
  readonly credits: string;
  readonly balance: string;
  readonly postings: string;
}

export interface DeskAccountPage {
  readonly prefix: string;
  readonly accounts: readonly DeskAccountRow[];
  readonly nextCursor: string | null;
}

export interface DeskStats {
  readonly transactions: string;
  readonly postings: string;
  readonly accounts: string;
  readonly assets: string;
  readonly lastSeq: string | null;
  readonly lastPostedAt: string | null;
  readonly asOf: string;
}

export type LedgerDeskAnswer =
  | { readonly read: 'transactions'; readonly page: DeskTransactionPage }
  | { readonly read: 'accounts'; readonly page: DeskAccountPage }
  | { readonly read: 'stats'; readonly stats: DeskStats };

const str = (value: unknown): value is string => typeof value === 'string';
const time = (value: unknown): value is string => str(value) && !Number.isNaN(Date.parse(value));
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parseTxRow(raw: unknown): DeskTransactionRow | null {
  const r = obj(raw);
  if (!r) return null;
  if (!str(r.txId) || !UUID.test(r.txId) || !str(r.seq) || !SEQ_CURSOR.test(r.seq)) return null;
  if (!str(r.businessKey) || !str(r.module) || !str(r.reason) || !time(r.postedAt)) return null;
  if (!Array.isArray(r.assets) || !r.assets.every(str)) return null;
  if (!str(r.postings) || !COUNT.test(r.postings)) return null;
  return {
    txId: r.txId,
    seq: r.seq,
    businessKey: r.businessKey,
    module: r.module,
    reason: r.reason,
    postedAt: r.postedAt,
    assets: r.assets as string[],
    postings: r.postings,
  };
}

function parseAccountRow(raw: unknown, prefix: string): DeskAccountRow | null {
  const r = obj(raw);
  if (!r) return null;
  if (!str(r.accountId) || !UUID.test(r.accountId) || !str(r.ownerType) || !str(r.ownerId)) return null;
  if (!str(r.address) || r.address !== `${r.ownerType}:${r.ownerId}` || !r.address.startsWith(prefix)) return null;
  if (!str(r.assetId) || !str(r.kind) || !str(r.purpose) || !str(r.postings) || !COUNT.test(r.postings)) return null;
  for (const amount of [r.debits, r.credits, r.balance]) if (!str(amount) || !DECIMAL.test(amount)) return null;
  return {
    accountId: r.accountId,
    address: r.address,
    ownerType: r.ownerType,
    ownerId: r.ownerId,
    assetId: r.assetId,
    kind: r.kind,
    purpose: r.purpose,
    debits: r.debits as string,
    credits: r.credits as string,
    balance: r.balance as string,
    postings: r.postings,
  };
}

function parseStats(raw: unknown): DeskStats | null {
  const r = obj(raw);
  if (!r) return null;
  for (const count of [r.transactions, r.postings, r.accounts, r.assets]) if (!str(count) || !COUNT.test(count)) return null;
  if (r.lastSeq !== null && (!str(r.lastSeq) || !COUNT.test(r.lastSeq))) return null;
  if (r.lastPostedAt !== null && !time(r.lastPostedAt)) return null;
  if (!time(r.asOf)) return null;
  return {
    transactions: r.transactions as string,
    postings: r.postings as string,
    accounts: r.accounts as string,
    assets: r.assets as string,
    lastSeq: r.lastSeq,
    lastPostedAt: r.lastPostedAt,
    asOf: r.asOf,
  };
}

/** svc-ledger's answer to one desk read, or null when the body is not that shape. */
export function parseDeskAnswer(read: LedgerDeskRead, query: Readonly<Record<string, string>>, raw: unknown): LedgerDeskAnswer | null {
  if (read === 'stats') {
    const stats = parseStats(raw);
    return stats ? { read, stats } : null;
  }
  const r = obj(raw);
  if (!r) return null;
  if (read === 'transactions') {
    if (!str(r.total) || !COUNT.test(r.total) || !Array.isArray(r.rows)) return null;
    if (r.nextCursor !== null && (!str(r.nextCursor) || !SEQ_CURSOR.test(r.nextCursor))) return null;
    const rows = r.rows.map(parseTxRow);
    if (rows.some((row) => row === null)) return null;
    return { read, page: { total: r.total, rows: rows as DeskTransactionRow[], nextCursor: r.nextCursor } };
  }
  const prefix = query.prefix ?? '';
  if (!str(r.prefix) || r.prefix !== prefix || !Array.isArray(r.accounts)) return null;
  if (r.nextCursor !== null && (!str(r.nextCursor) || !UUID.test(r.nextCursor))) return null;
  const accounts = r.accounts.map((row) => parseAccountRow(row, prefix));
  if (accounts.some((row) => row === null)) return null;
  return { read, page: { prefix, accounts: accounts as DeskAccountRow[], nextCursor: r.nextCursor } };
}

/**
 * The query a founder asked for, checked the way svc-ledger checks it, or null with nothing sent. Empty values are
 * dropped (no filter); a key the read does not take refuses.
 */
export function deskQuery(read: LedgerDeskRead, given: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const query: Record<string, string> = {};
  for (const [key, raw] of Object.entries(given)) {
    if (!DESK_KEYS[read].includes(key)) return null;
    const value = (raw ?? '').trim();
    if (value !== '') query[key] = value;
  }
  if (read === 'transactions') {
    if (query.assetId !== undefined && query.assetId.length > 32) return null;
    for (const key of ['from', 'to'] as const) if (query[key] !== undefined && !time(query[key])) return null;
    if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to)) return null;
    if (query.before !== undefined && !SEQ_CURSOR.test(query.before)) return null;
  }
  if (read === 'accounts') {
    if (query.prefix === undefined || !ADDRESS_PREFIX.test(query.prefix)) return null;
    if (query.after !== undefined && !UUID.test(query.after)) return null;
  }
  return query;
}

/** The query as a search string, keys in the read's own order. */
export function deskSearch(read: LedgerDeskRead, query: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const key of DESK_KEYS[read]) if (query[key] !== undefined) params.set(key, query[key]);
  return params.toString();
}

/** A browser's `datetime-local` value as the ISO instant it names in this browser's time zone, or '' when blank or not a time. */
export function localToIso(value: string): string {
  if (value.trim() === '') return '';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}
