// volt-room: /market/purchases
import { useState } from 'react';
import {
  MARKET_COMMERCE_PROGRAMME,
  MARKET_LISTINGS,
  MARKET_MY_PURCHASES,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import { Button } from '@intafaced/ui/lit';
import { RecordListTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session';
import { Details, formatBpsPercent } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { MarketPurchaseRecords } from '../MarketPurchaseRecords';
import { useKitAction } from '../volt-action';
import { KitRead, Section } from '../volt-parts';
import { cancelMarketSubscription, recoverMarketAction, requestMarketRefund } from '../market-room/market-calls';

/** A price exactly as the service stores it, with its asset; the figure scrolls by keyboard rather than being cut. */
function MarketPrice({ price, assetId }: { price: string; assetId: string }) {
  return (
    <div className="lt-stack">
      <div tabIndex={0} role="group" aria-label={copyText('market.price')}>
        <strong className="lt-num" lang="zxx">
          {displayAmount(price)}
        </strong>
      </div>{' '}
      <span lang="zxx">{assetId}</span>
    </div>
  );
}

/**
 * `/market/purchases` on the record-list template: the buyer's own Market purchases, their refund windows, receipts,
 * refund requests and subscription cancellations. Uses the same reads, calls and words as `../Market.tsx` and
 * `../market-room/MarketRoom.tsx`.
 */
export function MarketPurchasesRoom() {
  const api = useApi(),
    { userId } = useSession(),
    routes = moreRoomRoutesCopy.useCopy(),
    action = useKitAction('market', {
      recover: (reference) => recoverMarketAction(api, userId, reference),
      done: () => purchases.reload(),
    });
  const [limit] = useState(50);
  const listings = useResource((signal) => api.call(MARKET_LISTINGS, { limit }, { signal }), `listings:false:false:public:${limit}:`);
  const programme = useResource((signal) => api.call(MARKET_COMMERCE_PROGRAMME, undefined, { signal }), 'market-programme');
  const purchases = useResource(
    (signal) => api.call(MARKET_MY_PURCHASES, { limit }, { signal, accept: (rows) => rows.every((row) => row.buyerId === userId) }),
    `purchases:${userId}:${limit}`,
  );
  const preferences = usePreferences();
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const titleOf = (listingId: string) =>
    listings.resource.status === 'ready' ? listings.resource.data.find((row) => row.id === listingId)?.title : undefined;

  function requestRefund(row: MarketPurchase) {
    action.stage({
      title: () => copyText('market.ask.the.seller.for.a.refund'),
      reference: `refund-request:${row.id}`,
      confirm: () => copyText('market.request.refund'),
      success: () => copyText('market.refund.requested'),
      content: () => (
        <>
          <Details
            items={[
              [copyText('market.listing'), <span lang="und">{titleOf(row.listingId) ?? row.listingId}</span>],
              [copyText('market.price'), <MarketPrice price={row.price} assetId={row.assetId} />],
            ]}
          />
          {row.refundWindowEndsAt && <p>{copyText('market.refund.request.body', { value1: when(row.refundWindowEndsAt) })}</p>}
        </>
      ),
      run: () => requestMarketRefund(api, userId, row),
      done: purchases.reload,
    });
  }

  // Read from the service: null means the owner has not decided it, so the room names that blocker beside the refund controls.
  const policyUnset = programme.resource.status === 'ready' && programme.resource.data.refundPolicy === null;
  const policyNote = (
    <p className="lt-hint" role="note" data-code="owner.decision">
      <Text k="market.refund.policy.is.not.set" /> <code lang="zxx">owner.decision</code>
    </p>
  );

  return (
    <RecordListTemplate
      title={routes.t('purchases')}
      description={copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace')}
      state={{ kind: 'ready' }}
      filters={
        <Tabs
          label={copyText('market.catalogue')}
          current="/market/purchases"
          items={[
            { label: copyText('market.catalogue'), href: '/market' },
            { label: copyText('market.my.listings'), href: '/market/mine' },
            { label: copyText('market.publish.a.strategy.subscription'), href: '/market/strategy' },
          ]}
        />
      }
      list={
        <div className="lt-stack">
          <KitRead resource={programme.resource} retry={programme.reload}>
            {(p) => (
              <p className="lt-hint">
                {p.commissionConfigured && p.commissionBps !== null
                  ? copyText('market.published.house.commission.basis.points.charged.to', { value1: formatBpsPercent(p.commissionBps) })
                  : copyText('market.the.house.commission.is.unpublished.the.service')}
              </p>
            )}
          </KitRead>
          <Section title={copyText('market.your.purchases')}>
            <MarketPurchaseRecords
              resource={purchases.resource}
              reload={purchases.reload}
              limit={limit}
              titleOf={titleOf}
              refundNote={policyUnset ? policyNote : undefined}
              renderRefund={(row) => (
                <Button
                  tone="secondary"
                  disabled={
                    action.disabled ||
                    Boolean(row.refundRequestedAt) ||
                    !row.refundWindowEndsAt ||
                    Date.parse(row.refundWindowEndsAt) <= Date.now()
                  }
                  onClick={() => requestRefund(row)}
                >
                  <Text k="market.ask.for.a.refund" />
                </Button>
              )}
              renderCancel={(row) => (
                <Button
                  tone="secondary"
                  disabled={action.disabled}
                  onClick={() =>
                    action.stage({
                      title: () => copyText('market.cancel.subscription.access'),
                      confirm: () => copyText('market.cancel.access'),
                      success: () => copyText('market.access.cancellation.recorded'),
                      content: () => (
                        <p>
                          <Text k="market.cancel.access.for.listing" />
                          <code lang="zxx">{row.listingId}</code>
                          <Text k="market.this.does.not.issue.a.refund" />
                        </p>
                      ),
                      run: () => cancelMarketSubscription(api, userId, row),
                      done: purchases.reload,
                    })
                  }
                >
                  <Text k="market.cancel.access" />
                </Button>
              )}
            />
          </Section>
          {action.feedback}
          {action.dialog}
        </div>
      }
    />
  );
}
