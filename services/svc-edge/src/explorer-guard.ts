/**
 * The API explorer is read-only against live data (DV-console-01, J-developer-15 #7).
 *
 * The explorer at `/developers/explorer` tags every request it sends with `x-api-explorer: 1`. A tagged request
 * made with a live key that would write (any method but GET, HEAD and OPTIONS) is refused here, before anything is
 * forwarded, with `edge.explorer_live_write_refused`. A sandbox key's write goes on to the sandbox as any key's would.
 * An untagged request is not the explorer's and is untouched: the key's own scopes still decide it.
 */
export const EXPLORER_HEADER = 'x-api-explorer';
export const EXPLORER_LIVE_WRITE_REFUSED = 'edge.explorer_live_write_refused';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function explorerLiveWrite(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  principal: { kid?: string | undefined; key_env?: string | undefined } | null | undefined,
): boolean {
  if (headers[EXPLORER_HEADER] === undefined) return false;
  if (READS.has(method.toUpperCase())) return false;
  // Only a key is held to this: the explorer always sends one. A sandbox key may write; every other key is live.
  return Boolean(principal?.kid) && principal?.key_env !== 'sandbox';
}
