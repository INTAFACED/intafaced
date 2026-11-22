import { PaySection } from '../../../components';
import { Gate } from '../../components';
import { KpiStrip } from '../../ui/Kpi';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { isPayKey } from './model';
import type { ApiKey, Health } from './schemas';

const tools = [
  ['/pay/payments?view=tools', 'toolPayment', 'toolPaymentBody'],
  ['/pay/links?view=tools', 'toolLink', 'toolLinkBody'],
  ['/pay/settlements?view=tools', 'toolSettlement', 'toolSettlementBody'],
  ['/pay/payouts?view=tools', 'toolPayout', 'toolPayoutBody'],
] as const;

/** Test mode at a glance: what you have set up, what has been delivered, and the tools that make test activity. */
export function Sandbox({ api }: { api: SettingsBApi }) {
  const keys = useResource((signal) => api.keysList(signal), 'dev:sandbox:keys');
  const health = useResource((signal) => api.webhookHealth(signal), 'dev:sandbox:health');
  return <SandboxView keys={keys.resource} health={health.resource} reload={() => (keys.reload(), health.reload())} />;
}

export function SandboxView({ keys, health, reload }: { keys: Resource<ApiKey[]>; health: Resource<Health>; reload: () => void }) {
  const { t } = c.useCopy();
  const testKeys =
    keys.status === 'ready' ? keys.data.filter((k) => k.mode === 'sandbox' && isPayKey(k.scopes) && !k.revoked).length : null;
  const endpointsOn = health.status === 'ready' ? health.data.endpoints.filter((e) => e.status === 'active').length : null;
  const sum = (key: 'delivered' | 'failed' | 'dead') =>
    health.status === 'ready' ? health.data.endpoints.reduce((n, e) => n + e.deliveries[key], 0) : null;
  const delivered = sum('delivered');
  const failed = health.status === 'ready' ? (sum('failed') ?? 0) + (sum('dead') ?? 0) : null;
  const dash = '—';
  const step = (done: boolean | null) => (done === null ? t('stepUnknown') : done ? t('stepDone') : t('stepTodo'));
  return (
    <div className="stack">
      <p className="pp-callout">
        <strong>{t('testOnlyTitle')}</strong> {t('sandboxIntro')}
      </p>
      <KpiStrip
        label={t('sandboxTitle')}
        tiles={[
          { label: t('tileTestKeys'), period: t('rightNow'), href: '/pay/developer/keys?status=active', value: testKeys ?? dash },
          { label: t('tileEndpointsOn'), period: t('rightNow'), href: '/pay/developer/webhooks?status=active', value: endpointsOn ?? dash },
          {
            label: t('deliveredTile'),
            period: t('allEndpoints'),
            href: '/pay/developer/deliveries?status=delivered',
            value: delivered ?? dash,
          },
          { label: t('failedOrGaveUpTile'), period: t('allEndpoints'), href: '/pay/developer/deliveries', value: failed ?? dash },
        ]}
      />
      {(keys.status === 'failed' || health.status === 'failed') && (
        <p className="muted" role="status">
          {t('someCountsMissing')}{' '}
          <button type="button" className="text-link" onClick={reload}>
            {t('tryAgain')}
          </button>
        </p>
      )}
      <PaySection title={t('gettingStarted')} description={t('gettingStartedBody')}>
        <ol className="pp-checklist">
          <li>
            <a className="text-link" href="/pay/developer/keys#create">
              {t('stepKey')}
            </a>
            <span className="muted">{step(testKeys === null ? null : testKeys > 0)}</span>
          </li>
          <li>
            <a className="text-link" href="/pay/developer/webhooks#add">
              {t('stepEndpoint')}
            </a>
            <span className="muted">{step(endpointsOn === null ? null : endpointsOn > 0)}</span>
          </li>
          <li>
            <a className="text-link" href="/pay/developer/deliveries">
              {t('stepEvent')}
            </a>
            <span className="muted">{step(delivered === null ? null : delivered > 0)}</span>
          </li>
        </ol>
      </PaySection>
      <PaySection title={t('toolsTitle')} description={t('toolsBody')}>
        <ul className="pp-tool-list">
          {tools.map(([href, title, body]) => (
            <li key={href}>
              <a className="text-link" href={href}>
                {t(title)}
              </a>
              <small className="muted">{t(body)}</small>
            </li>
          ))}
        </ul>
      </PaySection>
    </div>
  );
}
