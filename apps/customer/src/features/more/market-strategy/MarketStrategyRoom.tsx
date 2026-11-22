// volt-room: /market/strategy
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, Field } from '@intafaced/ui/lit';
import { FlowTemplate, Skeleton, Table, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import {
  MARKET_APPLY_AS_VENDOR,
  MARKET_ARCHIVE_LISTING,
  MARKET_CANCEL_SUBSCRIPTION,
  MARKET_COMMERCE_PROGRAMME,
  MARKET_CREATE_STRATEGY_LISTING,
  MARKET_MINE,
  MARKET_MY_LISTINGS,
  MARKET_MY_PURCHASES,
  MARKET_REFUND,
  MARKET_REFUND_REQUESTS,
  MARKET_RELEASE_SLOT,
  MARKET_REQUEST_REFUND,
  MARKET_SLOTS,
  type MarketListing,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import { t as copyText, Text } from '../copy';
import { useApi, useSession } from '../../session';
import { useResource, type Resource } from '../../../shared/resource';
import { usePreferences } from '../../../shared/preferences';
import { decimalSchema, parseAmount } from '../../../shared/money';
import type { ApiResult } from '../../../shared/api';
import { filterListings, NO_FILTER, type ListingFilter } from '../market-explorer';
import { useAction } from '../common';
import { marketRecover, REVIEW_COPY, refundPolicyUnset } from '../market-room';
import { readRefusal } from './read-refusal';
import { Details, Limit, ListingFilters, ListingSheet, MarketPrice, Retry, TextArea } from './StrategyParts';
import { StrategyPurchases } from './StrategyPurchases';

/**
 * `/market/strategy`: a seller publishes a strategy subscription (MC-market-01), on the flow template. The same seller
 * workspace `/market/mine` shows (their listings, application, listing capacity, refund requests and purchases), with
 * the listing form fixed to a subscription that `createStrategyListing` files. Every call, check and outcome rule is the
 * Market room's own (`../market-room.ts`, the `market` action journal); svc-market enforces approval, stake capacity
 * and the house commission.
 */
const PATH = '/market/strategy';
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`market-strategy-${id}`}>
      <h2 id={`market-strategy-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

/** One read in place: a still shape while it loads, "Try again" where it failed (the room's refusal names why), else its rows. */
function Read<T>({
  resource,
  retry,
  empty,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Skeleton shape="rows" count={2} />;
  if (resource.status === 'failed') return <Retry failure={resource.failure} retry={retry} />;
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return <EmptyState title={empty} />;
  return <>{children(resource.data)}</>;
}

export function MarketStrategyRoom() {
  const api = useApi(),
    { userId } = useSession(),
    { language } = usePreferences(),
    action = useAction('market', {
      recover: marketRecover(api, userId),
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
  // The read keys are the Market room's own for `strategy`, so both pages share one read of the same rows.
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
  const when = (at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
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
      run: async () =>
        refundPolicyUnset(
          await api.call(
            MARKET_REQUEST_REFUND,
            { purchaseId: row.id },
            { accept: (p) => p.id === row.id && p.buyerId === userId && p.status === 'held' && Boolean(p.refundRequestedAt) },
          ),
        ),
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
      run: async () =>
        refundPolicyUnset(
          await api.call(
            MARKET_REFUND,
            { purchaseId: row.id },
            { accept: (p) => p.id === row.id && p.buyerId === row.buyerId && p.status === 'refunded' },
          ),
        ),
      done: refundRequests.reload,
    });
  }
  function archive(row: MarketListing) {
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
          { accept: (result) => result.id === row.id && result.vendorId === row.vendorId && result.status === 'archived' },
        ),
      done: () => {
        listings.reload();
        slots.reload();
      },
    });
  }
  function apply() {
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
          accept: (row) => row.userId === userId && row.displayName === input.displayName && row.description === input.description,
        }),
      done: vendor.reload,
    });
  }
  function publish() {
    const offerType = 'subscription';
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
          row.offerType === offerType &&
          row.periodSeconds === periodSeconds &&
          row.status === 'active';
        return api.call(MARKET_CREATE_STRATEGY_LISTING, { ...terms, periodSeconds: Number(period) }, { accept });
      },
      done: () => {
        listings.reload();
        slots.reload();
      },
    });
  }
  // Read from the service: null means the owner has not decided it, so the room names that blocker beside the refund controls.
  const policyUnset = programme.resource.status === 'ready' && programme.resource.data.refundPolicy === null;
  const policyNote = (
    <p role="note" data-code="owner.decision">
      <Text k="market.refund.policy.is.not.set" /> <code lang="zxx">owner.decision</code>
    </p>
  );
  const validPrice = decimalSchema.safeParse(price).success && parseAmount(price) > 0n;
  const validPeriod = /^[1-9]\d*$/.test(period) && Number.isSafeInteger(Number(period));

  // A read that failed is named once, above the room, in the app's words; the part it fed keeps its place with "Try again".
  const failed = [programme, listings, vendor, slots, refundRequests, purchases]
    .map((read) => (read.resource.status === 'failed' ? (read.resource.failure as Failed) : null))
    .find((failure) => failure !== null);
  const returnTo = typeof location === 'undefined' ? PATH : location.pathname + location.search;
  let state: RoomState = { kind: 'ready' };
  const reads = [programme, listings, vendor, slots, refundRequests, purchases];
  if (!userId && failed) state = { kind: 'refused', refusal: readRefusal(failed, language, returnTo) };
  else if (!userId && reads.some((read) => read.resource.status === 'loading')) state = { kind: 'loading' };
  else if (failed) state = { kind: 'ready', partial: { missing: readRefusal(failed, language, returnTo) } };

  return (
    <FlowTemplate
      title={copyText('moreroutes.strategy.subscriptions')}
      description={copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace')}
      state={state}
      step={
        <div>
          <Tabs
            label={copyText('market.catalogue')}
            current={PATH}
            items={[
              { label: copyText('market.catalogue'), href: '/market' },
              { label: copyText('market.my.listings'), href: '/market/mine' },
              { label: copyText('market.publish.a.strategy.subscription'), href: PATH },
            ]}
          />
          {programme.resource.status === 'ready' ? (
            <p>
              {programme.resource.data.commissionConfigured && programme.resource.data.commissionBps !== null
                ? copyText('market.published.house.commission.basis.points.charged.to', { value1: programme.resource.data.commissionBps })
                : copyText('market.the.house.commission.is.unpublished.the.service')}
            </p>
          ) : (
            <Read resource={programme.resource} retry={programme.reload}>
              {() => null}
            </Read>
          )}
          <Section id="listings" title={copyText('market.your.listings')}>
            <Read resource={listings.resource} retry={listings.reload} empty={copyText('market.you.have.no.listings')}>
              {(allRows) => {
                const rows = filterListings(allRows, filter);
                const detail = allRows.find((row) => row.id === detailId) ?? null;
                return (
                  <>
                    <ListingFilters rows={allRows} filter={filter} onChange={setFilter} shown={rows.length} />
                    {detail ? (
                      <ListingSheet
                        row={detail}
                        signedIn={Boolean(userId)}
                        onClose={() => setDetailId(null)}
                        onSeller={(vendorId) => {
                          setFilter({ ...NO_FILTER, vendorId });
                          setDetailId(null);
                        }}
                      >
                        <Details items={[[copyText('market.price'), <MarketPrice price={detail.price} assetId={detail.assetId} />]]} />
                        {action.feedback}
                      </ListingSheet>
                    ) : null}
                    <div>
                      {rows.map((row) => (
                        <article key={row.id}>
                          <h3 lang="und">{row.title}</h3>
                          <p lang="und">{row.description}</p>
                          <Details
                            items={[
                              [copyText('market.seller'), <code lang="zxx">{row.vendorId}</code>],
                              [copyText('market.offer'), <span lang="zxx">{row.offerType}</span>],
                              [copyText('market.status'), <span lang="zxx">{row.status}</span>],
                              [
                                copyText('market.review'),
                                <span data-review-state={row.reviewState}>
                                  <Text k={REVIEW_COPY[row.reviewState]} />
                                </span>,
                              ],
                              [copyText('market.price'), <MarketPrice price={row.price} assetId={row.assetId} />],
                              [
                                copyText('market.access'),
                                <>
                                  {row.periodSeconds
                                    ? copyText('market.seconds.one.paid.period', { seconds: row.periodSeconds })
                                    : copyText('market.one.time.purchase')}
                                  {row.offerType === 'subscription' && (
                                    <small>
                                      {' '}
                                      <Text k="market.automatic.recurring.charges.are.not.built" />
                                    </small>
                                  )}
                                </>,
                              ],
                            ]}
                          />
                          <div className="lt-actions">
                            <Button
                              tone="quiet"
                              aria-label={copyText('market.view.listing.2', { value1: row.title })}
                              lang="und"
                              onClick={() => setDetailId(row.id)}
                            >
                              <Text k="market.view.listing" />
                            </Button>
                            <Button tone="secondary" disabled={action.disabled || row.status === 'archived'} onClick={() => archive(row)}>
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
            </Read>
          </Section>
          <Section id="application" title={copyText('market.seller.application')}>
            <Read resource={vendor.resource} retry={vendor.reload}>
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
                    onSubmit={(e) => {
                      e.preventDefault();
                      apply();
                    }}
                  >
                    <Field
                      label={copyText('market.seller.display.name')}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={80}
                      required
                    />
                    <TextArea
                      label={copyText('market.seller.description')}
                      value={description}
                      onChange={setDescription}
                      maxLength={2000}
                    />
                    <Button type="submit" tone="primary" disabled={action.disabled || !name.trim() || !description.trim()}>
                      <Text k="market.review.application" />
                    </Button>
                  </form>
                )
              }
            </Read>
          </Section>
          <Section id="capacity" title={copyText('market.listing.capacity')}>
            <Read resource={slots.resource} retry={slots.reload}>
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
                        <div key={slot.id} className="lt-actions">
                          <code lang="zxx">{slot.ref}</code>
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
            </Read>
          </Section>
          <Section id="publish" title={copyText('market.publish.a.strategy.subscription')}>
            <p>
              <Text k="market.approval.and.stake.capacity.are.enforced.by" />
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                publish();
              }}
            >
              <Field label={copyText('market.listing.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              <TextArea label={copyText('market.listing.description')} value={description} onChange={setDescription} maxLength={4000} />
              <Field label={copyText('market.price.asset.id')} value={asset} onChange={(e) => setAsset(e.target.value)} maxLength={32} />
              <Field label={copyText('market.price')} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              <Field
                label={copyText('market.paid.period.in.seconds')}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                inputMode="numeric"
              />
              <Button
                type="submit"
                tone="primary"
                disabled={action.disabled || !title.trim() || !description.trim() || !asset.trim() || !validPrice || !validPeriod}
              >
                <Text k="market.review.listing" />
              </Button>
            </form>
          </Section>
          <Section id="refunds" title={copyText('market.refund.requests')}>
            <p>
              <Text k="market.refund.requests.meaning" />
            </p>
            {policyUnset && policyNote}
            <Read resource={refundRequests.resource} retry={refundRequests.reload}>
              {(rows) =>
                rows.length ? (
                  <Table
                    caption={copyText('market.refund.requests')}
                    rows={rows}
                    rowKey={(row) => row.id}
                    columns={[
                      {
                        key: 'listing',
                        label: copyText('market.listing'),
                        cell: (row) => <span lang="und">{titleOf(row.listingId) ?? row.listingId}</span>,
                      },
                      {
                        key: 'price',
                        label: copyText('market.price'),
                        align: 'end',
                        cell: (row) => <MarketPrice price={row.price} assetId={row.assetId} />,
                      },
                      {
                        key: 'window',
                        label: copyText('market.refund.window.ends'),
                        cell: (row) => (row.refundWindowEndsAt ? when(row.refundWindowEndsAt) : null),
                      },
                      {
                        key: 'requested',
                        label: copyText('market.requested.at'),
                        cell: (row) => (row.refundRequestedAt ? when(row.refundRequestedAt) : null),
                      },
                      { key: 'buyer', label: copyText('market.buyer'), ltr: true, cell: (row) => <code lang="zxx">{row.buyerId}</code> },
                      {
                        key: 'refund',
                        label: copyText('market.refund'),
                        cell: (row) => (
                          <Button tone="secondary" disabled={action.disabled} onClick={() => refund(row)}>
                            <Text k="market.refund" />
                          </Button>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <EmptyState title={copyText('market.no.refund.requests')} />
                )
              }
            </Read>
          </Section>
          <Section id="purchases" title={copyText('market.your.purchases')}>
            <StrategyPurchases
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
                      run: () =>
                        api.call(
                          MARKET_CANCEL_SUBSCRIPTION,
                          { listingId: row.listingId },
                          { accept: (result) => result.listingId === row.listingId && result.buyerId === userId },
                        ),
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
