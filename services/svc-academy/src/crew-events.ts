/**
 * crewMemberCreated → academy lobby route. NOT WIRED. NOT A CLASS B CLOSE.
 *
 * This header used to say "(ADR D-S-13 Class B close)" and it was false. Nothing
 * imports this file except its own unit test: `index.ts` has never referenced it,
 * and — read that file's header — svc-academy holds NO BUS CONNECTION AT ALL, so
 * `subscribeCrewMemberCreated` could not attach even if something did import it.
 * `MemoryCrewLobbyRouter` below is a process-local `Map`; no lobby is routed
 * anywhere by this code.
 *
 * It was nevertheless enough to make `event-wiring` report the event as wired —
 * that gate matched the TEXT of `bus.subscribe(…)` — and on that basis the honest
 * `crewMemberCreated` socket entry was deleted from the catalog. The gate now
 * decides wiring by reachability from the service entrypoint, so this file counts
 * for nothing until it is mounted, and the socket entry is back.
 *
 * KEPT, not deleted: the shape is right, and it is roughly what the real consumer
 * will look like. What it is not is a consumer. Mounting it means giving
 * svc-academy a bus first — a real decision about this service's boot
 * dependencies, and exactly the "scope question" ADR D-S-13 reserves for the
 * owner. It is recorded as Class B in `WIRING_SOCKETS` (packages/events/src/catalog.ts).
 */

import { MemorySeenStore, idempotent, type EventBus, type SeenStore, type Subscription } from '@intafaced/events';

export type CrewPlacement = {
  readonly crewId: string;
  readonly userId: string;
  readonly role: string;
  readonly crewSize: number;
  readonly matchRunId: string;
  readonly routedAt: Date;
};

/** Process-local placement log for tests + readiness. */
export class MemoryCrewLobbyRouter {
  private readonly byUser = new Map<string, CrewPlacement>();

  route(input: Omit<CrewPlacement, 'routedAt'> & { now?: Date }): CrewPlacement {
    const row: CrewPlacement = {
      crewId: input.crewId,
      userId: input.userId,
      role: input.role,
      crewSize: input.crewSize,
      matchRunId: input.matchRunId,
      routedAt: input.now ?? new Date(),
    };
    this.byUser.set(input.userId, row);
    return row;
  }

  placementOf(userId: string): CrewPlacement | null {
    return this.byUser.get(userId) ?? null;
  }

  list(): CrewPlacement[] {
    return [...this.byUser.values()];
  }
}

export async function subscribeCrewMemberCreated(
  bus: EventBus,
  router: MemoryCrewLobbyRouter,
  store: SeenStore = new MemorySeenStore(),
): Promise<Subscription> {
  return bus.subscribe(
    'crewMemberCreated',
    idempotent(
      async (payload) => {
        router.route({
          crewId: payload.crewId,
          userId: payload.userId,
          role: payload.role,
          crewSize: payload.crewSize,
          matchRunId: payload.matchRunId,
        });
      },
      store,
      'svc-academy-crew-lobby',
    ),
    { durable: 'academy-crew-member-created' },
  );
}
