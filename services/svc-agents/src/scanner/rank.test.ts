import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rankFixtures, type MarketFixture } from './rank.js';
import { SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL, SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW } from './signal-inputs-law.js';

const NOW = new Date('2026-08-04T12:00:00.000Z');

function row(partial: Partial<MarketFixture> & Pick<MarketFixture, 'marketId'>): MarketFixture {
  return {
    last: '100.5',
    volume24h: '1000',
    change24hBps: 50,
    asOf: '2026-08-04T11:59:00.000Z',
    maxAgeMs: 120_000,
    ...partial,
  };
}

/** Sealed P0-11 — only path that may return ranked signals (D26-P1-A3). Owner-published page size (20 is allowed if explicit). */
function sealedOpts(extra: Parameters<typeof rankFixtures>[1] = {}) {
  return { now: NOW, signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW, limit: 20, ...extra };
}

describe('scanner rankFixtures (Stage-1 fixtures)', () => {
  it('D26-P1-A3: omitted law → refuse ranked signals (no sneak default board)', () => {
    const r = rankFixtures([row({ marketId: 'BTC-USD' })], { now: NOW });
    expect(r).toEqual({
      status: 'refuse',
      reason: 'signal_inputs_law_blank',
      userMessageKey: 'agents.scanner.signal_inputs_closed',
      residual: SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL,
    });
  });

  it('D26-P1-A3: unpublished law → refuse even with complete fixtures', () => {
    const r = rankFixtures([row({ marketId: 'BTC-USD' })], {
      now: NOW,
      signalInputsLaw: { published: false },
    });
    expect(r.status).toBe('refuse');
    if (r.status !== 'refuse') return;
    expect(r.reason).toBe('signal_inputs_law_blank');
    expect(r.residual).toContain('D26-P0-11');
  });

  it('omitted / blank / NaN / <1 limit refuses — never invent a 20-row rank page', () => {
    const fixtures = Array.from({ length: 25 }, (_, i) => row({ marketId: `M${String(i).padStart(2, '0')}-USD`, change24hBps: 25 - i }));
    const omitted = rankFixtures(fixtures, { now: NOW, signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW });
    expect(omitted).toEqual({
      status: 'refuse',
      reason: 'rank_limit_unset',
      userMessageKey: 'agents.scanner.rank_limit_unset',
    });
    for (const limit of [Number.NaN, 0, -1, 1.5] as const) {
      const r = rankFixtures(fixtures, sealedOpts({ limit }));
      expect(r).toEqual({
        status: 'refuse',
        reason: 'rank_limit_unset',
        userMessageKey: 'agents.scanner.rank_limit_unset',
      });
    }
  });

  it('owner-published 20 slices the rank page — never a silent default', () => {
    const fixtures = Array.from({ length: 25 }, (_, i) => row({ marketId: `M${String(i).padStart(2, '0')}-USD`, change24hBps: 25 - i }));
    const r = rankFixtures(fixtures, sealedOpts({ limit: 20 }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals).toHaveLength(20);
    expect(r.signals[0]!.marketId).toBe('M00-USD');
  });

  it('returns empty when the fixture list is empty — no invented markets', () => {
    const r = rankFixtures([], sealedOpts());
    expect(r).toEqual({ status: 'empty', userMessageKey: 'agents.scanner.empty' });
  });

  it('ranks complete fresh fixtures by |change| × volume weight', () => {
    const r = rankFixtures(
      [
        row({ marketId: 'BTC-USD', change24hBps: 10, volume24h: '100' }),
        row({ marketId: 'ETH-USD', change24hBps: -200, volume24h: '5000' }),
        row({ marketId: 'SOL-USD', change24hBps: 50, volume24h: '200' }),
      ],
      sealedOpts(),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals.map((s) => s.marketId)).toEqual(['ETH-USD', 'SOL-USD', 'BTC-USD']);
    expect(r.signals[0]!.reasons).toContain('change_down');
    expect(r.signals[0]!.score).toMatch(/^\d+\.\d{6}$/);
  });

  it('skips incomplete quotes — never zero-fills last/volume', () => {
    const r = rankFixtures(
      [row({ marketId: 'BTC-USD' }), row({ marketId: 'GHOST-USD', last: null, volume24h: null, change24hBps: null })],
      sealedOpts(),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]!.marketId).toBe('BTC-USD');
    expect(r.skippedIncomplete).toBe(1);
  });

  it('refuses with unavailable/stale when every row is past maxAge', () => {
    const r = rankFixtures(
      [
        row({
          marketId: 'BTC-USD',
          asOf: '2026-08-04T10:00:00.000Z',
          maxAgeMs: 60_000,
        }),
      ],
      sealedOpts(),
    );
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.scanner.unavailable',
      reason: 'stale',
    });
  });

  it('refuses with unavailable/no_quotes when all rows lack quotes', () => {
    const r = rankFixtures([row({ marketId: 'A', last: null }), row({ marketId: 'B', volume24h: null })], sealedOpts());
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') return;
    expect(r.reason).toBe('no_quotes');
    expect(r.userMessageKey).toBe('agents.scanner.unavailable');
  });

  it('does not invent a signal list when only invalid decimals arrive', () => {
    const r = rankFixtures([row({ marketId: 'X', last: 'not-a-number', volume24h: '1e999' })], sealedOpts());
    expect(r.status).toBe('unavailable');
  });

  it('Stage-2: market plane dark → refuse invent signals', () => {
    const r = rankFixtures([row({ marketId: 'BTC-USD' })], sealedOpts({ marketPlane: 'dark' }));
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.scanner.unavailable',
      reason: 'market_plane_dark',
    });
  });

  it('Stage-2 L3: market allowlist drops out-of-scope ids — no invent ranks', () => {
    const r = rankFixtures(
      [
        row({ marketId: 'BTC-USD', change24hBps: 10 }),
        row({ marketId: 'ETH-USD', change24hBps: 200 }),
        row({ marketId: 'SOL-USD', change24hBps: 50 }),
      ],
      sealedOpts({ marketAllowlist: ['ETH-USD'] }),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals.map((s) => s.marketId)).toEqual(['ETH-USD']);
    expect(r.skippedIncomplete).toBe(2);
  });

  it('Stage-2 L3: allowlist with no matches → empty not invent', () => {
    const r = rankFixtures([row({ marketId: 'BTC-USD' })], sealedOpts({ marketAllowlist: ['NOPE-USD'] }));
    expect(r).toEqual({ status: 'empty', userMessageKey: 'agents.scanner.empty' });
  });
});

