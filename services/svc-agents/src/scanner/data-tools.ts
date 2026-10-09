/**
 * Market Scanner Stage-2 — live data tools with typed refusals.
 *
 * Spec: docs/ops/trk/agents.scanner.md Stage 2.
 *
 * Caller supplies allowlisted fixture rows (same honesty class as Stage-1
 * rankFixtures). Never invents last/volume/change, market lists, or book tops.
 * Dark plane / incomplete / stale / undeclared / money-write → typed refuse.
 * Agents never ledger.post.
 */

import { isScannerDataTool, isScannerMoneyWriteTool, scannerAgentGuardrail } from './guardrail.js';
import { scannerTierGate, type ScannerTierGateRefuse, type ScannerTierLaw } from './tier-gate.js';
import type { MarketPlaneState } from './rank.js';

export type TickerFixture = {
  readonly marketId: string;
  /** Last trade / mid as decimal string. null = no quote — refuse, never invent. */
  readonly last: string | null;
  readonly volume24h: string | null;
  readonly change24hBps: number | null;
  readonly asOf: string;
  readonly maxAgeMs: number;
};

export type MarketListFixture = {
  readonly marketId: string;
  readonly symbol: string;
  readonly status: 'open' | 'halted' | 'closed';
};

export type BookTopFixture = {
  readonly marketId: string;
  /** Best bid as decimal string. null = incomplete — refuse. */
  readonly bid: string | null;
  /** Best ask as decimal string. null = incomplete — refuse. */
  readonly ask: string | null;
  readonly asOf: string;
  readonly maxAgeMs: number;
};

export type ScannerDataToolOk =
  | {
      readonly status: 'ok';
      readonly tool: 'trade.ticker';
      readonly marketId: string;
      readonly last: string;
      readonly volume24h: string;
      readonly change24hBps: number;
      readonly asOf: string;
    }
  | {
      readonly status: 'ok';
      readonly tool: 'trade.markets.list';
      readonly markets: readonly MarketListFixture[];
    }
  | {
      readonly status: 'ok';
      readonly tool: 'trade.book.top';
      readonly marketId: string;
      readonly bid: string;
      readonly ask: string;
      readonly asOf: string;
    };

export type ScannerDataToolRefuseReason =
  | 'market_plane_dark'
  | 'tier_law_blank'
  | 'tier_not_granted'
  | 'depth_invalid'
  | 'tool_not_declared'
  | 'money_write'
  | 'tool_not_in_tier'
  | 'missing_fixture'
  | 'incomplete_ticker'
  | 'incomplete_book'
  | 'invalid_decimal'
  | 'stale'
  | 'empty_markets';

export type ScannerDataToolRefuse = {
  readonly status: 'refuse';
  readonly tool: string;
  readonly reason: ScannerDataToolRefuseReason;
  readonly userMessageKey: 'agents.scanner.unavailable' | 'agents.scanner.tier_closed';
};

export type ScannerDataToolResult = ScannerDataToolOk | ScannerDataToolRefuse;

function parseUnsignedDecimal(s: string): boolean {
  return /^\d+(\.\d{1,18})?$/.test(s);
}

function isFresh(asOf: string, maxAgeMs: number, nowMs: number): boolean {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs && nowMs - t >= 0;
}

function tierRefuseToData(tool: string, refuse: ScannerTierGateRefuse): ScannerDataToolRefuse {
  return {
    status: 'refuse',
    tool,
    reason: refuse.reason,
    userMessageKey: refuse.userMessageKey,
  };
}

/**
 * Invoke one Stage-2-declared scanner read tool against caller fixtures.
 * Composes plane gate + tier gate + allowlist honesty + max-age.
 */
