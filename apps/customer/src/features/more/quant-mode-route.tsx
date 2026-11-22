import type { ReactNode } from 'react';
import { BacktestRoom } from '../quant';
import { Quant, quantModeWords } from './Quant';

const MODES = { '/quant/studio': 'studio', '/quant/backtest': 'backtest', '/quant/sandbox': 'sandbox' } as const;

/** The studio, backtest and sandbox rooms under `/quant`, which `Quant` draws on its desk template. Null for every other path. */
export function quantModeRoute(
  pathname: string,
  paper: boolean,
  userId: string | null,
): { title: ReactNode; description: ReactNode; content: ReactNode; framed?: boolean } | null {
  const mode = MODES[pathname as keyof typeof MODES];
  if (!mode) return null;
  const { title, description } = quantModeWords(mode);
  return {
    title,
    description,
    content: (
      <Quant
        key={`${pathname}:${userId}`}
        paper={paper}
        mode={mode}
        // The bar backtest runs saved signal rules; the walk-forward record beside it keeps its own named refusal.
        bars={mode === 'backtest' ? <BacktestRoom key={`bars:${userId}`} /> : undefined}
      />
    ),
    // Drawn on its own desk template, which carries the title and description itself.
    framed: true,
  };
}
