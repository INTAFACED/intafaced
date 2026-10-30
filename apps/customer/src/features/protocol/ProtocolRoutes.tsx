import { ParkedProtocolRoom } from './ParkedProtocolRoom';
import { NotFoundRoute, PendingRoute } from './PendingRoute';
import { matchWeb3Route } from './routes';
import { SUBNAV } from './blockers';
import { WalletRoom } from './wallet/WalletRoom';
import { TokenPage } from './tokens/TokenPage';
import { TokensRoom } from './tokens/TokensRoom';
import { AddressPage } from './watch/AddressPage';
import { WatchlistPage } from './watch/WatchlistPage';
import { BlockPage, TxPage } from './explorer/pages';
import { PoolPage } from './pools/PoolPage';

/**
 * Mounts one component per Web3 route (IA-SPEC 2.8). A tab route renders its room's tab; a detail route renders its full
 * layout and names the blocker until its slice lands. Every other slice in the DEX and Protocol module mounts here.
 */
export function ProtocolRoutes({ path }: { path: string }) {
  const found = matchWeb3Route(path);
  if (!found) return <NotFoundRoute path={path} />;
  const { route, params } = found;
  if (route.wallet) return <WalletRoom section={route.wallet} />;
  if (route.tokens === 'list') return <TokensRoom />;
  if (route.tokens === 'detail') return <TokenPage address={safeDecode(params.address)} />;
  if (route.pool === 'detail') {
    const value = safeDecode(params.poolId);
    // A pool id that is not an address is answered not found without asking the indexer.
    if (value === undefined || !route.param?.shape.test(value))
      return <PendingRoute room={route.room} page="poolDetail" blocker="indexer" valid={false} />;
    return <PoolPage address={value.toLowerCase()} />;
  }
  if (route.explorer === 'address') return <AddressPage address={safeDecode(params.address)} />;
  if (route.explorer === 'watchlist') return <WatchlistPage />;
  if (route.explorer === 'block' || route.explorer === 'tx') {
    const value = route.param ? safeDecode(params[route.param.name]) : undefined;
    // A malformed id is answered not found without asking the indexer.
    if (value === undefined || !route.param?.shape.test(value))
      return (
        <PendingRoute room={route.room} page={route.explorer === 'block' ? 'blockDetail' : 'txDetail'} blocker="indexer" valid={false} />
      );
    return route.explorer === 'block' ? <BlockPage height={Number(value)} /> : <TxPage hash={value.toLowerCase()} />;
  }
  if (route.walletGroup) return <WalletRoom section="addressBook" groupId={safeDecode(params.groupId) ?? ''} />;
  if (route.pending) {
    const { param } = route.pending;
    const value = param ? params[param.name] : undefined;
    return (
      <PendingRoute
        room={route.room}
        page={route.pending.page}
        blocker={route.pending.blocker}
        param={safeDecode(value)}
        valid={!param || (value !== undefined && param.shape.test(safeDecode(value) ?? ''))}
      />
    );
  }
  if (route.room === 'wallet' || !route.tab) return <NotFoundRoute path={path} />;
  const slug = route.room;
  // The tab room reads the tab from the path; the first tab lives at the room root.
  const subPath = route.tab === SUBNAV[slug][0]!.id ? '' : route.tab;
  return <ParkedProtocolRoom slug={slug} subPath={subPath} />;
}

function safeDecode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
