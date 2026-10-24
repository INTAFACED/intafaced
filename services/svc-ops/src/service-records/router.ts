import { TRPCError } from '@trpc/server';
import {
  SERVICE_NOT_FOUND,
  SERVICE_RECORD_INVALID,
  SERVICE_RECORD_STALE,
  SERVICE_STORAGE_UNCONFIGURED,
  router,
  scopedProcedure,
  serviceGetInputSchema,
  serviceGetOutputSchema,
  serviceListOutputSchema,
  serviceRecordValues,
  serviceSetInputSchema,
} from '@intafaced/contracts';
import { isModuleId, type ModuleId } from '@intafaced/config';
import { OpsError } from '../codes.js';
import type { ServiceRecordStore } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

export interface ServiceRecordsDeps {
  readonly store: ServiceRecordStore | undefined;
  readonly now: () => string;
}

const refusal = (code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED', err: OpsError) =>
  new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });

function storeOf(deps: ServiceRecordsDeps): ServiceRecordStore {
  if (!deps.store)
    throw refusal(
      'PRECONDITION_FAILED',
      new OpsError(SERVICE_STORAGE_UNCONFIGURED, 'no durable storage is configured for service records, so no owner can be read or set'),
    );
  return deps.store;
}

function moduleOf(value: string): ModuleId {
  if (!isModuleId(value)) throw refusal('NOT_FOUND', new OpsError(SERVICE_NOT_FOUND, `${value} is not a platform module`));
  return value;
}

/**
 * Service records for the console's service page per module (OPS-service-health-01).
 *
 * `services.list` and `services.get` (`admin:read`): the records founders have set. A module nobody has set reads as
 * revision 0 with no owner, which the console shows as "owner not set"; nothing is seeded or guessed. A module the
 * registry does not name refuses `ops.service_not_found`.
 * `services.set` (`admin:write`): replace one module's owner team, dependencies and runbook from the revision read. A
 * value it does not take refuses `ops.service_record_invalid` naming the field; a record saved since it was read refuses
 * `ops.service_record_stale`. The actor is the founder in the token. No money moves.
 */
export function createServiceRecordsRouter(deps: ServiceRecordsDeps) {
  return router({
    list: scopedProcedure('admin:read', guards)
      .output(serviceListOutputSchema)
      .query(async () => ({ records: await storeOf(deps).list(), asOf: deps.now() })),
    get: scopedProcedure('admin:read', guards)
      .input(serviceGetInputSchema)
      .output(serviceGetOutputSchema)
      .query(async ({ input }) => {
        const module = moduleOf(input.module);
        return { record: await storeOf(deps).get(module), asOf: deps.now() };
      }),
    set: scopedProcedure('admin:write', guards)
      .input(serviceSetInputSchema)
      .output(serviceGetOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const module = moduleOf(input.module);
        const checked = serviceRecordValues(module, input);
        if (!checked.ok)
          throw refusal(
            'BAD_REQUEST',
            new OpsError(SERVICE_RECORD_INVALID, `not a value the service record takes: ${checked.invalid.join(', ')}`),
          );
        const store = storeOf(deps);
        const at = deps.now();
        try {
          return { record: await store.set(module, input.expectedRevision, checked.values, ctx.principal.userId, at), asOf: at };
        } catch (err) {
          if (err instanceof OpsError && err.code === SERVICE_RECORD_STALE) throw refusal('CONFLICT', err);
          throw err;
        }
      }),
  });
}
