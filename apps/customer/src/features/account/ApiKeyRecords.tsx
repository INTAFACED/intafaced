import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { currentReturnLocation } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { Button, Loading } from '../../shared/ui';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { useSession } from '../session/session';
import {
  currentSharedCardRoute as currentReadRoute,
  subscribeSharedCardRoute as subscribeReadRoute,
} from '../more/blueprint-shared-card-contract';
import { apiKeyReadWindows, readApiKeyRecords, type ApiKeyReadWindow, type ApiKeyRecord } from './api-key-records-api';
import { copy } from './copy';
import { ApiKeyRevocation, useApiKeyRevocation } from './ApiKeyRevocation';
import { canReviewApiKeyRevoke } from './api-key-revoke-contract';

type Lease = Readonly<{
  api: ApiClient;
  owner: string | null;
  session: object | null;
  route: ReturnType<typeof currentReadRoute>;
  limit: ApiKeyReadWindow;
}>;
type Request = Readonly<{ lease: Lease; controller: AbortController }>;
type View =
  | { status: 'idle' }
  | { status: 'loading'; request: Request }
  | { status: 'ready'; request: Request; rows: ApiKeyRecord[] }
  | { status: 'failed'; request: Request; failure: Extract<ApiResult<unknown>, { ok: false }> };

