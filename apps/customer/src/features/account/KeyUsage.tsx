import { useMemo } from 'react';
import { keyUsageOutputSchema, type KeyUsageOutput } from '@intafaced/contracts/api-rate-limits';
import type { ApiClient, ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { Failure, Loading } from './kit-parts';

const keyUsageCopy = defineCopy('api-key-usage', {
  title: 'Usage',
  lead: 'What this key spent from its rate limit, as the server counted it. Reading this costs the key nothing.',
  used: 'Used',
  usedTail: 'tokens since {since}',
  refused: 'Refused (429)',
  refusedValue: '{count} calls',
  remaining: 'Remaining',
  remainingTail: 'of {burst} tokens',
  limits: 'Limits',
  refill: 'Refill',
  refillValue: '{count} a minute',
  none: 'No calls of this key counted yet. Used 0; the full burst remains.',
  asOf: 'As of {at}',
  refresh: 'Refresh usage',
  loading: 'Reading usage…',
  limitsLink: 'How rate limits work',
});

export const readKeyUsage = (api: ApiClient, keyId: string, signal: AbortSignal): Promise<ApiResult<KeyUsageOutput>> =>
  api.plain('edge', `/rate-limits/keys/${encodeURIComponent(keyId)}/usage`, keyUsageOutputSchema, { signal });

/**
 * The key detail's usage panel (DV-limits-02, J-developer-06 #3): used and remaining with the time the server read them;
 * Refresh reads again and the time moves. Counts only, never a credential. The counts sit in a "Limits" region
 * (J-developer-08 #5): used and remaining as whole numbers, with the time they were read.
 */
export function KeyUsage({ keyId }: { keyId: string }) {
  const { t, requestedLocale } = keyUsageCopy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readKeyUsage(api, keyId, signal), `key-usage:${userId}:${keyId}`);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const at = (iso: string) => `${when.format(new Date(iso))} UTC`;
  const usage = resource.status === 'ready' ? resource.data : null;
  return (
    <section data-testid="security__card" aria-labelledby="api-key-usage">
      <h2 id="api-key-usage">{t('title')}</h2>
      <p className="lt-hint">{t('lead')}</p>
      {resource.status === 'loading' && <Loading label={t('loading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      <div role="region" aria-label={t('limits')}>
        {usage?.state === 'counted' && (
          <KeyValue
            rows={[
              {
                label: t('used'),
                value: (
                  <span data-testid="api-keys__used">
                    <span data-testid="api-keys__limit-used">{usage.used}</span> {t('usedTail', { since: at(usage.since) })}
                  </span>
                ),
              },
              {
                label: t('remaining'),
                value: (
                  <span data-testid="api-keys__remaining">
                    <span data-testid="api-keys__limit-remaining">{usage.remaining}</span> {t('remainingTail', { burst: usage.burst })}
                  </span>
                ),
              },
              { label: t('refused'), value: <span data-testid="api-keys__refused">{t('refusedValue', { count: usage.refused })}</span> },
              { label: t('refill'), value: t('refillValue', { count: usage.refillPerMinute }) },
            ]}
          />
        )}
        {usage?.state === 'none' && <p data-testid="api-keys__usage-none">{t('none')}</p>}
        {usage && (
          <p data-testid="api-keys__usage-as-of">
            <span data-testid="api-keys__limits-as-of">
              <time dateTime={usage.asOf}>{t('asOf', { at: at(usage.asOf) })}</time>
            </span>
          </p>
        )}
      </div>
      <div className="lt-actions">
        <Button tone="secondary" onClick={reload} disabled={resource.status === 'loading'}>
          {t('refresh')}
        </Button>
        <a className="lt-link" href="/developers/rate-limits">
          {t('limitsLink')}
        </a>
      </div>
    </section>
  );
}
