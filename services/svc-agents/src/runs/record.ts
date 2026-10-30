import { AgentError, MeteredReplayError } from '../errors.js';
import { RefusedError, type ThinkResult } from '../runtime.js';
import { RunTransitionError } from './machine.js';
import type { RunStore, StoredRun } from './store.js';

/** How long a `running` run is left to its caller before a retry with the same request id may take it over. */
export const RUN_LEASE_MS = 300_000;

const ENGINE_FAILURES: ReadonlySet<string> = new Set(['agents.provider_unavailable', 'agents.provider_failed']);

/**
 * Runs one engine call as a stored run (AG-sessions-01, ENGINE RS-1 to RS-4), in this order:
 * 1. the run row is written first, in its own transaction (`admitted`);
 * 2. it moves to `running`, then the call runs (admission, engine, meter and audit, unchanged);
 * 3. it ends `completed` with the reply and the metered cost, `refused` with the platform's typed code, or `failed`
 *    when the engine did not answer.
 *
 * If this crashes exactly here:
 * - before the row: nothing exists;
 * - after the row and before the call: the run reads `admitted` (or `running`), and a retry with the same request id
 *   continues it, a `running` one once its lease has passed;
 * - after the call and before the run is marked: the meter has the usage and the run reads `running`; a retry past
 *   the lease is refused by the runtime's existing `agents.request_id_replay` from that usage row, which never bills
 *   twice, and adopts the run: it ends `completed` and metered, with that code on its event, because the call was
 *   charged once into the session window. Its reply and cost were not kept (the reply reads empty, the cost blank);
 *   the window and the ledger hold the charge. A replay refused only on the claim (a call that died before it was
 *   metered) billed nothing, so that run ends `refused`.
 *
 * A second request with the same id while the run is live (`running` inside its lease, or waiting) and a repeat of a
 * `completed` run are not recorded again: the runtime decides that call exactly as before (a metered repeat is refused
 * as a replay), and the stored run stays as it was. Two retries racing for one resumable run (an admitted, failed or
 * refused one, or a running one past its lease): the second is refused with `agents.run_transition_invalid` before it
 * calls anything. The same request id asked for another agent or task is refused as `agents.request_id_replay`.
 */
export async function runRecorded(
  store: RunStore,
  input: { userId: string; sessionId: string; agentId: string; requestId: string; task: string; assetId: string },
  call: () => Promise<ThinkResult>,
  now: () => number = Date.now,
): Promise<{ result: ThinkResult; run: StoredRun }> {
  const { run, admitted } = await store.admit(input);
  // One request id names one request: a stored run asked for another agent or task is a replay, refused before anything
  // runs, so the stored run never describes a call that was not made.
  if (!admitted && (run.agentId !== input.agentId || run.task !== input.task)) {
    throw new AgentError(
      `Request id "${input.requestId}" already names another request on session ${input.sessionId}`,
      'agents.request_id_replay',
      'agents.error.request_id_replay',
      { requestId: input.requestId },
    );
  }
  let running: StoredRun | null;
  let tookOver = false;
  if (run.state === 'admitted' || run.state === 'failed' || run.state === 'refused') {
    running = await store.move(run.id, 'running');
  } else if (run.state === 'running' && now() - Date.parse(run.updatedAt) > RUN_LEASE_MS) {
    // The lease passed; the race for it is the database's, and a loser is refused before it calls anything.
    running = await store.takeOver(run.id, new Date(now() - RUN_LEASE_MS));
    if (!running) throw new RunTransitionError('running', 'running');
    tookOver = true;
  } else {
    running = null;
  }
  if (!running) return { result: await call(), run };

  let result: ThinkResult;
  try {
    result = await call();
  } catch (err) {
    // A guardrail refusal carries its own typed code; any other platform refusal is its error code. An engine that did
    // not answer is a failure, not a decision: it billed nothing and the same request id may run again (RS-4).
    const code = err instanceof RefusedError ? err.refusal.code : err instanceof AgentError ? err.code : null;
    // A run taken over after its lease whose request id the meter already holds was charged by the call before the
    // crash: it is adopted as that charged call, never recorded as a refusal that billed nothing.
    const charged = tookOver && err instanceof MeteredReplayError;
    const failed = code === null || ENGINE_FAILURES.has(code);
    await store
      .move(running.id, charged ? 'completed' : failed ? 'failed' : 'refused', {
        ...(code ? { code } : {}),
        ...(charged ? { metered: true } : {}),
      })
      // The caller's error is the answer; a run left `running` is taken over by a retry once its lease has passed.
      .catch(() => undefined);
    throw err;
  }
  const completed = await store
    .move(running.id, 'completed', {
      reply: result.text,
      cost: result.cost,
      assetId: input.assetId,
      metered: result.metered,
      actionId: result.action.id,
    })
    // The usage is metered and the reply is the person's: a failed mark leaves the run `running` and still answers.
    // Money-safe: the meter's unique (session, request id) row means a retry never bills again, and a retry past the
    // lease adopts the run as completed and metered (above).
    .catch(() => running);
  return { result, run: completed };
}
