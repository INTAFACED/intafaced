// The Copy and Bots rooms' reads and writes. Every call here already exists in the service (VERIFIED against
// the local stack on 2026-10-17); the shapes mirror the legacy `features/trade/tool-api.ts`, which stays the owner of
// the calls both rooms share. Only fields the screen shows are kept, and no service sentence is ever kept
// (`residual` and `statusLine` are deliberately left out of the schema).
import { z } from 'zod';
import {
  LEADER_MODES,
  algoPolicySchema,
  botListRowSchema,
  botListSchema,
  copiedMarketSchema,
  copiedPositionSchema,
  copiedPositionsSchema,
  copyAckSchema,
  copyClosePositionSchema,
  copyDeskSchema,
  copyPositionSchema,
  copySkipLogSchema,
  copySkipSchema,
  followPositionsSchema,
  gridBotSchema,
  gridPresetsSchema,
  gridSetupSchema,
  gridTopUpFreeSchema,
  gridTopUpSchema,
  gridWithdrawalSchema,
  leadCopiersSchema,
  leadEarningsSchema,
  leadLevelSchema,
  leadMissionsSchema,
  leadTradeSchema,
  leadTradesSchema,
  leaderPageSchema,
  leaderProfileSchema,
  leaderRowSchema,
  leaderTradeSchema,
  leaderTradesSchema,
  myLeadSchema,
  mySignalsSchema,
  platformPausesSchema,
  providerSignalSchema,
  signalCriteriaSchema,
  signalEarningsSchema,
  signalPublishSchema,
  signalVettingSchema,
  signalWebhookSchema,
  studioListSchema,
  studioStrategySchema,
  venueFollowCheckSchemaOf,
} from '@intafaced/contracts/trade-copy-room';
import type { ApiClient } from '../../../shared/api';
import { algoSchema, copyFollowSchema, createToolApi } from '../../../features/trade/tool-api';

export {
  copyDeskSchema,
  signalWebhookSchema,
  providerSignalSchema,
  signalVettingSchema,
  signalCriteriaSchema,
  signalPublishSchema,
  mySignalsSchema,
  signalEarningsSchema,
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
  myLeadSchema,
  copySkipSchema,
} from '@intafaced/contracts/trade-copy-room';

export type CopyDesk = z.infer<typeof copyDeskSchema>;

export type SignalWebhook = z.infer<typeof signalWebhookSchema>;
export type ProviderSignal = z.infer<typeof providerSignalSchema>;
export type SignalVetting = z.infer<typeof signalVettingSchema>;
export type SignalEarnings = z.infer<typeof signalEarningsSchema>;
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

export type PlatformPauses = z.infer<typeof platformPausesSchema>;

export type AlgoPolicy = z.infer<typeof algoPolicySchema>;

export type BotListRow = z.infer<typeof botListRowSchema>;
/** Bots My bots reads at a time. The service refuses a list read without a limit, and lists at most 500 a read. */
export const BOT_LIST_PAGE = 50;
export const BOT_LIST_MAX = 500;

export type StudioStrategy = z.infer<typeof studioStrategySchema>;

export type LeaderMode = (typeof LEADER_MODES)[number];

export type LeaderRow = z.infer<typeof leaderRowSchema>;

export type LeaderProfile = z.infer<typeof leaderProfileSchema>;

export type LeaderTrade = z.infer<typeof leaderTradeSchema>;

export type CopyPosition = z.infer<typeof copyPositionSchema>;

export type GridBot = z.infer<typeof gridBotSchema>;
export type GridWithdrawal = z.infer<typeof gridWithdrawalSchema>;
export type GridTopUpRequest = { botId: string; requestId: string; asset: string; amount: string };
export type GridModifyRequest = { botId: string; trailing: boolean; shiftLimitPercent: string; minGridCount: number | null };
export type GridWithdrawRequest = {
  botId: string;
  requestId: string;
  asset: string;
  amount: string;
  stepUpApprovalId: string | null;
};
export type GridSetup = z.infer<typeof gridSetupSchema>;
export type GridRequest = {
  clientRequestId: string;
  symbol: string;
  /** Blank fields are sent as they are, so the service names the one that is missing. */
  lowerPrice: string;
  upperPrice: string;
  gridCount: number | null;
  investment: string;
};
export type CopiedPosition = z.infer<typeof copiedPositionSchema>;
export type CopiedMarket = z.infer<typeof copiedMarketSchema>;

export type LeadEarnings = z.infer<typeof leadEarningsSchema>;
export const LEAD_EARNINGS_PAGE = 50;

export type LeadLevel = z.infer<typeof leadLevelSchema>;

