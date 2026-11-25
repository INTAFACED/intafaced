import { useMemo, useState } from 'react';
import { MarketTable, PanelHead, Surface, type MarketRow } from '@intafaced/ui/lit';
import { Segmented } from '@intafaced/ui/lit/templates';
import { assetName, homeCopy } from './copy';
import { commandCopy } from './command-copy';
import { priceText, type Tickers } from './MarketsSection';
import { coinHref, fmtPct, fmtUsd, isHiddenPath, type Decimal, type Loadable } from './deps';
import type { Listing } from './select';
import { tradeTabHref } from '../../app/navigation';
import { StateBlock } from './volt-parts';

type View = 'watch' | 'movers';

/**
 * Home's markets panel (Home A): the watchlist, or the biggest movers, as one table of the kit's market rows, each
 * opening its coin, with Trade at the end. Prices are the venue's TEST prices; volumes are what the venue reports.
 */
export function HomeMarkets({
  watch,
  popular,
  movers,
  tickers,
  sparklines,
  loading,
  broken,
  retry,
}: {
  watch: Listing[];
  popular: boolean;
  movers: Listing[];
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
  loading: boolean;
  broken: boolean;
  retry?: () => void;
}) {
  const { t } = commandCopy.useCopy();
  const home = homeCopy.useCopy();
  const [view, setView] = useState<View>('watch');
  const shown = view === 'movers' && movers.length > 0 ? movers : watch;
  const points = useMemo(() => (sparklines.status === 'ready' ? sparklines.data : {}), [sparklines]);
  const rows = useMemo<MarketRow[]>(
    () =>
      shown.map((item) => {
        const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
        const volume = ticker?.quoteVolume24h ?? null;
        return {
          id: item.symbol,
          symbol: item.base,
          name: assetName(item.base, home) ?? undefined,
          price: ticker ? priceText(item, ticker) : null,
          change: ticker?.changePct24h != null ? fmtPct(ticker.changePct24h) : null,
          trend: points[item.symbol] ?? undefined,
          volume: volume === null ? null : fmtUsd(volume, { compact: true }),
          href: coinHref(item.base, 'simple'),
        };
      }),
    [shown, tickers, points, home],
  );
  const desk = isHiddenPath('/trade') ? null : tradeTabHref('pro');
  return (
    <Surface data-testid="hp-markets" className="hm-markets" aria-labelledby="home-markets-title">
      <PanelHead
        title={<span id="home-markets-title">{t('Markets')}</span>}
        aside={
          <>
            {movers.length > 0 ? (
              <Segmented
                label={t('Markets view')}
                options={[
                  { value: 'watch', label: popular ? t('Popular') : t('Watchlist') },
                  { value: 'movers', label: t('Movers') },
                ]}
                value={view}
                onChange={(value) => setView(value as View)}
              />
            ) : null}
            {desk ? (
              <a className="hm-link" href={desk}>
                {t('Open the desk')}
              </a>
            ) : null}
          </>
        }
      />
      {broken ? (
        <StateBlock kind="error" title={t('Markets down')} onRetry={retry ?? (() => location.reload())} retryLabel={t('Try again')} />
      ) : (
        <MarketTable
          labels={{
            caption: t('Markets'),
            market: t('Market'),
            price: t('Price'),
            change: t('24h'),
            trend: t('Last day'),
            volume: t('24h volume'),
            trendLabel: (row) => t('{asset}, last day', { asset: row.symbol }),
          }}
          rows={rows}
          loadingRows={loading ? 6 : undefined}
          empty={<p className="lt-hint">{t('No markets yet')}</p>}
          action={(row) => (
            <a className="lt-button lt-button-secondary hm-trade" href={row.href}>
              {t('Trade')}
            </a>
          )}
          actionLabel={t('Trade')}
        />
      )}
    </Surface>
  );
}
