import { useState } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure } from '../../shared/ui';
import { subAccountFeaturesCopy as copy } from './sub-account-features-copy';
import { FEATURE_REFUSAL_KEYS, assetsView, featureResult, featuresView, type Feature } from './sub-account-features';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Balances by asset and trading-feature switches for one live sub-account (W-security-accounts-06). Balances come from the money
 * services and are not valued; an unreadable service is said so, never shown as empty. Switching a feature records a choice and
 * moves no money.
 */
export function SubaccountFeatures({ subAccountId }: { subAccountId: string }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState<Feature | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const features = useResource(
    (signal) =>
      userId && shown
        ? api.query('identity', 'subAccounts.getFeatures', { subAccountId }, featuresView, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `subaccount-features:${userId}:${subAccountId}:${shown}`,
  );
  const assets = useResource(
    (signal) =>
      userId && shown
        ? api.query('identity', 'subAccounts.assets', { subAccountId }, assetsView, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `subaccount-assets:${userId}:${subAccountId}:${shown}`,
  );

  async function flip(feature: Feature, enabled: boolean) {
    if (busy) return;
    setBusy(feature);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'subAccounts.setFeatures', { subAccountId, feature, enabled }, featureResult);
      if (!answer.ok) setFailure(answer);
      features.reload();
    } finally {
      setBusy(null);
    }
  }

  if (!shown) {
    return (
      <Button variant="ghost" aria-label={`${t('title')} ${subAccountId}`} onClick={() => setShown(true)}>
        {t('open')}
      </Button>
    );
  }
  const view = features.resource.status === 'ready' ? features.resource.data : null;
  const held = assets.resource.status === 'ready' ? assets.resource.data : null;
  const refusal = failure && failure.code ? FEATURE_REFUSAL_KEYS[failure.code] : undefined;
  return (
    <div className="stack" role="group" aria-label={t('title')}>
      <h3>{t('balancesTitle')}</h3>
      {assets.resource.status === 'loading' && <p className="muted">{t('loading')}</p>}
      {assets.resource.status === 'failed' &&
        (assets.resource.failure.code === 'identity.sub_account_check_unavailable' ? (
          <p className="notice" role="status">
            {t('assetsUnavailable')}
          </p>
        ) : (
          <Failure result={assets.resource.failure} retry={assets.reload} />
        ))}
      {held &&
        (held.balances.length === 0 ? (
          <p>{t('balancesEmpty')}</p>
        ) : (
          <ul data-testid="security__rows" className="security__rows">
            {held.balances.map((balance) => (
              <li key={balance.assetId} data-testid="security__row" className="security__row">
                {balance.amount} {balance.assetId}
              </li>
            ))}
          </ul>
        ))}
      <h3>{t('featuresTitle')}</h3>
      <p>{t('featuresBody')}</p>
      {features.resource.status === 'loading' && <p className="muted">{t('loading')}</p>}
      {features.resource.status === 'failed' && <Failure result={features.resource.failure} retry={features.reload} />}
      {view && (
        <>
          {!view.published && <p className="notice">{t('unpublished')}</p>}
          {view.frozen && <p className="notice">{t('frozenNote')}</p>}
          <ul data-testid="security__rows" className="security__rows">
            {view.features.map((row) => {
              const name = t(`feature_${row.feature}` as 'feature_spot');
              return (
                <li key={row.feature} data-testid="security__row" className="security__row">
                  <span>
                    {name}: {row.enabled ? t('on') : t('off')}
                    {row.feature === 'futures' && !row.enabled && <> · {t('futuresParked')}</>}
                    {row.feature !== 'futures' && !row.offered && !row.enabled && <> · {t('notOffered')}</>}
                  </span>
                  {row.enabled ? (
                    <Button
                      variant="secondary"
                      disabled={busy !== null || view.frozen}
                      aria-label={t('turnOff', { feature: name })}
                      onClick={() => void flip(row.feature, false)}
                    >
                      {busy === row.feature ? t('working') : t('off')}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy !== null || view.frozen || !row.offered}
                      aria-label={t('turnOn', { feature: name })}
                      onClick={() => void flip(row.feature, true)}
                    >
                      {busy === row.feature ? t('working') : t('on')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {failure &&
        (refusal ? (
          <p className="notice" role="alert">
            {t(refusal as 'refusedUnset')}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <div className="actions">
        <Button variant="ghost" disabled={busy !== null} onClick={() => setShown(false)}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
