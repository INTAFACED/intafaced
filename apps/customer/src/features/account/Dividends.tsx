import { DataTable, Page } from '../../shared/ui';
import { dividendsCopy as copy } from './dividends-copy';
import './dividends.css';

/**
 * The dividends room. No procedure lists an account's own payouts yet, so the history is an honest empty table:
 * what a dividend is here, what is missing, and nowhere an amount that was not read from the service.
 */
export function Dividends() {
  const { t, Copy, languageFor } = copy.useCopy();
  return (
    <div className="dividends" lang={languageFor('title')} style={{ display: 'contents' }}>
      <Page title={t('title')} description={t('description')}>
        <div className="dividends__columns">
          <section aria-labelledby="dividends-what">
            <h2 id="dividends-what">
              <Copy k="whatTitle" />
            </h2>
            <p>
              <Copy k="whatBody" />
            </p>
          </section>
          <section aria-labelledby="dividends-need">
            <h2 id="dividends-need">
              <Copy k="needTitle" />
            </h2>
            <p>
              <Copy k="needBody" />
            </p>
            <p className="muted">
              <Copy k="needToken" />
            </p>
          </section>
        </div>
        <section aria-labelledby="dividends-history">
          <h2 id="dividends-history">
            <Copy k="historyTitle" />
          </h2>
          <DataTable label={t('historyLabel')} headers={[t('colDate'), t('colAsset'), t('colAmount'), t('colSource')]}>
            <tr>
              <td colSpan={4}>
                <strong>
                  <Copy k="emptyTitle" />
                </strong>
                <br />
                <span className="muted">
                  <Copy k="emptyBody" />
                </span>
              </td>
            </tr>
          </DataTable>
        </section>
        <div className="actions">
          <a className="text-link" href="/token">
            <Copy k="token" />
          </a>
          <a className="text-link" href="/bank/earn">
            <Copy k="earn" />
          </a>
          <a className="text-link" href="/money/activity">
            <Copy k="activity" />
          </a>
        </div>
      </Page>
    </div>
  );
}
