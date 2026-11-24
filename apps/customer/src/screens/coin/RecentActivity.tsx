import { useMemo } from 'react';
import { coinCopy } from './copy';
import { byNewest, FILLS_PAGE, FillsTable, KitState, LoadState, precisionOf, useDeskMarkets, useFills } from './deps';

const SHOWN = 5;

/** A fill's symbol is "BTC/USDT" (the service's own); the markets list may spell it "BTC-USDT". */
const partsOf = (symbol: string): string[] => symbol.replace('-', '/').split('/');

/**
 * "Recent {BASE} activity" (UI-SPEC 5.5): the last five rows of Activity's Trades tab for this coin, drawn with the
 * same table. "View all" opens Activity.
 */
export function RecentActivity({ asset }: { asset: string }) {
  const { t } = coinCopy.useCopy();
  const fills = useFills(false);
  const markets = useDeskMarkets();
  const precision = useMemo(() => precisionOf(markets.status === 'ready' ? markets.data : []), [markets]);
  return (
    <section className="lt-stack" aria-labelledby="coin-recent-title" data-testid="recent">
      <div className="lt-title-row">
        <h2 id="coin-recent-title" data-testid="coin-h2">
          {t('Recent {asset} activity', { asset })}
        </h2>
        <a data-testid="coin-recent__all" className="lt-link" href={`/money/activity?tab=trades&asset=${encodeURIComponent(asset)}`}>
          {t('View all')}
        </a>
      </div>
      <div>
        <LoadState load={fills} thing="trades">
          {(rows) => {
            const mine = byNewest(rows.filter((fill) => partsOf(fill.symbol).includes(asset))).slice(0, SHOWN);
            if (mine.length > 0) return <FillsTable rows={mine} precision={precision} layout="activity" />;
            // Only the latest page of fills is read. A full page with none in this coin does not mean there are none, so it points to the full list.
            if (rows.length >= FILLS_PAGE)
              return (
                <KitState
                  kind="empty"
                  testId="coin-recent__empty"
                  title={t('No latest activity', { asset, count: FILLS_PAGE })}
                  body={t('No latest activity body', { asset })}
                  action={{ label: t('View all'), href: `/money/activity?tab=all&asset=${encodeURIComponent(asset)}` }}
                />
              );
            return (
              <KitState
                kind="empty"
                testId="coin-recent__empty"
                title={t('No activity yet', { asset })}
                body={t('No activity body', { asset })}
              />
            );
          }}
        </LoadState>
      </div>
    </section>
  );
}
