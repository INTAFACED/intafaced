import { ASSET_LINK_NOT_TOKEN, router, TRPCError, VENUE_BAD_AMOUNT, VENUE_INSUFFICIENT_FREE, VENUE_UNSET } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  PROTOCOL_VENUE_ASSET_LINK_REVIEW,
  PROTOCOL_VENUE_BALANCES,
  PROTOCOL_VENUE_BUILD_DEPOSIT,
  PROTOCOL_VENUE_BUILD_WITHDRAW,
  PROTOCOL_VENUE_READS,
} from '@intafaced/contracts/protocol-chain-procedures';
import { protocolRefusal } from '../refusal.js';
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
  return router({
    balances: mountRecord(PROTOCOL_VENUE_BALANCES, ({ input }) => guard(() => venueBalances(deps, input.account)), protocolRefusal),
    buildDeposit: mountRecord(PROTOCOL_VENUE_BUILD_DEPOSIT, ({ input }) => guard(() => buildVenueDeposit(deps, input)), protocolRefusal),
    buildWithdraw: mountRecord(PROTOCOL_VENUE_BUILD_WITHDRAW, ({ input }) => guard(() => buildVenueWithdraw(deps, input)), protocolRefusal),
    /** Whether an ERC-20 is one of the venue's own two assets, with its decimals (J-dex-protocol-05 #10). A read. */
    assetLinkReview: mountRecord(
      PROTOCOL_VENUE_ASSET_LINK_REVIEW,
      ({ input }) => guard(() => reviewAssetLink(deps, input.token)),
      protocolRefusal,
    ),
    /** The contract-read docs: the venue's public getters with examples (J-dex-protocol-05 #10). */
    reads: mountRecord(PROTOCOL_VENUE_READS, () => guard(() => venueReads(deps)), protocolRefusal),
  });
}
