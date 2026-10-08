/**
 * Navigator Stage-2 — real data tools with typed refusals.
 *
 * Spec: docs/ops/trk/agents.navigator.md Stage 2.
 *
 * Caller supplies fixture rows (same honesty class as scanner.rankFixtures).
 * Never invents mids, market lists, or session fields. Dark plane / incomplete /
 * stale / undeclared / money-write → typed refuse. Agents never ledger.post.
 */

import { isNegative, MoneyError, parseAmount } from '@intafaced/ledger-client';
import { isNavigatorMoneyWriteTool, navigatorAgentGuardrail } from './guardrail.js';
import { navigatorGrounded, type TradeDataPlane } from './grounded.js';
import { navigatorTierGate, type NavigatorTierLaw, type TierGateRefuse } from './tier-gate.js';

export const NAVIGATOR_DATA_TOOLS = ['trade.quote', 'trade.markets.list', 'identity.session.read'] as const;
export type NavigatorDataToolName = (typeof NAVIGATOR_DATA_TOOLS)[number];

export type QuoteFixture = {
  readonly marketId: string;
  /** Last / mid as decimal string. null = no quote — refuse, never invent. */
  readonly last: string | null;
  readonly asOf: string;
  readonly maxAgeMs: number;
};

export type MarketListFixture = {
  readonly marketId: string;
  readonly symbol: string;
  readonly status: 'open' | 'halted' | 'closed';
};

export type SessionFixture = {
  readonly sessionId: string;
  readonly userId: string;
  readonly status: 'open' | 'closed';
};

export type DataToolOk =
  | {
      readonly status: 'ok';
      readonly tool: 'trade.quote';
      readonly marketId: string;
      /** Echo of caller fixture last — never invented. */
      readonly last: string;
      readonly asOf: string;
    }
  | {
      readonly status: 'ok';
      readonly tool: 'trade.markets.list';
      readonly markets: readonly MarketListFixture[];
    }
  | {
      readonly status: 'ok';
      readonly tool: 'identity.session.read';
      readonly session: SessionFixture;
    };

export type DataToolRefuseReason =
  | 'trade_plane_dark'
  | 'tier_law_blank'
  | 'tier_not_granted'
  | 'tool_not_declared'
  | 'money_write'
  | 'tool_not_in_tier'
  | 'missing_fixture'
  | 'incomplete_quote'
  | 'invalid_decimal'
  | 'stale'
  | 'empty_markets'
  | 'markets_limit_unset'
  | 'incomplete_session'
  | 'no_live_session'
  | 'subject_mismatch';

export type DataToolRefuse = {
  readonly status: 'refuse';
  readonly tool: string;
  readonly reason: DataToolRefuseReason;
  readonly userMessageKey: 'agents.navigator.unavailable' | 'agents.navigator.tier_closed' | 'agents.navigator.markets_limit_unset';
};

export type DataToolResult = DataToolOk | DataToolRefuse;

function parseUnsignedDecimal(s: string): boolean {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return false;
  try {
    const amount = parseAmount(s);
    if (isNegative(amount)) return false;
    return true;
  } catch (err) {
    if (err instanceof MoneyError) return false;
    throw err;
  }
}

function isFresh(asOf: string, maxAgeMs: number, nowMs: number): boolean {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs && nowMs - t >= 0;
}

function isDeclaredDataTool(tool: string): tool is NavigatorDataToolName {
  return (NAVIGATOR_DATA_TOOLS as readonly string[]).includes(tool);
}

function tierRefuseToData(tool: string, refuse: TierGateRefuse): DataToolRefuse {
  return {
    status: 'refuse',
    tool,
    reason: refuse.reason,
    userMessageKey: refuse.userMessageKey,
  };
}

/**
 * Invoke one Stage-1-declared read data tool against caller fixtures.
 * Composes plane gate + tier gate + allowlist honesty.
 */
