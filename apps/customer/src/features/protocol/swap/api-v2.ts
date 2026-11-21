import {
  PROTOCOL_AMM_APPROVAL_ROUTE,
  PROTOCOL_AMM_BUILD_PERMIT,
  PROTOCOL_AMM_BUILD_SWAP_V2,
  PROTOCOL_AMM_PATHS,
  PROTOCOL_AMM_V2_SETTINGS,
} from '@intafaced/contracts/protocol-amm-procedures';
import {
  type ProtocolBuildPermitInput,
  type ProtocolBuildSwapV2Input,
  type ProtocolPathsInput,
} from '@intafaced/contracts/protocol-swap-v2';
import type { ApiClient } from '../../../shared/api';

/**
 * The router v2 swap's reads (D-swap-03, D-swap-intents-01, -02): its deployment, how a token may be approved, the
 * permits to sign, the best path for a number of hops, and the one call the wallet sends. Each refuses by name.
 */
export function createSwapV2Api(api: ApiClient) {
  return {
    settings: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_V2_SETTINGS, undefined, { signal }),
    approvalRoute: (input: { owner: string; token: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_APPROVAL_ROUTE, input, { signal }),
    buildPermit: (input: ProtocolBuildPermitInput, signal?: AbortSignal) => api.call(PROTOCOL_AMM_BUILD_PERMIT, input, { signal }),
    paths: (input: ProtocolPathsInput, signal?: AbortSignal) => api.call(PROTOCOL_AMM_PATHS, input, { signal }),
    buildSwap: (
      input: Partial<ProtocolBuildSwapV2Input> & Omit<ProtocolBuildSwapV2Input, 'unwrapOut' | 'simulate'>,
      signal?: AbortSignal,
    ) => api.call(PROTOCOL_AMM_BUILD_SWAP_V2, input, { signal }),
  };
}
export type SwapV2Api = ReturnType<typeof createSwapV2Api>;
