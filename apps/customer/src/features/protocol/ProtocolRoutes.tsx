import { ParkedProtocolRoom } from './ParkedProtocolRoom';
import { NotFoundRoute, PendingRoute } from './PendingRoute';
import { ADDRESS_SHAPE, matchWeb3Route } from './routes';
import { SUBNAV } from './blockers';
import { WalletRoom } from './wallet/WalletRoom';
import { WalletHomeRoom } from './wallet/WalletHomeRoom';
import { AccountsRoom } from './wallet/AccountsRoom';
import { ActivityRoom } from './wallet/ActivityRoom';
import { AddressBookRoom } from './wallet/AddressBookRoom';
import { ApprovalsRoom } from './wallet/ApprovalsRoom';
import { SessionKeysRoom } from './wallet/SessionKeysRoom';
import { WalletGroupRoom } from './wallet/WalletGroupRoom';
import { VenueWalletRoom } from './venue-wallet/VenueWalletRoom';
import { EmbeddedWalletRoom } from './embedded-wallet/EmbeddedWalletRoom';
import { ClaimPage } from './wallet/ClaimPage';
import { ConventionPage, HoldingPage } from './wallet/HoldingPages';
import { TokenPage } from './tokens/TokenPage';
import { TokensRoom } from './tokens/TokensRoom';
import { NewPool } from './liquidity/NewPool';
import { AddLiquidity } from './liquidity/AddLiquidity';
import { PositionNotFound, PositionPage, PositionsList } from './liquidity/Positions';
import { AddressPage } from './watch/AddressPage';
import { WatchlistPage } from './watch/WatchlistPage';
import { BlockPage, RecordNotFound, TxPage } from './explorer/pages';
import { PoolPage } from './pools/PoolPage';
import { ContractPage } from './contracts/ContractPage';
import { OrdersRoom } from './orders/OrdersRoom';
import { BlocksRoom } from './chain-blocks/BlocksRoom';
import { ValidatorsRoom } from './chain-validators/ValidatorsRoom';
import { ValidatorPage } from './chain-validators/ValidatorPage';
import { ChainRoom } from './chain-status/ChainRoom';
import { OverviewRoom } from './protocol-overview/OverviewRoom';
import { RailsRoom } from './rails/RailsRoom';
import { ContractsRoom } from './protocol-contracts/ContractsRoom';
import { PoolsRoom } from './dex-pools/PoolsRoom';
import { LendRoom } from './lend/LendRoom';
import { VenueRoom } from './venue/VenueRoom';
import { OwnFreezeNotice } from '../account';

/**
 * Mounts one component per Web3 route (IA-SPEC 2.8). A tab route renders its room's tab; a detail route renders its full
 * layout and names the blocker until its slice lands. Every other slice in the DEX and Protocol module mounts here.
 */
export function ProtocolRoutes({ path }: { path: string }) {
  const found = matchWeb3Route(path);
  if (!found) return <NotFoundRoute path={path} />;
  // Every wallet section first says when the owner froze their account (J-wallet-13 #3).
  if (found.route.room === 'wallet')
    return (
      <>
        <OwnFreezeNotice />
        {routeBody(path, found)}
      </>
    );
  return routeBody(path, found);
}

function routeBody(path: string, found: NonNullable<ReturnType<typeof matchWeb3Route>>) {
  const { route, params } = found;
  // The venue account is its own room on the flow template (J-wallet-09), reached from the wallet room's tabs.
  if (route.wallet === 'venue') return <VenueWalletRoom />;
  // The person's own embedded wallet is its own room on the flow template too (J-wallet-22).
  if (route.wallet === 'embedded') return <EmbeddedWalletRoom />;
  // The wallet sections that are lists of records are rooms of their own on the record-list template.
  if (route.wallet === 'activity') return <ActivityRoom />;
  if (route.wallet === 'accounts') return <AccountsRoom />;
  if (route.wallet === 'addressBook') return <AddressBookRoom />;
  if (route.wallet === 'approvals') return <ApprovalsRoom />;
  if (route.wallet === 'sessionKeys') return <SessionKeysRoom />;
  if (route.wallet === 'overview') return <WalletHomeRoom />;
  if (route.wallet) return <WalletRoom section={route.wallet} />;
  if (route.tokens === 'list') return <TokensRoom />;
  if (route.tokens === 'detail') return <TokenPage address={safeDecode(params.address)} />;
  if (route.liquidity === 'new') return <NewPool />;
  if (route.liquidity === 'positions') return <PositionsList />;
  if (route.liquidity === 'add' || route.liquidity === 'position') {
    const value = route.param ? safeDecode(params[route.param.name]) : undefined;
    // A malformed id is answered not found without asking the service.
    if (value === undefined || !route.param?.shape.test(value))
      return route.liquidity === 'add' ? <NotFoundRoute path={path} /> : <PositionNotFound />;
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
      return <RecordNotFound page={route.explorer === 'block' ? 'blockDetail' : 'txDetail'} />;
    return route.explorer === 'block' ? <BlockPage height={Number(value)} /> : <TxPage hash={value.toLowerCase()} />;
  }
  if (route.walletClaim) {
    const id = safeDecode(params.linkId);
    if (id === undefined || !ADDRESS_SHAPE.test(id)) return <NotFoundRoute path={path} />;
    return <ClaimPage id={id} />;
  }
  if (route.walletToken) {
    const token = safeDecode(params.token);
    if (token === undefined || !ADDRESS_SHAPE.test(token)) return <NotFoundRoute path={path} />;
    return <HoldingPage token={token} />;
  }
  if (route.walletConvention) return <ConventionPage id={safeDecode(params.convention) ?? ''} />;
  if (route.walletGroup) return <WalletGroupRoom groupId={safeDecode(params.groupId) ?? ''} />;
  if (route.pending) {
    const { param } = route.pending;
    const value = param ? params[param.name] : undefined;
    const valid = !param || (value !== undefined && param.shape.test(safeDecode(value) ?? ''));
    // The validator page is its own room on the monitor template.
    if (route.pending.page === 'validatorDetail') return <ValidatorPage validatorId={safeDecode(value)} valid={valid} />;
    return (
      <PendingRoute room={route.room} page={route.pending.page} blocker={route.pending.blocker} param={safeDecode(value)} valid={valid} />
    );
  }
  if (route.room === 'wallet' || !route.tab) return <NotFoundRoute path={path} />;
  // The record-list tabs are rooms of their own on their template; the other tabs stay in the parked room.
  if (route.room === 'chain' && route.tab === 'blocks') return <BlocksRoom />;
  if (route.room === 'chain' && route.tab === 'validators') return <ValidatorsRoom />;
  // The monitor tabs are rooms of their own on their template too.
  if (route.room === 'chain' && route.tab === 'status') return <ChainRoom />;
  if (route.room === 'protocol' && route.tab === 'overview') return <OverviewRoom />;
  if (route.room === 'protocol' && route.tab === 'rails') return <RailsRoom />;
  if (route.room === 'protocol' && route.tab === 'contracts') return <ContractsRoom />;
  if (route.room === 'dex' && route.tab === 'pools') return <PoolsRoom />;
  if (route.room === 'dex' && route.tab === 'lend') return <LendRoom />;
  if (route.room === 'dex' && route.tab === 'venue') return <VenueRoom />;
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
