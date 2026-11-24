import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { embeddedWalletPasskeySchema } from './protocol-embedded-wallet.js';

/**
 * svc-identity `embeddedWallet.provision` (J-wallet-22): the owner's embedded-wallet provider makes, or returns, the
 * signed-in person's one wallet, bound to their own passkey. svc-identity holds the provider's API key; svc-protocol
 * holds none and calls this during the person's own request, passing the edge-signed principal on unchanged, so the
 * wallet is only ever made for the person whose request it is. The answer carries no key material.
 */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const identityEmbeddedWalletProvisionOutputSchema = z.object({
  /** The provider's own id for the wallet. */
  walletId: z.string().regex(/^[A-Za-z0-9_/-]{1,160}$/),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** The person the provider bound the wallet to: always the caller. */
  ownerRef: z.string().min(1),
});

export const IDENTITY_EMBEDDED_WALLET_PROVISION = defineProcedure({
  ...base,
  name: 'identity.embeddedWallet.provision',
  kind: 'mutation',
  path: 'embeddedWallet.provision',
  access: { caller: 'scope', scope: 'identity:write', person: true },
  refusals: {
    /** svc-identity holds no provider key settings, so no wallet can be made. Nothing was made. */
    'wallet.embedded_provider_unset': 'PRECONDITION_FAILED',
    /** The provider did not answer, or answered with an error. Nothing was made. */
    'wallet.embedded_provider_down': 'SERVICE_UNAVAILABLE',
    /** The provider would not make a wallet with this passkey. Nothing was made. */
    'wallet.embedded_wallet_mismatch': 'CONFLICT',
  },
  input: z.object({ passkey: embeddedWalletPasskeySchema }),
  output: identityEmbeddedWalletProvisionOutputSchema,
  samples: [
    { verdict: 'accept', input: { passkey: { credentialId: 'TEST-credential', publicKey: 'TEST-key', algorithm: -7 } } },
    { verdict: 'refuse', input: { passkey: { credentialId: 'TEST-credential', publicKey: 'TEST-key', algorithm: -8 } } },
    { verdict: 'refuse', input: {} },
  ],
});
