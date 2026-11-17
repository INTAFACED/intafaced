import { categoryKey, errorClassCopy, severityKey } from './error-class-copy';
import { TRADE_ERROR_CATALOGUE } from '@intafaced/contracts/trade-errors';
import { docsCopy } from '../developers-docs-copy';
import { tradeErrorsCopy, causeKey, fixKey } from './trade-errors-copy';

/**
 * The order error catalogue (DV-errors-01, DV-errors-02): one row per code, drawn from the contracts list that
 * svc-trade's tests hold to what it sends. Each row has its entry's anchor, which is where a refusal's `docs` link points.
 */
export function TradeErrorsCatalogue() {
  const { t } = tradeErrorsCopy.useCopy();
  const cls = errorClassCopy.useCopy();
  return (
    <>
      <section className="pub-card" aria-labelledby="dev-trade-errors">
        <h2 id="dev-trade-errors">{t('tableTitle')}</h2>
        <div className="table-scroll">
          <table className="pub-table dev-text-table" data-testid="trade-errors-catalogue">
            <thead>
              <tr>
                <th scope="col">{t('colCode')}</th>
                <th scope="col">{t('colStatus')}</th>
                <th scope="col">{t('colDetail')}</th>
                <th scope="col">{cls.t('colSeverity')}</th>
                <th scope="col">{cls.t('colCategory')}</th>
                <th scope="col">{t('colCause')}</th>
                <th scope="col">{t('colFix')}</th>
              </tr>
            </thead>
            <tbody>
              {TRADE_ERROR_CATALOGUE.map((entry) => (
                <tr
                  key={entry.anchor}
                  id={entry.anchor}
                  data-cause={entry.cause}
                  data-code={entry.intafacedCode}
                  data-severity={entry.severity}
                  data-category={entry.category}
                >
                  <th scope="row">
                    <code>{entry.code}</code>
                  </th>
                  <td>{entry.status}</td>
                  <td>
                    <code>{entry.intafacedCode}</code>
                  </td>
                  <td>{cls.t(severityKey(entry.severity))}</td>
                  <td>{cls.t(categoryKey(entry.category))}</td>
                  <td>{t(causeKey(entry.cause))}</td>
                  <td>{t(fixKey(entry.cause))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <a className="text-link" href="/developers/errors/auth">
        {t('authLink')} →
      </a>
    </>
  );
}

/** /developers/errors: the order error catalogue, as one of the portal's written pages. */
export function ErrorsPage({ title }: { title: string }) {
  const { t } = tradeErrorsCopy.useCopy();
  const docs = docsCopy.useCopy();
  return (
    <div className="pub-page" data-testid="developers-errors">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('lead')}</p>
      </header>
      <TradeErrorsCatalogue />
      <a className="text-link" href="/developers">
        ← {docs.t('back')}
      </a>
    </div>
  );
}
