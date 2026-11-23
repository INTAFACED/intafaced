import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  protocolOpsMarketsListOutputSchema,
  protocolOpsPoolsListOutputSchema,
  protocolOpsReasonCodesOutputSchema,
  protocolOpsPoolHideInputSchema,
  protocolOpsActionResultSchema,
  protocolOpsPoolRestoreInputSchema,
  protocolOpsMarketDelistInputSchema,
  protocolOpsMarketRestoreInputSchema,
} from './protocol-ops.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `protocolListing.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_PROTOCOL_LISTING_POOLS_LIST = defineProcedure({
  ...base,
  name: 'ops.protocolListing.pools.list',
  kind: 'query',
  path: 'protocolListing.pools.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.protocol_listing_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: protocolOpsPoolsListOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_PROTOCOL_LISTING_MARKETS_LIST = defineProcedure({
  ...base,
  name: 'ops.protocolListing.markets.list',
  kind: 'query',
  path: 'protocolListing.markets.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: protocolOpsMarketsListOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_PROTOCOL_LISTING_REASON_CODES_LIST = defineProcedure({
  ...base,
  name: 'ops.protocolListing.reasonCodes.list',
  kind: 'query',
  path: 'protocolListing.reasonCodes.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.protocol_listing_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: protocolOpsReasonCodesOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_PROTOCOL_LISTING_POOLS_HIDE = defineProcedure({
  ...base,
  name: 'ops.protocolListing.pools.hide',
  kind: 'mutation',
  path: 'protocolListing.pools.hide',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {
    'action_approval.identity_unwired': 'PRECONDITION_FAILED',
    'action_approval.missing': 'PRECONDITION_FAILED',
    'action_approval.not_founders': 'PRECONDITION_FAILED',
    'ops.protocol_listing_storage_unconfigured': 'PRECONDITION_FAILED',
    'protocol.ops_reason_code_unknown': 'PRECONDITION_FAILED',
  },
  input: protocolOpsPoolHideInputSchema,
  output: protocolOpsActionResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        chainId: 1,
        poolAddress: '0x1111111111111111111111111111111111111111',
        reasonCode: 'USDC',
        reason: 'USDC',
        approvalId: 'USDC',
        operationId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_PROTOCOL_LISTING_POOLS_RESTORE = defineProcedure({
  ...base,
  name: 'ops.protocolListing.pools.restore',
  kind: 'mutation',
  path: 'protocolListing.pools.restore',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: protocolOpsPoolRestoreInputSchema,
  output: protocolOpsActionResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: { chainId: 1, poolAddress: '0x1111111111111111111111111111111111111111', approvalId: 'USDC', operationId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_PROTOCOL_LISTING_MARKETS_DELIST = defineProcedure({
  ...base,
  name: 'ops.protocolListing.markets.delist',
  kind: 'mutation',
  path: 'protocolListing.markets.delist',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: protocolOpsMarketDelistInputSchema,
  output: protocolOpsActionResultSchema,
  samples: [
    { verdict: 'accept', input: { symbol: 'USDC', reasonCode: 'USDC', reason: 'USDC', approvalId: 'USDC', operationId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_PROTOCOL_LISTING_MARKETS_RESTORE = defineProcedure({
  ...base,
  name: 'ops.protocolListing.markets.restore',
  kind: 'mutation',
  path: 'protocolListing.markets.restore',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: protocolOpsMarketRestoreInputSchema,
  output: protocolOpsActionResultSchema,
  samples: [
    { verdict: 'accept', input: { symbol: 'USDC', approvalId: 'USDC', operationId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
