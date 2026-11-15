import { MATCHING_FETCH_MS, MatchingUnavailableError } from './matching-client.js';

/**
 * svc-matching's published trading rulebook (RC-cex-spot-08), read from its public doors: `GET /rulebook` (the version in
 * force with its sections) and `GET /rulebook/versions` (the history). Public reads, so nothing is signed. A refusal or a
 * timeout throws, and the caller answers a typed 503; svc-trade never holds or invents rulebook text.
 */
export function createMatchingRulebookReader(
  baseUrl: string,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): (which: 'current' | 'versions') => Promise<unknown> {
  const base = baseUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? MATCHING_FETCH_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return async (which) => {
    const path = which === 'current' ? '/rulebook' : '/rulebook/versions';
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new MatchingUnavailableError(`svc-matching ${path} failed (${res.status})`);
    return (await res.json()) as unknown;
  };
}
