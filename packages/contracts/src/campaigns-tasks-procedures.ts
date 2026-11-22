import { defineProcedure } from './procedure.js';
import { welcomeChecklistSchema, welcomeClaimInputSchema, welcomeClaimResultSchema, welcomeListInputSchema } from './campaigns-rewards.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `tasks.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** The caller's own welcome checklist (CM-rewards-hub-03): its window and each task's state and reward. */
export const CAMPAIGNS_TASKS_WELCOME_LIST = defineProcedure({
  ...base,
  name: 'campaigns.tasks.welcome.list',
  kind: 'query',
  path: 'tasks.welcome.list',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: welcomeListInputSchema,
  output: welcomeChecklistSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Claims one welcome task for the caller's own account. A second call returns the first claim's reward. */
export const CAMPAIGNS_TASKS_WELCOME_CLAIM = defineProcedure({
  ...base,
  name: 'campaigns.tasks.welcome.claim',
  kind: 'mutation',
  path: 'tasks.welcome.claim',
  access: { caller: 'scope', scope: 'campaigns:write', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: welcomeClaimInputSchema,
  output: welcomeClaimResultSchema,
  samples: [
    { verdict: 'accept', input: { event: 'trade.fill' } },
    { verdict: 'refuse', input: 42 },
  ],
});
