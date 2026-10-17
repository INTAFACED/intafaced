import type { z } from 'zod';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button } from '@intafaced/ui';
import { PaySection } from '../../components';
import { Chip, Gate, Kpi, KpiGrid, ListShell, MoreFooter, Timeline } from '../components';
import { useCursorList, useReadAt, type ListState } from '../hooks';
import { Arrives, CopyReference, PortalBack, ReadStamp } from '../ExtensionTools';
import { extensionCopy as c, portalCopy } from './copy';
import type { PortalApi } from '../api';
import { kybCurrentSchema, type KybEvent } from '../schemas';
type Kyb = z.infer<typeof kybCurrentSchema>;
export function Compliance({ portal }: { portal: PortalApi }) {
  const current = useResource((signal) => portal.kybCurrent(signal), 'portal:compliance-current');
  const history = useCursorList(
    (cursor, signal) => portal.kybHistory(cursor, signal),
    'portal:compliance-history',
    (e) => e.seq,
  );
  return (
    <ComplianceView
      current={current.resource}
      history={history.state}
      loadMore={history.loadMore}
      reload={() => {
        current.reload();
        history.reload();
      }}
    />
  );
}
export function ComplianceView({
  current,
  history,
  loadMore,
  reload,
}: {
  current: Resource<Kyb>;
  history: ListState<KybEvent>;
  loadMore: () => void;
  reload: () => void;
}) {
  const at = useReadAt(current.status === 'ready', current);
  const statusName = (value: string) => {
    const key = { none: 'chipKyb_none', pending: 'chipKyb_pending', approved: 'chipKyb_approved', rejected: 'chipKyb_rejected' } as const;
    return value in key ? portalCopy.t(key[value as keyof typeof key]) : c.t('unavailable');
  };
  return (
    <div className="stack">
      <PortalBack />
      <PaySection
        title={c.t('currentRecord')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <Gate resource={current} retry={reload}>
          {(record) => (
            <>
              <KpiGrid label={c.t('currentRecord')}>
                <Kpi
                  label={c.t('verificationStatus')}
                  period={c.t('currentRecord')}
                  value={<Chip kind="kyb" value={record.kybStatus} />}
                  href="/pay/onboarding/verification"
                />
                <Kpi
                  label={c.t('verificationReference')}
                  period={c.t('currentRecord')}
                  value={record.kybRef ? <span className="pp-wrap">{record.kybRef}</span> : c.t('noReference')}
                />
                <Kpi label={c.t('screeningStatus')} value={c.t('screeningUnknown')} href="#compliance-gaps" />
                <Kpi label={c.t('reverifyDue')} value={c.t('noDueRead')} href="#compliance-gaps" />
              </KpiGrid>
              {record.kybRef && <CopyReference value={record.kybRef} />}
              <ReadStamp at={at} />
              <p className="pp-callout">{c.t('kybNotScreening')}</p>
            </>
          )}
        </Gate>
      </PaySection>
      <div id="compliance-gaps">
        <Arrives>{c.t('complianceGap')}</Arrives>
      </div>
      <PaySection title={c.t('complianceHistory')} description={c.t('complianceHistoryBody')}>
        <ListShell
          state={history}
          retry={reload}
          empty={{
            title: c.t('complianceEmpty'),
            body: c.t('complianceEmptyBody'),
            action: (
              <a className="text-link" href="/pay/onboarding/verification">
                {c.t('verificationAction')}
              </a>
            ),
          }}
        >
          {(events) => (
            <>
              <Timeline
                label={c.t('complianceHistory')}
                items={events.map((e) => ({
                  at: e.at,
                  title: `${c.t('complianceChange')}: ${statusName(e.fromStatus)} → ${statusName(e.toStatus)}`,
                  detail: c.t(e.decidedBy === 'merchant' ? 'changedByMerchant' : 'changedByIntafaced'),
                }))}
              />
              {history.status === 'ready' && <MoreFooter state={history} onMore={loadMore} />}
            </>
          )}
        </ListShell>
      </PaySection>
    </div>
  );
}
