/**
 * Execution room (/execution): work a large order over time (TWAP / VWAP / POV), show only a part of it (iceberg), spread
 * it over a price range (scaled), read every child order and fill, and see which routing capabilities exist and which are
 * blocked. Everything shown is read from the service; nothing is invented.
 */
import type { ScreenProps } from '../../../app/screen-types';
import { Badge, EmptyState, Tabs, TabsList, TabsPanel, TabsTab, useSession } from '../rooms/ui';
import { Freshness } from '../rooms/RoomNotices';
import { RoomFrame } from '../rooms/RoomFrame';
import { AlgoTab } from './AlgoTab';
import { BlotterTab } from './BlotterTab';
import { IcebergTab } from './IcebergTab';
import { RoutingTab } from './RoutingTab';
import { ScaledTab } from './ScaledTab';
import { execCopy } from './copy';
import { useAlgoIds, useAlgoPolicy, useExecMarkets, useParents } from './data';
import { Gate, signInHref } from './parts';

export default function Screen(_props: ScreenProps) {
  const { t } = execCopy.useCopy();
  const { userId } = useSession();
  const policy = useAlgoPolicy();
  const markets = useExecMarkets();
  const ids = useAlgoIds(userId);
  const parents = useParents(ids);

  const meta = (
    <>
      <Freshness asOf={policy.status === 'ready' ? policy.asOf : null} refused={policy.status === 'refused'} />
      {policy.status === 'ready' ? (
        <Badge tone={policy.data.capability.jobsEnabled ? 'lime' : 'warn'}>
          {policy.data.capability.jobsEnabled ? t('Scheduler running') : t('Scheduler off chip')}
        </Badge>
      ) : null}
    </>
  );

  return (
    <RoomFrame mode="Execution" title={t('Execution')} description={t('Execution description')} meta={meta}>
      {!userId ? (
        <EmptyState
          variant="refused"
          title={t('Sign in title')}
          reason={t('Sign in reason')}
          action={{ label: t('Sign in'), href: signInHref(), variant: 'primary' }}
        />
      ) : (
        <Tabs defaultValue="algo">
          <TabsList divider aria-label={t('Execution tabs')} className="overflow-x-auto">
            <TabsTab value="algo">{t('Algo orders')}</TabsTab>
            <TabsTab value="iceberg">{t('Iceberg')}</TabsTab>
            <TabsTab value="scaled">{t('Scaled')}</TabsTab>
            <TabsTab value="blotter">{t('Child orders and fills')}</TabsTab>
            <TabsTab value="routing">{t('Routing')}</TabsTab>
          </TabsList>
          <div className="pt-4">
            <TabsPanel value="algo">
              <Gate load={markets}>{(list) => <AlgoTab markets={list} policy={policy} userId={userId} />}</Gate>
            </TabsPanel>
            <TabsPanel value="iceberg">
              <Gate load={markets}>{(list) => <IcebergTab markets={list} />}</Gate>
            </TabsPanel>
            <TabsPanel value="scaled">
              <Gate load={markets}>{(list) => <ScaledTab markets={list} />}</Gate>
            </TabsPanel>
            <TabsPanel value="blotter">
              <BlotterTab parents={parents.status === 'ready' ? parents.data : []} />
            </TabsPanel>
            <TabsPanel value="routing">
              <RoutingTab />
            </TabsPanel>
          </div>
        </Tabs>
      )}
    </RoomFrame>
  );
}
