// volt-room: /market
import { useRef, useState } from 'react';
import {
  MARKET_COMMERCE_PROGRAMME,
  MARKET_LISTINGS,
  MARKET_LISTINGS_BY_CATEGORY,
  MARKET_MY_PURCHASES,
  type MarketListing,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate, Sheet, Tabs } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session';
import { Details, formatBpsPercent, Limit } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { filterListings, NO_FILTER, type ListingFilter } from '../market-explorer';
import { marketListingCopy } from '../market-listing-copy';
import { CategorySelect, ListingDetail, MarketDoors, MarketFilters, SellerDirectory } from '../MarketExplorer';
import { MarketPurchaseRecords } from '../MarketPurchaseRecords';
import { useKitAction } from '../volt-action';
import { KitRead, Section } from '../volt-parts';
import { cancelMarketSubscription, purchaseListing, recoverMarketAction, requestMarketRefund, REVIEW_COPY } from './market-calls';

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
 * /market on the kit: the published catalogue with its filters, categories and listing detail, the doors to the copy
 * room, the seller directory and the buyer's own purchases with their refund and cancel controls. The same reads, words
 * and actions as the catalogue of the old view (`../Market.tsx`), which /market/mine, /market/strategy and
 * /market/purchases still draw; its money calls are one logic with that view's (`./market-calls.ts`).
 */
