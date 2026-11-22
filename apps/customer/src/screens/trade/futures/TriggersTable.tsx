import { useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Badge, Button, StatusTag, type StatusKind } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { ConditionalOrder, EntryProtection } from './api';
import { LoadGate, TabHeader } from './HistoryTab';
import { useFuturesWriter } from './hooks';
import { WriteNotice } from './PositionDialogs';
import { TriggerFacts, triggerKind, triggerLine, triggerStatus } from './TriggerFacts';
import { triggersCopy } from './triggers-copy';
import { RegionNote } from './notes';

/**
 * Every take profit, stop loss and stop on the account, armed or recent (J-derivatives-03). A fired one stays listed
 * after its position closes, so the trader can see it went from armed to filled and which book order closed it.
 */
export function TriggersTable({
  triggers,
  entries,
  positions,
  onChanged,
}: {
  triggers: Loadable<ConditionalOrder[]>;
  entries: Loadable<EntryProtection[]>;
  /** The open positions, so a failed order can say where its position stands now. */
  positions: Loadable<Position[]>;
  onChanged: () => void;
}) {
  const { t } = triggersCopy.useCopy();
  const { timeZone } = usePreferences();
  const writer = useFuturesWriter(onChanged);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const open = positions.status === 'ready' ? positions.data : positions.status === 'empty' ? [] : null;

  // Under the same device guard as every other trade write: nothing goes out while an earlier answer is unknown.
  const cancel = async (order: ConditionalOrder) => {
    setCancelling(order.id);
    await writer.run({ op: 'cancel-trigger', input: { symbol: order.market, id: order.id } });
    setCancelling(null);
    onChanged();
  };
  const check = async () => {
    if (writer.note.state === 'pending') await writer.check(writer.note.pending);
    onChanged();
  };

  const columns: Column<ConditionalOrder>[] = [
    { key: 'time', label: t('Col time'), cell: (o) => dayTime(Date.parse(o.createdAt), timeZone) },
    { key: 'contract', label: t('Col contract'), cell: (o) => o.market },
    { key: 'what', label: t('Col what'), cell: (o) => triggerKind(o, t) },
    {
      key: 'side',
      label: t('Col side'),
      cell: (o) => <Badge tone={o.side === 'buy' ? 'up' : 'down'}>{o.side === 'buy' ? t('Buy') : t('Sell')}</Badge>,
    },
    { key: 'size', label: t('Col size'), align: 'end', cell: (o) => <Amount value={fmtAmount(o.quantity, { places: 8 })} /> },
    { key: 'trigger', label: t('Col trigger'), cell: (o) => triggerLine(o, t) ?? '' },
    {
      key: 'status',
      label: t('Col status'),
      cell: (o) => <StatusTag status={triggerStatus(o)} label={t(`Status ${o.status}`)} />,
    },
    {
      key: 'detail',
      label: t('Col detail'),
      cell: (o) => (
        <span className="lt-stack-tight lt-small">
          <TriggerFacts order={o} positions={open} />
        </span>
      ),
    },
    {
      key: 'action',
      label: t('Col action'),
      cell: (o) =>
        o.status === 'armed' ? (
          <Button
            tone="secondary"
            size="sm"
            busy={cancelling === o.id}
            disabled={writer.locked}
            aria-label={t('Cancel trigger label', { what: triggerKind(o, t), contract: o.market })}
            onClick={() => void cancel(o)}
          >
            {t('Cancel trigger')}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <section aria-label={t('Triggers table')} className="lt-stack">
        <TabHeader title={t('Triggers heading')} load={triggers} />
        {writer.outcome?.kind === 'refused' || writer.outcome?.kind === 'blocked' || writer.note.state !== 'none' ? (
          <div className="lt-small">
            <WriteNotice writer={writer} onCheck={() => void check()} />
          </div>
        ) : null}
        <LoadGate load={triggers} thing={t('Triggers thing')}>
          {(rows) => (
            <Table
              mode="pro"
              dense
              caption={t('Triggers table')}
              columns={columns}
              rows={[...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))}
              rowKey={(o) => o.id}
              empty={<RegionNote title={t('Triggers empty')} reason={t('Triggers empty reason')} />}
            />
          )}
        </LoadGate>
      </section>
      <EntryProtections entries={entries} />
    </>
  );
}

const ENTRY_TONE: Record<EntryProtection['status'], StatusKind> = {
  waiting: 'pending',
  armed: 'working',
  done: 'filled',
  not_filled: 'cancelled',
  no_position: 'cancelled',
  not_placed: 'cancelled',
};

/** What each opening order asked to be protected with, and how far its legs have armed on what it filled. */
function EntryProtections({ entries }: { entries: Loadable<EntryProtection[]> }) {
  const { t } = triggersCopy.useCopy();
  const { timeZone } = usePreferences();
  const columns: Column<EntryProtection>[] = [
    { key: 'time', label: t('Col time'), cell: (e) => dayTime(Date.parse(e.createdAt), timeZone) },
    { key: 'contract', label: t('Col contract'), cell: (e) => e.symbol },
    {
      key: 'order',
      label: t('Col order'),
      cell: (e) => <Badge tone={e.side === 'buy' ? 'up' : 'down'}>{e.side === 'buy' ? t('Buy') : t('Sell')}</Badge>,
    },
    { key: 'tp', label: t('Col take profit'), align: 'end', cell: (e) => e.takeProfit ?? t('None') },
    { key: 'sl', label: t('Col stop loss'), align: 'end', cell: (e) => e.stopLoss ?? t('None') },
    { key: 'covers', label: t('Col covers'), align: 'end', cell: (e) => <Amount value={fmtAmount(e.armedQuantity, { places: 8 })} /> },
    {
      key: 'status',
      label: t('Col status'),
      cell: (e) => <StatusTag status={ENTRY_TONE[e.status]} label={t(`Entry status ${e.status}`)} />,
    },
  ];
  return (
    <section aria-label={t('Entries table')} className="lt-stack">
      <TabHeader title={t('Entries heading')} load={entries} />
      <LoadGate load={entries} thing={t('Entries thing')}>
        {(rows) => (
          <Table
            mode="pro"
            dense
            caption={t('Entries table')}
            columns={columns}
            rows={rows}
            rowKey={(e) => e.id}
            empty={<RegionNote title={t('Entries empty')} reason={t('Entries empty reason')} />}
          />
        )}
      </LoadGate>
    </section>
  );
}
