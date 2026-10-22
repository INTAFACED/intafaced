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
}: {
  host: ChartHost | null;
  bars: readonly Candle[];
  workbench: string;
  symbol: string;
  tickSize: string;
  limits: DrawingLimits;
}) {
  const { userId } = useSession();
  const api = useDrawings(host, bars, { userId, workbench, symbol, tickSize, limits });
  return (
    <div className="dw-layer">
      <DrawingToolbar api={api} />
      <ObjectTree api={api} />
    </div>
  );
}
