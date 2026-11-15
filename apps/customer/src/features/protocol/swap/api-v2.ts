import {
  protocolApprovalRouteOutputSchema,
  protocolBuildPermitOutputSchema,
  protocolBuildSwapV2OutputSchema,
  protocolPathOutputSchema,
  protocolSwapV2SettingsSchema,
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
    settings: (signal?: AbortSignal) => api.query('protocol', 'amm.v2Settings', undefined, protocolSwapV2SettingsSchema, { signal }),
    approvalRoute: (input: { owner: string; token: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.approvalRoute', input, protocolApprovalRouteOutputSchema, { signal }),
    buildPermit: (input: ProtocolBuildPermitInput, signal?: AbortSignal) =>
      api.query('protocol', 'amm.buildPermit', input, protocolBuildPermitOutputSchema, { signal }),
    paths: (input: ProtocolPathsInput, signal?: AbortSignal) =>
      api.query('protocol', 'amm.paths', input, protocolPathOutputSchema, { signal }),
    buildSwap: (
      input: Partial<ProtocolBuildSwapV2Input> & Omit<ProtocolBuildSwapV2Input, 'unwrapOut' | 'simulate'>,
      signal?: AbortSignal,
    ) => api.query('protocol', 'amm.buildSwapV2', input, protocolBuildSwapV2OutputSchema, { signal }),
  };
}
export type SwapV2Api = ReturnType<typeof createSwapV2Api>;
