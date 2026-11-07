import { publicJurisdictionProcedure, router, TRPCError } from '@intafaced/contracts';
import {
  protocolEmbeddedMarkInputSchema,
  protocolEmbeddedStatusInputSchema,
  protocolEmbeddedStatusSchema,
} from '@intafaced/contracts/protocol-embedded';
import type { Hex } from 'viem';
import { embeddedStatus, EmbeddedExportRefusedError, markExported, type EmbeddedExportStore } from './exports.js';

/** `embedded.status` and `embedded.markExported` (RC-dex-protocol-05). Public like the rest of this plane; the key's own signature is the proof. */
export interface EmbeddedDeps {
  chainId: () => number;
  store: EmbeddedExportStore;
}

const toTrpc = (err: unknown) =>
  err instanceof EmbeddedExportRefusedError
    ? new TRPCError({ code: 'FORBIDDEN', message: `${err.code}: ${err.message}`, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });

export function createEmbeddedRouter(deps: EmbeddedDeps) {
  return router({
    status: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolEmbeddedStatusInputSchema)
      .output(protocolEmbeddedStatusSchema)
      .query(async ({ input }) => {
        try {
          return await embeddedStatus(deps.store, deps.chainId(), input.account);
        } catch (err) {
          throw toTrpc(err);
        }
      }),
    markExported: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolEmbeddedMarkInputSchema)
      .output(protocolEmbeddedStatusSchema)
      .mutation(async ({ input }) => {
        try {
          return await markExported(deps.store, { chainId: deps.chainId(), account: input.account, signature: input.signature as Hex });
        } catch (err) {
          throw toTrpc(err);
        }
      }),
  });
}
