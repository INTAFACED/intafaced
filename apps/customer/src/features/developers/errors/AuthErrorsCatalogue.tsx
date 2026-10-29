import { AUTH_ERROR_CATALOGUE } from '@intafaced/contracts/auth-errors';
import { authErrorsCopy, causeKey, fixKey } from './auth-errors-copy';

/**
 * The authentication and permission catalogue (DV-errors-02): one row per refusal, drawn from the contracts list that
 * svc-edge's tests hold to what the edge sends. Each row has its entry's anchor, which is where the edge's key and
 * signature refusals point their `docs` link.
 */
export function AuthErrorsCatalogue() {
  const { t } = authErrorsCopy.useCopy();
  return (
    <>
      <p className="muted">{t('lead')}</p>
      <section className="pub-card" aria-labelledby="dev-auth-errors">
        <h2 id="dev-auth-errors">{t('tableTitle')}</h2>
        <div className="table-scroll">
          <table className="pub-table dev-text-table" data-testid="auth-errors-catalogue">
            <thead>
              <tr>
                <th scope="col">{t('colCode')}</th>
                <th scope="col">{t('colStatus')}</th>
                <th scope="col">{t('colDetail')}</th>
                <th scope="col">{t('colCause')}</th>
                <th scope="col">{t('colFix')}</th>
              </tr>
            </thead>
            <tbody>
              {AUTH_ERROR_CATALOGUE.map((entry) => (
                <tr key={entry.anchor} id={entry.anchor} data-cause={entry.cause} data-code={entry.code}>
                  <th scope="row">
                    <code>{entry.code}</code>
                  </th>
                  <td>{entry.status}</td>
                  <td>{entry.intafacedCode ? <code>{entry.intafacedCode}</code> : t('noDetail')}</td>
                  <td>
                    {t(causeKey(entry.cause))}
                    {entry.answeredBy === 'trade' ? <span className="muted"> {t('answeredByTrade')}</span> : null}
                  </td>
                  <td>
                    {entry.cause === 'scope' ? (
                      <a className="text-link" href="/developers/permissions">
                        {t(fixKey(entry.cause))}
                      </a>
                    ) : (
                      t(fixKey(entry.cause))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
