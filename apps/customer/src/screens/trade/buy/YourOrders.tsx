import { useMemo, useRef, useState } from 'react';
import './buy.css';
import { ORDERS_HREF } from './BuyCard';
import { buyCopy } from './copy';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  createTradeApi,
  defaultPoller,
  fmtAmount,
  refusalCopy,
  StateBlock,
  StatusChip,
  Table,
  useClosedOrders,
  useOpenOrders,
  useSession,
  type Loadable,
  type Order,
  type TableColumn,
  type TradeApi,
} from './deps';
import { baseOf, canCancel, pickRows, statusWord, type OrderStatusWord } from './orders-view';
import { plainRefusal } from './quote-flow';
import { recheckCancel } from './cancel-recheck';
import { usePendingNote } from './order-flow';
import { clearPending, runGuarded, type Pending } from './write-lock';

/** The orders read is polled every 10 s; older than this it reads Stale. */
const ORDERS_STALE_AFTER_MS = 30_000;

type Notice = { text: string; tone: 'ok' | 'warn'; recheck?: { order: Order; pendingId: string } };

/** "Your orders" beside the card (spec R2 item 3): the same /orders reads the desk uses. Signed out: nothing. */
export function YourOrders() {
  const { session } = useSession();
  return session ? <OrdersPanel /> : null;
}

function readyData(read: Loadable<Order[]>): Order[] {
  return read.status === 'ready' ? read.data : [];
}

