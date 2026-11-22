// volt-room: /pay/network/:childId
// volt-room: portal:network-child
import { KeyValue } from '@intafaced/ui/lit/templates';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { PortalApi } from '../../api';
import { DateTime } from '../../ui/DateTime';
import { uiCopy } from '../../ui/copy';
import { reason as notLive } from '../../chrome/copy';
import { Chip, Empty, EntityList, Facts, LinkButton, MoneyText, ReadGate, Section } from '../../volt/parts';
import { MonitorRoom } from '../../volt/MonitorRoom';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';
import { areaWords, bpsPercent, isPlatformAccount, nodeName } from '../account/model';
import type { SubMerchant, SubSummary } from '../account/schemas';
import { NotPlatform } from './NotPlatform';

/** `/pay/network/:child` on the monitor template, for the account the access resolved. */
export function NetworkChildRoom({ portal, childId, mode }: { portal: PortalApi; childId: string; mode: string | null }) {
  return <MonitorRoom>{() => ({ panels: <NetworkChild portal={portal} childId={childId} mode={mode} /> })}</MonitorRoom>;
}

/** `/pay/network/:child`: one sub-merchant, its last 30 days, its newest payments and who holds permissions over it. */
function NetworkChild({ portal, childId, mode }: { portal: PortalApi; childId: string; mode: string | null }) {
  const node = useResource((s) => portal.subGet(childId, s), `portal:sub:${childId}`);
  const summary = useResource((s) => portal.subSummary(childId, s), `portal:sub-summary:${childId}`);
  if (!isPlatformAccount(mode)) return <NotPlatform />;
  return (
    <NetworkChildView
      node={node.resource}
      summary={summary.resource}
      reload={() => {
        node.reload();
        summary.reload();
      }}
    />
  );
}

export function NetworkChildView({
  node,
  summary,
  reload,
}: {
  node: Resource<SubMerchant>;
  summary: Resource<SubSummary>;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  return (
    <ReadGate
      resource={node}
      retry={reload}
      waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.get' }}
      rows={4}
    >
      {(base) => {
        const named = summary.status === 'ready' ? summary.data : base;
        const name = nodeName(named, t('subWord'));
        const id = encodeURIComponent(base.id);
        return (
          <div className="lt-stack">
            <header className="lt-stack">
              <a className="lt-link" href="/pay/network">
                {t('netBack')}
              </a>
              <h2>
                {name} <Chip kind="merchant" value={base.status} />
              </h2>
              <p className="lt-hint">
                {t('netAdded')} <DateTime value={base.createdAt} />
              </p>
              <div className="lt-actions">
                <LinkButton href={`/pay/permissions?child=${id}`} tone="primary">
                  {t('netPermissionsAction')}
                </LinkButton>
              </div>
            </header>
            <Section title={t('netFactsTitle')}>
              <Facts
                items={[
                  [t('fVerification'), <Chip kind="kyb" value={base.kybStatus} />],
                  [t('colFee'), base.feeBps === null ? t('notSet') : bpsPercent(base.feeBps)],
                  [t('netDepth'), String(base.depth)],
                ]}
              />
            </Section>
            <ReadGate
              resource={summary}
              retry={reload}
              waiting={{ reason: t('waitSummary'), body: t('netSummaryBlocked'), needs: 'submerchant.summary' }}
            >
              {(data) => <Summary data={data} />}
            </ReadGate>
            <nav aria-label={u('related')}>
              <h3>{u('related')}</h3>
              <ul>
                <li>
                  <a className="lt-link" href={`/pay/permissions?child=${id}`}>
                    {t('netPermissionsAction')}
                  </a>
                </li>
                <li>
                  <a className="lt-link" href="/pay/network">
                    {t('netBack')}
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        );
      }}
    </ReadGate>
  );
}

function Summary({ data }: { data: SubSummary }) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  return (
    <>
      <Section title={t('netVolumeTitle')} description={t('netVolumeBody')}>
        {data.volume === null ? (
          <p className="lt-hint">{t('netNoPaymentAccess')}</p>
        ) : data.volume.items.length === 0 ? (
          <Empty title={t('netNoVolume')}>{t('netNoVolumeBody')}</Empty>
        ) : (
          <KeyValue
            label={t('netVolumeTitle')}
            rows={data.volume.items.map((v) => ({
              label: v.assetCode,
              value: <MoneyText value={v.volume} asset={v.assetCode} />,
              note: v.count === 1 ? t('netPaymentsCountOne') : t('netPaymentsCount', { n: v.count }),
            }))}
          />
        )}
      </Section>
      <Section
        title={t('netRecentTitle')}
        description={
          data.recentPayments?.items.length === 1
            ? t('netRecentBodyOne')
            : t('netRecentBody', { n: data.recentPayments?.items.length ?? 0 })
        }
      >
        {data.recentPayments === null ? (
          <p className="lt-hint">{t('netNoPaymentAccess')}</p>
        ) : data.recentPayments.items.length === 0 ? (
          <Empty title={t('netNoRecent')}>{t('netNoRecentBody')}</Empty>
        ) : (
          <EntityList
            label={t('netRecentTitle')}
            rows={data.recentPayments.items}
            rowKey={(r) => r.id}
            columns={[
              { header: t('colWhen'), cell: (r) => <DateTime value={r.createdAt} /> },
              { header: p('colAmount'), cell: (r) => <MoneyText value={r.amount} asset={r.assetId} /> },
              { header: p('colStatus'), cell: (r) => <Chip kind="payment" value={r.status} /> },
            ]}
          />
        )}
      </Section>
      <Section title={t('netGrantsTitle')} description={t('netGrantsBody')}>
        {data.grants === null ? (
          <p className="lt-hint">{t('netNoGrantAccess')}</p>
        ) : data.grants.items.length === 0 ? (
          <Empty title={t('netNoGrants')}>{t('netNoGrantsBody')}</Empty>
        ) : (
          <ul className="lt-rows" aria-label={t('netGrantsTitle')}>
            {data.grants.items.map((g) => (
              <li key={`${g.area}:${g.granteeMerchantId}`}>{areaWords(g.area)}</li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
