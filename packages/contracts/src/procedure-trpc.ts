import type { z } from 'zod';
import { replyAccepted, type ProcedureRecord, type TrpcTransport } from './procedure.js';
import { unwrapTrpcData } from './action-approval-client.js';

type TrpcRecord = ProcedureRecord & TrpcTransport;

/**
 * Where and how one service sends a tRPC call to another, from the call's record: the path, the method (a query is a GET
 * with `?input=`, a mutation a POST with the body) and the input, checked against the record before it leaves. The caller
 * keeps its own fetch, signing, timeout and error reading, so moving a call onto its record changes nothing on the wire.
 */
export function trpcRecordRequest<R extends TrpcRecord>(
  record: R,
  baseUrl: string,
  input: z.input<R['input']>,
): { readonly url: string; readonly method: 'GET' | 'POST'; readonly body?: string } {
  const target = `${baseUrl.replace(/\/$/, '')}/trpc/${record.path}`;
  const parsed: unknown = input === undefined ? undefined : record.input.parse(input);
  const payload = parsed === undefined ? undefined : JSON.stringify(parsed);
  if (record.kind === 'query')
    return { url: payload === undefined ? target : `${target}?input=${encodeURIComponent(payload)}`, method: 'GET' };
  return { url: target, method: 'POST', ...(payload === undefined ? {} : { body: payload }) };
}

/**
 * A tRPC reply read by its record: the envelope unwrapped, the data parsed by `record.output` and the record's `accept`
 * checks run. `null` when the reply is not the published shape, so a caller never hands on what it could not verify.
 */
export function trpcRecordReply<R extends TrpcRecord>(record: R, body: unknown): z.output<R['output']> | null {
  const parsed = record.output.safeParse(unwrapTrpcData(body));
  if (!parsed.success || !replyAccepted(record, parsed.data)) return null;
  return parsed.data as z.output<R['output']>;
}
