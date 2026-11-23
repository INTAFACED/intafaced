import { useEffect, useRef, useState } from 'react';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import {
  MINING_CONNECTION,
  MINING_MINER_SECRET_ISSUE,
  MINING_MINER_SECRET_STATUS,
  MINING_OVERVIEW,
  MINING_PROBE,
} from '@intafaced/contracts/mining-procedures';
import { useApi } from '../session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { Button, EmptyState, Failure, Field, Loading, Panel } from '../../shared/ui';
import { miningPoolCopy } from './mining-pool-copy';
import { isPlaceholderAddress, shortReference } from '../../shared/reference';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import type { MiningHealth } from './mining-journey';
import { CONNECTION_UNSET, OVERVIEW_UNSET, PROBE_REFUSALS, SECTIONS } from './mining-pool-codes';

/** `overview`: the owner's published pool sections. A blank section is null; a wholly blank overview refuses. */
export type PoolOverview = ProcedureOutput<typeof MINING_OVERVIEW>;
/** `connection`: the published host and port, and the signed account's own id. A blank host or port refuses. */
export type PoolConnection = ProcedureOutput<typeof MINING_CONNECTION>;
/** `minerSecret.status`: when the account's miner secret was issued, or null. Never the secret. */
export type MinerSecretStatus = ProcedureOutput<typeof MINING_MINER_SECRET_STATUS>;
/** `minerSecret.issue`: a new secret, shown this once; the pool keeps only its hash. */
export type IssuedMinerSecret = ProcedureOutput<typeof MINING_MINER_SECRET_ISSUE>;
/** `probe`: one TCP connect from the pool's network to its own published address. Stores nothing. */
export type PoolProbe = ProcedureOutput<typeof MINING_PROBE>;

type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The pool worker name for a rig: the published pattern with `{worker}` filled in. Without a pattern there is none, and a
 * pattern that needs a rig name has none until one is typed (a placeholder is never handed to a miner).
 */
export function workerNameFor(pattern: string | null, rig: string): string | null {
  if (pattern === null) return null;
  if (!pattern.includes('{worker}')) return pattern;
  return rig ? pattern.split('{worker}').join(rig) : null;
}

/** Overview tab: what the pool is, how to connect, and whether its address answers. */
export function MiningPool({ probe }: { probe: Probe }) {
  const { overview, connection, secret, issue } = useMiningPool();
  return (
    <div className="more-columns">
      <div>
        <PoolOverviewView read={overview} />
        <PoolConnectView read={connection} />
        <MinerSecretView read={secret} issue={issue} />
      </div>
      <div>
        <PoolProbeView state={probe.state} onPress={probe.press} />
      </div>
    </div>
  );
}

/** The overview tab's reads: the published overview, the connection, the miner secret's status, and issuing a new one. */
export function useMiningPool() {
  const api = useApi();
  const overview = useResource((signal) => api.call(MINING_OVERVIEW, undefined, { signal }), 'mining-overview');
  const connection = useResource((signal) => api.call(MINING_CONNECTION, undefined, { signal }), 'mining-connection');
  const secret = useResource((signal) => api.call(MINING_MINER_SECRET_STATUS, undefined, { signal }), 'mining-miner-secret');
  const issue = () => api.call(MINING_MINER_SECRET_ISSUE, undefined, { accept: (issued) => issued.secret.length > 0 });
  return { overview, connection, secret, issue };
}

export function PoolOverviewView({ read }: { read: Read<PoolOverview> }) {
  const { t } = miningPoolCopy.useCopy();
  const { resource } = read;
  if (resource.status === 'loading') return <Loading />;
  // A wholly unpublished overview is each section "Not set": no coin, hardware or split is filled in for the owner.
  const unset = resource.status === 'failed' && resource.failure.code === OVERVIEW_UNSET;
  if (resource.status === 'failed' && !unset) return <Failure result={resource.failure} retry={read.reload} />;
  const data = resource.status === 'ready' ? resource.data : null;
  return (
    <Panel title={t('overviewTitle')}>
      {data?.what ? <p>{data.what}</p> : null}
      {SECTIONS.map(({ key, field }) => {
        const text = data ? data[field] : null;
        return (
          <Panel key={key} title={t(key)} aria-label={t(key)} data-state={text === null ? 'unset' : 'set'}>
            {text === null ? <p className="lt-muted">{t('notSet')}</p> : <p>{text}</p>}
          </Panel>
        );
      })}
      {data ? <p className="lt-muted">{t('overviewVersion', { version: data.version })}</p> : null}
    </Panel>
  );
}

