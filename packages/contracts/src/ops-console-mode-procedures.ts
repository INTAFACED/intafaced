import { defineProcedure, NO_INPUT } from './procedure.js';
import { consoleModeSchema, consoleModeSetInputSchema, consoleModeSetOutputSchema } from './ops-console-mode.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `consoleMode.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_CONSOLE_MODE_GET = defineProcedure({
  ...base,
  name: 'ops.consoleMode.get',
  kind: 'query',
  path: 'consoleMode.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.console_mode_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: consoleModeSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_CONSOLE_MODE_SET = defineProcedure({
  ...base,
  name: 'ops.consoleMode.set',
  kind: 'mutation',
  path: 'consoleMode.set',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {
    'action_approval.identity_unwired': 'PRECONDITION_FAILED',
    'ops.console_mode_storage_unconfigured': 'PRECONDITION_FAILED',
    'ops.idempotency_conflict': 'PRECONDITION_FAILED',
  },
  input: consoleModeSetInputSchema,
  output: consoleModeSetOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { action: 'ops.console_mode.on', reason: '11111111-1111-4111-8111-111111111111', approvalId: 'USDC', operationId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
