import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import {
  BRIDGE_AMOUNT_INVALID,
  BRIDGE_BURN_MISMATCH,
  BRIDGE_KEY_CONFLICT,
  BRIDGE_PROVIDER_UNSET,
  BRIDGE_ROUTE_KIND_FORBIDDEN,
  BRIDGE_ROUTE_UNKNOWN,
  BRIDGE_ROUTES_INVALID,
  BRIDGE_ROUTES_UNSET,
  BRIDGE_TOO_MANY_WAITING,
  BRIDGE_TRANSFER_NOT_FOUND,
  BRIDGE_UNREACHABLE,
  bridgeRoutesListOutputSchema,
  bridgeTransferBurnInputSchema,
  bridgeTransferSchema,
  bridgeTransferStartInputSchema,
  bridgeTransfersListInputSchema,
  bridgeTransfersListOutputSchema,
} from './protocol-bridge.js';
import {
  CONTRACT_ANSWER_UNREADABLE,
  CONTRACT_ARGUMENT_INVALID,
  CONTRACT_CALL_REVERTED,
  CONTRACT_FUNCTION_UNKNOWN,
  CONTRACT_INTERFACE_UNKNOWN,
  CONTRACT_READ_GAS_EXCEEDED,
  protocolContractBuildWriteInputSchema,
  protocolContractBuildWriteOutputSchema,
  protocolContractInspectInputSchema,
  protocolContractInspectOutputSchema,
  protocolContractReadInputSchema,
  protocolContractReadOutputSchema,
} from './protocol-contract-source.js';
import {
  ESCROW_AMOUNT_INVALID,
  ESCROW_AUDIT_EXTERNAL,
  ESCROW_DEAL_NOT_FOUND,
  ESCROW_NOT_DEPLOYED,
  protocolEscrowBuildInputSchema,
  protocolEscrowBuildOutputSchema,
  protocolEscrowDealInputSchema,
  protocolEscrowDealOutputSchema,
  protocolEscrowStatusOutputSchema,
} from './protocol-escrow.js';
import {
  LENDING_MARKET_UNSET,
  protocolLendingPositionInputSchema,
  protocolLendingPositionOutputSchema,
} from './protocol-lending-position.js';
import { protocolPortfolioInputSchema, protocolPortfolioOutputSchema } from './protocol-portfolio.js';
import { PRICE_SETTINGS_UNSET } from './protocol-swap.js';
import {
  TOKEN_NOT_LISTED,
  TOKEN_UNSUPPORTED,
  TOKENS_BLOCK_AHEAD,
  TOKENS_BLOCK_TOO_OLD,
  TOKENS_HOLDERS_INCONSISTENT,
  TOKENS_QUOTE_UNSET,
  TOKENS_READ_TOO_LARGE,
  tokenPageInputSchema,
  tokenPageOutputSchema,
  tokensBriefOutputSchema,
  tokensLeaderboardOutputSchema,
  tokensListInputSchema,
  tokensListOutputSchema,
} from './protocol-tokens.js';
import {
  ASSET_LINK_NOT_TOKEN,
  protocolAssetLinkReviewInputSchema,
  protocolAssetLinkReviewOutputSchema,
  protocolVenueBalancesInputSchema,
  protocolVenueBalancesOutputSchema,
  protocolVenueBuildInputSchema,
  protocolVenueBuildOutputSchema,
  protocolVenueReadsOutputSchema,
  VENUE_BAD_AMOUNT,
  VENUE_INSUFFICIENT_FREE,
  VENUE_UNSET,
} from './protocol-venue-funds.js';
import {
  CLAIM_ESCROW_UNSET,
  CLAIM_LINK_NOT_FOUND,
  FEE_ABOVE_CEILING,
  FEE_BUMP_UNSET,
  FEE_CEILING_UNSET,
  protocolClaimLinkConfigOutputSchema,
  protocolClaimLinkGetInputSchema,
  protocolClaimLinkGetOutputSchema,
  protocolClaimLinkListInputSchema,
  protocolClaimLinkListOutputSchema,
  protocolReplacementInputSchema,
  protocolReplacementOutputSchema,
  TX_FINAL,
  TX_NOT_FOUND,
  TX_NOT_YOURS,
  TX_SPEEDUP_CREATE,
} from './protocol-wallet-tx.js';

