// volt-room: /mining
import { useState } from 'react';
import { Button, Field, Tag } from '@intafaced/ui/lit';
import { CatalogueTemplate, KeyValue, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import type { Resource } from '../../../shared/resource';
import { stamp } from '../../../screens/money/time';
import { t as copyText } from '../copy';
import { useMiningHealth, type MiningTab } from '../MiningAvailability';
import {
  useCopyValue,
  useMiningPool,
  usePoolProbe,
  workerNameFor,
  type IssuedMinerSecret,
  type MinerSecretStatus,
  type PoolConnection,
  type PoolOverview,
  type ProbeState,
} from '../MiningPool';
import { useMiningJourney } from '../MiningRooms';
import { miningCopy } from '../mining-copy';
import type { MiningHealth } from '../mining-journey';
import { miningDepthCopy } from '../mining-depth-copy';
import { CONNECTION_UNSET, OVERVIEW_UNSET, PROBE_REFUSALS, SECTIONS } from '../mining-pool-codes';
import { miningPoolCopy } from '../mining-pool-copy';
import { preservePaperHref } from '../trade-context';
import { EmptyNote, FailureNote, Section, Waiting } from '../volt-parts';

type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Each section's own address; /mining itself is the overview. */
const SECTION_PATHS: Readonly<Record<Exclude<MiningTab, 'Overview'>, string>> = {
  Workers: '/mining/workers',
  Shares: '/mining/shares',
  Rewards: '/mining/rewards',
  Status: '/mining/status',
};

/**
 * /mining on the kit (J-more-catalogue-05 #1 to #3): the verdict on the pool and its journey, what the pool is, how to
 * connect a rig, the miner secret, and the reachability test. The same reads and words as the overview tab of the old
 * room (`../MiningAvailability.tsx`), which the section addresses still draw; each other section's button opens its
 * own address, keeping the simulated view when this one is simulated.
 */
export function MiningRoom({ paper }: { paper: boolean }) {
  const health = useMiningHealth();
  const probe = usePoolProbe();
  const { overview, connection, secret, issue } = useMiningPool();
  const depth = miningDepthCopy.useCopy();
  const scope = miningCopy.useCopy().t('scope');
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.mining')}
      description={scope}
      state={{ kind: 'ready' }}
      filters={
        <SectionTabs<MiningTab>
          items={[
            { value: 'Overview', label: depth.t('tabOverview') },
            { value: 'Workers', label: depth.t('tabWorkers') },
            { value: 'Shares', label: depth.t('tabShares') },
            { value: 'Rewards', label: depth.t('tabRewards') },
            { value: 'Status', label: depth.t('tabStatus') },
          ]}
          value="Overview"
          onChange={(tab) => {
            if (tab !== 'Overview') navigate(preservePaperHref(SECTION_PATHS[tab], paper));
          }}
          label={depth.t('sections')}
        />
      }
      items={
        <>
          <div className="lt-grid lt-grid-main-side">
            <div className="lt-col-main">
              <OverviewView read={overview} />
              <ConnectView read={connection} />
              <SecretView read={secret} issue={issue} />
            </div>
            <div className="lt-col-side">
              <ProbeView state={probe.state} onPress={probe.press} />
            </div>
          </div>
          <PoolJourney health={health} />
        </>
      }
    />
  );
}

