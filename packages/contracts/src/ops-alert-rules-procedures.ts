import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { OPS_ALERT_HEALTH, OPS_ALERT_STATES } from './ops-alert-rules.js';
import { cursorSchema, rule, stateSchema } from './ops-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `alertRules.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

/** Rules with their stored state and health. A rule that has not been evaluated yet says so; no state is invented. */
export const OPS_ALERT_RULES_STATES = defineProcedure({
  ...base,
  name: 'ops.alertRules.states',
  kind: 'query',
  path: 'alertRules.states',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    folder: z.string().optional(),
    group: z.string().optional(),
    name: z.string().max(120).optional(),
    label: z.object({ key: z.string(), value: z.string() }).optional(),
    state: z.enum(OPS_ALERT_STATES).optional(),
    health: z.enum(OPS_ALERT_HEALTH).optional(),
    cursor: cursorSchema.optional(),
  }),
  output: z.object({ items: z.array(z.object({ rule, status: stateSchema.nullable() })), nextCursor: z.string().nullable() }),
  outputChecks: {
    ops_alert_labels_holds: { at: 'output.items[].rule.labels', says: 'at most 20 labels' },
    ops_alert_annotations_holds: {
      at: 'output.items[].rule.annotations',
      says: 'ops.panel_link_incomplete — a panel link needs both the dashboard and the panel',
    },
    runbook_url_holds: { at: 'output.items[].rule.annotations.runbookUrl', says: 'runbook link is an https address' },
  },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
