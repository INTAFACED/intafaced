import { router, TRPCError } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { BRIDGE_ROUTES_UNSET } from '@intafaced/contracts/protocol-bridge';
import { PROTOCOL_BRIDGE_ROUTES_LIST } from '@intafaced/contracts/protocol-chain-procedures';
import { protocolRefusal } from '../refusal.js';
import { BridgeRoutesError, listBridgeRoutes } from './routes.js';

/**
 * `bridge.*` (D-bridge-chain-03). Public and read only: the route table the owner published. Building a burn, the
 * attestation and the mint wait on the owner's decision on bridging scope and provider, so nothing here signs, holds a key
 * or posts to the ledger.
 */
export function createBridgeRouter(deps: { loadRoutes?: (() => unknown) | undefined } = {}) {
  return router({
    routes: router({
      list: mountRecord(
        PROTOCOL_BRIDGE_ROUTES_LIST,
        () => {
          try {
            return { routes: listBridgeRoutes(deps.loadRoutes) };
          } catch (err) {
            if (err instanceof BridgeRoutesError)
              throw new TRPCError({
                code: err.code === BRIDGE_ROUTES_UNSET ? 'PRECONDITION_FAILED' : 'SERVICE_UNAVAILABLE',
                message: err.message,
                cause: err,
              });
            throw err;
          }
        },
        protocolRefusal,
      ),
    }),
  });
}
