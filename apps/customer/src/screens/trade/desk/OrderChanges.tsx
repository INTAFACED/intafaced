import { useEffect, useRef, useState } from 'react';
import { Fold } from '@intafaced/ui/lit';
import { useDataEnv } from '../../../data/hooks';
import type { OrderChange } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { fmtAmount, fmtPrice } from '../../../data';
import { changeLine, latestOnly } from './order-changes';
import { dayTime } from './time';

type State = { status: 'idle' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: OrderChange[] };

/**
 * What was changed on one order, read when the person opens it (the kit's `Fold`, the page's own disclosure, so it opens in place). An
 * unchanged order says so; a failed read says so.
 */
export function OrderChanges({ orderId, tick }: { orderId: string; tick?: string }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const env = useDataEnv();
  const api = useDeskApi();
  const [state, setState] = useState<State>({ status: 'idle' });

  const reads = useRef(latestOnly()).current;
  useEffect(() => reads.cancel, [reads]);

  async function load(open: boolean) {
    if (!open) {
      reads.cancel();
      return;
    }
    const ticket = reads.next();
    setState({ status: 'loading' });
    env.poller.recordExternalRequest();
    const result = await api.changes(orderId);
    if (!reads.isCurrent(ticket)) return;
    setState(result.ok ? { status: 'ready', rows: result.data } : { status: 'failed' });
  }

  const lines = state.status === 'ready' ? state.rows.flatMap((row) => changeLine(row) ?? []) : [];
  const unreadable = state.status === 'ready' ? state.rows.length - lines.length : 0;
  return (
    <Fold title={t('Order changes open')} onOpenChange={(open) => void load(open)}>
      <div className="lt-stack">
        <p className="lt-hint">{t('Order changes title')}</p>
        {state.status === 'loading' ? <p className="lt-hint">{t('Order changes loading')}</p> : null}
        {state.status === 'failed' ? <p className="lt-hint">{t('Order changes failed')}</p> : null}
        {state.status === 'ready' && state.rows.length === 0 ? <p className="lt-hint">{t('Order changes none')}</p> : null}
        {lines.length > 0 ? (
          <ul className="lt-stack">
            {lines.map((line, index) => (
              <li key={`${line.at}:${index}`}>
                <span>{Number.isNaN(Date.parse(line.at)) ? '—' : dayTime(Date.parse(line.at), timeZone)}</span>{' '}
                {line.key === 'Order changes amend'
                  ? t(line.key, { amount: fmtAmount(line.amount, { places: 8 }), price: fmtPrice(line.price, tick) })
                  : t(line.key)}
              </li>
            ))}
          </ul>
        ) : null}
        {unreadable > 0 ? <p className="lt-hint">{t('Order changes unreadable')}</p> : null}
      </div>
    </Fold>
  );
}
