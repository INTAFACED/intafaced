import { z } from 'zod';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import {
  PAY_ALLOWLIST_CANCEL,
  PAY_ALLOWLIST_GET,
  PAY_ALLOWLIST_LIST_CHANGES,
  PAY_ALLOWLIST_LIST_ENTRIES,
  PAY_ALLOWLIST_MODE,
  PAY_ALLOWLIST_POLICY,
  PAY_ALLOWLIST_PROPOSE_ADD,
  PAY_ALLOWLIST_PROPOSE_DELETE,
  PAY_ALLOWLIST_PROPOSE_POLICY,
  PAY_ALLOWLIST_SET_MODE,
} from '@intafaced/contracts/pay-allowlist-procedures';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { allowlistCopy } from './withdrawal-allowlist-copy';

// svc-pay's `allowlist.*` calls, each by its record (`@intafaced/contracts/pay-allowlist-procedures`). The list says where
// money MAY go; it is not a balance and moves nothing.
export type AllowlistEntry = ProcedureOutput<typeof PAY_ALLOWLIST_LIST_ENTRIES>[number];
export type AllowlistChange = ProcedureOutput<typeof PAY_ALLOWLIST_GET>;
export type AllowlistMode = ProcedureOutput<typeof PAY_ALLOWLIST_MODE>;
export type AllowlistPolicy = ProcedureOutput<typeof PAY_ALLOWLIST_POLICY>;
export type AllowlistSetModeResult = ProcedureOutput<typeof PAY_ALLOWLIST_SET_MODE>;
export type AllowlistGroup = AllowlistEntry['group'];

const id = z.string().guid();
const changeIdSchema = id.transform((value) => value.toLowerCase());
const limitSchema = z.number().int().min(1).max(200);

/** `?changeId=` on the room: none means the overview, one valid id means the detail, anything else is invalid. */
export function requestedChange(search: string): { ok: true; id: string | null } | { ok: false } {
  const values = new URLSearchParams(search).getAll('changeId');
  if (!values.length) return { ok: true, id: null };
  if (values.length !== 1) return { ok: false };
  const parsed = changeIdSchema.safeParse(values[0]);
  return parsed.success ? { ok: true, id: parsed.data } : { ok: false };
}

type FailureKey = 'invalidId' | 'invalidWindow' | 'signedOut';
function refuse(code: string, key: FailureKey) {
  return { ok: false as const, reason: 'invalid_response' as const, code, message: allowlistCopy.t(key) };
}

export function createAllowlistReads(api: ApiClient, userId: string | null, current: () => boolean) {
  function admission(signal?: AbortSignal) {
    if (!current() || signal?.aborted) return authoredRefusal('aborted', { key: 'accountChanged' });
    return !userId ? { ...refuse('allowlist.session_required', 'signedOut'), reason: 'unauthorized' as const } : null;
  }
  /** Rows named for anyone else are never shown: the list is the caller's own. */
  const ownRows = <T extends { userId: string }>(rows: T[], limit: number) =>
    rows.every((row) => row.userId === userId) && rows.length <= limit;
  return {
    async mode(signal?: AbortSignal): Promise<ApiResult<AllowlistMode>> {
      const denied = admission(signal);
      if (denied) return denied;
      const result = await api.call(PAY_ALLOWLIST_MODE, {}, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && result.data.userId !== userId ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async policy(signal?: AbortSignal): Promise<ApiResult<AllowlistPolicy>> {
      const denied = admission(signal);
      if (denied) return denied;
      const result = await api.call(PAY_ALLOWLIST_POLICY, {}, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && result.data.userId !== userId ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async entries(limit: number, signal?: AbortSignal): Promise<ApiResult<AllowlistEntry[]>> {
      const denied = admission(signal);
      if (denied) return denied;
      if (!limitSchema.safeParse(limit).success) return refuse('allowlist.window_invalid', 'invalidWindow');
      const result = await api.call(PAY_ALLOWLIST_LIST_ENTRIES, { limit }, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && !ownRows(result.data, limit) ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async changes(limit: number, signal?: AbortSignal): Promise<ApiResult<AllowlistChange[]>> {
      const denied = admission(signal);
      if (denied) return denied;
      if (!limitSchema.safeParse(limit).success) return refuse('allowlist.window_invalid', 'invalidWindow');
      const result = await api.call(PAY_ALLOWLIST_LIST_CHANGES, { limit }, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && !ownRows(result.data, limit) ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async get(changeId: string, signal?: AbortSignal): Promise<ApiResult<AllowlistChange>> {
      const denied = admission(signal);
      if (denied) return denied;
      const parsed = changeIdSchema.safeParse(changeId);
      if (!parsed.success) return refuse('allowlist.input_invalid', 'invalidId');
      const result = await api.call(PAY_ALLOWLIST_GET, { changeId: parsed.data }, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && result.data.id.toLowerCase() !== parsed.data ? refuse('allowlist.input_invalid', 'invalidId') : result;
    },
    /** Cancel the caller's own waiting change (`trade:write`, no step-up). Returns the change as the service now records it. */
    async cancel(changeId: string): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      const parsed = changeIdSchema.safeParse(changeId);
      if (!parsed.success) return refuse('allowlist.input_invalid', 'invalidId');
      return api.call(PAY_ALLOWLIST_CANCEL, { changeId: parsed.data });
    },
    // The four calls below need `trade:withdraw`. Each carries the one-use token from `WithdrawStepUp` as its own bearer;
    // the session is never swapped. `clientRef` is the request's own reference, fixed when the person starts the action
    // so a retry of the same action is the same request.
    /** Switch the list on (applies at once) or ask to switch it off (a request for the team). */
    async setMode(enabled: boolean, clientRef: string, token: string): Promise<ApiResult<AllowlistSetModeResult>> {
      const denied = admission();
      if (denied) return denied;
      return api.call(PAY_ALLOWLIST_SET_MODE, { enabled, clientRef }, { bearer: token });
    },
    async proposeAdd(
      input: { group: AllowlistGroup; assetId: string; address: string; label: string; clientRef: string },
      token: string,
    ): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.call(PAY_ALLOWLIST_PROPOSE_ADD, input, { bearer: token });
    },
    async proposeDelete(entryId: string, clientRef: string, token: string): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.call(PAY_ALLOWLIST_PROPOSE_DELETE, { entryId, clientRef }, { bearer: token });
    },
    async proposePolicy(
      input: { enabled: boolean; assetId: string; maxAmount: string; clientRef: string },
      token: string,
    ): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.call(PAY_ALLOWLIST_PROPOSE_POLICY, input, { bearer: token });
    },
  };
}
