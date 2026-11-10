import type { Sql } from 'postgres';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  navigatorAskInputSchema,
  navigatorAskResultSchema,
  navigatorOnchainAccountInputSchema,
  navigatorOnchainBindInputSchema,
  navigatorOnchainBindingReadSchema,
  navigatorOnchainBindingSchema,
  navigatorOnchainSignerInputSchema,
  navigatorOnchainSignerSchema,
  navigatorOrdersInputSchema,
  navigatorOrdersSchema,
  navigatorTradingSchema,
  type NavigatorAskResult,
} from '@intafaced/contracts/agents-onchain';
import { executeProcedure } from '../procedures.js';
import { NAVIGATOR_AGENT_ID } from './session-run.js';
import { NavigatorOnchainError, NavigatorOnchainStore, navigatorAskIsTrade, navigatorSigner, preparedGrant } from './onchain.js';
import { navigatorTrade, navigatorTrading, type NavigatorChain, type NavigatorMarket, type NavigatorSender } from './onchain-trade.js';
import { navigatorAskMovesMoneyOut } from '@intafaced/contracts/agents-onchain';

export interface NavigatorOnchainDeps {
  readonly sql: Sql | undefined;
  /** AGENTS_NAVIGATOR_ONCHAIN_SIGNER: the signer's public address. Blank refuses `rail.crypto`. */
  readonly signer: string | null;
  /** AGENTS_NAVIGATOR_ONCHAIN_SENDER_URL's signer: takes the session call. Blank refuses a trade `rail.crypto`. */
  readonly sender: NavigatorSender | null;
  /** AGENTS_NAVIGATOR_ONCHAIN_MARKET. Blank refuses a trade `agents.navigator_market_unset`. */
  readonly market: NavigatorMarket | null;
  /** The chain reads, on AGENTS_NAVIGATOR_ONCHAIN_RPC_URL. Blank refuses a trade `agents.navigator_market_unset`. */
  readonly chain: NavigatorChain | null;
  /** The session's owner and agent, or null when there is no such session. */
  readonly session: (sessionId: string) => Promise<{ userId: string; agentId: string; status: string } | null>;
}

const HTTP: Record<NavigatorOnchainError['code'], TRPCError['code']> = {
  'agents.session_key_cap_unset': 'BAD_REQUEST',
  'agents.session_key_expiry_unset': 'BAD_REQUEST',
  'agents.session_key_selector_forbidden': 'FORBIDDEN',
  'agents.onchain_chain_unsupported': 'BAD_REQUEST',
  'agents.onchain_binding_not_found': 'NOT_FOUND',
  'agents.request_id_replay': 'CONFLICT',
  'agents.navigator_money_out_forbidden': 'FORBIDDEN',
  'agents.navigator_trade_over_cap': 'FORBIDDEN',
  'agents.navigator_no_live_key': 'PRECONDITION_FAILED',
  'agents.navigator_trade_unparsed': 'BAD_REQUEST',
  'agents.navigator_trade_cap_unit': 'BAD_REQUEST',
  'agents.navigator_trade_out_of_scope': 'FORBIDDEN',
  'agents.navigator_market_unset': 'PRECONDITION_FAILED',
  'agents.navigator_trade_unquoted': 'PRECONDITION_FAILED',
  'rail.crypto': 'PRECONDITION_FAILED',
  'audit.external': 'PRECONDITION_FAILED',
};

/** The refusal's code is the error's message, as the other svc-agents routes answer; its field rides in the cause. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NavigatorOnchainError) throw new TRPCError({ code: HTTP[err.code], message: err.code, cause: err });
    throw err;
  }
}

function storeOf(sql: Sql | undefined): NavigatorOnchainStore {
  if (!sql) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agents.capability_unavailable' });
  return new NavigatorOnchainStore(sql);
}

/**
 * `navigator.onchain.*`, `navigator.ask`, `navigator.orders` and `navigator.trading`, spread into the navigator router. The person is the
 * signed principal, never the body; every row read or written is theirs.
 */
