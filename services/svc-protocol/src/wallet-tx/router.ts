import type { Address } from 'viem';
import {
  CLAIM_LINK_NOT_FOUND,
  FEE_BUMP_UNSET,
  FEE_CEILING_UNSET,
  CLAIM_ESCROW_UNSET,
  TX_NOT_FOUND,
  TX_NOT_YOURS,
  protocolClaimLinkConfigOutputSchema,
  protocolClaimLinkGetInputSchema,
  protocolClaimLinkGetOutputSchema,
  protocolClaimLinkListInputSchema,
  protocolClaimLinkListOutputSchema,
  protocolReplacementInputSchema,
  protocolReplacementOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import { claimLinkConfig, getClaimLink, listClaimLinks, requireEscrow, WalletTxRefusal, type ClaimChain } from './claim-link.js';
import { buildReplacement, type ReplacementChain, type ReplacementSetting } from './replacement.js';

export interface WalletTxDeps {
  chain: () => ClaimChain & ReplacementChain;
  /** `PROTOCOL_CLAIM_ESCROW_ADDRESS`. Null or zero refuses `protocol.claim_escrow_unset`. */
  claimEscrow: () => Address | null;
  /** `PROTOCOL_TX_FEE_BUMP_BPS` and `PROTOCOL_TX_FEE_CEILING_WEI`. Null refuses by name. */
  replacement: () => ReplacementSetting;
  /** Shapes a chain failure the way the rest of the router does (unreachable, absent contract). */
  toTrpcError: (err: unknown) => TRPCError;
}

const TRPC_CODE: Record<string, TRPCError['code']> = {
  [CLAIM_ESCROW_UNSET]: 'PRECONDITION_FAILED',
  [FEE_BUMP_UNSET]: 'PRECONDITION_FAILED',
  [FEE_CEILING_UNSET]: 'PRECONDITION_FAILED',
  [CLAIM_LINK_NOT_FOUND]: 'NOT_FOUND',
  [TX_NOT_FOUND]: 'NOT_FOUND',
  [TX_NOT_YOURS]: 'FORBIDDEN',
};

/**
 * `protocol.claimLink.*` (D-swap-12) and `protocol.tx.buildReplacement` (RC-dex-protocol-01): chain reads and one
 * unsigned transaction. Permissionless like the rest of this plane; nothing here can sign, send or post.
 */
export function createWalletTxRouters(deps: WalletTxDeps) {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WalletTxRefusal)
        throw new TRPCError({ code: TRPC_CODE[err.code] ?? 'CONFLICT', message: err.message, cause: err });
      throw deps.toTrpcError(err);
    }
  };
  const procedure = publicJurisdictionProcedure('protocol', 'protocol');
  return {
    claimLink: router({
      config: procedure
        .output(protocolClaimLinkConfigOutputSchema)
        .query(() => guard(async () => claimLinkConfig(deps.chain(), requireEscrow(deps.claimEscrow())))),
      get: procedure
        .input(protocolClaimLinkGetInputSchema)
        .output(protocolClaimLinkGetOutputSchema)
        .query(({ input }) => guard(async () => getClaimLink(deps.chain(), requireEscrow(deps.claimEscrow()), input.id as Address))),
      list: procedure
        .input(protocolClaimLinkListInputSchema)
        .output(protocolClaimLinkListOutputSchema)
        .query(({ input }) => guard(async () => listClaimLinks(deps.chain(), requireEscrow(deps.claimEscrow()), input.sender as Address))),
    }),
    tx: router({
      buildReplacement: procedure
        .input(protocolReplacementInputSchema)
        .output(protocolReplacementOutputSchema)
        .query(({ input }) => guard(async () => buildReplacement(deps.chain(), deps.replacement(), input))),
    }),
  };
}
