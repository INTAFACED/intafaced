/**
 * What happened to a ladder: the service's answer per order in plain words, the book as read back by id prefix, and a
 * group cancel that is just one cancel per still-open order (the service has no ladder object, SCL-1).
 */
import { useState } from 'react';
import type { Order } from '../../../features/trade/trade-api';
import { Button } from '@intafaced/ui/lit';
import { StatusChip, Table, type Column } from '@intafaced/ui/lit/templates';
import { UNKNOWN, fmtAmount, fmtPrice } from '../rooms/ui';
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
  const mark = (l: Line) => (l.placed === 'success' || l.placed === 'found' ? 'done' : l.placed === 'refused' ? 'failed' : 'unknown');
  const columns: Column<Line>[] = [
    { key: 'n', label: '#', cell: (l) => String(l.index) },
    { key: 'price', label: t('Price'), align: 'end', cell: (l) => (l.price === null ? UNKNOWN : fmtPrice(l.price, market?.tickSize)) },
    { key: 'size', label: t('Size'), align: 'end', cell: (l) => (l.size === null ? UNKNOWN : fmtAmount(l.size)) },
    { key: 'result', label: t('Answer'), cell: (l) => (run ? <StatusChip status={mark(l)} label={placedWord(l)} /> : UNKNOWN) },
    {
      key: 'book',
      label: t('On the book'),
      cell: (l) => (found === null ? UNKNOWN : l.order ? t(`Row ${l.order.status === 'open' ? 'open' : 'closed'}`) : t('Not found')),
    },
    {
      key: 'detail',
      label: t('Detail'),
      cell: (l) => (
        <span>
          {l.detail ?? '—'}
          {l.code ? (
            <>
              {' '}
              <span className="lt-ref">{l.code}</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      key: 'cancel',
      label: t('Cancel result'),
      cell: (l) => {
        const result = l.order ? cancels[l.order.id] : undefined;
        return result ? t(`Cancel ${result}`) : UNKNOWN;
      },
    },
  ];

  return (
    <section aria-label={t('Ladder result')} className="lt-col-main">
      <div className="lt-toolbar">
        <h3>{t('Ladder result')}</h3>
        {summary && run ? (
          <span role="status">
            {t('{k} of {n} placed', { k: String(summary.placed), n: String(run.rows.length) })}
            {summary.refused > 0 ? `, ${t('{n} refused', { n: String(summary.refused) })}` : ''}
            {summary.unknown > 0 ? `, ${t('{n} not confirmed', { n: String(summary.unknown) })}` : ''}
            {summary.absent > 0 ? `, ${t('{n} not on the book', { n: String(summary.absent) })}` : ''}
          </span>
        ) : null}
        {run ? (
          <Button disabled={checking} aria-busy={checking || undefined} onClick={onCheck}>
            {t('Check status')}
          </Button>
        ) : null}
        <Button disabled={live.length === 0 || writer.busy || writer.note.state !== 'none'} onClick={() => setConfirm(true)}>
          {t('Cancel all open in this ladder')}
        </Button>
      </div>
      {found === null ? (
        <Why>{t('Check first to cancel')}</Why>
      ) : live.length === 0 ? (
        <p className="lt-hint">{t('No open orders in this ladder')}</p>
      ) : null}
      <Table
        caption={t('Ladder result')}
        mode="pro"
        columns={columns}
        rows={lines}
        rowKey={(l) => l.clientOrderId}
        empty="Nothing to show"
      />
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
