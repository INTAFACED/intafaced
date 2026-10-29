import { railBalanceSnapshotSchema, railStatementSchema } from '@intafaced/contracts/ledger-reconciliation';
import { type ReconciliationSources, type SnapshotRead, unsetReconciliationSources } from './reconciliation-controls.js';

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
): ReconciliationSources {
  const unset = unsetReconciliationSources();
  return {
    parity: unset.parity,
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
