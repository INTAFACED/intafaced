import {
  protocolContractBuildWriteOutputSchema,
  protocolContractInspectOutputSchema,
  protocolContractReadOutputSchema,
} from '@intafaced/contracts/protocol-contract-source';
import { z } from 'zod';
import {
  protocolAddressReportReceiptSchema,
  protocolAddressRiskSchema,
  type ProtocolAddressReportInput,
} from '@intafaced/contracts/protocol-address-risk';
import {
  dexHealthSchema,
  indexerStatusSchema,
  protocolAuditProductsSchema,
  protocolPredictedAccountSchema,
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
  protocolAllowancesOutputSchema,
  protocolApprovalCheckOutputSchema,
  protocolFeeQuoteOutputSchema,
  protocolFeeSwapPlanOutputSchema,
  protocolFeeSwapSubmitOutputSchema,
  protocolFeeTokensOutputSchema,
  type ProtocolFeeSwapSubmitInput,
  protocolPoolQuoteOutputSchema,
  protocolRouteOptionsOutputSchema,
  protocolSwapFeesOutputSchema,
  protocolSwapPairsOutputSchema,
  protocolSwapSettingsOutputSchema,
  protocolTokenPricesOutputSchema,
  protocolUnsignedCallSchema,
} from '@intafaced/contracts/protocol-swap';
import {
  tokenPageOutputSchema,
  tokensBriefOutputSchema,
  tokensLeaderboardOutputSchema,
  tokensListOutputSchema,
  type TokenWindowId,
} from '@intafaced/contracts/protocol-tokens';
import {
  protocolClaimLinkConfigOutputSchema,
  protocolClaimLinkGetOutputSchema,
  protocolClaimLinkListOutputSchema,
  protocolReplacementOutputSchema,
  type ProtocolReplacementInput,
} from '@intafaced/contracts/protocol-wallet-tx';
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
    /** The address risk card: published labels, the open-report count and the screening state (D-developer-compliance-01). */
    addressRisk: (address: string, signal?: AbortSignal) =>
      api.query('protocol', 'addressRisk.read', { address }, protocolAddressRiskSchema, { signal }),
    /** Files a scam report as the signed-in person. A second open report for the same address refuses as a duplicate. */
    reportAddress: (input: ProtocolAddressReportInput) =>
      api.mutate('protocol', 'addressReports.submit', input, protocolAddressReportReceiptSchema),
    /** The smart account `owner` controls on this network (its counterfactual address) and whether it is deployed. */
    predictAccount: (owner: string, signal?: AbortSignal) =>
      api.query('protocol', 'predictAddress', { owner }, protocolPredictedAccountSchema, { signal }),
    /** The audit room's per-product rows: an owner-recorded external report per product, or none (D-developer-compliance-02). */
    auditProducts: (signal?: AbortSignal) => api.query('protocol', 'auditProducts', undefined, protocolAuditProductsSchema, { signal }),
    health: (signal?: AbortSignal) => api.query('protocol', 'health', undefined, protocolHealthSchema, { signal }),
    indexerStatus: (signal?: AbortSignal) => api.query('indexer', 'status', undefined, indexerStatusSchema, { signal }),
    dexHealth: (signal?: AbortSignal) => api.query('dex', 'health', undefined, dexHealthSchema, { signal }),
    /** A contract's source status, its proxy and the interface its Read and Write tabs use (D-explorer-06). */
    contractInspect: (address: string, signal?: AbortSignal) =>
      api.query('protocol', 'contract.inspect', { address }, protocolContractInspectOutputSchema, { signal }),
    /** One read function called at the contract's address, at one block. */
    contractRead: (input: { address: string; signature: string; args: string[] }) =>
      api.query('protocol', 'contract.read', input, protocolContractReadOutputSchema),
    /** The unsigned call for one write function; the person's own wallet signs and sends it. */
    contractBuildWrite: (input: { address: string; signature: string; args: string[]; value?: string }) =>
      api.query('protocol', 'contract.buildWrite', input, protocolContractBuildWriteOutputSchema),
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
    /** The claim-link escrow and its published expiry bounds, read from the contract; blank refuses by name (D-swap-12). */
    claimLinkConfig: (signal?: AbortSignal) =>
      api.query('protocol', 'claimLink.config', undefined, protocolClaimLinkConfigOutputSchema, { signal }),
    /** One claim link by its id (the link key's address), read from the escrow, with the chain's clock. */
    claimLinkGet: (id: string, signal?: AbortSignal) =>
      api.query('protocol', 'claimLink.get', { id }, protocolClaimLinkGetOutputSchema, { signal }),
    /** Every claim link `sender` created, newest first, with the chain's clock. */
    claimLinkList: (sender: string, signal?: AbortSignal) =>
      api.query('protocol', 'claimLink.list', { sender }, protocolClaimLinkListOutputSchema, { signal }),
    /** One unsigned same-nonce replacement for a pending transaction; a mined one refuses `protocol.tx_final`. */
    buildReplacement: (input: ProtocolReplacementInput, signal?: AbortSignal) =>
      api.query('protocol', 'tx.buildReplacement', input, protocolReplacementOutputSchema, { signal }),
    /** Every pool the network's factory lists and the tokens they trade, read from the chain. */
    ammPairs: (signal?: AbortSignal) => api.query('protocol', 'amm.pairs', undefined, protocolSwapPairsOutputSchema, { signal }),
    /** Every listed token's USD price from the pools at one block, or why it has none. */
    tokenPrices: (signal?: AbortSignal) => api.query('protocol', 'amm.prices', undefined, protocolTokenPricesOutputSchema, { signal }),
    /** Every token in the factory's pools with its price, growth and volume for one window, read at one block. */
    tokensList: (window: TokenWindowId, signal?: AbortSignal) =>
      api.query('protocol', 'tokens.list', { window }, tokensListOutputSchema, { signal }),
    /** One token's page: facts, trust, pairs with candles, holders and trades, read at one block. */
    tokenPage: (address: string, signal?: AbortSignal) =>
      api.query('protocol', 'tokens.page', { address }, tokenPageOutputSchema, { signal }),
    /** Wallets ranked by realised results from public swaps; each row carries the trades it sums. */
    tokensLeaderboard: (signal?: AbortSignal) =>
      api.query('protocol', 'tokens.leaderboard', undefined, tokensLeaderboardOutputSchema, { signal }),
    /** The market brief over the 24 hours to the head block, from the pools; null brief when nothing traded. */
    tokensBrief: (signal?: AbortSignal) => api.query('protocol', 'tokens.brief', undefined, tokensBriefOutputSchema, { signal }),
    /** The owner's swap settings; blank refuses and the form keeps Swap off. */
    swapSettings: (signal?: AbortSignal) =>
      api.query('protocol', 'amm.swapSettings', undefined, protocolSwapSettingsOutputSchema, { signal }),
    /** A quote from one pool's reserves as read now. `amountIn` in base units. */
    poolQuote: (input: { pool: string; tokenIn: string; amountIn: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.quoteFromPool', input, protocolPoolQuoteOutputSchema, { signal }),
    /** Every factory pool for the pair ranked for this amount at one block, best first, with why each other leg lost. */
    routes: (input: { tokenIn: string; tokenOut: string; amountIn: string; exclude: readonly string[] }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.routes', input, protocolRouteOptionsOutputSchema, { signal }),
    /** Whether `spender` may already move `amount` of `token` for `owner`, and the exact-amount calls that fix it. */
    checkApproval: (input: { owner: string; token: string; spender: string; amount: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.checkApproval', input, protocolApprovalCheckOutputSchema, { signal }),
    /** The swap call the wallet signs; the service re-reads the pool and refuses a minimum under the slippage ceiling. */
    buildSwap: (input: { pool: string; tokenIn: string; amountIn: string; minAmountOut: string; to: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.buildSwapExactIn', input, protocolUnsignedCallSchema, { signal }),
    /** Slow, Normal and Fast network fees from the last blocks, with the owner's fee cap; a blank setting refuses. */
    feeLevels: (signal?: AbortSignal) => api.query('protocol', 'amm.feeLevels', undefined, protocolSwapFeesOutputSchema, { signal }),
    /** The tokens the fee relay lists, its published markup and the gas a relayed swap is priced for; blank refuses. */
    feeTokens: (signal?: AbortSignal) => api.query('protocol', 'amm.feeTokens', undefined, protocolFeeTokensOutputSchema, { signal }),
    /** The network fee in `feeToken` at the most per gas chosen, priced by the relay; off-list or stale refuses by name. */
    feeQuote: (input: { feeToken: string; maxFeePerGasWei: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.feeQuote', input, protocolFeeQuoteOutputSchema, { signal }),
    /** What the person signs to swap with the fee in a token: a permit per token and the order, with the quote. */
    prepareFeeSwap: (
      input: {
        owner: string;
        pool: string;
        tokenIn: string;
        amountIn: string;
        minAmountOut: string;
        feeToken: string;
        maxFeePerGasWei: string;
      },
      signal?: AbortSignal,
    ) => api.query('protocol', 'amm.prepareFeeSwap', input, protocolFeeSwapPlanOutputSchema, { signal }),
    /** Hands the signed order to the fee relay, which sends it and pays the gas; answers the transaction hash. */
    relayFeeSwap: (input: ProtocolFeeSwapSubmitInput) =>
      api.mutate('protocol', 'amm.relayFeeSwap', input, protocolFeeSwapSubmitOutputSchema),
    /** The live allowances `owner` has given for the tokens the network's pools trade, read from the chain at one block. */
    allowances: (owner: string, signal?: AbortSignal) =>
      api.query('protocol', 'amm.allowances', { owner }, protocolAllowancesOutputSchema, { signal }),
    /** `approve(spender, 0)` for the wallet to sign and send. */
    buildRevoke: (input: { token: string; spender: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.buildRevoke', input, protocolUnsignedCallSchema, { signal }),
    /** A read-only quote. It moves nothing; the service refuses with a `dex.quote.*` code when no venue can be read fresh. */
    dexQuote: (input: { symbol: string; side: 'buy' | 'sell'; qty: string }, signal?: AbortSignal) =>
      api.query('dex', 'quote', input, dexQuoteSchema, { signal }),
  };
}
export type ProtocolApi = ReturnType<typeof createProtocolApi>;
