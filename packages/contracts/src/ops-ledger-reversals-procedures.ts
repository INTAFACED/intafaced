import { defineProcedure } from './procedure.js';
import {
  opsLedgerReversalSchema,
  opsReversalExecuteInputSchema,
  opsReversalGetInputSchema,
  opsReversalListInputSchema,
  opsReversalListSchema,
  opsReversalRequestInputSchema,
} from './ops-ledger-reversals.js';

/**
 * svc-ops `ledgerReversals.*` (OPS-ledger-desk-02): an operator's corrective reversal of a posted ledger transaction, asked
 * for by one founder, approved at identity by a different one, run once. svc-ops mounts each record (`mountRecord`) and the
 * console calls it by its record. Asking and running move value in the ledger, so they need `admin:treasury`; reading needs
 * `admin:read`.
 */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const storage = {
  'ops.reversal_storage_unconfigured': 'PRECONDITION_FAILED',
  'ops.reversal_ledger_unconfigured': 'PRECONDITION_FAILED',
} as const;

export const OPS_LEDGER_REVERSALS_REQUEST = defineProcedure({
  ...base,
  name: 'ops.ledgerReversals.request',
  kind: 'mutation',
  path: 'ledgerReversals.request',
  access: { caller: 'scope', scope: 'admin:treasury', module: 'core-ops', plane: 'fiat' },
  refusals: { ...storage, 'ops.reversal_already_reversed': 'CONFLICT' },
  input: opsReversalRequestInputSchema,
  output: opsLedgerReversalSchema,
  samples: [
    { verdict: 'accept', input: { originalTxId: ORIGINAL, reason: 'LOCAL TEST posted to the wrong account', caseRef: 'CASE-1' } },
    { verdict: 'refuse', input: { originalTxId: ORIGINAL.toUpperCase(), reason: 'r', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: ORIGINAL, reason: ' padded', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: ORIGINAL, reason: 'r', caseRef: '' } },
  ],
});

export const OPS_LEDGER_REVERSALS_EXECUTE = defineProcedure({
  ...base,
  name: 'ops.ledgerReversals.execute',
  kind: 'mutation',
  path: 'ledgerReversals.execute',
  access: { caller: 'scope', scope: 'admin:treasury', module: 'core-ops', plane: 'fiat' },
  refusals: {
    ...storage,
    'ops.reversal_already_reversed': 'CONFLICT',
    'ops.reversal_not_found': 'NOT_FOUND',
    'ops.reversal_state_illegal': 'CONFLICT',
    'ops.reversal_requester_only': 'FORBIDDEN',
    'action_approval.same_person': 'FORBIDDEN',
    'action_approval.identity_unwired': 'PRECONDITION_FAILED',
    'action_approval.missing': 'PRECONDITION_FAILED',
    'action_approval.wrong_action': 'PRECONDITION_FAILED',
    'action_approval.not_founders': 'PRECONDITION_FAILED',
  },
  input: opsReversalExecuteInputSchema,
  output: opsLedgerReversalSchema,
  samples: [
    { verdict: 'accept', input: { requestNo: '1', approvalId: 'ap_1', operationId: 'op_1' } },
    { verdict: 'refuse', input: { requestNo: '0', approvalId: 'ap_1', operationId: 'op_1' } },
    { verdict: 'refuse', input: { requestNo: '1', approvalId: '', operationId: 'op_1' } },
  ],
});

export const OPS_LEDGER_REVERSALS_GET = defineProcedure({
  ...base,
  name: 'ops.ledgerReversals.get',
  kind: 'query',
  path: 'ledgerReversals.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.reversal_storage_unconfigured': 'PRECONDITION_FAILED', 'ops.reversal_not_found': 'NOT_FOUND' },
  input: opsReversalGetInputSchema,
  output: opsLedgerReversalSchema,
  samples: [
    { verdict: 'accept', input: { requestNo: '1' } },
    { verdict: 'refuse', input: { requestNo: 'one' } },
  ],
});

export const OPS_LEDGER_REVERSALS_LIST = defineProcedure({
  ...base,
  name: 'ops.ledgerReversals.list',
  kind: 'query',
  path: 'ledgerReversals.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.reversal_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: opsReversalListInputSchema,
  output: opsReversalListSchema,
  samples: [
    { verdict: 'accept', input: { originalTxId: ORIGINAL, limit: 20 } },
    { verdict: 'refuse', input: { originalTxId: ORIGINAL, limit: 0 } },
    { verdict: 'refuse', input: { limit: 20 } },
  ],
});
