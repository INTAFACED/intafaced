import { describe, expect, it } from 'vitest';
import { invokeScannerDataTool, type TickerFixture } from './data-tools.js';
import { SCANNER_DATA_TOOLS } from './guardrail.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');

const law = {
  published: true as const,
  matrix: {
    free: { maxSignals: 5, tools: [...SCANNER_DATA_TOOLS] },
  },
};

function ticker(partial: Partial<TickerFixture> & Pick<TickerFixture, 'marketId'>): TickerFixture {
  return {
    last: '100.5',
    volume24h: '1000',
    change24hBps: 50,
    asOf: '2026-08-07T11:59:00.000Z',
    maxAgeMs: 120_000,
    ...partial,
  };
}

describe('invokeScannerDataTool (Stage-2)', () => {
  it('echoes complete fresh ticker — never invents last', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      ticker: ticker({ marketId: 'BTC-USD' }),
    });
    expect(r).toEqual({
      status: 'ok',
      tool: 'trade.ticker',
      marketId: 'BTC-USD',
      last: '100.5',
      volume24h: '1000',
      change24hBps: 50,
      asOf: '2026-08-07T11:59:00.000Z',
    });
  });

  it('dark plane refuses invent', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'dark',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      ticker: ticker({ marketId: 'BTC-USD' }),
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'market_plane_dark' });
  });

  it('stale ticker refuses', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      ticker: ticker({
        marketId: 'BTC-USD',
        asOf: '2026-08-07T10:00:00.000Z',
        maxAgeMs: 60_000,
      }),
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'stale' });
  });

  it('incomplete ticker refuses — no zero-fill', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      ticker: ticker({ marketId: 'BTC-USD', last: null }),
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'incomplete_ticker' });
  });

  it('a ticker last of -1 refuses invalid_decimal and does not return ok', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      ticker: ticker({ marketId: 'BTC-USD', last: '-1' }),
    });
    expect(r.status).not.toBe('ok');
    expect(r).toMatchObject({ status: 'refuse', reason: 'invalid_decimal' });
  });

  it('money-write tool refuses', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.order',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'money_write' });
  });

  it('refuses place/cancel/withdraw by name — a scanner session cannot trade', () => {
    for (const tool of ['trade.place', 'trade.cancel', 'bank.withdraw'] as const) {
      expect(
        invokeScannerDataTool({
          tool,
          plane: 'live',
          tierLaw: law,
          userTier: 'free',
          now: NOW,
        }),
        tool,
      ).toEqual({
        status: 'refuse',
        tool,
        reason: 'money_write',
        userMessageKey: 'agents.scanner.unavailable',
      });
    }
  });

  it('blank tier law refuse-closed', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.ticker',
      plane: 'live',
      tierLaw: null,
      userTier: 'free',
      now: NOW,
      ticker: ticker({ marketId: 'BTC-USD' }),
    });
    expect(r).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.scanner.tier_closed',
    });
  });

  it('book.top echoes bid/ask when fresh', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.book.top',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      bookTop: {
        marketId: 'ETH-USD',
        bid: '10.1',
        ask: '10.2',
        asOf: '2026-08-07T11:59:30.000Z',
        maxAgeMs: 120_000,
      },
    });
    expect(r).toEqual({
      status: 'ok',
      tool: 'trade.book.top',
      marketId: 'ETH-USD',
      bid: '10.1',
      ask: '10.2',
      asOf: '2026-08-07T11:59:30.000Z',
    });
  });

  it('markets.list refuses empty', () => {
    const r = invokeScannerDataTool({
      tool: 'trade.markets.list',
      plane: 'live',
      tierLaw: law,
      userTier: 'free',
      now: NOW,
      markets: [],
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'empty_markets' });
  });
});
