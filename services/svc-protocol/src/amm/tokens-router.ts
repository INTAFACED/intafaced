import type { Address } from 'viem';
import {
  publicJurisdictionProcedure,
  router,
  TRPCError,
  TOKENS_QUOTE_UNSET,
  tokenPageInputSchema,
  tokenPageOutputSchema,
  tokensLeaderboardOutputSchema,
  tokensListInputSchema,
  tokensListOutputSchema,
  type TokenBasics,
} from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';
import { leaderboard, tokenPage, tokensList, TokensReadError } from './tokens.js';
import { holdersReader, marketReader, type TokenLogsChain } from './token-reader.js';

export interface TokensRouterDeps {
  chain: TokenLogsChain;
  /** `PROTOCOL_AMM_FACTORY_ADDRESS`: the factory whose pools are the token list. Zero refuses. */
  factory: () => Address;
  /** `PROTOCOL_TOKENS_QUOTE_TOKEN`: the token prices and volumes are stated in. An owner setting; null refuses. */
  quoteToken: () => Address | null;
  /** Shapes a chain refusal the way the rest of the router does. */
  toTrpcError: (err: unknown) => TRPCError;
}

/**
 * `protocol.tokens.*`: the token list, a token's page and the wallet leaderboard, all read from the configured factory's
 * pools at one block (D-portfolio-wallet-06, -07, D-launch-listing-02, -04, D-explorer-05). Public chain data behind
 * the same permissionless guard as `amm.pairs`; nothing here can sign or post.
 */
export function createTokensRouter(deps: TokensRouterDeps) {
  const readMarket = marketReader(deps.chain);
  const readHolders = holdersReader(deps.chain);

  async function context() {
    const factory = deps.factory();
    if (isZeroAddress(factory))
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
      });
    const quoteAddress = deps.quoteToken();
    if (quoteAddress === null)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${TOKENS_QUOTE_UNSET}: PROTOCOL_TOKENS_QUOTE_TOKEN is an owner setting; no price is stated until it is set.`,
      });
    const snap = await readMarket(factory);
    const quote: TokenBasics = snap.tokens.find((t) => t.address.toLowerCase() === quoteAddress.toLowerCase()) ?? {
      address: quoteAddress,
      ...(await deps.chain.tokenBasics(quoteAddress)),
    };
    return { snap, quote };
  }

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TokensReadError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      throw deps.toTrpcError(err);
    }
  };

  return router({
    list: publicJurisdictionProcedure('protocol', 'protocol')
      .input(tokensListInputSchema)
      .output(tokensListOutputSchema)
      .query(({ input }) =>
        guard(async () => {
          const { snap, quote } = await context();
          return tokensList(snap, quote, input.window);
        }),
      ),
    page: publicJurisdictionProcedure('protocol', 'protocol')
      .input(tokenPageInputSchema)
      .output(tokenPageOutputSchema)
      .query(({ input }) =>
        guard(async () => {
          const { snap, quote } = await context();
          const address = input.address as Address;
          const token = snap.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? {
            address,
            ...(await deps.chain.tokenBasics(address)),
          };
          return tokenPage(snap, quote, token, await readHolders(address, snap.blockNumber));
        }),
      ),
    leaderboard: publicJurisdictionProcedure('protocol', 'protocol')
      .output(tokensLeaderboardOutputSchema)
      .query(() =>
        guard(async () => {
          const { snap, quote } = await context();
          return leaderboard(snap, quote);
        }),
      ),
  });
}
