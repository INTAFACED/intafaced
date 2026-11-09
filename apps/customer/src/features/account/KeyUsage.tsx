import { useMemo } from 'react';
import { keyUsageOutputSchema, type KeyUsageOutput } from '@intafaced/contracts/api-rate-limits';
import type { ApiClient, ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';

const copy = defineCopy('api-key-usage', {
  title: 'Usage',
  lead: 'What this key spent from its rate limit, as the server counted it. Reading this costs the key nothing.',
  used: 'Used',
  usedValue: '{count} tokens since {since}',
  refused: 'Refused (429)',
  refusedValue: '{count} calls',
  remaining: 'Remaining',
  remainingValue: '{count} of {burst} tokens',
  refill: 'Refill',
  refillValue: '{count} a minute',
  none: 'No calls of this key counted yet. Used 0; the full burst remains.',
  asOf: 'As of {at}',
  refresh: 'Refresh',
  loading: 'Reading usage…',
  limitsLink: 'How rate limits work',
});

export const readKeyUsage = (api: ApiClient, keyId: string, signal: AbortSignal): Promise<ApiResult<KeyUsageOutput>> =>
  api.plain('edge', `/rate-limits/keys/${encodeURIComponent(keyId)}/usage`, keyUsageOutputSchema, { signal });

/**
 * The key detail's usage panel (DV-limits-02, J-developer-06 #3): used and remaining with the time the server read them;
 * Refresh reads again and the time moves. Counts only, never a credential.
 */
export function KeyUsage({ keyId }: { keyId: string }) {
  const { t, requestedLocale } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readKeyUsage(api, keyId, signal), `key-usage:${userId}:${keyId}`);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const at = (iso: string) => `${when.format(new Date(iso))} UTC`;
  const usage = resource.status === 'ready' ? resource.data : null;
  return (
    <section data-testid="security__card" className="api-keys__detail security__card" aria-labelledby="api-key-usage">
      <h2 id="api-key-usage">{t('title')}</h2>
      <p className="muted">{t('lead')}</p>
      {resource.status === 'loading' && <Loading label={t('loading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {usage?.state === 'counted' && (
        <dl className="api-keys__facts">
          <div>
            <dt>{t('used')}</dt>
            <dd data-testid="api-keys__used">{t('usedValue', { count: usage.used, since: at(usage.since) })}</dd>
          </div>
          <div>
            <dt>{t('remaining')}</dt>
            <dd data-testid="api-keys__remaining">{t('remainingValue', { count: usage.remaining, burst: usage.burst })}</dd>
          </div>
          <div>
            <dt>{t('refused')}</dt>
            <dd data-testid="api-keys__refused">{t('refusedValue', { count: usage.refused })}</dd>
          </div>
          <div>
            <dt>{t('refill')}</dt>
            <dd>{t('refillValue', { count: usage.refillPerMinute })}</dd>
          </div>
        </dl>
      )}
      {usage?.state === 'none' && <p data-testid="api-keys__usage-none">{t('none')}</p>}
      {usage && <p data-testid="api-keys__usage-as-of">{t('asOf', { at: at(usage.asOf) })}</p>}
      <div className="api-keys__actions">
        <Button variant="secondary" onClick={reload} disabled={resource.status === 'loading'}>
          {t('refresh')}
        </Button>
        <a className="text-link" href="/developers/rate-limits">
          {t('limitsLink')}
        </a>
      </div>
    </section>
  );
}
