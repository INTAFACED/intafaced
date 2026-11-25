import type { Amount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import type { TwapParent } from './types.js';
import type { TwapParentStore } from './parent-store.js';

/** In-memory algo engine surface used by hydrate-on-mutate. */
export interface AlgoHydrateTarget {
  get(parentId: string): TwapParent | undefined;
  hydrate(parent: TwapParent, plan: readonly Amount[]): void;
  planOf(parentId: string): readonly Amount[] | undefined;
}

/**
 * Load a durable algo parent into the engine if this process does not already
 * hold it. Same owner check as `getAlgo`: missing or wrong user → not_found
 * (never hydrate a stranger). Pause/resume/cancel after restart must not 404
 * a schedule that Postgres still has for this caller.
 */
export async function hydrateAlgoIfMissing(
  engine: AlgoHydrateTarget,
  store: TwapParentStore,
  userId: string,
  parentId: string,
): Promise<TwapParent> {
  let parent = engine.get(parentId);
  if (!parent) {
    const loaded = await store.load(parentId);
    if (loaded && loaded.parent.userId === userId) {
      engine.hydrate(loaded.parent, loaded.plan);
      parent = loaded.parent;
    }
  }
  if (!parent || parent.userId !== userId) {
    throw new TradeError(`algo ${parentId} not found`, 'trade.algo_not_found');
  }
  return parent;
}

/**
 * Job-host hydrate: load by parent id with no caller principal. Tick after
 * restart reinstalls the durable createTwap place grant (not a minted userId).
 */
export async function hydrateAlgoFromStore(engine: AlgoHydrateTarget, store: TwapParentStore, parentId: string): Promise<void> {
  if (engine.get(parentId)) return;
  const loaded = await store.load(parentId);
  if (!loaded) {
    throw new TradeError(`algo ${parentId} not found`, 'trade.algo_not_found');
  }
  engine.hydrate(loaded.parent, loaded.plan);
}

/** Await the durable write after pause/resume/cancel (onChange is fire-and-forget). */
export async function persistAlgoMutation(engine: AlgoHydrateTarget, store: TwapParentStore, parent: TwapParent): Promise<TwapParent> {
  const plan = engine.planOf(parent.id) ?? [];
  await store.save({ parent, plan });
  return parent;
}

/** Await the durable write of an amend: the store's amend write, never read as a second create. */
export async function persistAlgoAmend(engine: AlgoHydrateTarget, store: TwapParentStore, parent: TwapParent): Promise<TwapParent> {
  const plan = engine.planOf(parent.id) ?? [];
  await store.saveAmend({ parent, plan });
  return parent;
}

export interface AlgoCancelTarget extends AlgoHydrateTarget {
  cancel(userId: string, parentId: string): Promise<TwapParent>;
}

/**
 * Cancel then await durable save. Child-cancel failure parks the parent
 * paused (`cancel_incomplete`) in memory first — persist that park before
 * rethrowing so `listActive` / restart tick cannot keep the parent tradable.
 */
export async function persistAlgoCancelAttempt(
  engine: AlgoCancelTarget,
  store: TwapParentStore,
  userId: string,
  parentId: string,
): Promise<TwapParent> {
  try {
    const cancelled = await engine.cancel(userId, parentId);
    return await persistAlgoMutation(engine, store, cancelled);
  } catch (err) {
    const live = engine.get(parentId);
    if (live) await persistAlgoMutation(engine, store, live);
    throw err;
  }
}