export function invokeNavigatorDataTool(input: {
  tool: string;
  plane: TradeDataPlane;
  /** Product-law tier matrix. Blank → refuse-closed (no invent). */
  tierLaw?: NavigatorTierLaw | null;
  userTier?: string;
  /** Authenticated caller. Required before returning identity-scoped data. */
  requesterUserId?: string;
  now?: Date;
  quote?: QuoteFixture | null;
  markets?: readonly MarketListFixture[] | null;
  session?: SessionFixture | null;
}): DataToolResult {
  const tool = input.tool.trim();

  if (isNavigatorMoneyWriteTool(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'money_write',
      userMessageKey: 'agents.navigator.unavailable',
    };
  }

  const grounded = navigatorGrounded(input.plane);
  if (grounded.status === 'refuse') {
    return {
      status: 'refuse',
      tool,
      reason: 'trade_plane_dark',
      userMessageKey: grounded.userMessageKey,
    };
  }

  const tier = navigatorTierGate({
    law: input.tierLaw,
    userTier: input.userTier ?? '',
  });
  if (tier.status === 'refuse') {
    return tierRefuseToData(tool, tier);
  }

  const declared = new Set(navigatorAgentGuardrail().tools.map((t) => t.name));
  if (!declared.has(tool) || !isDeclaredDataTool(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'tool_not_declared',
      userMessageKey: 'agents.navigator.unavailable',
    };
  }

  if (!tier.allowedTools.includes(tool)) {
    return {
      status: 'refuse',
      tool,
      reason: 'tool_not_in_tier',
      userMessageKey: 'agents.navigator.tier_closed',
    };
  }

  const nowMs = (input.now ?? new Date()).getTime();

  if (tool === 'trade.quote') {
    const q = input.quote;
    if (!q || !q.marketId.trim()) {
      return {
        status: 'refuse',
        tool,
        reason: 'missing_fixture',
        userMessageKey: 'agents.navigator.unavailable',
      };
    }
    if (q.last == null) {
      return {
        status: 'refuse',
        tool,
        reason: 'incomplete_quote',
        userMessageKey: 'agents.navigator.unavailable',
      };
    }
    if (!parseUnsignedDecimal(q.last)) {
      return {
        status: 'refuse',
        tool,
        reason: 'invalid_decimal',
        userMessageKey: 'agents.navigator.unavailable',
      };
    }
    if (!isFresh(q.asOf, q.maxAgeMs, nowMs)) {
      return {
        status: 'refuse',
        tool,
        reason: 'stale',
        userMessageKey: 'agents.navigator.unavailable',
      };
    }
    return {
      status: 'ok',
      tool: 'trade.quote',
      marketId: q.marketId,
      last: q.last,
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
        userMessageKey: 'agents.navigator.unavailable',
      };
    }
    for (const m of markets) {
      if (!m.marketId.trim() || !m.symbol.trim()) {
        return {
          status: 'refuse',
          tool,
          reason: 'missing_fixture',
          userMessageKey: 'agents.navigator.unavailable',
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

  // identity.session.read — live overlay discards caller fixtures on miss by
  // passing null. That is `no_live_session`, not an invented open session.
  const session = input.session;
  if (!session) {
    return {
      status: 'refuse',
      tool,
      reason: 'no_live_session',
      userMessageKey: 'agents.navigator.unavailable',
    };
  }
  if (!session.sessionId.trim() || !session.userId.trim()) {
    return {
      status: 'refuse',
      tool,
      reason: 'incomplete_session',
      userMessageKey: 'agents.navigator.unavailable',
    };
  }
  if (!input.requesterUserId?.trim() || session.userId !== input.requesterUserId) {
    return {
      status: 'refuse',
      tool,
      reason: 'subject_mismatch',
      userMessageKey: 'agents.navigator.unavailable',
    };
  }
  return {
    status: 'ok',
    tool: 'identity.session.read',
    session: {
      sessionId: session.sessionId,
      userId: session.userId,
      status: session.status,
    },
  };
}

/** True when data tool succeeded. */
export function isNavigatorDataToolOk(result: DataToolResult): result is DataToolOk {
  return result.status === 'ok';
}
