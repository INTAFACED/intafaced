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
