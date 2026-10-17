/**
 * Boot after the journal is readable: replay, confirm holds, then listen.
 * A startup publish that still times out returns exit 1 and does not listen.
 */
import type { MatchingEngine } from './engine/engine.js';
import { enforceReplayHolds, type ReplayHoldGate, type ReplayHoldLookup } from './replay-hold.js';
import { StartupPublishError } from './startup-publish.js';

export interface OpenAfterReplayResult {
  readonly exit: 0 | 1;
  readonly listened: boolean;
  readonly message?: string;
  readonly gate?: ReplayHoldGate;
  readonly recovered?: { records: number; markets: number };
}

export async function openAfterReplay(options: {
  readonly engine: MatchingEngine;
  readonly holds: ReplayHoldLookup;
  readonly listen: () => Promise<void>;
}): Promise<OpenAfterReplayResult> {
  try {
    const recovered = await options.engine.recover();
    const gate = await enforceReplayHolds(options.engine, options.holds);
    options.engine.finishStartupAnnounce();
    await options.listen();
    return { exit: 0, listened: true, gate, recovered };
  } catch (err) {
    if (err instanceof StartupPublishError) {
      return { exit: 1, listened: false, message: err.message };
    }
    throw err;
  }
}
