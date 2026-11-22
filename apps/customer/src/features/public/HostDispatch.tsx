import { useEffect, useState } from 'react';
import { hostDispatchCopy as copy } from './host-dispatch-copy';
import { hostDispatchOnce, type HostDispatchView } from './host-dispatch';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';

/** The apex, app and join hosts as the deployment's host check left them: served, or the typed code that refused each. */
export function HostDispatch() {
  const { t } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [view, setView] = useState<HostDispatchView | null>(null);
  useEffect(() => {
    let live = true;
    void hostDispatchOnce().then((read) => live && setView(read));
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="lt-stack" data-testid="host-dispatch" aria-labelledby="host-dispatch-title">
      <h2 id="host-dispatch-title">
        {t('title')}
        {view?.test && (
          <>
            {' '}
            <span className="lt-test" data-testid="host-dispatch-test" data-status="test">
              {t('TEST')}
            </span>
          </>
        )}
      </h2>
      {!view ? (
        <p className="lt-hint">{t('checking')}</p>
      ) : (
        <>
          {view.test && (
            <p className="lt-hint" role="status">
              {t('testHosts')}
            </p>
          )}
          {view.source !== 'receipt' && (
            <p className="lt-hint" role="status">
              {t(view.source)}
            </p>
          )}
          {view.everyHost && (
            <p role="status">
              {t('everyHost')} <strong lang="zxx">{view.everyHost}</strong>
            </p>
          )}
          <ul className="lt-stack">
            {view.rows.map((row) => (
              <li key={row.role} data-testid={`host-dispatch-${row.role}`} data-result={row.result}>
                <span>{t(row.role)}</span>{' '}
                <span lang="zxx" className="lt-hint lt-wrap">
                  {row.host ?? t('notNamed')}
                </span>{' '}
                <strong lang="zxx">{row.result === 'served' ? t('served') : row.result}</strong>
              </li>
            ))}
          </ul>
          {view.checkedAt && (
            <p className="lt-hint">
              {t('checkedAt')} <span lang="zxx">{stamp(view.checkedAt, timeZone)}</span>
            </p>
          )}
          {view.lastGood && (
            <p className="lt-hint">
              {t('lastGood', {
                at: stamp(view.lastGood.checkedAt, timeZone),
                since: stamp(view.lastGood.staleSince ?? view.checkedAt ?? view.lastGood.checkedAt, timeZone),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
