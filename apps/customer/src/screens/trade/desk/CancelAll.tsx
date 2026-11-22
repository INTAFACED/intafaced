import { useRef, useState } from 'react';
import { useDataEnv } from '../../../data/hooks';
import { isTerminalOrder, type Order } from '../../../features/trade/trade-api';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';

/** A note's classes by its tone. */
const NOTE = { good: 'lt-note lt-note-good', bad: 'lt-note lt-note-bad' } as const;

/**
 * Cancel every open order in the market on screen. One DELETE per confirm; a doubtful answer is never retried: the person
 * is sent to Open orders, which stays the record. Other markets' orders are untouched.
 */
export function CancelAll({ symbol, orders, onDone }: { symbol: string; orders: readonly Order[]; onDone: () => void }) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const api = useDeskApi();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [finished, setFinished] = useState(false);
  const here = orders.filter((order) => order.symbol === symbol && !isTerminalOrder(order));
  if (here.length === 0 && !open) return null;

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const expected = here.length;
    env.poller.recordExternalRequest();
    const result = await api.cancelAll(symbol);
    if (result.ok) {
      const done = result.data.filter((order) => order.symbol === symbol && isTerminalOrder(order)).length;
      // The service cancels one by one: if fewer came back than were open, say so rather than "all".
      setNote(
        done >= expected
          ? { tone: 'good', text: t('Cancel all done', { count: done }) }
          : { tone: 'bad', text: t('Cancel all partial', { count: done, left: expected - done }) },
      );
    } else {
      // Some orders may already be cancelled when a later one fails, so a refusal never says "nothing was cancelled".
      setNote({ tone: 'bad', text: t('Cancel all uncertain') });
    }
    setFinished(true);
    busyRef.current = false;
    setBusy(false);
    onDone();
  }
  function close() {
    if (busyRef.current) return;
    setOpen(false);
    setNote(null);
    setFinished(false);
  }
  return (
    <>
      <Button tone="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('Cancel all', { count: here.length })}
      </Button>
      {open ? (
        <Sheet
          open
          role="alertdialog"
          title={t('Cancel all title', { pair: symbol })}
          description={t('Cancel all intro', { count: here.length, pair: symbol })}
          onClose={close}
        >
          {note ? (
            <p
              data-testid={note.tone === 'good' ? undefined : 'dk-note--bad'}
              className={NOTE[note.tone]}
              role={note.tone === 'good' ? 'status' : 'alert'}
            >
              {note.text}
            </p>
          ) : null}
          <div className="lt-actions">
            <Button tone="secondary" size="md" disabled={busy} onClick={close}>
              {finished ? t('Edit close') : t('Keep orders')}
            </Button>
            {finished ? null : (
              <Button loading={busy} tone="primary" size="md" onClick={() => void confirm()}>
                {t('Cancel all confirm')}
              </Button>
            )}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
