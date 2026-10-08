import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
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
      ctx.addIssue({ code: 'custom', message: 'Subscription period is missing' });
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
  if (row.status === 'pending') return { ok: false, reason: 'uncertain', message: 'Original purchase is still pending. Settlement is not confirmed.' };
  if (row.status === 'settled' && row.ledgerTxId && row.settledAt) return { ok: true, data: row };
  // The service marks rejected only for a definitive failed ledger admission;
  // it retains the rejection code and has no settlement evidence for that row.
  if (row.status === 'rejected' && row.rejectionCode && row.ledgerTxId === null && row.settledAt === null) return { ok: true, data: row };
  return { ok: false, reason: 'uncertain', message: 'The original settlement evidence is incomplete. Keep its purchase reference.' };
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
          z.array(purchaseSchema).refine((rows) => rows.every((r) => r.buyerId === userId), 'Purchase list belongs to another account'),
        );
        if (!rows.ok) return rows;
        const row = rows.data.find((r) => r.id === reference);
        return row
          ? originalPurchaseOutcome(row)
          : {
              ok: false as const,
              reason: 'uncertain' as const,
              message:
                'The original purchase is not present in this bounded history. Absence does not prove it was refused. No retry was sent.',
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
          vendorSchema.nullable().refine((row) => !row || row.userId === userId, 'Seller ownership does not match this account'),
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
            .refine((rows) => rows.every((row) => row.vendorId === vendorId), 'Listing ownership does not match this seller'),
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
          .refine((rows) => rows.every((row) => row.buyerId === userId), 'Purchase ownership does not match this account'),
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
              vendorSchema.nullable().refine((row) => !row || row.userId === userId, 'Seller ownership does not match this account'),
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
      title: 'Review purchase',
      reference: purchaseId,
      confirm: 'Confirm purchase',
      success: 'Purchase outcome received. Read its settlement status below.',
      content: (
        <Details
          items={[
            ['Listing', row.title],
            ['Price', `${displayAmount(row.price)} ${row.assetId}`],
            ['Access', row.periodSeconds ? `${row.periodSeconds} seconds · one paid period` : 'One-time purchase'],
            ['Renewal', 'Automatic recurring charges are not built.'],
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
          return { ok: false, reason: 'error', message: 'The listing terms changed. Reload the catalogue and review again.' };
        if (!canDispatch()) return { ok: false, reason: 'aborted', message: 'The account changed. Review this purchase again.' };
        const result = await api.mutate(
          'market',
          'purchase',
          { listingId: row.id, purchaseId },
          purchaseSchema.refine(
            (p) =>
              p.id === purchaseId && p.listingId === row.id && p.buyerId === userId && p.assetId === row.assetId && p.price === row.price,
            'Purchase response does not match the reviewed request',
          ),
        );
        if (result.ok) return originalPurchaseOutcome(result.data);
        if (result.reason === 'aborted' || result.status === 401 || result.status === 403) return result;
        return { ...result, reason: 'uncertain', message: result.message + ' Check the original purchase record before another purchase.' };
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
          Catalogue
        </a>
        <a className="text-link" href="/market/mine">
          My listings
        </a>
        <a className="text-link" href="/market/strategy">
          Publish a strategy subscription
        </a>
      </div>
      <Read resource={programme.resource} retry={programme.reload}>
        {(p) => (
          <p className="muted">
            {p.commissionConfigured && p.commissionBps !== null
              ? `Published house commission: ${p.commissionBps} basis points, charged to the seller.`
              : 'The house commission is unpublished. The service refuses listing creation and purchases until it is configured.'}
          </p>
        )}
      </Read>
      {(mine || strategy) && (
        <div className="more-columns">
          <div>
            <Panel title="Seller application">
              <Read resource={vendor.resource} retry={vendor.reload}>
                {(row) =>
                  row ? (
                    <Details
                      items={[
                        ['Seller', row.displayName],
                        ['Status', row.status],
                        ['Description', row.description],
                      ]}
                    />
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        action.stage({
                          title: 'Review seller application',
                          confirm: 'Submit application',
                          success: 'Application received',
                          content: (
                            <Details
                              items={[
                                ['Display name', name],
                                ['Description', description],
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
                      <Field label="Seller display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
                      <TextArea label="Seller description" value={description} onChange={setDescription} maxLength={2000} />
                      <Button type="submit" disabled={action.disabled || !name.trim() || !description.trim()}>
                        Review application
                      </Button>
                    </form>
                  )
                }
              </Read>
            </Panel>
            <Panel title="Listing capacity">
              <Read resource={slots.resource} retry={slots.reload}>
                {(s) =>
                  s ? (
                    <>
                      <Details
                        items={[
                          ['Stake tier', s.tier],
                          ['Capacity', s.capacity],
                          ['Held slots', s.held],
                          ['Usable listings', s.usable],
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
                                  title: 'Release listing slot',
                                  confirm: 'Release slot',
                                  success: 'Slot release confirmed',
                                  content: <p>Release {slot.ref}. A listing without a slot will no longer be available publicly.</p>,
                                  run: () => api.mutate('market', 'releaseSlot', { ref: slot.ref }, z.object({ released: z.boolean() })),
                                  done: slots.reload,
                                })
                              }
                            >
                              Release
                            </Button>
                          </div>
                        ))}
                    </>
                  ) : null
                }
              </Read>
            </Panel>
          </div>
          <Panel title={strategy ? 'Publish a strategy subscription' : 'Create a listing'}>
            <p className="muted">
              Approval and stake capacity are enforced by the service. Strategy subscriptions sell access for one paid period; return
              ranking and profit share are unavailable.
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
                  title: 'Review listing',
                  confirm: 'Publish listing',
                  success: 'Listing published',
                  content: (
                    <Details
                      items={[
                        ['Title', title],
                        ['Description', description],
                        ['Price', `${price} ${asset}`],
                        ['Offer', strategy ? 'Strategy subscription' : offer],
                        ['Period', offer === 'subscription' || strategy ? `${period} seconds` : 'Not applicable'],
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
              <Field label="Listing title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              <TextArea label="Listing description" value={description} onChange={setDescription} maxLength={4000} />
              {!strategy && <Select label="Offer type" value={offer} onChange={setOffer} options={['one_time', 'subscription']} />}
              <Field label="Price asset ID" value={asset} onChange={(e) => setAsset(e.target.value)} maxLength={32} />
              <Field label="Price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
              {(offer === 'subscription' || strategy) && (
                <Field label="Paid period in seconds" value={period} onChange={(e) => setPeriod(e.target.value)} inputMode="numeric" />
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
                Review listing
              </Button>
            </form>
          </Panel>
        </div>
      )}
      <Panel title={mine || strategy ? 'Your listings' : 'Browse listings'}>
        <Read
          resource={listings.resource}
          retry={listings.reload}
          empty={mine || strategy ? 'You have no listings' : 'No listings are available'}
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
                      {row.periodSeconds ? ` / ${row.periodSeconds} seconds` : ''}
                    </p>
                    <small>{row.status}</small>
                    {mine || strategy ? (
                      <Button
                        variant="secondary"
                        disabled={action.disabled || row.status === 'archived'}
                        onClick={() =>
                          action.stage({
                            title: 'Archive listing',
                            confirm: 'Archive listing',
                            success: 'Listing archived',
                            content: <p>{row.title} will leave the public catalogue.</p>,
                            run: () => api.mutate('market', 'archiveListing', { listingId: row.id }, listingSchema),
                            done: () => {
                              listings.reload();
                              slots.reload();
                            },
                          })
                        }
                      >
                        Archive
                      </Button>
                    ) : (
                      <Button
                        disabled={action.disabled || row.status !== 'active'}
                        onClick={() => buy(row)}
                        aria-label={`Buy ${row.title}`}
                      >
                        {row.offerType === 'subscription' ? 'Buy one period' : 'Buy'}
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
      <Panel title="Your purchases">
        <Read resource={purchases.resource} retry={purchases.reload} empty="You have no purchases">
          {(rows) => (
            <>
              <DataTable headers={['Purchase', 'Amount', 'Settlement', 'Access']} label="Purchase history">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <code>{r.id}</code>
                    </td>
                    <td>
                      {displayAmount(r.price)} {r.assetId}
                    </td>
                    <td>
                      {r.status}
                      {r.rejectionCode && <p>{r.rejectionCode}</p>}
                      {r.ledgerTxId && <small>Ledger {r.ledgerTxId}</small>}
                    </td>
                    <td>
                      {r.accessUntil ?? 'No expiring access'}
                      {r.accessUntil && (
                        <Button
                          variant="secondary"
                          disabled={action.disabled}
                          onClick={() =>
                            action.stage({
                              title: 'Cancel subscription access',
                              confirm: 'Cancel access',
                              success: 'Access cancellation recorded',
                              content: <p>Cancel access for listing {r.listingId}. This does not issue a refund.</p>,
                              run: () =>
                                api.mutate(
                                  'market',
                                  'cancelSubscription',
                                  { listingId: r.listingId },
                                  z.object({ listingId: uuid, buyerId: uuid, cancelledAt: time }),
                                ),
                              done: purchases.reload,
                            })
                          }
                        >
                          Cancel access
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <Limit count={rows.length} limit={limit} cap={50} onChange={setLimit} />
            </>
          )}
        </Read>
      </Panel>
      {action.feedback}
      {action.dialog}
    </div>
  );
}
