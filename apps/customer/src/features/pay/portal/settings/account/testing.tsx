import { expect } from 'vitest';
import type { ApiResult } from '../../../../../shared/api';
import type { Resource } from '../../../../../shared/resource';
import type { ListState } from '../../hooks';

// Helpers for the account tests. Everything built with them is TEST DATA: no real person, business or amount.
export type Refusal = Extract<ApiResult<never>, { ok: false }>;
export const refusal = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Refusal => ({
  ok: false,
  reason,
  message: code,
  code,
  status,
});
export const ready = <T,>(data: T): Resource<T> => ({ status: 'ready', data });
export const failed = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Resource<never> => ({
  status: 'failed',
  failure: refusal(code, status, reason),
});
export const list = <T,>(items: T[], hasMore = false): ListState<T> => ({ status: 'ready', items, hasMore, more: 'idle' });
export const noop = () => undefined;
/** No service code may reach a reader. */
export const plain = (out: string) => expect(out).not.toMatch(/pay\.[a-z_]+/);
