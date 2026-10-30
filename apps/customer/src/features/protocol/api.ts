import { z } from 'zod';
import {
  dexHealthSchema,
  indexerStatusSchema,
  protocolAuditStatusSchema,
  protocolChainStatusSchema,
  protocolServiceHealthSchema,
} from '@intafaced/contracts/protocol-blockers';
import {
  protocolCapabilitiesOutputSchema,
  protocolDeploymentsOutputSchema,
  protocolNetworksListOutputSchema,
  type ProtocolDeploymentsOutput,
  type ProtocolNetworksListOutput,
} from '@intafaced/contracts/protocol-networks';
import {
  protocolRepresentationAcceptOutputSchema,
  protocolRepresentationStatusOutputSchema,
  type ProtocolRepresentationStatus,
} from '@intafaced/contracts/protocol-representation';
import {
  protocolApprovalCheckOutputSchema,
  protocolPoolQuoteOutputSchema,
  protocolSwapPairsOutputSchema,
  protocolSwapSettingsOutputSchema,
  protocolUnsignedCallSchema,
} from '@intafaced/contracts/protocol-swap';
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
export type NetworksList = ProtocolNetworksListOutput;
export type Deployments = ProtocolDeploymentsOutput;
export type RepresentationStatus = ProtocolRepresentationStatus;

export function createProtocolApi(api: ApiClient) {
  return {
    chainStatus: (signal?: AbortSignal) => api.query('protocol', 'chainStatus', undefined, chainStatusSchema, { signal }),
    auditStatus: (signal?: AbortSignal) => api.query('protocol', 'auditStatus', undefined, auditStatusSchema, { signal }),
    health: (signal?: AbortSignal) => api.query('protocol', 'health', undefined, protocolHealthSchema, { signal }),
    indexerStatus: (signal?: AbortSignal) => api.query('indexer', 'status', undefined, indexerStatusSchema, { signal }),
    dexHealth: (signal?: AbortSignal) => api.query('dex', 'health', undefined, dexHealthSchema, { signal }),
    /** The owner-published network registry. A field the owner has not published is null. */
    networksList: (signal?: AbortSignal) => api.query('protocol', 'networks.list', undefined, protocolNetworksListOutputSchema, { signal }),
    /** Recorded contracts and router versions for one chain. A chain with nothing recorded is a refusal, not an empty list. */
    deploymentsList: (chainId: number, signal?: AbortSignal) =>
      api.query('protocol', 'deployments.list', { chainId }, protocolDeploymentsOutputSchema, { signal }),
    /** What the node can do, measured by the service. Only the configured chain is probed; any other chain reports nothing probed. */
    capabilities: (chainId: number, signal?: AbortSignal) =>
      api.query('protocol', 'capabilities', { chainId }, protocolCapabilitiesOutputSchema, { signal }),
    /** The representation a wallet accepts once per version before its first signing action, and whether it has. */
    representationStatus: (address: string, signal?: AbortSignal) =>
      api.query('protocol', 'representation.status', { address }, protocolRepresentationStatusOutputSchema, { signal }),
    /** Records the wallet's signature over `representationStatus().message`. The service checks that the address signed it. */
    representationAccept: (input: { address: string; version: string; signature: string }) =>
      api.mutate('protocol', 'representation.accept', input, protocolRepresentationAcceptOutputSchema),
    /** Every pool the network's factory lists and the tokens they trade, read from the chain. */
    ammPairs: (signal?: AbortSignal) => api.query('protocol', 'amm.pairs', undefined, protocolSwapPairsOutputSchema, { signal }),
    /** The owner's swap settings; blank refuses and the form keeps Swap off. */
    swapSettings: (signal?: AbortSignal) =>
      api.query('protocol', 'amm.swapSettings', undefined, protocolSwapSettingsOutputSchema, { signal }),
    /** A quote from one pool's reserves as read now. `amountIn` in base units. */
    poolQuote: (input: { pool: string; tokenIn: string; amountIn: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.quoteFromPool', input, protocolPoolQuoteOutputSchema, { signal }),
    /** Whether `spender` may already move `amount` of `token` for `owner`, and the exact-amount calls that fix it. */
    checkApproval: (input: { owner: string; token: string; spender: string; amount: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.checkApproval', input, protocolApprovalCheckOutputSchema, { signal }),
    /** The swap call the wallet signs; the service re-reads the pool and refuses a minimum under the slippage ceiling. */
    buildSwap: (input: { pool: string; tokenIn: string; amountIn: string; minAmountOut: string; to: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.buildSwapExactIn', input, protocolUnsignedCallSchema, { signal }),
    /** A read-only quote. It moves nothing; the service refuses with a `dex.quote.*` code when no venue can be read fresh. */
    dexQuote: (input: { symbol: string; side: 'buy' | 'sell'; qty: string }, signal?: AbortSignal) =>
      api.query('dex', 'quote', input, dexQuoteSchema, { signal }),
  };
}
export type ProtocolApi = ReturnType<typeof createProtocolApi>;