/** The verdict on the pool from its public liveness, and each journey step with whether it can start and why not. */
function PoolJourney({ health }: { health: Read<MiningHealth> }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { reading, loading, verdict, steps } = useMiningJourney(health);
  return (
    <div className="lt-grid">
      <Section title={t('verdictTitle')}>
        {loading ? (
          <Waiting />
        ) : (
          <>
            <p role="status">
              <Copy k={`verdict_${verdict}`} />
            </p>
            <KeyValue
              rows={[
                { label: t('readingProcess'), value: <Copy k={reading ? 'responding' : 'silent'} /> },
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
            <Button tone="secondary" onClick={health.reload}>
              <Copy k="tabStatus" />
            </Button>
          </>
        )}
      </Section>
      <Section title={t('journeyTitle')}>
        <ol aria-label={t('journeyLabel')}>
          {steps.map((step) => (
            <li key={step.id} data-state={step.state}>
              <h3>{step.title}</h3>
              <Tag tone={step.state === 'blocked' ? 'down' : 'neutral'}>{step.stateLabel}</Tag>
              <p>{step.body}</p>
              {step.reason ? <p className="lt-hint">{step.reason}</p> : null}
              {step.action ? <div className="lt-actions">{step.action}</div> : null}
            </li>
          ))}
        </ol>
        <a className="lt-button lt-button-secondary" href="/support">
          <Copy k="support" />
        </a>
      </Section>
    </div>
  );
}

/** What the pool is: each published section, or "Not set" with nothing invented; a wholly blank overview is all unset. */
function OverviewView({ read }: { read: Read<PoolOverview> }) {
  const { t } = miningPoolCopy.useCopy();
  const { resource } = read;
  if (resource.status === 'loading') return <Waiting />;
  const unset = resource.status === 'failed' && resource.failure.code === OVERVIEW_UNSET;
  if (resource.status === 'failed' && !unset) return <FailureNote result={resource.failure} retry={read.reload} />;
  const data = resource.status === 'ready' ? resource.data : null;
  return (
    <Section title={t('overviewTitle')}>
      {data?.what ? <p>{data.what}</p> : null}
      {SECTIONS.map(({ key, field }) => {
        const text = data ? data[field] : null;
        return (
          <section key={key} aria-label={t(key)} data-state={text === null ? 'unset' : 'set'}>
            <h3>{t(key)}</h3>
            {text === null ? <p className="lt-hint">{t('notSet')}</p> : <p>{text}</p>}
          </section>
        );
      })}
      {data ? <p className="lt-hint">{t('overviewVersion', { version: data.version })}</p> : null}
    </Section>
  );
}

/** How to point a rig at the pool: each value with its copy button, and the worker name for the rig typed here. */
function ConnectView({ read }: { read: Read<PoolConnection> }) {
  const { t } = miningPoolCopy.useCopy();
  const [rig, setRig] = useState('');
  const { resource } = read;
  return (
    <Section title={t('connectTitle')} aria-label={t('connectTitle')}>
      {resource.status === 'loading' ? (
        <Waiting />
      ) : resource.status === 'failed' ? (
        resource.failure.code === CONNECTION_UNSET ? (
          <div role="alert" data-testid="mining-connection-unset" data-code={CONNECTION_UNSET}>
            <EmptyNote title={t('connectionUnsetTitle')}>{t('connectionUnsetBody')}</EmptyNote>
          </div>
        ) : (
          <FailureNote result={resource.failure} retry={read.reload} />
        )
      ) : (
        <>
          <dl className="lt-kv">
            <CopyLine
              id="mining-pool-address"
              label={t('poolAddress')}
              copyLabel={t('copyPoolAddress')}
              value={`${resource.data.host}:${resource.data.port}`}
            />
            <CopyLine id="mining-account-id" label={t('accountId')} copyLabel={t('copyAccountId')} value={resource.data.accountId} />
            {resource.data.secureUrl === null ? null : (
              <CopyLine
                id="mining-secure-address"
                label={t('secureAddress')}
                copyLabel={t('copySecureAddress')}
                value={resource.data.secureUrl}
              />
            )}
            <CopyLine
              id="mining-worker-name"
              label={t('workerName')}
              copyLabel={t('copyWorkerName')}
              value={workerNameFor(resource.data.workerNamePattern, rig)}
              empty={resource.data.workerNamePattern === null ? t('notSet') : t('workerNameNeedsRig')}
            />
          </dl>
          <Field
            label={t('rigName')}
            hint={t('rigNameHint')}
            value={rig}
            maxLength={64}
            onChange={(event) => setRig(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
          />
          <p className="lt-hint">{t('accountIdNote')}</p>
        </>
      )}
    </Section>
  );
}

/**
 * The account's miner secret, which the rig sends as its password. A new one is shown once, here, with its copy button;
 * after that the room only says when it was issued. Issuing again replaces it, and the old one stops working.
 */
function SecretView({ read, issue }: { read: Read<MinerSecretStatus>; issue: () => Promise<ApiResult<IssuedMinerSecret>> }) {
  const { t } = miningPoolCopy.useCopy();
  const { timeZone } = usePreferences();
  const [shown, setShown] = useState<IssuedMinerSecret | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const { resource } = read;
  async function press() {
    setBusy(true);
    setFailure(null);
    const result = await issue();
    setBusy(false);
    // No re-read after an issue: the answer carries its own issue time, and a re-read that failed would hide the secret
    // the person sees only this once.
    if (result.ok) setShown(result.data);
    else setFailure(result);
  }
  const issuedAt = shown?.issuedAt ?? (resource.status === 'ready' ? resource.data.issuedAt : null);
  return (
    <Section title={t('secretTitle')} aria-label={t('secretTitle')}>
      {resource.status === 'loading' ? (
        <Waiting />
      ) : resource.status === 'failed' ? (
        <FailureNote result={resource.failure} retry={read.reload} />
      ) : (
        <>
          {shown ? (
            <>
              <dl className="lt-kv">
                <CopyLine id="mining-miner-secret" label={t('secretLabel')} copyLabel={t('copySecret')} value={shown.secret} />
              </dl>
              <p role="status">{t('secretShownOnce')}</p>
            </>
          ) : null}
          <p data-testid="mining-miner-secret-issued" data-state={issuedAt ? 'issued' : 'none'}>
            {issuedAt ? t('secretIssuedOn', { at: stamp(issuedAt, timeZone) }) : t('secretNone')}
          </p>
          <p className="lt-hint">{t('secretNote')}</p>
          {failure ? <FailureNote result={failure} /> : null}
          <Button tone="secondary" disabled={busy} onClick={() => void press()}>
            {issuedAt ? t('secretReissue') : t('secretIssue')}
          </Button>
        </>
      )}
    </Section>
  );
}

function CopyLine({
  id,
  label,
  copyLabel,
  value,
  empty,
}: {
  id: string;
  label: string;
  copyLabel: string;
  value: string | null;
  /** What shows in place of a missing value; "Not set" unless said. */
  empty?: string;
}) {
  const { t } = miningPoolCopy.useCopy();
  const { state, copy } = useCopyValue(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code className="lt-mono" data-testid={id} lang="und" dir="ltr">
          {value ?? empty ?? t('notSet')}
        </code>{' '}
        <Button tone="secondary" aria-label={copyLabel} disabled={value === null} onClick={() => void copy()}>
          {state === 'done' ? t('copied') : copyLabel}
        </Button>
        <span role="status" className="lt-hint">
          {state === 'done' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
        </span>
      </dd>
    </div>
  );
}

/** The reachability test: one connect from the pool's own network to its published address; the last answer stays shown. */
export function ProbeView({ state, onPress }: { state: ProbeState; onPress: () => void }) {
  const { t } = miningPoolCopy.useCopy();
  const code = state.status === 'failed' ? state.failure.code : undefined;
  const refusal = code !== undefined && Object.hasOwn(PROBE_REFUSALS, code) ? PROBE_REFUSALS[code] : undefined;
  const shown = state.status === 'done' ? state.probe : state.status === 'idle' ? null : state.last;
  return (
    <Section title={t('probeTitle')} aria-label={t('probeTitle')}>
      <p data-testid="mining-reachability" data-result={shown ? shown.result : 'none'}>
        {shown ? t(`probe_${shown.result}`, { ms: shown.roundTripMs }) : t('probeNone')}
      </p>
      {shown ? <p className="lt-hint">{t('probeViewpoint')}</p> : null}
      {state.status === 'busy' ? <p className="lt-hint">{t('probeBusy')}</p> : null}
      {state.status === 'failed' ? (
        refusal ? (
          <p role="alert" data-code={state.failure.code}>
            {t(refusal)}
          </p>
        ) : (
          <FailureNote result={state.failure} />
        )
      ) : null}
      <Button tone="secondary" disabled={state.status === 'busy'} onClick={onPress}>
        {t('probeAction')}
      </Button>
    </Section>
  );
}
