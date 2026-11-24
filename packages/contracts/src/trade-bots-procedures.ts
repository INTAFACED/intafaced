import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  decimalOrBlank,
  gridAnswer,
  gridPresetsAnswer,
  gridSetupAnswer,
  gridTopUpAnswer,
  gridTopUpFreeAnswer,
  gridWithdrawalAnswer,
  ownGridAnswer,
} from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `bots.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_BOTS_GRID_SETUP = defineProcedure({
  ...base,
  name: 'trade.bots.grid.setup',
  kind: 'query',
  path: 'bots.grid.setup',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: gridSetupAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_BOTS_GRID_PRESETS = defineProcedure({
  ...base,
  name: 'trade.bots.grid.presets',
  kind: 'query',
  path: 'bots.grid.presets',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: gridPresetsAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_BOTS_GRID_STOP = defineProcedure({
  ...base,
  name: 'trade.bots.grid.stop',
  kind: 'mutation',
  path: 'bots.grid.stop',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ botId: z.string().min(1).max(64) }),
  output: gridAnswer,
  samples: [
    { verdict: 'accept', input: { botId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_BOTS_GRID_TOP_UP_FREE = defineProcedure({
  ...base,
  name: 'trade.bots.grid.topUpFree',
  kind: 'query',
  path: 'bots.grid.topUpFree',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ botId: z.string().min(1).max(64) }),
  output: gridTopUpFreeAnswer,
  samples: [
    { verdict: 'accept', input: { botId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_BOTS_GRID_TOP_UP = defineProcedure({
  ...base,
  name: 'trade.bots.grid.topUp',
  kind: 'mutation',
  path: 'bots.grid.topUp',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    botId: z.string().min(1).max(64),
    requestId: z.string().min(8).max(120),
    asset: z.string().max(16).optional().nullable(),
    amount: decimalOrBlank,
  }),
  output: gridTopUpAnswer,
  samples: [
    { verdict: 'accept', input: { botId: 'USDC', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_BOTS_GRID_MODIFY = defineProcedure({
  ...base,
  name: 'trade.bots.grid.modify',
  kind: 'mutation',
  path: 'bots.grid.modify',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    botId: z.string().min(1).max(64),
    trailing: z.boolean().optional().nullable(),
    shiftLimitPercent: decimalOrBlank,
    minGridCount: z.number().int().optional().nullable(),
  }),
  output: ownGridAnswer,
  samples: [
    { verdict: 'accept', input: { botId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_BOTS_GRID_WITHDRAW_PROFIT = defineProcedure({
  ...base,
  name: 'trade.bots.grid.withdrawProfit',
  kind: 'mutation',
  path: 'bots.grid.withdrawProfit',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    botId: z.string().min(1).max(64),
    requestId: z.string().min(8).max(120),
    asset: z.string().min(2).max(16),
    amount: decimalOrBlank,
    stepUpApprovalId: z.string().max(128).optional().nullable(),
  }),
  output: gridWithdrawalAnswer,
  samples: [
    { verdict: 'accept', input: { botId: 'USDC', requestId: 'ethereum', asset: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
