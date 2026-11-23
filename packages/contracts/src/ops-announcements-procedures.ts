import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  announcementActiveOutputSchema,
  announcementChangeInputSchema,
  announcementsListOutputSchema,
  announcementWriteOutputSchema,
} from './ops-console-announcements.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `announcements.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_ANNOUNCEMENTS_ACTIVE = defineProcedure({
  ...base,
  name: 'ops.announcements.active',
  kind: 'query',
  path: 'announcements.active',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: announcementActiveOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_ANNOUNCEMENTS_LIST = defineProcedure({
  ...base,
  name: 'ops.announcements.list',
  kind: 'query',
  path: 'announcements.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: announcementsListOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_ANNOUNCEMENTS_CHANGE = defineProcedure({
  ...base,
  name: 'ops.announcements.change',
  kind: 'mutation',
  path: 'announcements.change',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: announcementChangeInputSchema,
  output: announcementWriteOutputSchema,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111', op: 'publish' } },
    { verdict: 'refuse', input: 42 },
  ],
});