export function PoolConnectView({ read }: { read: Read<PoolConnection> }) {
  const { t } = miningPoolCopy.useCopy();
  const [rig, setRig] = useState('');
  const { resource } = read;
  return (
    <Panel title={t('connectTitle')} aria-label={t('connectTitle')}>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        resource.failure.code === CONNECTION_UNSET ? (
          <div role="alert" data-testid="mining-connection-unset" data-code={CONNECTION_UNSET}>
            <EmptyState title={t('connectionUnsetTitle')}>{t('connectionUnsetBody')}</EmptyState>
          </div>
        ) : (
          <Failure result={resource.failure} retry={read.reload} />
        )
      ) : (
        <>
          <dl>
            <CopyLine
              id="mining-pool-address"
              label={t('poolAddress')}
              copyLabel={t('copyPoolAddress')}
              value={`${resource.data.host}:${resource.data.port}`}
              shown={isPlaceholderAddress(resource.data.host) ? t('testAddress') : undefined}
            />
            <CopyLine
              id="mining-account-id"
              label={t('accountId')}
              copyLabel={t('copyAccountId')}
              value={resource.data.accountId}
              shown={shortReference(resource.data.accountId)}
            />
            {resource.data.secureUrl === null ? null : (
              <CopyLine
                id="mining-secure-address"
                label={t('secureAddress')}
                copyLabel={t('copySecureAddress')}
                value={resource.data.secureUrl}
                shown={isPlaceholderAddress(resource.data.secureUrl) ? t('testAddress') : undefined}
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
          <p className="lt-muted">{t('accountIdNote')}</p>
        </>
      )}
    </Panel>
  );
}

/**
 * The account's miner secret, which the rig sends as its password. A new one is shown once, here, with its copy button;
 * after that the room only says when it was issued. Issuing again replaces it, and the old one stops working.
 */
export function MinerSecretView({
  read,
  issue,
  initial = null,
}: {
  read: Read<MinerSecretStatus>;
  issue: () => Promise<ApiResult<IssuedMinerSecret>>;
  /** The secret just issued (tests). */
  initial?: IssuedMinerSecret | null;
}) {
  const { t } = miningPoolCopy.useCopy();
  const { timeZone } = usePreferences();
  const [shown, setShown] = useState<IssuedMinerSecret | null>(initial);
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
    <Panel title={t('secretTitle')} aria-label={t('secretTitle')}>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={read.reload} />
      ) : (
        <>
          {shown ? (
            <>
              <dl>
                <CopyLine id="mining-miner-secret" label={t('secretLabel')} copyLabel={t('copySecret')} value={shown.secret} />
              </dl>
              <p role="status">{t('secretShownOnce')}</p>
            </>
          ) : null}
          <p data-testid="mining-miner-secret-issued" data-state={issuedAt ? 'issued' : 'none'}>
            {issuedAt ? t('secretIssuedOn', { at: stamp(issuedAt, timeZone) }) : t('secretNone')}
          </p>
          <p className="lt-muted">{t('secretNote')}</p>
          {failure ? <Failure result={failure} /> : null}
          <Button variant="secondary" disabled={busy} onClick={() => void press()}>
            {issuedAt ? t('secretReissue') : t('secretIssue')}
          </Button>
        </>
      )}
    </Panel>
  );
}

/** Copying one value to the clipboard: done or failed for two seconds, then idle again. Nothing to copy does nothing. */
export function useCopyValue(value: string | null) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }
  return { state, copy };
}

