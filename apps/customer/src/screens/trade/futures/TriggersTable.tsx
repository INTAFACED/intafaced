import { useState } from 'react';
import { Amount, Badge, Button, EmptyState, StatusTag, Table, type StatusKind, type TableColumn } from '@intafaced/ui';
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

/**
 * Every take profit, stop loss and stop on the account, armed or recent (J-derivatives-03). A fired one stays listed
 * after its position closes, so the trader can see it went from armed to filled and which book order closed it.
 */
export function TriggersTable({
  triggers,
  entries,
  onChanged,
}: {
  triggers: Loadable<ConditionalOrder[]>;
  entries: Loadable<EntryProtection[]>;
  onChanged: () => void;
}) {
  const { t } = triggersCopy.useCopy();
  const { timeZone } = usePreferences();
  const writer = useFuturesWriter(onChanged);
  const [cancelling, setCancelling] = useState<string | null>(null);

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

  const columns: TableColumn<ConditionalOrder>[] = [
    { id: 'time', header: t('Col time'), value: (o) => dayTime(Date.parse(o.createdAt), timeZone) },
    { id: 'contract', header: t('Col contract'), value: (o) => o.market },
    { id: 'what', header: t('Col what'), value: (o) => triggerKind(o, t) },
    {
      id: 'side',
      header: t('Col side'),
      cell: (o) => (
        <Badge variant="outline" tone={o.side === 'buy' ? 'up' : 'down'}>
          {o.side === 'buy' ? t('Buy') : t('Sell')}
        </Badge>
      ),
    },
    { id: 'size', header: t('Col size'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.quantity, { places: 8 })} /> },
    { id: 'trigger', header: t('Col trigger'), value: (o) => triggerLine(o, t) ?? '' },
    {
      id: 'status',
      header: t('Col status'),
      cell: (o) => <StatusTag status={triggerStatus(o)} label={t(`Status ${o.status}`)} />,
    },
    {
      id: 'detail',
      header: t('Col detail'),
      cell: (o) => (
        <span className="flex flex-col text-xs">
          <TriggerFacts order={o} />
        </span>
      ),
    },
    {
      id: 'action',
      header: t('Col action'),
      cell: (o) =>
        o.status === 'armed' ? (
          <Button
            variant="secondary"
            size={28}
            loading={cancelling === o.id}
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
      <section aria-label={t('Triggers table')} className="flex flex-col border-t border-line">
        <TabHeader title={t('Triggers heading')} load={triggers} />
        {writer.outcome?.kind === 'refused' || writer.outcome?.kind === 'blocked' || writer.note.state !== 'none' ? (
          <div className="px-3 text-xs">
            <WriteNotice writer={writer} onCheck={() => void check()} />
          </div>
        ) : null}
        <LoadGate load={triggers} thing={t('Triggers thing')}>
          {(rows) => (
            <Table
              label={t('Triggers table')}
              density="dense"
              columns={columns}
              rows={[...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))}
              getRowId={(o) => o.id}
              emptyState={<EmptyState size="inline" title={t('Triggers empty')} reason={t('Triggers empty reason')} />}
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
  const columns: TableColumn<EntryProtection>[] = [
    { id: 'time', header: t('Col time'), value: (e) => dayTime(Date.parse(e.createdAt), timeZone) },
    { id: 'contract', header: t('Col contract'), value: (e) => e.symbol },
    {
      id: 'order',
      header: t('Col order'),
      cell: (e) => (
        <Badge variant="outline" tone={e.side === 'buy' ? 'up' : 'down'}>
          {e.side === 'buy' ? t('Buy') : t('Sell')}
        </Badge>
      ),
    },
    { id: 'tp', header: t('Col take profit'), numeric: true, value: (e) => e.takeProfit ?? t('None') },
    { id: 'sl', header: t('Col stop loss'), numeric: true, value: (e) => e.stopLoss ?? t('None') },
    { id: 'covers', header: t('Col covers'), numeric: true, cell: (e) => <Amount value={fmtAmount(e.armedQuantity, { places: 8 })} /> },
    {
      id: 'status',
      header: t('Col status'),
      cell: (e) => <StatusTag status={ENTRY_TONE[e.status]} label={t(`Entry status ${e.status}`)} />,
    },
  ];
  return (
    <section aria-label={t('Entries table')} className="flex flex-col border-t border-line">
      <TabHeader title={t('Entries heading')} load={entries} />
      <LoadGate load={entries} thing={t('Entries thing')}>
        {(rows) => (
          <Table
            label={t('Entries table')}
            density="dense"
            columns={columns}
            rows={rows}
            getRowId={(e) => e.id}
            emptyState={<EmptyState size="inline" title={t('Entries empty')} reason={t('Entries empty reason')} />}
          />
        )}
      </LoadGate>
    </section>
  );
}
