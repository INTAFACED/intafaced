import { Button, EmptyState } from '@intafaced/ui';
import { useResource, type Resource } from '../../../../../shared/resource';
import { PaySection } from '../../../components';
import { Chip, Facts } from '../../components';
import type { PortalApi } from '../../api';
import { DateTime } from '../../ui/DateTime';
import { DetailHeader } from '../../ui/DetailHeader';
import { EntityList } from '../../ui/EntityList';
import { MoneyText } from '../../ui/MoneyText';
import { RelatedLinks } from '../../ui/RelatedLinks';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';
import { areaWords, bpsPercent, isPlatformAccount, nodeName } from '../account/model';
import type { SubMerchant, SubSummary } from '../account/schemas';
import { ReadGate } from '../account/ui';
import { NotPlatform } from './Network';

/** `/pay/network/:child`: one sub-merchant, its last 30 days, its newest payments and who holds permissions over it. */
export function NetworkChild({ portal, childId, mode }: { portal: PortalApi; childId: string; mode: string | null }) {
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

export function NetworkChildView({ node, summary, reload }: { node: Resource<SubMerchant>; summary: Resource<SubSummary>; reload: () => void }) {
  const { t } = accountCopy.useCopy();
  return (
    <ReadGate resource={node} retry={reload} waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.get' }} rows={4}>
      {(base) => {
        const named = summary.status === 'ready' ? summary.data : base;
        const name = nodeName(named, t('subWord'));
        const id = encodeURIComponent(base.id);
        return (
          <div className="stack">
            <DetailHeader
              back={{ href: '/pay/network', label: t('netBack') }}
              title={name}
              status={<Chip kind="merchant" value={base.status} />}
              subtitle={
                <>
                  {t('netAdded')} <DateTime value={base.createdAt} />
                </>
              }
              action={
                <Button variant="primary" nativeButton={false} role="link" render={<a href={`/pay/permissions?child=${id}`} />}>
                  {t('netPermissionsAction')}
                </Button>
              }
            />
            <PaySection title={t('netFactsTitle')}>
              <Facts
                items={[
                  [t('fVerification'), <Chip kind="kyb" value={base.kybStatus} />],
                  [t('colFee'), base.feeBps === null ? t('notSet') : bpsPercent(base.feeBps)],
                  [t('netDepth'), String(base.depth)],
                ]}
              />
            </PaySection>
            <ReadGate resource={summary} retry={reload} waiting={{ reason: t('waitSummary'), body: t('netSummaryBlocked'), needs: 'submerchant.summary' }}>
              {(data) => <Summary data={data} />}
            </ReadGate>
            <RelatedLinks
              links={[
                { href: `/pay/permissions?child=${id}`, label: t('netPermissionsAction') },
                { href: '/pay/network', label: t('netBack') },
              ]}
            />
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
      <PaySection title={t('netVolumeTitle')} description={t('netVolumeBody')}>
        {data.volume === null ? (
          <p className="muted">{t('netNoPaymentAccess')}</p>
        ) : data.volume.items.length === 0 ? (
          <EmptyState title={t('netNoVolume')}>{t('netNoVolumeBody')}</EmptyState>
        ) : (
          <ul className="sa-list" aria-label={t('netVolumeTitle')}>
            {data.volume.items.map((v) => (
              <li key={v.assetCode}>
                <MoneyText value={v.volume} asset={v.assetCode} /> <span className="muted">· {t('netPaymentsCount', { n: v.count })}</span>
              </li>
            ))}
          </ul>
        )}
      </PaySection>
      <PaySection title={t('netRecentTitle')} description={t('netRecentBody', { n: data.recentPayments?.items.length ?? 0 })}>
        {data.recentPayments === null ? (
          <p className="muted">{t('netNoPaymentAccess')}</p>
        ) : data.recentPayments.items.length === 0 ? (
          <EmptyState title={t('netNoRecent')}>{t('netNoRecentBody')}</EmptyState>
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
            card={(r) => ({
              title: <MoneyText value={r.amount} asset={r.assetId} />,
              time: <DateTime value={r.createdAt} />,
              status: <Chip kind="payment" value={r.status} />,
            })}
          />
        )}
      </PaySection>
      <PaySection title={t('netGrantsTitle')} description={t('netGrantsBody')}>
        {data.grants === null ? (
          <p className="muted">{t('netNoGrantAccess')}</p>
        ) : data.grants.items.length === 0 ? (
          <EmptyState title={t('netNoGrants')}>{t('netNoGrantsBody')}</EmptyState>
        ) : (
          <ul className="sa-list" aria-label={t('netGrantsTitle')}>
            {data.grants.items.map((g) => (
              <li key={`${g.area}:${g.granteeMerchantId}`}>{areaWords(g.area)}</li>
            ))}
          </ul>
        )}
      </PaySection>
    </>
  );
}
