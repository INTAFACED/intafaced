import { matchPath } from '../../app/path-match';

/** The six rooms of the More room-set that have more than one page. */
export type MoreRoomId = 'predict' | 'market' | 'launch' | 'token' | 'mining' | 'blueprint';
/** `part`: a section of the room that has its own address; its room checks any id in the path itself. `detail`: one record of the room, named by an id in the path. */
export type MoreRouteKind = 'part' | 'detail';
export interface MoreRoute {
  pattern: string;
  room: MoreRoomId;
  kind: MoreRouteKind;
  /** Key of the page's own title in `moreRoomRoutesCopy`. */
  title:
    | 'positions'
    | 'purchases'
    | 'newLaunch'
    | 'launchCheck'
    | 'launchRequirements'
    | 'governance'
    | 'economy'
    | 'burn'
    | 'workers'
    | 'shares'
    | 'rewards'
    | 'status'
    | 'crew'
    | 'sharedCard'
    | 'market'
    | 'predict'
    | 'launchProject'
    | 'proposal'
    | 'worker';
}

/**
 * The one list of the room-set's sub-pages (MC-order-01). The rooms themselves (`/predict`, `/market`, `/market/mine`,
 * `/market/strategy`, `/launch`, `/token`, `/mining`, `/blueprint`) keep their own branches in `MoreRoutes`.
 * Literal sections come before the parameter route of the same room, and a test fails if a literal could be taken for an id.
 */
export const MORE_ROUTES: readonly MoreRoute[] = [
  { pattern: '/predict/positions', room: 'predict', kind: 'part', title: 'positions' },
  { pattern: '/predict/:marketId', room: 'predict', kind: 'detail', title: 'predict' },
  { pattern: '/market/purchases', room: 'market', kind: 'part', title: 'purchases' },
  { pattern: '/market/:listingId', room: 'market', kind: 'detail', title: 'market' },
  { pattern: '/launch/new', room: 'launch', kind: 'part', title: 'newLaunch' },
  { pattern: '/launch/check', room: 'launch', kind: 'part', title: 'launchCheck' },
  { pattern: '/launch/requirements', room: 'launch', kind: 'part', title: 'launchRequirements' },
  { pattern: '/launch/:projectId', room: 'launch', kind: 'detail', title: 'launchProject' },
  { pattern: '/token/governance', room: 'token', kind: 'part', title: 'governance' },
  { pattern: '/token/economy', room: 'token', kind: 'part', title: 'economy' },
  { pattern: '/token/burn', room: 'token', kind: 'part', title: 'burn' },
  { pattern: '/token/governance/:proposalId', room: 'token', kind: 'detail', title: 'proposal' },
  { pattern: '/mining/workers', room: 'mining', kind: 'part', title: 'workers' },
  { pattern: '/mining/shares', room: 'mining', kind: 'part', title: 'shares' },
  { pattern: '/mining/rewards', room: 'mining', kind: 'part', title: 'rewards' },
  { pattern: '/mining/status', room: 'mining', kind: 'part', title: 'status' },
  { pattern: '/mining/workers/:workerId', room: 'mining', kind: 'detail', title: 'worker' },
  { pattern: '/blueprint/crew', room: 'blueprint', kind: 'part', title: 'crew' },
  { pattern: '/blueprint/shared/:cardId', room: 'blueprint', kind: 'part', title: 'sharedCard' },
];

/** First segment under each room that is a section, so never an id. The room's own page is the room's path itself. */
export const RESERVED_SEGMENTS: Readonly<Record<MoreRoomId, readonly string[]>> = {
  predict: ['positions', 'settings'],
  market: ['mine', 'strategy', 'purchases'],
  launch: ['new', 'check', 'requirements', 'mine'],
  token: ['governance', 'economy', 'burn'],
  mining: ['workers', 'shares', 'rewards', 'status'],
  blueprint: ['shared', 'crew'],
};

/** What an id in a path may look like. Checked after one URL-decode, before any request, and never taken as authority. */
const idShape = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type MoreRouteMatch =
  | { route: MoreRoute; id?: undefined; invalid?: undefined }
  | { route: MoreRoute; id: string; invalid?: undefined }
  | { route: MoreRoute; invalid: true; id?: undefined };

/** The sub-page `path` (no query) opens, or undefined when it is not one. A detail route with a malformed id still matches, flagged `invalid`. */
export function matchMoreRoute(path: string): MoreRouteMatch | undefined {
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  for (const route of MORE_ROUTES) {
    const params = matchPath(route.pattern, clean);
    if (!params) continue;
    if (route.kind === 'part') return { route };
    const raw = Object.values(params)[0] ?? '';
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return { route, invalid: true };
    }
    const reserved = RESERVED_SEGMENTS[route.room];
    // `/market/a%2Fb` decodes to a slash: that is not one segment, so not an id.
    return idShape.test(id) && !reserved.includes(id) ? { route, id } : { route, invalid: true };
  }
  return undefined;
}
