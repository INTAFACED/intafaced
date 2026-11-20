import {
  PROTOCOL_AMM_ALLOWANCES,
  PROTOCOL_AMM_BUILD_REVOKE,
  PROTOCOL_AMM_BUILD_SWAP_EXACT_IN,
  PROTOCOL_AMM_CHECK_APPROVAL,
  PROTOCOL_AMM_FEE_LEVELS,
  PROTOCOL_AMM_FEE_QUOTE,
  PROTOCOL_AMM_FEE_TOKENS,
  PROTOCOL_AMM_PAIRS,
  PROTOCOL_AMM_PREPARE_FEE_SWAP,
  PROTOCOL_AMM_PRICES,
  PROTOCOL_AMM_QUOTE_FROM_POOL,
  PROTOCOL_AMM_RELAY_FEE_SWAP,
  PROTOCOL_AMM_ROUTES,
  PROTOCOL_AMM_SWAP_SETTINGS,
} from '@intafaced/contracts/protocol-amm-procedures';
import {
  protocolAssetLinkReviewOutputSchema,
  protocolVenueReadsOutputSchema,
  protocolVenueBalancesOutputSchema,
  protocolVenueBuildOutputSchema,
  type ProtocolVenueBuildInput,
} from '@intafaced/contracts/protocol-venue-funds';
import {
  protocolContractBuildWriteOutputSchema,
  protocolContractInspectOutputSchema,
  protocolContractReadOutputSchema,
} from '@intafaced/contracts/protocol-contract-source';
import { z } from 'zod';
import type { ProtocolAddressReportInput } from '@intafaced/contracts/protocol-address-risk';
import { PROTOCOL_ADDRESS_REPORTS_SUBMIT, PROTOCOL_ADDRESS_RISK_READ } from '@intafaced/contracts/protocol-wallet-procedures';
import {
  dexHealthSchema,
  indexerStatusSchema,
  type ProtocolAuditStatus,
  type ProtocolChainStatus,
  type ProtocolServiceHealth,
} from '@intafaced/contracts/protocol-blockers';
import type { ProtocolDeploymentsOutput, ProtocolNetworksListOutput } from '@intafaced/contracts/protocol-networks';
import type { ProtocolRepresentationStatus } from '@intafaced/contracts/protocol-representation';
import {
  PROTOCOL_AUDIT_PRODUCTS,
  PROTOCOL_AUDIT_STATUS,
  PROTOCOL_BUILD_REVOKE_ALL_SESSIONS,
  PROTOCOL_BUILD_SESSION_GRANT,
  PROTOCOL_BUILD_SESSION_REVOKE,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_CHAIN_STATUS,
  PROTOCOL_DEPLOYMENTS_LIST,
  PROTOCOL_HEALTH,
  PROTOCOL_NETWORKS_LIST,
  PROTOCOL_PREDICT_ADDRESS,
  PROTOCOL_REPRESENTATION_ACCEPT,
  PROTOCOL_REPRESENTATION_STATUS,
  PROTOCOL_SESSIONS_LIST,
} from '@intafaced/contracts/protocol-procedures';
import { type ProtocolFeeSwapSubmitInput } from '@intafaced/contracts/protocol-swap';
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
import {
  protocolEscrowBuildOutputSchema,
  protocolEscrowDealOutputSchema,
  type ProtocolEscrowBuildInput,
} from '@intafaced/contracts/protocol-escrow';
import { dexQuoteSchema } from '@intafaced/contracts/dex-quote';
import { protocolPortfolioOutputSchema } from '@intafaced/contracts/protocol-portfolio';
import { protocolLendingPositionOutputSchema } from '@intafaced/contracts/protocol-lending-position';
import type { ApiClient } from '../../shared/api';

/**
 * svc-protocol's own reads are called by their records (`@intafaced/contracts/protocol-procedures`), which parse each answer;
 * `audited` is a literal false there, so a response that ever claims otherwise fails validation and shows as a refusal
 * instead of a badge. svc-indexer `status` and svc-dex `health` / `quote` parse with their contracts schemas, which keep only the fields
 * this room renders.
 */
/** A session key's scope as `buildSessionGrant` takes it: unix seconds, wei as a decimal string, exact targets and selectors. */
export type SessionGrantSpec = {
  key: string;
  validUntil: number;
  spendLimitWei: string;
  targets: string[];
  selectors: string[];
};
export { dexHealthSchema, dexQuoteSchema, indexerStatusSchema };
export type ChainStatus = ProtocolChainStatus;
export type AuditStatus = ProtocolAuditStatus;
export type ProtocolHealth = ProtocolServiceHealth;
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;
export type DexHealth = z.infer<typeof dexHealthSchema>;
export type DexQuote = z.infer<typeof dexQuoteSchema>;
export type NetworksList = ProtocolNetworksListOutput;
export type Deployments = ProtocolDeploymentsOutput;
export type RepresentationStatus = ProtocolRepresentationStatus;

