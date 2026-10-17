import 'server-only';
import {
  payHaltEventSchema,
  payHaltOperatorStatusSchema,
  payHaltPendingClearListSchema,
  payHaltSetInputSchema,
  payHaltSetResultSchema,
  type PayHaltScope,
  type PayHaltTarget,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { HALT_REASON_MAX, HALT_REASON_MIN, scopeTargetProblem } from './model';
import type { PayHaltsRead } from './types';

/**
 * svc-pay halts, read and written as the signed-in founder. `payHalts.*` is behind svc-pay's own founder authority:
 * the service checks the caller is a live founder and records WHICH founder. This console adds no authority.
 */

const LABELS: PartLabels = {
  service: 'svc-pay',
  forbiddenMessage: 'svc-pay did not accept your founder session for this read.',
  refusedMessage: (code) =>
    code === 'pay.halt_store_unavailable' ? 'The halt store cannot be read. Treat every operation as halted until it can.' : null,
};

const part = <T, U>(result: FounderCallResult<T>, pick: (data: T) => U): Part<U> => partFrom(result, pick, LABELS);

const eventsParser = (raw: unknown) => {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const row of raw) {
    const parsed = payHaltEventSchema.safeParse(row);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
};

export async function loadPayHalts(ctx: FounderCallContext, now: Date = new Date()): Promise<PayHaltsRead> {
  const [status, pending, history] = await Promise.all([
    founderCall(ctx, 'pay', 'payHalts.operatorStatus', 'GET', {}, parseWith(payHaltOperatorStatusSchema)),
    founderCall(ctx, 'pay', 'payHalts.pendingClears', 'GET', { limit: 50 }, parseWith(payHaltPendingClearListSchema)),
    founderCall(ctx, 'pay', 'payHalts.history', 'GET', { limit: 30 }, eventsParser),
  ]);
  return {
    asOf: now.toISOString(),
    status: part(status, (d) => d),
    pending: part(pending, (d) => d),
    history: part(history, (d) => d),
  };
}

export interface SetBody {
  readonly requestId: string;
  readonly scope: PayHaltScope;
  readonly target: PayHaltTarget;
  readonly halted: boolean;
  readonly reason: string;
  readonly expectedVersion: string;
}

/** The service's own schema is the last word on shape; this runs it so a malformed body never leaves the console. */
export function readSetBody(raw: unknown): SetBody | null {
  const parsed = payHaltSetInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const body = parsed.data;
  if (body.reason.length < HALT_REASON_MIN || body.reason.length > HALT_REASON_MAX) return null;
  if (scopeTargetProblem(body.scope, body.target) !== null) return null;
  return body;
}

export type PayHaltSetResult = NonNullable<ReturnType<typeof payHaltSetResultSchema.parse>>;

export function setHalt(ctx: FounderCallContext, body: SetBody): Promise<FounderCallResult<PayHaltSetResult>> {
  return founderCall(ctx, 'pay', 'payHalts.set', 'POST', body, parseWith(payHaltSetResultSchema));
}
