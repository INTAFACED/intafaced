import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  protocolVenueWalletAddressInputSchema,
  protocolVenueWalletAuthorizeInputSchema,
  protocolVenueWalletChallengeInputSchema,
  protocolVenueWalletChallengeOutputSchema,
  protocolVenueWalletConnectionSchema,
  protocolVenueWalletDisconnectedOutputSchema,
  protocolVenueWalletOpenInputSchema,
  protocolVenueWalletStatusOutputSchema,
} from '@intafaced/contracts/protocol-venue-wallet';
import { getAddress as toChecksum } from 'viem';
import { WALLET_SESSION_UNSET, WALLET_SIGNATURE_NOT_OWNER } from '../address-book/session.js';
import {
  VENUE_CHALLENGE_USED,
  VENUE_CONNECTION_EXPIRED,
  VENUE_CONNECTION_NONE,
  VENUE_CONNECTION_TTL_UNSET,
  VENUE_UNWIRED,
  VenueConnectionRefusedError,
  WALLET_SANCTIONED,
  WALLET_SANCTIONS_UNSET,
  authorizeVenueAction,
  connectionStatus,
  issueVenueChallenge,
  openVenueConnection,
  type VenueConnectionDeps,
  type VenueConnectionRefusalCode,
  type VenueConnectionRecord,
  type VenueConnectionStore,
} from './connection.js';

/**
 * `venueWallet.*` (J-wallet-09): a signed-in person's own wallet connected to their account. Every procedure needs a
 * person (no service caller) and runs the jurisdiction guard first, so a visitor from a blocked region is refused
 * `denied.region_blocked` with its reason before a message is written. The person comes from the signed principal, never
 * from the input; the wallet's ownership comes from its own signature.
 */
export interface VenueWalletRouterDeps extends VenueConnectionDeps {
  now?: () => Date;
}

const guard = { module: 'protocol', plane: 'protocol', person: true } as const;

/** How each refusal reaches the wire. Unlisted codes (an invalid challenge, an unlisted origin) are BAD_REQUEST. */
const HTTP_CODE: Partial<Record<VenueConnectionRefusalCode, TRPCError['code']>> = {
  [WALLET_SESSION_UNSET]: 'PRECONDITION_FAILED',
  [VENUE_CONNECTION_TTL_UNSET]: 'PRECONDITION_FAILED',
  [WALLET_SANCTIONS_UNSET]: 'PRECONDITION_FAILED',
  [VENUE_CONNECTION_NONE]: 'PRECONDITION_FAILED',
  [VENUE_CONNECTION_EXPIRED]: 'PRECONDITION_FAILED',
  [VENUE_UNWIRED]: 'PRECONDITION_FAILED',
  [WALLET_SANCTIONED]: 'FORBIDDEN',
  [WALLET_SIGNATURE_NOT_OWNER]: 'FORBIDDEN',
  [VENUE_CHALLENGE_USED]: 'CONFLICT',
};

/** The refusal's code leads the message, as the wallet session's do, so the page can read it. */
export function venueWalletTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof VenueConnectionRefusedError) {
    const code = HTTP_CODE[err.code] ?? 'BAD_REQUEST';
    return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

const out = (row: VenueConnectionRecord, now: Date) => ({
  address: row.address,
  chainId: row.chainId,
  connectedAt: row.connectedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  status: connectionStatus(row, now),
  holdsKey: false as const,
});

export function createVenueWalletRouter(deps: VenueWalletRouterDeps) {
  const now = deps.now ?? (() => new Date());
  const guarded = async <T>(work: () => Promise<T> | T): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw venueWalletTrpcError(err);
    }
  };
  return router({
    challenge: scopedProcedure('protocol:read', guard)
      .input(protocolVenueWalletChallengeInputSchema)
      .output(protocolVenueWalletChallengeOutputSchema)
      .mutation(({ ctx, input }) =>
        guarded(() => {
          const issued = issueVenueChallenge(deps, { userId: ctx.principal.userId, ...input }, now());
          return { message: issued.message, challenge: issued.challenge, expiresAt: issued.expiresAt.toISOString() };
        }),
      ),
    open: scopedProcedure('protocol:read', guard)
      .input(protocolVenueWalletOpenInputSchema)
      .output(protocolVenueWalletConnectionSchema)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          const at = now();
          return out(await openVenueConnection(deps, { userId: ctx.principal.userId, ...input }, at), at);
        }),
      ),
    status: scopedProcedure('protocol:read', guard)
      .output(protocolVenueWalletStatusOutputSchema)
      .query(({ ctx }) =>
        guarded(async () => {
          const at = now();
          const rows = await deps.store.list(ctx.principal.userId, deps.chainId());
          return { connections: rows.map((row) => out(row, at)) };
        }),
      ),
    disconnect: scopedProcedure('protocol:read', guard)
      .input(protocolVenueWalletAddressInputSchema)
      .output(protocolVenueWalletDisconnectedOutputSchema)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          const address = toChecksum(input.address);
          // Disconnecting a wallet that is not connected answers the same: the end state is the one asked for.
          await deps.store.revoke(ctx.principal.userId, deps.chainId(), address, now());
          return { address, disconnected: true as const };
        }),
      ),
    authorize: scopedProcedure('protocol:read', guard)
      .input(protocolVenueWalletAuthorizeInputSchema)
      .mutation(({ ctx, input }) => guarded(() => authorizeVenueAction(deps, { userId: ctx.principal.userId, ...input }, now()))),
  });
}

/** A connection store that is not wired: nothing is connected, and connecting fails loudly rather than pretending. */
export const unwiredVenueConnectionStore: VenueConnectionStore = {
  open: async () => {
    throw new Error('venue connection store is not wired');
  },
  list: async () => [],
  find: async () => null,
  revoke: async () => false,
};
