import { useMemo } from 'react';
import type { ZodType } from 'zod';
import type { ProcedureInput, ProcedureOutput } from '@intafaced/contracts/procedure';
import type { ApiClient, ApiResult, AppProcedure } from '../../../../shared/api';
import { useSession } from '../../../session';
import { portalTools } from '../api-tools';
import { portalRefusal, refusalText } from '../refusal';
import { analyticsApi } from './analytics/client';
import { developersApi } from './developers/client';
import { reportsApi } from './reports/client';

/** A record the developer pages send to svc-identity. */
type IdentityRecord = AppProcedure & { readonly module: 'identity' };

/**
 * The calls the developers, reports and analytics pages make. They sit beside the shared portal client, not inside it,
 * so no other package's client file is touched. `identity` is the sign-in service: it owns API keys and request signing.
 */
export function settingsBTools(api: ApiClient, userId: string | null) {
  const pay = portalTools(api, userId);
  const denied = () => (userId ? null : portalRefusal('signInRequired', 'unauthorized'));
  async function identityMutate<T>(procedure: string, input: unknown, schema: ZodType<T>): Promise<ApiResult<T>> {
    const no = denied();
    if (no) return no;
    const result = await api.mutate('identity', procedure, input, schema);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  /** `identityQuery` by the call's written record: its path, input type and answer come from the record svc-identity mounts. */
  async function identityQueryRecord<R extends IdentityRecord>(
    record: R,
    input: ProcedureInput<R>,
    signal?: AbortSignal,
  ): Promise<ApiResult<ProcedureOutput<R>>> {
    return denied() ?? api.call(record, input, { signal });
  }
  /** `identityMutate` by the call's written record, its refusal in plain words as `identityMutate`'s is. */
  async function identityMutateRecord<R extends IdentityRecord>(
    record: R,
    input: ProcedureInput<R>,
  ): Promise<ApiResult<ProcedureOutput<R>>> {
    const no = denied();
    if (no) return no;
    const result = await api.call(record, input);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  return { ...pay, identityMutate, identityQueryRecord, identityMutateRecord };
}
export type SettingsBTools = ReturnType<typeof settingsBTools>;

export function settingsBApi(api: ApiClient, userId: string | null) {
  const tools = settingsBTools(api, userId);
  return { ...developersApi(tools), ...reportsApi(tools), ...analyticsApi(tools) };
}
export type SettingsBApi = ReturnType<typeof settingsBApi>;

/** The client a page reads. Built once per signed-in person. */
export function useSettingsBApi(): SettingsBApi {
  const { api, userId } = useSession();
  return useMemo(() => settingsBApi(api, userId), [api, userId]);
}
