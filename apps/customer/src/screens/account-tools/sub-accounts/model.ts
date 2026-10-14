import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';

/**
 * Sub-accounts (M9). Checked on origin/main (svc-identity `subAccounts`):
 *  - `list { limit 1..200 }` -> [{ id, label, purpose, revoked, createdAt }]  (identity:read)
 *  - `create { label 1..64, purpose? ..200 }` -> { id }; refuses until the owner has set a cap on how many a person may have
 *  - `revoke { subAccountId }` -> { revoked }; closes it, moves no money
 * There is no rename and no money-moving call a customer can use: `assertTransferDoor` only checks ownership. So the
 * screen offers neither, and says so.
 */

export const LIST_LIMIT = 200;
export const LABEL_MAX = 64;
export const PURPOSE_MAX = 200;

const record = z.object({
  id: z.string().uuid(),
  label: z.string(),
  purpose: z.string().nullable(),
  revoked: z.boolean(),
  createdAt: z.string(),
});
export type SubAccountRow = z.infer<typeof record>;

export function readSubAccounts(api: ApiClient, signal: AbortSignal): Promise<ApiResult<SubAccountRow[]>> {
  return api.query('identity', 'subAccounts.list', { limit: LIST_LIMIT }, z.array(record), { signal });
}

export const labelError = (raw: string): 'empty' | 'long' | null => {
  const label = raw.trim();
  return label.length === 0 ? 'empty' : label.length > LABEL_MAX ? 'long' : null;
};
export const purposeError = (raw: string): 'long' | null => (raw.trim().length > PURPOSE_MAX ? 'long' : null);

export function createSubAccount(
  api: ApiClient,
  input: { label: string; purpose: string },
  signal?: AbortSignal,
): Promise<ApiResult<{ id: string }>> {
  const purpose = input.purpose.trim();
  return api.mutate(
    'identity',
    'subAccounts.create',
    { label: input.label.trim(), ...(purpose ? { purpose } : {}) },
    z.object({ id: z.string().uuid() }),
    { signal },
  );
}

export function closeSubAccount(api: ApiClient, subAccountId: string, signal?: AbortSignal): Promise<ApiResult<{ revoked: boolean }>> {
  return api.mutate('identity', 'subAccounts.revoke', { subAccountId }, z.object({ revoked: z.boolean() }), { signal });
}

export type CreateFailureKind = 'not-open' | 'limit' | 'on-hold' | 'uncertain' | 'signed-out' | 'other';

export function classifyCreateFailure(failure: Extract<ApiResult<unknown>, { ok: false }>): CreateFailureKind {
  const text = `${failure.code ?? ''} ${failure.message}`.toLowerCase();
  if (failure.reason === 'unauthorized') return 'signed-out';
  if (failure.reason === 'uncertain') return 'uncertain';
  if (text.includes('sub_account_cap_unset') || text.includes('max_sub_accounts is unset')) return 'not-open';
  if (text.includes('sub_account_limit') || text.includes('sub-account limit')) return 'limit';
  if (text.includes('account_frozen') || /account is (frozen|suspended|unavailable)/.test(text)) return 'on-hold';
  return 'other';
}
