// The Copy and Bots rooms' reads and writes. Every call here already exists in the service (VERIFIED against
// the local stack on 2026-10-17); the shapes mirror the legacy `features/trade/tool-api.ts`, which stays the owner of
// the calls both rooms share. Only fields the screen shows are kept, and no service sentence is ever kept
// (`residual` and `statusLine` are deliberately left out of the schema).
import { QUANT_STUDIO_LIST } from '@intafaced/contracts/quant-studio-procedures';
import { GRID_SET_EXITS, GRID_SET_IDLE_YIELD, GRID_SUBMIT_PERMISSION } from '@intafaced/contracts/trade-grid-procedures';
import {
  RECURRING_CREATE,
  RECURRING_GET,
  RECURRING_LIST,
  RECURRING_SUBMIT_PERMISSION,
  RECURRING_TERMINATE,
  RECURRING_UPDATE,
} from '@intafaced/contracts/trade-recurring-procedures';
import {
  MARKET_SIGNALS_ARCHIVE,
  MARKET_SIGNALS_CRITERIA,
  MARKET_SIGNALS_EARNINGS,
  MARKET_SIGNALS_LIST,
  MARKET_SIGNALS_MINE,
  MARKET_SIGNALS_PUBLISH,
  type MarketSignal,
  type MarketSignalVetting,
} from '@intafaced/contracts/market-procedures';
import { z } from 'zod';
import {
  LEADER_MODES,
  botListRowSchema,
  copiedMarketSchema,
  copiedPositionSchema,
  copyDeskSchema,
  copyPositionSchema,
  copySkipSchema,
  gridBotSchema,
  leadTradeSchema,
  leaderProfileSchema,
  leaderRowSchema,
  leaderTradeSchema,
  myLeadSchema,
  signalWebhookSchema,
  studioListSchema,
  studioStrategySchema,
  venueFollowCheckSchemaOf,
} from '@intafaced/contracts/trade-copy-room';
import { parsesAs, type ApiClient } from '../../../shared/api';
import { copyFollowSchema, createToolApi } from '../../../features/trade/tool-api';
import {
  TRADE_COPY_MY_LEAD,
  TRADE_COPY_LEADER_TRADES,
  TRADE_COPY_FOLLOW,
  TRADE_COPY_CHECK_VENUE_FOLLOW,
  TRADE_COPY_AMEND_FOLLOW,
  TRADE_COPY_GRANT_SESSION_KEY,
  TRADE_COPY_KILL_SESSION_KEY,
  TRADE_COPY_CLOSE_COPIED_POSITION,
  TRADE_COPY_SKIP_LOG,
  TRADE_COPY_LEAD_EARNINGS,
  TRADE_COPY_LEAD_LEVEL,
  TRADE_COPY_LEAD_MISSIONS,
  TRADE_COPY_LEAD_TRADES,
  TRADE_COPY_LEAD_COPIERS,
  TRADE_COPY_PLATFORM_PAUSES,
  TRADE_COPY_DESK_STATUS,
  TRADE_COPY_STOP,
  TRADE_COPY_LIST_LEADERS,
  TRADE_COPY_LEADER_PROFILE,
  TRADE_COPY_FOLLOW_POSITIONS,
  TRADE_COPY_COPIED_POSITIONS,
  TRADE_COPY_FLATTEN,
} from '@intafaced/contracts/trade-copy-records';
import { TRADE_SIGNALS_WEBHOOKS_CREATE, TRADE_SIGNALS_WEBHOOKS_LIST } from '@intafaced/contracts/trade-signals-procedures';
import {
  TRADE_BOTS_GRID_SETUP,
  TRADE_BOTS_GRID_PRESETS,
  TRADE_BOTS_GRID_STOP,
  TRADE_BOTS_GRID_TOP_UP_FREE,
  TRADE_BOTS_GRID_TOP_UP,
  TRADE_BOTS_GRID_MODIFY,
  TRADE_BOTS_GRID_WITHDRAW_PROFIT,
  TRADE_BOTS_GRID_CREATE,
  TRADE_BOTS_GRID_GET,
  TRADE_BOTS_GRID_LIST,
} from '@intafaced/contracts/trade-bots-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';
import { TRADE_ALGO_POLICY, TRADE_ALGO_CREATE_TWAP, TRADE_ALGO_LIST } from '@intafaced/contracts/trade-algo-procedures';

