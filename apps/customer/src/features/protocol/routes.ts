import { matchPath } from '../../app/path-match';

/**
 * The Web3 route table (IA-SPEC 2.8). Pure data: navigation.ts reads it to register the rooms and ProtocolRoutes.tsx
 * reads it to mount one component per route. A route with `pending` has its full layout but no data source yet; it names
 * the blocker instead of showing a blank.
 */
export type Web3Room = 'dex' | 'chain' | 'protocol' | 'wallet';
/** What a not-yet-built route waits on: our own indexer reader, the wallet connection, or the INTACHAIN network. */
export type PendingBlocker = 'indexer' | 'wallet' | 'chain';
export type PendingPage =
  'poolNew' | 'poolDetail' | 'positionDetail' | 'tokenDetail' | 'blockDetail' | 'txDetail' | 'addressDetail' | 'validatorDetail';

/** The wallet room's sections, each at its own path so Back returns to the section the person left. */
export const WALLET_SECTIONS = {
  overview: '/wallet',
  activity: '/wallet/activity',
  send: '/wallet/send',
  receive: '/wallet/receive',
  scan: '/wallet/scan',
  approvals: '/wallet/approvals',
  sessionKeys: '/wallet/session-keys',
  accounts: '/wallet/accounts',
  safety: '/wallet/safety',
} as const;
export type WalletSection = keyof typeof WALLET_SECTIONS;

export interface Web3Route {
  path: string;
  room: Web3Room;
  /** An existing tab of the room (`SUBNAV`); the tab room renders it. */
  tab?: string;
  /** The wallet room, opened on this section. */
  wallet?: WalletSection;
  pending?: { page: PendingPage; blocker: PendingBlocker; param?: { name: string; shape: RegExp } };
}

const digits = /^\d{1,20}$/;
const txHash = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const id = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Specific routes sit before the parameter routes that could swallow them (`/dex/pools/new` before `/dex/pools/:poolId`). */
export const WEB3_ROUTES: readonly Web3Route[] = [
  { path: '/dex', room: 'dex', tab: 'swap' },
  { path: '/dex/pools', room: 'dex', tab: 'pools' },
  { path: '/dex/pools/new', room: 'dex', pending: { page: 'poolNew', blocker: 'wallet' } },
  { path: '/dex/pools/:poolId', room: 'dex', pending: { page: 'poolDetail', blocker: 'indexer', param: { name: 'poolId', shape: id } } },
  { path: '/dex/positions', room: 'dex', tab: 'positions' },
  {
    path: '/dex/positions/:positionId',
    room: 'dex',
    pending: { page: 'positionDetail', blocker: 'wallet', param: { name: 'positionId', shape: id } },
  },
  {
    path: '/dex/tokens/:address',
    room: 'dex',
    pending: { page: 'tokenDetail', blocker: 'indexer', param: { name: 'address', shape: address } },
  },
  { path: '/dex/venue', room: 'dex', tab: 'venue' },
  ...(Object.entries(WALLET_SECTIONS) as [WalletSection, string][]).map(([wallet, path]) => ({ path, room: 'wallet' as const, wallet })),
  { path: '/chain', room: 'chain', tab: 'status' },
  { path: '/chain/blocks', room: 'chain', tab: 'blocks' },
  {
    path: '/chain/blocks/:height',
    room: 'chain',
    pending: { page: 'blockDetail', blocker: 'indexer', param: { name: 'height', shape: digits } },
  },
  { path: '/chain/tx/:hash', room: 'chain', pending: { page: 'txDetail', blocker: 'indexer', param: { name: 'hash', shape: txHash } } },
  {
    path: '/chain/address/:address',
    room: 'chain',
    pending: { page: 'addressDetail', blocker: 'indexer', param: { name: 'address', shape: address } },
  },
  { path: '/chain/validators', room: 'chain', tab: 'validators' },
  {
    path: '/chain/validators/:validatorId',
    room: 'chain',
    pending: { page: 'validatorDetail', blocker: 'chain', param: { name: 'validatorId', shape: id } },
  },
  { path: '/chain/audit', room: 'chain', tab: 'audit' },
  { path: '/protocol', room: 'protocol', tab: 'overview' },
  { path: '/protocol/contracts', room: 'protocol', tab: 'contracts' },
  { path: '/protocol/rails', room: 'protocol', tab: 'rails' },
  { path: '/protocol/audit', room: 'protocol', tab: 'audit' },
];

export interface Web3Match {
  route: Web3Route;
  params: Record<string, string>;
}
export function matchWeb3Route(path: string): Web3Match | undefined {
  for (const route of WEB3_ROUTES) {
    const params = matchPath(route.path, path.length > 1 ? path.replace(/\/+$/, '') : path);
    if (params) return { route, params };
  }
  return undefined;
}

/** True when `path` is under a Web3 room (`/dex`, `/chain`, `/protocol`, `/wallet`), whether or not a route matches it. */
export function isWeb3Path(path: string): boolean {
  return /^\/(?:dex|chain|protocol|wallet)(?:\/|$)/.test(path);
}
