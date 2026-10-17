import { useResource } from '../../../../shared/resource';
import { parseAmount } from '../../../../shared/money';
import type { PortalApi } from '../api';
import { NotConfigured, PortalLoading, UsageBar } from '../components';
import { isNotLive } from '../refusal';
import { NotLiveCard } from '../chrome/NotLiveCard';
import { reason } from '../chrome/copy';
import type { UsageRow } from '../schemas';
import { MoneyText } from '../ui/MoneyText';
import { DateTime } from '../ui/DateTime';
import { layoutCopy as c } from './copy';

/** How much of a limit is used, 0 to 100. Exact bigint arithmetic; the bar is only a picture of it. */
export function usagePercent(used: string | null, limit: string): number | null {
  if (used === null) return null;
  const cap = parseAmount(limit);
  if (cap <= 0n) return null;
  const pct = Number((parseAmount(used) * 10_000n) / cap) / 100;
  return Math.max(0, Math.min(100, pct));
}

/** The merchant's tier by name and the first few limits with how much of each is used. A tier that is not set says so. */
export function TierUsage({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = c.useCopy();
  const tier = useResource((s) => portal.ownTier(merchantId, s), `portal:home-tier:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `portal:home-usage:${merchantId}`);
  const own = tier.resource.status === 'ready' ? tier.resource.data : null;
  const name = own && own.status === 'configured' ? (own.tiers.find((x) => x.id === own.ownTierId)?.name ?? null) : null;
  return (
    <div className="stack">
      <p>
        <strong>{t('tierLabel')}</strong>{' '}
        {tier.resource.status === 'loading' ? '…' : name ? name : <NotConfigured>{t('tierNotSet')}</NotConfigured>}
      </p>
      {usage.resource.status === 'loading' && <PortalLoading rows={1} />}
      {usage.resource.status === 'failed' &&
        (isNotLive(usage.resource.failure) ? (
          <NotLiveCard reason={reason('reasonLimits')} />
        ) : (
          <p className="muted">{t('usageUnavailable')}</p>
        ))}
      {usage.resource.status === 'ready' && <UsageRows rows={usage.resource.data.rows.slice(0, 3)} />}
      <a className="text-link" href="/pay/limits">
        {t('allLimits')} →
      </a>
    </div>
  );
}

export function UsageRows({ rows }: { rows: readonly UsageRow[] }) {
  const { t } = c.useCopy();
  if (rows.length === 0) return <p className="muted">{t('noLimits')}</p>;
  return (
    <ul className="pp-links">
      {rows.map((row) => {
        const pct = usagePercent(row.used, row.limit);
        const label = t(`cap_${row.kind}`);
        return (
          <li key={`${row.kind}:${row.assetCode ?? ''}`}>
            <span>{label}</span> {pct !== null && <UsageBar pct={pct} label={label} />}
            <small className="muted">
              {row.used === null ? (
                t('usageUnknown')
              ) : row.assetCode ? (
                <>
                  <MoneyText value={row.used} asset={row.assetCode} /> {t('usageOf')} <MoneyText value={row.limit} asset={row.assetCode} />
                </>
              ) : (
                `${row.used} ${t('usageOf')} ${row.limit}`
              )}
              {row.resetsAt && (
                <>
                  {' · '}
                  {t('usageResets')} <DateTime value={row.resetsAt} />
                </>
              )}
            </small>
          </li>
        );
      })}
    </ul>
  );
}
