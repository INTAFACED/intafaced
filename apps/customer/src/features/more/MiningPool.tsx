import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading, Panel } from '../../shared/ui';
import { miningPoolCopy } from './mining-pool-copy';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import type { MiningHealth } from './mining-journey';

// hand-declared-ok: svc-mining-pool's overview, connection and probe answers have no browser-safe schema in packages/contracts yet

/** `overview`: the owner's published pool sections. A blank section is null; a wholly blank overview refuses. */
export const poolOverview = z.object({
  version: z.string(),
  what: z.string().nullable(),
  coin: z.string().nullable(),
  hardware: z.string().nullable(),
  revenueSplit: z.string().nullable(),
  notSupported: z.string().nullable(),
});
export type PoolOverview = z.infer<typeof poolOverview>;

/** `connection`: the published host and port, and the signed account's own id. A blank host or port refuses. */
export const poolConnection = z.object({
  host: z.string(),
  port: z.string(),
  secureUrl: z.string().nullable(),
  accountId: z.string(),
  workerNamePattern: z.string().nullable(),
  credentialOffered: z.literal(false),
  credentialReason: z.string(),
});
export type PoolConnection = z.infer<typeof poolConnection>;

/** `probe`: one TCP connect from the pool's network to its own published address. Stores nothing. */
export const poolProbe = z.object({
  result: z.enum(['reachable', 'refused', 'timed_out']),
  roundTripMs: z.string(),
  viewpoint: z.literal('pool_network'),
});
export type PoolProbe = z.infer<typeof poolProbe>;

export const OVERVIEW_UNSET = 'mining.overview_unset';
export const CONNECTION_UNSET = 'mining.connection_unset';
const PROBE_REFUSALS: Readonly<Record<string, 'probeLimit' | 'probeLimitUnset' | 'probeTimeoutUnset' | 'probeTargetUnset'>> = {
  'mining.probe_limit_reached': 'probeLimit',
  'mining.probe_limit_unset': 'probeLimitUnset',
  'mining.probe_timeout_unset': 'probeTimeoutUnset',
  [CONNECTION_UNSET]: 'probeTargetUnset',
};

type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const SECTIONS = [
  { key: 'coin', field: 'coin' },
  { key: 'hardware', field: 'hardware' },
  { key: 'revenueSplit', field: 'revenueSplit' },
  { key: 'notSupported', field: 'notSupported' },
] as const;

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
  const api = useApi();
  const overview = useResource((signal) => api.query('mining', 'overview', undefined, poolOverview, { signal }), 'mining-overview');
  const connection = useResource((signal) => api.query('mining', 'connection', undefined, poolConnection, { signal }), 'mining-connection');
  return (
    <div className="more-columns">
      <div>
        <PoolOverviewView read={overview} />
        <PoolConnectView read={connection} />
      </div>
      <div>
        <PoolProbeView state={probe.state} onPress={probe.press} />
      </div>
    </div>
  );
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
            {text === null ? <p className="muted">{t('notSet')}</p> : <p>{text}</p>}
          </Panel>
        );
      })}
      {data ? <p className="muted">{t('overviewVersion', { version: data.version })}</p> : null}
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
          <p className="muted">{t('accountIdNote')}</p>
          <p className="muted">{t('credentialNote')}</p>
        </>
      )}
    </Panel>
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
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code data-testid={id} lang="und" dir="ltr">
          {value ?? empty ?? t('notSet')}
        </code>{' '}
        <Button variant="secondary" aria-label={copyLabel} disabled={value === null} onClick={() => void copy()}>
          {state === 'done' ? t('copied') : copyLabel}
        </Button>
        <span role="status" className="muted">
          {state === 'done' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
        </span>
      </dd>
    </div>
  );
}

/** `last`: the latest answered test, kept on screen while a later press is running or refused. */
type ProbeState =
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
    const result = await api.query('mining', 'probe', undefined, poolProbe);
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
      {shown ? <p className="muted">{t('probeViewpoint')}</p> : null}
      {state.status === 'busy' ? <p className="muted">{t('probeBusy')}</p> : null}
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
          <p className="muted">{t('statusNote')}</p>
        </Panel>
      </div>
      <div>
        <PoolProbeView state={probe.state} onPress={probe.press} />
      </div>
    </div>
  );
}
