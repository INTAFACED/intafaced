import { createApiClient, type ApiResult } from '../../shared/api';
import { bankWriteForReview } from './contracts';
import { settleRefusal } from './money-refusal-copy';
import type { ActionSpec } from './components';

/** The wire answer of a tRPC mutation. */
export const wire = (data: unknown) => new Response(JSON.stringify({ result: { data } }));
/** A typed refusal exactly as the bank sends it: the HTTP status, and its code under `data.cause.code`. */
export const refusal = (status: number, code: string, message = 'operator text') =>
  new Response(JSON.stringify({ error: { message, code: -32603, data: { code: 'BAD_REQUEST', httpStatus: status, cause: { code } } } }), {
    status,
  });

/**
 * Sends a reviewed action the way the confirm dialog does: the spec builds the request from the typed values and the
 * request id, the reply is checked against what was reviewed, and a refusal is read for plain words. Tests only.
 */
export async function sendReviewed(
  spec: ActionSpec,
  values: Record<string, string>,
  requestId: string,
  fetcher: typeof fetch,
): Promise<{ input: Record<string, unknown>; outcome: ApiResult<unknown>; refusedFirst: boolean }> {
  const api = createApiClient({ fetch: fetcher });
  const input = spec.input(values, requestId);
  const sent = await api.mutate(
    'bank',
    spec.procedure,
    input,
    bankWriteForReview(spec.procedure, input).refine((data) => spec.verifyOutcome?.(data, input) ?? true),
  );
  const settled = settleRefusal(sent, spec.procedure);
  return { input, outcome: settled.outcome, refusedFirst: settled.refusedFirst };
}
