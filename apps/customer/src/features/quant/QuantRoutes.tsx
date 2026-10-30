import type { ReactNode } from 'react';
import { Quant } from '../more/Quant';
import { t as moreCopy } from '../more/copy';
import { AlgoHome } from './AlgoHome';
import { BacktestRoom } from './BacktestRoom';
import { StrategiesRoom } from './StrategiesRoom';
import { StrategyPage } from './StrategyPage';
import { strategyPageCopy } from './strategy-page-copy';
import { strategiesCopy } from './strategies-copy';
import { algoCopy } from './algo-copy';

const MODES = { '/quant/studio': 'studio', '/quant/backtest': 'backtest', '/quant/sandbox': 'sandbox' } as const;

/** The Algo dev rooms under `/quant`; `MoreRoutes` hands the whole prefix here. Null for a path that is not one of them. */
export function quantRoute(
  pathname: string,
  paper: boolean,
  userId: string | null,
): { title: ReactNode; description: ReactNode; content: ReactNode } | null {
  if (pathname === '/quant') {
    return {
      title: algoCopy.t('title'),
      description: algoCopy.t('description'),
      content: <AlgoHome key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const strategy = /^\/quant\/strategies\/([^/]+)$/.exec(pathname);
  if (strategy) {
    let strategyId = strategy[1]!;
    try {
      strategyId = decodeURIComponent(strategyId);
    } catch {
      // A broken escape is sent as it is, and the service answers that no such strategy exists.
    }
    return {
      title: strategiesCopy.t('title'),
      description: strategyPageCopy.t('description'),
      content: <StrategyPage key={`${userId ?? 'anonymous'}:${strategyId}`} strategyId={strategyId} paper={paper} />,
    };
  }
  if (pathname === '/quant/strategies') {
    return {
      title: strategiesCopy.t('title'),
      description: strategiesCopy.t('description'),
      content: <StrategiesRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const mode = MODES[pathname as keyof typeof MODES];
  if (!mode) return null;
  return {
    title:
      mode === 'sandbox'
        ? moreCopy('moreroutes.quant.sandbox')
        : mode === 'studio'
          ? moreCopy('moreroutes.quant.studio')
          : moreCopy('moreroutes.backtest'),
    description: moreCopy('moreroutes.simulated.strategy.research.with.explicit.historical.evidence'),
    content:
      mode === 'backtest' ? (
        // The bar backtest runs saved signal rules; the walk-forward record below keeps its own named refusal.
        <>
          <BacktestRoom key={`bars:${userId}`} />
          <Quant key={`${pathname}:${userId}`} paper={paper} mode={mode} />
        </>
      ) : (
        <Quant key={`${pathname}:${userId}`} paper={paper} mode={mode} />
      ),
  };
}
