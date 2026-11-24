import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  campaignDefinitionInputSchema,
  campaignGetInputSchema,
  campaignSchema,
  campaignTransitionInputSchema,
  campaignUpdateInputSchema,
} from './campaigns-catalogue.js';
import { ruleLibraryEntrySchema, ruleLibrarySaveInputSchema, ruleTestInputSchema, ruleTestResultSchema } from './campaigns-rules.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `ops.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

export const CAMPAIGNS_OPS_CAMPAIGNS_LIST = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.list',
  kind: 'query',
  path: 'ops.campaigns.list',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(campaignSchema),
  outputChecks: {
    tier_id_holds: {
      at: ['output[].trialPass.tierId', 'output[].pendingChange.definition.trialPass.tierId'],
      says: 'a pass grants a tier above regular',
    },
  },
  samples: [{ verdict: 'accept' }],
});

/** One campaign by id, at any age (the list is the newest 200). */
export const CAMPAIGNS_OPS_CAMPAIGNS_GET = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.get',
  kind: 'query',
  path: 'ops.campaigns.get',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: campaignGetInputSchema,
  output: campaignSchema,
  outputChecks: {
    tier_id_holds: {
      at: ['output.trialPass.tierId', 'output.pendingChange.definition.trialPass.tierId'],
      says: 'a pass grants a tier above regular',
    },
  },
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const CAMPAIGNS_OPS_CAMPAIGNS_CREATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.create',
  kind: 'mutation',
  path: 'ops.campaigns.create',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: campaignDefinitionInputSchema,
  checks: { tier_id_holds: { at: 'input.trialPass.tierId', says: 'a pass grants a tier above regular' } },
  output: campaignSchema,
  outputChecks: {
    tier_id_holds: {
      at: ['output.trialPass.tierId', 'output.pendingChange.definition.trialPass.tierId'],
      says: 'a pass grants a tier above regular',
    },
  },
  samples: [
    { verdict: 'accept', input: { name: 'USDC', type: 'USDC' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'tier_id_holds', input: { name: 'USDC', type: 'USDC', trialPass: { tierId: 'regular', seconds: 60 } } },
  ],
});

export const CAMPAIGNS_OPS_CAMPAIGNS_UPDATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.update',
  kind: 'mutation',
  path: 'ops.campaigns.update',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: campaignUpdateInputSchema,
  checks: { tier_id_holds: { at: 'input.definition.trialPass.tierId', says: 'a pass grants a tier above regular' } },
  output: campaignSchema,
  outputChecks: {
    tier_id_holds: {
      at: ['output.trialPass.tierId', 'output.pendingChange.definition.trialPass.tierId'],
      says: 'a pass grants a tier above regular',
    },
  },
  samples: [
    { verdict: 'accept', input: { id: 'USDC', revision: 1, definition: { name: 'USDC', type: 'USDC' } } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'tier_id_holds',
      input: { id: 'USDC', revision: 1, definition: { name: 'USDC', type: 'USDC', trialPass: { tierId: 'regular', seconds: 60 } } },
    },
  ],
});

/** submit, approve (a second person), activate, pause, resume, end, close, archive. */
export const CAMPAIGNS_OPS_CAMPAIGNS_TRANSITION = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.transition',
  kind: 'mutation',
  path: 'ops.campaigns.transition',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: campaignTransitionInputSchema,
  output: campaignSchema,
  outputChecks: {
    tier_id_holds: {
      at: ['output.trialPass.tierId', 'output.pendingChange.definition.trialPass.tierId'],
      says: 'a pass grants a tier above regular',
    },
  },
  samples: [
    { verdict: 'accept', input: { id: 'USDC', action: 'submit', revision: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Tries a tree on a TEST fixture account: every failing condition by its place. Reads no account, stores nothing. */
export const CAMPAIGNS_OPS_RULES_TEST = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.test',
  kind: 'query',
  path: 'ops.rules.test',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: ruleTestInputSchema,
  output: ruleTestResultSchema,
  samples: [
    { verdict: 'accept', input: { tree: { kind: 'group', op: 'and', parts: [] }, fixture: 'test-business-kp' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The name's next revision; the same tree again returns the revision it made. */
export const CAMPAIGNS_OPS_RULES_LIBRARY_SAVE = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.library.save',
  kind: 'mutation',
  path: 'ops.rules.library.save',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: ruleLibrarySaveInputSchema,
  output: ruleLibraryEntrySchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', tree: { kind: 'group', op: 'and', parts: [] } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const CAMPAIGNS_OPS_RULES_LIBRARY_LIST = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.library.list',
  kind: 'query',
  path: 'ops.rules.library.list',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(ruleLibraryEntrySchema),
  samples: [{ verdict: 'accept' }],
});
