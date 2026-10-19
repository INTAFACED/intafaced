/**
 * MKT-0094 — the newest exported candle is the current uncommitted minute,
 * and rows older than the 720 most recent are absent. Gaps are not filled in.
 */
import { describe, expect, it } from 'vitest';
import { exportOhlcv, OHLC_RECENT_ROW_CAP } from './candles.js';
import type { Candle } from './types.js';

const MINUTE = 60_000;
const NOW_MS = 1_700_000_060_000;
const CURRENT_OPEN = Math.floor(NOW_MS / MINUTE) * MINUTE;

function bar(openTimeMs: number, close: bigint): Candle {
  return { openTimeMs, open: 10n, high: 12n, low: 9n, close, volume: 4n };
}

describe('MKT-0094 OHLC export', () => {
  it('keeps at most the 720 most recent rows', () => {
    expect(OHLC_RECENT_ROW_CAP).toBe(720);
  });

  it('marks the current 1-minute bucket uncommitted and leaves the previous one committed', () => {
    const exported = exportOhlcv([bar(CURRENT_OPEN - MINUTE, 11n), bar(CURRENT_OPEN, 15n)], '1m', NOW_MS);
    expect(exported).toHaveLength(2);
    expect(exported[1]).toMatchObject({
      openTimeMs: CURRENT_OPEN,
      close: 15n,
      committed: false,
    });
    expect(exported[0]).toMatchObject({
      openTimeMs: CURRENT_OPEN - MINUTE,
      close: 11n,
      committed: true,
    });
  });

  it('drops the row older than the 720 most recent and does not invent the missing minutes', () => {
    const rows: Candle[] = [];
    for (let i = 720; i >= 1; i -= 1) rows.push(bar(CURRENT_OPEN - i * MINUTE, 10n));
    rows.push(bar(CURRENT_OPEN, 15n));
    expect(rows).toHaveLength(721);

    const exported = exportOhlcv(rows, '1m', NOW_MS);
    expect(exported).toHaveLength(720);
    expect(exported[0]?.openTimeMs).toBe(CURRENT_OPEN - 719 * MINUTE);
    expect(exported[719]).toMatchObject({ openTimeMs: CURRENT_OPEN, committed: false });
    expect(exported.some((row) => row.openTimeMs === CURRENT_OPEN - 720 * MINUTE)).toBe(false);

    const gapped = exportOhlcv([bar(CURRENT_OPEN - 3 * MINUTE, 8n), bar(CURRENT_OPEN, 15n)], '1m', NOW_MS);
    expect(gapped.map((row) => row.openTimeMs)).toEqual([CURRENT_OPEN - 3 * MINUTE, CURRENT_OPEN]);
  });
});
