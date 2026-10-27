import { useEffect, useState } from 'react';
import './coin.css';
import type { ScreenProps } from '../../app/screen-types';
import { AboutSection } from './AboutSection';
import { aboutFor } from './about';
import { CoinBar } from './CoinBar';
import { coinCopy, coinName } from './copy';
import {
  BuyCard,
  Button,
  coinHref,
  dec,
  navigate,
  PAR_ASSETS,
  refusalCopy,
  Skeleton,
  StateBlock,
  useFavorites,
  useMarkets,
  usePortfolio,
  usePreferences,
  useSession,
  useTicker,
  type Loadable,
  type MarketRow,
  type PortfolioSummary,
} from './deps';
import { isUnpricedMarket, pickQuote } from './coin-math';
import { QuotePicker } from './QuotePicker';
import { useTickerStates } from './use-ticker-states';
import { KeyStats, holdingOf } from './KeyStats';
import { PriceCard } from './PriceCard';
import { RecentActivity } from './RecentActivity';
import { YourCoin } from './YourCoin';

const ASSET = /^[A-Z0-9]{2,12}$/;
/** The two coins every price is read against, in the order a price is looked up (UI-SPEC 1.2). */
const QUOTES = ['USDT', 'USDC'] as const;

/**
 * Coin page (UI-SPEC 5.5), `/coin/:asset`: coin bar, price and chart with range pills, the Simple Buy card (Pro: a
 * "Trade" button to the desk), key stats, what you hold, About, and your recent trades in this coin.
 */
export default function CoinScreen({ params }: ScreenProps) {
  const asset = (params.asset ?? '').trim().toUpperCase();
  const markets = useMarkets({ includeClosed: true });
  const portfolio = usePortfolio();

  const listed = markets.status === 'ready' && markets.data.some((m) => m.base === asset || m.quote === asset);
  const held = portfolio.status === 'ready' && portfolio.data.holdings.some((h) => h.asset === asset);
  const settled = markets.status === 'ready' || markets.status === 'empty';
  // Unknown asset in the address: back to the markets list (UI-SPEC 5.5). A coin the person holds is known even with no
  // market, so the portfolio is waited for first.
  const unknown = !ASSET.test(asset) || (settled && !listed && portfolio.status !== 'loading' && !held);
  useEffect(() => {
    if (unknown) navigate('/trade', true);
  }, [unknown]);

  if (unknown) return null;
  if (markets.status === 'error' || markets.status === 'refused')
    return (
      <Frame>
        <section data-testid="coin-problem" className="coin-card coin-problem">
          <MarketsProblem markets={markets} />
        </section>
      </Frame>
    );
  if (!settled || (markets.status === 'empty' && portfolio.status === 'loading'))
    return (
      <Frame>
        <PageSkeleton />
      </Frame>
    );
  return (
    <Frame>
      <CoinPage key={asset} asset={asset} markets={markets.status === 'ready' ? markets.data : []} portfolio={portfolio} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="if-coin" className="if-coin">
      {children}
    </div>
  );
}

