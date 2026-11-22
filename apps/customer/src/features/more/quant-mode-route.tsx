import type { ReactNode } from 'react';
import { BacktestRoom } from '../quant';
import { t as copyText } from './copy';
import { Quant } from './Quant';

const MODES = { '/quant/studio': 'studio', '/quant/backtest': 'backtest', '/quant/sandbox': 'sandbox' } as const;

/** The studio, backtest and sandbox rooms under `/quant`, which `Quant` draws. Null for every other path. */
export function quantModeRoute(
  pathname: string,
  paper: boolean,
  userId: string | null,
): { title: ReactNode; description: ReactNode; content: ReactNode; bare?: true } | null {
  const mode = MODES[pathname as keyof typeof MODES];
  if (!mode) return null;
  return {
    title:
      mode === 'sandbox'
        ? copyText('moreroutes.quant.sandbox')
        : mode === 'studio'
          ? copyText('moreroutes.quant.studio')
          : copyText('moreroutes.backtest'),
    description: copyText('moreroutes.simulated.strategy.research.with.explicit.historical.evidence'),
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