export function MarketRoom() {
  const api = useApi(),
    { userId } = useSession(),
    action = useKitAction('market', {
      recover: (reference) => recoverMarketAction(api, userId, reference),
      done: () => purchases.reload(),
    });
  const [limit, setLimit] = useState(50),
    [filter, setFilter] = useState<ListingFilter>(NO_FILTER),
    // The catalogue's category ('' = every listing).
    [category, setCategory] = useState(''),
    [detailId, setDetailId] = useState<string | null>(null);
  const listings = useResource(
      (signal) =>
        category
          ? api.call(MARKET_LISTINGS_BY_CATEGORY, { category, limit }, { signal })
          : api.call(MARKET_LISTINGS, { limit }, { signal }),
      `listings:false:false:public:${limit}:${category}`,
    ),
    programme = useResource((signal) => api.call(MARKET_COMMERCE_PROGRAMME, undefined, { signal }), 'market-programme');
  const purchases = useResource(
    (signal) => api.call(MARKET_MY_PURCHASES, { limit }, { signal, accept: (rows) => rows.every((row) => row.buyerId === userId) }),
    `purchases:${userId}:${limit}`,
  );
  const preferences = usePreferences();
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  // The stored outcome of the last purchase, so its success line says held when the service held it.
  const bought = useRef<'held' | 'paid'>('paid');
  const ownRows = purchases.resource.status === 'ready' ? purchases.resource.data : [];
  const heldPurchaseOf = (listingId: string) => ownRows.find((p) => p.listingId === listingId && p.status === 'held');
  const titleOf = (listingId: string) =>
    listings.resource.status === 'ready' ? listings.resource.data.find((row) => row.id === listingId)?.title : undefined;
  function buy(row: MarketListing) {
    const purchaseId = crypto.randomUUID();
    action.stage({
      title: () => copyText('market.review.purchase'),
      reference: purchaseId,
      confirm: () => copyText('market.confirm.purchase'),
      success: () =>
        bought.current === 'held'
          ? copyText('market.purchase.held')
          : copyText('market.purchase.outcome.received.read.its.settlement.status'),
      content: () => (
        <Details
          items={[
            [copyText('market.listing'), <span lang="und">{row.title}</span>],
            [copyText('market.seller'), <code lang="zxx">{row.vendorId}</code>],
            [copyText('market.price'), <MarketPrice price={row.price} assetId={row.assetId} />],
            [
              copyText('market.access'),
              row.periodSeconds
                ? copyText('market.seconds.one.paid.period', { seconds: row.periodSeconds })
                : copyText('market.one.time.purchase'),
            ],
            [copyText('market.renewal'), copyText('market.automatic.recurring.charges.are.not.built')],
          ]}
        />
      ),
      run: (canDispatch) =>
        purchaseListing(api, {
          userId,
          row,
          purchaseId,
          canDispatch,
          onOutcome: (outcome) => {
            bought.current = outcome;
          },
        }),
      done: purchases.reload,
    });
  }
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
    <CatalogueTemplate
      title={copyText('moreroutes.market')}
      description={copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace')}
      state={{ kind: 'ready' }}
      filters={
        <Tabs
          label={copyText('market.catalogue')}
          current="/market"
          items={[
            { label: copyText('market.catalogue'), href: '/market' },
            { label: copyText('market.my.listings'), href: '/market/mine' },
            { label: copyText('market.publish.a.strategy.subscription'), href: '/market/strategy' },
          ]}
        />
      }
      items={
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
          <MarketDoors />
          <Section title={copyText('market.browse.listings')} className="lt-stack">
            <div className="lt-toolbar">
              <CategorySelect value={category} onChange={setCategory} allLabel={marketListingCopy.t('categoryAll')} />
              <p className="lt-hint">{marketListingCopy.t('categoryNote')}</p>
            </div>
            <KitRead
              resource={listings.resource}
              retry={listings.reload}
              empty={category ? marketListingCopy.t('categoryEmpty') : copyText('market.no.listings.are.available')}
            >
              {(allRows) => {
                const rows = filterListings(allRows, filter);
                const detail = allRows.find((row) => row.id === detailId) ?? null;
                return (
                  <>
                    <MarketFilters rows={allRows} filter={filter} onChange={setFilter} shown={rows.length} />
                    {detail ? (
                      <Sheet open title={detail.title} onClose={() => setDetailId(null)}>
                        <ListingDetail
                          row={detail}
                          signedIn={Boolean(userId)}
                          onClose={() => setDetailId(null)}
                          onSeller={(vendorId) => {
                            setFilter({ ...NO_FILTER, vendorId });
                            setDetailId(null);
                          }}
                        >
                          <div className="lt-stack">
                            <span className="lt-hint">
                              <Text k="market.price" />
                            </span>
                            <div role="group" aria-label={copyText('market.price')}>
                              <strong className="lt-num" lang="zxx">
                                {displayAmount(detail.price)}
                              </strong>{' '}
                              <span lang="zxx">{detail.assetId}</span>
                            </div>
                          </div>
                          {heldPurchaseOf(detail.id) ? (
                            <p>
                              <Text k="market.you.own.this.held" />
                            </p>
                          ) : null}
                          <div className="lt-actions">
                            <Button
                              tone="primary"
                              disabled={action.disabled || detail.status !== 'active' || Boolean(heldPurchaseOf(detail.id))}
                              onClick={() => buy(detail)}
                            >
                              {detail.offerType === 'subscription' ? <Text k="market.buy.one.period" /> : <Text k="market.buy" />}
                            </Button>
                          </div>
                          {action.feedback}
                        </ListingDetail>
                      </Sheet>
                    ) : null}
                    <div className="lt-grid">
                      {rows.map((row) => (
                        <article className="lt-stack" key={row.id}>
                          <h3 lang="und">{row.title}</h3>
                          <p className="lt-hint" lang="und">
                            {row.description}
                          </p>
                          <dl className="lt-kv">
                            <div>
                              <dt>
                                <Text k="market.seller" />
                              </dt>
                              <dd>
                                <code className="lt-mono" lang="zxx">
                                  {row.vendorId}
                                </code>
                              </dd>
                            </div>
                            <div>
                              <dt>
                                <Text k="market.offer" />
                              </dt>
                              <dd lang="zxx">{row.offerType}</dd>
                            </div>
                            <div>
                              <dt>
                                <Text k="market.review" />
                              </dt>
                              <dd data-review-state={row.reviewState}>
                                <Text k={REVIEW_COPY[row.reviewState]} />
                              </dd>
                            </div>
                            <div>
                              <dt>
                                <Text k="market.price" />
                              </dt>
                              <dd>
                                <MarketPrice price={row.price} assetId={row.assetId} />
                              </dd>
                            </div>
                            <div>
                              <dt>
                                <Text k="market.access" />
                              </dt>
                              <dd>
                                <p>
                                  {row.periodSeconds
                                    ? copyText('market.seconds.one.paid.period', { seconds: row.periodSeconds })
                                    : copyText('market.one.time.purchase')}
                                </p>
                                {row.offerType === 'subscription' && (
                                  <p className="lt-hint">
                                    <Text k="market.automatic.recurring.charges.are.not.built" />
                                  </p>
                                )}
                              </dd>
                            </div>
                          </dl>
                          <div className="lt-actions">
                            <Button
                              tone="quiet"
                              aria-label={copyText('market.view.listing.2', { value1: row.title })}
                              lang="und"
                              onClick={() => setDetailId(row.id)}
                            >
                              <Text k="market.view.listing" />
                            </Button>
                            <Button
                              tone="primary"
                              disabled={action.disabled || row.status !== 'active' || Boolean(heldPurchaseOf(row.id))}
                              onClick={() => buy(row)}
                              onFocus={(event) => {
                                const target = event.currentTarget;
                                if (!target.matches(':focus-visible')) return;
                                const navigation = document.querySelector<HTMLElement>('.mobile-doors')?.getBoundingClientRect();
                                if (navigation?.height && target.getBoundingClientRect().bottom > navigation.top)
                                  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                              }}
                              aria-label={copyText('market.buy.2', { value1: row.title })}
                              lang="und"
                            >
                              {row.offerType === 'subscription' ? <Text k="market.buy.one.period" /> : <Text k="market.buy" />}
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                    <Limit count={allRows.length} limit={limit} cap={50} onChange={setLimit} />
                  </>
                );
              }}
            </KitRead>
          </Section>
          <SellerDirectory
            onSeller={(vendorId) => {
              setFilter({ ...NO_FILTER, vendorId });
              setDetailId(null);
            }}
          />
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
          {detailId ? null : action.feedback}
          {action.dialog}
        </div>
      }
    />
  );
}
