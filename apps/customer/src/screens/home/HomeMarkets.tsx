import { useMemo, useState } from 'react';
import { ButtonLink, MarketTable, PanelHead, type MarketRow } from '@intafaced/ui/lit';
import { TabPanel, Tabs } from '@intafaced/ui/lit/templates';
import { assetName, homeCopy } from './copy';
import { commandCopy } from './command-copy';
import { priceText, type Tickers } from './MarketsSection';
import { coinHref, fmtPct, isHiddenPath, type Decimal, type Loadable } from './deps';
import type { Listing } from './select';
import { StateBlock } from './volt-parts';

type View = 'watch' | 'movers';

/**
 * Home's markets panel: the watchlist or the biggest movers, as one table of the kit's market rows, each opening its
 * coin, with Trade at the end, and the door to every market. Prices are the venue's TEST prices.
 */
export function HomeMarkets({
  watch,
  popular,
  movers,
  count,
  tickers,
  sparklines,
  loading,
  broken,
  retry,
}: {
  watch: Listing[];
  popular: boolean;
  movers: Listing[];
  /** How many markets there are to trade. */
  count: number;
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
  loading: boolean;
  broken: boolean;
  retry?: () => void;
}) {
  const { t } = commandCopy.useCopy();
  const home = homeCopy.useCopy();
  const [view, setView] = useState<View>('watch');
  const shown = useMemo(() => (view === 'movers' && movers.length > 0 ? movers : watch), [view, movers, watch]);
  const points = useMemo(() => (sparklines.status === 'ready' ? sparklines.data : {}), [sparklines]);
  const rows = useMemo<MarketRow[]>(
    () =>
      shown.map((item) => {
        const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
        return {
          id: item.symbol,
          symbol: item.base,
          name: assetName(item.base, home) ?? undefined,
          price: ticker ? priceText(item, ticker) : null,
          change: ticker?.changePct24h != null ? fmtPct(ticker.changePct24h) : null,
          trend: points[item.symbol] ?? undefined,
          href: coinHref(item.base, 'simple'),
        };
      }),
    [shown, tickers, points, home],
  );
  const all = isHiddenPath('/trade') ? null : '/trade';
  return (
    <section data-testid="hp-markets" className="hm-markets" aria-labelledby="home-markets-title">
      <PanelHead
        title={
          <span id="home-markets-title" data-sr-only="">
            {t('Markets')}
          </span>
        }
        aside={
          <>
            <Tabs
              id="home-markets"
              soft
              label={t('Markets view')}
              items={[
                { value: 'watch', label: popular ? t('Popular') : t('Watchlist') },
                ...(movers.length > 0 ? [{ value: 'movers', label: t('Movers') }] : []),
              ]}
              value={view}
              onChange={(value) => setView(value as View)}
            />
            {all && count > 0 ? (
              <a className="hm-link" href={all}>
                {t('All {count} markets', { count: String(count) })}
              </a>
            ) : null}
          </>
        }
      />
      {broken ? (
        <StateBlock kind="error" title={t('Markets down')} onRetry={retry ?? (() => location.reload())} retryLabel={t('Try again')} />
      ) : (
        <TabPanel id="home-markets" value={view} current={view}>
          <MarketTable
            labels={{
              caption: t('Markets'),
              market: t('Market'),
              price: t('Price'),
              change: t('24h'),
              trend: t('Last day'),
              trendLabel: (row) => t('{asset}, last day', { asset: row.symbol }),
            }}
            rows={rows}
            loadingRows={loading ? 6 : undefined}
            empty={<p className="lt-hint">{t('No markets yet')}</p>}
            action={(row) => (
              <ButtonLink size="sm" tone="secondary" href={row.href}>
                {t('Trade')}
              </ButtonLink>
            )}
            actionLabel={t('Trade')}
          />
        </TabPanel>
      )}
    </section>
  );
}
