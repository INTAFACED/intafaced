import { railBalanceSnapshotSchema } from '@intafaced/contracts/ledger-reconciliation';
import { type ReconciliationSources, type SnapshotRead, unsetReconciliationSources } from './reconciliation-controls.js';

/** How long one outside read may take before the run records the source as unavailable. */
export const OUTSIDE_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * The outside side of an outside-balance control (OPS-reconciliation-01/-02). With no snapshot URL (the owner has published
 * no rail snapshot) the outside side is `unset`. With one, each run reads `GET <url>?asOf=<instant>` and expects a rail
 * balance snapshot; a refused connection, a timeout, a redirect, a non-200 answer, a body that is not a snapshot or a
 * snapshot dated after the instant asked for is `unavailable`, which the run records as ERROR
 * (`ledger.reconcile_source_unavailable`), never PASS. An earlier snapshot is used, and its own as-of is stored with the
 * run, so the gap is on the record. Source parity stays unset.
 */
export function reconciliationSourcesFrom(
  outsideSnapshotUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = OUTSIDE_SNAPSHOT_TIMEOUT_MS,
): ReconciliationSources {
  const unset = unsetReconciliationSources();
  if (!outsideSnapshotUrl) return unset;
  return {
    parity: unset.parity,
    outsideBalance: async (readAt: Date): Promise<SnapshotRead> => {
      const url = new URL(outsideSnapshotUrl);
      url.searchParams.set('asOf', readAt.toISOString());
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (res.status !== 200) {
          await res.body?.cancel();
          return { kind: 'unavailable' };
        }
        const snapshot = railBalanceSnapshotSchema.safeParse(await res.json());
        if (!snapshot.success || Date.parse(snapshot.data.asOf) > readAt.getTime()) return { kind: 'unavailable' };
        return { kind: 'snapshot', asOf: snapshot.data.asOf, balances: snapshot.data.balances };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
