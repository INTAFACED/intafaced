import { TRPCError } from '@trpc/server';
import {
  protocolOpsActionResultSchema,
  protocolOpsHiddenOutputSchema,
  protocolOpsMarketDelistInputSchema,
  protocolOpsMarketRestoreInputSchema,
  protocolOpsMarketsListOutputSchema,
  protocolOpsPoolHideInputSchema,
  protocolOpsPoolRestoreInputSchema,
  protocolOpsPoolsListOutputSchema,
  publicProcedure,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED, OpsError } from '../codes.js';
import type { ListingDesk } from './wiring.js';
import type { ListingRow } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    throw new TRPCError({
      code: err.code === OPS_IDEMPOTENCY_CONFLICT ? 'CONFLICT' : 'PRECONDITION_FAILED',
      message: `${err.code} — ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

function require(desk: ListingDesk | undefined): ListingDesk {
  if (!desk) {
    throw new OpsError(
      OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED,
      'No durable storage is configured for protocol listing decisions. Nothing was read or saved, and no list is claimed to be empty.',
    );
  }
  return desk;
}

const poolId = (targetId: string): { chainId: number; poolAddress: string } => {
  const [chain, address] = targetId.split(':');
  return { chainId: Number(chain), poolAddress: address ?? '' };
};

const hiddenOf = (row: ListingRow) =>
  row.state === 'hidden' && row.reasonCode && row.reason
    ? { reasonCode: row.reasonCode, reason: row.reason, approvalId: row.approvalId, policyVersion: row.policyVersion, at: row.updatedAt }
    : null;

/**
 * Pool hide and market delist for the Protocol ops desk (D-order-controls-04). This service holds the four-eyes role the
 * Protocol Plane lacks; svc-protocol and svc-dex only read `hidden`.
 */
export function createProtocolListingRouter(desk: ListingDesk | undefined) {
  return router({
    pools: router({
      list: scopedProcedure('admin:read', guards)
        .output(protocolOpsPoolsListOutputSchema)
        .query(async () => {
          try {
            const d = require(desk);
            const rows = await d.store.list('pool');
            return {
              asOf: d.now(),
              pools: rows.map((row) => ({ ...poolId(row.targetId), state: row.state, hidden: hiddenOf(row) })),
            };
          } catch (err) {
            return deskError(err);
          }
        }),
      hide: scopedProcedure('admin:write', guards)
        .input(protocolOpsPoolHideInputSchema)
        .output(protocolOpsActionResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await require(desk).desk.hidePool(ctx.principal.userId, input);
          } catch (err) {
            return deskError(err);
          }
        }),
      restore: scopedProcedure('admin:write', guards)
        .input(protocolOpsPoolRestoreInputSchema)
        .output(protocolOpsActionResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await require(desk).desk.restorePool(ctx.principal.userId, input);
          } catch (err) {
            return deskError(err);
          }
        }),
    }),
    markets: router({
      list: scopedProcedure('admin:read', guards)
        .output(protocolOpsMarketsListOutputSchema)
        .query(async () => {
          try {
            const d = require(desk);
            const rows = await d.store.list('market');
            return { asOf: d.now(), markets: rows.map((row) => ({ symbol: row.targetId, state: row.state, hidden: hiddenOf(row) })) };
          } catch (err) {
            return deskError(err);
          }
        }),
      delist: scopedProcedure('admin:write', guards)
        .input(protocolOpsMarketDelistInputSchema)
        .output(protocolOpsActionResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await require(desk).desk.delistMarket(ctx.principal.userId, input);
          } catch (err) {
            return deskError(err);
          }
        }),
      restore: scopedProcedure('admin:write', guards)
        .input(protocolOpsMarketRestoreInputSchema)
        .output(protocolOpsActionResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await require(desk).desk.restoreMarket(ctx.principal.userId, input);
          } catch (err) {
            return deskError(err);
          }
        }),
    }),
    /**
     * The public hide list: ids only, no reason and no signer. Without storage it refuses; a reader must never take an
     * unreadable list for an empty one.
     */
    hidden: publicProcedure.output(protocolOpsHiddenOutputSchema).query(async () => {
      try {
        const d = require(desk);
        const [pools, markets] = await Promise.all([d.store.list('pool'), d.store.list('market')]);
        return {
          asOf: d.now(),
          pools: pools.filter((row) => row.state === 'hidden').map((row) => poolId(row.targetId)),
          markets: markets.filter((row) => row.state === 'hidden').map((row) => ({ symbol: row.targetId })),
        };
      } catch (err) {
        return deskError(err);
      }
    }),
  });
}
