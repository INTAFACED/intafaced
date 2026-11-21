import { SubNav } from '@intafaced/ui';
import { copy, t as copyText, Text } from './copy';
import { useRef, useState } from 'react';
import {
  MARKET_APPLY_AS_VENDOR,
  MARKET_ARCHIVE_LISTING,
  MARKET_CANCEL_SUBSCRIPTION,
  MARKET_COMMERCE_PROGRAMME,
  MARKET_CREATE_LISTING,
  MARKET_CREATE_STRATEGY_LISTING,
  MARKET_LISTINGS,
  MARKET_LISTINGS_BY_CATEGORY,
  MARKET_MINE,
  MARKET_MY_LISTINGS,
  MARKET_MY_PURCHASES,
  MARKET_PURCHASE,
  MARKET_REFUND,
  MARKET_REFUND_REQUESTS,
  MARKET_RELEASE_SLOT,
  MARKET_REQUEST_REFUND,
  MARKET_SLOTS,
  type ListingReviewState,
  type MarketListing,
  type MarketPurchase,
} from '@intafaced/contracts/market-procedures';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Dialog, EmptyState, Field, Panel } from '../../shared/ui';
import { MarketPurchaseRecords } from './MarketPurchaseRecords';
import { CategorySelect, ListingDetail, MarketDoors, MarketFilters, SellerDirectory } from './MarketExplorer';
import { marketListingCopy } from './market-listing-copy';
import { filterListings, NO_FILTER, type ListingFilter } from './market-explorer';
import { Details, Limit, Read, Select, TextArea, useAction, presentActionFailure } from './common';
import type { ApiResult, RefusalReason } from '../../shared/api';
type MarketFailureKey =
  | 'market.original.purchase.is.still.pending.settlement.is'
  | 'market.the.original.settlement.evidence.is.incomplete.keep'
  | 'market.the.original.purchase.is.not.present.in'
  | 'market.the.listing.terms.changed.reload.the.catalogue'
  | 'market.the.account.changed.review.this.purchase.again';
function marketRefusal(reason: RefusalReason, key: MarketFailureKey) {
  return presentActionFailure({ ok: false as const, reason, message: copyText(key) }, (locale) => {
    const current = copy.forLocale(locale);
    return { message: current.t(key), language: current.languageFor(key) };
  });
}
function MarketPrice({ price, assetId }: { price: string; assetId: string }) {
  return (
    <div className="market-purchases-value" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="market-purchases-exact-price" tabIndex={0} role="group" aria-label={copyText('market.price')}>
        <strong className="numeric" lang="zxx">
          {displayAmount(price)}
        </strong>
      </div>{' '}
      <span lang="zxx">{assetId}</span>
    </div>
  );
}
const REVIEW_COPY = {
  in_review: 'market.review.state.in.review',
  approved: 'market.review.state.approved',
  rejected: 'market.review.state.rejected',
  suspended: 'market.review.state.suspended',
  taken_down: 'market.review.state.taken.down',
} as const satisfies Record<ListingReviewState, string>;
function originalPurchaseOutcome(row: MarketPurchase): ApiResult<MarketPurchase> {
  if (row.status === 'pending') return marketRefusal('uncertain', 'market.original.purchase.is.still.pending.settlement.is');
  if (row.status === 'settled' && row.ledgerTxId && row.settledAt) return { ok: true, data: row };
  // A held purchase is paid into the buyer's held pot (MC-market-02); its release or refund comes later.
  if ((row.status === 'held' || row.status === 'released' || row.status === 'refunded') && row.ledgerTxId) return { ok: true, data: row };
  // The service marks rejected only for a definitive failed ledger admission;
  // it retains the rejection code and has no settlement evidence for that row.
  if (row.status === 'rejected' && row.rejectionCode && row.ledgerTxId === null && row.settledAt === null) return { ok: true, data: row };
  return marketRefusal('uncertain', 'market.the.original.settlement.evidence.is.incomplete.keep');
}
/** The service's typed refusal while the refund policy is blank, shown in the room's own words; nothing moved. */
const refundPolicyUnset = <T,>(result: ApiResult<T>): ApiResult<T> =>
  !result.ok && result.code === 'owner.decision'
    ? presentActionFailure(result, (locale) => {
        const current = copy.forLocale(locale);
        return { message: current.t('market.refund.policy.is.not.set'), language: current.languageFor('market.refund.policy.is.not.set') };
      })
    : result;
