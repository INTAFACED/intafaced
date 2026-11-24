import {
  PROTOCOL_VENUE_WALLET_REFUSALS,
  type ProtocolVenueWalletConnection,
  type VenueWalletAction,
} from '@intafaced/contracts/protocol-venue-wallet';
import {
  PROTOCOL_VENUE_WALLET_AUTHORIZE,
  PROTOCOL_VENUE_WALLET_CHALLENGE,
  PROTOCOL_VENUE_WALLET_DISCONNECT,
  PROTOCOL_VENUE_WALLET_OPEN,
  PROTOCOL_VENUE_WALLET_STATUS,
} from '@intafaced/contracts/protocol-wallet-procedures';
import type { ApiClient } from '../../../shared/api';

export type VenueConnection = ProtocolVenueWalletConnection;

/**
 * svc-protocol's venue wallet connection (J-wallet-09), for the signed-in person. A refusal here is this call's own
 * answer, never proof that the exchange sign-in ended, so none of them signs the person out.
 */
const keepSessionFor = PROTOCOL_VENUE_WALLET_REFUSALS;

export function createVenueWalletApi(api: ApiClient) {
  return {
    status: (signal?: AbortSignal) => api.call(PROTOCOL_VENUE_WALLET_STATUS, undefined, { keepSessionFor, signal }),
    challenge: (input: { address: string; origin: string }) => api.call(PROTOCOL_VENUE_WALLET_CHALLENGE, input, { keepSessionFor }),
    open: (input: { challenge: string; signature: string }) => api.call(PROTOCOL_VENUE_WALLET_OPEN, input, { keepSessionFor }),
    disconnect: (address: string) => api.call(PROTOCOL_VENUE_WALLET_DISCONNECT, { address }, { keepSessionFor }),
    /** Checks the connection before a signed venue action: live with its expiry, or its refusal (expired, none). */
    authorize: (address: string, action: VenueWalletAction) =>
      api.call(PROTOCOL_VENUE_WALLET_AUTHORIZE, { address, action }, { keepSessionFor }),
  };
}
export type VenueWalletApi = ReturnType<typeof createVenueWalletApi>;
