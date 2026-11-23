import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSession } from '../session';
import { Button } from '@intafaced/ui/lit';
import type { ApiClient, ApiResult } from '../../shared/api';
import { currentRoute, subscribeRoute } from '../../shared/route-watch';
import { BLUEPRINT_EXPORT } from '@intafaced/contracts/blueprint-procedures';
import { crewExportOwnedBy, crewProjection, type CrewEnvelope, type CrewRead } from './blueprint-crew-codec';
import { blueprintCrewCopy } from './blueprint-crew-copy';
import { BlueprintMentorCardAction } from './BlueprintSharedCard';
import { Section } from './volt-parts';

type Lease = Readonly<{ api: ApiClient; owner: string | null; session: object | null; route: ReturnType<typeof currentRoute> }>;
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
  const route = currentRoute();
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
    mounted.current && leaseRef.current === lease && !!lease.owner && lease.api.canWrite() && currentRoute() === lease.route;
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
    const release = subscribeRoute(() => {
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
      result = await lease.api.call(BLUEPRINT_EXPORT, undefined, {
        signal: request.controller.signal,
        accept: crewExportOwnedBy(lease.owner),
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
    <Section id="blueprint-crew" aria-label={t('title')} lang={languageFor('title')} title={t('title')}>
      {rendered.status === 'idle' ? <p className="lt-hint">{t('intro')}</p> : null}
      {rendered.status === 'loading' ? <p role="status">{t('loading')}</p> : null}
      {rendered.status === 'failed' ? (
        <div className="lt-refusal" role="status">
          <h3 className="lt-refusal-title">{t(rendered.failure)}</h3>
          <p className="lt-refusal-body">{t(`${rendered.failure}Detail`)}</p>
        </div>
      ) : null}
      {data?.status === 'unplaced' ? (
        <div role="status">
          <h3>{t('unplaced')}</h3>
          <p className="lt-hint">{t('unplacedDetail')}</p>
        </div>
      ) : null}
      {data?.status === 'placed' ? (
        <>
          <p className="lt-hint">{t('placed')}</p>
          <dl className="lt-kv">
            <div>
              <dt>{t('crew')}</dt>
              <dd lang={data.crew.name.trim() ? 'und' : languageFor('unnamed')}>{data.crew.name.trim() ? data.crew.name : t('unnamed')}</dd>
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
          <dl className="lt-kv">
            <div>
              <dt>{t('members')}</dt>
              <dd>{t('occupancy', { count: data.members.length, capacity: data.crew.capacity })}</dd>
            </div>
            <div>
              <dt>{t('season')}</dt>
              <dd lang="zxx">{data.crew.season}</dd>
            </div>
            <div>
              <dt>{t('xp')}</dt>
              <dd lang="zxx">{data.crew.xp}</dd>
            </div>
          </dl>
          {!data.profileAvailable ? (
            <aside className="lt-refusal">
              <strong className="lt-refusal-title">{t('profileUnavailable')}</strong>
              <p className="lt-refusal-body">{t('profileDetail')}</p>
            </aside>
          ) : null}
          <div className="lt-stack">
            <h3>{t('roster')}</h3>
            <ul>
              {data.members.map((member) => (
                <li key={member.userId}>
                  <strong>
                    {member.own ? `${t('you')} · ` : ''}
                    {t(member.role)}
                  </strong>
                  <span lang="zxx">{member.userId}</span>
                  <span className="lt-hint">{t('joined', { time: date(member.joinedAt) })}</span>
                  {/* The crewmate is picked here, so nobody has to copy their account code into the card viewer. */}
                  {member.own ? null : <BlueprintMentorCardAction subject={member.userId} available={admits} />}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
      <Button
        tone={rendered.status === 'idle' ? 'primary' : 'secondary'}
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
        <p className="lt-hint">
          <span>{t('exported', { time: date(data.exportedAt) })}</span>
          <span>{t('timeLimit')}</span>
        </p>
      ) : null}
    </Section>
  );
}
