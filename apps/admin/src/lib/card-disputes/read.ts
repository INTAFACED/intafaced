import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { parseCase, parseQueue, refusalWords, type DisputeCase, type DisputeState, type DisputeSummary } from './model';

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for card disputes. Reading needs admin:read.',
  refusedMessage: refusalWords,
} as const;

/** The queue, one state or every case, as svc-bank lists it. */
export async function readDisputeQueue(
  ctx: FounderCallContext,
  state: DisputeState | null,
): Promise<{ asOf: string; queue: Part<DisputeSummary[]> }> {
  const result = await founderCall(ctx, 'bank', 'ops.cardDisputes', 'GET', state ? { state } : {}, parseQueue);
  return { asOf: new Date().toISOString(), queue: partFrom(result, (d) => d, labels) };
}

/** One case with its timeline. */
export async function readDisputeCase(ctx: FounderCallContext, disputeId: string): Promise<{ asOf: string; dispute: Part<DisputeCase> }> {
  const result = await founderCall(ctx, 'bank', 'ops.cardDispute', 'GET', { disputeId }, parseCase);
  return { asOf: new Date().toISOString(), dispute: partFrom(result, (d) => d, labels) };
}
