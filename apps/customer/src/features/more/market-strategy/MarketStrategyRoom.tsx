// volt-room: /market/strategy
import { useState } from 'react';
import {
  MARKET_APPLY_AS_VENDOR,
  MARKET_ARCHIVE_LISTING,
  MARKET_COMMERCE_PROGRAMME,
  MARKET_CREATE_STRATEGY_LISTING,
  MARKET_MINE,
  MARKET_MY_LISTINGS,
  MARKET_MY_PURCHASES,
  MARKET_REFUND_REQUESTS,
  MARKET_RELEASE_SLOT,
  MARKET_SLOTS,
  type MarketListing,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate, Sheet, Tabs, TextAreaField } from '@intafaced/ui/lit/templates';
import { decimalSchema, displayAmount, parseAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session';
import { Details, formatBpsPercent, Limit } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { filterListings, NO_FILTER, type ListingFilter } from '../market-explorer';
import { ListingDetail, MarketFilters } from '../MarketExplorer';
import { MarketPurchaseRecords } from '../MarketPurchaseRecords';
import { useKitAction } from '../volt-action';
import { EmptyNote, KitRead, ScrollTable, Section } from '../volt-parts';
import {
  cancelMarketSubscription,
  recoverMarketAction,
  refundMarketPurchase,
  requestMarketRefund,
  REVIEW_COPY,
} from '../market-room/market-calls';

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
 * `/market/strategy` on the flow template: publish a strategy subscription, manage seller application and listing
 * capacity, review your listings, handle refund requests and inspect your purchases. Uses the same calls, predicates
 * and words as the strategy mode of `../Market.tsx`.
 */
export function MarketStrategyRoom() {
  const api = useApi(),
    { userId } = useSession(),
    action = useKitAction('market', {
      recover: (reference) => recoverMarketAction(api, userId, reference),
      done: () => purchases.reload(),
    });
  const [limit, setLimit] = useState(50),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [title, setTitle] = useState(''),
    [asset, setAsset] = useState(''),
    [price, setPrice] = useState(''),
    [period, setPeriod] = useState(''),
    [filter, setFilter] = useState<ListingFilter>(NO_FILTER),
    [detailId, setDetailId] = useState<string | null>(null);
  const listings = useResource(async (signal) => {
      const owner = await api.call(MARKET_MINE, undefined, { signal, accept: (row) => !row || row.userId === userId });
      if (!owner.ok) return owner;
      if (!owner.data) return { ok: true as const, data: [] };
      const vendorId = owner.data.id;
      return api.call(MARKET_MY_LISTINGS, { limit }, { signal, accept: (rows) => rows.every((row) => row.vendorId === vendorId) });
    }, `listings:false:true:${userId}:${limit}:`),
    programme = useResource((signal) => api.call(MARKET_COMMERCE_PROGRAMME, undefined, { signal }), 'market-programme');
  const purchases = useResource(
    (signal) => api.call(MARKET_MY_PURCHASES, { limit }, { signal, accept: (rows) => rows.every((row) => row.buyerId === userId) }),
    `purchases:${userId}:${limit}`,
  );
  // The seller's held purchases whose buyer asked for a refund (MC-market-02).
  const refundRequests = useResource(
    (signal) => api.call(MARKET_REFUND_REQUESTS, { limit: 50 }, { signal, accept: (rows) => rows.every((r) => r.vendorUserId === userId) }),
    `refund-requests:${userId}:false:true`,
  );
  const preferences = usePreferences();
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const vendor = useResource(
      (signal) => api.call(MARKET_MINE, undefined, { signal, accept: (row) => !row || row.userId === userId }),
      `vendor:${userId}:false:true`,
    ),
    slots = useResource((signal) => api.call(MARKET_SLOTS, undefined, { signal }), `slots:${userId}:false:true`);
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
  function refund(row: MarketPurchase) {
    action.stage({
      title: () => copyText('market.refund.the.buyer'),
      reference: `refund:${row.id}`,
      confirm: () => copyText('market.refund.the.buyer'),
      success: () => copyText('market.refunded'),
      content: () => (
        <>
          <Details
            items={[
              [copyText('market.listing'), <span lang="und">{titleOf(row.listingId) ?? row.listingId}</span>],
              [copyText('market.buyer'), <code lang="zxx">{row.buyerId}</code>],
              [copyText('market.price'), <MarketPrice price={row.price} assetId={row.assetId} />],
            ]}
          />
          <p>
            <Text k="market.refund.body" />
          </p>
        </>
      ),
      run: () => refundMarketPurchase(api, row),
      done: refundRequests.reload,
    });
  }
  // Read from the service: null means the owner has not decided it, so the room names that blocker beside the refund controls.
  const policyUnset = programme.resource.status === 'ready' && programme.resource.data.refundPolicy === null;
  const policyNote = (
    <p className="lt-hint" role="note" data-code="owner.decision">
      <Text k="market.refund.policy.is.not.set" /> <code lang="zxx">owner.decision</code>
    </p>
  );
  const validPrice = decimalSchema.safeParse(price).success && parseAmount(price) > 0n;
  const validPeriod = /^[1-9]\d*$/.test(period) && Number.isSafeInteger(Number(period));

  return (
    <FlowTemplate
      title={copyText('moreroutes.strategy.subscriptions')}
      description={copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack">
          <Tabs
            label={copyText('market.catalogue')}
            current="/market/strategy"
            items={[
              { label: copyText('market.catalogue'), href: '/market' },
              { label: copyText('market.my.listings'), href: '/market/mine' },
              { label: copyText('market.publish.a.strategy.subscription'), href: '/market/strategy' },
            ]}
          />
          <KitRead resource={programme.resource} retry={programme.reload}>
            {(p) => (
              <p className="lt-hint">
                {p.commissionConfigured && p.commissionBps !== null
                  ? copyText('market.published.house.commission.basis.points.charged.to', { value1: formatBpsPercent(p.commissionBps) })
                  : copyText('market.the.house.commission.is.unpublished.the.service')}
              </p>
            )}
          </KitRead>
          <Section title={copyText('market.publish.a.strategy.subscription')} className="lt-stack">
            <p className="lt-muted">
              <Text k="market.approval.and.stake.capacity.are.enforced.by" />
            </p>
            <form
              className="lt-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const terms = { title: title.trim(), description: description.trim(), assetId: asset.trim(), price };
                const periodSeconds = Number(period);
                const reviewedVendorId = vendor.resource.status === 'ready' ? vendor.resource.data?.id : undefined;
                action.stage({
                  title: () => copyText('market.review.listing'),
                  confirm: () => copyText('market.publish.listing'),
                  success: () => copyText('market.listing.published'),
                  content: () => (
                    <Details
                      items={[
                        [copyText('market.title'), <span lang="und">{title}</span>],
                        [copyText('market.description'), <span lang="und">{description}</span>],
                        [copyText('market.price'), <MarketPrice price={price} assetId={asset} />],
                        [copyText('market.offer'), copyText('market.strategy.subscription')],
                        [copyText('market.period'), copyText('market.period.seconds', { seconds: period })],
                      ]}
                    />
                  ),
                  run: () => {
                    const accept = (row: MarketListing) =>
                      (!reviewedVendorId || row.vendorId === reviewedVendorId) &&
                      row.title === terms.title &&
                      row.description === terms.description &&
                      row.assetId === terms.assetId &&
                      parseAmount(row.price) === parseAmount(terms.price) &&
                      row.offerType === 'subscription' &&
                      row.periodSeconds === periodSeconds &&
                      row.status === 'active';
                    return api.call(MARKET_CREATE_STRATEGY_LISTING, { ...terms, periodSeconds: Number(period) }, { accept });
                  },
                  done: () => {
                    listings.reload();
                    slots.reload();
                  },
                });
              }}
            >
              <Field label={copyText('market.listing.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              <TextAreaField
                label={copyText('market.listing.description')}
                value={description}
                onChange={setDescription}
                maxLength={4000}
              />
              <Field label={copyText('market.price.asset.id')} value={asset} onChange={(e) => setAsset(e.target.value)} maxLength={32} />
              <Field label={copyText('market.price')} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              <Field
                label={copyText('market.paid.period.in.seconds')}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                inputMode="numeric"
              />
              <Button
                tone="primary"
                type="submit"
                disabled={action.disabled || !title.trim() || !description.trim() || !asset.trim() || !validPrice || !validPeriod}
              >
                <Text k="market.review.listing" />
              </Button>
            </form>
          </Section>
          <Section title={copyText('market.your.listings')} className="lt-stack">
            <KitRead resource={listings.resource} retry={listings.reload} empty={copyText('market.you.have.no.listings')}>
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
                                <Text k="market.status" />
                              </dt>
                              <dd lang="zxx">{row.status}</dd>
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
                              tone="secondary"
                              disabled={action.disabled || row.status === 'archived'}
                              onClick={() =>
                                action.stage({
                                  title: () => copyText('market.archive.listing'),
                                  confirm: () => copyText('market.archive.listing'),
                                  success: () => copyText('market.listing.archived'),
                                  content: () => (
                                    <>
                                      <p>
                                        <span lang="und">{row.title}</span>
                                        <Text k="market.will.leave.the.public.catalogue" />
                                      </p>
                                      <Details
                                        items={[
                                          [copyText('market.listing'), <code lang="zxx">{row.id}</code>],
                                          [copyText('market.seller'), <code lang="zxx">{row.vendorId}</code>],
                                          [copyText('market.price'), <MarketPrice price={row.price} assetId={row.assetId} />],
                                        ]}
                                      />
                                    </>
                                  ),
                                  run: () =>
                                    api.call(
                                      MARKET_ARCHIVE_LISTING,
                                      { listingId: row.id },
                                      {
                                        accept: (result) =>
                                          result.id === row.id && result.vendorId === row.vendorId && result.status === 'archived',
                                      },
                                    ),
                                  done: () => {
                                    listings.reload();
                                    slots.reload();
                                  },
                                })
                              }
                            >
                              <Text k="market.archive" />
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
          <Section title={copyText('market.refund.requests')} className="lt-stack">
            <p className="lt-muted">
              <Text k="market.refund.requests.meaning" />
            </p>
            {policyUnset && policyNote}
            <KitRead resource={refundRequests.resource} retry={refundRequests.reload}>
              {(rows) =>
                rows.length ? (
                  <ScrollTable
                    label={copyText('market.refund.requests')}
                    headers={[
                      copyText('market.listing'),
                      copyText('market.price'),
                      copyText('market.refund.window.ends'),
                      copyText('market.requested.at'),
                      copyText('market.buyer'),
                      copyText('market.refund'),
                    ]}
                  >
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <span lang="und">{titleOf(row.listingId) ?? row.listingId}</span>
                        </td>
                        <td>
                          <MarketPrice price={row.price} assetId={row.assetId} />
                        </td>
                        <td>{row.refundWindowEndsAt ? when(row.refundWindowEndsAt) : null}</td>
                        <td>{row.refundRequestedAt ? when(row.refundRequestedAt) : null}</td>
                        <td>
                          <code lang="zxx">{row.buyerId}</code>
                        </td>
                        <td>
                          <Button tone="secondary" disabled={action.disabled} onClick={() => refund(row)}>
                            <Text k="market.refund" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </ScrollTable>
                ) : (
                  <EmptyNote title={copyText('market.no.refund.requests')} />
                )
              }
            </KitRead>
          </Section>
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
      summary={
        <div className="lt-stack">
          <Section title={copyText('market.seller.application')} className="lt-stack">
            <KitRead resource={vendor.resource} retry={vendor.reload}>
              {(row) =>
                row ? (
                  <Details
                    items={[
                      [copyText('market.display.name'), <span lang="und">{row.displayName}</span>],
                      [copyText('market.seller'), <code lang="zxx">{row.id}</code>],
                      [copyText('market.status'), <span lang="zxx">{row.status}</span>],
                      [copyText('market.description'), <span lang="und">{row.description}</span>],
                    ]}
                  />
                ) : (
                  <form
                    className="lt-stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const input = { displayName: name.trim(), description: description.trim() };
                      action.stage({
                        title: () => copyText('market.review.seller.application'),
                        confirm: () => copyText('market.submit.application'),
                        success: () => copyText('market.application.received'),
                        content: () => (
                          <Details
                            items={[
                              [copyText('market.display.name'), <span lang="und">{name}</span>],
                              [copyText('market.description'), <span lang="und">{description}</span>],
                            ]}
                          />
                        ),
                        run: () =>
                          api.call(MARKET_APPLY_AS_VENDOR, input, {
                            accept: (row) =>
                              row.userId === userId && row.displayName === input.displayName && row.description === input.description,
                          }),
                        done: vendor.reload,
                      });
                    }}
                  >
                    <Field
                      label={copyText('market.seller.display.name')}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={80}
                      required
                    />
                    <TextAreaField
                      label={copyText('market.seller.description')}
                      value={description}
                      onChange={setDescription}
                      maxLength={2000}
                    />
                    <Button tone="primary" type="submit" disabled={action.disabled || !name.trim() || !description.trim()}>
                      <Text k="market.review.application" />
                    </Button>
                  </form>
                )
              }
            </KitRead>
          </Section>
          <Section title={copyText('market.listing.capacity')} className="lt-stack">
            <KitRead resource={slots.resource} retry={slots.reload}>
              {(s) =>
                s ? (
                  <>
                    <Details
                      items={[
                        [copyText('market.stake.tier'), s.tier],
                        [copyText('market.capacity'), s.capacity],
                        [copyText('market.held.slots'), s.held],
                        [copyText('market.usable.listings'), s.usable],
                      ]}
                    />
                    {s.slots
                      .filter((r) => r.releasedAt === null)
                      .map((slot) => (
                        <div key={slot.id} className="lt-toolbar">
                          <code className="lt-mono" lang="zxx">
                            {slot.ref}
                          </code>
                          <Button
                            tone="secondary"
                            disabled={action.disabled}
                            onClick={() =>
                              action.stage({
                                title: () => copyText('market.release.listing.slot'),
                                confirm: () => copyText('market.release.slot'),
                                success: () => copyText('market.slot.release.confirmed'),
                                content: () => (
                                  <p>
                                    <Text k="market.release" />
                                    <code lang="zxx">{slot.ref}</code>
                                    <Text k="market.a.listing.without.a.slot.will.no" />
                                  </p>
                                ),
                                run: () => api.call(MARKET_RELEASE_SLOT, { ref: slot.ref }),
                                done: slots.reload,
                              })
                            }
                          >
                            <Text k="market.release.2" />
                          </Button>
                        </div>
                      ))}
                  </>
                ) : null
              }
            </KitRead>
          </Section>
        </div>
      }
    />
  );
}
