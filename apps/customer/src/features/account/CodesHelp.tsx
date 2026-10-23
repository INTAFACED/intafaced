import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../session/session';
import { Button } from '../../shared/ui';
import { codesHelpCopy as copy } from './codes-help-copy';
import {
  DRIFT_LIMIT_SECONDS,
  SERVER_TIME_PROCEDURE,
  clockDriftSeconds,
  clockVerdict,
  serverTimeSchema,
  type ClockVerdict,
} from './codes-help';

type Check = { kind: 'checking' } | { kind: 'failed' } | { kind: 'done'; verdict: ClockVerdict };

/**
 * "My codes do not work" on the authenticator card (slice I-signin-sessions-13): compares this device's clock with the
 * service's and says by how many seconds it is off, or that codes should work and offers Replace; warns about apps that
 * sync codes; and walks a move to a new phone, which is the card's own Replace. A failed time read makes no drift claim.
 */
export function CodesHelp({ onReplace, onClose }: { onReplace: () => void; onClose: () => void }) {
  const { t, languageFor } = copy.useCopy();
  const { api } = useSession();
  const [check, setCheck] = useState<Check>({ kind: 'checking' });
  const mounted = useRef(true);
  // The check runs when the panel opens and on "Check again", not when the session's client changes (a token refresh);
  // only the newest run may show its answer.
  const apiRef = useRef(api);
  apiRef.current = api;
  const latest = useRef(0);

  const run = useCallback(async () => {
    const mine = ++latest.current;
    setCheck({ kind: 'checking' });
    const sentAt = Date.now();
    const answer = await apiRef.current.query('identity', SERVER_TIME_PROCEDURE, undefined, serverTimeSchema);
    const receivedAt = Date.now();
    if (!mounted.current || mine !== latest.current) return;
    if (!answer.ok) return setCheck({ kind: 'failed' });
    try {
      setCheck({ kind: 'done', verdict: clockVerdict(clockDriftSeconds(answer.data.now, sentAt, receivedAt)) });
    } catch {
      setCheck({ kind: 'failed' });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
    };
  }, [run]);

  return (
    <section className="security__codes-help stack" aria-label={t('title')} lang={languageFor('title')}>
      <h3>{t('title')}</h3>
      <p>{t('why')}</p>
      {check.kind === 'checking' && <p role="status">{t('checking')}</p>}
      {check.kind === 'failed' && (
        <div className="stack">
          <p role="alert">{t('checkFailed')}</p>
          <div className="row">
            <Button variant="secondary" onClick={() => void run()}>
              {t('checkAgain')}
            </Button>
          </div>
        </div>
      )}
      {check.kind === 'done' && check.verdict.kind !== 'in-sync' && (
        <p className="error-text" role="status">
          {t(check.verdict.kind, { seconds: check.verdict.seconds })}
        </p>
      )}
      {check.kind === 'done' && check.verdict.kind === 'in-sync' && (
        <div className="stack">
          <p role="status">{t('inSync', { limit: DRIFT_LIMIT_SECONDS })}</p>
          <div className="row">
            <Button variant="secondary" onClick={onReplace}>
              {t('replace')}
            </Button>
          </div>
        </div>
      )}
      <h4>{t('syncTitle')}</h4>
      <p>{t('sync')}</p>
      <h4>{t('moveTitle')}</h4>
      <ol>
        <li>{t('move1')}</li>
        <li>{t('move2')}</li>
        <li>{t('move3')}</li>
        <li>{t('move4')}</li>
      </ol>
      <div className="row">
        <Button onClick={onReplace}>{t('moveStart')}</Button>
        <Button variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </section>
  );
}
