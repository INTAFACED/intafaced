import { QUANT_QUOTA_RESOURCES, type QuantQuotaResource } from '@intafaced/contracts/quant-algo';
import type { ApiResult } from '../../shared/api';
import { Failure } from '../../shared/ui';
import { quotaCopy } from './quota-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export type QuotaRefusalWords =
  | { kind: 'exceeded'; resource: QuantQuotaResource; used: string; limit: string; profile: string }
  | { kind: 'limitUnset'; resource: QuantQuotaResource; profile: string }
  | { kind: 'profileUnset' };

const isResource = (value: string): value is QuantQuotaResource => (QUANT_QUOTA_RESOURCES as readonly string[]).includes(value);

/**
 * svc-quant's quota refusals: `quant.quota_exceeded — <resource> — <words>: N used of L allowed by profile P`,
 * `quant.quota_unset — <resource> — the limit for <words> in profile P is not set…` and `quant.quota_profile_unset`.
 * Anything else is not a quota refusal.
 */
export function quotaRefusal(message: string): QuotaRefusalWords | null {
  const exceeded = /^quant\.quota_exceeded — ([a-z_]+) — .*: (\d+) used of (\d+) allowed by profile (.+)$/.exec(message.trim());
  if (exceeded && isResource(exceeded[1]!)) {
    return { kind: 'exceeded', resource: exceeded[1], used: exceeded[2]!, limit: exceeded[3]!, profile: exceeded[4]! };
  }
  const unset = /^quant\.quota_unset — ([a-z_]+) — .* in profile (.+) is not set/.exec(message.trim());
  if (unset && isResource(unset[1]!)) return { kind: 'limitUnset', resource: unset[1], profile: unset[2]! };
  if (/^quant\.quota_profile_unset\b/.test(message.trim())) return { kind: 'profileUnset' };
  return null;
}

/** A refused create: a quota refusal names the resource with its counts; any other refusal is shown as usual. */
export function QuotaRefusalOr({ failure, retry }: { failure: Failed; retry?: () => void }) {
  const { t } = quotaCopy.useCopy();
  const quota = quotaRefusal(failure.message);
  if (!quota) return <Failure result={failure} retry={retry} />;
  return (
    <p
      role="alert"
      className="error-text"
      data-testid="quant-quota-refusal"
      data-kind={quota.kind}
      data-resource={quota.kind === 'profileUnset' ? '' : quota.resource}
    >
      {quota.kind === 'exceeded'
        ? t('exceeded', { resource: t(quota.resource), used: quota.used, limit: quota.limit, profile: quota.profile })
        : quota.kind === 'limitUnset'
          ? t('limitUnset', { resource: t(quota.resource), profile: quota.profile })
          : t('profileUnset')}
    </p>
  );
}
