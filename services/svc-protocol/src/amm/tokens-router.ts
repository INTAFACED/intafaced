import type { Address } from 'viem';
import type { TokenBasics } from '@intafaced/contracts';
import { TOKENS_QUOTE_UNSET, TOKEN_NOT_LISTED, TOKEN_UNSUPPORTED } from '@intafaced/contracts/protocol-tokens';
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  PROTOCOL_TOKENS_BRIEF,
  PROTOCOL_TOKENS_LEADERBOARD,
  PROTOCOL_TOKENS_LIST,
  PROTOCOL_TOKENS_PAGE,
} from '@intafaced/contracts/protocol-chain-procedures';
import { isZeroAddress } from '../chain/availability.js';
import { protocolRefusal } from '../refusal.js';
import { leaderboard, marketBrief, tokenPage, tokensList, TokensReadError } from './tokens.js';
import { holdersReader, marketReader, shapeToken, type TokenLogsChain } from './token-reader.js';

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

  async function context(at?: bigint) {
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
    const snap = await readMarket(factory, at);
    const quote =
      snap.tokens.find((t) => t.address.toLowerCase() === quoteAddress.toLowerCase()) ??
      shapeToken<TokenBasics>({ address: quoteAddress, ...(await deps.chain.tokenBasics(quoteAddress)) });
    if (!quote) throw new TokensReadError(TOKEN_UNSUPPORTED, `the quote token ${quoteAddress} claims more decimals than the pages take.`);
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
    list: mountRecord(
      PROTOCOL_TOKENS_LIST,
      ({ input }) =>
        guard(async () => {
          const { snap, quote } = await context(input.blockNumber === undefined ? undefined : BigInt(input.blockNumber));
          return tokensList(snap, quote, input.window);
        }),
      protocolRefusal,
    ),
    page: mountRecord(
      PROTOCOL_TOKENS_PAGE,
      ({ input }) =>
        guard(async () => {
          const { snap, quote } = await context();
          const address = input.address as Address;
          // Only a listed token is read: its holders come from every Transfer it ever emitted, and an address in no pool
          // would let anyone ask for that read on any contract.
          const token = snap.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
          if (!token && snap.unsupported?.includes(address.toLowerCase()))
            throw new TokensReadError(TOKEN_UNSUPPORTED, `${address} claims more decimals than the pages take; it is left out.`);
          if (!token)
            throw new TokensReadError(TOKEN_NOT_LISTED, `${address} is in none of the factory's pools; no token page is read for it.`);
          return tokenPage(snap, quote, token, await readHolders(token.address as Address, snap.blockNumber));
        }),
      protocolRefusal,
    ),
    leaderboard: mountRecord(
      PROTOCOL_TOKENS_LEADERBOARD,
      () =>
        guard(async () => {
          const { snap, quote } = await context();
          return leaderboard(snap, quote);
        }),
      protocolRefusal,
    ),
    /** The market brief: the 24 hours to the head block, from the same read as the 24-hour list; null with no swap. */
    brief: mountRecord(
      PROTOCOL_TOKENS_BRIEF,
      () =>
        guard(async () => {
          const { snap, quote } = await context();
          return marketBrief(snap, quote);
        }),
      protocolRefusal,
    ),
  });
}
