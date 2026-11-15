import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  protocolEmbeddedWalletCreateInputSchema,
  protocolEmbeddedWalletCreateOutputSchema,
  protocolEmbeddedWalletStatusOutputSchema,
  type ProtocolEmbeddedWalletRefusal,
} from '@intafaced/contracts/protocol-embedded-wallet';
import {
  EMBEDDED_PROVIDER_DOWN,
  EMBEDDED_PROVIDER_UNSET,
  EMBEDDED_PROVIDER_UNWIRED,
  EMBEDDED_WALLET_MISMATCH,
  EmbeddedWalletRefusedError,
  createEmbeddedWallet,
  embeddedWalletStatus,
  type EmbeddedWalletDeps,
  type EmbeddedWalletRow,
  type EmbeddedWalletStore,
} from './embedded.js';

/**
 * `embeddedWallet.*` (J-wallet-22): the signed-in person's own embedded self-custody wallet. Every procedure needs a
 * person (no service caller) and runs the jurisdiction guard first, so a visitor from a blocked region is refused
 * `denied.region_blocked` with its reason before the provider is asked anything. The person comes from the signed
 * principal, never from the input.
 */
export interface EmbeddedWalletRouterDeps extends EmbeddedWalletDeps {
  now?: () => Date;
}

const guard = { module: 'protocol', plane: 'protocol', person: true } as const;

const HTTP_CODE: Record<ProtocolEmbeddedWalletRefusal, TRPCError['code']> = {
  [EMBEDDED_PROVIDER_UNSET]: 'PRECONDITION_FAILED',
  [EMBEDDED_PROVIDER_UNWIRED]: 'PRECONDITION_FAILED',
  [EMBEDDED_PROVIDER_DOWN]: 'SERVICE_UNAVAILABLE',
  [EMBEDDED_WALLET_MISMATCH]: 'CONFLICT',
};

/** The refusal's code leads the message, as the venue wallet's do, so the page can read it. */
export function embeddedWalletTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof EmbeddedWalletRefusedError)
    return new TRPCError({ code: HTTP_CODE[err.code], message: `${err.code}: ${err.message}`, cause: err });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

/** The wire record: the address and the provider's wallet id. There is no key field to fill. */
export const embeddedWalletOut = (row: EmbeddedWalletRow) => ({
  address: row.address,
  providerWalletId: row.providerWalletId,
  provider: row.provider,
  idempotencyKey: row.idempotencyKey,
  createdAt: row.createdAt.toISOString(),
  test: row.test,
  holdsKey: false as const,
});

export function createEmbeddedWalletRouter(deps: EmbeddedWalletRouterDeps) {
  const now = deps.now ?? (() => new Date());
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw embeddedWalletTrpcError(err);
    }
  };
  return router({
    status: scopedProcedure('protocol:read', guard)
      .output(protocolEmbeddedWalletStatusOutputSchema)
      .query(({ ctx }) =>
        guarded(async () => {
          const { provider, wallet } = await embeddedWalletStatus(deps, ctx.principal.userId);
          return { provider, wallet: wallet ? embeddedWalletOut(wallet) : null };
        }),
      ),
    create: scopedProcedure('protocol:read', guard)
      .input(protocolEmbeddedWalletCreateInputSchema)
      .output(protocolEmbeddedWalletCreateOutputSchema)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          const { row, created } = await createEmbeddedWallet(deps, { userId: ctx.principal.userId, passkey: input.passkey }, now());
          return { wallet: embeddedWalletOut(row), created };
        }),
      ),
  });
}

/** A store that is not wired: nobody has a wallet, and making one fails loudly rather than pretending. */
export const unwiredEmbeddedWalletStore: EmbeddedWalletStore = {
  find: async () => null,
  insert: async () => {
    throw new Error('embedded wallet store is not wired');
  },
};