export function Market({ mine = false, strategy = false }: { mine?: boolean; strategy?: boolean }) {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('market', {
      recover: async (reference) => {
        // A refund: the service's refund is keyed on the purchase, so asking again returns the stored outcome
        // (the whole price returns once); a purchase that is no longer held is a known outcome, not a pending one. So is
        // owner.decision: the service refuses it only before any refund was claimed, so nothing moved.
        if (reference.startsWith('refund:')) {
          const id = reference.slice('refund:'.length);
          const again = await api.call(MARKET_REFUND, { purchaseId: id }, { accept: (p) => p.id === id && p.status === 'refunded' });
          return !again.ok && (again.code === 'market.refund_not_held' || again.code === 'owner.decision')
            ? { ok: true, data: null }
            : again;
        }
        const requested = reference.startsWith('refund-request:') ? reference.slice('refund-request:'.length) : null;
        const rows = await api.call(MARKET_MY_PURCHASES, { limit: 50 }, { accept: (rows) => rows.every((r) => r.buyerId === userId) });
        if (!rows.ok) return rows;
        if (requested) {
          const held = rows.data.find((r) => r.id === requested);
          if (!held) return marketRefusal('uncertain', 'market.the.original.purchase.is.not.present.in');
          if (held.refundRequestedAt || held.status !== 'held') return { ok: true, data: held };
          // The request never landed: it is still the buyer's to send, so the original is known to have failed.
          return { ok: true, data: null };
        }
        const row = rows.data.find((r) => r.id === reference);
        return row ? originalPurchaseOutcome(row) : marketRefusal('uncertain', 'market.the.original.purchase.is.not.present.in');
      },
      done: () => purchases.reload(),
    });
  const [limit, setLimit] = useState(50),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [title, setTitle] = useState(''),
    [asset, setAsset] = useState(''),
    [price, setPrice] = useState(''),
    [offer, setOffer] = useState(strategy ? 'subscription' : 'one_time'),
    [period, setPeriod] = useState(''),
    [filter, setFilter] = useState<ListingFilter>(NO_FILTER),
    // The catalogue's category ('' = every listing), and the category a new one-time listing is filed under ('' = none).
    [category, setCategory] = useState(''),
    [newCategory, setNewCategory] = useState(''),
    [detailId, setDetailId] = useState<string | null>(null);
  const listings = useResource(
      async (signal) => {
        if (!mine && !strategy)
          return category
            ? api.call(MARKET_LISTINGS_BY_CATEGORY, { category, limit }, { signal })
            : api.call(MARKET_LISTINGS, { limit }, { signal });
        const owner = await api.call(MARKET_MINE, undefined, { signal, accept: (row) => !row || row.userId === userId });
        if (!owner.ok) return owner;
        if (!owner.data) return { ok: true as const, data: [] };
        const vendorId = owner.data.id;
        return api.call(MARKET_MY_LISTINGS, { limit }, { signal, accept: (rows) => rows.every((row) => row.vendorId === vendorId) });
      },
      `listings:${mine}:${strategy}:${mine || strategy ? userId : 'public'}:${limit}:${category}`,
    ),
    programme = useResource((signal) => api.call(MARKET_COMMERCE_PROGRAMME, undefined, { signal }), 'market-programme');
  const purchases = useResource(
    (signal) => api.call(MARKET_MY_PURCHASES, { limit }, { signal, accept: (rows) => rows.every((row) => row.buyerId === userId) }),
    `purchases:${userId}:${limit}`,
  );
  // The seller's held purchases whose buyer asked for a refund (MC-market-02).
  const refundRequests = useResource(
    (signal) =>
      mine || strategy
        ? api.call(MARKET_REFUND_REQUESTS, { limit: 50 }, { signal, accept: (rows) => rows.every((r) => r.vendorUserId === userId) })
        : Promise.resolve({ ok: true as const, data: [] }),
    `refund-requests:${userId}:${mine}:${strategy}`,
  );
  const preferences = usePreferences();
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const vendor = useResource(
      (signal) =>
        mine || strategy
          ? api.call(MARKET_MINE, undefined, { signal, accept: (row) => !row || row.userId === userId })
          : Promise.resolve({ ok: true as const, data: null }),
      `vendor:${userId}:${mine}:${strategy}`,
    ),
    slots = useResource(
      (signal) => (mine || strategy ? api.call(MARKET_SLOTS, undefined, { signal }) : Promise.resolve({ ok: true as const, data: null })),
      `slots:${userId}:${mine}:${strategy}`,
    );
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
      run: async (canDispatch) => {
        const fresh = await api.call(MARKET_LISTINGS, { limit: 50 });
        if (!fresh.ok) return fresh;
        const current = fresh.data.find((r) => r.id === row.id);
        if (
          !current ||
          current.status !== 'active' ||
          current.vendorId !== row.vendorId ||
          current.price !== row.price ||
          current.assetId !== row.assetId ||
          current.periodSeconds !== row.periodSeconds ||
          current.offerType !== row.offerType
        )
          return marketRefusal('error', 'market.the.listing.terms.changed.reload.the.catalogue');
        if (!canDispatch()) return marketRefusal('aborted', 'market.the.account.changed.review.this.purchase.again');
        const result = await api.call(
          MARKET_PURCHASE,
          { listingId: row.id, purchaseId },
          {
            accept: (p) =>
              p.id === purchaseId &&
              p.listingId === row.id &&
              p.buyerId === userId &&
              p.vendorId === row.vendorId &&
              p.assetId === row.assetId &&
              p.price === row.price,
          },
        );
        if (result.ok) {
          bought.current = result.data.status === 'held' ? 'held' : 'paid';
          return originalPurchaseOutcome(result.data);
        }
        if (result.reason === 'aborted' || result.status === 401 || result.status === 403) return result;
        // The existing pending banner supplies authored recovery guidance.
        // Retain the original service explanation or transport copy descriptor.
        return { ...result, reason: 'uncertain' };
      },
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
  // Read from the service: null means the owner has not decided it, so the room names that blocker beside the refund controls.
  const policyUnset = programme.resource.status === 'ready' && programme.resource.data.refundPolicy === null;
  const policyNote = (
    <p className="muted" role="note" data-code="owner.decision">
      <Text k="market.refund.policy.is.not.set" /> <code lang="zxx">owner.decision</code>
    </p>
  );
  const validPrice = decimalSchema.safeParse(price).success && parseAmount(price) > 0n;
  const validPeriod = /^[1-9]\d*$/.test(period) && Number.isSafeInteger(Number(period));
  return (
    <div className="more-grid">
      <SubNav
        aria-label={copyText('market.catalogue')}
        active={strategy ? 'strategy' : mine ? 'mine' : 'catalogue'}
        className="px-0"
        items={[
          { id: 'catalogue', label: copyText('market.catalogue'), href: '/market' },
          { id: 'mine', label: copyText('market.my.listings'), href: '/market/mine' },
          { id: 'strategy', label: copyText('market.publish.a.strategy.subscription'), href: '/market/strategy' },
        ]}
      />
      <Read resource={programme.resource} retry={programme.reload}>
        {(p) => (
          <p className="muted">
            {p.commissionConfigured && p.commissionBps !== null
              ? copyText('market.published.house.commission.basis.points.charged.to', { value1: p.commissionBps })
              : copyText('market.the.house.commission.is.unpublished.the.service')}
          </p>
        )}
      </Read>
      {mine || strategy ? null : <MarketDoors />}
      <Panel title={mine || strategy ? copyText('market.your.listings') : copyText('market.browse.listings')}>
        {mine || strategy ? null : (
          <div className="depth-filters">
            <CategorySelect value={category} onChange={setCategory} allLabel={marketListingCopy.t('categoryAll')} />
            <p className="muted">{marketListingCopy.t('categoryNote')}</p>
          </div>
        )}
        <Read
          resource={listings.resource}
          retry={listings.reload}
          empty={
            mine || strategy
              ? copyText('market.you.have.no.listings')
              : category
                ? marketListingCopy.t('categoryEmpty')
                : copyText('market.no.listings.are.available')
          }
        >
          {(allRows) => {
            const rows = filterListings(allRows, filter);
            const detail = allRows.find((row) => row.id === detailId) ?? null;
            return (
              <>
                <MarketFilters rows={allRows} filter={filter} onChange={setFilter} shown={rows.length} />
                {detail ? (
                  <Dialog title={<span lang="und">{detail.title}</span>} onClose={() => setDetailId(null)}>
                    <ListingDetail
                      row={detail}
                      signedIn={Boolean(userId)}
                      onClose={() => setDetailId(null)}
                      onSeller={(vendorId) => {
                        setFilter({ ...NO_FILTER, vendorId });
                        setDetailId(null);
                      }}
                    >
                      <div className="market-catalogue-price">
                        <span className="muted">
                          <Text k="market.price" />
                        </span>
                        <div role="group" aria-label={copyText('market.price')}>
                          <strong className="numeric" lang="zxx">
                            {displayAmount(detail.price)}
                          </strong>{' '}
                          <span lang="zxx">{detail.assetId}</span>
                        </div>
                      </div>
                      {mine || strategy ? null : (
                        <>
                          {heldPurchaseOf(detail.id) ? (
                            <p>
                              <Text k="market.you.own.this.held" />
                            </p>
                          ) : null}
                          <Button
                            disabled={action.disabled || detail.status !== 'active' || Boolean(heldPurchaseOf(detail.id))}
                            onClick={() => buy(detail)}
                          >
                            {detail.offerType === 'subscription' ? <Text k="market.buy.one.period" /> : <Text k="market.buy" />}
                          </Button>
                        </>
                      )}
                      {action.feedback}
                    </ListingDetail>
                  </Dialog>
                ) : null}
                <div className="more-rooms market-catalogue-list">
                  {rows.map((row) => (
                    <article className="more-room-link market-catalogue-row" key={row.id}>
                      <div className="market-catalogue-main">
                        <h3 lang="und">{row.title}</h3>
                        <p className="market-catalogue-description" lang="und">
                          {row.description}
                        </p>
                        <dl className="market-catalogue-facts">
                          <div>
                            <dt>
                              <Text k="market.seller" />
                            </dt>
                            <dd>
                              <code lang="zxx">{row.vendorId}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="market.offer" />
                            </dt>
                            <dd lang="zxx">{row.offerType}</dd>
                          </div>
                          {(mine || strategy) && (
                            <div>
                              <dt>
                                <Text k="market.status" />
                              </dt>
                              <dd lang="zxx">{row.status}</dd>
                            </div>
                          )}
                          <div>
                            <dt>
                              <Text k="market.review" />
                            </dt>
                            <dd data-review-state={row.reviewState}>
                              <Text k={REVIEW_COPY[row.reviewState]} />
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <div className="market-catalogue-decision">
                        <div className="market-catalogue-price">
                          <span className="muted">
                            <Text k="market.price" />
                          </span>
                          <MarketPrice price={row.price} assetId={row.assetId} />
                        </div>
                        <div className="market-catalogue-access">
                          <span className="muted">
                            <Text k="market.access" />
                          </span>
                          <p>
                            {row.periodSeconds
                              ? copyText('market.seconds.one.paid.period', { seconds: row.periodSeconds })
                              : copyText('market.one.time.purchase')}
                          </p>
                          {row.offerType === 'subscription' && (
                            <p className="muted">
                              <Text k="market.automatic.recurring.charges.are.not.built" />
                            </p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          aria-label={copyText('market.view.listing.2', { value1: row.title })}
                          lang="und"
                          onClick={() => setDetailId(row.id)}
                        >
                          <Text k="market.view.listing" />
                        </Button>
                        {mine || strategy ? (
                          <Button
                            variant="secondary"
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
                        ) : (
                          <Button
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
                        )}
                      </div>
                    </article>
                  ))}
                </div>
                <Limit count={allRows.length} limit={limit} cap={50} onChange={setLimit} />
              </>
            );
          }}
        </Read>
      </Panel>
      {!mine && !strategy ? (
        <SellerDirectory
          onSeller={(vendorId) => {
            setFilter({ ...NO_FILTER, vendorId });
            setDetailId(null);
          }}
        />
      ) : null}
      {(mine || strategy) && (
        <div className="more-columns">
          <div>
            <Panel title={copyText('market.seller.application')}>
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
                      <TextArea
                        label={copyText('market.seller.description')}
                        value={description}
                        onChange={setDescription}
                        maxLength={2000}
                      />
                      <Button type="submit" disabled={action.disabled || !name.trim() || !description.trim()}>
                        <Text k="market.review.application" />
                      </Button>
                    </form>
                  )
                }
              </Read>
            </Panel>
            <Panel title={copyText('market.listing.capacity')}>
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
                          <div key={slot.id} className="more-inline">
                            <code lang="zxx">{slot.ref}</code>
                            <Button
                              variant="secondary"
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
            </Panel>
          </div>
          <Panel title={strategy ? copyText('market.publish.a.strategy.subscription') : copyText('market.create.a.listing')}>
            <p className="muted">
              <Text k="market.approval.and.stake.capacity.are.enforced.by" />
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const offerType = strategy || offer === 'subscription' ? 'subscription' : 'one_time';
                const terms = { title: title.trim(), description: description.trim(), assetId: asset.trim(), price };
                const periodSeconds = offerType === 'subscription' ? Number(period) : undefined;
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
                        [copyText('market.offer'), strategy ? copyText('market.strategy.subscription') : <span lang="zxx">{offer}</span>],
                        [
                          copyText('market.period'),
                          offer === 'subscription' || strategy
                            ? copyText('market.period.seconds', { seconds: period })
                            : copyText('market.not.applicable'),
                        ],
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
                      row.periodSeconds === (periodSeconds ?? null) &&
                      row.status === 'active';
                    return strategy
                      ? api.call(MARKET_CREATE_STRATEGY_LISTING, { ...terms, periodSeconds: Number(period) }, { accept })
                      : api.call(
                          MARKET_CREATE_LISTING,
                          {
                            ...terms,
                            offerType,
                            ...(periodSeconds === undefined ? {} : { periodSeconds }),
                            ...(offerType === 'one_time' && newCategory ? { category: newCategory } : {}),
                          },
                          { accept },
                        );
                  },
                  done: () => {
                    listings.reload();
                    slots.reload();
                  },
                });
              }}
            >
              <Field label={copyText('market.listing.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              <TextArea label={copyText('market.listing.description')} value={description} onChange={setDescription} maxLength={4000} />
              {!strategy && (
                <Select label={copyText('market.offer.type')} value={offer} onChange={setOffer} options={['one_time', 'subscription']} />
              )}
              {!strategy && offer === 'one_time' && (
                <CategorySelect value={newCategory} onChange={setNewCategory} allLabel={marketListingCopy.t('categoryNone')} />
              )}
              <Field label={copyText('market.price.asset.id')} value={asset} onChange={(e) => setAsset(e.target.value)} maxLength={32} />
              <Field label={copyText('market.price')} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              {(offer === 'subscription' || strategy) && (
                <Field
                  label={copyText('market.paid.period.in.seconds')}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  inputMode="numeric"
                />
              )}
              <Button
                type="submit"
                disabled={
                  action.disabled ||
                  !title.trim() ||
                  !description.trim() ||
                  !asset.trim() ||
                  !validPrice ||
                  ((offer === 'subscription' || strategy) && !validPeriod)
                }
              >
                <Text k="market.review.listing" />
              </Button>
            </form>
          </Panel>
        </div>
      )}
      {(mine || strategy) && (
        <Panel title={copyText('market.refund.requests')}>
          <p className="muted">
            <Text k="market.refund.requests.meaning" />
          </p>
          {policyUnset && policyNote}
          <Read resource={refundRequests.resource} retry={refundRequests.reload}>
            {(rows) =>
              rows.length ? (
                <DataTable
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
                        <Button variant="secondary" disabled={action.disabled} onClick={() => refund(row)}>
                          <Text k="market.refund" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState title={copyText('market.no.refund.requests')} />
              )
            }
          </Read>
        </Panel>
      )}
      <Panel title={copyText('market.your.purchases')}>
        <MarketPurchaseRecords
          resource={purchases.resource}
          reload={purchases.reload}
          limit={limit}
          titleOf={titleOf}
          refundNote={policyUnset ? policyNote : undefined}
          renderRefund={(row) => (
            <Button
              variant="secondary"
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
              variant="secondary"
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
      </Panel>
      {detailId ? null : action.feedback}
      {action.dialog}
    </div>
  );
}
