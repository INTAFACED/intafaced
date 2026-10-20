import { z } from 'zod';
import {
  dexHealthSchema,
  indexerStatusSchema,
  protocolAuditStatusSchema,
  protocolChainStatusSchema,
  protocolServiceHealthSchema,
} from '@intafaced/contracts/protocol-blockers';
import type { ApiClient } from '../../shared/api';

/**
 * Read-only wire shapes for the Protocol rooms. Each mirrors the service's own output schema
 * (svc-protocol `chainStatus` / `auditStatus` / `health`, svc-indexer `status`, svc-dex `health` / `quote`)
 * and keeps only the fields this room renders. `audited` is a literal false on the wire, so a response that
 * ever claims otherwise fails validation and shows as a refusal instead of a badge.
 */
export const chainStatusSchema = protocolChainStatusSchema;
export const auditStatusSchema = protocolAuditStatusSchema;
export const protocolHealthSchema = protocolServiceHealthSchema;
export { dexHealthSchema, indexerStatusSchema };
export const dexQuoteSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  route: z.object({
    kind: z.enum(['quote', 'preview']),
    executable: z.boolean(),
    legs: z.array(z.object({ venue: z.string(), kind: z.string(), qty: z.string(), quoteAmount: z.string(), effectivePrice: z.string() })),
    filledQty: z.string(),
    unfilledQty: z.string(),
    totalQuoteAmount: z.string(),
  }),
  venues: z.array(z.object({ venueId: z.string(), plane: z.string(), custodial: z.boolean(), feeBps: z.number(), ageMs: z.number() })),
  unavailable: z.array(z.object({ venueId: z.string(), reason: z.string(), detail: z.string() })),
  degraded: z.boolean(),
  singleVenue: z.boolean(),
  executable: z.boolean(),
  nonExecutableReason: z.string().nullable(),
  asOf: z.string(),
});

export type ChainStatus = z.infer<typeof chainStatusSchema>;
export type AuditStatus = z.infer<typeof auditStatusSchema>;
export type ProtocolHealth = z.infer<typeof protocolHealthSchema>;
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;
export type DexHealth = z.infer<typeof dexHealthSchema>;
export type DexQuote = z.infer<typeof dexQuoteSchema>;

export function createProtocolApi(api: ApiClient) {
  return {
    chainStatus: (signal?: AbortSignal) => api.query('protocol', 'chainStatus', undefined, chainStatusSchema, { signal }),
    auditStatus: (signal?: AbortSignal) => api.query('protocol', 'auditStatus', undefined, auditStatusSchema, { signal }),
    health: (signal?: AbortSignal) => api.query('protocol', 'health', undefined, protocolHealthSchema, { signal }),
    indexerStatus: (signal?: AbortSignal) => api.query('indexer', 'status', undefined, indexerStatusSchema, { signal }),
    dexHealth: (signal?: AbortSignal) => api.query('dex', 'health', undefined, dexHealthSchema, { signal }),
    /** A read-only quote. It moves nothing; the service refuses with a `dex.quote.*` code when no venue can be read fresh. */
    dexQuote: (input: { symbol: string; side: 'buy' | 'sell'; qty: string }, signal?: AbortSignal) =>
      api.query('dex', 'quote', input, dexQuoteSchema, { signal }),
  };
}
export type ProtocolApi = ReturnType<typeof createProtocolApi>;