function MarketsProblem({ markets }: { markets: Loadable<MarketRow[]> }) {
  const { t } = coinCopy.useCopy();
  if (markets.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load the price')} onRetry={markets.retry} retryLabel={t('Try again')} />;
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return null;
}

/** The page's final shape while the markets load: bar, title, two cards of their real sizes. */
function PageSkeleton() {
  return (
    <div aria-busy="true" data-testid="coin-loading">
      <div data-testid="coin-bar" className="coin-bar">
        <Skeleton width={160} height={40} className="bg-field" />
      </div>
      <div className="coin-titlerow">
        <Skeleton width={220} height={34} className="bg-field" />
      </div>
      <div data-testid="coin-grid" className="coin-grid">
        <div className="coin-col">
          <Skeleton height={580} className="bg-panel" />
        </div>
        <div className="coin-col">
          <Skeleton height={440} className="bg-panel" />
          <Skeleton height={150} className="bg-panel" />
        </div>
      </div>
    </div>
  );
}

function CoinPage({ asset, markets, portfolio }: { asset: string; markets: MarketRow[]; portfolio: Loadable<PortfolioSummary> }) {
  const copy = coinCopy.useCopy();
  const { t } = copy;
  const { layoutMode } = usePreferences();
  const { userId } = useSession();
  const favorites = useFavorites(userId);
  const name = coinName(asset, copy);

  // The coin's markets: a coin that is a dollar itself (USDT, USDC) has none; other coins price against USDT, then USDC.
  const stable = PAR_ASSETS.has(asset);
  const open = stable ? [] : markets.filter((m) => m.orderable && m.base === asset);
  const quotes = QUOTES.filter((q) => open.some((m) => m.quote === q));
  const [chosen, setChosen] = useState<string | null>(null);
  // Which of the coin's markets can be priced: a listed market with no open book answers "no market" on its ticker. The
  // page prices against the first quote that can be; with none, it keeps the "no market" card and still offers the quotes.
  const states = useTickerStates(quotes.map((q) => open.find((m) => m.quote === q)!.symbol));
  const priced: string[] = quotes.filter(
    (q) => !isUnpricedMarket(states[open.find((m) => m.quote === q)!.symbol] ?? { status: 'loading' }),
  );
  const quote = pickQuote(quotes, priced, chosen);
  const market = priced.length && quote ? (open.find((m) => m.quote === quote) ?? null) : null;

  const holding = holdingOf(portfolio, asset);
  const holds = holding !== null && holding !== 'unknown' && (dec(holding.total) ?? 0n) > 0n ? holding : null;
  const hasAbout = aboutFor(asset) !== null;

  return (
    <>
      <CoinBar
        asset={asset}
        name={name}
        hasAbout={hasAbout}
        star={market ? { on: favorites.isFavorite(market.symbol), toggle: () => favorites.toggle(market.symbol) } : null}
      />
      <div className="coin-titlerow">
        <h1 data-testid="coin-title" className="coin-title">
          {t('{name} price', { name: name ?? asset })}
        </h1>
        {market ? (
          <span className="coin-pair" data-testid="pair">
            {market.base}/{market.quote}
          </span>
        ) : null}
      </div>
      <div data-testid="coin-grid" className="coin-grid">
        <div className="coin-col">
          {stable ? (
            <DollarCard asset={asset} />
          ) : market && quote ? (
            <PriceCard
              key={market.symbol}
              asset={asset}
              symbol={market.symbol}
              tickSize={market.tickSize}
              quotes={priced}
              quote={quote}
              onQuote={setChosen}
            />
          ) : (
            <section data-testid="coin-nomarket" className="coin-card coin-nomarket">
              {!stable && !priced.length && quotes.length > 1 && quote ? (
                <div className="coin-nomarket__quote">
                  <QuotePicker quotes={quotes} quote={quote} onQuote={setChosen} />
                </div>
              ) : null}
              <StateBlock
                kind="empty"
                title={
                  quote && quotes.length > 1 ? t('No pair market title', { pair: `${asset}/${quote}` }) : t('No market title', { asset })
                }
                body={t('No market body')}
                action={{ label: t('Go to Markets'), href: '/trade' }}
              />
            </section>
          )}
          {holds ? <YourCoin asset={asset} holding={holds} /> : null}
          <AboutSection asset={asset} name={name ?? asset} />
          <RecentActivity asset={asset} />
        </div>
        <div className="coin-col">
          {market && layoutMode !== 'pro' ? <BuyCard key={asset} initialAsset={asset} compact lockAsset /> : null}
          {market && layoutMode === 'pro' ? (
            <Button
              variant="primary"
              size={40}
              fullWidth
              nativeButton={false}
              render={<a href={coinHref(asset, 'pro', market.symbol)} data-testid="trade-button" />}
            >
              {t('Trade {pair}', { pair: `${market.base}/${market.quote}` })}
            </Button>
          ) : null}
          {market || !holds ? (
            <KeyStats asset={asset} symbol={market?.symbol ?? null} tickSize={market?.tickSize ?? null} portfolio={portfolio} />
          ) : null}
        </div>
      </div>
    </>
  );
}

/** USDT and USDC: counted at one dollar, with no chart, no range pills and no buy card (UI-SPEC 5.5). */
function DollarCard({ asset }: { asset: string }) {
  const { t } = coinCopy.useCopy();
  return (
    <section className="coin-card coin-dollar" aria-label={t('{name} price', { name: asset })}>
      <p className="coin-dollar__price" data-testid="dollar-price">
        <span className="coin-dollar__figure">{t('Dollar price')}</span> <span className="coin-dollar__rule">{t('Counted at 1 USD')}</span>
      </p>
    </section>
  );
}
