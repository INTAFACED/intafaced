// volt-room: /execution
/**
 * Execution room (/execution): work a large order over time (TWAP / VWAP / POV), show only a part of it (iceberg), spread
 * it over a price range (scaled), read every child order and fill, and see which routing capabilities exist and which are
 * blocked. Everything shown is read from the service; nothing is invented. Drawn on the Volt desk template: the whole
 * room is its orders region, a tool desk with no market list, chart or book of its own.
 */
import { useState } from 'react';
import { DeskTemplate, StatusChip, TabPanel, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../../app/screen-types';
import { TradeSubNav } from '../TradeSubNav';
import { useSession } from '../rooms/ui';
import { AlgoTab } from './AlgoTab';
import { BlotterTab } from './BlotterTab';
import { IcebergTab } from './IcebergTab';
import { RoutingTab } from './RoutingTab';
import { ScaledTab } from './ScaledTab';
import { execCopy } from './copy';
import { useAlgoIds, useAlgoPolicy, useExecMarkets, useParents } from './data';
import { Freshness, Gate, signInHref } from './parts';

type TabId = 'algo' | 'iceberg' | 'scaled' | 'blotter' | 'routing';

export default function Screen(_props: ScreenProps) {
  const { t } = execCopy.useCopy();
  const { userId } = useSession();
  const policy = useAlgoPolicy();
  const markets = useExecMarkets();
  const { ids } = useAlgoIds(userId);
  const parents = useParents(ids);
  const [tab, setTab] = useState<TabId>('algo');

  const state: RoomState = userId
    ? { kind: 'ready' }
    : {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('Sign in title'),
          body: t('Sign in reason'),
          action: { label: t('Sign in'), href: signInHref() },
        },
      };

  const meta = (
    <div className="lt-toolbar">
      <Freshness asOf={policy.status === 'ready' ? policy.asOf : null} refused={policy.status === 'refused'} />
      {policy.status === 'ready' ? (
        <StatusChip
          status={policy.data.capability.jobsEnabled ? 'done' : 'unknown'}
          label={policy.data.capability.jobsEnabled ? t('Scheduler running') : t('Scheduler off chip')}
        />
      ) : null}
    </div>
  );

  return (
    <DeskTemplate
      mode="pro"
      title={t('Execution')}
      section={<TradeSubNav />}
      description={t('Execution description')}
      state={state}
      instrument={undefined}
      chart={undefined}
      ticket={undefined}
      orders={
        <div className="lt-body">
          {meta}
          <Tabs
            id="execution"
            label={t('Execution tabs')}
            value={tab}
            onChange={(next) => setTab(next as TabId)}
            items={[
              { value: 'algo', label: t('Algo orders') },
              { value: 'iceberg', label: t('Iceberg') },
              { value: 'scaled', label: t('Scaled') },
              { value: 'blotter', label: t('Child orders and fills') },
              { value: 'routing', label: t('Routing') },
            ]}
          />
          <TabPanel id="execution" value="algo" current={tab}>
            <Gate load={markets}>{(list) => <AlgoTab markets={list} policy={policy} userId={userId} />}</Gate>
          </TabPanel>
          <TabPanel id="execution" value="iceberg" current={tab}>
            <Gate load={markets}>{(list) => <IcebergTab markets={list} />}</Gate>
          </TabPanel>
          <TabPanel id="execution" value="scaled" current={tab}>
            <Gate load={markets}>{(list) => <ScaledTab markets={list} />}</Gate>
          </TabPanel>
          <TabPanel id="execution" value="blotter" current={tab}>
            <BlotterTab parents={parents.status === 'ready' ? parents.data : []} />
          </TabPanel>
          <TabPanel id="execution" value="routing" current={tab}>
            <RoutingTab />
          </TabPanel>
        </div>
      }
    />
  );
}