export type MyLead = z.infer<typeof myLeadSchema>;

export type LeadMissions = z.infer<typeof leadMissionsSchema>;

export type LeadTrade = z.infer<typeof leadTradeSchema>;

export type LeadTrades = z.infer<typeof leadTradesSchema>;

export type LeadCopier = z.infer<typeof leadCopiersSchema>[number];

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
export type VenueFollowCheck = z.infer<typeof venueFollowCheckSchema>;

export function createRoomApi(api: ApiClient) {
  const tools = createToolApi(api);
  return {
    copyDesk: (signal?: AbortSignal) => api.query('trade', 'copy.deskStatus', undefined, copyDeskSchema, { signal }),
    leaders: (query: { marketMode?: LeaderMode; q?: string; cursor?: string }, signal?: AbortSignal) =>
      api.query(
        'trade',
        'copy.listLeaders',
        {
          limit: LEADER_PAGE,
          ...(query.marketMode ? { marketMode: query.marketMode } : {}),
          ...(query.q?.trim() ? { q: query.q.trim() } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
        leaderPageSchema,
        { signal },
      ),
    /** A ranked category or the trending row. The service refuses every one; the room shows that refusal as it comes. */
    rankedLeaders: (ranking: { category: string } | { trending: true }) =>
      api.query('trade', 'copy.listLeaders', { limit: LEADER_PAGE, ...ranking }, leaderPageSchema),
    leaderProfile: (leaderRef: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.leaderProfile', { leaderRef }, leaderProfileSchema, { signal }),
    leaderTrades: (leaderRef: string, cursor: string | null, signal?: AbortSignal) =>
      api.query('trade', 'copy.leaderTrades', { leaderRef, limit: LEADER_TRADES_PAGE, ...(cursor ? { cursor } : {}) }, leaderTradesSchema, {
        signal,
      }),
    follows: tools.copyFollows,
    follow: (input: FollowRequest) => api.mutate('trade', 'copy.follow', input, copyFollowSchema),
    /** Start copying on the venue, checked: every gate and term, with nothing written (J-copy-bots-otc-01 #5 #7). */
    checkVenueFollow: (input: FollowRequest) => api.mutate('trade', 'copy.checkVenueFollow', input, venueFollowCheckSchema),
    /** A follow that copies onto one of the person's own open agent accounts (svc-trade venue-copy.ts). */
    venueFollow: (input: FollowRequest & { agentAccountId: string }) => api.mutate('trade', 'copy.follow', input, copyFollowSchema),
    followAction: tools.copyAction,
    /** Edit limits: the sizing mode is locked (a change is refused), a blank cap clears it. */
    amendFollow: (input: AmendFollowRequest) => api.mutate('trade', 'copy.amendFollow', input, copyFollowSchema),
    /** Lets the service place each copy as this person. The one-time key it answers with is never kept. */
    grantCopying: (followId: string) => api.mutate('trade', 'copy.grantSessionKey', { followId }, copyFollowSchema),
    stopCopying: (followId: string) => api.mutate('trade', 'copy.killSessionKey', { followId }, copyFollowSchema),
    followPositions: (followId: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.followPositions', { followId }, followPositionsSchema, { signal }),
    /** Stop is close-only: new trades are fenced, the leader's closes still close what was copied (CB-copy-09). */
    stop: (followId: string) => api.mutate('trade', 'copy.stop', { followId, closeOnly: true }, copyAckSchema.passthrough()),
    copiedPositions: (followId: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.copiedPositions', { followId }, copiedPositionsSchema, { signal }),
    /** Closes one copied position, whole or by an amount. The service runs one close per position and amount. */
    closePosition: (followId: string, positionId: string, qty?: string) =>
      api.mutate(
        'trade',
        'copy.closeCopiedPosition',
        { followId, positionId, ...(qty ? { qty } : {}) },
        copyClosePositionSchema.passthrough(),
      ),
    skipLog: (followId: string, signal?: AbortSignal) => api.query('trade', 'copy.skipLog', { followId }, copySkipLogSchema, { signal }),
    /** Close-all needs identity's step-up for exactly this follow and request (`trade.step_up.copy.flatten`). */
    flatten: (input: { followId: string; requestId: string; stepUpApprovalId: string | null }) =>
      api.mutate('trade', 'copy.flatten', input, copyAckSchema.passthrough()),
    algoPolicy: (signal?: AbortSignal) => api.query('trade', 'algo.policy', undefined, algoPolicySchema, { signal }),
    webhooks: (signal?: AbortSignal) => api.query('trade', 'signals.webhooks.list', undefined, z.array(signalWebhookSchema), { signal }),
    createWebhook: (input: { symbol: string; venueOwner: string; clientRequestId: string }) =>
      api.mutate('trade', 'signals.webhooks.create', input, signalWebhookSchema),
    signalCriteria: (signal?: AbortSignal) => api.query('market', 'signals.criteria', undefined, signalCriteriaSchema, { signal }),
    publishSignal: (input: SignalPublishRequest) => api.mutate('market', 'signals.publish', input, signalPublishSchema),
    archiveSignal: (signalId: string) => api.mutate('market', 'signals.archive', { signalId }, providerSignalSchema),
    mySignals: (signal?: AbortSignal) => api.query('market', 'signals.mine', { limit: SIGNAL_PAGE }, mySignalsSchema, { signal }),
    signalList: (signal?: AbortSignal) =>
      api.query('market', 'signals.list', { limit: SIGNAL_PAGE }, z.array(providerSignalSchema), { signal }),
    signalEarnings: (window: { from: string; to: string }, signal?: AbortSignal) =>
      api.query('market', 'signals.earnings', window, signalEarningsSchema, { signal }),
    leadEarnings: (signal?: AbortSignal) =>
      api.query('trade', 'copy.leadEarnings', { limit: LEAD_EARNINGS_PAGE }, leadEarningsSchema, { signal }),
    leadLevel: (signal?: AbortSignal) => api.query('trade', 'copy.leadLevel', undefined, leadLevelSchema, { signal }),
    myLead: (signal?: AbortSignal) => api.query('trade', 'copy.myLead', undefined, myLeadSchema, { signal }),
    leadMissions: (signal?: AbortSignal) => api.query('trade', 'copy.leadMissions', undefined, leadMissionsSchema, { signal }),
    leadTrades: (signal?: AbortSignal) => api.query('trade', 'copy.leadTrades', undefined, leadTradesSchema, { signal }),
    leadCopiers: (signal?: AbortSignal) => api.query('trade', 'copy.leadCopiers', undefined, leadCopiersSchema, { signal }),
    /** Always refused `trade.copy_pnl_fee_forbidden`: a profit share is never offered. */
    setProfitShare: (percent: string) => api.mutate('trade', 'copy.setProfitShare', { percent }, z.unknown()),
    /** Always refused `trade.copy_pnl_fee_forbidden`: the platform sets no maximum ratio. */
    setMaxRatio: (ratio: string) => api.mutate('trade', 'copy.setMaxRatio', { ratio }, z.unknown()),
    platformPauses: (signal?: AbortSignal) => api.query('trade', 'copy.platformPauses', undefined, platformPausesSchema, { signal }),
    createTwap: (input: TwapRequest) => api.mutate('trade', 'algo.createTwap', input, algoSchema),
    algoList: (limit: number, signal?: AbortSignal) => api.query('trade', 'algo.list', { limit }, botListSchema, { signal }),
    algoGet: tools.algoGet,
    algoProgress: tools.algoProgress,
    algoAction: tools.algoAction,
    gridSetup: (signal?: AbortSignal) => api.query('trade', 'bots.grid.setup', undefined, gridSetupSchema, { signal }),
    gridPresets: (signal?: AbortSignal) => api.query('trade', 'bots.grid.presets', undefined, gridPresetsSchema, { signal }),
    gridCreate: (input: GridRequest) => api.mutate('trade', 'bots.grid.create', input, gridBotSchema),
    gridGet: (botId: string, signal?: AbortSignal) => api.query('trade', 'bots.grid.get', { botId }, gridBotSchema, { signal }),
    gridList: (signal?: AbortSignal) => api.query('trade', 'bots.grid.list', undefined, z.array(gridBotSchema), { signal }),
    gridStop: (botId: string) => api.mutate('trade', 'bots.grid.stop', { botId }, gridBotSchema),
    gridTopUpFree: (botId: string, signal?: AbortSignal) =>
      api.query('trade', 'bots.grid.topUpFree', { botId }, gridTopUpFreeSchema, { signal }),
    gridTopUp: (input: GridTopUpRequest) => api.mutate('trade', 'bots.grid.topUp', input, gridTopUpSchema),
    gridModify: (input: GridModifyRequest) => api.mutate('trade', 'bots.grid.modify', input, gridBotSchema),
    gridWithdraw: (input: GridWithdrawRequest) => api.mutate('trade', 'bots.grid.withdrawProfit', input, gridWithdrawalSchema),
    studio: (signal?: AbortSignal) => api.query('quant', 'studio.list', { limit: 50 }, studioListSchema, { signal }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
