import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  opsCapitalScenarioInputSchema,
  opsCapitalScenarioSchema,
  opsCapitalSnapshotSchema,
  opsCapitalThresholdSetInputSchema,
  opsCapitalThresholdSetOutputSchema,
} from './ops-capital.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `capital.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_CAPITAL_SNAPSHOT = defineProcedure({
  ...base,
  name: 'ops.capital.snapshot',
  kind: 'query',
  path: 'capital.snapshot',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.capital.storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: opsCapitalSnapshotSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_CAPITAL_SCENARIO = defineProcedure({
  ...base,
  name: 'ops.capital.scenario',
  kind: 'query',
  path: 'capital.scenario',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.capital.scenario_input_missing': 'PRECONDITION_FAILED', 'ops.capital.source_unavailable': 'PRECONDITION_FAILED' },
  input: opsCapitalScenarioInputSchema,
  output: opsCapitalScenarioSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'counterparty_default' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_CAPITAL_SET_THRESHOLD = defineProcedure({
  ...base,
  name: 'ops.capital.setThreshold',
  kind: 'mutation',
  path: 'capital.setThreshold',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: { 'action_approval.identity_unwired': 'PRECONDITION_FAILED', 'ops.capital.threshold_invalid': 'PRECONDITION_FAILED' },
  input: opsCapitalThresholdSetInputSchema,
  output: opsCapitalThresholdSetOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        assetId: 'USDC',
        minimum: 'USDC',
        contact: 'USDC',
        reason: 'USDC',
        approvalId: 'USDC',
        operationId: 'USDC',
        idempotencyKey: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
