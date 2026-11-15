import { quantApiCopy } from './quant-api-copy';
import { QUANT_API_ENDPOINTS } from './quant-api-endpoints';

/** /developers/quant (J-algo-dev-14; AL-api-01): the strategy API, what a key may call on Algo dev and what it can't. */
export function QuantApiPage({ title }: { title: string }) {
  const { t } = quantApiCopy.useCopy();
  return (
    <div className="pub-page" data-testid="developers-quant">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('lead')}</p>
      </header>
      <section className="pub-card" aria-labelledby="quant-key">
        <h2 id="quant-key">{t('keyTitle')}</h2>
        <p>{t('keyBody')}</p>
        <a className="text-link" href="/uc/safe/api-keys/new">
          /uc/safe/api-keys/new
        </a>
      </section>
      <section className="pub-card" aria-labelledby="quant-endpoints" data-testid="developers-quant-endpoints">
        <h2 id="quant-endpoints">{t('endpointsTitle')}</h2>
        <p>{t('endpointsLead')}</p>
        <div className="table-scroll">
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{t('colMethod')}</th>
                <th scope="col">{t('colPath')}</th>
                <th scope="col">{t('colScope')}</th>
                <th scope="col">{t('colWhat')}</th>
              </tr>
            </thead>
            <tbody>
              {QUANT_API_ENDPOINTS.map((row) => (
                <tr key={`${row.method} ${row.path}`} data-testid="developers-quant-endpoint" data-path={row.path} data-scope={row.scope}>
                  <td>
                    <code lang="und">{row.method}</code>
                  </td>
                  <td>
                    <code lang="und">{row.path}</code>
                  </td>
                  <td>
                    <code lang="und">{row.scope}</code>
                  </td>
                  <td>{(t as (key: string) => string)(row.what)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="pub-card" aria-labelledby="quant-idem" data-testid="developers-quant-idempotency">
        <h2 id="quant-idem">{t('idemTitle')}</h2>
        <p>{t('idemBody')}</p>
      </section>
      <section className="pub-card" aria-labelledby="quant-no-deploy" data-testid="developers-quant-no-deploy">
        <h2 id="quant-no-deploy">{t('noDeployTitle')}</h2>
        <p>{t('noDeployBody')}</p>
      </section>
      <section className="pub-card" aria-labelledby="quant-rules" data-testid="developers-quant-rules">
        <h2 id="quant-rules">{t('rulesTitle')}</h2>
        <p>{t('rulesBody')}</p>
      </section>
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}
