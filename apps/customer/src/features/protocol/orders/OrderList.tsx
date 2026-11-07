import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DexOrderHistory, DexOrderState, DexOrderView } from '@intafaced/contracts/protocol-dex-orders';
import { Button, DataTable, Dialog, EmptyState, Field, Panel } from '../../../shared/ui';
import { useWallet } from '../wallet/WalletProvider';
import type { OrdersTranslate } from './copy';
import type { OrdersContext } from './OrdersRoom';
import { refusalWords } from './OrdersRoom';

/** How often the open list reads again: fills, a trailing trigger and the keeper's log change without a click. */
const POLL_MS = 1_000;
const FILTERS: readonly {
  value: DexOrderState | '';
  key: 'filterAll' | 'filterOpen' | 'filterFilled' | 'filterExpired' | 'filterCancelled';
}[] = [
  { value: '', key: 'filterAll' },
  { value: 'open', key: 'filterOpen' },
  { value: 'filled', key: 'filterFilled' },
  { value: 'expired', key: 'filterExpired' },
  { value: 'cancelled', key: 'filterCancelled' },
];

/**
 * The person's orders (D-limit-dca-04): filtered by state and paged at 100, each with its history, Edit (a new
 * signature under the same order and a higher version) and Cancel (recorded at once, then the wallet's cancel call).
 */
export function OrderList({ ctx }: { ctx: OrdersContext }) {
  const { api, address, session, t, revision } = ctx;
  const [count, setCount] = useState<number | null>(null);
  const [state, setState] = useState<DexOrderState | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [page, setPage] = useState<{ orders: DexOrderView[]; total: number; pageSize: number; next: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // What happened to an edit or cancel after its dialog closed for the wallet; kept until the next one.
  const [outcome, setOutcome] = useState<string | null>(null);
  const [history, setHistory] = useState<DexOrderView | null>(null);
  const [editing, setEditing] = useState<DexOrderView | null>(null);
  const [cancelling, setCancelling] = useState<DexOrderView | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const counted = await api.count(address);
      if (!live) return;
      if (counted.ok) setCount(counted.data.count);
      if (!session) return;
      const listed = await api.list(session.accessToken, { ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) });
      if (!live) return;
      if (listed.ok) {
        setPage(listed.data);
        setProblem(null);
      } else setProblem(refusalWords(t, listed));
    })();
    return () => {
      live = false;
    };
  }, [api, address, session, state, cursor, revision, tick, t]);

  const headers = [t('hdrId'), t('hdrType'), t('hdrSide'), t('hdrAmount'), t('hdrTrigger'), t('hdrState'), t('rowFilled'), t('hdrActions')];
  const pages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const current = cursor && page ? Math.floor(Number(cursor) / page.pageSize) + 1 : 1;
  return (
    <Panel title={t('listTitle')}>
      <label className="field">
        <span>{t('listFilter')}</span>
        <select
          aria-label={t('listFilter')}
          value={state}
          onChange={(e) => {
            setState(e.target.value as DexOrderState | '');
            setCursor(undefined);
          }}
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.value}>
              {t(f.key)}
            </option>
          ))}
        </select>
      </label>
      <DataTable label={t('listTitle')} headers={headers}>
        {page && page.orders.length > 0 ? (
          page.orders.map((o) => (
            <OrderRow
              key={o.id}
              o={o}
              t={t}
              onHistory={() => setHistory(o)}
              onEdit={() => setEditing(o)}
              onCancel={() => setCancelling(o)}
            />
          ))
        ) : (
          <tr>
            <td colSpan={headers.length}>
              {problem ? (
                <p role="alert">{problem}</p>
              ) : count === 0 ? (
                <EmptyState title={t('listEmpty')} />
              ) : !session && count !== null ? (
                <EmptyState title={t('listNeedsSession')} />
              ) : page ? (
                <EmptyState title={t('historyNone')} />
              ) : null}
            </td>
          </tr>
        )}
      </DataTable>
      <nav aria-label={t('pages')} className="actions">
        <span>{t('pageInfo', { size: String(page?.pageSize ?? 100), page: String(current), pages: String(pages) })}</span>
        <Button
          variant="ghost"
          disabled={!cursor}
          onClick={() => setCursor(current > 2 ? String((current - 2) * (page?.pageSize ?? 100)) : undefined)}
        >
          {t('pagePrev')}
        </Button>
        <Button variant="ghost" disabled={!page?.next} onClick={() => setCursor(page?.next ?? undefined)}>
          {t('pageNext')}
        </Button>
      </nav>
      {history && session && <HistoryDialog ctx={ctx} order={history} accessToken={session.accessToken} onClose={() => setHistory(null)} />}
      {outcome && <p role="alert">{outcome}</p>}
      {editing && <EditDialog ctx={ctx} order={editing} onClose={() => setEditing(null)} onOutcome={setOutcome} />}
      {cancelling && <CancelDialog ctx={ctx} order={cancelling} onClose={() => setCancelling(null)} onOutcome={setOutcome} />}
    </Panel>
  );
}

