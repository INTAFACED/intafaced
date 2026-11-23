import type { z, ZodType } from 'zod';
import type { ProcedureInput, ProcedureOutput } from '@intafaced/contracts/procedure';
import { callAs, type ApiClient, type ApiResult, type AppProcedure } from '../../../shared/api';
import { portalRefusal, refusalText } from './refusal';
import * as p from './schemas';
import { confirmDestination, type DestinationProof } from './access/destination-step-up';

export const PAGE_SIZE = 25;

/** A record the portal sends to svc-pay. */
type PayRecord = AppProcedure & { readonly module: 'pay' };

/**
 * The three ways any portal call is made. Each package builds its own methods on these, so no package edits
 * another's client. The merchant is never taken from here: every procedure scopes itself from the signed session.
 */
export function portalTools(api: ApiClient, userId: string | null) {
  const signedIn = () => (userId ? null : portalRefusal('signInRequired', 'unauthorized'));
  async function query<T>(procedure: string, input: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
    return signedIn() ?? api.query('pay', procedure, input, schema, { signal });
  }
  /** A refused change comes back with its message already in plain words, because the shared review dialog prints `message` as it finds it. */
  async function mutate<T>(procedure: string, input: unknown, schema: ZodType<T>, opts?: { keepalive?: boolean }): Promise<ApiResult<T>> {
    const denied = signedIn();
    if (denied) return denied;
    const result = opts?.keepalive
      ? await api.mutate('pay', procedure, input, schema, { keepalive: true })
      : await api.mutate('pay', procedure, input, schema);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  const list = <T extends z.ZodTypeAny>(procedure: string, item: T, input: Record<string, unknown>, signal?: AbortSignal) =>
    query(procedure, { limit: PAGE_SIZE, ...input }, p.page(item), signal);
  /** `query` by the call's written record: its path, input type and answer come from the record svc-pay mounts. */
  async function queryRecord<R extends PayRecord>(
    record: R,
    input: ProcedureInput<R>,
    signal?: AbortSignal,
  ): Promise<ApiResult<ProcedureOutput<R>>> {
    return signedIn() ?? api.call(record, input, { signal });
  }
  /**
   * `queryRecord` read through this caller's own stricter schema (a `.refine()` tying the answer to what was asked): an
   * answer it refuses reads as unverified, and the caller gets what the schema parses, as when it called by name.
   */
  async function queryRecordAs<R extends PayRecord, T>(
    record: R,
    input: ProcedureInput<R>,
    schema: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<ApiResult<T>> {
    return signedIn() ?? callAs(api, record, input, schema, { signal });
  }
  /** `mutate` by the call's written record, its refusal in plain words as `mutate`'s is. */
  async function mutateRecord<R extends PayRecord>(
    record: R,
    input: ProcedureInput<R>,
    opts?: { keepalive?: boolean },
  ): Promise<ApiResult<ProcedureOutput<R>>> {
    const denied = signedIn();
    if (denied) return denied;
    const result = await api.call(record, input, opts?.keepalive ? { keepalive: true } : {});
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  /** `list` by the call's written record: the first page of `PAGE_SIZE`, the rest of its input as given. */
  const listRecord = <R extends PayRecord>(record: R, input: Omit<ProcedureInput<R>, 'limit'>, signal?: AbortSignal) =>
    queryRecord(record, { limit: PAGE_SIZE, ...input } as ProcedureInput<R>, signal);
  /** `listRecord` read through this caller's own stricter row schema, as `queryRecordAs` reads its answer. */
  const listRecordAs = <R extends PayRecord, T extends z.ZodTypeAny>(
    record: R,
    input: Omit<ProcedureInput<R>, 'limit'>,
    item: T,
    signal?: AbortSignal,
  ) => queryRecordAs(record, { limit: PAGE_SIZE, ...input } as ProcedureInput<R>, p.page(item), signal);
  /** The fresh-code confirmation a payout destination needs is asked of the identity service, on the same session. */
  const confirmDestinationStepUp = (
    destination: { merchantId: string; railId: string; kind: string; ref: string },
    proof: DestinationProof,
  ) => signedIn() ?? confirmDestination(api, destination, proof);
  return { userId, query, mutate, list, queryRecord, queryRecordAs, mutateRecord, listRecord, listRecordAs, confirmDestinationStepUp };
}
export type PortalTools = ReturnType<typeof portalTools>;
