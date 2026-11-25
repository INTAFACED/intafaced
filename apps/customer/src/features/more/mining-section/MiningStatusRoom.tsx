// volt-room: /mining/status
import { Button, Tag } from '@intafaced/ui/lit';
import { KeyValue, MonitorTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { useMiningHealth, type MiningTab } from '../MiningAvailability';
import { usePoolProbe } from '../MiningPool';
import { ProbeView } from '../mining-room/MiningRoom';
import { miningCopy } from '../mining-copy';
import { miningDepthCopy } from '../mining-depth-copy';
import { miningPoolCopy } from '../mining-pool-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { preservePaperHref } from '../trade-context';
import { KitRead, Section } from '../volt-parts';

/** Each section's own address; /mining itself is the overview. */
const SECTION_PATHS: Readonly<Record<MiningTab, string>> = {
  Overview: '/mining',
  Workers: '/mining/workers',
  Shares: '/mining/shares',
  Rewards: '/mining/rewards',
  Status: '/mining/status',
};

/** The Mining room's sections, the open one pressed; another opens its own address, keeping the simulated view. */
export function MiningSections({ value, paper }: { value: MiningTab; paper: boolean }) {
  const depth = miningDepthCopy.useCopy();
  return (
    <SectionTabs<MiningTab>
      items={[
        { value: 'Overview', label: depth.t('tabOverview') },
        { value: 'Workers', label: depth.t('tabWorkers') },
        { value: 'Shares', label: depth.t('tabShares') },
        { value: 'Rewards', label: depth.t('tabRewards') },
        { value: 'Status', label: depth.t('tabStatus') },
      ]}
      value={value}
      onChange={(tab) => {
        if (tab !== value) navigate(preservePaperHref(SECTION_PATHS[tab], paper));
      }}
      label={depth.t('sections')}
    />
  );
}

/**
 * /mining/status on the monitor template (J-more-catalogue-05 #4): whether the pool process answers now, the same
 * reachability test as the overview, what mining here still needs, and the pool's public liveness record. Public
 * liveness only: it reads no customer record, and a configured connection is never evidence of a credit or payout. The
 * same reads and words as the old room's Status tab (`../MiningAvailability.tsx`).
 */
export function MiningStatusRoom({ paper }: { paper: boolean }) {
  const health = useMiningHealth();
  const probe = usePoolProbe();
  const pool = miningPoolCopy.useCopy();
  const { Copy, t, languageFor, directionFor } = miningCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const live = health.resource.status === 'ready' ? 'answering' : health.resource.status === 'failed' ? 'silent' : 'unchecked';
  return (
    <MonitorTemplate
      title={routes.t('status')}
      description={t('scope')}
      state={{ kind: 'ready' }}
      figures={[
        <div key="live" aria-label={pool.t('statusTitle')}>
          <span>{pool.t('statusTitle')}</span>{' '}
          <strong data-testid="mining-pool-status" data-state={live}>
            {pool.t(`status_${live}`)}
          </strong>
        </div>,
      ]}
      actions={<MiningSections value="Status" paper={paper} />}
      panels={
        <div className="lt-grid">
          <ProbeView state={probe.state} onPress={probe.press} />
          <Section title={<Copy k="unavailableTitle" />} lang={languageFor('unavailableTitle')} dir={directionFor('unavailableTitle')}>
            <p className="lt-hint">
              <Copy k="unavailableBody" />
            </p>
            <a className="lt-button lt-button-primary" href="/support">
              <Copy k="support" />
            </a>
            <h3>
              <Copy k="required" />
            </h3>
            <KeyValue
              rows={(['workers', 'shares', 'credits'] as const).map((key) => ({
                label: t(key),
                value: (
                  <>
                    <Tag tone="neutral">
                      <Copy k="unavailable" />
                    </Tag>{' '}
                    <Copy k={key === 'workers' ? 'workersBody' : key === 'shares' ? 'sharesBody' : 'creditsBody'} />
                  </>
                ),
              }))}
            />
          </Section>
        </div>
      }
      explain={<p>{pool.t('statusNote')}</p>}
      related={
        <div lang={languageFor('publicStatus')} dir={directionFor('publicStatus')}>
          <details>
            <summary>
              <Copy k="publicStatus" />
            </summary>
            <p className="lt-hint">
              <Copy k="readScope" />
            </p>
            <KitRead resource={health.resource} retry={health.reload}>
              {(s) => (
                <>
                  <KeyValue
                    rows={[
                      { label: t('process'), value: <Copy k="responding" /> },
                      { label: t('ledger'), value: <Copy k={s.ledger.status === 'configured' ? 'configured' : 'absent'} /> },
                      { label: t('store'), value: <Copy k={s.pg.status === 'configured' ? 'configured' : 'absent'} /> },
                      {
                        label: t('jobs'),
                        value: s.jobs.length ? (
                          s.jobs.map((job, i) => (
                            <span className="lt-mono" lang="und" dir="ltr" key={i}>
                              {job}{' '}
                            </span>
                          ))
                        ) : (
                          <Copy k="noJobs" />
                        ),
                      },
                    ]}
                  />
                  <Button tone="secondary" onClick={health.reload}>
                    <Copy k="refresh" />
                  </Button>
                </>
              )}
            </KitRead>
            <p className="lt-hint">
              <Copy k="boundaries" />
            </p>
          </details>
          <a className="lt-link lt-link-alone" href="/more">
            <Copy k="more" />
          </a>
        </div>
      }
    />
  );
}