function OrderRow({
  o,
  t,
  onHistory,
  onEdit,
  onCancel,
}: {
  o: DexOrderView;
  t: OrdersTranslate;
  onHistory: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const trailing = o.trailPercent !== null;
  return (
    <tr>
      <td>
        <span className="numeric" data-testid="order-id" title={o.id}>
          {o.id.slice(0, 10)}
        </span>
      </td>
      <td>{o.kindName}</td>
      <td>{t(`side_${o.side}`)}</td>
      <td className="numeric">{t('rowAmount', { amount: o.amount, symbol: o.baseSymbol })}</td>
      <td className="numeric">
        <span data-testid="order-trigger">{o.trigger ?? '—'}</span>
        {trailing && (
          <>
            <br />
            <span data-testid="order-mark">{t('rowMark', { price: o.mark ?? '—' })}</span> ·{' '}
            {t('rowDistance', { percent: o.trailPercent! })}
          </>
        )}
        <br />
        <small>{t('rowMinOut', { amount: o.minOut, symbol: o.minOutSymbol })}</small>
      </td>
      <td>{o.stateName}</td>
      <td className="numeric">
        {t('rowFilled')} <span data-testid="order-filled">{o.filled}</span> {t('rowOf', { amount: o.amount })}
        {o.state !== 'filled' && o.state !== 'cancelled' && o.state !== 'cancelled_by_link' && o.state !== 'expired' && (
          <>
            {' · '}
            {t('rowOpen', { amount: o.open })}
          </>
        )}
        {o.cover !== null && (
          <>
            <br />
            <span data-testid="bracket-cover">{t('rowCover', { filled: o.cover, amount: o.amount })}</span>
          </>
        )}
        <br />
        <small data-testid="order-version">v{o.version}</small>
      </td>
      <td>
        <div className="actions">
          <Button variant="ghost" onClick={onHistory}>
            {t('rowHistory')}
          </Button>
          <Button variant="ghost" onClick={onEdit} disabled={!o.editable}>
            {t('rowEdit')}
          </Button>
          {o.cancellable && (
            <Button variant="ghost" onClick={onCancel}>
              {t('rowCancel')}
            </Button>
          )}
        </div>
        {o.state === 'filled' && <small>{t('rowNotEditable')}</small>}
      </td>
    </tr>
  );
}

function eventWords(t: OrdersTranslate, e: DexOrderHistory['events'][number], o: DexOrderView): string {
  switch (e.type) {
    case 'created':
      return t('ev_created', { trigger: e.trigger ? t('ev_trigger', { trigger: e.trigger }) : '', version: String(e.version ?? 1) });
    case 'fill': {
      const inSym = o.side === 'sell' ? o.baseSymbol : o.quoteSymbol;
      const outSym = o.side === 'sell' ? o.quoteSymbol : o.baseSymbol;
      return t('ev_fill', {
        amountIn: `${e.amountIn} ${inSym}`,
        amountOut: `${e.amountOut} ${outSym}`,
        price: e.price ?? '—',
        label: e.label ?? '',
        minOut: `${e.minOut} ${outSym}`,
      });
    }
    case 'edit':
      return t('ev_edit', { trigger: e.trigger ?? '—', version: String(e.version ?? 1) });
    case 'cancel':
    case 'cancel_refused_fill':
    case 'expired':
    case 'cancelled_by_link':
    case 'activated':
      return t(`ev_${e.type}`);
    default:
      return e.type;
  }
}

function attemptWords(t: OrdersTranslate, a: DexOrderHistory['attempts'][number]): string {
  const facts = { trigger: a.trigger ?? '—', price: a.price ?? '—', version: String(a.version) };
  switch (a.reason) {
    case 'checked':
      return t('at_checked', facts);
    case 'predicate_false':
      return t('at_predicate_false', facts);
    case 'oracle_stale':
      return t('at_oracle_stale');
    case 'oracle_disagree':
      return t('at_oracle_disagree');
    case 'insufficient_liquidity':
      return t('at_insufficient_liquidity');
    case 'insufficient_credit':
      return t('at_insufficient_credit');
    case 'reverted':
      return t('at_reverted');
    case 'rail.crypto':
      return t('at_rail_crypto');
    default:
      return t('at_other', { reason: a.reason });
  }
}

function HistoryDialog({
  ctx,
  order,
  accessToken,
  onClose,
}: {
  ctx: OrdersContext;
  order: DexOrderView;
  accessToken: string;
  onClose: () => void;
}) {
  const { api, t } = ctx;
  const [h, setH] = useState<DexOrderHistory | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void api.history(accessToken, order.id).then((r) => {
        if (!live) return;
        if (r.ok) setH(r.data);
        else setProblem(refusalWords(t, r));
      });
    read();
    // The keeper's log keeps moving while the dialog is open.
    const timer = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, accessToken, order.id, t]);
  return (
    <Dialog title={t('historyTitle')} onClose={onClose}>
      {problem && <p role="alert">{problem}</p>}
      {h && (
        <>
          <ol>
            {h.events.map((e, i) => (
              <li key={i}>
                <time dateTime={e.at}>{e.at.slice(11, 19)}</time> {eventWords(t, e, order)}
              </li>
            ))}
          </ol>
          <h3>{t('historyAttempts')}</h3>
          <ul aria-label={t('historyAttempts')}>
            {h.attempts.length === 0 ? <li>{t('historyNone')}</li> : h.attempts.map((a, i) => <li key={i}>{attemptWords(t, a)}</li>)}
          </ul>
        </>
      )}
    </Dialog>
  );
}

