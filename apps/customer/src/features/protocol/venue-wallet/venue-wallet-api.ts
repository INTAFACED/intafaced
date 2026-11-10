import {
  PROTOCOL_VENUE_WALLET_REFUSALS,
  protocolVenueWalletAuthorizedOutputSchema,
  protocolVenueWalletChallengeOutputSchema,
  protocolVenueWalletConnectionSchema,
  protocolVenueWalletDisconnectedOutputSchema,
  protocolVenueWalletStatusOutputSchema,
  type ProtocolVenueWalletConnection,
  type VenueWalletAction,
} from '@intafaced/contracts/protocol-venue-wallet';
import { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

export type VenueConnection = ProtocolVenueWalletConnection;

/**
 * svc-protocol's venue wallet connection (J-wallet-09), for the signed-in person. A refusal here is this call's own
 * answer, never proof that the exchange sign-in ended, so none of them signs the person out.
 */
const keepSessionFor = PROTOCOL_VENUE_WALLET_REFUSALS;

export function createVenueWalletApi(api: ApiClient) {
  const call = <T>(procedure: string, input: unknown, schema: z.ZodType<T>) =>
    api.mutate('protocol', procedure, input, schema, { keepSessionFor });
  return {
    status: (signal?: AbortSignal) =>
      api.query('protocol', 'venueWallet.status', undefined, protocolVenueWalletStatusOutputSchema, { keepSessionFor, signal }),
    challenge: (input: { address: string; origin: string }) =>
      call('venueWallet.challenge', input, protocolVenueWalletChallengeOutputSchema),
    open: (input: { challenge: string; signature: string }) => call('venueWallet.open', input, protocolVenueWalletConnectionSchema),
    disconnect: (address: string) => call('venueWallet.disconnect', { address }, protocolVenueWalletDisconnectedOutputSchema),
    /** Checks the connection before a signed venue action: live with its expiry, or its refusal (expired, none). */
    authorize: (address: string, action: VenueWalletAction) =>
      call('venueWallet.authorize', { address, action }, protocolVenueWalletAuthorizedOutputSchema),
  };
}
export type VenueWalletApi = ReturnType<typeof createVenueWalletApi>;