function OrdersPanel() {
  const { t } = buyCopy.useCopy();
  const { api, userId } = useSession();
  const tradeApi: TradeApi = useMemo(() => createTradeApi(api), [api]);
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const [confirming, setConfirming] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const sending = useRef(false);
  const note = usePendingNote(userId);
  const lostCancel = note.state === 'pending' && note.pending.kind === 'cancel' ? note.pending : null;
  const [lostText, setLostText] = useState<string | null>(null);

  const reads = [open, closed];
  const refused = reads.find((read) => read.status === 'refused');
  const failed = reads.find((read) => read.status === 'error');
  const loading = reads.some((read) => read.status === 'loading');
  const status: 'ready' | 'loading' | 'error' = failed || refused ? 'error' : loading ? 'loading' : 'ready';
  const rows = useMemo(() => pickRows(readyData(open), readyData(closed)), [open, closed]);
  const stamps = reads.flatMap((read) => (read.status === 'ready' ? [read.asOf] : []));
  const asOf = stamps.length === reads.length ? Math.min(...stamps) : null;

  const refreshReads = () => {
    if (!userId) return;
    defaultPoller().refresh(`desk-open:${userId}`);
    defaultPoller().refresh(`desk-closed:${userId}`);
    defaultPoller().refresh(`balance:${userId}`);
  };
  const retry = () => {
    if (failed?.status === 'error') failed.retry();
    refreshReads();
  };

  const blockedText = (reason: string) =>
    reason === 'otherTab'
      ? t('Other tab')
      : reason === 'signedOut'
        ? t('Sign in again')
        : reason === 'pending'
          ? t('Earlier order body')
          : t('No safe storage');

  async function confirmCancel(order: Order) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice(null);
    const pending: Pending = { kind: 'cancel', symbol: order.symbol, id: `cancel:${order.id}`, orderId: order.id, startedAt: Date.now() };
    const unknown: Notice = { text: t('Cancel not confirmed'), tone: 'warn', recheck: { order, pendingId: pending.id } };
    try {
      // Sent once, never retried: an unknown outcome keeps the device note and waits for a customer-pressed check.
      const guarded = await runGuarded(
        userId,
        pending,
        () => tradeApi.cancel({ id: order.id, symbol: order.symbol }),
        (result) => !result.ok && result.reason === 'uncertain',
      );
      setConfirming(null);
      if (guarded.kind === 'blocked') setNotice({ text: blockedText(guarded.reason), tone: 'warn' });
      else if (guarded.kind === 'threw') setNotice(unknown);
      else if (guarded.value.ok) setNotice({ text: t('Order cancelled'), tone: 'ok' });
      else if (guarded.value.reason === 'uncertain') setNotice(unknown);
      else {
        const copy = plainRefusal(guarded.value, {});
        setNotice({ text: `${copy.title}. ${copy.body}`.trim(), tone: 'warn' });
      }
    } finally {
      sending.current = false;
      setBusy(false);
      refreshReads();
    }
  }

  async function checkAgain(target: { order: Order; pendingId: string }) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      refreshReads();
      // A read, never a second cancel.
      const result = await tradeApi.order({ id: target.order.id, symbol: target.order.symbol });
      if (!result.ok) {
        setNotice({ text: t('Cancel not confirmed'), tone: 'warn', recheck: target });
        return;
      }
      if (result.data.recoveryRequired) {
        setNotice({ text: t('Still being checked'), tone: 'warn', recheck: target });
        return;
      }
      if (userId) clearPending(userId, target.pendingId);
      setNotice(result.data.status === 'open' ? { text: t('Still open'), tone: 'warn' } : { text: t('Order cancelled'), tone: 'ok' });
    } catch {
      setNotice({ text: t('Cancel not confirmed'), tone: 'warn', recheck: target });
    } finally {
      sending.current = false;
      setBusy(false);
      refreshReads();
    }
  }

  async function checkLostCancel(pending: Pending) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setLostText(null);
    try {
      // A read, never a second cancel.
      const result = await recheckCancel(tradeApi, userId, pending);
      if (result.kind === 'unknown') setLostText(t('Cancel not confirmed'));
      else if (result.kind === 'checking') setLostText(t('Still being checked'));
      else setNotice(result.kind === 'open' ? { text: t('Still open'), tone: 'warn' } : { text: t('Order cancelled'), tone: 'ok' });
    } finally {
      sending.current = false;
      setBusy(false);
      refreshReads();
    }
  }

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    [],
  );
  const words: Record<OrderStatusWord, string> = {
    open: t('Status open'),
    partly: t('Status partly'),
    filled: t('Status filled'),
    cancelled: t('Status cancelled'),
    rejected: t('Status rejected'),
    expired: t('Status expired'),
    checking: t('Status checking'),
  };
  const sideWord = (order: Order) => (order.side === 'sell' ? t('Sell') : t('Buy'));

  const columns: TableColumn<Order>[] = [
    { id: 'time', header: t('Time'), cell: (order) => timeFormat.format(order.timestamp), width: 130 },
    { id: 'market', header: t('Market'), value: (order) => order.symbol },
    {
      id: 'side',
      header: t('Side'),
      cell: (order) => (
        <Badge density="dense" tone={order.side === 'sell' ? 'down' : 'up'}>
          {sideWord(order)}
        </Badge>
      ),
      width: 80,
    },
    {
      id: 'amount',
      header: t('Amount'),
      numeric: true,
      cell: (order) => `${fmtAmount(order.amount, { places: 8 })} ${baseOf(order.symbol)}`,
    },
    { id: 'filled', header: t('Filled'), numeric: true, cell: (order) => fmtAmount(order.filled, { places: 8 }) },
    {
      id: 'status',
      header: t('Status'),
      cell: (order) => {
        const word = statusWord(order);
        if (word === null) return null;
        const reason = order.recoveryRequired ? order.recoveryReason : null;
        return (
          <Badge
            density="dense"
            tone={word === 'checking' || word === 'rejected' ? 'warn' : word === 'open' || word === 'partly' ? 'lime' : 'neutral'}
            title={reason ?? undefined}
          >
            {words[word]}
          </Badge>
        );
      },
      width: 140,
    },
    {
      id: 'action',
      header: '',
      headerLabel: t('Cancel order'),
      align: 'end',
      width: 100,
      cell: (order) =>
        canCancel(order) ? (
          <Button
            variant="secondary"
            size={28}
            disabled={busy}
            aria-label={t('Cancel order for {market}', { market: order.symbol, side: sideWord(order).toLowerCase() })}
            onClick={() => setConfirming(order)}
          >
            {t('Cancel')}
          </Button>
        ) : undefined,
    },
  ];

  const checking = rows.filter((order) => order.recoveryRequired && order.recoveryReason);
  const errorState =
    refused?.status === 'refused' ? (
      (() => {
        const copy = refusalCopy(refused.code);
        return <StateBlock kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />;
      })()
    ) : (
      <StateBlock kind="error" title={t('Couldn’t load orders')} onRetry={retry} retryLabel={t('Retry')} />
    );

  return (
    <section className="buy-orders" aria-label={t('Your orders')} data-testid="your-orders">
      <header className="buy-orders__head">
        <div>
          <h2>{t('Your orders')}</h2>
          <p>{t('Your orders hint')}</p>
        </div>
        <StatusChip
          density="dense"
          data-testid="orders-freshness"
          asOf={asOf}
          staleAfterMs={ORDERS_STALE_AFTER_MS}
          refused={refused !== undefined}
        />
        <Button variant="ghost" size={32} nativeButton={false} render={<a href={ORDERS_HREF} />}>
          {t('Open in Activity')}
        </Button>
      </header>
      {lostCancel && !notice?.recheck ? (
        <div className="buy-orders__notice" role="status" data-tone="warn" data-testid="orders-lost-cancel">
          <span>{lostText ?? t('Cancel not confirmed')}</span>
          <Button variant="secondary" size={28} loading={busy} onClick={() => checkLostCancel(lostCancel)}>
            {t('Check again')}
          </Button>
        </div>
      ) : null}
      {notice ? (
        <div className="buy-orders__notice" role="status" data-tone={notice.tone} data-testid="orders-notice">
          <span>{notice.text}</span>
          {notice.recheck ? (
            <Button variant="secondary" size={28} loading={busy} onClick={() => checkAgain(notice.recheck!)}>
              {t('Check again')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Table
        label={t('Your orders')}
        density="dense"
        columns={columns}
        rows={status === 'ready' ? rows : []}
        getRowId={(order) => order.id}
        status={status}
        loadingRows={4}
        errorState={errorState}
        onRetry={retry}
        emptyState={<StateBlock kind="empty" title={t('Orders empty title')} body={t('Orders empty body')} />}
        onRowActivate={() => window.location.assign(ORDERS_HREF)}
        minWidth={640}
      />
      {checking.length > 0 ? (
        <ul className="buy-orders__reasons">
          {checking.map((order) => (
            <li key={order.id}>
              {order.symbol}: {order.recoveryReason}
            </li>
          ))}
        </ul>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirming(null);
        }}
      >
        <AlertDialogContent className="buy-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Cancel this order title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? t('Cancel this order body', {
                    side: sideWord(confirming),
                    amount: fmtAmount(confirming.remaining, { places: 8 }),
                    coin: baseOf(confirming.symbol),
                  })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="secondary" size={40} />} disabled={busy}>
              {t('Keep order')}
            </AlertDialogClose>
            <Button variant="sell" size={40} loading={busy} onClick={() => confirming && confirmCancel(confirming)}>
              {busy ? t('Cancelling') : t('Cancel order')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
