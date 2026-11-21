import { serviceHealthSchema } from '@intafaced/contracts/service-health';
import { useApi } from '../../features/session/session';
import { useResource } from '../../shared/resource';

/**
 * The real state of the six More rooms (J-more-catalogue-01 #1, MC-order-01). Market, Launch and Token are open rooms: each
 * tile says whether the service behind it answers right now, read from that service's own `/health` through the edge, never
 * assumed. Predict, Mining and Blueprint are parked (the owner's scope decision of 6 Nov 2026): each tile says so and names
 * what it waits on. Nothing is hidden for either.
 */
export type LiveState = 'checking' | 'open' | 'not_answering';
export type RoomState = { kind: 'live'; state: LiveState } | { kind: 'parked'; blocker: ParkedBlocker };

/** What a parked room waits on: how Predict settles is the owner's decision; the pool and Blueprint's extras come after launch. */
export type ParkedBlocker = 'owner.decision' | 'after.launch';

/** Each open room tile and the edge module of the service its room reads. Launch's catalogue is served by svc-token. */
export const LIVE_ROOMS = { market: 'market', launch: 'token', token: 'token' } as const;

/** Each parked room tile and what it waits on. */
export const PARKED_ROOMS: Readonly<Record<'predict' | 'mining' | 'blueprint', ParkedBlocker>> = {
  predict: 'owner.decision',
  mining: 'after.launch',
  blueprint: 'after.launch',
};

/** The state of each of the six room tiles, keyed by tile id. */
export function useRoomStates(): Record<string, RoomState> {
  const api = useApi();
  const market = useResource((signal) => api.plain('market', '/health', serviceHealthSchema, { signal }), 'more-room-market');
  const token = useResource((signal) => api.plain('token', '/health', serviceHealthSchema, { signal }), 'more-room-token');
  const live = { market: liveState(market.resource.status), token: liveState(token.resource.status) };
  return {
    ...Object.fromEntries(Object.entries(LIVE_ROOMS).map(([tile, module]) => [tile, { kind: 'live', state: live[module] }])),
    ...Object.fromEntries(Object.entries(PARKED_ROOMS).map(([tile, blocker]) => [tile, { kind: 'parked', blocker }])),
  };
}

const liveState = (status: 'loading' | 'ready' | 'failed'): LiveState =>
  status === 'loading' ? 'checking' : status === 'ready' ? 'open' : 'not_answering';
