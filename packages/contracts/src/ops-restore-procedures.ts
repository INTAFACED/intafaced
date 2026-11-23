import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { OPS_RESTORE_ARCHIVE_UNCONFIGURED, OPS_RESTORE_ARCHIVE_UNPROBED, OPS_RESTORE_STORAGE_UNCONFIGURED } from './ops-call-schemas.js';
import { restoreBackupListSchema, restoreRunListSchema, restoreRunDetailSchema } from './ops-restore-watermarks.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `restore.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_RESTORE_WATERMARKS = defineProcedure({
  ...base,
  name: 'ops.restore.watermarks',
  kind: 'query',
  path: 'restore.watermarks',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    archive: z.object({
      configured: z.boolean(),
      probed: z.literal(false),
      code: z.enum([OPS_RESTORE_ARCHIVE_UNCONFIGURED, OPS_RESTORE_ARCHIVE_UNPROBED]),
    }),
    watermarks: z
      .object({
        stamped: z.boolean(),
        rows: z.array(
          z.object({
            service: z.string(),
            kind: z.string(),
            watermark: z.string(),
            recordedAt: z.string(),
            recordedBy: z.string(),
            approverId: z.string(),
          }),
        ),
      })
      .nullable(),
    storage: z.object({ configured: z.boolean(), code: z.literal(OPS_RESTORE_STORAGE_UNCONFIGURED).optional() }),
    restored: z.literal(false),
  }),
  samples: [{ verdict: 'accept' }],
});

export const OPS_RESTORE_BACKUPS = defineProcedure({
  ...base,
  name: 'ops.restore.backups',
  kind: 'query',
  path: 'restore.backups',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: restoreBackupListSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_RESTORE_RUNS = defineProcedure({
  ...base,
  name: 'ops.restore.runs',
  kind: 'query',
  path: 'restore.runs',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.restore_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: restoreRunListSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_RESTORE_RUN = defineProcedure({
  ...base,
  name: 'ops.restore.run',
  kind: 'query',
  path: 'restore.run',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: z.object({ restoreNo: z.string().min(1).max(128) }),
  output: restoreRunDetailSchema,
  samples: [
    { verdict: 'accept', input: { restoreNo: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
