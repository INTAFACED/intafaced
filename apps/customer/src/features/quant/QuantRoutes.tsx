import type { ReactNode } from 'react';
import { Quant } from '../more/Quant';
import { t as moreCopy } from '../more/copy';
import { AlgoHome } from './AlgoHome';
import { BacktestRoom } from './BacktestRoom';
import { SharedResult } from './ReportShare';
import { reportCopy } from './report-copy';
import { algoCopy } from './algo-copy';

const MODES = { '/quant/studio': 'studio', '/quant/backtest': 'backtest', '/quant/sandbox': 'sandbox' } as const;

/** A share token from its path segment; one copied with a broken escape is sent as it is and reads not found. */
function tokenOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

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
  // What a share link opens (AL-report-03), signed in or not.
  const share = /^\/quant\/share\/([^/]+)$/.exec(pathname);
  if (share) {
    return {
      title: reportCopy.t('publicTitle'),
      description: undefined,
      content: <SharedResult key={share[1]} token={tokenOf(share[1]!)} />,
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
