import type { ReconciliationEvaluationCursor } from '@intafaced/contracts/ledger-reconciliation';
import type { EvaluationFeedPort } from './feed-client.js';
import type { ReconciliationAlertStore } from './store.js';

const PAGE = 200;
const MAX_PAGES = 5;
/**
 * Each tick reads again from this far behind its cursor. The ledger's settle window is a clock bound, not commit order,
 * so a run whose commit stalled past it can land behind a cursor already passed; the overlap reads it once, and a run
 * already taken is skipped by its id.
 */
export const FEED_OVERLAP_MS = 120_000;
const NIL_ID = '00000000-0000-0000-0000-000000000000';

/** A cursor's place in (finishedAt, id) order, with the fraction padded to microseconds so it compares as text. */
function place(cursor: ReconciliationEvaluationCursor): string {
  const iso = new Date(cursor.finishedAt).toISOString().slice(0, 19);
  const fraction = /\.(\d+)/.exec(cursor.finishedAt)?.[1] ?? '';
  return `${iso}.${fraction.padEnd(6, '0').slice(0, 6)}|${cursor.id}`;
}

function later(a: ReconciliationEvaluationCursor | null, b: ReconciliationEvaluationCursor | null) {
  if (!a) return b;
  if (!b) return a;
  return place(b) > place(a) ? b : a;
}

/**
 * One feed tick: reads the ledger's settled evaluations from the stored cursor and takes each one into the alert store.
 * A failed read is recorded as the source being unavailable and the cursor stays, so the next tick reads the same rows
 * again; each tick starts FEED_OVERLAP_MS behind the cursor and a run already taken is skipped, so nothing is missed
 * and nothing counts twice. A run that cannot be stored is recorded the same way.
 */
export async function ingestReconciliationEvaluations(store: ReconciliationAlertStore, feed: EvaluationFeedPort): Promise<number> {
  let taken = 0;
  const stored = await store.cursor();
  let at = stored;
  let after: ReconciliationEvaluationCursor | null = stored
    ? { finishedAt: new Date(Date.parse(stored.finishedAt) - FEED_OVERLAP_MS).toISOString(), id: NIL_ID }
    : null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await feed.read({ after, limit: PAGE });
    if (!read.ok) {
      await store.recordFailure(read.message);
      return taken;
    }
    for (const evaluation of read.value.evaluations) {
      try {
        if (await store.ingest(evaluation)) taken++;
      } catch {
        // A row this service cannot store holds the cursor and shows on every answer, never as a healthy source.
        await store.recordFailure(`svc-ops could not store evaluation ${evaluation.run.id}. It reads it again on the next tick.`);
        return taken;
      }
    }
    // The overlap reads behind the cursor; the stored cursor only ever moves forward.
    at = later(at, read.value.next);
    await store.recordRead(at);
    if (read.value.evaluations.length < PAGE) break;
    after = read.value.next;
  }
  return taken;
}
