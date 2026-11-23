import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import { positionPreviewSchema, adlDisclosureSchema } from '@intafaced/contracts/trade-tools';
import { EXECUTION_SPINE } from '@intafaced/contracts/execution-procedures';
import type { ApiClient } from '../../shared/api';
import {
  TRADE_CONVERT_PAIRS,
  TRADE_CONVERT_LIMITS,
  TRADE_CONVERT_LIMIT_PLACE,
  TRADE_CONVERT_LIMIT_CANCEL,
  TRADE_CONVERT_ROUTE,
  TRADE_CONVERT_LIST,
  TRADE_CONVERT_QUOTE,
  TRADE_CONVERT_ACCEPT,
} from '@intafaced/contracts/trade-convert-procedures';
import {
  TRADE_ALGO_PROGRESS,
  TRADE_ALGO_GET,
  TRADE_ALGO_PAUSE,
  TRADE_ALGO_RESUME,
  TRADE_ALGO_CANCEL,
} from '@intafaced/contracts/trade-algo-procedures';
import {
  TRADE_OTC_MAKERS_LIST,
  TRADE_OTC_ACCEPT,
  TRADE_OTC_SETTLE,
  TRADE_OTC_DESK_STATUS,
} from '@intafaced/contracts/trade-otc-procedures';
import { TRADE_RFQ_GET, TRADE_RFQ_QUOTE } from '@intafaced/contracts/trade-rfq-procedures';
import {
  TRADE_COPY_DESK_STATUS,
  TRADE_COPY_LIST_MY_FOLLOWS,
  TRADE_COPY_PAUSE,
  TRADE_COPY_STOP,
  TRADE_COPY_DETACH,
  TRADE_COPY_RESUME,
} from '@intafaced/contracts/trade-copy-records';

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
    convertPairs: (signal?: AbortSignal) => api.call(TRADE_CONVERT_PAIRS, undefined, { signal }),
    convertLimits: (signal?: AbortSignal) => api.call(TRADE_CONVERT_LIMITS, undefined, { signal }),
    convertLimitPlace: (input: { symbol: string; side: 'buy' | 'sell'; amount: string; targetRate: string; clientLimitId: string }) =>
      api.call(TRADE_CONVERT_LIMIT_PLACE, input),
    convertLimitCancel: (id: string) => api.call(TRADE_CONVERT_LIMIT_CANCEL, { id }),
    /** How one asset converts to another; refuses by name where no route is built (a cash currency through a coin). */
    convertRoute: (input: { from: string; to: string }, signal?: AbortSignal) => api.call(TRADE_CONVERT_ROUTE, input, { signal }),
    convertQuote: (input: ConvertQuoteInput) => api.call(TRADE_CONVERT_QUOTE, input),
    /** The service refuses without a window (92 days at most) and a limit, so the caller always names both. */
    convertList: (input: { from: string; to: string; limit: number; cursor?: string }, signal?: AbortSignal) =>
      api.call(TRADE_CONVERT_LIST, input, { signal }),
    convertAccept: (quoteId: string, clientConvertId: string) => api.call(TRADE_CONVERT_ACCEPT, { quoteId, clientConvertId }),
    algoGet: (algoId: string, signal?: AbortSignal) => api.call(TRADE_ALGO_GET, { algoId }, { signal }),
    algoProgress: (algoId: string, signal?: AbortSignal) => api.call(TRADE_ALGO_PROGRESS, { algoId }, { signal }),
    algoAction: (action: 'pause' | 'resume' | 'cancel', algoId: string) =>
      action === 'pause'
        ? api.call(TRADE_ALGO_PAUSE, { algoId })
        : action === 'resume'
          ? api.call(TRADE_ALGO_RESUME, { algoId })
          : api.call(TRADE_ALGO_CANCEL, { algoId }),
    copyStatus: (signal?: AbortSignal) => api.call(TRADE_COPY_DESK_STATUS, undefined, { signal }),
    copyFollows: (signal?: AbortSignal) => api.call(TRADE_COPY_LIST_MY_FOLLOWS, { limit: 100 }, { signal }),
    copyAction: (action: 'pause' | 'stop' | 'detach' | 'resume', followId: string) =>
      action === 'pause'
        ? api.call(TRADE_COPY_PAUSE, { followId })
        : action === 'stop'
          ? api.call(TRADE_COPY_STOP, { followId })
          : action === 'detach'
            ? api.call(TRADE_COPY_DETACH, { followId })
            : api.call(TRADE_COPY_RESUME, { followId }),
    otcStatus: (signal?: AbortSignal) => api.call(TRADE_OTC_DESK_STATUS, undefined, { signal }),
    otcMakers: (signal?: AbortSignal) => api.call(TRADE_OTC_MAKERS_LIST, undefined, { signal }),
    otcQuote: (input: { side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string; makerIds: string[] }) =>
      api.call(TRADE_RFQ_QUOTE, input),
    otcGet: (quoteId: string) => api.call(TRADE_RFQ_GET, { quoteId }),
    otcAccept: (quoteId: string, assertedPrice: string) => api.call(TRADE_OTC_ACCEPT, { quoteId, assertedPrice }),
    otcSettle: (quoteId: string) => api.call(TRADE_OTC_SETTLE, { quoteId }),
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
    executionSpine: (signal?: AbortSignal) => api.call(EXECUTION_SPINE, undefined, { signal }),
  };
}
export type ToolApi = ReturnType<typeof createToolApi>;
