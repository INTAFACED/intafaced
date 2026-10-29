import type { EvaluationFeedPort } from './feed-client.js';
import type { ReconciliationAlertStore } from './store.js';

const PAGE = 200;
const MAX_PAGES = 5;

/**
 * One feed tick: reads the ledger's settled evaluations from the stored cursor and takes each one into the alert store.
 * A failed read is recorded as the source being unavailable and the cursor stays, so the next tick reads the same rows
 * again; a run already taken is skipped, so nothing counts twice. A run that cannot be stored is recorded the same way.
 */
export async function ingestReconciliationEvaluations(store: ReconciliationAlertStore, feed: EvaluationFeedPort): Promise<number> {
  let taken = 0;
  let after = await store.cursor();
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
    await store.recordRead(read.value.next);
    if (read.value.evaluations.length < PAGE) break;
    after = read.value.next;
  }
  return taken;
}
