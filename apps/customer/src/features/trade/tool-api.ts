import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import {
  convertQuoteSchema,
  convertTradeSchema,
  algoSchema,
  algoProgressSchema,
  copyFollowSchema,
  copyStatusSchema,
  otcStatusSchema,
  otcMakersSchema,
  otcQuoteSchema,
  otcFillSchema,
  positionPreviewSchema,
  convertPairsSchema,
  limitConvertSchema,
  convertRouteSchema,
  convertHistorySchema,
  copyActionSchema,
  otcSettledSchema,
  adlDisclosureSchema,
  executionSpineSchema,
} from '@intafaced/contracts/trade-tools';
import type { ApiClient } from '../../shared/api';

/** The trading tools' reply schemas live once in contracts; this file keeps the calls. */
export * from '@intafaced/contracts/trade-tools';

/**
 * `convert.quote` takes exactly one size: a base amount (`qty`, buy or sell) or a spend in the quote asset
 * (`quoteQty`, buy only; the service never charges more than it). The union makes sending both, or neither, a type error.
 */
export type ConvertQuoteInput =
  { symbol: string; side: 'buy' | 'sell'; qty: string; quoteQty?: never } | { symbol: string; side: 'buy'; quoteQty: string; qty?: never };

export function createToolApi(api: ApiClient) {
  return {
    convertPairs: (signal?: AbortSignal) => api.query('trade', 'convert.pairs', undefined, convertPairsSchema, { signal }),
    convertLimits: (signal?: AbortSignal) => api.query('trade', 'convert.limits', undefined, z.array(limitConvertSchema), { signal }),
    convertLimitPlace: (input: { symbol: string; side: 'buy' | 'sell'; amount: string; targetRate: string; clientLimitId: string }) =>
      api.mutate('trade', 'convert.limitPlace', input, limitConvertSchema),
    convertLimitCancel: (id: string) => api.mutate('trade', 'convert.limitCancel', { id }, limitConvertSchema),
    /** How one asset converts to another; refuses by name where no route is built (a cash currency through a coin). */
    convertRoute: (input: { from: string; to: string }, signal?: AbortSignal) =>
      api.query('trade', 'convert.route', input, convertRouteSchema, { signal }),
    convertQuote: (input: ConvertQuoteInput) => api.query('trade', 'convert.quote', input, convertQuoteSchema),
    /** The service refuses without a window (92 days at most) and a limit, so the caller always names both. */
    convertList: (input: { from: string; to: string; limit: number; cursor?: string }, signal?: AbortSignal) =>
      api.query('trade', 'convert.list', input, convertHistorySchema, { signal }),
    convertAccept: (quoteId: string, clientConvertId: string) =>
      api.mutate('trade', 'convert.accept', { quoteId, clientConvertId }, convertTradeSchema),
    algoGet: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.get', { algoId }, algoSchema, { signal }),
    algoProgress: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.progress', { algoId }, algoProgressSchema, { signal }),
    algoAction: (action: 'pause' | 'resume' | 'cancel', algoId: string) => api.mutate('trade', `algo.${action}`, { algoId }, algoSchema),
    copyStatus: (signal?: AbortSignal) => api.query('trade', 'copy.deskStatus', undefined, copyStatusSchema, { signal }),
    copyFollows: (signal?: AbortSignal) => api.query('trade', 'copy.listMyFollows', { limit: 100 }, z.array(copyFollowSchema), { signal }),
    copyAction: (action: 'pause' | 'stop' | 'detach' | 'resume', followId: string) =>
      api.mutate('trade', `copy.${action}`, { followId }, copyActionSchema),
    otcStatus: (signal?: AbortSignal) => api.query('trade', 'otc.deskStatus', undefined, otcStatusSchema, { signal }),
    otcMakers: (signal?: AbortSignal) => api.query('trade', 'otc.makers.list', undefined, otcMakersSchema, { signal }),
    otcQuote: (input: { side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string; makerIds: string[] }) =>
      api.mutate('trade', 'rfq.quote', input, otcQuoteSchema),
    otcGet: (quoteId: string) => api.query('trade', 'rfq.get', { quoteId }, otcQuoteSchema),
    otcAccept: (quoteId: string, assertedPrice: string) => api.mutate('trade', 'otc.accept', { quoteId, assertedPrice }, otcFillSchema),
    otcSettle: (quoteId: string) => api.mutate('trade', 'otc.settle', { quoteId }, otcSettledSchema),
    positionPreview: (input: { symbol: string; side: 'long' | 'short'; size: string; leverage: string; marginMode: 'isolated' }) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: input }),
    position: (id: string) => api.rest(`/positions/${encodeURIComponent(id)}`, positionSchema),
    positionClose: (id: string, input: { quantity: string; clientCloseId: string }) =>
      api.rest(`/positions/${encodeURIComponent(id)}/close`, positionSchema, {
        method: 'POST',
        body: { quantity: input.quantity, clientCloseId: input.clientCloseId },
      }),
    positionHistory: (signal?: AbortSignal) => api.rest('/positions/closed', z.array(positionSchema), { query: { limit: 100 }, signal }),
    disclosure: (signal?: AbortSignal) => api.rest('/futures/adl-disclosure', adlDisclosureSchema, { signal }),
    executionSpine: (signal?: AbortSignal) => api.query('execution', 'execution.spine', undefined, executionSpineSchema, { signal }),
  };
}
export type ToolApi = ReturnType<typeof createToolApi>;
