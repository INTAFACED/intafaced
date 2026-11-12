import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../../features/session/session';

/**
 * The real state of the six More rooms (J-more-catalogue-01 #1, MC-order-01): each tile on /more says whether the service
 * behind its room answers right now, read from that service's own `/health` through the edge, never assumed. A room whose
 * service does not answer says so; nothing is hidden for it. Predict also names the blocker that keeps its catalogue empty
 * whatever its service says: publishing a question waits on the owner's decision of who determines a result
 * (`owner.decision`, ENGINE E-1; the room shows the same notice).
 */
export type RoomState = 'checking' | 'open' | 'not_answering';

/** Each More room tile and the edge module of the service its room reads. Launch's catalogue is served by svc-token. */
export const ROOM_SERVICES: Readonly<Record<string, string>> = {
  predict: 'trade',
  market: 'market',
  launch: 'token',
  token: 'token',
  mining: 'mining',
  blueprint: 'blueprint',
};

/** A room's named blocker, shown beside its state; only Predict has one today. */
export const ROOM_BLOCKERS: Readonly<Record<string, 'owner.decision'>> = { predict: 'owner.decision' };

const health = z.object({ ok: z.literal(true) }).passthrough();

/** The state of each room tile, keyed by tile id: `checking` until its service's `/health` answers or fails. */
export function useRoomStates(): Record<string, RoomState> {
  const api = useApi();
  const [byModule, setByModule] = useState<Record<string, RoomState>>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const module of new Set(Object.values(ROOM_SERVICES))) {
      void api.plain(module, '/health', health, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        setByModule((now) => ({ ...now, [module]: result.ok ? 'open' : 'not_answering' }));
      });
    }
    return () => controller.abort();
  }, [api]);
  return Object.fromEntries(Object.entries(ROOM_SERVICES).map(([tile, module]) => [tile, byModule[module] ?? 'checking']));
}