export function invokeScannerDataTool(input: {
  tool: string;
  plane: MarketPlaneState;
  /** Product-law tier matrix. Blank → refuse-closed (no invent). */
  tierLaw?: ScannerTierLaw | null;
  userTier?: string;
  now?: Date;
  ticker?: TickerFixture | null;
  markets?: readonly MarketListFixture[] | null;
  bookTop?: BookTopFixture | null;
}): ScannerDataToolResult {
  const tool = input.tool.trim();

  if (isScannerMoneyWriteTool(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'money_write',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }

  if (input.plane === 'dark') {
    return {
      status: 'refuse',
      tool,
      reason: 'market_plane_dark',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }

  const tier = scannerTierGate({
    law: input.tierLaw,
    userTier: input.userTier ?? '',
  });
  if (tier.status === 'refuse') {
    return tierRefuseToData(tool, tier);
  }

  const declared = new Set(scannerAgentGuardrail().tools.map((t) => t.name));
  if (!declared.has(tool) || !isScannerDataTool(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'tool_not_declared',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }

  if (!tier.allowedTools.includes(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'tool_not_in_tier',
      userMessageKey: 'agents.scanner.tier_closed',
    };
  }

  const nowMs = (input.now ?? new Date()).getTime();

  if (tool === 'trade.ticker') {
    const q = input.ticker;
    if (!q || !q.marketId.trim()) {
      return {
        status: 'refuse',
        tool,
        reason: 'missing_fixture',
        userMessageKey: 'agents.scanner.unavailable',
      };
    }
    if (q.last == null || q.volume24h == null || q.change24hBps == null) {
      return {
        status: 'refuse',
        tool,
        reason: 'incomplete_ticker',
        userMessageKey: 'agents.scanner.unavailable',
      };
    }
    if (!parseUnsignedDecimal(q.last) || !parseUnsignedDecimal(q.volume24h)) {
      return {
        status: 'refuse',
        tool,
        reason: 'invalid_decimal',
        userMessageKey: 'agents.scanner.unavailable',
      };
    }
    if (!isFresh(q.asOf, q.maxAgeMs, nowMs)) {
      return {
        status: 'refuse',
        tool,
        reason: 'stale',
        userMessageKey: 'agents.scanner.unavailable',
      };
    }
    return {
      status: 'ok',
      tool: 'trade.ticker',
      marketId: q.marketId,
      last: q.last,
      volume24h: q.volume24h,
      change24hBps: q.change24hBps,
      asOf: q.asOf,
    };
  }

  if (tool === 'trade.markets.list') {
    const markets = input.markets;
    if (!markets || markets.length === 0) {
      return {
        status: 'refuse',
        tool,
        reason: 'empty_markets',
        userMessageKey: 'agents.scanner.unavailable',
      };
    }
    for (const m of markets) {
      if (!m.marketId.trim() || !m.symbol.trim()) {
        return {
          status: 'refuse',
          tool,
          reason: 'missing_fixture',
          userMessageKey: 'agents.scanner.unavailable',
        };
      }
    }
    return {
      status: 'ok',
      tool: 'trade.markets.list',
      markets: markets.map((m) => ({
        marketId: m.marketId,
        symbol: m.symbol,
        status: m.status,
      })),
    };
  }

  // trade.book.top
  const book = input.bookTop;
  if (!book || !book.marketId.trim()) {
    return {
      status: 'refuse',
      tool,
      reason: 'missing_fixture',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }
  if (book.bid == null || book.ask == null) {
    return {
      status: 'refuse',
      tool,
      reason: 'incomplete_book',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }
  if (!parseUnsignedDecimal(book.bid) || !parseUnsignedDecimal(book.ask)) {
    return {
      status: 'refuse',
      tool,
      reason: 'invalid_decimal',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }
  if (!isFresh(book.asOf, book.maxAgeMs, nowMs)) {
    return {
      status: 'refuse',
      tool,
      reason: 'stale',
      userMessageKey: 'agents.scanner.unavailable',
    };
  }
  return {
    status: 'ok',
    tool: 'trade.book.top',
    marketId: book.marketId,
    bid: book.bid,
    ask: book.ask,
    asOf: book.asOf,
  };
}

/** True when data tool succeeded. */
export function isScannerDataToolOk(result: ScannerDataToolResult): result is ScannerDataToolOk {
  return result.status === 'ok';
}
