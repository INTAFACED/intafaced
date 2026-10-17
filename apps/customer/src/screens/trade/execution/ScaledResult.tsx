/**
 * What happened to a ladder: the service's answer per order in plain words, the book as read back by id prefix, and a
 * group cancel that is just one cancel per still-open order (the service has no ladder object, SCL-1).
 */
import { useState } from 'react';
import type { Order } from '../../../features/trade/trade-api';
import { Badge, Button, Table, fmtAmount, fmtPrice, type TableColumn } from '../rooms/ui';
import { roomWords } from '../rooms/refusals';
import type { RoomWriter } from '../rooms/write';
import { execCopy } from './copy';
import { useTradeApi, type ExecMarket } from './data';
import { findGroup, isLive } from './model';
import { ConfirmDialog, Why } from './parts';
import type { ScaledRun } from './ScaledForm';

type CancelResult = 'cancelled' | 'refused' | 'unknown' | 'notSent';

interface Line {
  index: number;
  price: string | null;
  size: string | null;
  clientOrderId: string;
  /** `found` / `absent` are an unconfirmed order after a status check: it was on the book, or it was not. */
  placed: 'success' | 'refused' | 'unknown' | 'found' | 'absent' | null;
  detail: string | null;
  code: string | null;
  order: Order | null;
}

