import { useMemo } from 'react';
import { P2PTabs } from './p2p-tabs';
import { payCopy } from './copy';
import { EmptyState, Page } from './ui-kit';
import { createPersonalPayApi } from './pay-api';
import { useP2PView, type P2PView } from './p2p-view';
import { P2POffers } from './P2POffers';
import { CounterpartyRoom } from './p2p-counterparty/CounterpartyRoom';
import { p2pDepth } from './personal/p2p-depth-copy';
import { P2PEligibilityPanel } from './personal/Eligibility';
import { MethodsRoom } from './personal/MethodsRoom';
import { P2PBoard } from './p2p-board/Board';
import { P2PMine } from './p2p-board/Mine';
import { AccessRoom } from './p2p-access/AccessRoom';
import { OfferRoom } from './p2p-offer/OfferRoom';
import { OrderDetail, OrderRoom } from './p2p-order/OrderRoom';
// The other P2P rooms still draw the offer list's old look until they move to Volt.
import './p2p-offer.css';

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
  // The person's orders (and any opened order outside /chat) are on the record-list template in Volt.
  if ((showOrders || Boolean(tradeId)) && current !== '/chat') return <OrderRoom pay={pay} tradeId={tradeId ?? null} userId={userId} />;
  // Creating or editing an offer is on its flow template, which draws its own title and the P2P rooms.
  if (publish && !tradeId)
    return <OfferRoom pay={pay} userId={userId} mode={current === '/uc/ad/update' ? 'edit' : 'create'} offerId={params.get('offerId')} />;
  // The person's own offers are on the overview template too, which draws its own title and the P2P rooms.
  if (showMine && !tradeId) return <P2PMine pay={pay} userId={userId} />;
  // The offer board is on its overview template, which draws its own title and the P2P rooms.
  if (
    !tradeId &&
    current !== '/chat' &&
    current !== '/checkuser' &&
    !showOrders &&
    !publish &&
    !showAccess &&
    !showMine &&
    !(current === '/uc/ad/update')
  )
    return <P2PBoard pay={pay} userId={userId} offerOpen={Boolean(params.get('offerId'))} />;
  return (
    <Page
      eyebrow={payCopy.t('personalPay')}
      title={current === '/chat' || tradeId ? payCopy.t('p2pOrder') : payCopy.t('personToPerson')}
      description={
        tradeId || current === '/chat' || (!showOrders && !showMethods && !showAccess)
          ? undefined
          : payCopy.t('externalPaymentLedgerEscrowAndARecorded')
      }
    >
      <P2PTabs
        order={Boolean(tradeId) || current === '/chat'}
        current={
          showOrders || tradeId || current === '/chat'
            ? '/uc/order'
            : showMine
              ? '/uc/ad'
              : showMethods
                ? '/p2p/methods'
                : showAccess
                  ? '/p2p/access'
                  : '/p2p'
        }
      />
      {current === '/chat' && !tradeId ? (
        <EmptyState
          title={p2pDepth.t('chatPickTitle')}
          action={
            <a className="lt-button lt-button-primary" href="/uc/order">
              {p2pDepth.t('chatPickAction')}
            </a>
          }
        >
          {p2pDepth.t('chatPickBody')}
        </EmptyState>
      ) : current === '/chat' || tradeId ? (
        <OrderDetail pay={pay} tradeId={tradeId ?? ''} userId={userId} />
      ) : showMine ? (
        <P2POffers pay={pay} userId={userId} mine />
      ) : (
        <div className="lt-stack">
          {/* An open ad has the same checks beside its take form; the hub lists them all. */}
          {params.get('offerId') ? null : <P2PEligibilityPanel pay={pay} userId={userId} />}
          <P2POffers pay={pay} userId={userId} mine={false} />
        </div>
      )}
    </Page>
  );
}
