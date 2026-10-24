import { z } from 'zod';
import { MODULE_IDS, isModuleId, type ModuleId } from '@intafaced/config/modules';

/**
 * Wire types for the founder console's service page per module (`/health/:module`, OPS-service-health-01,
 * ops-console-service-health-001).
 *
 * A module's service record is what founders set by hand: the team that owns it, the modules it depends on, and its
 * runbook. Nothing is seeded: a module nobody has set reads as "owner not set" (`ops.service_owner_unset`), never as a
 * guessed team. A runbook is a path inside the repository's `docs/runbooks/`, never an outside link.
 *
 * On call, incidents, objectives and dashboards are not part of the record: they come from their own sources, and the
 * console shows each one's panel on its own.
 *
 * Browser-safe: zod and the module registry only.
 */

export const SERVICE_NOT_FOUND = 'ops.service_not_found' as const;
/** One panel's source could not be read; the rest of the page still shows. */
export const SERVICE_SOURCE_UNAVAILABLE = 'ops.service_source_unavailable' as const;
export const SERVICE_OWNER_UNSET = 'ops.service_owner_unset' as const;
export const SERVICE_RECORD_INVALID = 'ops.service_record_invalid' as const;
/** The record changed since the founder read it: read it again, so another founder's change is never overwritten unseen. */
export const SERVICE_RECORD_STALE = 'ops.service_record_stale' as const;
export const SERVICE_STORAGE_UNCONFIGURED = 'ops.service_storage_unconfigured' as const;

/**
 * A runbook in the repository: `docs/runbooks/<name>.md`, or under a folder there. Each part starts with a letter or digit,
 * so there is no `..`, no empty part, no leading slash and no scheme. At most 200 characters.
 */
export const SERVICE_RUNBOOK = /^(?=.{1,200}$)(?!.*\.\.)docs\/runbooks\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export const SERVICE_OWNER_TEAM_MAX = 80;

const moduleIdSchema = z.enum(MODULE_IDS);

export const serviceRecordSchema = z.object({
  module: moduleIdSchema,
  ownerTeam: z.string().min(1).max(SERVICE_OWNER_TEAM_MAX).nullable(),
  dependencies: z.array(moduleIdSchema),
  runbook: z.string().regex(SERVICE_RUNBOOK).nullable(),
  /** 0 with `updatedAt` null: nobody has set this module's record. */
  revision: z.number().int().min(0),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ServiceRecord = z.infer<typeof serviceRecordSchema>;

export const unsetServiceRecord = (module: ModuleId): ServiceRecord => ({
  module,
  ownerTeam: null,
  dependencies: [],
  runbook: null,
  revision: 0,
  updatedBy: null,
  updatedAt: null,
});

export const serviceGetInputSchema = z.object({ module: z.string().min(1).max(40) });
export const serviceGetOutputSchema = z.object({ record: serviceRecordSchema, asOf: z.string() });
export type ServiceGetOutput = z.infer<typeof serviceGetOutputSchema>;

export const serviceListOutputSchema = z.object({ records: z.array(serviceRecordSchema), asOf: z.string() });
export type ServiceListOutput = z.infer<typeof serviceListOutputSchema>;

/**
 * Replace one module's record from the revision the founder read. Values arrive loose, so svc-ops can name the one it
 * refuses (`ops.service_record_invalid`) rather than answering with a schema error.
 */
export const serviceSetInputSchema = z.object({
  module: z.string().min(1).max(40),
  expectedRevision: z.number().int().min(0),
  ownerTeam: z.string().max(400).nullable(),
  /** Checked by `serviceRecordValues`, so a bad list is refused by name rather than by the schema. */
  dependencies: z.array(z.string().max(100)).max(64),
  runbook: z.string().max(400).nullable(),
});
export type ServiceSetInput = z.infer<typeof serviceSetInputSchema>;

export type ServiceRecordValues = Pick<ServiceRecord, 'ownerTeam' | 'dependencies' | 'runbook'>;

/**
 * The record's values as svc-ops stores them, or the names of the fields it refuses. A blank owner or runbook is unset;
 * dependencies must be modules other than this one, each once.
 */
export function serviceRecordValues(
  module: ModuleId,
  input: Pick<ServiceSetInput, 'ownerTeam' | 'dependencies' | 'runbook'>,
): { ok: true; values: ServiceRecordValues } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const owner = input.ownerTeam?.trim() ?? '';
  if (owner.length > SERVICE_OWNER_TEAM_MAX) invalid.push('ownerTeam');
  const runbook = input.runbook?.trim() ?? '';
  if (runbook !== '' && !SERVICE_RUNBOOK.test(runbook)) invalid.push('runbook');
  const deps = input.dependencies;
  if (deps.some((d) => !isModuleId(d) || d === module) || new Set(deps).size !== deps.length) invalid.push('dependencies');
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    values: {
      ownerTeam: owner === '' ? null : owner,
      dependencies: MODULE_IDS.filter((m) => deps.includes(m)),
      runbook: runbook === '' ? null : runbook,
    },
  };
}
