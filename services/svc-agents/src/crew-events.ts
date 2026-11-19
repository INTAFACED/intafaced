/**
 * crewMemberCreated → agents crew channel open. NOT WIRED — nothing calls this.
 *
 * `index.ts` connects to NATS and builds a bus, and it has never called
 * `subscribeCrewMemberCreated`. Nothing imports this file except its own unit
 * test, so no crew channel is opened by this code; `MemoryCrewChannelOpener` is
 * a process-local `Map`.
 *
 * This file was nevertheless counted as closing ADR D-S-13's `crewMemberCreated`
 * Class B defect, because `event-wiring` matched the TEXT of `bus.subscribe(…)`,
 * and the catalog's honest socket entry was deleted on that basis. The gate now
 * decides wiring by reachability from the entrypoint, and this file is not
 * reachable, so it counts for nothing and the socket entry is back.
 *
 * Unlike the svc-academy half, this one is a two-line mount away: `index.ts`
 * already has the bus. It is left undone deliberately — ADR D-S-13 puts BOTH
 * named consumers on the owner, and half a close is how the description gets
 * quietly rewritten to match whichever half shipped. It is recorded as Class B
 * in `WIRING_SOCKETS` (packages/events/src/catalog.ts).
 */

import { MemorySeenStore, idempotent, type EventBus, type SeenStore, type Subscription } from '@intafaced/events';

export type CrewChannel = {
  readonly crewId: string;
  readonly userId: string;
  readonly role: string;
  readonly openedAt: Date;
};

export class MemoryCrewChannelOpener {
  private readonly channels = new Map<string, CrewChannel>();

  open(input: { crewId: string; userId: string; role: string; now?: Date }): CrewChannel {
    const key = `${input.crewId}:${input.userId}`;
    const existing = this.channels.get(key);
    if (existing) return existing;
    const row: CrewChannel = {
      crewId: input.crewId,
      userId: input.userId,
      role: input.role,
      openedAt: input.now ?? new Date(),
    };
    this.channels.set(key, row);
    return row;
  }

  channelOf(crewId: string, userId: string): CrewChannel | null {
    return this.channels.get(`${crewId}:${userId}`) ?? null;
  }

  list(): CrewChannel[] {
    return [...this.channels.values()];
  }
}

export async function subscribeCrewMemberCreated(
  bus: EventBus,
  opener: MemoryCrewChannelOpener,
  store: SeenStore = new MemorySeenStore(),
): Promise<Subscription> {
  return bus.subscribe(
    'crewMemberCreated',
    idempotent(
      async (payload) => {
        opener.open({
          crewId: payload.crewId,
          userId: payload.userId,
          role: payload.role,
        });
      },
      store,
      'svc-agents-crew-channel',
    ),
    { durable: 'agents-crew-member-created' },
  );
}
