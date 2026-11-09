import { StateBlock } from '@intafaced/ui';
import { SPOT_ORDER_TYPES_PATH, spotOrderTypesSchema } from '@intafaced/contracts/spot-order-types';
import { useSession } from '../../session/session';
import { deskCopy } from '../../../screens/trade/desk/copy';
import { TYPE_TAB_KEY } from '../../../screens/trade/desk/OrderOptions';
import { useRead } from '../use-read';
import { tradingApiCopy } from './trading-api-copy';

const V1 = '/api/v1';

/**
 * /developers/order-types (J-cex-spot-15 #4): the spot order types the API accepts, read from svc-trade's
 * GET /api/v1/order-types and named as the trading ticket names its tabs. The ticket draws its tabs from the same
 * shared list, so the two cannot differ. A listed type the API refuses is shown with its code.
 */
export function OrderTypesPage({ title }: { title: string }) {
  const { t } = tradingApiCopy.useCopy();
  const desk = deskCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => api.rest(SPOT_ORDER_TYPES_PATH.slice(V1.length), spotOrderTypesSchema, { signal }), [api]);
  return (
    <div className="pub-page" data-testid="developers-order-types">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('typesLead')}</p>
      </header>
      {read.status === 'loading' ? (
        <StateBlock kind="loading" rows={7} rowHeight={32} label={t('loading')} />
      ) : read.status === 'failed' ? (
        <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <>
          <section className="pub-card" aria-labelledby="dev-order-types">
            <h2 id="dev-order-types">{t('typesTitle')}</h2>
            <div className="table-scroll">
              <table className="pub-table dev-text-table" data-testid="order-types-accepted">
                <thead>
                  <tr>
                    <th scope="col">{t('colType')}</th>
                    <th scope="col">{t('colBodyType')}</th>
                    <th scope="col">{t('colFields')}</th>
                    <th scope="col">{t('colTif')}</th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.accepted.map((row) => (
                    <tr key={row.id} data-type={row.id}>
                      <th scope="row">{desk.t(TYPE_TAB_KEY[row.id])}</th>
                      <td>
                        <code>{row.send.type.join(' | ')}</code>
                      </td>
                      <td>{row.send.fields.length ? <code>{row.send.fields.join(', ')}</code> : t('noFields')}</td>
                      <td>{row.timeInForce.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="pub-card" aria-labelledby="dev-order-types-refused">
            <h2 id="dev-order-types-refused">{t('refusedTitle')}</h2>
            <p className="muted">{t('refusedLead')}</p>
            <table className="pub-table dev-text-table" data-testid="order-types-refused">
              <thead>
                <tr>
                  <th scope="col">{t('colType')}</th>
                  <th scope="col">{t('colCode')}</th>
                </tr>
              </thead>
              <tbody>
                {read.data.refused.map((row) => (
                  <tr key={row.id} data-type={row.id}>
                    <th scope="row">{t(`refused_${row.id}` as const)}</th>
                    <td>
                      <code>{row.code}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}
