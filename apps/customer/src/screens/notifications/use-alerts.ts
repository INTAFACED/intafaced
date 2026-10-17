import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../features/session/session';
import type { ApiResult } from '../../shared/api';
import { listAlerts, type AlertEvaluation, type PriceAlert } from './notify-api';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
export type AlertsState =
  { status: 'loading' } | { status: 'failed'; failure: Failure } | { status: 'ready'; items: PriceAlert[]; evaluation: AlertEvaluation };

/** The signed-in person's alerts. Another account's rows and repeated ids are dropped, never shown. */
export function useAlerts() {
  const { api, userId } = useSession();
  const [state, setState] = useState<AlertsState>({ status: 'loading' });
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void listAlerts(api, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) return setState({ status: 'failed', failure: result });
      const items = result.data.items.filter(
        (row, index, all) => row.userId === userId && all.findIndex((other) => other.id === row.id) === index,
      );
      setState({ status: 'ready', items, evaluation: result.data.evaluation });
    });
    return () => controller.abort();
  }, [api, userId, cycle]);
  /** Read again. Keeps what is on screen while the new answer comes. */
  const reload = useCallback(() => setCycle((value) => value + 1), []);
  return { state, reload };
}

export interface AlertMarket {
  id: string;
  label: string;
  quote: string;
}
export type MarketsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; markets: AlertMarket[] };

const marketRow = z
  .object({
    id: z.string().min(1).max(64),
    base: z.string(),
    quote: z.string(),
    spot: z.boolean().optional(),
    paper: z.boolean().optional(),
  })
  .passthrough();

/** The markets an alert can watch: real spot markets, not simulated ones. Read once when the page opens. */
export function useAlertMarkets(): MarketsState {
  const { api, userId } = useSession();
  const [state, setState] = useState<MarketsState>({ status: 'loading' });
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void api.rest('/markets', z.array(marketRow), { query: { limit: 500 }, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) return setState({ status: 'failed' });
      const markets = result.data
        .filter((row) => row.spot !== false && row.paper !== true)
        .map((row) => ({ id: row.id, label: `${row.base}/${row.quote}`, quote: row.quote }))
        .sort((a, b) => a.label.localeCompare(b.label));
      setState({ status: 'ready', markets });
    });
    return () => controller.abort();
  }, [api, userId]);
  return state;
}
