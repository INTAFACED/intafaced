import { ParkedProtocolRoom } from './ParkedProtocolRoom';
import { NotFoundRoute, PendingRoute } from './PendingRoute';
import { ADDRESS_SHAPE, matchWeb3Route } from './routes';
import { SUBNAV } from './blockers';
import { WalletRoom } from './wallet/WalletRoom';
import { ClaimPage } from './wallet/ClaimPage';
import { TokenPage } from './tokens/TokenPage';
import { TokensRoom } from './tokens/TokensRoom';
import { NewPool } from './liquidity/NewPool';
import { AddLiquidity } from './liquidity/AddLiquidity';
import { PositionPage, PositionsList } from './liquidity/Positions';
import { AddressPage } from './watch/AddressPage';
import { WatchlistPage } from './watch/WatchlistPage';
import { BlockPage, TxPage } from './explorer/pages';
import { PoolPage } from './pools/PoolPage';
import { ContractPage } from './contracts/ContractPage';
import { OrdersRoom } from './orders/OrdersRoom';

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
  if (route.liquidity === 'new') return <NewPool />;
  if (route.liquidity === 'positions') return <PositionsList />;
  if (route.liquidity === 'add' || route.liquidity === 'position') {
    const value = route.param ? safeDecode(params[route.param.name]) : undefined;
    // A malformed id is answered not found without asking the service.
    if (value === undefined || !route.param?.shape.test(value)) return <NotFoundRoute path={path} />;
    return route.liquidity === 'add' ? <AddLiquidity pool={value.toLowerCase()} /> : <PositionPage id={value.toLowerCase()} />;
  }
  if (route.pool === 'detail') {
    const value = safeDecode(params.poolId);
    // A pool id that is not an address is answered not found without asking the indexer.
    if (value === undefined || !route.param?.shape.test(value))
      return <PendingRoute room={route.room} page="poolDetail" blocker="indexer" valid={false} />;
    return <PoolPage address={value.toLowerCase()} />;
  }
  if (route.orders) return <OrdersRoom />;
  if (route.contract) return <ContractPage address={safeDecode(params.address)} />;
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
  if (route.walletClaim) {
    const id = safeDecode(params.linkId);
    if (id === undefined || !ADDRESS_SHAPE.test(id)) return <NotFoundRoute path={path} />;
    return <ClaimPage id={id} />;
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
