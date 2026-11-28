import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  applyToLeadAnswer,
  copyCheckVenueFollowAnswer,
  copyCloseCopiedPositionAnswer,
  copyFollowAnswer,
  copyFollowInput,
  copyGrantSessionKeyAnswer,
  copyLeaderTradesAnswer,
  copySkipLogAnswer,
  decimal,
  leadCopiersAnswer,
  leadEarningsAnswer,
  leadEligibilityAnswer,
  leadLevelAnswer,
  leadMissionsAnswer,
  leadTradesAnswer,
  myLeadAnswer,
  myLeadApplicationAnswer,
  platformPausesAnswer,
  copyDeskStatusOutput,
  copyListMyFollowsAnswer,
  copyPauseOutput,
  copyStopOutput,
  copyDetachOutput,
  copyResumeOutput,
  copyListLeadersAnswer,
  copyLeaderProfileAnswer,
  copyFollowPositionsAnswer,
  copyCopiedPositionsAnswer,
  copyFlattenOutput,
} from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `copy.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

/** The caller's newest lead application, or null. */
export const TRADE_COPY_MY_LEAD_APPLICATION = defineProcedure({
  ...base,
  name: 'trade.copy.myLeadApplication',
  kind: 'query',
  path: 'copy.myLeadApplication',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: myLeadApplicationAnswer,
  samples: [{ verdict: 'accept' }],
});

/** What applying to lead is measured by for the caller: whom they follow, the threshold and their venue USDC. */
export const TRADE_COPY_LEAD_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'trade.copy.leadEligibility',
  kind: 'query',
  path: 'copy.leadEligibility',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: leadEligibilityAnswer,
  samples: [{ verdict: 'accept' }],
});

/** Apply to lead (CB-copy-12). One open application per person; the same submit again answers it. */
export const TRADE_COPY_APPLY_TO_LEAD = defineProcedure({
  ...base,
  name: 'trade.copy.applyToLead',
  kind: 'mutation',
  path: 'copy.applyToLead',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ displayName: z.string().max(200) }),
  output: applyToLeadAnswer,
  samples: [
    { verdict: 'accept', input: { displayName: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's lead account once approved, or null (CB-copy-18, J-copy-bots-otc-04 #4). */
export const TRADE_COPY_MY_LEAD = defineProcedure({
  ...base,
  name: 'trade.copy.myLead',
  kind: 'query',
  path: 'copy.myLead',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: myLeadAnswer,
  samples: [{ verdict: 'accept' }],
});

/** One listed leader's own spot trades, newest first. Limit is required. */
export const TRADE_COPY_LEADER_TRADES = defineProcedure({
  ...base,
  name: 'trade.copy.leaderTrades',
  kind: 'query',
  path: 'copy.leaderTrades',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({
    leaderRef: z.string().min(1).max(80),
    limit: z.number().optional(),
    cursor: z.string().max(64).optional(),
  }),
  output: copyLeaderTradesAnswer,
  samples: [
    { verdict: 'accept', input: { leaderRef: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_FOLLOW = defineProcedure({
  ...base,
  name: 'trade.copy.follow',
  kind: 'mutation',
  path: 'copy.follow',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: copyFollowInput,
  output: copyFollowAnswer,
  samples: [
    {
      verdict: 'accept',
      input: {
        region: 'USDC',
        permittedMarkets: ['USDC'],
        maxNotionalPerOrder: '1',
        maxAggregateExposure: '1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        clientRequestId: 'ethereum',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Start copying on the venue, checked and not written (J-copy-bots-otc-01 #5 #7): the wizard asks this before the
 * follower's wallet opens an agent account for the follow, so a refused gate or term writes and signs nothing.
 */
export const TRADE_COPY_CHECK_VENUE_FOLLOW = defineProcedure({
  ...base,
  name: 'trade.copy.checkVenueFollow',
  kind: 'mutation',
  path: 'copy.checkVenueFollow',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: copyFollowInput.omit({ agentAccountId: true }),
  output: copyCheckVenueFollowAnswer,
  samples: [
    {
      verdict: 'accept',
      input: {
        region: 'USDC',
        permittedMarkets: ['USDC'],
        maxNotionalPerOrder: '1',
        maxAggregateExposure: '1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        clientRequestId: 'ethereum',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Edit limits on a follow (J-copy-bots-otc-02): the sizing mode is locked; a blank cap clears it. */
export const TRADE_COPY_AMEND_FOLLOW = defineProcedure({
  ...base,
  name: 'trade.copy.amendFollow',
  kind: 'mutation',
  path: 'copy.amendFollow',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    followId: z.string().min(1).max(64),
    sizingMode: z.enum(['fixed_amount', 'smart_sync', 'multiplier']).optional(),
    maxPerMarket: z.union([decimal, z.literal('')]).optional(),
    maxPerDay: z.union([decimal, z.literal('')]).optional(),
  }),
  output: copyFollowAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_GRANT_SESSION_KEY = defineProcedure({
  ...base,
  name: 'trade.copy.grantSessionKey',
  kind: 'mutation',
  path: 'copy.grantSessionKey',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyGrantSessionKeyAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_KILL_SESSION_KEY = defineProcedure({
  ...base,
  name: 'trade.copy.killSessionKey',
  kind: 'mutation',
  path: 'copy.killSessionKey',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyFollowAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Close one copied position, whole or by an amount (CB-copy-10). Once per close. */
export const TRADE_COPY_CLOSE_COPIED_POSITION = defineProcedure({
  ...base,
  name: 'trade.copy.closeCopiedPosition',
  kind: 'mutation',
  path: 'copy.closeCopiedPosition',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    followId: z.string().min(1).max(64),
    // A venue follow's position id is its copy's venue order key (`copy-mirror:<followId>:<client order id>`),
    // up to the door's 200-character business key.
    positionId: z.string().min(1).max(200),
    qty: z.string().min(1).max(64).optional(),
  }),
  output: copyCloseCopiedPositionAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC', positionId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Leader fills this follow did not copy, with the reason id, newest first (CB-copy-11). */
export const TRADE_COPY_SKIP_LOG = defineProcedure({
  ...base,
  name: 'trade.copy.skipLog',
  kind: 'query',
  path: 'copy.skipLog',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copySkipLogAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's own lead earnings: settled fee-share rows and their sum per asset; never a profit figure (J-copy-bots-otc-06 #3). */
export const TRADE_COPY_LEAD_EARNINGS = defineProcedure({
  ...base,
  name: 'trade.copy.leadEarnings',
  kind: 'query',
  path: 'copy.leadEarnings',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ limit: z.number() }),
  output: leadEarningsAnswer,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's own lead level: not set while the owner's thresholds are blank; the maximum ratio is never set (J-copy-bots-otc-06 #5). */
export const TRADE_COPY_LEAD_LEVEL = defineProcedure({
  ...base,
  name: 'trade.copy.leadLevel',
  kind: 'query',
  path: 'copy.leadLevel',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: leadLevelAnswer,
  samples: [{ verdict: 'accept' }],
});

/** The caller's new-trader missions and how far each has come (CB-copy-12, J-copy-bots-otc-04 #3). */
export const TRADE_COPY_LEAD_MISSIONS = defineProcedure({
  ...base,
  name: 'trade.copy.leadMissions',
  kind: 'query',
  path: 'copy.leadMissions',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: leadMissionsAnswer,
  samples: [{ verdict: 'accept' }],
});

/** The caller's own lead trades, ongoing and history, with counts (CB-copy-15, J-copy-bots-otc-04 #8). */
export const TRADE_COPY_LEAD_TRADES = defineProcedure({
  ...base,
  name: 'trade.copy.leadTrades',
  kind: 'query',
  path: 'copy.leadTrades',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: leadTradesAnswer,
  samples: [{ verdict: 'accept' }],
});

/** The caller's copiers and each one's state (CB-copy-15, J-copy-bots-otc-04 #8). */
export const TRADE_COPY_LEAD_COPIERS = defineProcedure({
  ...base,
  name: 'trade.copy.leadCopiers',
  kind: 'query',
  path: 'copy.leadCopiers',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: leadCopiersAnswer,
  samples: [{ verdict: 'accept' }],
});

/** The scopes the platform has paused now (CB-ops-03): leads by listing ref, bot types and symbols. */
export const TRADE_COPY_PLATFORM_PAUSES = defineProcedure({
  ...base,
  name: 'trade.copy.platformPauses',
  kind: 'query',
  path: 'copy.platformPauses',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: platformPausesAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_COPY_DESK_STATUS = defineProcedure({
  ...base,
  name: 'trade.copy.deskStatus',
  kind: 'query',
  path: 'copy.deskStatus',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: copyDeskStatusOutput,
  samples: [{ verdict: 'accept' }],
});

/** Caller's follows only — product desk list. Omit limit → named refuse, never invent 50. */
export const TRADE_COPY_LIST_MY_FOLLOWS = defineProcedure({
  ...base,
  name: 'trade.copy.listMyFollows',
  kind: 'query',
  path: 'copy.listMyFollows',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ limit: z.number().optional() }).optional(),
  output: copyListMyFollowsAnswer,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_PAUSE = defineProcedure({
  ...base,
  name: 'trade.copy.pause',
  kind: 'mutation',
  path: 'copy.pause',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyPauseOutput,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_STOP = defineProcedure({
  ...base,
  name: 'trade.copy.stop',
  kind: 'mutation',
  path: 'copy.stop',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64), closeOnly: z.boolean().optional() }),
  output: copyStopOutput,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_DETACH = defineProcedure({
  ...base,
  name: 'trade.copy.detach',
  kind: 'mutation',
  path: 'copy.detach',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyDetachOutput,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_RESUME = defineProcedure({
  ...base,
  name: 'trade.copy.resume',
  kind: 'mutation',
  path: 'copy.resume',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyResumeOutput,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Published leader directory. Listed rows only, stable by listed time.
 * Limit is required. Any sort or order parameter is a ranking refuse.
 */
export const TRADE_COPY_LIST_LEADERS = defineProcedure({
  ...base,
  name: 'trade.copy.listLeaders',
  kind: 'query',
  path: 'copy.listLeaders',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z
    .object({
      limit: z.number().optional(),
      cursor: z.string().max(500).optional(),
      sort: z.string().max(64).optional(),
      order: z.string().max(64).optional(),
      orderBy: z.string().max(64).optional(),
      return: z.string().max(64).optional(),
      profit: z.string().max(64).optional(),
      copiers: z.string().max(64).optional(),
      rank: z.string().max(64).optional(),
      // A ranked category or the trending row: accepted only so it can be refused by name (CB-copy-23).
      category: z.string().max(64).optional(),
      trending: z.boolean().optional(),
      marketMode: z.string().max(16).optional(),
      q: z.string().max(200).optional(),
    })
    .optional(),
  output: copyListLeadersAnswer,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One listed leader's page: listing facts and the metrics the owner defined. Not listed → NOT_FOUND. */
export const TRADE_COPY_LEADER_PROFILE = defineProcedure({
  ...base,
  name: 'trade.copy.leaderProfile',
  kind: 'query',
  path: 'copy.leaderProfile',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ leaderRef: z.string().min(1).max(80) }),
  output: copyLeaderProfileAnswer,
  samples: [
    { verdict: 'accept', input: { leaderRef: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's copied orders on one of their follows, newest first. */
export const TRADE_COPY_FOLLOW_POSITIONS = defineProcedure({
  ...base,
  name: 'trade.copy.followPositions',
  kind: 'query',
  path: 'copy.followPositions',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyFollowPositionsAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's copied positions on one of their follows, newest first, with what is still open (CB-copy-09/10). */
export const TRADE_COPY_COPIED_POSITIONS = defineProcedure({
  ...base,
  name: 'trade.copy.copiedPositions',
  kind: 'query',
  path: 'copy.copiedPositions',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ followId: z.string().min(1).max(64) }),
  output: copyCopiedPositionsAnswer,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_COPY_FLATTEN = defineProcedure({
  ...base,
  name: 'trade.copy.flatten',
  kind: 'mutation',
  path: 'copy.flatten',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    followId: z.string().min(1).max(64),
    requestId: z.string().max(64).nullable().optional(),
    stepUpApprovalId: z.string().max(128).nullable().optional(),
  }),
  output: copyFlattenOutput,
  samples: [
    { verdict: 'accept', input: { followId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
