import { useId, useState, type ReactNode } from 'react';
import {
  MARKET_LISTED,
  MARKET_LISTING_CATEGORIES_READ,
  MARKET_PROFILE,
  MARKET_SUBSCRIPTION_ACCESS,
  type MarketSubscriptionAccess,
} from '@intafaced/contracts/market-procedures';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, Field, Radio, Select } from '@intafaced/ui/lit';
import { Details } from './catalogue-parts';
import { KitRead, Section } from './volt-parts';
import { assetsOf, isFiltered, NO_FILTER, periodUnit, type ListingFilter, type ListingRow } from './market-explorer';
import { marketExplorerCopy } from './market-explorer-copy';
import { marketListingCopy } from './market-listing-copy';
import type { ApiResult } from '../../shared/api';

/**
 * The Market's four doors to what the copy room runs (MC-market-01): spot and futures copy trading, the bot marketplace
 * and the signal marketplace. Each opens its own section of `/trade/copy`, which owns the machinery; nothing is ranked.
 */
export const MARKET_DOORS = [
  { key: 'doorSpot', note: 'doorSpotNote', href: '/trade/copy?tab=spot' },
  { key: 'doorFutures', note: 'doorFuturesNote', href: '/trade/copy?tab=futures' },
  { key: 'doorBots', note: 'doorBotsNote', href: '/trade/copy?tab=bots' },
  { key: 'doorSignals', note: 'doorSignalsNote', href: '/trade/copy?tab=signal' },
] as const;

export function MarketDoors() {
  const { t } = marketListingCopy.useCopy();
  return (
    <nav aria-label={t('doorsTitle')}>
      <p className="lt-hint">{t('doorsNote')}</p>
      <ul className="lt-stack">
        {MARKET_DOORS.map((door) => (
          <li key={door.key} className="lt-stack">
            <a className="lt-link" href={door.href}>
              {t(door.key)}
            </a>
            <small className="lt-hint">{t(door.note)}</small>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A category's words: the known slugs are written in every language; an unknown one shows as the service names it. */
export function useCategoryLabel() {
  const { t } = marketListingCopy.useCopy();
  return (slug: string) => {
    const key = `cat_${slug}`;
    return key in CATEGORY_KEYS ? t(key as (typeof CATEGORY_KEYS)[keyof typeof CATEGORY_KEYS]) : slug;
  };
}
const CATEGORY_KEYS = {
  cat_bots: 'cat_bots',
  cat_defi: 'cat_defi',
  cat_compliance: 'cat_compliance',
  cat_payment_extensions: 'cat_payment_extensions',
  cat_security_custody: 'cat_security_custody',
  cat_data: 'cat_data',
  cat_advisory: 'cat_advisory',
  cat_partner_integrations: 'cat_partner_integrations',
} as const;

/**
 * The vendor marketplace's category taxonomy (RC-more-catalogue-18), read from svc-market (`listingCategories`), never
 * written here. `allLabel` is the choice of no category: every listing in the catalogue, or none filed on a new listing.
 */
export function CategorySelect({ value, onChange, allLabel }: { value: string; onChange: (slug: string) => void; allLabel: string }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  const label = useCategoryLabel();
  const categories = useResource((signal) => api.call(MARKET_LISTING_CATEGORIES_READ, undefined, { signal }), 'market-categories');
  return (
    <KitRead resource={categories.resource} retry={categories.reload}>
      {({ categories: slugs }) => (
        <Select
          label={t('category')}
          value={value}
          onChange={onChange}
          options={[{ value: '', label: allLabel }, ...slugs.map((slug) => ({ value: slug, label: label(slug) }))]}
        />
      )}
    </KitRead>
  );
}

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
  const typeName = useId();
  return (
    <div className="lt-stack">
      <div className="lt-toolbar">
        <Field label={t('search')} value={filter.query} maxLength={64} onChange={(e) => onChange({ ...filter, query: e.target.value })} />
        <fieldset className="lt-actions" role="radiogroup">
          <legend>{t('offer')}</legend>
          {(
            [
              ['all', t('offerAll')],
              ['one_time', t('offerOneTime')],
              ['subscription', t('offerSubscription')],
            ] as const
          ).map(([value, label]) => (
            <Radio
              key={value}
              name={typeName}
              value={value}
              checked={filter.offer === value}
              onSelect={() => onChange({ ...filter, offer: value })}
            >
              {label}
            </Radio>
          ))}
        </fieldset>
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
        <span className="lt-muted" role="status">
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
  const listingCopy = marketListingCopy.useCopy();
  const preferences = usePreferences();
  const seller = useResource((signal) => api.call(MARKET_PROFILE, { vendorId: row.vendorId }, { signal }), `market-seller:${row.vendorId}`);
  const [access, setAccess] = useState<ApiResult<MarketSubscriptionAccess> | null>(null);
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  const period = row.periodSeconds ? periodUnit(row.periodSeconds) : null;
  return (
    <Section title={t('detailTitle')} className="lt-stack">
      <h3 lang="und">{row.title}</h3>
      <p data-testid="more-body" className="lt-pre-wrap lt-wrap" lang="und">
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
        <p className="lt-hint">
          <Copy k="recurringNote" />
        </p>
      ) : null}
      <h3>
        <Copy k="seller" />
      </h3>
      {seller.resource.status === 'failed' && seller.resource.failure.reason === 'not_mounted' ? (
        <p className="lt-hint" role="status">
          <Copy k="sellerNotListed" />
        </p>
      ) : (
        <KitRead resource={seller.resource} retry={seller.reload}>
          {(s) => (
            <>
              <strong lang="und">{s.displayName}</strong>
              <p lang="und">{s.description}</p>
              <small>
                {t('sellerSince')}: {when(s.createdAt)}
              </small>
            </>
          )}
        </KitRead>
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
            <p className="lt-hint">
              <Copy k="accessOneTime" />
            </p>
          )}
        </>
      ) : null}
    </Section>
  );
}

export function SellerDirectory({ onSeller }: { onSeller: (vendorId: string) => void }) {
  const api = useApi();
  const { Copy, t } = marketExplorerCopy.useCopy();
  const sellers = useResource((signal) => api.call(MARKET_LISTED, { limit: 20 }, { signal }), 'market-sellers');
  return (
    <Section title={t('directoryTitle')} className="lt-stack">
      <p className="lt-hint">
        <Copy k="directoryNote" />
      </p>
      <KitRead resource={sellers.resource} retry={sellers.reload} empty={t('directoryEmpty')}>
        {(rows) => (
          <div className="lt-grid">
            {rows.map((s) => (
              <article key={s.id} className="lt-stack">
                <h3 lang="und">{s.displayName}</h3>
                <p lang="und">{s.description}</p>
                <div className="lt-actions">
                  <Button tone="secondary" onClick={() => onSeller(s.id)}>
                    <Copy k="seeListings" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </KitRead>
    </Section>
  );
}
