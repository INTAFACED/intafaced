// The Copy and Bots rooms' reads and writes. Every call here already exists in the service (VERIFIED against
// the local stack on 2026-10-17); the shapes mirror the legacy `features/trade/tool-api.ts`, which stays the owner of
// the calls both rooms share. Only fields the screen shows are kept, and no service sentence is ever kept
// (`residual` and `statusLine` are deliberately left out of the schema).
import { z } from 'zod';
import { decimalSchema } from '../../../shared/money';
import type { ApiClient } from '../../../shared/api';
import { algoSchema, copyFollowSchema, createToolApi } from '../../../features/trade/tool-api';

export const copyDeskSchema = z.object({
  feeSharePublished: z.boolean(),
  jurisdictionPublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  autoMirrorPlace: z.object({ published: z.boolean() }).optional(),
});
export type CopyDesk = z.infer<typeof copyDeskSchema>;

const ackSchema = z.object({ followId: z.string(), relationshipState: z.string(), newIntentFenced: z.boolean(), disposition: z.string() });

export const algoPolicySchema = z.object({
  capability: z.object({ createEnabled: z.boolean(), jobsEnabled: z.boolean() }),
  immatureKinds: z.array(z.string()),
});
export type AlgoPolicy = z.infer<typeof algoPolicySchema>;

export const studioStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  cash: decimalSchema,
  risk: z.object({ maxDrawdown: decimalSchema, maxNotional: decimalSchema, kill: decimalSchema }),
  environment: z.string(),
  claimLabel: z.string(),
  live: z.boolean(),
  simulated: z.boolean(),
});
export type StudioStrategy = z.infer<typeof studioStrategySchema>;

export type FollowRequest = {
  leaderId: string;
  region: string;
  permittedMarkets: string[];
  maxNotionalPerOrder: string;
  maxAggregateExposure: string;
  maxLoss?: string;
  expiresAt: string;
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

export function createRoomApi(api: ApiClient) {
  const tools = createToolApi(api);
  return {
    copyDesk: (signal?: AbortSignal) => api.query('trade', 'copy.deskStatus', undefined, copyDeskSchema, { signal }),
    follows: tools.copyFollows,
    follow: (input: FollowRequest) => api.mutate('trade', 'copy.follow', input, copyFollowSchema),
    followAction: tools.copyAction,
    flatten: (followId: string) => api.mutate('trade', 'copy.flatten', { followId }, ackSchema.passthrough()),
    algoPolicy: (signal?: AbortSignal) => api.query('trade', 'algo.policy', undefined, algoPolicySchema, { signal }),
    createTwap: (input: TwapRequest) => api.mutate('trade', 'algo.createTwap', input, algoSchema),
    algoGet: tools.algoGet,
    algoProgress: tools.algoProgress,
    algoAction: tools.algoAction,
    studio: (signal?: AbortSignal) =>
      api.query('quant', 'studio.list', { limit: 50 }, z.object({ strategies: z.array(studioStrategySchema) }), { signal }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
