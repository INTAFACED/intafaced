import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  BRIDGE_AMOUNT_INVALID,
  BRIDGE_BURN_MISMATCH,
  BRIDGE_KEY_CONFLICT,
  BRIDGE_PROVIDER_UNSET,
  BRIDGE_ROUTE_UNKNOWN,
  BRIDGE_ROUTES_UNSET,
  BRIDGE_TOO_MANY_WAITING,
  BRIDGE_TRANSFER_NOT_FOUND,
} from '@intafaced/contracts/protocol-bridge';
import {
  PROTOCOL_BRIDGE_ROUTES_LIST,
  PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED,
  PROTOCOL_BRIDGE_TRANSFERS_LIST,
  PROTOCOL_BRIDGE_TRANSFERS_START,
} from '@intafaced/contracts/protocol-chain-procedures';
import { protocolRefusal } from '../refusal.js';
import { BridgeRoutesError, listBridgeRoutes } from './routes.js';
import {
  BridgeTransferError,
  burnSubmitted,
  listTransfers,
  startTransfer,
  type BridgeProvider,
  type BridgeTransfersDeps,
  type BridgeTransferStore,
} from './transfers.js';

const STATUS: Record<string, TRPCError['code']> = {
  [BRIDGE_ROUTES_UNSET]: 'PRECONDITION_FAILED',
  [BRIDGE_PROVIDER_UNSET]: 'PRECONDITION_FAILED',
  [BRIDGE_ROUTE_UNKNOWN]: 'BAD_REQUEST',
  [BRIDGE_AMOUNT_INVALID]: 'BAD_REQUEST',
  [BRIDGE_BURN_MISMATCH]: 'BAD_REQUEST',
  [BRIDGE_TRANSFER_NOT_FOUND]: 'NOT_FOUND',
  [BRIDGE_KEY_CONFLICT]: 'CONFLICT',
  [BRIDGE_TOO_MANY_WAITING]: 'CONFLICT',
};

/** A bridge refusal leaves with its code leading the message, as the record lists it; anything else goes on as thrown. */
function bridgeTrpcError(err: unknown): unknown {
  if (err instanceof BridgeRoutesError || err instanceof BridgeTransferError)
    return new TRPCError({ code: STATUS[err.code] ?? 'SERVICE_UNAVAILABLE', message: err.message, cause: err });
  return err;
}

async function answering<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw bridgeTrpcError(err);
  }
}

/** Refuses every transfer call when the service was started without the transfers' table. */
const unwired = () => Promise.reject(new BridgeTransferError(BRIDGE_PROVIDER_UNSET, 'bridge transfers are not wired in this process'));
const unwiredStore: BridgeTransferStore = {
  insert: unwired,
  findByKey: unwired,
  get: unwired,
  list: unwired,
  countWaiting: unwired,
  advance: unwired,
};

/**
 * `bridge.*` (D-bridge-chain-03). The route table the owner published, and the person's transfers on it: the intent is
 * stored before the burn, the wallet signs the burn and the mint, and each row is brought up to date from the chains and
 * the provider's attestation. Nothing here signs, holds a key or posts to the ledger. With no provider connected (the
 * owner has chosen none) a transfer refuses `bridge.provider_unset`.
 */
export function createBridgeRouter(
  deps: {
    loadRoutes?: (() => unknown) | undefined;
    provider?: (() => BridgeProvider | null) | undefined;
    store?: BridgeTransferStore | undefined;
  } = {},
) {
  const transfers: BridgeTransfersDeps = {
    routes: () => listBridgeRoutes(deps.loadRoutes),
    provider: () => deps.provider?.() ?? null,
    store: deps.store ?? unwiredStore,
  };
  return router({
    routes: router({
      list: mountRecord(
        PROTOCOL_BRIDGE_ROUTES_LIST,
        () => answering(() => ({ routes: listBridgeRoutes(deps.loadRoutes) })),
        protocolRefusal,
      ),
    }),
    transfers: router({
      start: mountRecord(PROTOCOL_BRIDGE_TRANSFERS_START, ({ input }) => answering(() => startTransfer(transfers, input)), protocolRefusal),
      burnSubmitted: mountRecord(
        PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED,
        ({ input }) => answering(() => burnSubmitted(transfers, input)),
        protocolRefusal,
      ),
      list: mountRecord(PROTOCOL_BRIDGE_TRANSFERS_LIST, ({ input }) => answering(() => listTransfers(transfers, input)), protocolRefusal),
    }),
  });
}