interface DialogProps {
  ctx: OrdersContext;
  order: DexOrderView;
  onClose: () => void;
  /** Words for what went wrong after the dialog closed, or null when all went through. */
  onOutcome: (words: string | null) => void;
}

function EditDialog({ ctx, order, onClose, onOutcome }: DialogProps) {
  const { api, session, t, gated, send, changed } = ctx;
  const wallet = useWallet();
  const sign = useRef(wallet.sign);
  sign.current = wallet.sign;
  const [trigger, setTrigger] = useState(order.trigger ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!session) return setProblem(t('needSession'));
      const prepared = await api.prepareEdit(session.accessToken, order.id, trigger.trim());
      if (!prepared.ok) return setProblem(refusalWords(t, prepared));
      // The wallet's sheet opens outside this dialog: close it first so nothing under it is inert.
      onClose();
      onOutcome(null);
      const gate = await gated(async () => {
        const signed = await sign.current({ kind: 'typedData', typedData: prepared.data.typedData as never });
        if (signed.status === 'rejected') return onOutcome(t('walletRejected'));
        if (signed.status !== 'signed') return onOutcome(t('walletFailed', { message: signed.status === 'failed' ? signed.message : '' }));
        // The new version is stored first; only then is the old one retired on chain. A refused update retires nothing,
        // so the order never ends with no signature that can fill.
        const updated = await api.update(session.accessToken, prepared.data.draftId, signed.signature);
        if (!updated.ok) return onOutcome(refusalWords(t, updated));
        if (prepared.data.call) {
          const failed = await send({
            title: t('editReplace'),
            steps: [
              {
                label: prepared.data.call.label,
                request: { kind: 'transaction', to: prepared.data.call.to, data: prepared.data.call.data },
              },
            ],
          });
          if (failed) return onOutcome(t('editReplaceFailed', { words: failed }));
        }
      });
      if (gate) onOutcome(gate);
      changed();
    },
    [api, session, order.id, trigger, t, gated, send, changed, onClose, onOutcome],
  );
  return (
    <Dialog title={t('editTitle')} onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        <Field
          label={t('editTrigger', { quote: order.quoteSymbol, base: order.baseSymbol })}
          inputMode="decimal"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        />
        <Button type="submit">{t('editSave')}</Button>
        {problem && <p role="alert">{problem}</p>}
      </form>
    </Dialog>
  );
}

function CancelDialog({ ctx, order, onClose, onOutcome }: DialogProps) {
  const { api, session, t, gated, send, changed } = ctx;
  const [problem, setProblem] = useState<string | null>(null);
  const confirm = async () => {
    if (!session) return setProblem(t('needSession'));
    const cancelled = await api.cancel(session.accessToken, order.id);
    if (!cancelled.ok) return setProblem(refusalWords(t, cancelled));
    // Recorded: the keeper stops at once. The on-chain cancel follows from the wallet, outside this dialog.
    onClose();
    onOutcome(null);
    changed();
    const gate = await gated(async () => {
      const failed = await send({
        title: t('cancelSteps'),
        steps: cancelled.data.calls.map((c) => ({ label: c.label, request: { kind: 'transaction', to: c.to, data: c.data } })),
      });
      if (failed) onOutcome(t('cancelChainFailed', { words: failed }));
    });
    if (gate) onOutcome(t('cancelChainFailed', { words: gate }));
    changed();
  };
  return (
    <Dialog title={t('cancelTitle')} onClose={onClose}>
      <p>{t('cancelCopy')}</p>
      <Button variant="danger" onClick={() => void confirm()}>
        {t('cancelConfirm')}
      </Button>
      {problem && <p role="alert">{problem}</p>}
    </Dialog>
  );
}
