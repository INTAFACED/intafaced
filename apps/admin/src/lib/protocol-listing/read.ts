import 'server-only';
import { type FounderCallContext, partFrom, type Part, founderRecordCall } from '@/lib/desk';
import {
  OPS_PROTOCOL_LISTING_POOLS_LIST,
  OPS_PROTOCOL_LISTING_MARKETS_LIST,
  OPS_PROTOCOL_LISTING_REASON_CODES_LIST,
} from '@intafaced/contracts/ops-protocol-listing-procedures';

type Hidden = { reasonCode: string; reason: string; approvalId: string; policyVersion: string; at: string };
type State = 'visible' | 'hidden' | 'applying';
export interface ProtocolOpsPoolsListOutput {
  asOf: string;
  pools: { chainId: number; poolAddress: string; state: State; hidden: Hidden | null }[];
}
export interface ProtocolOpsMarketsListOutput {
  asOf: string;
  markets: { symbol: string; state: State; hidden: Hidden | null }[];
}

export interface ProtocolOpsReasonCodesOutput {
  asOf: string;
  source: 'default' | 'env' | 'admin';
  codes: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ProtocolListingRead {
  readonly asOf: string;
  readonly pools: Part<ProtocolOpsPoolsListOutput>;
  readonly markets: Part<ProtocolOpsMarketsListOutput>;
  readonly reasonCodes: Part<ProtocolOpsReasonCodesOutput>;
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'ops.protocol_listing_storage_unconfigured':
    'svc-ops has no durable storage for listing decisions on this deployment, so nothing can be read or changed.',
};

const options = (what: string) => ({
  service: 'svc-ops',
  forbiddenMessage: `svc-ops did not accept this founder session for the ${what}. It needs the operator read permission (admin:read).`,
  refusedMessage: (code: string | null) => (code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null),
});

/** The pools and markets INTAFACED has decided about, from svc-ops as the signed-in founder. A failed read says why and shows no rows. */
export async function readProtocolListing(ctx: FounderCallContext): Promise<ProtocolListingRead> {
  const [pools, markets, reasonCodes] = await Promise.all([
    founderRecordCall(ctx, OPS_PROTOCOL_LISTING_POOLS_LIST, undefined),
    founderRecordCall(ctx, OPS_PROTOCOL_LISTING_MARKETS_LIST, undefined),
    founderRecordCall(ctx, OPS_PROTOCOL_LISTING_REASON_CODES_LIST, undefined),
  ]);
  return {
    asOf: new Date().toISOString(),
    pools: partFrom(pools, (d) => d, options('pool list')),
    markets: partFrom(markets, (d) => d, options('market list')),
    reasonCodes: partFrom(reasonCodes, (d) => d, options('reason code list')),
  };
}
