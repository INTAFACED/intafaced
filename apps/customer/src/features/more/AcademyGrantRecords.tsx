import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { Details } from './common';
import type { AcademyAction } from './academy-action';
import type { GrantRecord } from './academy-grant-api';
import { academyGrantCopy as copy } from './academy-grant-copy';
import './academy-grant.css';

export function AcademyGrantRecords({ action, titles }: { action: AcademyAction; titles: ReadonlyMap<string, string> }) {
  const { userId } = useSession();
  const { t, Copy, requestedLocale } = copy.useCopy();
  const context = action.readContext;
  const alive = useRef(true),
    currentRead = useRef<object | null>(null),
    size = useRef(50);
  const [view, setView] = useState<{
    context: typeof context;
    status: 'loading' | 'ready' | 'failed';
    limit: number;
    rows: GrantRecord[];
    failure: Extract<ApiResult<unknown>, { ok: false }> | null;
  }>({ context, status: 'loading', limit: 50, rows: [], failure: null });
  const current = () => alive.current && action.isCurrent();
  async function read(limit: number) {
    if (!current() || limit !== size.current) return;
    const attempt = {};
    currentRead.current = attempt;
    setView({ context, status: 'loading', limit, rows: [], failure: null });
    const guard = () => current() && currentRead.current === attempt && limit === size.current;
    const result = await action.grantApi.readRecords(limit, guard);
    if (!guard()) return;
    setView({
      context,
      status: result.ok ? 'ready' : 'failed',
      limit,
      rows: result.ok ? result.data : [],
      failure: result.ok ? null : result,
    });
  }
  useLayoutEffect(() => {
    alive.current = true;
    size.current = 50;
    void read(50);
    return () => {
      alive.current = false;
      currentRead.current = null;
    };
  }, [context]);
  const shown = view.context === context && current() ? view : null;
  const snapshot = action.snapshot;
  const proof = current() ? (snapshot.known?.grant ?? action.recorded) : null;
  const identity = (certId: string, reference: string) => (
    <Details
      items={[
        [t('certificate'), <span lang={titles.has(certId) ? 'und' : 'zxx'}>{titles.get(certId) ?? certId}</span>],
        [t('account'), <code lang="zxx">{userId}</code>],
        [t('reference'), <code lang="zxx">{reference}</code>],
      ]}
    />
  );
  if (!current()) return null;
  return (
    <div className="academy-grant-records" lang={requestedLocale}>
      <header>
        <h2>
          <Copy k="title" />
        </h2>
        <p className="muted">
          <Copy k="subtitle" />
        </p>
      </header>
      {snapshot.status === 'grant' && !proof && (
        <section data-testid="academy-grant-original" className="academy-grant-original" aria-label={t('unknown')}>
          <h3>
            <Copy k="unknown" />
          </h3>
          {identity(snapshot.certId!, snapshot.marker.reference!)}
          <p>
            <Copy k="unknownBody" />
          </p>
          {action.noMatch && (
            <p className="muted">
              <Copy k="noMatch" />
            </p>
          )}
          <Button onClick={() => void action.check()} disabled={action.busy}>
            <Copy k="check" />
          </Button>
          <a className="text-link" href="/support">
            <Copy k="support" />
          </a>
        </section>
      )}
      {proof && (
        <section data-testid="academy-grant-original" className="academy-grant-original" aria-label={t('confirmed')}>
          <h3>
            <Copy k="confirmed" />
          </h3>
          {identity(proof.certId, proof.idempotencyKey)}
          <Details
            items={[
              [
                t('recordedAt'),
                <time lang="zxx" dateTime={proof.grantedAt}>
                  {proof.grantedAt}
                </time>,
              ],
            ]}
          />
          <p>
            <Copy k="confirmedBody" />
          </p>
          <p className="muted">
            <Copy k="xpUnknown" />
          </p>
          {snapshot.known && (
            <>
              <p>
                <Copy k="cleanup" />
              </p>
              <Button onClick={() => void action.cleanup(snapshot.known!)} disabled={action.busy}>
                <Copy k="cleanupAction" />
              </Button>
              <p className="muted">
                <Copy k="cleanupOnly" />
              </p>
            </>
          )}
        </section>
      )}
      <section aria-label={t('records')} className="academy-grant-list">
        <div className="academy-grant-heading">
          <h3>
            <Copy k="records" />
          </h3>
          <Button variant="secondary" onClick={() => void read(view.limit)} disabled={shown?.status === 'loading'}>
            <Copy k="refresh" />
          </Button>
        </div>
        {!shown || shown.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : shown.status === 'failed' && shown.failure ? (
          <Failure result={shown.failure} retry={() => void read(shown.limit)} />
        ) : (
          <>
            {!shown.rows.length && <EmptyState title={t('empty')} />}
            {shown.rows.map((row) => (
              <article key={row.idempotencyKey}>
                <h4 lang={titles.has(row.certId) ? 'und' : 'zxx'}>{titles.get(row.certId) ?? row.certId}</h4>
                <time lang="zxx" dateTime={row.grantedAt}>
                  {row.grantedAt}
                </time>
                <code lang="zxx">{row.idempotencyKey}</code>
              </article>
            ))}
            <p className="muted">
              <Copy k="window" params={{ count: shown.rows.length, limit: shown.limit }} />
            </p>
            {shown.rows.length >= shown.limit && shown.limit < 200 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  size.current = Math.min(200, shown.limit + 50);
                  void read(size.current);
                }}
              >
                <Copy k="larger" />
              </Button>
            ) : (
              shown.limit === 200 && (
                <p className="muted">
                  <Copy k="cap" />
                </p>
              )
            )}
          </>
        )}
        <p className="muted">
          <Copy k="boundary" />
        </p>
      </section>
    </div>
  );
}