/** The service builds the owner's call; this room signs only one whose target is an address and whose data is whole bytes. */
const isWalletCall = (call: { to: string; data: string }) => /^0x[0-9a-fA-F]{40}$/.test(call.to) && /^0x([0-9a-fA-F]{2})*$/.test(call.data);

export function createProtocolApi(api: ApiClient) {
  return {
    chainStatus: (signal?: AbortSignal) => api.call(PROTOCOL_CHAIN_STATUS, undefined, { signal }),
    auditStatus: (signal?: AbortSignal) => api.call(PROTOCOL_AUDIT_STATUS, undefined, { signal }),
    /** The address risk card: published labels, the open-report count and the screening state (D-developer-compliance-01). */
    addressRisk: (address: string, signal?: AbortSignal) => api.call(PROTOCOL_ADDRESS_RISK_READ, { address }, { signal }),
    /** Files a scam report as the signed-in person. A second open report for the same address refuses as a duplicate. */
    reportAddress: (input: ProtocolAddressReportInput) => api.call(PROTOCOL_ADDRESS_REPORTS_SUBMIT, input),
    /** Every session key `account` granted, from its own logs, with the on-chain status at one block (D-portfolio-wallet-02). */
    sessionsList: (account: string, signal?: AbortSignal) => api.call(PROTOCOL_SESSIONS_LIST, { account }, { signal }),
    /** The unsigned owner call that grants one session key; a scope with transfer or approval power is refused here. */
    buildSessionGrant: (input: { account: string; spec: SessionGrantSpec }) =>
      api.call(PROTOCOL_BUILD_SESSION_GRANT, input, { accept: isWalletCall }),
    /** The unsigned owner call that revokes one key. */
    buildSessionRevoke: (input: { account: string; sessionKey: string }) =>
      api.call(PROTOCOL_BUILD_SESSION_REVOKE, input, { accept: isWalletCall }),
    /** The one unsigned owner call that ends every key at once (the account's session epoch moves on). */
    buildRevokeAllSessions: (input: { account: string }) => api.call(PROTOCOL_BUILD_REVOKE_ALL_SESSIONS, input, { accept: isWalletCall }),
    /** The smart account `owner` controls on this network (its counterfactual address) and whether it is deployed. */
    predictAccount: (owner: string, signal?: AbortSignal) => api.call(PROTOCOL_PREDICT_ADDRESS, { owner }, { signal }),
    /** The audit room's per-product rows: an owner-recorded external report per product, or none (D-developer-compliance-02). */
    auditProducts: (signal?: AbortSignal) => api.call(PROTOCOL_AUDIT_PRODUCTS, undefined, { signal }),
    health: (signal?: AbortSignal) => api.call(PROTOCOL_HEALTH, undefined, { signal }),
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
    networksList: (signal?: AbortSignal) => api.call(PROTOCOL_NETWORKS_LIST, undefined, { signal }),
    /** Recorded contracts and router versions for one chain. A chain with nothing recorded is a refusal, not an empty list. */
    deploymentsList: (chainId: number, signal?: AbortSignal) => api.call(PROTOCOL_DEPLOYMENTS_LIST, { chainId }, { signal }),
    /** What the node can do, measured by the service. Only the configured chain is probed; any other chain reports nothing probed. */
    capabilities: (chainId: number, signal?: AbortSignal) => api.call(PROTOCOL_CAPABILITIES, { chainId }, { signal }),
    /** The representation a wallet accepts once per version before its first signing action, and whether it has. */
    representationStatus: (address: string, signal?: AbortSignal) => api.call(PROTOCOL_REPRESENTATION_STATUS, { address }, { signal }),
    /** Records the wallet's signature over `representationStatus().message`. The service checks that the address signed it. */
    representationAccept: (input: { address: string; version: string; signature: string }) =>
      api.call(PROTOCOL_REPRESENTATION_ACCEPT, input),
    /** The trading venue's balances for `account` (total, reserved, free), read from the contract (D-bridge-chain-04). */
    venueBalances: (account: string, signal?: AbortSignal) =>
      api.query('protocol', 'venue.balances', { account }, protocolVenueBalancesOutputSchema, { signal }),
    /** The unsigned approval (when needed) and `deposit` call; nothing is sent. */
    venueBuildDeposit: (input: ProtocolVenueBuildInput) =>
      api.query('protocol', 'venue.buildDeposit', input, protocolVenueBuildOutputSchema),
    /** The unsigned `withdraw` call; above the free amount refuses `protocol.venue_insufficient_free` naming it. */
    venueBuildWithdraw: (input: ProtocolVenueBuildInput) =>
      api.query('protocol', 'venue.buildWithdraw', input, protocolVenueBuildOutputSchema),
    /** Whether `token` is one of the venue's own two assets, with its decimals; a read (J-dex-protocol-05 #10). */
    assetLinkReview: (token: string) => api.query('protocol', 'venue.assetLinkReview', { token }, protocolAssetLinkReviewOutputSchema),
    /** The venue's read-only calls with examples (the contract-read docs). */
    venueReads: (signal?: AbortSignal) => api.query('protocol', 'venue.reads', undefined, protocolVenueReadsOutputSchema, { signal }),
    /** The claim-link escrow and its published expiry bounds, read from the contract; blank refuses by name (D-swap-12). */
    /** RC-p2p-01: one sovereign P2P escrow deal as the contract holds it now, with the chain's clock. */
    escrowDeal: (dealId: string, signal?: AbortSignal) =>
      api.query('protocol', 'escrow.deal', { dealId }, protocolEscrowDealOutputSchema, { signal }),
    /** RC-p2p-01: one unsigned call on the sovereign P2P escrow (or the token's approve of it). The wallet signs it. */
    escrowBuild: (input: ProtocolEscrowBuildInput, signal?: AbortSignal) =>
      api.query('protocol', 'escrow.build', input, protocolEscrowBuildOutputSchema, { signal }),
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
    ammPairs: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_PAIRS, undefined, { signal }),
    /** Every listed token's USD price from the pools at one block, or why it has none. */
    /** One address's holdings, value, profit and loss and transfers, read from the chain (D-portfolio-wallet-04). */
    portfolio: (address: string, signal?: AbortSignal) =>
      api.query('protocol', 'portfolio.read', { address }, protocolPortfolioOutputSchema, { signal }),
    /** One account's collateral and debt in the lending market, read from the contract (D-portfolio-wallet-04). */
    lendingPosition: (account: string, signal?: AbortSignal) =>
      api.query('protocol', 'lending.position', { account }, protocolLendingPositionOutputSchema, { signal }),
    tokenPrices: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_PRICES, undefined, { signal }),
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
    swapSettings: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_SWAP_SETTINGS, undefined, { signal }),
    /** A quote from one pool's reserves as read now. `amountIn` in base units. */
    poolQuote: (input: { pool: string; tokenIn: string; amountIn: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_QUOTE_FROM_POOL, input, { signal }),
    /** Every factory pool for the pair ranked for this amount at one block, best first, with why each other leg lost. */
    routes: (input: { tokenIn: string; tokenOut: string; amountIn: string; exclude: readonly string[] }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_ROUTES, { ...input, exclude: [...input.exclude] }, { signal }),
    /** Whether `spender` may already move `amount` of `token` for `owner`, and the exact-amount calls that fix it. */
    checkApproval: (input: { owner: string; token: string; spender: string; amount: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_CHECK_APPROVAL, input, { signal }),
    /** The swap call the wallet signs; the service re-reads the pool and refuses a minimum under the slippage ceiling. */
    buildSwap: (input: { pool: string; tokenIn: string; amountIn: string; minAmountOut: string; to: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_BUILD_SWAP_EXACT_IN, input, { signal }),
    /** Slow, Normal and Fast network fees from the last blocks, with the owner's fee cap; a blank setting refuses. */
    feeLevels: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_FEE_LEVELS, undefined, { signal }),
    /** The tokens the fee relay lists, its published markup and the gas a relayed swap is priced for; blank refuses. */
    feeTokens: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_FEE_TOKENS, undefined, { signal }),
    /** The network fee in `feeToken` at the most per gas chosen, priced by the relay; off-list or stale refuses by name. */
    feeQuote: (input: { feeToken: string; maxFeePerGasWei: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_FEE_QUOTE, input, { signal }),
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
    ) => api.call(PROTOCOL_AMM_PREPARE_FEE_SWAP, input, { signal }),
    /** Hands the signed order to the fee relay, which sends it and pays the gas; answers the transaction hash. */
    relayFeeSwap: (input: ProtocolFeeSwapSubmitInput) => api.call(PROTOCOL_AMM_RELAY_FEE_SWAP, input),
    /** The live allowances `owner` has given for the tokens the network's pools trade, read from the chain at one block. */
    allowances: (owner: string, signal?: AbortSignal) => api.call(PROTOCOL_AMM_ALLOWANCES, { owner }, { signal }),
    /** `approve(spender, 0)` for the wallet to sign and send. */
    buildRevoke: (input: { token: string; spender: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_BUILD_REVOKE, input, { signal }),
    /** A read-only quote. It moves nothing; the service refuses with a `dex.quote.*` code when no venue can be read fresh. */
    dexQuote: (input: { symbol: string; side: 'buy' | 'sell'; qty: string }, signal?: AbortSignal) =>
      api.query('dex', 'quote', input, dexQuoteSchema, { signal }),
  };
}
export type ProtocolApi = ReturnType<typeof createProtocolApi>;
