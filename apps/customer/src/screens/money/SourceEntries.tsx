import { ArrowLeft } from 'lucide-react';
import { navigate } from './deps';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { NO_FILTERS } from './activity-filter';
import type { SourceKind } from './activity-sources';
import { assetFromPath, balanceEntriesHref } from './balance-entries-model';
import { SourceActivity } from './SourceActivity';
import { whereCopy } from './where-it-sits-copy';

const SOURCES: readonly SourceKind[] = ['wallet', 'venue', 'partner'];

/** `?source=wallet|venue|partner` from the link on one Assets row; anything else is every source. */
function sourceFromSearch(search: string): SourceKind | null {
  const value = new URLSearchParams(search).get('source');
  return SOURCES.includes(value as SourceKind) ? (value as SourceKind) : null;
}

function Link({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <a
      className="money-alloc__opt"
      aria-current={current ? 'true' : undefined}
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * `/money/balance/:asset` on the launch model (J-portfolio-01 #6): what makes one figure on Assets is not our ledger's
 * entries (INTAFACED holds none of it) but the records of the place that holds it: the chain's transactions for the
 * wallet, the venue's fills and deposits for the venue account, the partner's lines for the partner account. Newest
 * first, each line with its source and its own reference (SourceActivity, the one list /money/activity shows).
 */
export function SourceEntries({ status, rawAsset, search }: { status: VenueUp; rawAsset: string; search: string }) {
  const { t } = whereCopy.useCopy();
  const { hideBalances } = usePreferences();
  const asset = assetFromPath(rawAsset);
  const source = sourceFromSearch(search);
  const sourceName = (kind: SourceKind) =>
    kind === 'wallet'
      ? t('Wallet title')
      : kind === 'venue'
        ? t('Venue title', { venue: status.venue.displayName })
        : t('Partner title unnamed');
  return (
    <div data-testid="if-money" className="if-money if-money--activity money-detail">
      <Link href="/money" current={false}>
        <ArrowLeft size={16} aria-hidden="true" />
        {t('Records back')}
      </Link>
      <header className="money-detail__head">
        <h1 className="money-title" data-testid="source-records-title" data-asset={asset} data-source={source ?? ''}>
          {source ? t('Records title source', { asset, source: sourceName(source) }) : t('Records title', { asset })}
        </h1>
        <p className="money-detail__note">{t('Records intro')}</p>
      </header>
      <div className="money-alloc__switch" role="group" aria-label={t('Source')}>
        <Link href={balanceEntriesHref(asset)} current={source === null}>
          {t('Records all sources')}
        </Link>
        {SOURCES.map((kind) => (
          <Link key={kind} href={`${balanceEntriesHref(asset)}?source=${kind}`} current={source === kind}>
            {sourceName(kind)}
          </Link>
        ))}
      </div>
      <SourceActivity status={status} filters={NO_FILTERS} asset={asset} hidden={hideBalances} source={source} />
    </div>
  );
}
