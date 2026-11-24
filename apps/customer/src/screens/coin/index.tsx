// volt-room: /coin/:asset
import { useEffect, useState } from 'react';
import { MonitorTemplate, RoomBar, Skeleton } from '@intafaced/ui/lit/templates';
import type { RoomState } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../app/screen-types';
import { AboutSection } from './AboutSection';
import { aboutFor } from './about';
import { CoinBar } from './CoinBar';
import { coinCopy, coinName } from './copy';
import {
  BuyCard,
  coinHref,
  dec,
  KitState,
  LinkButton,
  navigate,
  PAR_ASSETS,
  refusalCopy,
  useFavorites,
  useMarkets,
  usePortfolio,
  usePreferences,
  useSession,
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
import { RecurringBuyButton } from '../trade/copybots/RecurringBuy';

const ASSET = /^[A-Z0-9]{2,12}$/;
/** The two coins every price is read against, in the order a price is looked up (UI-SPEC 1.2). */
const QUOTES = ['USDT', 'USDC'] as const;
const READY: RoomState = { kind: 'ready' };

/**
 * Coin page (UI-SPEC 5.5), `/coin/:asset`, on the kit's monitor template: the coin bar (the room's own bar), price and
 * chart with range pills, the Simple Buy card (Pro: a "Trade" button to the desk), key stats, what you hold, About, and
 * your recent trades in this coin.
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
      <Frame asset={asset}>
        <section data-testid="coin-problem">
          <MarketsProblem markets={markets} />
        </section>
      </Frame>
    );
  if (!settled || (markets.status === 'empty' && portfolio.status === 'loading')) return <PageSkeleton asset={asset} />;
  return (
    <div data-testid="if-coin">
      <CoinPage key={asset} asset={asset} markets={markets.status === 'ready' ? markets.data : []} portfolio={portfolio} />
    </div>
  );
}

/** The room with only its title and one part: the markets could not be read. */
function Frame({ asset, children }: { asset: string; children: React.ReactNode }) {
  const copy = coinCopy.useCopy();
  const name = coinName(asset, copy) ?? asset;
  return (
    <div data-testid="if-coin">
      <MonitorTemplate title={copy.t('{name} price', { name })} state={READY} figures={[]} chart={children} />
    </div>
  );
}

function MarketsProblem({ markets }: { markets: Loadable<MarketRow[]> }) {
  const { t } = coinCopy.useCopy();
  if (markets.status === 'error')
    return <KitState kind="error" title={t('Couldn’t load the price')} onRetry={markets.retry} retryLabel={t('Try again')} />;
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code);
    return <KitState kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return null;
}

/** The page's final shape while the markets load: the bar, the title, and the template's own placeholders. */
function PageSkeleton({ asset }: { asset: string }) {
  const copy = coinCopy.useCopy();
  const name = coinName(asset, copy) ?? asset;
  return (
    <div aria-busy="true" data-testid="coin-loading">
      <div data-testid="if-coin">
        <MonitorTemplate
          title={copy.t('{name} price', { name })}
          bar={
            <RoomBar marks={{ 'data-testid': 'coin-bar' }}>
              <Skeleton shape="text" count={1} />
            </RoomBar>
          }
          state={{ kind: 'loading' }}
          figures={[]}
          chart={null}
          panels={null}
          related={null}
        />
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
    <MonitorTemplate
      title={t('{name} price', { name: name ?? asset })}
      mode={layoutMode === 'pro' ? 'pro' : 'simple'}
      bar={
        <CoinBar
          asset={asset}
          name={name}
          hasAbout={hasAbout}
          star={market ? { on: favorites.isFavorite(market.symbol), toggle: () => favorites.toggle(market.symbol) } : null}
        />
      }
      roomAction={
        market ? (
          <span className="lt-hint" data-testid="pair">
            {market.base}/{market.quote}
          </span>
        ) : undefined
      }
      state={READY}
      figures={[]}
      chart={
        stable ? (
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
          <section data-testid="coin-nomarket" className="lt-stack">
            {!stable && !priced.length && quotes.length > 1 && quote ? (
              <QuotePicker quotes={quotes} quote={quote} onQuote={setChosen} />
            ) : null}
            <KitState
              kind="empty"
              title={
                quote && quotes.length > 1 ? t('No pair market title', { pair: `${asset}/${quote}` }) : t('No market title', { asset })
              }
              body={t('No market body')}
              action={{ label: t('Go to Markets'), href: '/trade' }}
            />
          </section>
        )
      }
      panels={
        <div className="lt-stack">
          {holds ? <YourCoin asset={asset} holding={holds} /> : null}
          <AboutSection asset={asset} name={name ?? asset} />
          <RecentActivity asset={asset} />
        </div>
      }
      related={
        <div className="lt-stack">
          {market && layoutMode !== 'pro' ? <BuyCard key={asset} initialAsset={asset} compact lockAsset /> : null}
          {market && layoutMode === 'pro' ? (
            <LinkButton href={coinHref(asset, 'pro', market.symbol)} tone="primary" data-testid="trade-button">
              {t('Trade {pair}', { pair: `${market.base}/${market.quote}` })}
            </LinkButton>
          ) : null}
          {/* A recurring buy of a basket, this coin first, on the person's own venue account (J-copy-bots-otc-16). */}
          {!stable ? <RecurringBuyButton asset={asset} /> : null}
          {market || !holds ? (
            <KeyStats asset={asset} symbol={market?.symbol ?? null} tickSize={market?.tickSize ?? null} portfolio={portfolio} />
          ) : null}
        </div>
      }
    />
  );
}

/** USDT and USDC: counted at one dollar, with no chart, no range pills and no buy card (UI-SPEC 5.5). */
function DollarCard({ asset }: { asset: string }) {
  const { t } = coinCopy.useCopy();
  return (
    <section aria-label={t('{name} price', { name: asset })}>
      <p className="lt-figure" data-testid="dollar-price">
        <span>{t('Dollar price')}</span> <span className="lt-hint">{t('Counted at 1 USD')}</span>
      </p>
    </section>
  );
}
