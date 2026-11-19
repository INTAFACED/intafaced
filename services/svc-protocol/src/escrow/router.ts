import {
  ESCROW_AUDIT_EXTERNAL,
  ESCROW_DEAL_NOT_FOUND,
  ESCROW_NOT_DEPLOYED,
  protocolEscrowBuildInputSchema,
  protocolEscrowBuildOutputSchema,
  protocolEscrowDealInputSchema,
  protocolEscrowDealOutputSchema,
  protocolEscrowStatusOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import { buildEscrowCall, EscrowRefusal, escrowStatus, readDeal, type EscrowChain, type EscrowSetting } from './sovereign.js';

export interface EscrowRouterDeps {
  chain: () => EscrowChain;
  setting: () => EscrowSetting;
  /** Shapes a chain failure the way the rest of the router does (unreachable, absent contract). */
  toTrpcError: (err: unknown) => TRPCError;
}

const TRPC_CODE: Record<string, TRPCError['code']> = {
  [ESCROW_NOT_DEPLOYED]: 'PRECONDITION_FAILED',
  [ESCROW_AUDIT_EXTERNAL]: 'PRECONDITION_FAILED',
  [ESCROW_DEAL_NOT_FOUND]: 'NOT_FOUND',
  'protocol.escrow_amount_invalid': 'BAD_REQUEST',
};

/**
 * `protocol.escrow.*` (RC-p2p-01): the sovereign P2P escrow's status, one deal's chain state, and unsigned calls.
 * Permissionless reads and builders like the rest of this plane; nothing here signs, sends or posts.
 */
export function createEscrowRouter(deps: EscrowRouterDeps) {
  const guard = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EscrowRefusal) throw new TRPCError({ code: TRPC_CODE[err.code] ?? 'CONFLICT', message: err.message, cause: err });
      throw deps.toTrpcError(err);
    }
  };
  const procedure = publicJurisdictionProcedure('protocol', 'protocol');
  return router({
    status: procedure.output(protocolEscrowStatusOutputSchema).query(() => guard(() => escrowStatus(deps.setting()))),
    deal: procedure
      .input(protocolEscrowDealInputSchema)
      .output(protocolEscrowDealOutputSchema)
      .query(({ input }) => guard(() => readDeal(deps.chain(), deps.setting(), input.dealId))),
    build: procedure
      .input(protocolEscrowBuildInputSchema)
      .output(protocolEscrowBuildOutputSchema)
      .query(({ input }) => guard(() => buildEscrowCall(deps.setting(), input))),
  });
}
