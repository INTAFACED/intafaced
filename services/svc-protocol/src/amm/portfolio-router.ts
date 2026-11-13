import type { Address } from 'viem';
import {
  PRICE_SETTINGS_UNSET,
  protocolPortfolioInputSchema,
  protocolPortfolioOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';
import { readPortfolio, type PortfolioChain } from './portfolio.js';
import type { PriceSetting } from './prices.js';
import { TokensReadError } from './tokens.js';

export interface PortfolioRouterDeps {
  chain: PortfolioChain;
  /** `PROTOCOL_AMM_FACTORY_ADDRESS`: the factory whose pools list the tokens and price them. Zero refuses. */
  factory: () => Address;
  /** `PROTOCOL_PRICE_USD_TOKENS` and `PROTOCOL_PRICE_MIN_RESERVE_USD`. Null refuses, as `amm.prices` does. */
  priceSetting: () => PriceSetting | null;
  toTrpcError: (err: unknown) => TRPCError;
}

/**
 * `protocol.portfolio.read` (D-portfolio-wallet-04, J-dex-protocol-06): any address's holdings, value, profit and loss,
 * drawdown and transfers, read from the chain. Public chain data behind the same permissionless guard as `amm.prices`:
 * the address asked about is the scope, so no session is read and none is needed. Nothing here can sign or post.
 */
export function createPortfolioRouter(deps: PortfolioRouterDeps) {
  return router({
    read: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolPortfolioInputSchema)
      .output(protocolPortfolioOutputSchema)
      .query(async ({ input }) => {
        const setting = deps.priceSetting();
        if (!setting)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${PRICE_SETTINGS_UNSET}: PROTOCOL_PRICE_USD_TOKENS and PROTOCOL_PRICE_MIN_RESERVE_USD are owner settings; no value is stated until they are set.`,
          });
        const factory = deps.factory();
        if (isZeroAddress(factory))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
          });
        try {
          return await readPortfolio({ chain: deps.chain, factory, setting }, input.address as Address);
        } catch (err) {
          if (err instanceof TokensReadError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
          throw deps.toTrpcError(err);
        }
      }),
  });
}
