import { z } from 'zod';
import {
  payHaltEventSchema,
  payHaltHistoryInputSchema,
  payHaltOperatorStatusSchema,
  payHaltPendingClearListInputSchema,
  payHaltPendingClearListSchema,
  payHaltSetInputSchema,
  payHaltSetResultSchema,
  type PayHaltErrorCode,
} from './pay-halts.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-pay `payHalts.*`, the operator's side: reading every halt, setting or clearing one, its history and the clears
 * waiting for a second founder. Each is founder-only (svc-pay's founder authority, read live before the input is parsed);
 * the founder comes from that check, never the body. svc-pay mounts each from here (`namespaces/pay-halts.ts`) and the
 * console calls each by its record. A merchant's own `payHalts.status` is not here: it has no app caller yet.
 */

/** Each refusal by its code, with the status `namespaces/pay-halts.ts` sends it with. */
const STATUS = {
  'pay.halt_store_unavailable': 'SERVICE_UNAVAILABLE',
  'pay.halt_target_not_found': 'NOT_FOUND',
  'pay.halt_target_unknown_rail': 'NOT_FOUND',
  'pay.halt_target_unsupported': 'BAD_REQUEST',
} as const satisfies Record<PayHaltErrorCode, RefusalStatus>;
const refuse = (...codes: PayHaltErrorCode[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc', access: { caller: 'founder' } } as const;
const REQUEST = '55555555-5555-4555-8555-555555555555';

export const PAY_HALTS_OPERATOR_STATUS = defineProcedure({
  ...base,
  name: 'pay.payHalts.operatorStatus',
  kind: 'query',
  path: 'payHalts.operatorStatus',
  refusals: refuse('pay.halt_store_unavailable'),
  input: NO_INPUT,
  output: payHaltOperatorStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const PAY_HALTS_SET = defineProcedure({
  ...base,
  name: 'pay.payHalts.set',
  kind: 'mutation',
  path: 'payHalts.set',
  refusals: refuse(
    'pay.halt_store_unavailable',
    'pay.halt_target_not_found',
    'pay.halt_target_unknown_rail',
    'pay.halt_target_unsupported',
  ),
  input: payHaltSetInputSchema,
  output: payHaltSetResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: REQUEST,
        scope: 'payout',
        target: { level: 'global' },
        halted: true,
        reason: 'venue outage',
        expectedVersion: '0',
      },
    },
    { verdict: 'refuse', input: { requestId: REQUEST, scope: 'payout', target: { level: 'global' }, halted: true, expectedVersion: '0' } },
  ],
});

export const PAY_HALTS_HISTORY = defineProcedure({
  ...base,
  name: 'pay.payHalts.history',
  kind: 'query',
  path: 'payHalts.history',
  refusals: refuse(
    'pay.halt_store_unavailable',
    'pay.halt_target_not_found',
    'pay.halt_target_unknown_rail',
    'pay.halt_target_unsupported',
  ),
  input: payHaltHistoryInputSchema,
  output: z.array(payHaltEventSchema),
  samples: [
    { verdict: 'accept', input: { scope: 'intake', limit: 20 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const PAY_HALTS_PENDING_CLEARS = defineProcedure({
  ...base,
  name: 'pay.payHalts.pendingClears',
  kind: 'query',
  path: 'payHalts.pendingClears',
  refusals: refuse(
    'pay.halt_store_unavailable',
    'pay.halt_target_not_found',
    'pay.halt_target_unknown_rail',
    'pay.halt_target_unsupported',
  ),
  input: payHaltPendingClearListInputSchema,
  output: payHaltPendingClearListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 50, cursor: 'x' } },
  ],
});
