import { z } from 'zod';
import {
  payAllowlistChangeSchema as changeSchema,
  payAllowlistEntrySchema as entrySchema,
  payAllowlistModeSchema as modeSchema,
  payAllowlistPolicySchema as policySchema,
  payAllowlistSetModeResultSchema as setModeResultSchema,
} from '@intafaced/contracts/pay-money-room';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { allowlistCopy } from './withdrawal-allowlist-copy';

// Published svc-pay `allowlist.*` views, from `@intafaced/contracts/pay-money-room`. The list says where money MAY go; it is
// not a balance and moves nothing.
export {
  PAY_ALLOWLIST_CHANGE_STATUSES as CHANGE_STATUSES,
  payAllowlistChangeSchema as changeSchema,
  payAllowlistEntrySchema as entrySchema,
  payAllowlistModeSchema as modeSchema,
  payAllowlistPolicySchema as policySchema,
  payAllowlistSetModeResultSchema as setModeResultSchema,
} from '@intafaced/contracts/pay-money-room';
export type AllowlistEntry = z.infer<typeof entrySchema>;
export type AllowlistChange = z.infer<typeof changeSchema>;
export type AllowlistMode = z.infer<typeof modeSchema>;
export type AllowlistPolicy = z.infer<typeof policySchema>;
export type AllowlistSetModeResult = z.infer<typeof setModeResultSchema>;
export type AllowlistGroup = z.infer<typeof entrySchema>['group'];

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
      const result = await api.query('pay', 'allowlist.mode', {}, modeSchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && result.data.userId !== userId ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async policy(signal?: AbortSignal): Promise<ApiResult<AllowlistPolicy>> {
      const denied = admission(signal);
      if (denied) return denied;
      const result = await api.query('pay', 'allowlist.policy', {}, policySchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && result.data.userId !== userId ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async entries(limit: number, signal?: AbortSignal): Promise<ApiResult<AllowlistEntry[]>> {
      const denied = admission(signal);
      if (denied) return denied;
      if (!limitSchema.safeParse(limit).success) return refuse('allowlist.window_invalid', 'invalidWindow');
      const result = await api.query('pay', 'allowlist.listEntries', { limit }, z.array(entrySchema), { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && !ownRows(result.data, limit) ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async changes(limit: number, signal?: AbortSignal): Promise<ApiResult<AllowlistChange[]>> {
      const denied = admission(signal);
      if (denied) return denied;
      if (!limitSchema.safeParse(limit).success) return refuse('allowlist.window_invalid', 'invalidWindow');
      const result = await api.query('pay', 'allowlist.listChanges', { limit }, z.array(changeSchema), { signal });
      const departed = admission(signal);
      if (departed) return departed;
      return result.ok && !ownRows(result.data, limit) ? refuse('allowlist.window_invalid', 'invalidWindow') : result;
    },
    async get(changeId: string, signal?: AbortSignal): Promise<ApiResult<AllowlistChange>> {
      const denied = admission(signal);
      if (denied) return denied;
      const parsed = changeIdSchema.safeParse(changeId);
      if (!parsed.success) return refuse('allowlist.input_invalid', 'invalidId');
      const result = await api.query('pay', 'allowlist.get', { changeId: parsed.data }, changeSchema, { signal });
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
      return api.mutate('pay', 'allowlist.cancel', { changeId: parsed.data }, changeSchema);
    },
    // The four calls below need `trade:withdraw`. Each carries the one-use token from `WithdrawStepUp` as its own bearer;
    // the session is never swapped. `clientRef` is the request's own reference, fixed when the person starts the action
    // so a retry of the same action is the same request.
    /** Switch the list on (applies at once) or ask to switch it off (a request for the team). */
    async setMode(enabled: boolean, clientRef: string, token: string): Promise<ApiResult<AllowlistSetModeResult>> {
      const denied = admission();
      if (denied) return denied;
      return api.mutate('pay', 'allowlist.setMode', { enabled, clientRef }, setModeResultSchema, { bearer: token });
    },
    async proposeAdd(
      input: { group: AllowlistGroup; assetId: string; address: string; label: string; clientRef: string },
      token: string,
    ): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.mutate('pay', 'allowlist.proposeAdd', input, changeSchema, { bearer: token });
    },
    async proposeDelete(entryId: string, clientRef: string, token: string): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.mutate('pay', 'allowlist.proposeDelete', { entryId, clientRef }, changeSchema, { bearer: token });
    },
    async proposePolicy(
      input: { enabled: boolean; assetId: string; maxAmount: string; clientRef: string },
      token: string,
    ): Promise<ApiResult<AllowlistChange>> {
      const denied = admission();
      if (denied) return denied;
      return api.mutate('pay', 'allowlist.proposePolicy', input, changeSchema, { bearer: token });
    },
  };
}
