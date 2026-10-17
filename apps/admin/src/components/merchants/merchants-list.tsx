import type { FounderGlobalMetrics } from '@intafaced/contracts';
import { KYB_STATUSES, MERCHANT_STATUSES, kybStatusChip, merchantStatusChip } from '@/lib/merchants/chips';
import {
  firstPageHref,
  hasActiveFilter,
  nextPageHref,
  PAGE_SIZES,
  previousPageHref,
  type MerchantListQuery,
} from '@/lib/merchants/list-params';
import type { MerchantListPageData } from '@/lib/merchants/loaders';
import { describeFreshness } from '@/lib/merchants/time';
import { AsOf, FailureState, KpiTile, PageHead } from './ui';
import { MerchantTable } from './merchant-table';

function count(funnel: FounderGlobalMetrics['onboardingFunnel'], step: string): number {
  return funnel.find((s) => s.step === step)?.count ?? 0;
}

function describeFilter(query: MerchantListQuery): string {
  const parts = [
    query.status ? `status = ${query.status}` : null,
    query.kyb ? `KYB = ${query.kyb}` : null,
    query.tier ? `tier = ${query.tier}` : null,
  ].filter(Boolean);
  return parts.length ? `Filters: ${parts.join(', ')}.` : 'No filters.';
}

export function MerchantsListView({ data, query }: { data: MerchantListPageData; query: MerchantListQuery }) {
  const retry = '/merchants/all';
  const funnel = data.counts.kind === 'ok' ? data.counts.data.onboardingFunnel : null;
  return (
    <div className="mp-page">
      <PageHead
        title="All merchants"
        purpose="Every merchant on the platform with status, business verification and lifetime volume. Open one to see its payments, settlements and controls."
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
      />

      {funnel ? (
        <div className="mp-kpis" role="group" aria-label="Merchant counts">
          <KpiTile
            label="Merchants"
            value={<span className="mp-num">{MERCHANT_STATUSES.reduce((n, s) => n + count(funnel, `status.${s}`), 0)}</span>}
            period="Right now, all statuses"
            href="/merchants/all"
          />
          <KpiTile
            label="Active"
            value={<span className="mp-num">{count(funnel, 'status.active')}</span>}
            period="Right now"
            href="/merchants/all?status=active"
          />
          <KpiTile
            label="KYB pending"
            value={<span className="mp-num">{count(funnel, 'kyb.pending')}</span>}
            period="Right now"
            href="/merchants/all?kyb=pending"
          />
          <KpiTile
            label="Suspended"
            value={<span className="mp-num">{count(funnel, 'status.suspended')}</span>}
            period="Right now"
            href="/merchants/all?status=suspended"
          />
        </div>
      ) : null}

      <form className="mp-filters" method="get" action="/merchants/all" aria-label="Filter merchants">
        <div className="mp-field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" name="status" className="mp-input" defaultValue={query.status ?? ''}>
            <option value="">Any status</option>
            {MERCHANT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {merchantStatusChip(s).label}
              </option>
            ))}
          </select>
        </div>
        <div className="mp-field">
          <label htmlFor="f-kyb">Business verification</label>
          <select id="f-kyb" name="kyb" className="mp-input" defaultValue={query.kyb ?? ''}>
            <option value="">Any KYB state</option>
            {KYB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {kybStatusChip(s).label}
              </option>
            ))}
          </select>
        </div>
        <div className="mp-field">
          <label htmlFor="f-tier">Tier</label>
          <select id="f-tier" name="tier" className="mp-input" defaultValue="" disabled aria-describedby="f-tier-hint">
            <option value="">Not available yet</option>
          </select>
        </div>
        <div className="mp-field">
          <label htmlFor="f-limit">Per page</label>
          <select id="f-limit" name="limit" className="mp-input" defaultValue={String(query.limit)}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <p id="f-tier-hint" className="mp-hint mp-filters__note">
          The tier filter is not connected: the service refuses it because no tiers exist. Search and sort work on the rows of the current
          page only.
        </p>
        <div className="mp-filters__actions">
          <button type="submit" className="mp-btn mp-btn--primary">
            Apply filters
          </button>
          {hasActiveFilter(query) ? (
            <a className="mp-btn" href="/merchants/all">
              Clear
            </a>
          ) : null}
        </div>
      </form>

      {data.list.kind !== 'ok' ? (
        <FailureState failure={data.list} what="The merchant list" retryHref={retry} />
      ) : (
        <>
          <AsOf freshness={data.list.data.freshness} label="List" />
          <MerchantTable
            rows={data.list.data.rows}
            asOf={describeFreshness(data.list.data.freshness).state === 'unknown' ? null : data.list.data.freshness.asOf}
            filterNote={describeFilter(query)}
            emptyHint={
              hasActiveFilter(query)
                ? 'No merchant fits these filters. Clear them to see everyone.'
                : 'No merchant has been created yet. Merchants show here as soon as one exists.'
            }
          />
          <nav className="mp-pager" aria-label="Pages">
            {previousPageHref(query) ? (
              <a className="mp-btn" href={previousPageHref(query)!} rel="prev">
                ← Previous page
              </a>
            ) : (
              <span className="mp-btn" aria-disabled="true" data-disabled="true">
                ← Previous page
              </span>
            )}
            {query.cursor ? (
              <a className="mp-btn" href={firstPageHref(query)}>
                First page
              </a>
            ) : null}
            {data.list.data.nextCursor ? (
              <a className="mp-btn" href={nextPageHref(query, data.list.data.nextCursor)} rel="next">
                Next page →
              </a>
            ) : (
              <span className="mp-btn" aria-disabled="true" data-disabled="true">
                {data.list.data.rows.length > 0 ? 'End of list' : 'Next page →'}
              </span>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
