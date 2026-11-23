/**
 * Health never probes the chain. `chainStatus` does.
 *
 * `ok: true, chainId: 31337` sold Anvil's env default as a live chain. Process
 * liveness stays `ok: true`. Configured / unprobed is not chain ok — no
 * `chainId` field, `observedChainId` is null.
 *
 * Do not stamp a custodial literal. Health/ok is liveness, not a certified
 * non-custodial plane.
 */
import { PROTOCOL_CHAIN_UNPROBED, type ProtocolHealthHonesty } from '@intafaced/contracts/protocol-blockers';

/** The wire shape is the `protocol.health` record's (`@intafaced/contracts/protocol-procedures`). */
export { PROTOCOL_CHAIN_UNPROBED, type ProtocolHealthHonesty };

export function protocolHealthHonesty(input: {
  relayEnabled: boolean;
  factoryConfigured: boolean;
  venueVaultConfigured?: boolean;
}): ProtocolHealthHonesty {
  return {
    ok: true,
    service: 'svc-protocol',
    relayEnabled: input.relayEnabled,
    factoryConfigured: input.factoryConfigured,
    ...(input.venueVaultConfigured === undefined ? {} : { venueVaultConfigured: input.venueVaultConfigured }),
    chain: {
      status: 'unprobed',
      code: PROTOCOL_CHAIN_UNPROBED,
      observedChainId: null,
    },
  };
}
