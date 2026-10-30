import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Read, Select } from './common';
import { assetsOf, isFiltered, NO_FILTER, periodUnit, type ListingFilter, type ListingRow } from './market-explorer';
import { marketExplorerCopy } from './market-explorer-copy';
import type { ApiResult } from '../../shared/api';

const sellerSchema = z.object({ id: z.string().guid(), displayName: z.string(), description: z.string(), createdAt: z.string() });
const accessSchema = z.object({
  granted: z.literal(true),
  listingId: z.string().guid(),
  buyerId: z.string().guid(),
  accessUntil: z.string(),
});

export function MarketFilters({
  rows,
  filter,
  onChange,
  shown,
}: {
  rows: readonly ListingRow[];
  filter: ListingFilter;
  onChange: (filter: ListingFilter) => void;
  shown: number;
}) {
  const { Copy, t } = marketExplorerCopy.useCopy();
  return (
    <div className="more-grid">
      <div className="depth-filters">
        <Field label={t('search')} value={filter.query} maxLength={64} onChange={(e) => onChange({ ...filter, query: e.target.value })} />
        <Select
          label={t('offer')}
          value={filter.offer}
          onChange={(value) => onChange({ ...filter, offer: value as ListingFilter['offer'] })}
          options={[
            { value: 'all', label: t('offerAll') },
            { value: 'one_time', label: t('offerOneTime') },
            { value: 'subscription', label: t('offerSubscription') },
          ]}
        />
        <Select
          label={t('asset')}
          value={filter.asset}
          onChange={(value) => onChange({ ...filter, asset: value })}
          options={[{ value: '', label: t('assetAll') }, ...assetsOf(rows).map((asset) => ({ value: asset, label: asset }))]}
        />
        <Select
          label={t('sort')}
          value={filter.sort}
          onChange={(value) => onChange({ ...filter, sort: value as ListingFilter['sort'] })}
          options={[
            { value: 'newest', label: t('sortNewest') },
            { value: 'price_asc', label: t('sortPriceAsc') },
            { value: 'price_desc', label: t('sortPriceDesc') },
            { value: 'title', label: t('sortTitle') },
          ]}
        />
      </div>
      <div data-testid="more-toolbar" className="more-toolbar">
        <span className="muted" role="status">
          {t('showing', { shown, total: rows.length })}
          {filter.vendorId ? ` · ${t('sellerFilter')}` : ''}
        </span>
        {isFiltered(filter) ? (
          <Button variant="ghost" onClick={() => onChange(NO_FILTER)}>
            <Copy k="clear" />
          </Button>
        ) : null}
      </div>
      {shown === 0 && rows.length > 0 ? (
        <p role="status">
          <Copy k="noMatch" />
        </p>
      ) : null}
    </div>
  );
}

export function ListingDetail({
  row,
  signedIn,
  onClose,
  onSeller,
  children,
}: {
  row: ListingRow;
  signedIn: boolean;
  onClose: () => void;
  onSeller: (vendorId: string) => void;
  /** The listing's purchase controls, drawn by the Market room. */
  children?: ReactNode;
}) {
  const api = useApi();
  const { Copy, t } = marketExplorerCopy.useCopy();
  const preferences = usePreferences();
  const seller = useResource(
    (signal) => api.query('market', 'profile', { vendorId: row.vendorId }, sellerSchema, { signal }),
    `market-seller:${row.vendorId}`,
  );
  const [access, setAccess] = useState<ApiResult<z.infer<typeof accessSchema>> | null>(null);
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const period = row.periodSeconds ? periodUnit(row.periodSeconds) : null;
  return (
    <Panel title={t('detailTitle')}>
      <h3 lang="und">{row.title}</h3>
      <p data-testid="more-body" className="more-body" lang="und">
        {row.description}
      </p>
      <Details
        items={[
          [t('price'), `${displayAmount(row.price)} ${row.assetId}`],
          [t('period'), period ? t(`every_${period.unit}`, { value: period.value }) : t('periodNone')],
          [t('status'), row.status],
          [t('listed'), when(row.createdAt)],
        ]}
      />
      {children}
      {row.offerType === 'subscription' ? (
        <p className="muted">
          <Copy k="recurringNote" />
        </p>
      ) : null}
      <h3>
        <Copy k="seller" />
      </h3>
      {seller.resource.status === 'failed' && seller.resource.failure.reason === 'not_mounted' ? (
        <p className="muted" role="status">
          <Copy k="sellerNotListed" />
        </p>
      ) : (
        <Read resource={seller.resource} retry={seller.reload}>
          {(s) => (
            <>
              <strong lang="und">{s.displayName}</strong>
              <p lang="und">{s.description}</p>
              <small>
                {t('sellerSince')}: {when(s.createdAt)}
              </small>
            </>
          )}
        </Read>
      )}
      <div className="depth-card-actions">
        <Button variant="secondary" onClick={() => onSeller(row.vendorId)}>
          <Copy k="moreFromSeller" />
        </Button>
        <Button variant="ghost" onClick={onClose}>
          <Copy k="closeDetails" />
        </Button>
      </div>
      {signedIn ? (
        <>
          <h3>
            <Copy k="accessTitle" />
          </h3>
          {row.offerType === 'subscription' ? (
            <>
              <Button
                variant="secondary"
                onClick={async () => setAccess(await api.query('market', 'subscriptionAccess', { listingId: row.id }, accessSchema))}
              >
                <Copy k="accessCheck" />
              </Button>
              {access?.ok ? (
                <p role="status">{t('accessGranted', { until: when(access.data.accessUntil) })}</p>
              ) : access && access.reason === 'not_mounted' ? (
                <p role="status">
                  <Copy k="accessNone" />
                </p>
              ) : access ? (
                <p role="alert">{access.message}</p>
              ) : null}
            </>
          ) : (
            <p className="muted">
              <Copy k="accessOneTime" />
            </p>
          )}
        </>
      ) : null}
    </Panel>
  );
}

const directorySchema = z.array(sellerSchema);
export function SellerDirectory({ onSeller }: { onSeller: (vendorId: string) => void }) {
  const api = useApi();
  const { Copy, t } = marketExplorerCopy.useCopy();
  const sellers = useResource((signal) => api.query('market', 'listed', { limit: 20 }, directorySchema, { signal }), 'market-sellers');
  return (
    <Panel title={t('directoryTitle')}>
      <p className="muted">
        <Copy k="directoryNote" />
      </p>
      <Read resource={sellers.resource} retry={sellers.reload} empty={t('directoryEmpty')}>
        {(rows) => (
          <div className="depth-cards">
            {rows.map((s) => (
              <article key={s.id} className="depth-card">
                <h3 lang="und">{s.displayName}</h3>
                <p lang="und">{s.description}</p>
                <div className="depth-card-actions">
                  <Button variant="secondary" onClick={() => onSeller(s.id)}>
                    <Copy k="seeListings" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Read>
    </Panel>
  );
}
