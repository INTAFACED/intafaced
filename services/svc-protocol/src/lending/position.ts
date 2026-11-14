import { formatUnits, getAddress, parseAbi, type Address, type PublicClient } from 'viem';
import {
  LENDING_MARKET_UNSET,
  protocolLendingPositionInputSchema,
  protocolLendingPositionOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
  type ProtocolLendingPosition,
} from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';

/**
 * One account's position in the isolated lending market (D-portfolio-wallet-04, J-dex-protocol-06 #4).
 *
 * The market is the IsolatedLendingMarket contract (`contracts/lending/IsolatedLendingMarket.sol`): its public
 * `collateralOf` and `debtOf` are the account's collateral and debt, read from the chain at one block. This service keeps
 * no copy and posts nothing to the ledger; it signs and builds nothing.
 *
 * Refuses `protocol.lending_market_unset` when no market is set (`PROTOCOL_LENDING_MARKET_ADDRESS`, an owner setting):
 * nothing is read, and no zero is shown in place of a position.
 */
export const LENDING_POSITION_ABI = parseAbi([
  'function collateralToken() view returns (address)',
  'function borrowToken() view returns (address)',
  'function maxLtvBps() view returns (uint16)',
  'function collateralOf(address) view returns (uint256)',
  'function debtOf(address) view returns (uint256)',
]);
const TOKEN_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

export type LendingChain = Pick<PublicClient, 'readContract' | 'getChainId' | 'getBlockNumber'>;

export interface LendingPositionDeps {
  chain: () => LendingChain;
  /** `PROTOCOL_LENDING_MARKET_ADDRESS`. Null or zero refuses `protocol.lending_market_unset`. */
  market: () => Address | null;
}

export class LendingMarketUnset extends Error {
  readonly code = LENDING_MARKET_UNSET;
  constructor() {
    super(
      `${LENDING_MARKET_UNSET}: the lending market is an owner setting (PROTOCOL_LENDING_MARKET_ADDRESS) that is not set, so no lending position can be read.`,
    );
    this.name = 'LendingMarketUnset';
  }
}

export async function lendingPosition(deps: LendingPositionDeps, accountInput: string): Promise<ProtocolLendingPosition> {
  const configured = deps.market();
  if (configured === null || isZeroAddress(configured)) throw new LendingMarketUnset();
  const market = getAddress(configured);
  const account = getAddress(accountInput);
  const chain = deps.chain();
  const blockNumber = await chain.getBlockNumber();
  const at = <T>(address: Address, abi: typeof LENDING_POSITION_ABI | typeof TOKEN_ABI, functionName: string, args: unknown[] = []) =>
    chain.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
  const [chainId, collateralAddress, borrowAddress, maxLtvBps, collateral, debt] = await Promise.all([
    chain.getChainId(),
    at<Address>(market, LENDING_POSITION_ABI, 'collateralToken'),
    at<Address>(market, LENDING_POSITION_ABI, 'borrowToken'),
    at<number>(market, LENDING_POSITION_ABI, 'maxLtvBps'),
    at<bigint>(market, LENDING_POSITION_ABI, 'collateralOf', [account]),
    at<bigint>(market, LENDING_POSITION_ABI, 'debtOf', [account]),
  ]);
  const facts = async (token: Address) => {
    const [symbol, decimals] = await Promise.all([
      at<string>(token, TOKEN_ABI, 'symbol').catch(() => null),
      at<number>(token, TOKEN_ABI, 'decimals'),
    ]);
    return { address: getAddress(token), symbol, decimals: Number(decimals) };
  };
  const [collateralToken, borrowToken] = await Promise.all([facts(collateralAddress), facts(borrowAddress)]);
  return {
    market,
    chainId,
    account,
    blockNumber: blockNumber.toString(),
    collateralToken,
    borrowToken,
    collateral: formatUnits(collateral, collateralToken.decimals),
    debt: formatUnits(debt, borrowToken.decimals),
    maxLtvBps: Number(maxLtvBps),
  };
}

/** `protocol.lending.*`: public chain reads only, behind the same permissionless guard as the venue's balances. */
export function createLendingRouter(deps: LendingPositionDeps & { toTrpcError: (err: unknown) => TRPCError }) {
  return router({
    position: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolLendingPositionInputSchema)
      .output(protocolLendingPositionOutputSchema)
      .query(async ({ input }) => {
        try {
          return await lendingPosition(deps, input.account);
        } catch (err) {
          if (err instanceof LendingMarketUnset) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
          throw deps.toTrpcError(err);
        }
      }),
  });
}