function CopyLine({
  id,
  label,
  copyLabel,
  value,
  shown,
  empty,
}: {
  id: string;
  label: string;
  copyLabel: string;
  value: string | null;
  /** What the line reads when the value itself is no text for a person (a long id, a test machine's address); the copy
   *  button still copies `value`. */
  shown?: string;
  /** What shows in place of a missing value; "Not set" unless said. */
  empty?: string;
}) {
  const { t } = miningPoolCopy.useCopy();
  const { state, copy } = useCopyValue(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code data-testid={id} lang="und" dir="ltr" title={shown && value ? value : undefined}>
          {value === null ? (empty ?? t('notSet')) : (shown ?? value)}
        </code>{' '}
        <Button variant="secondary" aria-label={copyLabel} disabled={value === null} onClick={() => void copy()}>
          {state === 'done' ? t('copied') : copyLabel}
        </Button>
        <span role="status" className="lt-muted">
          {state === 'done' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
        </span>
      </dd>
    </div>
  );
}

/** `last`: the latest answered test, kept on screen while a later press is running or refused. */
export type ProbeState =
  | { status: 'idle' }
  | { status: 'busy'; last: PoolProbe | null }
  | { status: 'done'; probe: PoolProbe }
  | { status: 'failed'; failure: Failed; last: PoolProbe | null };

export type Probe = { state: ProbeState; press: () => void };

/**
 * The reachability test, held by the mining room so the Overview and Status tabs share one result: a press counts against
 * the account's limit, so switching tabs mid-test must not drop its answer.
 */
export function usePoolProbe(): Probe {
  const api = useApi();
  const [state, setState] = useState<ProbeState>({ status: 'idle' });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function press() {
    const last = state.status === 'done' ? state.probe : state.status === 'idle' ? null : state.last;
    setState({ status: 'busy', last });
    const result = await api.call(MINING_PROBE, undefined);
    if (!mounted.current) return;
    setState(result.ok ? { status: 'done', probe: result.data } : { status: 'failed', failure: result, last });
  }
  return { state, press: () => void press() };
}

export function PoolProbeView({ state, onPress }: { state: ProbeState; onPress: () => void }) {
  const { t } = miningPoolCopy.useCopy();
  const code = state.status === 'failed' ? state.failure.code : undefined;
  const refusal = code !== undefined && Object.hasOwn(PROBE_REFUSALS, code) ? PROBE_REFUSALS[code] : undefined;
  const shown = state.status === 'done' ? state.probe : state.status === 'idle' ? null : state.last;
  return (
    <Panel title={t('probeTitle')} aria-label={t('probeTitle')}>
      <p data-testid="mining-reachability" data-result={shown ? shown.result : 'none'}>
        {shown ? t(`probe_${shown.result}`, { ms: shown.roundTripMs }) : t('probeNone')}
      </p>
      {shown ? <p className="lt-muted">{t('probeViewpoint')}</p> : null}
      {state.status === 'busy' ? <p className="lt-muted">{t('probeBusy')}</p> : null}
      {state.status === 'failed' ? (
        refusal ? (
          <p role="alert" data-code={state.failure.code}>
            {t(refusal)}
          </p>
        ) : (
          <Failure result={state.failure} />
        )
      ) : null}
      <Button variant="secondary" disabled={state.status === 'busy'} onClick={onPress}>
        {t('probeAction')}
      </Button>
    </Panel>
  );
}

/** Status tab: whether the pool process answers now, then the same reachability test as the overview. */
export function MiningPoolStatus({ health, probe }: { health: Read<MiningHealth>; probe: Probe }) {
  const { t } = miningPoolCopy.useCopy();
  const state = health.resource.status === 'ready' ? 'answering' : health.resource.status === 'failed' ? 'silent' : 'unchecked';
  return (
    <div className="more-columns">
      <div>
        <Panel title={t('statusTitle')} aria-label={t('statusTitle')}>
          <p data-testid="mining-pool-status" data-state={state}>
            {t(`status_${state}`)}
          </p>
          <p className="lt-muted">{t('statusNote')}</p>
        </Panel>
      </div>
      <div>
        <PoolProbeView state={probe.state} onPress={probe.press} />
      </div>
    </div>
  );
}
