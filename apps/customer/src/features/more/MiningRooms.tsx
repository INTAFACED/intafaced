import { useState } from 'react';
import { Button, DataTable, EmptyState, Field, Loading, Panel } from '../../shared/ui';
import { Select } from './common';
import { DisabledAction, Journey, StatRow, StatusPill, type JourneyStep } from './depth-kit';
import { dependencyReading, MINING_STEPS, poolVerdict, type MiningHealth } from './mining-journey';
import { miningDepthCopy } from './mining-depth-copy';
import type { Resource } from '../../shared/resource';

type Room = 'Overview' | 'Workers' | 'Shares' | 'Rewards';
type Health = { resource: Resource<MiningHealth>; reload: () => void };

export function MiningRooms({ room, health }: { room: Room; health: Health }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const reading = health.resource.status === 'ready' ? health.resource.data : null;
  const loading = health.resource.status === 'loading';
  if (room === 'Workers') return <Workers />;
  if (room === 'Shares') return <Shares />;
  if (room === 'Rewards') return <Rewards />;
  const verdict = poolVerdict(reading);
  const steps: JourneyStep[] = MINING_STEPS.map((step) => {
    const need = dependencyReading(reading, step);
    return {
      id: step.id,
      title: t(`step_${step.id}`),
      body: t(`step_${step.id}_body`),
      state: 'blocked',
      stateLabel: t('stepBlocked'),
      reason: (
        <>
          <Copy k="blocker_no_customer_api" />
          {step.dependency === 'ledger' || step.dependency === 'store' ? (
            <>
              {' '}
              <Copy k="needs" /> <Copy k={step.dependency === 'ledger' ? 'need_ledger' : 'need_store'} />:{' '}
              <Copy k={need === 'configured' ? 'configured' : need === 'absent' ? 'absent' : 'unknown'} />. <Copy k="checked" />.
            </>
          ) : null}
        </>
      ),
    };
  });
  return (
    <div className="more-grid">
      <Panel title={t('verdictTitle')}>
        {loading ? (
          <Loading />
        ) : (
          <>
            <p role="status">
              <Copy k={`verdict_${verdict}`} />
            </p>
            <StatRow
              items={[
                {
                  label: t('readingProcess'),
                  value: <Copy k={reading ? 'responding' : 'silent'} />,
                },
                {
                  label: t('readingLedger'),
                  value: <Copy k={reading ? (reading.ledger.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                {
                  label: t('readingStore'),
                  value: <Copy k={reading ? (reading.pg.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                { label: t('readingJobs'), value: reading ? reading.jobs.length : t('unknown'), note: t('checked') },
              ]}
            />
            <Button variant="secondary" onClick={health.reload}>
              <Copy k="tabStatus" />
            </Button>
          </>
        )}
      </Panel>
      <Panel title={t('journeyTitle')}>
        <Journey steps={steps} label={t('journeyLabel')} />
        <a className="button button--secondary" href="/support">
          <Copy k="support" />
        </a>
      </Panel>
    </div>
  );
}

function Workers() {
  const { Copy, t } = miningDepthCopy.useCopy();
  const [name, setName] = useState('');
  return (
    <div className="more-columns">
      <Panel title={t('workersRegister')}>
        <Field
          label={t('workerName')}
          hint={t('workerNameHint')}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
        />
        <DisabledAction label={t('workerRegisterAction')} reason={t('workerRegisterReason')} />
      </Panel>
      <Panel title={t('workersRoster')}>
        <EmptyState title={<Copy k="noRecords" />} />
        <DataTable headers={[t('rosterName'), t('rosterHashrate'), t('rosterLastShare')]} label={t('workersRoster')}>
          <tr>
            <td colSpan={3}>
              <StatusPill state="blocked">
                <Copy k="stepBlocked" />
              </StatusPill>
            </td>
          </tr>
        </DataTable>
      </Panel>
    </div>
  );
}

function Shares() {
  const { Copy, t } = miningDepthCopy.useCopy();
  const [worker, setWorker] = useState('');
  return (
    <div className="more-columns">
      <Panel title={t('sharesTitle')}>
        <div className="depth-filters">
          <Select label={t('sharesWorker')} value={worker} onChange={setWorker} options={[{ value: '', label: t('sharesAll') }]} />
          <label className="field">
            <span>{t('sharesWindow')}</span>
            <select disabled aria-disabled="true">
              <option>{t('unknown')}</option>
            </select>
          </label>
        </div>
        <StatRow
          items={[
            { label: t('sharesCount'), value: t('unknown') },
            { label: t('sharesRejected'), value: t('unknown') },
            { label: t('sharesWeight'), value: t('unknown') },
          ]}
        />
        <EmptyState title={<Copy k="noRecords" />} />
      </Panel>
      <Panel title={t('sharesRule')}>
        <p className="muted">
          <Copy k="blocker_no_customer_api" />
        </p>
      </Panel>
    </div>
  );
}

function Rewards() {
  const { Copy, t } = miningDepthCopy.useCopy();
  return (
    <div className="more-columns">
      <Panel title={t('rewardsTitle')}>
        <StatRow
          items={[
            { label: t('rewardsCredited'), value: t('unknown') },
            { label: t('rewardsPending'), value: t('unknown') },
            { label: t('rewardsFee'), value: t('unknown') },
            { label: t('rewardsWindow'), value: t('unknown') },
          ]}
        />
        <EmptyState title={<Copy k="noRecords" />} />
        <p className="muted">
          <Copy k="rewardsMethod" />
        </p>
        <DisabledAction label={t('rewardsExport')} reason={t('rewardsExportReason')} />
      </Panel>
      <Panel title={t('rewardsDestination')}>
        <p>
          <Copy k="rewardsDestinationBody" />
        </p>
      </Panel>
    </div>
  );
}