export {
  copyDeskSchema,
  signalWebhookSchema,
  platformPausesSchema,
  algoPolicySchema,
  botListRowSchema,
  studioStrategySchema,
  LEADER_MODES,
  leaderRowSchema,
  leaderProfileSchema,
  leaderTradeSchema,
  copyPositionSchema,
  gridBotSchema,
  gridWithdrawalSchema,
  gridTopUpSchema,
  gridSetupSchema,
  copiedPositionSchema,
  copiedMarketSchema,
  leadEarningsSchema,
  leadLevelSchema,
  copySkipSchema,
} from '@intafaced/contracts/trade-copy-room';

export type CopyDesk = ProcedureOutput<typeof TRADE_COPY_DESK_STATUS>;

export type SignalWebhook = z.infer<typeof signalWebhookSchema>;
export type ProviderSignal = MarketSignal;
export type SignalVetting = MarketSignalVetting;
export type SignalEarnings = z.output<typeof MARKET_SIGNALS_EARNINGS.output>;
export type SignalPublishRequest = {
  publishKey: string;
  title: string;
  description: string;
  assetId: string;
  recommendedAmount: string | null;
  feeModel: 'free' | 'monthly' | 'profit_share' | 'recurring';
  price: string | null;
  periodSeconds: number | null;
};
/** Signals a list read asks for at a time; the service refuses a read without a limit and lists at most 50. */
export const SIGNAL_PAGE = 50;

export type PlatformPauses = ProcedureOutput<typeof TRADE_COPY_PLATFORM_PAUSES>;

export type AlgoPolicy = ProcedureOutput<typeof TRADE_ALGO_POLICY>;

export type BotListRow = z.infer<typeof botListRowSchema>;
/** Bots My bots reads at a time. The service refuses a list read without a limit, and lists at most 500 a read. */
export const BOT_LIST_PAGE = 50;
export const BOT_LIST_MAX = 500;

export type StudioStrategy = z.infer<typeof studioStrategySchema>;

export type LeaderMode = (typeof LEADER_MODES)[number];

export type LeaderRow = z.infer<typeof leaderRowSchema>;

export type LeaderProfile = ProcedureOutput<typeof TRADE_COPY_LEADER_PROFILE>;

export type LeaderTrade = z.infer<typeof leaderTradeSchema>;

export type CopyPosition = z.infer<typeof copyPositionSchema>;

export type GridBot = z.infer<typeof gridBotSchema>;
export type GridWithdrawal = ProcedureOutput<typeof TRADE_BOTS_GRID_WITHDRAW_PROFIT>;
export type GridTopUpRequest = { botId: string; requestId: string; asset: string; amount: string };
export type GridModifyRequest = { botId: string; trailing: boolean; shiftLimitPercent: string; minGridCount: number | null };
/** A grid's exits: blank prices clear an exit, and an RSI value is sent as typed so the service names its refusal. */
export type GridExitsRequest = { botId: string; stopBelow: string; stopAbove: string; rsiBelow?: string };
export type GridWithdrawRequest = {
  botId: string;
  requestId: string;
  asset: string;
  amount: string;
  stepUpApprovalId: string | null;
};
export type GridSetup = ProcedureOutput<typeof TRADE_BOTS_GRID_SETUP>;
export type GridRequest = {
  clientRequestId: string;
  symbol: string;
  /** Blank fields are sent as they are, so the service names the one that is missing. */
  lowerPrice: string;
  upperPrice: string;
  gridCount: number | null;
  investment: string;
  /** The person's own venue account the grid trades on, while the venue door is on. */
  owner?: string;
};
export type CopiedPosition = z.infer<typeof copiedPositionSchema>;
export type CopiedMarket = z.infer<typeof copiedMarketSchema>;

