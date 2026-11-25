import { DocPage } from '../DocPage';
import { ReadFailed, ReadLoading } from '../ReadState';
import { spotOrderTypesSchema } from '@intafaced/contracts/spot-order-types';
import { useSession } from '../../session';
import { venueCopy } from '../../trade';
import { deskCopy } from '../../../screens/trade/desk/copy';
import { useRead } from '../use-read';
import { acceptedCells, refusedName } from './order-types-view';
import { tradingApiCopy } from './trading-api-copy';

/**
 * /developers/order-types (J-cex-spot-15 #4): the spot order types the API accepts, read from svc-trade's
 * GET /api/v1/order-types (`SPOT_ORDER_TYPES_PATH`; the client adds the /api/v1 base) and named as the trading ticket
 * names its tabs. When the venue door is on, svc-trade derives the list from the venue's spot market capabilities so it
 * matches `VenueSpotDesk` and `VenueOrderOptions`. Each type shows one whole example body; a listed type refused by the
 * door is shown with its code.
 */
export function OrderTypesPage({ title }: { title: string }) {
  const { t } = tradingApiCopy.useCopy();
  const desk = deskCopy.useCopy();
  const venue = venueCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => api.rest('/order-types', spotOrderTypesSchema, { signal }), [api]);
  const lead =
    read.status === 'ready' && read.data.source === 'venue' && read.data.symbol
      ? t('typesLeadVenue', { symbol: read.data.symbol })
      : t('typesLead');
  return (
    <DocPage id="order-types" title={title} lead={lead} back={t('back')}>
      {read.status === 'loading' ? (
        <ReadLoading rows={7} label={t('loading')} />
      ) : read.status === 'failed' ? (
        <ReadFailed title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <>
          <section aria-labelledby="dev-order-types">
            <h2 id="dev-order-types">{t('typesTitle')}</h2>
            <div>
              <table className="lt-table" data-testid="order-types-accepted">
                <thead>
                  <tr>
                    <th scope="col">{t('colType')}</th>
                    <th scope="col">{t('colBodyType')}</th>
                    <th scope="col">{t('colFields')}</th>
                    <th scope="col">{t('colTif')}</th>
                    <th scope="col">{t('colNote')}</th>
                    <th scope="col">{t('colExample')}</th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.accepted.map((row) => {
                    const cells = acceptedCells(row, t, desk.t, read.data.source);
                    return (
                      <tr key={row.id} data-type={row.id}>
                        <th scope="row">{cells.name}</th>
                        <td>
                          <code>{cells.bodyType}</code>
                        </td>
                        <td>{cells.fields ? <code>{cells.fields}</code> : t('noFields')}</td>
                        <td>{cells.timeInForce}</td>
                        <td>{cells.note}</td>
                        <td>
                          <pre className="lt-code">
                            <code>{cells.example}</code>
                          </pre>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-labelledby="dev-order-types-refused">
            <h2 id="dev-order-types-refused">{t('refusedTitle')}</h2>
            <p className="lt-hint">{read.data.source === 'venue' ? t('refusedLeadVenue') : t('refusedLead')}</p>
            <table className="lt-table" data-testid="order-types-refused">
              <thead>
                <tr>
                  <th scope="col">{t('colType')}</th>
                  <th scope="col">{t('colCode')}</th>
                </tr>
              </thead>
              <tbody>
                {read.data.refused.map((row) => (
                  <tr key={row.id} data-type={row.id}>
                    <th scope="row">{refusedName(row, desk.t, read.data.source, venue.t)}</th>
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
    </DocPage>
  );
}
