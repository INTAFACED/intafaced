import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, Field, Panel } from '../../shared/ui';
import { MarketPurchaseRecords } from './MarketPurchaseRecords';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
import type { ApiResult } from '../../shared/api';
const uuid = z.string().uuid(),
  time = z.string().datetime();
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
  status: z.enum(['pending', 'settled', 'rejected']),
  ledgerTxId: uuid.nullable(),
  rejectionCode: z.string().nullable(),
  createdAt: time,
  settledAt: time.nullable(),
  accessUntil: time.nullable(),
});
function originalPurchaseOutcome(row: z.infer<typeof purchaseSchema>): ApiResult<z.infer<typeof purchaseSchema>> {
  if (row.status === 'pending')
    return { ok: false, reason: 'uncertain', message: copyText('market.original.purchase.is.still.pending.settlement.is') };
  if (row.status === 'settled' && row.ledgerTxId && row.settledAt) return { ok: true, data: row };
  // The service marks rejected only for a definitive failed ledger admission;
  // it retains the rejection code and has no settlement evidence for that row.
  if (row.status === 'rejected' && row.rejectionCode && row.ledgerTxId === null && row.settledAt === null) return { ok: true, data: row };
  return { ok: false, reason: 'uncertain', message: copyText('market.the.original.settlement.evidence.is.incomplete.keep') };
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
        return row
          ? originalPurchaseOutcome(row)
          : {
              ok: false as const,
              reason: 'uncertain' as const,
              message: copyText('market.the.original.purchase.is.not.present.in'),
            };
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
    [period, setPeriod] = useState('');
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
  function buy(row: z.infer<typeof listingSchema>) {
    const purchaseId = crypto.randomUUID();
    action.stage({
      title: copyText('market.review.purchase'),
      reference: purchaseId,
      confirm: copyText('market.confirm.purchase'),
      success: copyText('market.purchase.outcome.received.read.its.settlement.status'),
      content: (
        <Details
          items={[
            [copyText('market.listing'), row.title],
            [copyText('market.price'), `${displayAmount(row.price)} ${row.assetId}`],
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
          current.price !== row.price ||
          current.assetId !== row.assetId ||
          current.periodSeconds !== row.periodSeconds ||
          current.offerType !== row.offerType
        )
          return { ok: false, reason: 'error', message: copyText('market.the.listing.terms.changed.reload.the.catalogue') };
        if (!canDispatch())
          return { ok: false, reason: 'aborted', message: copyText('market.the.account.changed.review.this.purchase.again') };
        const result = await api.mutate(
          'market',
          'purchase',
          { listingId: row.id, purchaseId },
          purchaseSchema.refine(
            (p) =>
              p.id === purchaseId && p.listingId === row.id && p.buyerId === userId && p.assetId === row.assetId && p.price === row.price,
            copyText('market.purchase.response.does.not.match.the.reviewed'),
          ),
        );
        if (result.ok) return originalPurchaseOutcome(result.data);
        if (result.reason === 'aborted' || result.status === 401 || result.status === 403) return result;
        return {
          ...result,
          reason: 'uncertain',
          message: result.message + copyText('market.check.the.original.purchase.record.before.another'),
        };
      },
      done: purchases.reload,
    });
  }
  const validPrice = decimalSchema.safeParse(price).success && parseAmount(price) > 0n;
  const validPeriod = /^[1-9]\d*$/.test(period) && Number.isSafeInteger(Number(period));
  return (
    <div className="more-grid">
      <div className="more-toolbar">
        <a className="text-link" href="/market">
          <Text k="market.catalogue" />
        </a>
        <a className="text-link" href="/market/mine">
          <Text k="market.my.listings" />
        </a>
        <a className="text-link" href="/market/strategy">
          <Text k="market.publish.a.strategy.subscription" />
        </a>
      </div>
      <Read resource={programme.resource} retry={programme.reload}>
        {(p) => (
          <p className="muted">
            {p.commissionConfigured && p.commissionBps !== null
              ? copyText('market.published.house.commission.basis.points.charged.to', { value1: p.commissionBps })
              : copyText('market.the.house.commission.is.unpublished.the.service')}
          </p>
        )}
      </Read>
      {(mine || strategy) && (
        <div className="more-columns">
          <div>
            <Panel title={copyText('market.seller.application')}>
              <Read resource={vendor.resource} retry={vendor.reload}>
                {(row) =>
                  row ? (
                    <Details
                      items={[
                        [copyText('market.seller'), row.displayName],
                        [copyText('market.status'), row.status],
                        [copyText('market.description'), row.description],
                      ]}
                    />
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        action.stage({
                          title: copyText('market.review.seller.application'),
                          confirm: copyText('market.submit.application'),
                          success: copyText('market.application.received'),
                          content: (
                            <Details
                              items={[
                                [copyText('market.display.name'), name],
                                [copyText('market.description'), description],
                              ]}
                            />
                          ),
                          run: () =>
                            api.mutate(
                              'market',
                              'applyAsVendor',
                              { displayName: name.trim(), description: description.trim() },
                              vendorSchema,
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
                            <code>{slot.ref}</code>
                            <Button
                              variant="secondary"
                              disabled={action.disabled}
                              onClick={() =>
                                action.stage({
                                  title: copyText('market.release.listing.slot'),
                                  confirm: copyText('market.release.slot'),
                                  success: copyText('market.slot.release.confirmed'),
                                  content: (
                                    <p>
                                      <Text k="market.release" />
                                      {slot.ref}
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
                action.stage({
                  title: copyText('market.review.listing'),
                  confirm: copyText('market.publish.listing'),
                  success: copyText('market.listing.published'),
                  content: (
                    <Details
                      items={[
                        [copyText('market.title'), title],
                        [copyText('market.description'), description],
                        [copyText('market.price'), `${price} ${asset}`],
                        [copyText('market.offer'), strategy ? copyText('market.strategy.subscription') : offer],
                        [
                          copyText('market.period'),
                          offer === 'subscription' || strategy
                            ? copyText('market.period.seconds', { seconds: period })
                            : copyText('market.not.applicable'),
                        ],
                      ]}
                    />
                  ),
                  run: () => api.mutate('market', strategy ? 'createStrategyListing' : 'createListing', input, listingSchema),
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
      <Panel title={mine || strategy ? copyText('market.your.listings') : copyText('market.browse.listings')}>
        <Read
          resource={listings.resource}
          retry={listings.reload}
          empty={mine || strategy ? copyText('market.you.have.no.listings') : copyText('market.no.listings.are.available')}
        >
          {(rows) => (
            <>
              <div className="more-rooms">
                {rows.map((row) => (
                  <article className="more-room-link" key={row.id}>
                    <strong>{row.title}</strong>
                    <p>{row.description}</p>
                    <p>
                      {displayAmount(row.price)} {row.assetId}
                      {row.periodSeconds ? copyText('market.seconds', { value1: row.periodSeconds }) : ''}
                    </p>
                    <small>{row.status}</small>
                    {mine || strategy ? (
                      <Button
                        variant="secondary"
                        disabled={action.disabled || row.status === 'archived'}
                        onClick={() =>
                          action.stage({
                            title: copyText('market.archive.listing'),
                            confirm: copyText('market.archive.listing'),
                            success: copyText('market.listing.archived'),
                            content: (
                              <p>
                                {row.title}
                                <Text k="market.will.leave.the.public.catalogue" />
                              </p>
                            ),
                            run: () => api.mutate('market', 'archiveListing', { listingId: row.id }, listingSchema),
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
                        disabled={action.disabled || row.status !== 'active'}
                        onClick={() => buy(row)}
                        aria-label={copyText('market.buy.2', { value1: row.title })}
                      >
                        {row.offerType === 'subscription' ? copyText('market.buy.one.period') : copyText('market.buy')}
                      </Button>
                    )}
                  </article>
                ))}
              </div>
              <Limit count={rows.length} limit={limit} cap={50} onChange={setLimit} />
            </>
          )}
        </Read>
      </Panel>
      <Panel title={copyText('market.your.purchases')}>
        <MarketPurchaseRecords
          resource={purchases.resource}
          reload={purchases.reload}
          limit={limit}
          renderCancel={(row) => (
            <Button
              variant="secondary"
              disabled={action.disabled}
              onClick={() =>
                action.stage({
                  title: copyText('market.cancel.subscription.access'),
                  confirm: copyText('market.cancel.access'),
                  success: copyText('market.access.cancellation.recorded'),
                  content: (
                    <p>
                      <Text k="market.cancel.access.for.listing" />
                      {row.listingId}
                      <Text k="market.this.does.not.issue.a.refund" />
                    </p>
                  ),
                  run: () =>
                    api.mutate(
                      'market',
                      'cancelSubscription',
                      { listingId: row.listingId },
                      z.object({ listingId: uuid, buyerId: uuid, cancelledAt: time }),
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
      {action.feedback}
      {action.dialog}
    </div>
  );
}
