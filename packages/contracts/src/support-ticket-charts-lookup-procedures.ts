import { defineProcedure } from './procedure.js';
import { supportChartsLookupInputSchema, supportChartsLookupSchema } from './support-charts-lookup.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `ticketChartsLookup.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

/**
 * A customer's price alerts, their trigger history and saved desk layouts, for a ticket the agent can see
 * (C-ops-03 (a), J-charts-desk-19 #1). Read-only. The customer comes off the ticket: the input is `.strict()`, so a
 * `userId` is refused rather than silently dropped, as on `accountState`. One `charts_lookup` trail row is written
 * before anything is read; when it does not land the lookup is refused.
 */
export const SUPPORT_TICKET_CHARTS_LOOKUP = defineProcedure({
  ...base,
  name: 'support.ticketChartsLookup',
  kind: 'query',
  path: 'ticketChartsLookup',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: supportChartsLookupInputSchema,
  output: supportChartsLookupSchema,
  outputChecks: {
    desk_workspace_holds: { at: 'output.layouts|0.items[].desk', says: 'each widget once; a linked panel is on the desk' },
    desk_links_hold: {
      at: 'output.layouts|0.items[].desk.links',
      says: "each member's group carries a market; each group has a member",
    },
  },
  samples: [
    { verdict: 'accept', input: { ticketId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
