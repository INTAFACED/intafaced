import { useMemo } from 'react';
import type { ZodType } from 'zod';
import type { ApiClient, ApiResult } from '../../../../shared/api';
import { useSession } from '../../../session/session';
import { portalTools } from '../api-tools';
import { portalRefusal, refusalText } from '../refusal';
import { analyticsApi } from './analytics/client';
import { developersApi } from './developers/client';
import { reportsApi } from './reports/client';

/**
 * The calls the developers, reports and analytics pages make. They sit beside the shared portal client, not inside it,
 * so no other package's client file is touched. `identity` is the sign-in service: it owns API keys and request signing.
 */
export function settingsBTools(api: ApiClient, userId: string | null) {
  const pay = portalTools(api, userId);
  const denied = () => (userId ? null : portalRefusal('signInRequired', 'unauthorized'));
  async function identityQuery<T>(procedure: string, input: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
    return denied() ?? api.query('identity', procedure, input, schema, { signal });
  }
  async function identityMutate<T>(procedure: string, input: unknown, schema: ZodType<T>): Promise<ApiResult<T>> {
    const no = denied();
    if (no) return no;
    const result = await api.mutate('identity', procedure, input, schema);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  return { ...pay, identityQuery, identityMutate };
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