/**
 * svc-protocol's chain reads and unsigned-call builders, one record per call: the sovereign escrow, the trading venue's
 * funds, the lending position, the contract tabs, the bridge route table, the token pages, the portfolio, claim links and
 * the same-nonce replacement. Each is permissionless behind the Protocol Plane's jurisdiction guard; nothing here signs,
 * sends or posts. The service mounts each from here (`mountRecord`), so path, guard, input, output and refusals are this file.
 */

const base = { service: 'svc-protocol', module: 'protocol', transport: 'trpc', kind: 'query' } as const;
const PROTOCOL = { caller: 'jurisdiction', module: 'protocol', plane: 'protocol' } as const;

/** The chain being absent, unreachable or another chain: `toTrpcError` sends each as SERVICE_UNAVAILABLE. */
const CHAIN = [
  'protocol.chain_not_configured',
  'protocol.chain_unreachable',
  'protocol.contract_not_deployed',
  'protocol.chain_id_mismatch',
] as const;
/** The AMM factory unset (`PROTOCOL_AMM_FACTORY_ADDRESS`), refused before any chain read. */
const AMM_FACTORY_UNSET = 'protocol.amm_factory_unset';

const refusals = (...groups: (readonly [readonly string[], RefusalStatus])[]): Refusals =>
  Object.freeze(Object.fromEntries(groups.flatMap(([codes, status]) => codes.map((c) => [c, status] as const))));

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const NOT_ADDRESS = '';
const TX_HASH = `0x${'ab'.repeat(32)}`;

