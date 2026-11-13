import { useEffect, useMemo, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { EmptyState, Failure, Loading } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { venueApi, type VenueKeptOrder } from '../venue-api';
import type { OrdersT } from './orders-copy';

/** The most pages of kept orders read per wallet; past it the list says only the first ones are read. */
export const ASSISTANT_ORDER_PAGES = 20;

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type State =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'failed'; failure: Refusal }
  | { status: 'ready'; rows: VenueKeptOrder[]; partial: number | null };

/** The assistant's orders among what the door kept: those whose origin names an agent key, newest first. */
export function assistantOrders(kept: readonly VenueKeptOrder[]): VenueKeptOrder[] {
  return kept.filter((o) => o.origin?.startsWith('agent:')).reverse();
}

const VENUE_STATUS: Record<
  string,
  'venuePending' | 'venueOpen' | 'venuePartlyFilled' | 'venueFilled' | 'venueCanceled' | 'venueRejected' | 'venueExpired'
> = {
  pending: 'venuePending',
  open: 'venueOpen',
  partially_filled: 'venuePartlyFilled',
  filled: 'venueFilled',
  canceled: 'venueCanceled',
  rejected: 'venueRejected',
  expired: 'venueExpired',
};

function statusWords(row: VenueKeptOrder, t: OrdersT): string {
  if (row.state === 'unknown') return t('keptUnknown');
  if (row.state === 'refused') return t('keptRefused');
  if (row.state === 'not_sent') return t('keptNotSent');
  const key = row.order ? VENUE_STATUS[row.order.status] : undefined;
  return key ? t(key) : (row.order?.status ?? t('keptUnknown'));
}

/**
 * Orders by your assistant, on `/trade/orders` (J-agents-21 #7): every order the person's own outside assistant placed
 * with its agent key on its agent account, read from the venue through the person's door and tagged "by your
 * assistant". Read only: nothing here signs, sends or cancels.
 */
export function AssistantOrders({ t, revision }: { t: OrdersT; revision: number }) {
  const { api, userId } = useSession();
  const venue = useMemo(() => venueApi(api), [api]);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async (): Promise<State> => {
      const accounts = await venue.agentAccounts(controller.signal);
      if (!accounts.ok) return accounts.code === 'trade.user_venue_off' ? { status: 'off' } : { status: 'failed', failure: accounts };
      const owners = [...new Set(accounts.data.accounts.map((a) => a.owner.toLowerCase()))];
      const kept: VenueKeptOrder[] = [];
      let partial: number | null = null;
      for (const owner of owners) {
        let cursor: string | undefined;
        for (let page = 0; ; page += 1) {
          if (page === ASSISTANT_ORDER_PAGES) {
            partial = kept.length;
            break;
          }
          const read = await venue.keptOrders(owner, cursor, controller.signal);
          if (!read.ok) return { status: 'failed', failure: read };
          kept.push(...read.data.orders);
          if (!read.data.nextCursor) break;
          cursor = read.data.nextCursor;
        }
      }
      return { status: 'ready', rows: assistantOrders(kept), partial };
    })().then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [venue, userId, revision]);

  return (
    <section data-testid="assistant-orders" aria-labelledby="assistant-orders-title" className="orders-assistant">
      <h3 id="assistant-orders-title">{t('assistantTitle')}</h3>
      <p className="muted orders-note">{t('assistantLead')}</p>
      {state.status === 'loading' ? <Loading label={t('assistantLoading')} /> : null}
      {state.status === 'off' ? <p className="muted orders-note">{t('assistantOff')}</p> : null}
      {state.status === 'failed' ? <Failure result={state.failure} /> : null}
      {state.status === 'ready' && state.rows.length === 0 ? <EmptyState title={t('assistantNone')} /> : null}
      {state.status === 'ready' && state.rows.length > 0 ? (
        <div className="orders-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('colMarket')}</th>
                <th scope="col">{t('colSide')}</th>
                <th scope="col">{t('colAmount')}</th>
                <th scope="col">{t('colFilled')}</th>
                <th scope="col">{t('colAvgPrice')}</th>
                <th scope="col">{t('colStatus')}</th>
                <th scope="col">{t('colPlacedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.actionKey} data-venue-client-order-id={row.venueClientOrderId ?? ''} data-action-key={row.actionKey}>
                  <td>{row.order?.symbol ?? t('notKnown')}</td>
                  <td>{row.order ? (row.order.side === 'buy' ? t('sideBuy') : t('sideSell')) : t('notKnown')}</td>
                  <td className="numeric">{row.order ? displayAmount(row.order.amount) : t('notKnown')}</td>
                  <td className="numeric">{row.order ? displayAmount(row.order.filled) : t('notKnown')}</td>
                  <td className="numeric">{row.order?.averagePrice ? displayAmount(row.order.averagePrice) : t('notKnown')}</td>
                  <td data-order-status={row.order?.status ?? row.state}>{statusWords(row, t)}</td>
                  <td>
                    <span className="pill" data-placed-by="assistant">
                      {t('byAssistant')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {state.status === 'ready' && state.partial !== null ? (
        <p className="muted orders-note">{t('assistantMore', { count: String(state.partial) })}</p>
      ) : null}
    </section>
  );
}
