import { SubNav } from '@intafaced/ui';
import { copy, t as copyText, Text } from './copy';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Dialog, EmptyState, Field, Panel } from '../../shared/ui';
import { MarketPurchaseRecords } from './MarketPurchaseRecords';
import { ListingDetail, MarketFilters, SellerDirectory } from './MarketExplorer';
import { filterListings, NO_FILTER, type ListingFilter } from './market-explorer';
import { Details, Limit, Read, Select, TextArea, useAction, presentActionFailure } from './common';
import type { ApiResult, RefusalReason } from '../../shared/api';
const uuid = z.string().guid(),
  time = z.string().datetime();
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
export const listingSchema = z
  .object({
    id: uuid,
    vendorId: uuid,
    title: z.string(),
    description: z.string(),
    offerType: z.enum(['one_time', 'subscription']),
    assetId: z.string().min(1),
    price: decimalSchema,
    periodSeconds: z.number().int().positive().nullable(),
    status: z.enum(['active', 'archived']),
    createdAt: time,
    updatedAt: time,
  })
  .superRefine((row, ctx) => {
    if (row.offerType === 'subscription' && row.periodSeconds === null)
      ctx.addIssue({ code: 'custom', message: copyText('market.subscription.period.is.missing') });
  });
const purchaseSchema = z.object({
  id: uuid,
  listingId: uuid,
  buyerId: uuid,
  vendorId: uuid,
  vendorUserId: uuid,
  assetId: z.string(),
  price: decimalSchema,
  commissionBps: z.number().int(),
  status: z.enum(['pending', 'settled', 'rejected', 'held', 'released', 'refunded']),
  ledgerTxId: uuid.nullable(),
  rejectionCode: z.string().nullable(),
  refundWindowEndsAt: time.nullable().optional(),
  refundRequestedAt: time.nullable().optional(),
  createdAt: time,
  settledAt: time.nullable(),
  accessUntil: time.nullable(),
});
function originalPurchaseOutcome(row: z.infer<typeof purchaseSchema>): ApiResult<z.infer<typeof purchaseSchema>> {
  if (row.status === 'pending') return marketRefusal('uncertain', 'market.original.purchase.is.still.pending.settlement.is');
  if (row.status === 'settled' && row.ledgerTxId && row.settledAt) return { ok: true, data: row };
  // A held purchase is paid into the buyer's held pot (MC-market-02); its release or refund comes later.
  if ((row.status === 'held' || row.status === 'released' || row.status === 'refunded') && row.ledgerTxId) return { ok: true, data: row };
  // The service marks rejected only for a definitive failed ledger admission;
  // it retains the rejection code and has no settlement evidence for that row.
  if (row.status === 'rejected' && row.rejectionCode && row.ledgerTxId === null && row.settledAt === null) return { ok: true, data: row };
  return marketRefusal('uncertain', 'market.the.original.settlement.evidence.is.incomplete.keep');
}
const vendorSchema = z.object({
  id: uuid,
  userId: uuid,
  displayName: z.string(),
  description: z.string(),
  status: z.enum(['applied', 'approved', 'rejected', 'suspended']),
  createdAt: time,
  updatedAt: time,
});
const slotSchema = z.object({ id: uuid, vendorId: uuid, ref: z.string(), claimedAt: time, releasedAt: time.nullable() });
const slotsSchema = z.object({
  vendorId: uuid,
  status: z.string(),
  tier: z.string(),
  capacity: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  usable: z.number().int().nonnegative(),
  slots: z.array(slotSchema),
});
const programmeSchema = z.object({ commissionBps: z.number().int().nonnegative().nullable(), commissionConfigured: z.boolean() });
export function Market({ mine = false, strategy = false }: { mine?: boolean; strategy?: boolean }) {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('market', {
      recover: async (reference) => {
        const rows = await api.query(
          'market',
          'myPurchases',
          { limit: 50 },
          z
            .array(purchaseSchema)
            .refine((rows) => rows.every((r) => r.buyerId === userId), copyText('market.purchase.list.belongs.to.another.account')),
        );
        if (!rows.ok) return rows;
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
    [detailId, setDetailId] = useState<string | null>(null);
  const listings = useResource(
      async (signal) => {
        if (!mine && !strategy) return api.query('market', 'listings', { limit }, z.array(listingSchema), { signal });
        const owner = await api.query(
          'market',
          'mine',
          undefined,
          vendorSchema
            .nullable()
            .refine((row) => !row || row.userId === userId, copyText('market.seller.ownership.does.not.match.this.account')),
          { signal },
        );
        if (!owner.ok) return owner;
        if (!owner.data) return { ok: true as const, data: [] };
        const vendorId = owner.data.id;
        return api.query(
          'market',
          'myListings',
          { limit },
          z
            .array(listingSchema)
            .refine(
              (rows) => rows.every((row) => row.vendorId === vendorId),
              copyText('market.listing.ownership.does.not.match.this.seller'),
            ),
          { signal },
        );
      },
      `listings:${mine}:${strategy}:${mine || strategy ? userId : 'public'}:${limit}`,
    ),
    programme = useResource(
      (signal) => api.query('market', 'commerceProgramme', undefined, programmeSchema, { signal }),
      'market-programme',
    );
  const purchases = useResource(
    (signal) =>
      api.query(
        'market',
        'myPurchases',
        { limit },
        z
          .array(purchaseSchema)
          .refine((rows) => rows.every((row) => row.buyerId === userId), copyText('market.purchase.ownership.does.not.match.this.account')),
        { signal },
      ),
    `purchases:${userId}:${limit}`,
  );
  // The seller's held purchases whose buyer asked for a refund (MC-market-02).
  const refundRequests = useResource(
    (signal) =>
      mine || strategy
        ? api.query('market', 'refundRequests', { limit: 50 }, z.array(purchaseSchema), { signal })
        : Promise.resolve({ ok: true as const, data: [] }),
    `refund-requests:${userId}:${mine}:${strategy}`,
  );
  const preferences = usePreferences();
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const vendor = useResource(
      (signal) =>
        mine || strategy
          ? api.query(
              'market',
              'mine',
              undefined,
              vendorSchema
                .nullable()
                .refine((row) => !row || row.userId === userId, copyText('market.seller.ownership.does.not.match.this.account')),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: null }),
      `vendor:${userId}:${mine}:${strategy}`,
    ),
    slots = useResource(
      (signal) =>
        mine || strategy
          ? api.query('market', 'slots', undefined, slotsSchema, { signal })
          : Promise.resolve({ ok: true as const, data: null }),
      `slots:${userId}:${mine}:${strategy}`,
    );
  // The stored outcome of the last purchase, so its success line says held when the service held it.
  const bought = useRef<'held' | 'paid'>('paid');
  const ownRows = purchases.resource.status === 'ready' ? purchases.resource.data : [];
  const heldPurchaseOf = (listingId: string) => ownRows.find((p) => p.listingId === listingId && p.status === 'held');
  const titleOf = (listingId: string) =>
    listings.resource.status === 'ready' ? listings.resource.data.find((row) => row.id === listingId)?.title : undefined;
  function buy(row: z.infer<typeof listingSchema>) {
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
        const fresh = await api.query('market', 'listings', { limit: 50 }, z.array(listingSchema));
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
        const result = await api.mutate(
          'market',
          'purchase',
          { listingId: row.id, purchaseId },
          purchaseSchema.refine(
            (p) =>
              p.id === purchaseId &&
              p.listingId === row.id &&
              p.buyerId === userId &&
              p.vendorId === row.vendorId &&
              p.assetId === row.assetId &&
              p.price === row.price,
            copyText('market.purchase.response.does.not.match.the.reviewed'),
          ),
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
  function requestRefund(row: z.infer<typeof purchaseSchema>) {
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
          <p>{copyText('market.refund.request.body', { value1: row.refundWindowEndsAt ? when(row.refundWindowEndsAt) : '—' })}</p>
        </>
      ),
      run: () =>
        api.mutate(
          'market',
          'requestRefund',
          { purchaseId: row.id },
          purchaseSchema.refine(
            (p) => p.id === row.id && p.buyerId === userId && p.status === 'held' && Boolean(p.refundRequestedAt),
            copyText('market.refund.response.does.not.match'),
          ),
        ),
      done: purchases.reload,
    });
  }
  function refund(row: z.infer<typeof purchaseSchema>) {
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
      run: () =>
        api.mutate(
          'market',
          'refund',
          { purchaseId: row.id },
          purchaseSchema.refine(
            (p) => p.id === row.id && p.buyerId === row.buyerId && p.status === 'refunded',
            copyText('market.refund.response.does.not.match'),
          ),
        ),
      done: refundRequests.reload,
    });
  }
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
      <Panel title={mine || strategy ? copyText('market.your.listings') : copyText('market.browse.listings')}>
        <Read
          resource={listings.resource}
          retry={listings.reload}
          empty={mine || strategy ? copyText('market.you.have.no.listings') : copyText('market.no.listings.are.available')}
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
                                  api.mutate(
                                    'market',
                                    'archiveListing',
                                    { listingId: row.id },
                                    listingSchema.refine(
                                      (result) => result.id === row.id && result.vendorId === row.vendorId && result.status === 'archived',
                                    ),
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
                            api.mutate(
                              'market',
                              'applyAsVendor',
                              input,
                              vendorSchema.refine(
                                (row) =>
                                  row.userId === userId && row.displayName === input.displayName && row.description === input.description,
                              ),
                            ),
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
                                  run: () => api.mutate('market', 'releaseSlot', { ref: slot.ref }, z.object({ released: z.boolean() })),
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
                const input = {
                  title: title.trim(),
                  description: description.trim(),
                  assetId: asset.trim(),
                  price,
                  ...(offer === 'subscription' || strategy ? { periodSeconds: Number(period) } : {}),
                  ...(!strategy ? { offerType: offer } : {}),
                };
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
                  run: () =>
                    api.mutate(
                      'market',
                      strategy ? 'createStrategyListing' : 'createListing',
                      input,
                      listingSchema.refine(
                        (row) =>
                          (!reviewedVendorId || row.vendorId === reviewedVendorId) &&
                          row.title === input.title &&
                          row.description === input.description &&
                          row.assetId === input.assetId &&
                          parseAmount(row.price) === parseAmount(input.price) &&
                          row.offerType === (strategy ? 'subscription' : offer) &&
                          row.periodSeconds === (input.periodSeconds ?? null) &&
                          row.status === 'active',
                      ),
                    ),
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
          renderRefund={(row) => (
            <Button variant="secondary" disabled={action.disabled || Boolean(row.refundRequestedAt)} onClick={() => requestRefund(row)}>
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
                    api.mutate(
                      'market',
                      'cancelSubscription',
                      { listingId: row.listingId },
                      z
                        .object({ listingId: uuid, buyerId: uuid, cancelledAt: time })
                        .refine((result) => result.listingId === row.listingId && result.buyerId === userId),
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
