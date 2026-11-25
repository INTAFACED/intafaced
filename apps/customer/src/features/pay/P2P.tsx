import { useMemo } from 'react';
import { createPersonalPayApi } from './pay-api';
import { useP2PView, type P2PView } from './p2p-view';
import { CounterpartyRoom } from './p2p-counterparty/CounterpartyRoom';
import { MethodsRoom } from './personal/MethodsRoom';
import { P2PBoard } from './p2p-board/Board';
import { P2PMine } from './p2p-board/Mine';
import { AccessRoom } from './p2p-access/AccessRoom';
import { OfferRoom } from './p2p-offer/OfferRoom';
import { OrderRoom } from './p2p-order/OrderRoom';

export { destinationRows, OrderActions, OrderPaymentDetails } from './p2p-order/OrderRoom';

export function P2P({ path }: { path: string }) {
  const view = useP2PView();
  return <P2PCurrent key={view.epoch} path={path} view={view} />;
}

function P2PCurrent({ path, view }: { path: string; view: P2PView }) {
  const { api, userId } = view;
  const pay = useMemo(() => createPersonalPayApi(api, userId, undefined, view.current), [view]);
  const params = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  const current = path.split('?')[0] ?? '/p2p';
  const tradeId =
    current === '/checkuser'
      ? undefined
      : (params.get('tradeId') ?? (current === '/chat' ? params.get('id') : null) ?? path.match(/^\/p2p\/orders\/([^/?]+)/)?.[1]);
  const showOrders = current === '/uc/order' || current === '/p2p/orders';
  const showMine = current === '/uc/ad' || current === '/p2p/offers';
  const showMethods = current === '/p2p/methods' || params.get('view') === 'methods';
  const showAccess = current === '/p2p/access' || params.get('view') === 'access';
  const publish = current === '/uc/ad/create' || current === '/uc/ad/update' || current === '/p2p/offers/new';
  const counterparty = params.get('userId') ?? params.get('userid') ?? (current === '/checkuser' ? params.get('id') : null);
  // A member's P2P record is on its monitor template, which draws its own title and the P2P rooms.
  if (current === '/checkuser') return <CounterpartyRoom pay={pay} counterparty={counterparty} returnTo={params.get('returnTo')} />;
  // Payment methods is on its settings template, which draws its own title and the P2P rooms.
  if (showMethods && !tradeId && current !== '/chat' && !showOrders && !publish && !showAccess)
    return <MethodsRoom pay={pay} userId={userId} />;
  // Trading access is on its flow template, which draws its own title and the P2P rooms.
  if (showAccess && !tradeId && current !== '/chat' && !showOrders && !publish) return <AccessRoom pay={pay} userId={userId} />;
  // The person's orders and order conversation (/chat) are on the record-list template in Volt.
  if (showOrders || current === '/chat' || Boolean(tradeId))
    return <OrderRoom pay={pay} tradeId={tradeId ?? null} userId={userId} chat={current === '/chat'} />;
  // Creating or editing an offer is on its flow template, which draws its own title and the P2P rooms.
  if (publish && !tradeId)
    return <OfferRoom pay={pay} userId={userId} mode={current === '/uc/ad/update' ? 'edit' : 'create'} offerId={params.get('offerId')} />;
  // The person's own offers are on the flow template, which draws its own title and the P2P rooms.
  if (showMine && !tradeId) return <P2PMine pay={pay} userId={userId} />;
  // The offer board is on its overview template, which draws its own title and the P2P rooms.
  return <P2PBoard pay={pay} userId={userId} offerOpen={Boolean(params.get('offerId'))} />;
}
