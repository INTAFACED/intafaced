import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../../app/screen-types';
import { useDeviceSetting } from '../../features/trade/hooks';
import { useSession } from '../../features/session/session';
import type { ChartInterval } from '../trade/chart/candles';
import { useDeskMarkets } from '../trade/desk/data';
import { findMarket, pairOf, type DeskMarket } from '../trade/desk/market';
import '../trade/chart/chart.css';
import './charts.css';
import { chartsCopy } from './copy';
import { Button, defaultDeskPair, navigate, normalizePair, refusalCopy, Skeleton, StateBlock } from './deps';
import { MarketChartWidget, type WidgetProps } from './MarketChartWidget';
import {
  DEFAULT_SETTING,
  chartsHref,
  intervalFromSearch,
  isWorkbenchSetting,
  settingKey,
  workbenchId,
  type ChartMode,
  type WorkbenchSetting,
} from './workbench';

/** The one store every widget on the page reads: the market (from the address) and the interval and style (kept per workbench). */
interface Workbench {
  id: string;
  market: DeskMarket;
  markets: readonly DeskMarket[];
  setting: WorkbenchSetting;
  setInterval: (interval: ChartInterval) => void;
  setMode: (mode: ChartMode) => void;
  chooseMarket: (symbol: string) => void;
}
const WorkbenchContext = createContext<Workbench | null>(null);
const useWorkbench = (): Workbench => {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('useWorkbench needs a workbench');
  return value;
};

function MarketSelect({
  label,
  value,
  markets,
  onChoose,
}: {
  label: string;
  value: string;
  markets: readonly DeskMarket[];
  onChoose: (symbol: string) => void;
}) {
  return (
    <label className="cw-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChoose(event.target.value)}>
        {markets.map((market) => (
          <option key={market.symbol} value={market.symbol}>
            {market.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The second chart: it follows the workbench, or it is set free with a market and interval of its own. */
function SecondChart({ openSocket }: Pick<WidgetProps, 'openSocket'>) {
  const { t } = chartsCopy.useCopy();
  const bench = useWorkbench();
  const [linked, setLinked] = useState(true);
  const [own, setOwn] = useState<{ symbol: string; setting: WorkbenchSetting }>({ symbol: bench.market.symbol, setting: bench.setting });
  const market = linked ? bench.market : (findMarket(bench.markets as DeskMarket[], own.symbol) ?? bench.market);
  const setting = linked ? bench.setting : own.setting;
  return (
    <div className="cw-second">
      <div className="cw-second-bar">
        <label className="cw-check">
          <input
            type="checkbox"
            checked={linked}
            onChange={(event) => {
              const next = event.target.checked;
              if (!next) setOwn({ symbol: bench.market.symbol, setting: bench.setting });
              setLinked(next);
            }}
          />
          <span>{t('Follow the first chart')}</span>
        </label>
        {!linked && (
          <MarketSelect
            label={t('Second chart market')}
            value={market.symbol}
            markets={bench.markets}
            onChoose={(symbol) => setOwn((now) => ({ ...now, symbol }))}
          />
        )}
      </div>
      <MarketChartWidget
        market={market}
        interval={setting.interval}
        mode={setting.mode}
        onInterval={(interval) =>
          linked ? bench.setInterval(interval) : setOwn((now) => ({ ...now, setting: { ...now.setting, interval } }))
        }
        onMode={(mode) => (linked ? bench.setMode(mode) : setOwn((now) => ({ ...now, setting: { ...now.setting, mode } })))}
        openSocket={openSocket}
      />
    </div>
  );
}

function Page({
  market,
  markets,
  search,
  openSocket,
}: {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  search: string;
  openSocket?: WidgetProps['openSocket'];
}) {
  const { t } = chartsCopy.useCopy();
  const { userId } = useSession();
  const id = workbenchId(search);
  const [setting, setSetting] = useDeviceSetting<WorkbenchSetting>(settingKey(userId, id), DEFAULT_SETTING, isWorkbenchSetting);
  const [second, setSecond] = useState(false);
  // An interval in the address opens the workbench at that interval, once; after that the person's choice stands.
  const fromAddress = useRef(intervalFromSearch(search));
  useEffect(() => {
    const wanted = fromAddress.current;
    fromAddress.current = undefined;
    if (wanted && wanted !== setting.interval) setSetting({ ...setting, interval: wanted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setInterval = useCallback((interval: ChartInterval) => setSetting((now) => ({ ...now, interval })), [setSetting]);
  const setMode = useCallback((mode: ChartMode) => setSetting((now) => ({ ...now, mode })), [setSetting]);
  const chooseMarket = useCallback((symbol: string) => navigate(chartsHref(pairOf(symbol), { workbench: id })), [id]);
  const bench = useMemo<Workbench>(
    () => ({ id, market, markets, setting, setInterval, setMode, chooseMarket }),
    [id, market, markets, setting, setInterval, setMode, chooseMarket],
  );
  return (
    <WorkbenchContext.Provider value={bench}>
      <div className="cw-page" data-market={market.symbol} data-workbench={id}>
        <header className="cw-head">
          <div>
            <h1>{t('Charts')}</h1>
            <p>{t('Charts lead')}</p>
          </div>
          <div className="cw-head-actions">
            <MarketSelect label={t('Choose a market')} value={market.symbol} markets={markets} onChoose={chooseMarket} />
            <a className="cw-link" href={`/trade/spot/${pairOf(market.symbol)}`}>
              {t('Trade this market')}
            </a>
          </div>
        </header>
        <MarketChartWidget
          market={market}
          interval={setting.interval}
          mode={setting.mode}
          onInterval={setInterval}
          onMode={setMode}
          openSocket={openSocket}
        />
        <div className="cw-more-charts">
          <Button type="button" variant="secondary" onClick={() => setSecond((now) => !now)}>
            {second ? t('Remove the second chart') : t('Add a linked chart')}
          </Button>
        </div>
        {second && <SecondChart openSocket={openSocket} />}
      </div>
    </WorkbenchContext.Provider>
  );
}

/** The workbench, `/charts/:symbol`: a chart for the market in the address, with the interval and style shared by every chart on the page. */
export default function ChartsScreen({ params, search, openSocket }: ScreenProps & { openSocket?: WidgetProps['openSocket'] }) {
  const { t } = chartsCopy.useCopy();
  const markets = useDeskMarkets();
  const pair = normalizePair(params.symbol ?? defaultDeskPair);
  if (markets.status === 'loading')
    return (
      <div className="cw-page" role="status" aria-busy="true">
        <Skeleton height={440} className="bg-field" />
      </div>
    );
  if (markets.status === 'error')
    return (
      <div className="cw-page cw-page--state">
        <StateBlock kind="error" title={t('Couldn’t load this market')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </div>
    );
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code, { pair });
    return (
      <div className="cw-page cw-page--state">
        <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />
      </div>
    );
  }
  const market = markets.status === 'ready' ? findMarket(markets.data, pair) : undefined;
  if (!market || markets.status !== 'ready')
    return (
      <div className="cw-page cw-page--state">
        <StateBlock
          kind="empty"
          title={t('Market not found title')}
          body={t('Market not found body')}
          action={{ label: t('See all markets'), href: '/trade' }}
        />
      </div>
    );
  return <Page key={market.symbol} market={market} markets={markets.data} search={search} openSocket={openSocket} />;
}
