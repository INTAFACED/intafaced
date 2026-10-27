import { uiDirection } from '../../shared/locale';
import { tradeCopy as copy, CopyText, choiceNode } from './copy';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { navigate } from '../../app/location';
import { hiddenFeatureFor } from '../../app/feature-registry';
import { useResource } from '../../shared/resource';
import { createTradeApi } from './trade-api';
import { TradingTools } from './TradingTools';
import { BotsRoom } from '../../screens/trade/copybots/BotsRoom';
import { CopyRoom } from '../../screens/trade/copybots/CopyRoom';
import { CalendarRoom, NewsRoom } from './news/NewsRooms';
import { RiskControl } from './risk/RiskControl';
import { OrderDetailRoom } from './orders/OrderDetailRoom';
import { OrderHistoryRoom } from './orders/OrderHistoryRoom';
import './trade.css';

const modes = ['Spot', 'Margin', 'Futures', 'Options', 'Copy', 'Bots', 'Execution', 'Quote desk'];
const modeRoutes: Record<string, string> = {
  Spot: '/exchange',
  Margin: '/trade/margin',
  Futures: '/trade/futures',
  Options: '/trade/options',
  Copy: '/trade/copy',
  Bots: '/trade/bots',
  Execution: '/execution',
  Convert: '/trade/convert',
  'Quote desk': '/otc',
};
let catalogueIdentity = 0;

/**
 * The hidden trading modes (Margin, Futures, Options, Copy, Bots, Execution, Quote desk).
 * The spot desk, Markets list, Buy and Convert are the redesigned screens under `screens/trade/`;
 * `/exchange` and `/trade` reach them through the room table, never through here.
 */
/** A path segment as written; one with broken percent-encoding stays raw, so it reads as an order that is not found. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function TradeRoutes({ path }: { path: string }) {
  const pathname = new URL(path, location.origin).pathname.replace(/\/+$/, '');
  if (pathname === '/trade/news') return <NewsRoom />;
  if (pathname === '/trade/calendar') return <CalendarRoom />;
  if (pathname === '/trade/risk') return <RiskControl />;
  if (pathname === '/trade/orders') return <OrderHistoryRoom path={path} />;
  const orderMatch = /^\/trade\/orders\/([^/]+)$/.exec(pathname);
  if (orderMatch) return <OrderDetailRoom orderId={decodedSegment(orderMatch[1]!)} />;
  return <TradeModeRoutes path={path} />;
}
function TradeModeRoutes({ path }: { path: string }) {
  const route = new URL(path, location.origin),
    pathname = route.pathname;
  const preferences = usePreferences();
  const { languageFor } = copy.forLocale(preferences.language);
  const transport = useApi(),
    api = useMemo(() => createTradeApi(transport), [transport]),
    { userId } = useSession();
  const catalogueKey = useMemo(() => ++catalogueIdentity, [transport]);
  const catalogue = useResource((signal) => api.markets(signal), `trade-catalogue:${catalogueKey}`);
  const [simulation, setSimulation] = useState(() => route.searchParams.get('simulated') === 'true');
  const activeMode = pathname.startsWith('/trade/convert')
    ? 'Convert'
    : pathname.startsWith('/otc')
      ? 'Quote desk'
      : pathname.startsWith('/execution')
        ? 'Execution'
        : (modes.find((mode) => mode !== 'Spot' && pathname.includes(`/trade/${mode.toLowerCase()}`)) ?? 'Spot');
  const markets = catalogue.resource.status === 'ready' ? catalogue.resource.data : [];
  const visible = markets.filter(
    (market) =>
      market.paper === simulation &&
      (activeMode === 'Futures' ? market.swap || market.future : activeMode === 'Options' ? market.option : market.spot),
  );
  useEffect(() => {
    setSimulation(route.searchParams.get('simulated') === 'true');
  }, [path]);
  // A trade address that names no mode is the spot desk, which now lives at /trade/spot/:pair.
  useEffect(() => {
    if (activeMode === 'Spot') navigate('/trade', true);
  }, [activeMode]);
  if (activeMode === 'Spot') return null;
  // Copy and Bots are complete rooms of their own (screens/trade/copybots); they bring their own mode row.
  if (activeMode === 'Copy') return <CopyRoom path={path} />;
  if (activeMode === 'Bots') return <BotsRoom path={path} />;
  return (
    <div
      data-testid="trade-root"
      className="trade-root"
      lang={copy.forLocale(preferences.language).renderedLocale}
      dir={uiDirection(copy.forLocale(preferences.language).renderedLocale)}
    >
      <nav className="trade-modes" aria-label={copy.t('tradingModes')} lang={languageFor('tradingModes')}>
        <div className="trade-mode-links">
          {modes.map((mode) => (
            <a
              key={mode}
              aria-current={activeMode === mode ? 'page' : undefined}
              href={`${modeRoutes[mode]}${simulation ? '?simulated=true' : ''}`}
            >
              {choiceNode(mode)}
            </a>
          ))}
        </div>
        {/* Simulated markets are a blocked feature: the switch shows, and the desk says that no paper market is published. A row marked hidden would drop it. */}
        {hiddenFeatureFor(pathname, '?simulated=true') ? null : (
          <label className="trade-simulation">
            <input
              type="checkbox"
              checked={simulation}
              onChange={(event) => {
                setSimulation(event.target.checked);
                const target = new URL(location.href);
                if (event.target.checked) target.searchParams.set('simulated', 'true');
                else target.searchParams.delete('simulated');
                navigate(`${target.pathname}${target.search}${target.hash}`, true);
              }}
            />
            <CopyText k="simulated" />
          </label>
        )}
      </nav>
      <TradingTools
        key={`${activeMode}:${simulation}:${userId ?? 'guest'}`}
        api={api}
        transport={transport}
        mode={activeMode}
        markets={visible}
        simulation={simulation}
      />
    </div>
  );
}