// ── escrow ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_ESCROW_STATUS = defineProcedure({
  ...base,
  name: 'protocol.escrow.status',
  path: 'escrow.status',
  access: PROTOCOL,
  refusals: refusals([[ESCROW_AUDIT_EXTERNAL], 'PRECONDITION_FAILED']),
  input: NO_INPUT,
  output: protocolEscrowStatusOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_ESCROW_DEAL = defineProcedure({
  ...base,
  name: 'protocol.escrow.deal',
  path: 'escrow.deal',
  access: PROTOCOL,
  refusals: refusals(
    [[ESCROW_AUDIT_EXTERNAL, ESCROW_NOT_DEPLOYED], 'PRECONDITION_FAILED'],
    [[ESCROW_DEAL_NOT_FOUND], 'NOT_FOUND'],
    [CHAIN, 'SERVICE_UNAVAILABLE'],
  ),
  input: protocolEscrowDealInputSchema,
  output: protocolEscrowDealOutputSchema,
  samples: [
    { verdict: 'accept', input: { dealId: '1' } },
    { verdict: 'refuse', input: { dealId: '0' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PROTOCOL_ESCROW_BUILD = defineProcedure({
  ...base,
  name: 'protocol.escrow.build',
  path: 'escrow.build',
  access: PROTOCOL,
  refusals: refusals([[ESCROW_AUDIT_EXTERNAL, ESCROW_NOT_DEPLOYED], 'PRECONDITION_FAILED'], [[ESCROW_AMOUNT_INVALID], 'BAD_REQUEST']),
  input: protocolEscrowBuildInputSchema,
  output: protocolEscrowBuildOutputSchema,
  samples: [
    { verdict: 'accept', input: { action: 'approve', token: ADDRESS, amount: '1000' } },
    { verdict: 'accept', input: { action: 'release', dealId: '7' } },
    { verdict: 'refuse', input: { action: 'approve', token: ADDRESS, amount: '0' } },
    { verdict: 'refuse', input: { action: 'withdraw', dealId: '7' } },
  ],
});

// ── venue ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const VENUE_READ = refusals([[VENUE_UNSET], 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']);
const VENUE_BUILD = refusals(
  [[VENUE_UNSET, VENUE_INSUFFICIENT_FREE], 'PRECONDITION_FAILED'],
  [[VENUE_BAD_AMOUNT], 'BAD_REQUEST'],
  [CHAIN, 'SERVICE_UNAVAILABLE'],
);
const VENUE_BUILD_SAMPLES = [
  { verdict: 'accept', input: { account: ADDRESS, side: 'base', amount: '1.5' } },
  { verdict: 'refuse', input: { account: ADDRESS, side: 'margin', amount: '1' } },
  { verdict: 'refuse', input: { account: ADDRESS, side: 'quote', amount: '-1' } },
] as const;

export const PROTOCOL_VENUE_BALANCES = defineProcedure({
  ...base,
  name: 'protocol.venue.balances',
  path: 'venue.balances',
  access: PROTOCOL,
  refusals: VENUE_READ,
  input: protocolVenueBalancesInputSchema,
  output: protocolVenueBalancesOutputSchema,
  samples: [
    { verdict: 'accept', input: { account: ADDRESS } },
    { verdict: 'refuse', input: { account: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_VENUE_BUILD_DEPOSIT = defineProcedure({
  ...base,
  name: 'protocol.venue.buildDeposit',
  path: 'venue.buildDeposit',
  access: PROTOCOL,
  refusals: VENUE_BUILD,
  input: protocolVenueBuildInputSchema,
  output: protocolVenueBuildOutputSchema,
  samples: VENUE_BUILD_SAMPLES,
});

export const PROTOCOL_VENUE_BUILD_WITHDRAW = defineProcedure({
  ...base,
  name: 'protocol.venue.buildWithdraw',
  path: 'venue.buildWithdraw',
  access: PROTOCOL,
  refusals: VENUE_BUILD,
  input: protocolVenueBuildInputSchema,
  output: protocolVenueBuildOutputSchema,
  samples: VENUE_BUILD_SAMPLES,
});

export const PROTOCOL_VENUE_ASSET_LINK_REVIEW = defineProcedure({
  ...base,
  name: 'protocol.venue.assetLinkReview',
  path: 'venue.assetLinkReview',
  access: PROTOCOL,
  refusals: refusals([[VENUE_UNSET], 'PRECONDITION_FAILED'], [[ASSET_LINK_NOT_TOKEN], 'BAD_REQUEST'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: protocolAssetLinkReviewInputSchema,
  output: protocolAssetLinkReviewOutputSchema,
  samples: [
    { verdict: 'accept', input: { token: ADDRESS } },
    { verdict: 'refuse', input: { token: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_VENUE_READS = defineProcedure({
  ...base,
  name: 'protocol.venue.reads',
  path: 'venue.reads',
  access: PROTOCOL,
  refusals: VENUE_READ,
  input: NO_INPUT,
  output: protocolVenueReadsOutputSchema,
  samples: [{ verdict: 'accept' }],
});

// ── lending ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_LENDING_POSITION = defineProcedure({
  ...base,
  name: 'protocol.lending.position',
  path: 'lending.position',
  access: PROTOCOL,
  refusals: refusals([[LENDING_MARKET_UNSET], 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: protocolLendingPositionInputSchema,
  output: protocolLendingPositionOutputSchema,
  samples: [
    { verdict: 'accept', input: { account: ADDRESS } },
    { verdict: 'refuse', input: { account: NOT_ADDRESS } },
  ],
});

// ── contract tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────

const CONTRACT_CALL = refusals(
  [[CONTRACT_INTERFACE_UNKNOWN], 'PRECONDITION_FAILED'],
  [[CONTRACT_FUNCTION_UNKNOWN, CONTRACT_ARGUMENT_INVALID], 'BAD_REQUEST'],
  [[CONTRACT_CALL_REVERTED, CONTRACT_READ_GAS_EXCEEDED, CONTRACT_ANSWER_UNREADABLE], 'CONFLICT'],
  [CHAIN, 'SERVICE_UNAVAILABLE'],
);

export const PROTOCOL_CONTRACT_INSPECT = defineProcedure({
  ...base,
  name: 'protocol.contract.inspect',
  path: 'contract.inspect',
  access: PROTOCOL,
  refusals: refusals([CHAIN, 'SERVICE_UNAVAILABLE']),
  input: protocolContractInspectInputSchema,
  output: protocolContractInspectOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: { address: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_CONTRACT_READ = defineProcedure({
  ...base,
  name: 'protocol.contract.read',
  path: 'contract.read',
  access: PROTOCOL,
  refusals: CONTRACT_CALL,
  input: protocolContractReadInputSchema,
  output: protocolContractReadOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, signature: 'totalSupply()', args: [] } },
    { verdict: 'refuse', input: { address: ADDRESS, signature: 'f', args: [] } },
    { verdict: 'refuse', input: { address: ADDRESS, signature: 'totalSupply()' } },
  ],
});

export const PROTOCOL_CONTRACT_BUILD_WRITE = defineProcedure({
  ...base,
  name: 'protocol.contract.buildWrite',
  path: 'contract.buildWrite',
  access: PROTOCOL,
  refusals: CONTRACT_CALL,
  input: protocolContractBuildWriteInputSchema,
  output: protocolContractBuildWriteOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, signature: 'transfer(address,uint256)', args: [ADDRESS, '1'] } },
    { verdict: 'accept', input: { address: ADDRESS, signature: 'deposit()', args: [], value: '1000' } },
    { verdict: 'refuse', input: { address: ADDRESS, signature: 'deposit()', args: [], value: '-1' } },
  ],
});

// ── bridge ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_BRIDGE_ROUTES_LIST = defineProcedure({
  ...base,
  name: 'protocol.bridge.routes.list',
  path: 'bridge.routes.list',
  access: PROTOCOL,
  refusals: refusals(
    [[BRIDGE_ROUTES_UNSET], 'PRECONDITION_FAILED'],
    [[BRIDGE_ROUTES_INVALID, BRIDGE_ROUTE_KIND_FORBIDDEN], 'SERVICE_UNAVAILABLE'],
  ),
  input: NO_INPUT,
  output: bridgeRoutesListOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every transfer call: no provider or table, an unreachable chain or attester. */
const BRIDGE_TRANSFER = [
  [[BRIDGE_ROUTES_UNSET, BRIDGE_PROVIDER_UNSET], 'PRECONDITION_FAILED'],
  [[BRIDGE_ROUTES_INVALID, BRIDGE_ROUTE_KIND_FORBIDDEN, BRIDGE_UNREACHABLE], 'SERVICE_UNAVAILABLE'],
] as const;
const WALLET = '0x00000000000000000000000000000000000a11ce';
const TRANSFER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Starts one transfer on a listed route: the intent is stored before anything is signed, and the burn to sign comes
 * back. The same key answers the same transfer. Non-custodial: the wallet signs the burn; nothing posts to the ledger.
 */
export const PROTOCOL_BRIDGE_TRANSFERS_START = defineProcedure({
  ...base,
  kind: 'mutation',
  name: 'protocol.bridge.transfers.start',
  path: 'bridge.transfers.start',
  access: PROTOCOL,
  refusals: refusals(
    ...BRIDGE_TRANSFER,
    [[BRIDGE_ROUTE_UNKNOWN, BRIDGE_AMOUNT_INVALID], 'BAD_REQUEST'],
    [[BRIDGE_KEY_CONFLICT, BRIDGE_TOO_MANY_WAITING], 'CONFLICT'],
  ),
  input: bridgeTransferStartInputSchema,
  output: bridgeTransferSchema,
  samples: [
    {
      verdict: 'accept',
      input: { wallet: WALLET, fromChainId: 84532, toChainId: 31337, asset: 'TUSDC', amount: '1', clientKey: 'bridge-sample-0001' },
    },
    {
      verdict: 'refuse',
      input: { wallet: WALLET, fromChainId: 84532, toChainId: 31337, asset: 'TUSDC', amount: '1', clientKey: 'short' },
    },
  ],
});

/** The burn's hash, once the wallet sent it: checked on the source chain against the transfer's intent before it is kept. */
export const PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED = defineProcedure({
  ...base,
  kind: 'mutation',
  name: 'protocol.bridge.transfers.burnSubmitted',
  path: 'bridge.transfers.burnSubmitted',
  access: PROTOCOL,
  refusals: refusals(...BRIDGE_TRANSFER, [[BRIDGE_TRANSFER_NOT_FOUND], 'NOT_FOUND'], [[BRIDGE_BURN_MISMATCH], 'BAD_REQUEST']),
  input: bridgeTransferBurnInputSchema,
  output: bridgeTransferSchema,
  samples: [
    { verdict: 'accept', input: { wallet: WALLET, id: TRANSFER_ID, txHash: `0x${'ab'.repeat(32)}` } },
    { verdict: 'refuse', input: { wallet: WALLET, id: TRANSFER_ID, txHash: '0x1234' } },
  ],
});

/**
 * A wallet's transfers, each brought up to date from the chains and the provider: a stored intent whose burn is on chain
 * resumes as burn submitted, never a second burn; an attested burn offers its mint; a mint on chain reads minted.
 */
export const PROTOCOL_BRIDGE_TRANSFERS_LIST = defineProcedure({
  ...base,
  name: 'protocol.bridge.transfers.list',
  path: 'bridge.transfers.list',
  access: PROTOCOL,
  refusals: refusals(...BRIDGE_TRANSFER),
  input: bridgeTransfersListInputSchema,
  output: bridgeTransfersListOutputSchema,
  samples: [
    { verdict: 'accept', input: { wallet: WALLET } },
    { verdict: 'refuse', input: { wallet: '0x1234' } },
  ],
});

// ── tokens ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every tokens read: the factory and the quote token are owner settings, and the read is bounded. */
const TOKENS_READ = [AMM_FACTORY_UNSET, TOKENS_QUOTE_UNSET, TOKEN_UNSUPPORTED, TOKENS_READ_TOO_LARGE] as const;

export const PROTOCOL_TOKENS_LIST = defineProcedure({
  ...base,
  name: 'protocol.tokens.list',
  path: 'tokens.list',
  access: PROTOCOL,
  refusals: refusals([[...TOKENS_READ, TOKENS_BLOCK_AHEAD, TOKENS_BLOCK_TOO_OLD], 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: tokensListInputSchema,
  output: tokensListOutputSchema,
  samples: [
    { verdict: 'accept', input: { window: '24h' } },
    { verdict: 'accept', input: { window: '5m', blockNumber: '120' } },
    { verdict: 'refuse', input: { window: '7d' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PROTOCOL_TOKENS_PAGE = defineProcedure({
  ...base,
  name: 'protocol.tokens.page',
  path: 'tokens.page',
  access: PROTOCOL,
  refusals: refusals(
    [[...TOKENS_READ, TOKEN_NOT_LISTED, TOKENS_HOLDERS_INCONSISTENT], 'PRECONDITION_FAILED'],
    [CHAIN, 'SERVICE_UNAVAILABLE'],
  ),
  input: tokenPageInputSchema,
  output: tokenPageOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: { address: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_TOKENS_LEADERBOARD = defineProcedure({
  ...base,
  name: 'protocol.tokens.leaderboard',
  path: 'tokens.leaderboard',
  access: PROTOCOL,
  refusals: refusals([TOKENS_READ, 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: NO_INPUT,
  output: tokensLeaderboardOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_TOKENS_BRIEF = defineProcedure({
  ...base,
  name: 'protocol.tokens.brief',
  path: 'tokens.brief',
  access: PROTOCOL,
  refusals: refusals([TOKENS_READ, 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: NO_INPUT,
  output: tokensBriefOutputSchema,
  samples: [{ verdict: 'accept' }],
});

// ── portfolio ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_PORTFOLIO_READ = defineProcedure({
  ...base,
  name: 'protocol.portfolio.read',
  path: 'portfolio.read',
  access: PROTOCOL,
  refusals: refusals(
    [[PRICE_SETTINGS_UNSET, AMM_FACTORY_UNSET, TOKEN_UNSUPPORTED, TOKENS_READ_TOO_LARGE], 'PRECONDITION_FAILED'],
    [CHAIN, 'SERVICE_UNAVAILABLE'],
  ),
  input: protocolPortfolioInputSchema,
  output: protocolPortfolioOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: { address: NOT_ADDRESS } },
  ],
});

// ── claim links and replacement ───────────────────────────────────────────────────────────────────────────────────────

const CLAIM_READ = refusals([[CLAIM_ESCROW_UNSET], 'PRECONDITION_FAILED'], [CHAIN, 'SERVICE_UNAVAILABLE']);

export const PROTOCOL_CLAIM_LINK_CONFIG = defineProcedure({
  ...base,
  name: 'protocol.claimLink.config',
  path: 'claimLink.config',
  access: PROTOCOL,
  refusals: CLAIM_READ,
  input: NO_INPUT,
  output: protocolClaimLinkConfigOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_CLAIM_LINK_GET = defineProcedure({
  ...base,
  name: 'protocol.claimLink.get',
  path: 'claimLink.get',
  access: PROTOCOL,
  refusals: refusals([[CLAIM_ESCROW_UNSET], 'PRECONDITION_FAILED'], [[CLAIM_LINK_NOT_FOUND], 'NOT_FOUND'], [CHAIN, 'SERVICE_UNAVAILABLE']),
  input: protocolClaimLinkGetInputSchema,
  output: protocolClaimLinkGetOutputSchema,
  samples: [
    { verdict: 'accept', input: { id: ADDRESS } },
    { verdict: 'refuse', input: { id: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_CLAIM_LINK_LIST = defineProcedure({
  ...base,
  name: 'protocol.claimLink.list',
  path: 'claimLink.list',
  access: PROTOCOL,
  refusals: CLAIM_READ,
  input: protocolClaimLinkListInputSchema,
  output: protocolClaimLinkListOutputSchema,
  samples: [
    { verdict: 'accept', input: { sender: ADDRESS } },
    { verdict: 'refuse', input: { sender: NOT_ADDRESS } },
  ],
});

export const PROTOCOL_TX_BUILD_REPLACEMENT = defineProcedure({
  ...base,
  name: 'protocol.tx.buildReplacement',
  path: 'tx.buildReplacement',
  access: PROTOCOL,
  refusals: refusals(
    [[FEE_BUMP_UNSET, FEE_CEILING_UNSET], 'PRECONDITION_FAILED'],
    [[TX_NOT_FOUND], 'NOT_FOUND'],
    [[TX_NOT_YOURS], 'FORBIDDEN'],
    [[TX_FINAL, TX_SPEEDUP_CREATE, FEE_ABOVE_CEILING], 'CONFLICT'],
    [CHAIN, 'SERVICE_UNAVAILABLE'],
  ),
  input: protocolReplacementInputSchema,
  output: protocolReplacementOutputSchema,
  samples: [
    { verdict: 'accept', input: { txHash: TX_HASH, from: ADDRESS, mode: 'speedUp' } },
    { verdict: 'accept', input: { txHash: TX_HASH, from: ADDRESS, mode: 'cancel' } },
    { verdict: 'refuse', input: { txHash: TX_HASH, from: ADDRESS, mode: 'replace' } },
    { verdict: 'refuse', input: { txHash: '0xab', from: ADDRESS, mode: 'cancel' } },
  ],
});

/** Every chain-read record, in the order svc-protocol mounts them. */
export const PROTOCOL_CHAIN_PROCEDURES = [
  PROTOCOL_ESCROW_STATUS,
  PROTOCOL_ESCROW_DEAL,
  PROTOCOL_ESCROW_BUILD,
  PROTOCOL_VENUE_BALANCES,
  PROTOCOL_VENUE_BUILD_DEPOSIT,
  PROTOCOL_VENUE_BUILD_WITHDRAW,
  PROTOCOL_VENUE_ASSET_LINK_REVIEW,
  PROTOCOL_VENUE_READS,
  PROTOCOL_LENDING_POSITION,
  PROTOCOL_CONTRACT_INSPECT,
  PROTOCOL_CONTRACT_READ,
  PROTOCOL_CONTRACT_BUILD_WRITE,
  PROTOCOL_BRIDGE_ROUTES_LIST,
  PROTOCOL_BRIDGE_TRANSFERS_START,
  PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED,
  PROTOCOL_BRIDGE_TRANSFERS_LIST,
  PROTOCOL_TOKENS_LIST,
  PROTOCOL_TOKENS_PAGE,
  PROTOCOL_TOKENS_LEADERBOARD,
  PROTOCOL_TOKENS_BRIEF,
  PROTOCOL_PORTFOLIO_READ,
  PROTOCOL_CLAIM_LINK_CONFIG,
  PROTOCOL_CLAIM_LINK_GET,
  PROTOCOL_CLAIM_LINK_LIST,
  PROTOCOL_TX_BUILD_REPLACEMENT,
] as const;