export function ScaledResult({
  run,
  found,
  market,
  writer,
  onCheck,
  checking,
}: {
  run: ScaledRun | null;
  found: Order[] | null;
  market: ExecMarket | null;
  writer: RoomWriter;
  onCheck: () => void;
  checking: boolean;
}) {
  const { t } = execCopy.useCopy();
  const trade = useTradeApi();
  const [confirm, setConfirm] = useState(false);
  const [cancels, setCancels] = useState<Record<string, CancelResult>>({});

  const lines: Line[] = run
    ? findGroup(run.nonce, run.rows.length, [found ?? []]).map((g) => {
        const row = run.rows[g.index - 1]!;
        const item = run.results?.find((r) => r.clientOrderId === g.clientOrderId) ?? run.results?.[g.index - 1] ?? null;
        const words = item?.status === 'refused' ? roomWords({ code: item.error?.intafacedCode, message: item.error?.message }) : null;
        const placed: Line['placed'] =
          item?.status === 'unknown' && found !== null ? (g.order ? 'found' : 'absent') : (item?.status ?? null);
        return {
          index: g.index,
          price: row.price,
          size: row.size,
          clientOrderId: g.clientOrderId,
          placed,
          detail: words ? `${words.title}. ${words.body}` : null,
          code: words?.code ?? null,
          order: g.order,
        };
      })
    : (found ?? []).map((o, i) => ({
        index: i + 1,
        price: o.price,
        size: o.amount,
        clientOrderId: o.clientOrderId ?? o.id,
        placed: null,
        detail: null,
        code: null,
        order: o,
      }));
  if (!run && found === null) return null;

  const live = (found ?? []).filter(isLive);
  const summary = run?.results
    ? {
        placed: lines.filter((l) => l.placed === 'success' || l.placed === 'found').length,
        refused: lines.filter((l) => l.placed === 'refused').length,
        unknown: lines.filter((l) => l.placed === 'unknown').length,
        absent: lines.filter((l) => l.placed === 'absent').length,
      }
    : null;

  async function cancelAll() {
    const next: Record<string, CancelResult> = {};
    setCancels(next);
    let stopped = false;
    for (const order of live) {
      if (stopped) {
        next[order.id] = 'notSent';
      } else {
        const result = await writer.run({ kind: 'cancel', id: order.id, symbol: order.symbol, call: () => trade.cancel(order) });
        next[order.id] =
          result.kind === 'done'
            ? 'cancelled'
            : result.kind === 'refused'
              ? 'refused'
              : result.kind === 'uncertain'
                ? 'unknown'
                : 'notSent';
        stopped = result.kind === 'uncertain' || result.kind === 'blocked';
      }
      setCancels({ ...next });
    }
    setConfirm(false);
    onCheck();
  }

  const placedWord = (l: Line) =>
    l.placed === 'success'
      ? t('Placed')
      : l.placed === 'found'
        ? t('Placed, found on the book')
        : l.placed === 'absent'
          ? t('Not on the book')
          : l.placed === 'refused'
            ? t('Refused')
            : l.placed === 'unknown'
              ? t('Not confirmed')
              : t('Not reported');
  const tone = (l: Line) => (l.placed === 'success' || l.placed === 'found' ? 'up' : l.placed === 'refused' ? 'error' : 'warn');
  const columns: TableColumn<Line>[] = [
    { id: 'n', header: '#', pin: 'start', value: (l) => String(l.index) },
    {
      id: 'price',
      header: t('Price'),
      numeric: true,
      value: (l) => l.price,
      cell: (l) => (l.price === null ? null : fmtPrice(l.price, market?.tickSize)),
    },
    { id: 'size', header: t('Size'), numeric: true, value: (l) => l.size, cell: (l) => (l.size === null ? null : fmtAmount(l.size)) },
    { id: 'result', header: t('Answer'), cell: (l) => (run ? <Badge tone={tone(l)}>{placedWord(l)}</Badge> : null) },
    {
      id: 'book',
      header: t('On the book'),
      cell: (l) => (found === null ? null : l.order ? t(`Row ${l.order.status === 'open' ? 'open' : 'closed'}`) : t('Not found')),
    },
    {
      id: 'detail',
      header: t('Detail'),
      width: 320,
      cell: (l) => (
        <span className="whitespace-normal break-words">
          {l.detail ?? '—'}
          {l.code ? <span className="block break-all text-xs text-fg-2">{l.code}</span> : null}
        </span>
      ),
      value: (l) => l.detail,
    },
    {
      id: 'cancel',
      header: t('Cancel result'),
      cell: (l) => {
        const result = l.order ? cancels[l.order.id] : undefined;
        return result ? t(`Cancel ${result}`) : null;
      },
    },
  ];

  return (
    <section aria-label={t('Ladder result')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('Ladder result')}</h3>
        {summary && run ? (
          <span role="status" className="text-sm text-fg">
            {t('{k} of {n} placed', { k: String(summary.placed), n: String(run.rows.length) })}
            {summary.refused > 0 ? `, ${t('{n} refused', { n: String(summary.refused) })}` : ''}
            {summary.unknown > 0 ? `, ${t('{n} not confirmed', { n: String(summary.unknown) })}` : ''}
            {summary.absent > 0 ? `, ${t('{n} not on the book', { n: String(summary.absent) })}` : ''}
          </span>
        ) : null}
        {run ? (
          <Button variant="secondary" size={32} loading={checking} onClick={onCheck}>
            {t('Check status')}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size={32}
          disabled={live.length === 0 || writer.busy || writer.note.state !== 'none'}
          onClick={() => setConfirm(true)}
        >
          {t('Cancel all open in this ladder')}
        </Button>
      </div>
      {found === null ? (
        <Why>{t('Check first to cancel')}</Why>
      ) : live.length === 0 ? (
        <p className="m-0 text-sm text-fg-2">{t('No open orders in this ladder')}</p>
      ) : null}
      <Table label={t('Ladder result')} density="dense" columns={columns} rows={lines} minWidth={900} getRowId={(l) => l.clientOrderId} />
      <ConfirmDialog
        open={confirm}
        title={t('Cancel the open orders of this ladder?')}
        description={t('Group cancel body')}
        rows={[
          { label: t('Open orders'), value: String(live.length) },
          { label: t('Market'), value: live[0]?.symbol ?? run?.symbol ?? null },
        ]}
        confirmLabel={t('Cancel {n} orders', { n: String(live.length) })}
        tone="secondary"
        busy={writer.busy}
        onConfirm={() => void cancelAll()}
        onCancel={() => setConfirm(false)}
      />
    </section>
  );
}
