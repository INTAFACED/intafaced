import { payCustodyOpenItemsReplySchema, type ServiceCallRequest } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import {
  RECONCILIATION_ITEMS_MAX,
  railBalanceSnapshotSchema,
  railStatementSchema,
  reconciliationReconcilingItemSchema,
  type ReconciliationReconcilingItem,
} from '@intafaced/contracts/ledger-reconciliation';
import {
  type OpenItemsRead,
  type ReconciliationSources,
  type SnapshotRead,
  unsetReconciliationSources,
} from './reconciliation-controls.js';

/** How long one outside read may take before the run records the source as unavailable. */
export const OUTSIDE_SNAPSHOT_TIMEOUT_MS = 10_000;

type Parse = (body: unknown) => { asOf: string; balances: SnapshotRead['balances'] } | null;

/**
 * One outside read: `GET <url>` with the given query. A refused connection, a timeout, a redirect, a non-200 answer, a body
 * the parser refuses or a body dated after the instant asked for is `unavailable`, never a balance.
 */
async function readOutside(
  base: string,
  query: Record<string, string>,
  readAt: Date,
  parse: Parse,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SnapshotRead> {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { kind: 'unavailable' };
    }
    const read = parse(await res.json());
    if (!read || Date.parse(read.asOf) > readAt.getTime()) return { kind: 'unavailable' };
    return { kind: 'snapshot', asOf: read.asOf, balances: read.balances };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * The outside side of an outside-balance control (OPS-reconciliation-01/-02, per-rail controls OPS-reconciliation-04).
 *
 * A control over the whole outside book reads `GET <outsideSnapshotUrl>?asOf=<instant>` and expects a rail balance snapshot.
 * A control over one rail's boundary (`accountSet.rail`) reads only that rail's statement URL, `GET <url>?rail=<rail>&asOf=
 * <instant>`, and expects a rail statement naming that same rail; a statement for another rail is `unavailable`. With no URL
 * (the owner has published none) the side is `unset`, which the run records as UNSET, never zero; a rail control never falls
 * back to the whole-book snapshot. Any read that fails is `unavailable`, which the run records as ERROR
 * (`ledger.reconcile_source_unavailable`), never PASS. An earlier snapshot is used, and its own as-of is stored with the run,
 * so the gap is on the record. Amounts are taken as given, in the ledger's signed form. Source parity stays unset.
 */
export function reconciliationSourcesFrom(
  outsideSnapshotUrl: string | undefined,
  railStatementUrls: ReadonlyMap<string, string> = new Map(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = OUTSIDE_SNAPSHOT_TIMEOUT_MS,
  openItems?: OpenItemsSource,
): ReconciliationSources {
  const unset = unsetReconciliationSources();
  return {
    parity: unset.parity,
    openItems: async (rail: string, notAfter: Date): Promise<OpenItemsRead> => {
      const url = openItems?.urls.get(rail);
      if (!openItems || !url) return { kind: 'unset' };
      return readOpenItems(url, rail, notAfter, openItems.sign, fetchImpl, timeoutMs);
    },
    outsideBalance: async (readAt: Date): Promise<SnapshotRead> => {
      if (!outsideSnapshotUrl) return { kind: 'unset' };
      return readOutside(
        outsideSnapshotUrl,
        { asOf: readAt.toISOString() },
        readAt,
        (body) => {
          const snapshot = railBalanceSnapshotSchema.safeParse(body);
          return snapshot.success ? snapshot.data : null;
        },
        fetchImpl,
        timeoutMs,
      );
    },
    railStatement: async (readAt: Date, rail: string): Promise<SnapshotRead> => {
      const url = railStatementUrls.get(rail);
      if (!url) return { kind: 'unset' };
      return readOutside(
        url,
        { rail, asOf: readAt.toISOString() },
        readAt,
        (body) => {
          const statement = railStatementSchema.safeParse(body);
          return statement.success && statement.data.rail === rail ? statement.data : null;
        },
        fetchImpl,
        timeoutMs,
      );
    },
  };
}

/** Signs one call to svc-pay as svc-ledger (`serviceCallSigner`). */
export type OpenItemsSigner = (payload: string, request: ServiceCallRequest) => Record<string, string>;

export interface OpenItemsSource {
  /** `LEDGER_RECONCILE_OPEN_ITEMS_<RAIL>_URL`, per rail. A rail with none has no open items source: `unset`. */
  readonly urls: ReadonlyMap<string, string>;
  readonly sign: OpenItemsSigner;
}

const OPEN_ITEMS_PAGE = 200;

/** Adds one kind's amount and count under `key` (`<kind>:<asset>`, and `#<kind>:<asset>` for the count). */
function tally(into: Map<string, bigint>, key: string, amount: bigint, count: bigint): void {
  if (amount === 0n && count === 0n) return;
  into.set(key, (into.get(key) ?? 0n) + amount);
  into.set(`#${key}`, (into.get(`#${key}`) ?? 0n) + count);
}

/**
 * Every open item svc-pay lists for one rail (`POST <url>` signed as svc-ledger, `{ rail, offset, limit }`), page by page.
 * Each page is its own snapshot, so every page must carry the same `total` and `sums` and the items must add up to those
 * sums; anything else (a write between pages, a refused or failed call, a body the schema refuses, more than
 * RECONCILIATION_ITEMS_MAX items) is `unavailable`, never a partial list. Amounts are the rail-minus-ledger signed amounts.
 */
async function readOpenItems(
  url: string,
  rail: string,
  notAfter: Date,
  sign: OpenItemsSigner,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OpenItemsRead> {
  const items: ReconciliationReconcilingItem[] = [];
  let first: string | null = null;
  let total = 0;
  let net = new Map<string, bigint>();
  let byKind = new Map<string, bigint>();
  try {
    for (let offset = 0; offset === 0 || offset < total; offset += OPEN_ITEMS_PAGE) {
      const payload = JSON.stringify({ rail, offset, limit: OPEN_ITEMS_PAGE });
      const headers = sign(payload, { method: 'POST', url: new URL(url), contentType: 'application/json' });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return { kind: 'unavailable' };
      }
      const page = payCustodyOpenItemsReplySchema.safeParse(await res.json());
      if (!page.success) return { kind: 'unavailable' };
      const shape = JSON.stringify({ total: page.data.total, sums: page.data.sums });
      if (first === null) first = shape;
      else if (shape !== first) return { kind: 'unavailable' };
      total = page.data.total;
      net = new Map();
      byKind = new Map();
      for (const sum of page.data.sums) {
        net.set(sum.assetId, (net.get(sum.assetId) ?? 0n) + parseAmount(sum.net));
        tally(byKind, `held:${sum.assetId}`, parseAmount(sum.held), BigInt(sum.heldCount));
        tally(byKind, `reversal_unfunded:${sum.assetId}`, parseAmount(sum.reversalUnfunded), BigInt(sum.reversalUnfundedCount));
      }
      if (total > RECONCILIATION_ITEMS_MAX) return { kind: 'unavailable' };
      for (const item of page.data.items) {
        // Each item carries its kind's sign: held is rail-over-ledger (+amount), an uncovered reversal ledger-over-rail
        // (-amount). An item svc-pay saw after the statement's as-of is not in that statement: the two read different moments.
        const signed = item.kind === 'held' ? item.amount : `-${item.amount}`;
        if (item.signedAmount !== signed || parseAmount(item.amount) <= 0n) return { kind: 'unavailable' };
        if (Date.parse(item.detectedAt) > notAfter.getTime()) return { kind: 'unavailable' };
        const named = reconciliationReconcilingItemSchema.safeParse({
          source: 'svc-pay',
          id: item.depositId,
          kind: item.kind,
          assetId: item.assetId,
          amount: item.signedAmount,
        });
        if (!named.success) return { kind: 'unavailable' };
        items.push(named.data);
      }
      if (page.data.items.length === 0) break;
    }
  } catch {
    return { kind: 'unavailable' };
  }
  if (items.length !== total || new Set(items.map((item) => item.id)).size !== total) return { kind: 'unavailable' };
  // The named items must add up to the sums svc-pay stated, asset by asset, or the list is not the whole of them.
  const added = new Map<string, bigint>();
  for (const item of items) added.set(item.assetId, (added.get(item.assetId) ?? 0n) + parseAmount(item.amount));
  for (const assetId of new Set([...added.keys(), ...net.keys()])) {
    if ((added.get(assetId) ?? 0n) !== (net.get(assetId) ?? 0n)) return { kind: 'unavailable' };
  }
  // And kind by kind, in amount and in count, so two kinds can never swap behind a net that still adds up.
  const listed = new Map<string, bigint>();
  for (const item of items) {
    const amount = parseAmount(item.amount);
    tally(listed, `${item.kind}:${item.assetId}`, amount < 0n ? -amount : amount, 1n);
  }
  for (const key of new Set([...listed.keys(), ...byKind.keys()])) {
    if ((listed.get(key) ?? 0n) !== (byKind.get(key) ?? 0n)) return { kind: 'unavailable' };
  }
  return { kind: 'items', items };
}
