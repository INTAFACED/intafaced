import { PROTOCOL_EMBEDDED_WALLET_REFUSALS, type EmbeddedWalletPasskey } from '@intafaced/contracts/protocol-embedded-wallet';
import { PROTOCOL_EMBEDDED_WALLET_CREATE, PROTOCOL_EMBEDDED_WALLET_STATUS } from '@intafaced/contracts/protocol-wallet-procedures';
import type { ApiClient } from '../../../shared/api';

/**
 * svc-protocol's embedded self-custody wallet (J-wallet-22), for the signed-in person: the provider named, and the
 * person's one wallet as INTAFACED records it (the address and the provider's wallet id). A refusal here is this call's
 * own answer, never proof that the exchange sign-in ended, so none of them signs the person out.
 */
const keepSessionFor = PROTOCOL_EMBEDDED_WALLET_REFUSALS;

export function createEmbeddedWalletApi(api: ApiClient) {
  return {
    status: (signal?: AbortSignal) => api.call(PROTOCOL_EMBEDDED_WALLET_STATUS, undefined, { keepSessionFor, signal }),
    /** Makes the person's one wallet, or answers the one they have. The passkey is public: an id and a public key. */
    create: (passkey: EmbeddedWalletPasskey) => api.call(PROTOCOL_EMBEDDED_WALLET_CREATE, { passkey }, { keepSessionFor }),
  };
}
export type EmbeddedWalletApi = ReturnType<typeof createEmbeddedWalletApi>;