export type LeadEarnings = ProcedureOutput<typeof TRADE_COPY_LEAD_EARNINGS>;
export const LEAD_EARNINGS_PAGE = 50;

export type LeadLevel = ProcedureOutput<typeof TRADE_COPY_LEAD_LEVEL>;

export type MyLead = z.infer<typeof myLeadSchema>;

export type LeadMissions = ProcedureOutput<typeof TRADE_COPY_LEAD_MISSIONS>;

export type LeadTrade = z.infer<typeof leadTradeSchema>;

export type LeadTrades = ProcedureOutput<typeof TRADE_COPY_LEAD_TRADES>;

export type LeadCopier = ProcedureOutput<typeof TRADE_COPY_LEAD_COPIERS>[number];

export type CopySkip = z.infer<typeof copySkipSchema>;

/** Leaders per directory page and trades per lead page. The service refuses a read without one. */
export const LEADER_PAGE = 50;
export const LEADER_TRADES_PAGE = 20;

export type FollowRequest = {
  leaderId?: string;
  leaderRef?: string;
  region: string;
  permittedMarkets: string[];
  maxNotionalPerOrder: string;
  maxAggregateExposure: string;
  maxLoss?: string;
  /** Quote amount each copied order uses. Left out means no fixed size. */
  fixedOrderSize?: string;
  /** How each copy is sized. Locked once the follow is made. */
  sizingMode?: 'fixed_amount' | 'smart_sync';
  expiresAt: string;
  /** This Start copying request's own key: pressing again returns the same follow. */
  clientRequestId: string;
};
export type AmendFollowRequest = {
  followId: string;
  sizingMode?: 'fixed_amount' | 'smart_sync' | 'multiplier';
  maxPerMarket?: string;
  maxPerDay?: string;
};
export type TwapRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  totalQty: string;
  durationMs: number;
  sliceIntervalMs: number;
  limitPrice?: string;
  clientAlgoId: string;
  kind: 'twap' | 'vwap' | 'pov';
  participationBps?: number;
};

export const venueFollowCheckSchema = venueFollowCheckSchemaOf(copyFollowSchema);
export type VenueFollowCheck = ProcedureOutput<typeof TRADE_COPY_CHECK_VENUE_FOLLOW>;