export function ApiKeyRecords() {
  const { api, userId: owner, session } = useSession();
  const { t, Copy, requestedLocale, languageFor } = copy.useCopy();
  const dateTime = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
    return { formatter, language: formatter.resolvedOptions().locale };
  }, [requestedLocale]);
  const heading = useId();
  const [limit, setLimit] = useState<ApiKeyReadWindow>(50);
  const [view, setView] = useState<View>({ status: 'idle' });
  const [, refresh] = useState(0);
  const mounted = useRef(false),
    leaseRef = useRef<Lease | null>(null),
    requestRef = useRef<Request | null>(null),
    viewRef = useRef(view);
  function discard() {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }
  function show(next: View) {
    viewRef.current = next;
    setView(next);
  }
  const route = currentReadRoute();
  if (
    !leaseRef.current ||
    leaseRef.current.api !== api ||
    leaseRef.current.owner !== owner ||
    leaseRef.current.session !== session ||
    leaseRef.current.route !== route ||
    leaseRef.current.limit !== limit
  ) {
    discard();
    leaseRef.current = Object.freeze({ api, owner, session, route, limit });
  }
  const lease = leaseRef.current;
  // canWrite is the immediate client/session identity guard, not a key grant.
  const admits = () =>
    mounted.current &&
    leaseRef.current === lease &&
    !!lease.owner &&
    !!lease.session &&
    lease.api.canWrite() &&
    currentReadRoute() === lease.route;
  const requestCurrent = (request: Request) =>
    admits() && requestRef.current === request && request.lease === lease && !request.controller.signal.aborted;
  const rendered: View = view.status === 'idle' || requestCurrent(view.request) ? view : { status: 'idle' };
  const actionCurrent = () => admits() && viewRef.current === view;
  useLayoutEffect(() => {
    mounted.current = true;
    const release = subscribeReadRoute(() => {
      discard();
      leaseRef.current = null;
      // Retire private DOM and retained callbacks at the observed departure,
      // even when a same-task URL A→B→A would leave the final href unchanged.
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
    if (!actionCurrent() || rendered.status === 'loading') return;
    discard();
    const request: Request = Object.freeze({ lease, controller: new AbortController() });
    requestRef.current = request;
    // No previous private rows survive admission or a failed refresh.
    show({ status: 'loading', request });
    let result: ApiResult<ApiKeyRecord[]>;
    try {
      result = await readApiKeyRecords(lease.api, lease.limit, request.controller.signal);
    } catch {
      result = authoredRefusal('unreachable', { key: 'loadFailed' });
    }
    if (!requestCurrent(request)) return;
    show(result.ok ? { status: 'ready', request, rows: result.data } : { status: 'failed', request, failure: result });
  }
  function chooseWindow(value: string) {
    if (!actionCurrent()) return;
    const next = apiKeyReadWindows.find((choice) => String(choice) === value);
    if (!next || next === limit) return;
    discard();
    leaseRef.current = null;
    flushSync(() => {
      show({ status: 'idle' });
      setLimit(next);
    });
  }
  const revocation = useApiKeyRevocation({
    api,
    owner,
    session,
    context: lease,
    limit,
    inventory: rendered.status === 'ready' ? rendered : null,
    current: admits,
    actionCurrent,
    inventoryCurrent: (receipt) =>
      viewRef.current === receipt && viewRef.current.status === 'ready' && requestCurrent(viewRef.current.request),
  });
  if (!owner || !session) return null;
  const failure = rendered.status === 'failed' ? rendered.failure : null;
  return (
    <section
      data-testid="security__card"
      className="api-key-records security__card"
      aria-labelledby={heading}
      lang={languageFor('api.records.title')}
    >
      <header className="api-key-records__introduction">
        <h2 id={heading}>
          <Copy k="api.records.title" />
        </h2>
        <p className="muted">
          <Copy k="api.records.intro" />
        </p>
      </header>
      {failure && (
        <div className="api-key-records__failure" role="status">
          <h3>
            <Copy
              k={
                failure.reason === 'forbidden'
                  ? 'api.records.forbidden'
                  : failure.reason === 'invalid_response'
                    ? 'api.records.invalid'
                    : failure.reason === 'unauthorized'
                      ? 'api.records.signin.title'
                      : 'api.records.failed'
              }
            />
          </h3>
          <p className="muted">
            <Copy k="api.records.failed.body" />
          </p>
          <p lang={failure.messageCopy ? uiCopy.forLocale(requestedLocale).languageFor(failure.messageCopy.key) : 'und'}>
            {failure.messageCopy ? uiMessage(failure.messageCopy, requestedLocale) : failure.message}
          </p>
          {failure.reason === 'unauthorized' && (
            <a
              className="text-link api-key-records__signin"
              href={`/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`}
              onClick={(event) => {
                if (!actionCurrent()) {
                  event.preventDefault();
                  return;
                }
                event.currentTarget.href = `/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`;
              }}
            >
              <Copy k="api.records.signin" />
            </a>
          )}
        </div>
      )}
      <div className="api-key-records__controls">
        {failure?.reason !== 'unauthorized' && (
          <Button variant="secondary" disabled={rendered.status === 'loading'} onClick={() => void read()}>
            <Copy
              k={
                rendered.status === 'idle' ? 'api.records.read' : rendered.status === 'failed' ? 'api.records.retry' : 'api.records.refresh'
              }
            />
          </Button>
        )}
      </div>
      <ApiKeyRevocation action={revocation} />
      {rendered.status === 'loading' && <Loading label={<Copy k="api.records.loading" />} />}
      {rendered.status === 'ready' &&
        (rendered.rows.length === 0 ? (
          <p role="status">
            <Copy k="api.records.empty" />
          </p>
        ) : (
          <ul className="api-key-records__rows">
            {rendered.rows.map((record) => (
              <li key={record.id} className="api-key-records__row">
                <div className="api-key-records__name">
                  <h3>{record.name ? <bdi lang="und">{record.name}</bdi> : <Copy k="api.records.unnamed" />}</h3>
                  <p className="muted">
                    <Copy k={record.revoked ? 'api.records.revoked' : 'api.records.not.revoked'} />
                  </p>
                </div>
                <dl className="api-key-records__references">
                  <div>
                    <dt>
                      <Copy k="api.records.id" />
                    </dt>
                    <dd>
                      <bdi lang="und">{record.id}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Copy k="api.records.prefix" />
                    </dt>
                    <dd>
                      <bdi lang="und">{record.prefix}</bdi>
                    </dd>
                  </div>
                </dl>
                <dl className="api-key-records__metadata">
                  <div>
                    <dt>
                      <Copy k="api.records.mode" />
                    </dt>
                    <dd>
                      <bdi lang="und">{record.mode}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Copy k="api.records.scopes" />
                    </dt>
                    <dd>
                      {record.scopes.map((scope, index) => (
                        <bdi key={index} lang="und">
                          {index > 0 ? ' · ' : ''}
                          {scope}
                        </bdi>
                      ))}
                    </dd>
                  </div>
                  <div>
                    {record.lastUsedAt === null ? (
                      <dd className="muted">
                        <Copy k="api.records.no.last.use" />
                      </dd>
                    ) : (
                      <>
                        <dt>
                          <Copy k="api.records.last.used" />
                        </dt>
                        <dd>
                          <time dateTime={record.lastUsedAt} lang={dateTime.language} dir="auto">
                            {dateTime.formatter.format(new Date(record.lastUsedAt))} UTC
                          </time>
                        </dd>
                      </>
                    )}
                  </div>
                </dl>
                {canReviewApiKeyRevoke(record) && (
                  <Button
                    variant="secondary"
                    className="api-key-revoke__row-action"
                    disabled={revocation.blocked}
                    onClick={(event) => revocation.review(record, event?.currentTarget)}
                  >
                    <Copy k="api.revoke.review" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
      {rendered.status === 'ready' && rendered.rows.length >= limit && (
        <p className="muted">
          <Copy k="api.records.window.scope" params={{ count: limit }} />
        </p>
      )}
    </section>
  );
}
