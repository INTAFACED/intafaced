import { useEffect, useState } from 'react';
import { hostDispatchCopy as copy } from './host-dispatch-copy';
import { readHostDispatch, type HostDispatchView } from './host-dispatch';

/** The apex, app and join hosts as the deployment's host check left them: served, or the typed code that refused each. */
export function HostDispatch() {
  const { t } = copy.useCopy();
  const [view, setView] = useState<HostDispatchView | null>(null);
  useEffect(() => {
    let live = true;
    void readHostDispatch().then((read) => live && setView(read));
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="help__card host-dispatch" data-testid="host-dispatch" aria-labelledby="host-dispatch-title">
      <h2 id="host-dispatch-title">{t('title')}</h2>
      {!view ? (
        <p className="muted">{t('checking')}</p>
      ) : (
        <>
          {view.source !== 'receipt' && (
            <p className="muted" role="status">
              {t(view.source)}
            </p>
          )}
          <ul className="host-dispatch__rows">
            {view.rows.map((row) => (
              <li key={row.role} data-testid={`host-dispatch-${row.role}`} data-result={row.result}>
                <span>{t(row.role)}</span>{' '}
                <span lang="zxx" className="muted">
                  {row.host ?? t('notNamed')}
                </span>{' '}
                <strong lang="zxx">{row.result === 'served' ? t('served') : row.result}</strong>
                {row.detail && (
                  <span lang="und" className="muted">
                    {' '}
                    ({row.detail})
                  </span>
                )}
              </li>
            ))}
          </ul>
          {view.checkedAt && (
            <p className="help__caption muted">
              {t('checkedAt')} <span lang="zxx">{view.checkedAt}</span>
            </p>
          )}
          {view.lastGood && <p className="help__caption muted">{t('lastGood', { at: view.lastGood.checkedAt })}</p>}
        </>
      )}
    </section>
  );
}
