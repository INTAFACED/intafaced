import { useState } from 'react';
import { useDataEnv } from '../../../data/hooks';
import type { OrderChange } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { fmtAmount, fmtPrice, Popover, PopoverContent, PopoverTrigger } from './deps';
import { changeLine } from './order-changes';
import { dayTime } from './time';

type State = { status: 'idle' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: OrderChange[] };

/** What was changed on one order, read when the person opens it. An unchanged order says so; a failed read says so. */
export function OrderChanges({ orderId, tick }: { orderId: string; tick?: string }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const env = useDataEnv();
  const api = useDeskApi();
  const [state, setState] = useState<State>({ status: 'idle' });

  async function load(open: boolean) {
    if (!open) return;
    setState({ status: 'loading' });
    env.poller.recordExternalRequest();
    const result = await api.changes(orderId);
    setState(result.ok ? { status: 'ready', rows: result.data } : { status: 'failed' });
  }

  const lines = state.status === 'ready' ? state.rows.flatMap((row) => changeLine(row) ?? []) : [];
  return (
    <Popover onOpenChange={(open) => void load(open)}>
      <PopoverTrigger className="dk-changes-trigger">{t('Order changes open')}</PopoverTrigger>
      <PopoverContent align="end" className="dk-changes-pop">
        <p className="dk-changes-title">{t('Order changes title')}</p>
        {state.status === 'loading' ? <p className="dk-changes-note">{t('Order changes loading')}</p> : null}
        {state.status === 'failed' ? <p className="dk-changes-note">{t('Order changes failed')}</p> : null}
        {state.status === 'ready' && lines.length === 0 ? <p className="dk-changes-note">{t('Order changes none')}</p> : null}
        {lines.length > 0 ? (
          <ul className="dk-changes-list">
            {lines.map((line, index) => (
              <li key={`${line.at}:${index}`}>
                <span className="if-num">{dayTime(Date.parse(line.at), timeZone)}</span>{' '}
                {line.key === 'Order changes amend'
                  ? t(line.key, { amount: fmtAmount(line.amount, { places: 8 }), price: fmtPrice(line.price, tick) })
                  : t(line.key)}
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
