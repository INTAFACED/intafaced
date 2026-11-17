import { QUANT_SANDBOX_LIMITS, type QuantSandboxLimit } from '@intafaced/contracts/quant-algo';
import type { ApiResult } from '../../shared/api';
import { limitsCopy } from './limits-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The plan limit a sandbox refusal names, read from the service's own sentence ("<code> — <limit>: …"): unset (no run
 * started) or hit (the run ended at it). Null for any other failure.
 */
export function sandboxLimitRefusalOf(result: Failed): { kind: 'unset' | 'hit'; limit: QuantSandboxLimit } | null {
  const text = result.message ?? '';
  const m = /quant\.(sandbox_limit_unset|sandbox_memory|sandbox_output|sandbox_timeout) — ([a-z_]+):/.exec(text);
  if (!m || !(QUANT_SANDBOX_LIMITS as readonly string[]).includes(m[2] ?? '')) return null;
  return { kind: m[1] === 'sandbox_limit_unset' ? 'unset' : 'hit', limit: m[2] as QuantSandboxLimit };
}

/** The sentence a customer reads for that refusal, in the plan's words. */
export function sandboxLimitSentence(
  refusal: { kind: 'unset' | 'hit'; limit: QuantSandboxLimit },
  copy: { t: (typeof limitsCopy)['t'] } = limitsCopy,
): string {
  const limit = copy.t(refusal.limit).toLowerCase();
  return refusal.kind === 'unset' ? copy.t('refusedUnset', { limit }) : copy.t('refusedHit', { limit });
}
