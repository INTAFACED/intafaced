import { MemorySeenStore, idempotent, type EventBus, type SeenStore, type Subscription } from '@intafaced/events';
import type { LiveRuns } from './quant/live-run/live-runs.js';
import type { AgentOrders } from './venue/agent-orders.js';
import type { OwnAgentTrading } from './venue/own-agent-trading.js';

/**
 * The owner froze their own account (J-wallet-13 #1, `selfFreezeApplied`, svc-identity's event). svc-trade keeps three
 * kinds of agent permission for a person, and revokes every one of them at once, not on the next supervisor pass:
 *   · each live strategy run's agent permission (its orders stop, open orders cancelled once, the position kept);
 *   · each assistant connection and the venue agent key of each open agent account (#12's revoke);
 *   · each own-agent allowance.
 * Every part is safe to repeat (each moves only from the state it expects), and the handler is idempotent by the event's
 * business key (`identity.self_freeze.frozen:<freezeId>`), so a twice-delivered event is one revoke. Each part runs even
 * when another fails; any failure throws after all three tried, so the event is delivered again and the rest finished.
 * The doors still read the freeze themselves before they act, so a late or lost event never lets an action through.
 * Nothing is restored on the lift. Moves no money.
 */
export interface SelfFreezeConsumers {
  readonly liveRuns: Pick<LiveRuns, 'applySelfFreeze'> | null;
  readonly agentOrders: Pick<AgentOrders, 'applySelfFreeze'> | null;
  readonly ownAgentTrading: Pick<OwnAgentTrading, 'applySelfFreeze'> | null;
}

async function applySelfFreeze(consumers: SelfFreezeConsumers, userId: string): Promise<void> {
  const parts: Array<Promise<unknown> | undefined> = [
    consumers.liveRuns?.applySelfFreeze(userId),
    consumers.agentOrders?.applySelfFreeze(userId),
    consumers.ownAgentTrading?.applySelfFreeze(userId),
  ];
  const failed = (await Promise.allSettled(parts)).filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(
      `the owner's freeze of ${userId} is not finished here (${failed.length} part${failed.length === 1 ? '' : 's'} failed: ${failed
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join('; ')}); the event is delivered again`,
    );
  }
}

export async function subscribeSelfFreeze(
  bus: EventBus,
  consumers: SelfFreezeConsumers,
  store: SeenStore = new MemorySeenStore(),
): Promise<Subscription> {
  return bus.subscribe(
    'selfFreezeApplied',
    idempotent(async (payload) => applySelfFreeze(consumers, payload.userId), store, 'svc-trade'),
    { durable: 'trade-self-freeze' },
  );
}
