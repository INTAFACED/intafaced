import { useRef, useState } from 'react';
import { useDataEnv } from '../../../data/hooks';
import { BATCH_CANCEL_MAX, isTerminalOrder, type BatchCancel, type Order } from '../../../features/trade/trade-api';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  fmtAmount,
  refusalCopy,
} from './deps';

type Scope = 'selected' | 'spot' | 'everything';
type Outcome =
  | { kind: 'batch'; rows: Array<{ key: string; label: string; tone: 'good' | 'bad'; text: string }>; done: number; count: number }
  | { kind: 'all'; tone: 'good' | 'bad'; text: string };

const baseOf = (symbol: string): string => symbol.split('/')[0] ?? symbol;

/**
 * Cancel more than one market's orders: the ticked orders by id (one batch request, each id answered on its own line),
 * every spot order (other products stay open), or every order. Asked first; one request per confirm; a doubtful answer
 * is never retried, and Open orders stays the record.
 */
export function CancelMany({
  orders,
  selected,
  onDone,
}: {
  orders: readonly Order[];
  selected: ReadonlySet<string>;
  onDone: (cancelled: readonly string[]) => void;
}) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const api = useDeskApi();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('selected');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const live = orders.filter((order) => !isTerminalOrder(order));
  const chosen = live.filter((order) => selected.has(order.id));
  if (live.length === 0 && !open) return null;

  const label = (order: Order | undefined, id: string) =>
    order
      ? order.price === null
        ? t('Cancel batch row market', {
            side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
            amount: fmtAmount(order.amount, { places: 8 }),
            asset: baseOf(order.symbol),
            pair: order.symbol,
          })
        : t('Cancel batch row', {
            side: order.side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
            amount: fmtAmount(order.amount, { places: 8 }),
            asset: baseOf(order.symbol),
            price: fmtAmount(order.price, { places: 8 }),
            pair: order.symbol,
          })
      : t('Cancel batch row unknown', { id });

  function batchOutcome(data: BatchCancel): Outcome {
    const rows = data.results.map((row) => {
      const id = row.orderId ?? String(row.index);
      const name = label(
        chosen.find((order) => order.id === row.orderId),
        id,
      );
      if (row.status === 'success' && row.order && isTerminalOrder(row.order))
        return { key: id, label: name, tone: 'good' as const, text: t('Cancel batch cancelled') };
      if (row.status === 'refused') {
        const code = row.error?.intafacedCode ?? row.error?.code ?? '';
        return { key: id, label: name, tone: 'bad' as const, text: t('Cancel batch refused', { reason: refusalCopy(code).title }) };
      }
      return { key: id, label: name, tone: 'bad' as const, text: t('Cancel batch unknown') };
    });
    const done = rows.filter((row) => row.tone === 'good').length;
    return { kind: 'batch', rows, done, count: rows.length };
  }

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    env.poller.recordExternalRequest();
    let cancelled: string[] = [];
    try {
      if (scope === 'selected') {
        const result = await api.cancelBatch(chosen.map((order) => order.id));
        if (result.ok) {
          setOutcome(batchOutcome(result.data));
          cancelled = result.data.results.filter((row) => row.status === 'success' && row.orderId).map((row) => row.orderId as string);
        } else if (result.code === 'trade.batch_too_large') {
          setOutcome({ kind: 'all', tone: 'bad', text: t('Cancel batch too many', { max: BATCH_CANCEL_MAX }) });
        } else {
          setOutcome({ kind: 'all', tone: 'bad', text: t('Cancel all uncertain') });
        }
      } else {
        const result = scope === 'spot' ? await api.cancelAllSpot() : await api.cancelAllMarkets();
        if (result.ok) {
          const done = result.data.filter(isTerminalOrder);
          cancelled = done.map((order) => order.id);
          // An order the service returned that has not ended yet may still be open: say so, never "all cancelled".
          const left = result.data.length - done.length;
          setOutcome(
            left === 0
              ? { kind: 'all', tone: 'good', text: t('Cancel all done', { count: done.length }) }
              : { kind: 'all', tone: 'bad', text: t('Cancel all partial', { count: done.length, left }) },
          );
        } else {
          // Some orders may already be cancelled when a later one fails, so a refusal never says "nothing was cancelled".
          setOutcome({ kind: 'all', tone: 'bad', text: t('Cancel all uncertain') });
        }
      }
    } catch {
      setOutcome({ kind: 'all', tone: 'bad', text: t('Cancel all uncertain') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    onDone(cancelled);
  }
  function close() {
    if (busyRef.current) return;
    setOpen(false);
    setOutcome(null);
  }
  function start() {
    setScope(chosen.length > 0 && chosen.length <= BATCH_CANCEL_MAX ? 'selected' : 'spot');
    setOpen(true);
  }
  const canConfirm = scope !== 'selected' || (chosen.length > 0 && chosen.length <= BATCH_CANCEL_MAX);
  const option = (value: Scope, text: string, disabled = false, note?: string) => (
    <label className="dk-scope">
      <input
        type="radio"
        name="dk-cancel-scope"
        value={value}
        checked={scope === value}
        disabled={disabled || busy}
        onChange={() => setScope(value)}
      />
      <span>
        {text}
        {note ? <span className="dk-scope-note">{note}</span> : null}
      </span>
    </label>
  );
  return (
    <>
      <button type="button" className="dk-cancel-all" onClick={start}>
        {t('Cancel orders')}
      </button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        {open ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Cancel orders title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Cancel orders intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            {outcome ? null : (
              <fieldset className="dk-scopes" aria-label={t('Cancel orders title')}>
                {option(
                  'selected',
                  chosen.length > 0 ? t('Cancel scope selected', { count: chosen.length }) : t('Cancel scope selected none'),
                  chosen.length === 0 || chosen.length > BATCH_CANCEL_MAX,
                  chosen.length > BATCH_CANCEL_MAX ? t('Cancel batch too many', { max: BATCH_CANCEL_MAX }) : undefined,
                )}
                {option('spot', t('Cancel scope spot'), false, t('Cancel scope spot note'))}
                {option('everything', t('Cancel scope everything'))}
              </fieldset>
            )}
            {outcome?.kind === 'all' ? (
              <p
                data-testid={outcome.tone === 'good' ? undefined : 'dk-note--bad'}
                className={outcome.tone === 'good' ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
                role={outcome.tone === 'good' ? 'status' : 'alert'}
              >
                {outcome.text}
              </p>
            ) : null}
            {outcome?.kind === 'batch' ? (
              <div role="status">
                <p
                  data-testid={outcome.done === outcome.count ? undefined : 'dk-note--bad'}
                  className={outcome.done === outcome.count ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
                >
                  {t('Cancel batch summary', { done: outcome.done, count: outcome.count })}
                </p>
                <ul className="dk-batch">
                  {outcome.rows.map((row) => (
                    <li key={row.key} className={row.tone === 'good' ? 'dk-batch-good' : 'dk-batch-bad'}>
                      {row.label}: {row.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={busy} onClick={close}>
                {outcome ? t('Edit close') : t('Keep orders')}
              </Button>
              {outcome ? null : (
                <Button variant="primary" shape="pill" size={40} loading={busy} disabled={!canConfirm} onClick={() => void confirm()}>
                  {t('Cancel orders confirm')}
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}