describe('scanner last/volume24h are money — bigint parse, rank key is unitless', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('parses last and volume as scaled bigint — no parseDecimal Number()', () => {
    const src = readFileSync(join(here, 'rank.ts'), 'utf8');
    expect(src).toMatch(/parseAmount/);
    expect(src).not.toMatch(/function parseDecimal/);
    expect(src).not.toMatch(/const n = Number\(/);
    expect(src).not.toMatch(/\bparseFloat\s*\(/);
    expect(src).not.toMatch(/\bformatAmount\b/);
    expect(src).toMatch(/log1pVolumeWeight/);
    expect(src).not.toMatch(/limit\s*\?\?\s*20/);
    expect(src).toMatch(/rank_limit_unset/);
  });

  it('includes a past-MAX_SAFE_INTEGER last (quote completeness, not score)', () => {
    const pastSafe = '9007199254740993';
    const r = rankFixtures([row({ marketId: 'BTC-USD', last: pastSafe })], sealedOpts());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]!.marketId).toBe('BTC-USD');
  });

  it('ranks past-MAX_SAFE_INTEGER volumes by bigint, not Number(formatAmount)', () => {
    const high = '9007199254740993';
    const low = '9007199254740992';
    expect(Number(high)).toBe(Number(low));
    const r = rankFixtures(
      [row({ marketId: 'LOW-USD', volume24h: low, change24hBps: 50 }), row({ marketId: 'HIGH-USD', volume24h: high, change24hBps: 50 })],
      sealedOpts(),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.signals.map((s) => s.marketId)).toEqual(['HIGH-USD', 'LOW-USD']);
    expect(r.signals[0]!.score).toMatch(/^\d+\.\d{6}$/);
  });

  it('skips last/volume with more than 18 decimal places — refuse invent', () => {
    const r = rankFixtures([row({ marketId: 'BTC-USD', last: '1.1234567890123456789', volume24h: '1000' })], sealedOpts());
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') return;
    expect(r.reason).toBe('no_quotes');
  });

  it('skips a negative last the same way a negative volume is skipped — not a signal', () => {
    const mixed = rankFixtures(
      [row({ marketId: 'BTC-USD', last: '100.5', volume24h: '1000' }), row({ marketId: 'NEG-USD', last: '-1', volume24h: '1000' })],
      sealedOpts(),
    );
    expect(mixed.status).toBe('ok');
    if (mixed.status !== 'ok') return;
    expect(mixed.signals.map((s) => s.marketId)).toEqual(['BTC-USD']);
    expect(mixed.skippedIncomplete).toBe(1);

    const onlyNegative = rankFixtures([row({ marketId: 'NEG-USD', last: '-1' })], sealedOpts());
    expect(onlyNegative.status).toBe('unavailable');
    if (onlyNegative.status !== 'unavailable') return;
    expect(onlyNegative.reason).toBe('no_quotes');
  });
});
