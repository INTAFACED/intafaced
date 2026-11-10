import type { Sql } from 'postgres';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  navigatorApprovalsInputSchema,
  navigatorApprovalsSchema,
  navigatorAskInputSchema,
  navigatorAskResultSchema,
  navigatorOnchainAccountInputSchema,
  navigatorOnchainBindInputSchema,
  navigatorOnchainBindingReadSchema,
  navigatorOnchainBindingSchema,
  navigatorOnchainSignerInputSchema,
  navigatorOnchainSignerSchema,
  type NavigatorAskResult,
} from '@intafaced/contracts/agents-onchain';
import { executeProcedure } from '../procedures.js';
import { NAVIGATOR_AGENT_ID } from './session-run.js';
import { NavigatorOnchainError, NavigatorOnchainStore, navigatorAskIsTrade, navigatorSigner, preparedGrant } from './onchain.js';

export interface NavigatorOnchainDeps {
  readonly sql: Sql | undefined;
  /** AGENTS_NAVIGATOR_ONCHAIN_SIGNER: the signer's public address. Blank refuses `rail.crypto`. */
  readonly signer: string | null;
  /** AGENTS_APPROVAL_TTL_SECONDS: how long a held trade ask waits. Blank refuses holding one `agents.approval.ttl_unset`. */
  readonly approvalTtlSeconds: number | null;
  /** The session's owner and agent, or null when there is no such session. */
  readonly session: (sessionId: string) => Promise<{ userId: string; agentId: string; status: string } | null>;
}

const HTTP: Record<NavigatorOnchainError['code'], TRPCError['code']> = {
  'agents.session_key_cap_unset': 'BAD_REQUEST',
  'agents.session_key_expiry_unset': 'BAD_REQUEST',
  'agents.session_key_selector_forbidden': 'FORBIDDEN',
  'agents.onchain_chain_unsupported': 'BAD_REQUEST',
  'agents.onchain_binding_not_found': 'NOT_FOUND',
  'agents.approval.ttl_unset': 'PRECONDITION_FAILED',
  'agents.request_id_replay': 'CONFLICT',
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
 * `navigator.onchain.*`, `navigator.ask` and `navigator.approvals`, spread into the navigator router. The person is the
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
        .query(({ input }) => guard(async () => navigatorSigner(input.chainId, deps.signer))),

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
     * One ask to the Navigator, before anything runs. The Navigator never trades unasked: an ask that names a trade
     * (swap, buy, sell, trade or order, as a whole word) is held as an approval request for the person, and nothing
     * runs, no engine is called and nothing is charged, whether or not a session key is live. Any other ask stores
     * nothing and goes on to the ordinary run.
     */
    ask: executeProcedure()
      .input(navigatorAskInputSchema)
      .output(navigatorAskResultSchema)
      .mutation(({ ctx, input }) =>
        guard(async (): Promise<NavigatorAskResult> => {
          const session = await navigatorSession(input.sessionId, ctx.principal.userId);
          if (session.status !== 'open') throw new TRPCError({ code: 'BAD_REQUEST', message: 'agents.refused.session_closed' });
          if (!navigatorAskIsTrade(input.text)) return { kind: 'none' };
          if (!deps.approvalTtlSeconds) throw new NavigatorOnchainError('agents.approval.ttl_unset');
          const store = storeOf(deps.sql);
          const request = await store.hold({
            userId: ctx.principal.userId,
            sessionId: input.sessionId,
            requestId: input.requestId,
            text: input.text,
            ttlSeconds: deps.approvalTtlSeconds,
          });
          return { kind: 'approval', request, ceiling: await store.holdsUnrevoked(ctx.principal.userId) };
        }),
      ),

    /** The session's held trade asks, newest first: the person's own only. */
    approvals: readProcedure()
      .input(navigatorApprovalsInputSchema)
      .output(navigatorApprovalsSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          await navigatorSession(input.sessionId, ctx.principal.userId);
          return { requests: await storeOf(deps.sql).requests(ctx.principal.userId, input.sessionId) };
        }),
      ),
  };
}
