/**
 * Historical market data downloads (`/api/v1/history/datasets/:id/download`) served by svc-trade (RC-cex-spot-05;
 * J-cex-spot-15 #10).
 *
 * The file is binary gzipped NDJSON (`application/gzip`). Reading it as UTF-8 text corrupts non-UTF-8 bytes and breaks
 * SHA-256 verification. On this exact download route, the edge forwards the raw bytes untouched along with
 * `content-disposition`, `x-content-sha256` and `cache-control`.
 */

const HISTORY_DOWNLOAD_RE = /^\/api\/v1\/history\/datasets\/[^/]+\/download$/;
const DOWNLOAD_HEADERS = ['content-disposition', 'x-content-sha256', 'cache-control'] as const;

export function isHistoryDownloadPath(pathname: string): boolean {
  return HISTORY_DOWNLOAD_RE.test(pathname);
}

/** True when the upstream reply on a history download route is binary gzip bytes (not a JSON error). */
export function isBinaryHistoryReply(pathname: string, contentType: string | null): boolean {
  if (!isHistoryDownloadPath(pathname)) return false;
  const ct = (contentType ?? '').toLowerCase();
  return ct.includes('application/gzip') || ct.includes('application/octet-stream');
}

/** Forwarded download headers on `/api/v1/history/datasets/:id/download` only. */
export function historyDownloadHeaders(pathname: string, upstream: { get(name: string): string | null }): Record<string, string> {
  if (!isHistoryDownloadPath(pathname)) return {};
  const out: Record<string, string> = {};
  for (const name of DOWNLOAD_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}
