import { createApiClient, parsesAs, type ApiClient, type ApiResult } from '../../shared/api';
import { z } from 'zod';
import { bankWriteForReview } from './contracts';
import { settleRefusal } from './money-refusal-copy';
import type { ActionSpec } from './components';

/** The name a spec's call goes by: its record's path, or the name it gives while it has no record. */
export const writeName = (spec: ActionSpec): string => (spec.record ? spec.record.path : spec.procedure);

/**
 * Sends one reviewed bank write, the one way every write dialog does: by its record when it has one (`api.call`), else by
 * name, and either way the answer is held to what was reviewed (`bankWriteForReview`) and to the spec's own check.
 */
export function sendWrite(
  api: Pick<ApiClient, 'call' | 'mutate'>,
  spec: ActionSpec,
  sent: Record<string, unknown>,
  input: Record<string, unknown>,
): Promise<ApiResult<unknown>> {
  const verified = (data: unknown) => spec.verifyOutcome?.(data, input) ?? true;
  if (spec.record)
    return api.call(spec.record, sent, { accept: parsesAs(bankWriteForReview(spec.record.path, input, z.unknown()).refine(verified)) });
  return api.mutate('bank', spec.procedure, sent, bankWriteForReview(spec.procedure, input).refine(verified));
}

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
  const sent = await sendWrite(api, spec, input, input);
  const settled = settleRefusal(sent, writeName(spec));
  return { input, outcome: settled.outcome, refusedFirst: settled.refusedFirst };
}
