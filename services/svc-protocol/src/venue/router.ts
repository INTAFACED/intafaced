import {
  ASSET_LINK_NOT_TOKEN,
  protocolAssetLinkReviewInputSchema,
  protocolAssetLinkReviewOutputSchema,
  protocolVenueReadsOutputSchema,
  VENUE_BAD_AMOUNT,
  VENUE_INSUFFICIENT_FREE,
  VENUE_UNSET,
  protocolVenueBalancesInputSchema,
  protocolVenueBalancesOutputSchema,
  protocolVenueBuildInputSchema,
  protocolVenueBuildOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import { reviewAssetLink, venueReads } from './asset-link.js';
import { buildVenueDeposit, buildVenueWithdraw, venueBalances, VenueFundsRefusal, type VenueFundsDeps } from './funds.js';

const TRPC_CODE: Record<string, TRPCError['code']> = {
  [VENUE_UNSET]: 'PRECONDITION_FAILED',
  [VENUE_BAD_AMOUNT]: 'BAD_REQUEST',
  [VENUE_INSUFFICIENT_FREE]: 'PRECONDITION_FAILED',
  [ASSET_LINK_NOT_TOKEN]: 'BAD_REQUEST',
};

/**
 * `protocol.venue.*` (D-bridge-chain-04): the trading venue's balances for an account, the unsigned deposit and
 * withdraw calls, the asset link review and the contract-read docs. Permissionless like the rest of this plane: chain reads and unsigned calls only, nothing signs or posts.
 */
export function createVenueFundsRouter(deps: VenueFundsDeps & { toTrpcError: (err: unknown) => TRPCError }) {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VenueFundsRefusal)
        throw new TRPCError({ code: TRPC_CODE[err.code] ?? 'CONFLICT', message: err.message, cause: err });
      throw deps.toTrpcError(err);
    }
  };
  const procedure = publicJurisdictionProcedure('protocol', 'protocol');
  return router({
    balances: procedure
      .input(protocolVenueBalancesInputSchema)
      .output(protocolVenueBalancesOutputSchema)
      .query(({ input }) => guard(() => venueBalances(deps, input.account))),
    buildDeposit: procedure
      .input(protocolVenueBuildInputSchema)
      .output(protocolVenueBuildOutputSchema)
      .query(({ input }) => guard(() => buildVenueDeposit(deps, input))),
    buildWithdraw: procedure
      .input(protocolVenueBuildInputSchema)
      .output(protocolVenueBuildOutputSchema)
      .query(({ input }) => guard(() => buildVenueWithdraw(deps, input))),
    /** Whether an ERC-20 is one of the venue's own two assets, with its decimals (J-dex-protocol-05 #10). A read. */
    assetLinkReview: procedure
      .input(protocolAssetLinkReviewInputSchema)
      .output(protocolAssetLinkReviewOutputSchema)
      .query(({ input }) => guard(() => reviewAssetLink(deps, input.token))),
    /** The contract-read docs: the venue's public getters with examples (J-dex-protocol-05 #10). */
    reads: procedure.output(protocolVenueReadsOutputSchema).query(() => guard(() => venueReads(deps))),
  });
}
