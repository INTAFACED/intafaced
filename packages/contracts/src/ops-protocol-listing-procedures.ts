import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  protocolOpsMarketsListOutputSchema,
  protocolOpsPoolsListOutputSchema,
  protocolOpsReasonCodesOutputSchema,
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
