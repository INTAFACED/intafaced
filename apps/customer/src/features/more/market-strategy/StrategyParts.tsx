import { useState, type ReactNode } from 'react';
import { Button, EmptyState, Field, Segmented, Select as KitSelect, TextArea as KitTextArea } from '@intafaced/ui/lit';
import { KeyValue, Sheet, Skeleton } from '@intafaced/ui/lit/templates';
import { MARKET_PROFILE, MARKET_SUBSCRIPTION_ACCESS, type MarketSubscriptionAccess } from '@intafaced/contracts/market-procedures';
import { t as copyText, Text } from '../copy';
import { useApi } from '../../session';
import { useResource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { assetsOf, isFiltered, NO_FILTER, periodUnit, type ListingFilter, type ListingRow } from '../market-explorer';
import { marketExplorerCopy } from '../market-explorer-copy';
import { marketListingCopy } from '../market-listing-copy';
import { uiCopy } from '../../../shared/ui-copy';
import type { ApiResult } from '../../../shared/api';
import { readRefusal, retryable } from './read-refusal';

/** An exact price and its asset, one group named "Price" so the review and the row read it the same way. */
export function MarketPrice({ price, assetId }: { price: string; assetId: string }) {
  return (
    <span>
      <span tabIndex={0} role="group" aria-label={copyText('market.price')}>
        <strong className="lt-mono" lang="zxx">
          {displayAmount(price)}
        </strong>
      </span>{' '}
      <span lang="zxx">{assetId}</span>
    </span>
  );
}

/** Label and value rows, on the kit's KeyValue. */
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return <KeyValue rows={items.map(([label, value]) => ({ label, value }))} />;
}

/** The kit's native select inside a field label. */
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return <KitSelect label={label} value={value} onChange={(e) => onChange(e.target.value)} options={options} />;
}

export function TextArea({
  label,
  value,
  onChange,
  maxLength = 10000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return <KitTextArea label={label} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={5} />;
}

/** How many rows were asked for and shown; the service publishes no cursor, so a larger window is the only way on. */
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  return (
    <div>
      <small>
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button tone="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small>
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}

/** "Try again" for a failed read, offered only where a second attempt can change the answer. */
export function Retry({ failure, retry }: { failure: Extract<ApiResult<unknown>, { ok: false }>; retry: () => void }) {
  const { t } = uiCopy.useCopy();
  return retryable(failure) ? (
    <Button tone="secondary" onClick={retry}>
      {t('retry')}
    </Button>
  ) : null;
}

/** The catalogue's search, listing type, asset and order, over the rows already read. */
export function ListingFilters({
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
    <div>
      <div className="lt-toolbar">
        <Field label={t('search')} value={filter.query} maxLength={64} onChange={(e) => onChange({ ...filter, query: e.target.value })} />
        <Segmented
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
      <div data-testid="more-toolbar" className="lt-toolbar">
        <span role="status">
          {t('showing', { shown, total: rows.length })}
          {filter.vendorId ? ` · ${t('sellerFilter')}` : ''}
        </span>
        {isFiltered(filter) ? (
          <Button tone="quiet" onClick={() => onChange(NO_FILTER)}>
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

/** One listing opened in the kit's sheet: its terms, the seller's profile and, signed in, the subscription access check. */
export function ListingSheet({
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
  /** The room's own controls and feedback for this listing. */
  children?: ReactNode;
}) {
  const api = useApi();
  const { Copy, t } = marketExplorerCopy.useCopy();
  const listingCopy = marketListingCopy.useCopy();
  const preferences = usePreferences();
  const seller = useResource((signal) => api.call(MARKET_PROFILE, { vendorId: row.vendorId }, { signal }), `market-seller:${row.vendorId}`);
  const [access, setAccess] = useState<ApiResult<MarketSubscriptionAccess> | null>(null);
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const period = row.periodSeconds ? periodUnit(row.periodSeconds) : null;
  const sellerFailure = seller.resource.status === 'failed' ? seller.resource.failure : null;
  return (
    <Sheet open title={row.title} onClose={onClose}>
      <section aria-label={t('detailTitle')}>
        <h2>{t('detailTitle')}</h2>
        <h3 lang="und">{row.title}</h3>
        <p data-testid="more-body" lang="und">
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
          <p>
            <Copy k="recurringNote" />
          </p>
        ) : null}
        <h3>
          <Copy k="seller" />
        </h3>
        {sellerFailure && sellerFailure.reason === 'not_mounted' ? (
          <p role="status">
            <Copy k="sellerNotListed" />
          </p>
        ) : sellerFailure ? (
          <SheetFailure failure={sellerFailure} retry={seller.reload} />
        ) : seller.resource.status === 'ready' ? (
          <>
            <strong lang="und">{seller.resource.data.displayName}</strong>
            <p lang="und">{seller.resource.data.description}</p>
            <small>
              {t('sellerSince')}: {when(seller.resource.data.createdAt)}
            </small>
          </>
        ) : (
          <Skeleton shape="text" count={2} />
        )}
        <div className="lt-actions">
          <a className="lt-link" href={`/market/${encodeURIComponent(row.id)}`}>
            {listingCopy.t('openPage')}
          </a>
          <Button tone="secondary" onClick={() => onSeller(row.vendorId)}>
            <Copy k="moreFromSeller" />
          </Button>
          <Button tone="quiet" onClick={onClose}>
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
                <Button tone="secondary" onClick={async () => setAccess(await api.call(MARKET_SUBSCRIPTION_ACCESS, { listingId: row.id }))}>
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
              <p>
                <Copy k="accessOneTime" />
              </p>
            )}
          </>
        ) : null}
      </section>
    </Sheet>
  );
}

/** A failed read inside the sheet, which covers the room's own refusal: its words on the kit's empty part, and "Try again". */
function SheetFailure({ failure, retry }: { failure: Extract<ApiResult<unknown>, { ok: false }>; retry: () => void }) {
  const { language } = usePreferences();
  const refusal = readRefusal(failure, language, location.pathname + location.search);
  return <EmptyState title={refusal.title} body={refusal.body} action={<Retry failure={failure} retry={retry} />} />;
}
