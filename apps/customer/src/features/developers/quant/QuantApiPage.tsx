import { DocPage } from '../DocPage';
import { quantApiCopy } from './quant-api-copy';
import { QUANT_API_ENDPOINTS } from './quant-api-endpoints';
import { QUANT_PYTHON_CLIENT } from './python-client';

const PYTHON_HREF = `data:text/x-python;charset=utf-8,${encodeURIComponent(QUANT_PYTHON_CLIENT)}`;

/** /developers/quant (J-algo-dev-14; AL-api-01): the strategy API, what a key may call on Algo dev and what it can't. */
export function QuantApiPage({ title }: { title: string }) {
  const { t } = quantApiCopy.useCopy();
  return (
    <DocPage id="quant" title={title} lead={t('lead')} back={t('back')}>
      <section aria-labelledby="quant-key">
        <h2 id="quant-key">{t('keyTitle')}</h2>
        <p>{t('keyBody')}</p>
        <a className="lt-link lt-link-alone" href="/uc/safe/api-keys/new">
          /uc/safe/api-keys/new
        </a>
      </section>
      <section aria-labelledby="quant-endpoints" data-testid="developers-quant-endpoints">
        <h2 id="quant-endpoints">{t('endpointsTitle')}</h2>
        <p>{t('endpointsLead')}</p>
        <div>
          <table className="lt-table">
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
                  <td data-label={t('colMethod')}>
                    <code lang="und">{row.method}</code>
                  </td>
                  <td data-label={t('colPath')}>
                    <code lang="und">{row.path}</code>
                  </td>
                  <td data-label={t('colScope')}>
                    <code lang="und">{row.scope}</code>
                  </td>
                  <td data-label={t('colWhat')} data-align="start">
                    {(t as (key: string) => string)(row.what)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section id="python" aria-labelledby="quant-python" data-testid="developers-quant-python">
        <h2 id="quant-python">{t('pyTitle')}</h2>
        <p>{t('pyBody')}</p>
        <p data-testid="developers-quant-python-install">
          <code lang="und">{t('pyInstall')}</code>
        </p>
        <a
          className="lt-link lt-link-alone"
          href={PYTHON_HREF}
          download="intafaced_quant.py"
          data-testid="developers-quant-python-download"
        >
          {t('pyDownload')}
        </a>
      </section>
      <section aria-labelledby="quant-idem" data-testid="developers-quant-idempotency">
        <h2 id="quant-idem">{t('idemTitle')}</h2>
        <p>{t('idemBody')}</p>
      </section>
      <section aria-labelledby="quant-no-deploy" data-testid="developers-quant-no-deploy">
        <h2 id="quant-no-deploy">{t('noDeployTitle')}</h2>
        <p>{t('noDeployBody')}</p>
      </section>
      <section aria-labelledby="quant-rules" data-testid="developers-quant-rules">
        <h2 id="quant-rules">{t('rulesTitle')}</h2>
        <p>{t('rulesBody')}</p>
      </section>
    </DocPage>
  );
}