export function navigatorOnchainRoutes(deps: NavigatorOnchainDeps) {
  const readProcedure = () => scopedProcedure('agents:read', { module: 'agents' });
  /** The person's own Navigator session; another person's, another agent's or none read the same: not found. */
  async function navigatorSession(sessionId: string, userId: string) {
    const session = await deps.session(sessionId);
    if (!session || session.userId !== userId || session.agentId !== NAVIGATOR_AGENT_ID) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'agents.refused.session_closed' });
    }
    return session;
  }

  return {
    onchain: router({
      /** The Navigator's signer on this chain: a public address on the test network; mainnet and blank refuse by name. */
      signer: readProcedure()
        .input(navigatorOnchainSignerInputSchema)
        .output(navigatorOnchainSignerSchema)
        .query(({ input }) =>
          guard(async () => ({
            ...navigatorSigner(input.chainId, deps.signer),
            pools: deps.market?.pools.map((p) => p.toLowerCase()) ?? [],
            router: deps.market?.router.toLowerCase() ?? null,
          })),
        ),

      /** Records the grant the person prepared for the Navigator's key. Nothing is granted here: their wallet signs it. */
      bind: executeProcedure()
        .input(navigatorOnchainBindInputSchema)
        .output(navigatorOnchainBindingSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { signer } = navigatorSigner(input.chainId, deps.signer);
            const grant = preparedGrant(input);
            return storeOf(deps.sql).bind({
              userId: ctx.principal.userId,
              chainId: input.chainId,
              account: input.account,
              sessionKey: signer,
              spendLimitWei: grant.spendLimitWei,
              validUntil: grant.validUntil,
              targets: input.targets,
              selectors: input.selectors,
              specHash: input.specHash,
            });
          }),
        ),

      /** Marks the binding revoking, once. The chain says when it is revoked, after the person signs the revoke. */
      revoke: executeProcedure()
        .input(navigatorOnchainAccountInputSchema)
        .output(navigatorOnchainBindingSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { signer } = navigatorSigner(input.chainId, deps.signer);
            return storeOf(deps.sql).requestRevoke(ctx.principal.userId, input.chainId, input.account, signer);
          }),
        ),

      binding: readProcedure()
        .input(navigatorOnchainAccountInputSchema)
        .output(navigatorOnchainBindingReadSchema)
        .query(({ ctx, input }) =>
          guard(async () => {
            const { signer } = navigatorSigner(input.chainId, deps.signer);
            return { binding: await storeOf(deps.sql).binding(ctx.principal.userId, input.chainId, input.account, signer) };
          }),
        ),
    }),

    /**
     * One ask to the Navigator, before anything runs. An ask to move money out is refused by name. An ask that names a
     * trade (swap, buy, sell, trade or order, as a whole word) is the Navigator's to place inside the cap the person
     * signed for its session key: inside the cap it is sent once, with no approval asked, and tagged as placed by the
     * assistant; above the cap, or with no live key, it is refused by name before anything is signed. No engine is called
     * and nothing is charged for it. Any other ask stores nothing and goes on to the ordinary run.
     */
    ask: executeProcedure()
      .input(navigatorAskInputSchema)
      .output(navigatorAskResultSchema)
      .mutation(({ ctx, input }) =>
        guard(async (): Promise<NavigatorAskResult> => {
          const session = await navigatorSession(input.sessionId, ctx.principal.userId);
          if (session.status !== 'open') throw new TRPCError({ code: 'BAD_REQUEST', message: 'agents.refused.session_closed' });
          if (!navigatorAskIsTrade(input.text) && !navigatorAskMovesMoneyOut(input.text)) return { kind: 'none' };
          const order = await navigatorTrade(
            { store: storeOf(deps.sql), signer: deps.signer, sender: deps.sender, market: deps.market, chain: deps.chain },
            { userId: ctx.principal.userId, sessionId: input.sessionId, requestId: input.requestId, text: input.text },
          );
          return { kind: 'order', order };
        }),
      ),

    /** The orders the Navigator placed in the session, newest first: the person's own only. */
    orders: readProcedure()
      .input(navigatorOrdersInputSchema)
      .output(navigatorOrdersSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          await navigatorSession(input.sessionId, ctx.principal.userId);
          return { orders: await storeOf(deps.sql).orders(ctx.principal.userId, input.sessionId) };
        }),
      ),

    /** The person's live Navigator key: the cap they signed, read from the chain, and what its orders hold. Null with none. */
    trading: readProcedure()
      .output(navigatorTradingSchema)
      .query(({ ctx }) =>
        guard(async () =>
          navigatorTrading(
            { store: storeOf(deps.sql), signer: deps.signer, sender: deps.sender, market: deps.market, chain: deps.chain },
            ctx.principal.userId,
          ),
        ),
      ),
  };
}
