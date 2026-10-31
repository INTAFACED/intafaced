import type { Candle } from '../../../data/types';
import './drawings.css';
import { useSession } from '../../../features/session/session';
import type { ChartHost } from '../chart-host';
import { DrawingToolbar } from './DrawingToolbar';
import { ObjectTree } from './ObjectTree';
import { useDrawings } from './useDrawings';
import type { DrawingLimits } from './model';

/**
 * The drawing tools as a chart add-on: the workbench hands it the host and the bars the chart draws, and it renders the
 * toolbar and the object tree beside the chart. `limits` are the owner's values (blank refuses).
 */
export function DrawingsLayer({
  host,
  bars,
  workbench,
  symbol,
  tickSize,
  limits,
  onIndicatorsSlot,
}: {
  host: ChartHost | null;
  bars: readonly Candle[];
  workbench: string;
  symbol: string;
  tickSize: string;
  limits: DrawingLimits;
  /** Receives the object tree's indicator slot, where the chart's studies list themselves. */
  onIndicatorsSlot?: (slot: HTMLElement | null) => void;
}) {
  const { userId } = useSession();
  // Keyed by the person as well as the workbench: a sign-in change remounts the tools, so one person's drawings are never
  // written under another's key, even when the workbench itself does not change.
  return (
    <DrawingsTools
      key={`${userId ?? 'guest'}:${workbench}`}
      host={host}
      bars={bars}
      workbench={workbench}
      userId={userId}
      symbol={symbol}
      tickSize={tickSize}
      limits={limits}
      onIndicatorsSlot={onIndicatorsSlot}
    />
  );
}

function DrawingsTools({
  host,
  bars,
  workbench,
  userId,
  symbol,
  tickSize,
  limits,
  onIndicatorsSlot,
}: {
  host: ChartHost | null;
  bars: readonly Candle[];
  workbench: string;
  userId: string | null;
  symbol: string;
  tickSize: string;
  limits: DrawingLimits;
  onIndicatorsSlot?: (slot: HTMLElement | null) => void;
}) {
  const api = useDrawings(host, bars, { userId, workbench, symbol, tickSize, limits });
  return (
    <div className="dw-layer">
      <DrawingToolbar api={api} />
      <ObjectTree api={api} onIndicatorsSlot={onIndicatorsSlot} />
    </div>
  );
}
