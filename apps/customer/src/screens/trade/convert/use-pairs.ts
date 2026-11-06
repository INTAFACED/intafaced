import { useEffect, useState } from 'react';
import type { ConvertPairs, createToolApi } from '../../../features/trade/tool-api';

export type PairsState = { status: 'loading' } | { status: 'ready'; data: ConvertPairs } | { status: 'unread' };

/**
 * What the service would convert now (`convert.pairs`), read once per open. While it is unread the picker shows the
 * markets' own list without limits; it never invents a limit, and a coin the service restricts is dropped once it answers.
 */
export function useConvertPairs(tools: ReturnType<typeof createToolApi>): PairsState {
  const [state, setState] = useState<PairsState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void tools.convertPairs(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: 'ready', data: result.data } : { status: 'unread' });
    });
    return () => controller.abort();
  }, [tools]);
  return state;
}

export type RouteState = { status: 'loading' } | { status: 'direct' } | { status: 'refused'; code: string } | { status: 'unread' };

/** How `from` converts to `to`, asked once (`convert.route`). A refusal keeps the service's code; nothing is priced. */
export function useConvertRoute(tools: ReturnType<typeof createToolApi>, from: string, to: string): RouteState {
  const [state, setState] = useState<RouteState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void tools.convertRoute({ from, to }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setState({ status: 'direct' });
      else if (result.code?.startsWith('trade.')) setState({ status: 'refused', code: result.code });
      else setState({ status: 'unread' });
    });
    return () => controller.abort();
  }, [tools, from, to]);
  return state;
}
