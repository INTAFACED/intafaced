import { describe, expect, it } from 'vitest';
import { historyDownloadHeaders, isBinaryHistoryReply, isHistoryDownloadPath } from './history-download-proxy.js';

describe('history download proxy at the edge (RC-cex-spot-05)', () => {
  const path = '/api/v1/history/datasets/11111111-1111-4111-8111-111111111111/download';

  it('matches only /api/v1/history/datasets/:id/download', () => {
    expect(isHistoryDownloadPath(path)).toBe(true);
    expect(isHistoryDownloadPath('/api/v1/history/datasets')).toBe(false);
    expect(isHistoryDownloadPath('/api/v1/history/schemas')).toBe(false);
    expect(isHistoryDownloadPath('/api/v1/history/datasets/a/b/download')).toBe(false);
  });

  it('treats gzip replies on the download route as binary, and JSON errors as text', () => {
    expect(isBinaryHistoryReply(path, 'application/gzip')).toBe(true);
    expect(isBinaryHistoryReply(path, 'application/octet-stream')).toBe(true);
    expect(isBinaryHistoryReply(path, 'application/json; charset=utf-8')).toBe(false);
    expect(isBinaryHistoryReply('/api/v1/history/datasets', 'application/gzip')).toBe(false);
  });

  it('forwards content-disposition, x-content-sha256 and cache-control only on the download path', () => {
    const headers = new Headers({
      'content-disposition': 'attachment; filename="BTC-USDT-trades-2026-11-24.ndjson.gz"',
      'x-content-sha256': 'a'.repeat(64),
      'cache-control': 'public, max-age=300',
      'x-other': 'ignored',
    });
    expect(historyDownloadHeaders(path, headers)).toEqual({
      'content-disposition': 'attachment; filename="BTC-USDT-trades-2026-11-24.ndjson.gz"',
      'x-content-sha256': 'a'.repeat(64),
      'cache-control': 'public, max-age=300',
    });
    expect(historyDownloadHeaders('/api/v1/markets', headers)).toEqual({});
  });
});
