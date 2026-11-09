import { QUANT_QUOTA_RESOURCES, type QuantQuotaResource } from '@intafaced/contracts/quant-algo';
import type { ApiResult } from '../../shared/api';
import { Failure } from '../../shared/ui';
import { usageCopy } from './usage-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** The resource a plan refusal names, and its counts, read from the service's own refusal ("<resource>: <n> used of <m> allowed"). */
export function quotaRefusalOf(
  result: Failed,
):
  | { kind: 'exceeded'; resource: QuantQuotaResource; used: string; limit: string }
  | { kind: 'unset'; resource: QuantQuotaResource }
  | { kind: 'profile_unset' }
  | null {
  const text = result.message ?? '';
  const resourceOf = (raw: string | undefined) =>
    raw && (QUANT_QUOTA_RESOURCES as readonly string[]).includes(raw) ? (raw as QuantQuotaResource) : null;
  if (result.code === 'quant.quota_exceeded' || text.startsWith('quant.quota_exceeded')) {
    const m = /quant\.quota_exceeded — ([a-z_]+): (\d+) used of (\d+) allowed/.exec(text);
    const resource = resourceOf(m?.[1]);
    return m && resource ? { kind: 'exceeded', resource, used: m[2] ?? '', limit: m[3] ?? '' } : null;
  }
  if (result.code === 'quant.quota_unset' || text.startsWith('quant.quota_unset')) {
    const resource = resourceOf(/quant\.quota_unset — ([a-z_]+):/.exec(text)?.[1]);
    return resource ? { kind: 'unset', resource } : null;
  }
  if (result.code === 'quant.quota_profile_unset' || text.startsWith('quant.quota_profile_unset')) return { kind: 'profile_unset' };
  return null;
}

/** A failure, said in the plan's words when the plan refused it; any other failure reads as it always does. */
export function QuotaAwareFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { t } = usageCopy.useCopy();
  const quota = quotaRefusalOf(result);
  if (!quota) return <Failure result={result} retry={retry} />;
  const body =
    quota.kind === 'exceeded'
      ? t('exceeded', { resource: t(quota.resource).toLowerCase(), used: quota.used, limit: quota.limit })
      : quota.kind === 'unset'
        ? t('unset', { resource: t(quota.resource).toLowerCase() })
        : t('profileUnset');
  return (
    <div
      data-testid="quant-quota-refusal"
      data-resource={quota.kind === 'profile_unset' ? '' : quota.resource}
      data-kind={quota.kind}
      className="failure"
      role="status"
    >
      <h3>{t('refusedTitle')}</h3>
      <p>{body}</p>
      <a className="text-link" href="/quant/strategies">
        {t('refusedUsage')}
      </a>
    </div>
  );
}
