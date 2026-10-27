import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSession } from '../session/session';
import { Button, Panel } from '../../shared/ui';
import type { ApiClient, ApiResult } from '../../shared/api';
import { currentSharedCardRoute, subscribeSharedCardRoute } from './blueprint-shared-card-contract';
import { crewExportForOwner, crewProjection, type CrewEnvelope, type CrewRead } from './blueprint-crew-codec';
import { blueprintCrewCopy } from './blueprint-crew-copy';
import './blueprint-crew.css';

type Lease = Readonly<{ api: ApiClient; owner: string | null; session: object | null; route: ReturnType<typeof currentSharedCardRoute> }>;
type Request = Readonly<{ lease: Lease; controller: AbortController }>;
type View =
  | { status: 'idle' }
  | { status: 'loading'; request: Request }
  | { status: 'ready'; request: Request; data: CrewRead }
  | { status: 'failed'; request: Request; failure: 'unverified' | 'forbidden' | 'failed' };

export function BlueprintCrew() {
  const { api, userId, session } = useSession();
  const { t, languageFor, requestedLocale } = blueprintCrewCopy.useCopy();
  const [view, setView] = useState<View>({ status: 'idle' });
  const [, refresh] = useState(0);
  const viewRef = useRef(view),
    leaseRef = useRef<Lease | null>(null),
    requestRef = useRef<Request | null>(null),
    mounted = useRef(false);
  function discard() {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }
  const route = currentSharedCardRoute();
  if (
    !leaseRef.current ||
    leaseRef.current.api !== api ||
    leaseRef.current.owner !== userId ||
    leaseRef.current.session !== session ||
    leaseRef.current.route !== route
  ) {
    discard();
    leaseRef.current = Object.freeze({ api, owner: userId, session, route });
  }
  const lease = leaseRef.current;
  const admits = () =>
    mounted.current && leaseRef.current === lease && !!lease.owner && lease.api.canWrite() && currentSharedCardRoute() === lease.route;
  const requestCurrent = (request: Request) => admits() && request.lease === lease && requestRef.current === request;
  const visible = view.status === 'idle' || requestCurrent(view.request);
  const rendered = visible ? view : { status: 'idle' as const };
  const actionCurrent = () => admits() && viewRef.current === view && rendered.status !== 'loading';
  function show(next: View) {
    viewRef.current = next;
    setView(next);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const release = subscribeSharedCardRoute(() => {
      discard();
      leaseRef.current = null;
      // The observer runs at the URL departure, including same-task A→B→A.
      // Commit private DOM retirement before a retained handler can run.
      flushSync(() => {
        show({ status: 'idle' });
        refresh((value) => value + 1);
      });
    });
    return () => {
      mounted.current = false;
      leaseRef.current = null;
      discard();
      release();
    };
  }, []);
  useLayoutEffect(() => {
    if (view.status !== 'idle' && view.request.lease !== lease) show({ status: 'idle' });
  }, [lease]);

  async function read() {
    if (!actionCurrent() || !lease.owner) return;
    discard();
    const request: Request = Object.freeze({ lease, controller: new AbortController() });
    requestRef.current = request;
    show({ status: 'loading', request });
    let result: ApiResult<CrewEnvelope>;
    try {
      result = await lease.api.query('blueprint', 'export', undefined, crewExportForOwner(lease.owner), {
        signal: request.controller.signal,
      });
    } catch {
      result = { ok: false, reason: 'unreachable', message: '' };
    }
    if (!requestCurrent(request)) return;
    if (result.ok) show({ status: 'ready', request, data: crewProjection(result.data) });
    else
      show({
        status: 'failed',
        request,
        failure: result.reason === 'invalid_response' ? 'unverified' : result.reason === 'forbidden' ? 'forbidden' : 'failed',
      });
  }
  const data = rendered.status === 'ready' ? rendered.data : null;
  const date = (value: string) =>
    new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
  return (
    <section
      id="blueprint-crew"
      data-testid="blueprint-crew"
      className="blueprint-crew"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <Panel title={t('title')}>
        {rendered.status === 'idle' ? <p className="muted">{t('intro')}</p> : null}
        {rendered.status === 'loading' ? <p role="status">{t('loading')}</p> : null}
        {rendered.status === 'failed' ? (
          <div className="blueprint-crew-failure" role="status">
            <h3>{t(rendered.failure)}</h3>
            <p>{t(`${rendered.failure}Detail`)}</p>
          </div>
        ) : null}
        {data?.status === 'unplaced' ? (
          <div role="status">
            <h3>{t('unplaced')}</h3>
            <p className="muted">{t('unplacedDetail')}</p>
          </div>
        ) : null}
        {data?.status === 'placed' ? (
          <>
            <p className="muted">{t('placed')}</p>
            <dl data-testid="blueprint-crew-identity" className="blueprint-crew-identity">
              <div>
                <dt>{t('crew')}</dt>
                <dd className="blueprint-crew-name" lang={data.crew.name.trim() ? 'und' : languageFor('unnamed')}>
                  {data.crew.name.trim() ? data.crew.name : t('unnamed')}
                </dd>
              </div>
              <div>
                <dt>{t('reference')}</dt>
                <dd lang="zxx">{data.crew.id}</dd>
              </div>
              <div>
                <dt>{t('yourRole')}</dt>
                <dd>{t(data.members[0]!.role)}</dd>
              </div>
            </dl>
            <dl className="blueprint-crew-facts">
              <div>
                <dt>{t('members')}</dt>
                <dd>{t('occupancy', { count: data.members.length, capacity: data.crew.capacity })}</dd>
              </div>
              <div>
                <dt>{t('season')}</dt>
                <dd lang="zxx">{data.crew.season}</dd>
              </div>
              <div className="blueprint-crew-xp">
                <dt>{t('xp')}</dt>
                <dd lang="zxx">{data.crew.xp}</dd>
              </div>
            </dl>
            {!data.profileAvailable ? (
              <aside data-testid="blueprint-crew-note" className="blueprint-crew-note">
                <strong>{t('profileUnavailable')}</strong>
                <p>{t('profileDetail')}</p>
              </aside>
            ) : null}
            <div data-testid="blueprint-crew-roster" className="blueprint-crew-roster">
              <h3>{t('roster')}</h3>
              <ul>
                {data.members.map((member) => (
                  <li key={member.userId}>
                    <strong>
                      {member.own ? `${t('you')} · ` : ''}
                      {t(member.role)}
                    </strong>
                    <span lang="zxx">{member.userId}</span>
                    <span className="muted">{t('joined', { time: date(member.joinedAt) })}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
        <Button
          variant={rendered.status === 'idle' ? 'primary' : 'secondary'}
          disabled={!lease.owner || rendered.status === 'loading'}
          onClick={() => void read()}
        >
          {t(
            rendered.status === 'idle'
              ? 'read'
              : rendered.status === 'failed'
                ? 'retry'
                : rendered.status === 'loading'
                  ? 'loading'
                  : 'again',
          )}
        </Button>
        {data ? (
          <p className="blueprint-crew-export-time muted">
            <span>{t('exported', { time: date(data.exportedAt) })}</span>
            <span>{t('timeLimit')}</span>
          </p>
        ) : null}
      </Panel>
    </section>
  );
}