export function createRoomApi(api: ApiClient) {
  const tools = createToolApi(api);
  return {
    copyDesk: (signal?: AbortSignal) => api.call(TRADE_COPY_DESK_STATUS, undefined, { signal }),
    leaders: (query: { marketMode?: LeaderMode; q?: string; cursor?: string }, signal?: AbortSignal) =>
      api.call(
        TRADE_COPY_LIST_LEADERS,
        {
          limit: LEADER_PAGE,
          ...(query.marketMode ? { marketMode: query.marketMode } : {}),
          ...(query.q?.trim() ? { q: query.q.trim() } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
        { signal },
      ),
    /** A ranked category or the trending row. The service refuses every one; the room shows that refusal as it comes. */
    rankedLeaders: (ranking: { category: string } | { trending: true }) =>
      api.call(TRADE_COPY_LIST_LEADERS, { limit: LEADER_PAGE, ...ranking }),
    leaderProfile: (leaderRef: string, signal?: AbortSignal) => api.call(TRADE_COPY_LEADER_PROFILE, { leaderRef }, { signal }),
    leaderTrades: (leaderRef: string, cursor: string | null, signal?: AbortSignal) =>
      api.call(
        TRADE_COPY_LEADER_TRADES,
        { leaderRef, limit: LEADER_TRADES_PAGE, ...(cursor ? { cursor } : {}) },
        {
          signal,
        },
      ),
    follows: tools.copyFollows,
    follow: (input: FollowRequest) => api.call(TRADE_COPY_FOLLOW, input),
    /** Start copying on the venue, checked: every gate and term, with nothing written (J-copy-bots-otc-01 #5 #7). */
    checkVenueFollow: (input: FollowRequest) => api.call(TRADE_COPY_CHECK_VENUE_FOLLOW, input),
    /** A follow that copies onto one of the person's own open agent accounts (svc-trade venue-copy.ts). */
    venueFollow: (input: FollowRequest & { agentAccountId: string }) => api.call(TRADE_COPY_FOLLOW, input),
    followAction: tools.copyAction,
    /** Edit limits: the sizing mode is locked (a change is refused), a blank cap clears it. */
    amendFollow: (input: AmendFollowRequest) => api.call(TRADE_COPY_AMEND_FOLLOW, input),
    /** Lets the service place each copy as this person. The one-time key it answers with is never kept. */
    grantCopying: (followId: string) => api.call(TRADE_COPY_GRANT_SESSION_KEY, { followId }),
    stopCopying: (followId: string) => api.call(TRADE_COPY_KILL_SESSION_KEY, { followId }),
    followPositions: (followId: string, signal?: AbortSignal) => api.call(TRADE_COPY_FOLLOW_POSITIONS, { followId }, { signal }),
    /** Stop is close-only: new trades are fenced, the leader's closes still close what was copied (CB-copy-09). */
    stop: (followId: string) => api.call(TRADE_COPY_STOP, { followId, closeOnly: true }),
    copiedPositions: (followId: string, signal?: AbortSignal) => api.call(TRADE_COPY_COPIED_POSITIONS, { followId }, { signal }),
    /** Closes one copied position, whole or by an amount. The service runs one close per position and amount. */
    closePosition: (followId: string, positionId: string, qty?: string) =>
      api.call(TRADE_COPY_CLOSE_COPIED_POSITION, { followId, positionId, ...(qty ? { qty } : {}) }),
    skipLog: (followId: string, signal?: AbortSignal) => api.call(TRADE_COPY_SKIP_LOG, { followId }, { signal }),
    /** Close-all needs identity's step-up for exactly this follow and request (`trade.step_up.copy.flatten`). */
    flatten: (input: { followId: string; requestId: string; stepUpApprovalId: string | null }) => api.call(TRADE_COPY_FLATTEN, input),
    algoPolicy: (signal?: AbortSignal) => api.call(TRADE_ALGO_POLICY, undefined, { signal }),
    webhooks: (signal?: AbortSignal) => api.call(TRADE_SIGNALS_WEBHOOKS_LIST, undefined, { signal }),
    createWebhook: (input: { symbol: string; venueOwner: string; clientRequestId: string }) =>
      api.call(TRADE_SIGNALS_WEBHOOKS_CREATE, input),
    signalCriteria: (signal?: AbortSignal) => api.call(MARKET_SIGNALS_CRITERIA, undefined, { signal }),
    publishSignal: (input: SignalPublishRequest) => api.call(MARKET_SIGNALS_PUBLISH, input),
    archiveSignal: (signalId: string) => api.call(MARKET_SIGNALS_ARCHIVE, { signalId }),
    mySignals: (signal?: AbortSignal) => api.call(MARKET_SIGNALS_MINE, { limit: SIGNAL_PAGE }, { signal }),
    signalList: (signal?: AbortSignal) => api.call(MARKET_SIGNALS_LIST, { limit: SIGNAL_PAGE }, { signal }),
    signalEarnings: (window: { from: string; to: string }, signal?: AbortSignal) => api.call(MARKET_SIGNALS_EARNINGS, window, { signal }),
    leadEarnings: (signal?: AbortSignal) => api.call(TRADE_COPY_LEAD_EARNINGS, { limit: LEAD_EARNINGS_PAGE }, { signal }),
    leadLevel: (signal?: AbortSignal) => api.call(TRADE_COPY_LEAD_LEVEL, undefined, { signal }),
    myLead: (signal?: AbortSignal) => api.call(TRADE_COPY_MY_LEAD, undefined, { signal }),
    leadMissions: (signal?: AbortSignal) => api.call(TRADE_COPY_LEAD_MISSIONS, undefined, { signal }),
    leadTrades: (signal?: AbortSignal) => api.call(TRADE_COPY_LEAD_TRADES, undefined, { signal }),
    leadCopiers: (signal?: AbortSignal) => api.call(TRADE_COPY_LEAD_COPIERS, undefined, { signal }),
    /** Always refused `trade.copy_pnl_fee_forbidden`: a profit share is never offered. */
    setProfitShare: (percent: string) => api.mutate('trade', 'copy.setProfitShare', { percent }, z.unknown()),
    /** Always refused `trade.copy_pnl_fee_forbidden`: the platform sets no maximum ratio. */
    setMaxRatio: (ratio: string) => api.mutate('trade', 'copy.setMaxRatio', { ratio }, z.unknown()),
    platformPauses: (signal?: AbortSignal) => api.call(TRADE_COPY_PLATFORM_PAUSES, undefined, { signal }),
    createTwap: (input: TwapRequest) => api.call(TRADE_ALGO_CREATE_TWAP, input),
    algoList: (limit: number, signal?: AbortSignal) => api.call(TRADE_ALGO_LIST, { limit }, { signal }),
    algoGet: tools.algoGet,
    algoProgress: tools.algoProgress,
    algoAction: tools.algoAction,
    gridSetup: (signal?: AbortSignal) => api.call(TRADE_BOTS_GRID_SETUP, undefined, { signal }),
    gridPresets: (signal?: AbortSignal) => api.call(TRADE_BOTS_GRID_PRESETS, undefined, { signal }),
    gridCreate: (input: GridRequest) => api.call(TRADE_BOTS_GRID_CREATE, input),
    gridGet: (botId: string, signal?: AbortSignal) => api.call(TRADE_BOTS_GRID_GET, { botId }, { signal }),
    gridList: (signal?: AbortSignal) => api.call(TRADE_BOTS_GRID_LIST, undefined, { signal }),
    gridStop: (botId: string) => api.call(TRADE_BOTS_GRID_STOP, { botId }),
    gridSubmitPermission: (input: {
      botId: string;
      actionKey: string;
      signature: { digest: string; signature: string; signedBy: string };
    }) => api.call(GRID_SUBMIT_PERMISSION, input),
    gridTopUpFree: (botId: string, signal?: AbortSignal) => api.call(TRADE_BOTS_GRID_TOP_UP_FREE, { botId }, { signal }),
    gridTopUp: (input: GridTopUpRequest) => api.call(TRADE_BOTS_GRID_TOP_UP, input),
    gridModify: (input: GridModifyRequest) => api.call(TRADE_BOTS_GRID_MODIFY, input),
    gridSetExits: (input: GridExitsRequest) => api.call(GRID_SET_EXITS, input),
    gridSetIdleYield: (input: { botId: string; on: boolean }) => api.call(GRID_SET_IDLE_YIELD, input),
    gridWithdraw: (input: GridWithdrawRequest) => api.call(TRADE_BOTS_GRID_WITHDRAW_PROFIT, input),
    // The recurring buy of a basket on the person's own venue account (J-copy-bots-otc-16).
    recurringCreate: (input: z.input<typeof RECURRING_CREATE.input>) => api.call(RECURRING_CREATE, input),
    recurringSubmitPermission: (input: z.input<typeof RECURRING_SUBMIT_PERMISSION.input>) => api.call(RECURRING_SUBMIT_PERMISSION, input),
    recurringGet: (ruleId: string, signal?: AbortSignal) => api.call(RECURRING_GET, { ruleId }, { signal }),
    recurringList: (signal?: AbortSignal) => api.call(RECURRING_LIST, {}, { signal }),
    recurringUpdate: (input: z.input<typeof RECURRING_UPDATE.input>) => api.call(RECURRING_UPDATE, input),
    recurringTerminate: (ruleId: string) => api.call(RECURRING_TERMINATE, { ruleId }),
    // The room shows only strategies whose amounts read as unsigned amounts; a page with any other reads as unverified.
    studio: (signal?: AbortSignal) => api.call(QUANT_STUDIO_LIST, { limit: 50 }, { signal, accept: parsesAs(studioListSchema) }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
