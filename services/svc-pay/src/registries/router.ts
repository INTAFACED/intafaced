import { z } from 'zod';
import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import type { ActionApprovalConsumer } from '../action-approval-consume.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure, type FounderContext } from '../namespaces/founder-procedure.js';
import { toTrpcError } from './errors.js';
import {
  listInputSchema,
  networkSaveInputSchema,
  networkViewSchema,
  registryEventViewSchema,
  registryHistoryInputSchema,
  registryPreviewInputSchema,
  registryPreviewSchema,
  venueSaveInputSchema,
  venueViewSchema,
  walletRouteSaveInputSchema,
  walletRouteViewSchema,
  type VenueHealthView,
} from './schemas.js';
import { RegistryService } from './service.js';

/** What a mount supplies besides the founder authority. */
export type RegistriesMountDeps = Omit<RegistriesRouterDeps, 'founderAuthority'>;

export interface RegistriesRouterDeps {
  founderAuthority: FounderAuthority;
  sql: Sql;
  approvals: ActionApprovalConsumer;
  knownVenueKeys?: readonly string[];
  venueHealth?: (venueId: string) => VenueHealthView | null;
}

/** The authority middleware put the verified founder id on the context. A missing one refuses. */
function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}

/**
 * `founderAdmin.registries.*` — editable venue, network and wallet-route
 * registries (W16). Founder-only: EVERY procedure is built from
 * `founderProcedure`, never `admin:read`. The static inventory test asserts it.
 *
 * Returns the `registries` sub-router. tRPC refuses two routers that both own a
 * top-level `founderAdmin` key, so it is mounted INSIDE the founderAdmin router
 * (see namespaces/founder-admin.ts), not merged beside it.
 */
export function createRegistriesRouter(deps: RegistriesRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new RegistryService({
    sql: deps.sql,
    approvals: deps.approvals,
    ...(deps.knownVenueKeys ? { knownVenueKeys: deps.knownVenueKeys } : {}),
    ...(deps.venueHealth ? { venueHealth: deps.venueHealth } : {}),
  });

  return router({
    venues: router({
      list: founder
        .input(listInputSchema)
        .output(z.array(venueViewSchema))
        .query(() => wrap(() => service.listVenues())),
      save: founder
        .input(venueSaveInputSchema)
        .output(venueViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.saveVenue(actorOf(ctx), input))),
    }),
    networks: router({
      list: founder
        .input(listInputSchema)
        .output(z.array(networkViewSchema))
        .query(() => wrap(() => service.listNetworks())),
      save: founder
        .input(networkSaveInputSchema)
        .output(networkViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.saveNetwork(actorOf(ctx), input))),
    }),
    walletRoutes: router({
      list: founder
        .input(listInputSchema)
        .output(z.array(walletRouteViewSchema))
        .query(() => wrap(() => service.listWalletRoutes())),
      save: founder
        .input(walletRouteSaveInputSchema)
        .output(walletRouteViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.saveWalletRoute(actorOf(ctx), input))),
    }),
    /** What a change would need (dual control or not) and the hash the second founder's approval must bind to. */
    preview: founder
      .input(registryPreviewInputSchema)
      .output(registryPreviewSchema)
      .query(({ input }) => wrap(() => service.preview(input))),
    history: founder
      .input(registryHistoryInputSchema)
      .output(z.array(registryEventViewSchema))
      .query(({ input }) => wrap(() => service.history(input.registry, input.entryKey, input.limit))),
  });
}
export type RegistriesRouter = ReturnType<typeof createRegistriesRouter>;
