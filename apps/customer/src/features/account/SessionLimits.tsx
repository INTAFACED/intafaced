import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { sessionLimitsCopy as copy } from './session-limits-copy';
import { OUT_OF_RANGE, minutesFrom, sessionSettings, spoken } from './session-limits-api';

/**
 * Idle sign-out and the signed-in device limit in Security (slice I-signin-sessions-06, journey J-identity-06 #4): the
 * platform's idle sign-out and device limit as the owner set them (or that none is set), the time that applies to this
 * account, and a shorter time of the person's own. A longer time than the platform's is refused by identity and nothing
 * changes. The time is chosen in whole minutes.
 */
export function SessionLimits() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'sessionSettings', {}, sessionSettings, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `session-limits:${userId}`,
  );

  const time = (seconds: number) => {
    const { unit, count } = spoken(seconds);
    const one = { days: 'day', hours: 'hour', minutes: 'minute', seconds: 'second' } as const;
    return count === 1 ? t(one[unit]) : t(unit, { count });
  };

  async function save(seconds: number | null, range: { minSeconds: number; maxSeconds: number }) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setFailure(null);
    setNote(null);
    try {
      const answer = await api.mutate('identity', 'setIdleSignout', { seconds }, sessionSettings);
      if (!mounted.current) return;
      if (!answer.ok) {
        if (answer.reason !== 'uncertain' && answer.code === OUT_OF_RANGE) {
          return setProblem(t('outOfRange', { min: Math.ceil(range.minSeconds / 60), max: Math.floor(range.maxSeconds / 60) }));
        }
        return setFailure(answer);
      }
      setNote(t(seconds === null ? 'cleared' : 'saved'));
      reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const view = resource.data;
  if (!view) return null;
  const minMinutes = Math.ceil(view.range.minSeconds / 60);
  const maxMinutes = Math.floor(view.range.maxSeconds / 60);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minutes = minutesFrom(String(new FormData(event.currentTarget).get('idle-minutes') ?? ''));
    if (minutes === null) {
      setNote(null);
      return setProblem(t('notMinutes'));
    }
    void save(minutes * 60, view!.range);
  }

  return (
    <section
      data-testid="security__card"
      className="security__session-limits security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p data-testid="session-limits__owner">
        {view.owner.idleSeconds === null
          ? t('ownerIdleUnset', { time: time(view.absoluteSeconds) })
          : t('ownerIdle', { time: time(view.owner.idleSeconds) })}
      </p>
      <p data-testid="session-limits__applied">
        <strong>{view.appliedIdleSeconds === null ? t('appliedNone') : t('applied', { time: time(view.appliedIdleSeconds) })}</strong>{' '}
        <span className="muted">{view.own.idleSeconds === null ? t('ownUnset') : t('ownSet', { time: time(view.own.idleSeconds) })}</span>
      </p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      <form onSubmit={submit} noValidate>
        <Field
          name="idle-minutes"
          inputMode="numeric"
          label={t('label')}
          hint={t('hint', { min: minMinutes, max: maxMinutes })}
          error={problem ?? undefined}
          disabled={busy}
        />
        <div className="actions">
          <Button type="submit" disabled={busy}>
            {busy ? t('working') : t('save')}
          </Button>
          {view.own.idleSeconds !== null && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void save(null, view.range)}>
              {t('clear')}
            </Button>
          )}
        </div>
      </form>
      <h3>{t('devicesTitle')}</h3>
      <p data-testid="session-limits__devices">
        {view.owner.maxDevices === null ? t('maxDevicesUnset') : t('maxDevices', { count: view.owner.maxDevices })}
      </p>
    </section>
  );
}
