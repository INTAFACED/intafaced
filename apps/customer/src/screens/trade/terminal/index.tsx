/**
 * Terminal (/trade/terminal, J-copy-bots-otc-30, CB-order-controls-05): one MetaTrader-style view of the person's own
 * open orders, ended orders and fills, copied positions with their close, and algo orders with their child orders, plus a
 * DOM tab that is a labelled preview (the engine it needs is not connected). Every row is read from the service; each
 * part is the room that already owns it (the Execution blotter and algo list, the Copy room's copied positions).
 */
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { Badge, EmptyState, Table, Tabs, TabsList, TabsPanel, TabsTab, useSession, type TableColumn } from '../rooms/ui';
import { RoomFrame } from '../rooms/RoomFrame';
import { useRoomApi } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
import { WriteNotice } from '../rooms/RoomNotices';
import type { AlgoParent } from '../rooms/api';
import { useClosedOrders, useFills, useOpenOrders, useRefreshPrivate } from '../desk/data';
import { buildBlotter, childParents, filterBlotter } from '../execution/blotter';
import { BlotterTable, useCancelFlow } from '../execution/OrdersView';
import { AlgoDetail, AlgoList, type AlgoAction } from '../execution/AlgoList';
import { execCopy } from '../execution/copy';
import { useAlgoIds, useParents, useRefreshParents, type ParentRead } from '../execution/data';
import { ConfirmDialog, Gate, Why, signInHref } from '../execution/parts';
import { useApi } from '../../../features/session/session';
import { createRoomApi } from '../copybots/api';
import { CopiedPositions } from '../copybots/FollowCopies';
import { useWriteGuard } from '../copybots/guard';
import { useLive } from '../copybots/live';
import { RefusalNote } from '../copybots/parts';
import { terminalCopy } from './copy';

type TabId = 'orders' | 'history' | 'positions' | 'algo' | 'dom';
const TABS: readonly TabId[] = ['orders', 'history', 'positions', 'algo', 'dom'];

function OrdersTab({ parents }: { parents: readonly ParentRead[] }) {
  const { t } = terminalCopy.useCopy();
  const open = useOpenOrders();
  const refresh = useRefreshPrivate();
  const cancel = useCancelFlow(refresh);
  const childOf = useMemo(() => childParents(parents.flatMap((p) => (p.ok ? [{ id: p.id, children: p.parent.children }] : []))), [parents]);
  const rows = useMemo(() => buildBlotter(open.status === 'ready' ? open.data : [], [], [], [], childOf), [open, childOf]);
  return (
    <div className="flex flex-col gap-3">
      <Gate load={open}>
        {() => (
          <BlotterTable
            rows={rows}
            label={t('Open orders')}
            emptyText={t('No open orders')}
            onCancel={cancel.ask}
            cancelLocked={cancel.locked}
            showOrderId
          />
        )}
      </Gate>
      {cancel.notice}
      {cancel.dialog}
    </div>
  );
}

function HistoryTab({ parents }: { parents: readonly ParentRead[] }) {
  const { t } = terminalCopy.useCopy();
  const closed = useClosedOrders(true);
  const fills = useFills(true);
  const childOf = useMemo(() => childParents(parents.flatMap((p) => (p.ok ? [{ id: p.id, children: p.parent.children }] : []))), [parents]);
  const orders = useMemo(() => buildBlotter([], closed.status === 'ready' ? closed.data : [], [], [], childOf), [closed, childOf]);
  // Fills are linked to their orders by the order id each fill names; the orders lists are passed so each fill keeps its source.
  const fillRows = useMemo(
    () =>
      buildBlotter([], closed.status === 'ready' ? closed.data : [], fills.status === 'ready' ? fills.data : [], [], childOf).filter(
        (r) => r.kind === 'fill',
      ),
    [closed, fills, childOf],
  );
  return (
    <div className="flex flex-col gap-4">
      {closed.status === 'ready' && fills.status !== 'ready' && fills.status !== 'loading' ? <Why>{t('History partly unread')}</Why> : null}
      <Gate load={closed}>
        {() => <BlotterTable rows={orders} label={t('Order history')} emptyText={t('No ended orders')} showOrderId />}
      </Gate>
      <Gate load={fills}>{() => <BlotterTable rows={fillRows} label={t('Fills')} emptyText={t('No fills')} showOrderId />}</Gate>
    </div>
  );
}

function PositionsTab() {
  const { t } = terminalCopy.useCopy();
  const transport = useApi();
  const { session } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const guard = useWriteGuard();
  const follows = useLive((signal) => api.follows(signal), `terminal-follows:${session ? 'in' : 'out'}`, 15_000);
  if (follows.status === 'error' && follows.failure) return <RefusalNote failure={follows.failure} retry={follows.reload} />;
  if (follows.data === null) return <Gate load={{ status: 'loading' }}>{() => null}</Gate>;
  if (follows.data.length === 0)
    return <EmptyState variant="empty" size="inline" title={t('No follows')} reason={t('No follows reason')} />;
  return (
    <div className="flex flex-col gap-4">
      {guard.pending?.kind === 'copy' ? (
        <Why>
          {t('Check in Copy')}{' '}
          <a className="text-link" href="/trade/copy?tab=follows">
            {t('Open Copy')}
          </a>
        </Why>
      ) : null}
      {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
      {follows.data.map((follow) => (
        <section
          key={follow.followId}
          aria-label={t('Copied from {leader}', { leader: follow.leaderRef ?? follow.leaderId ?? follow.followId })}
        >
          <h3 className="m-0 mb-2 text-sm font-medium">
            {t('Copied from {leader}', { leader: follow.leaderRef ?? follow.leaderId ?? follow.followId })}
          </h3>
          <CopiedPositions follow={follow} api={api} guard={guard} />
        </section>
      ))}
    </div>
  );
}

function AlgoTab({
  ids,
  parents,
  listing,
}: {
  ids: string[];
  parents: ReturnType<typeof useParents>;
  listing: ReturnType<typeof useAlgoIds>['list'];
}) {
  const { t } = terminalCopy.useCopy();
  const exec = execCopy.useCopy();
  const room = useRoomApi();
  const writer = useRoomWriter();
  const refreshParents = useRefreshParents(ids);
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<{ parent: AlgoParent; action: AlgoAction } | null>(null);
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const fills = useFills(true);
  const rows = parents.status === 'ready' ? parents.data : [];
  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const childOf = useMemo(() => childParents(rows.flatMap((p) => (p.ok ? [{ id: p.id, children: p.parent.children }] : []))), [rows]);
  const children = useMemo(
    () =>
      selected
        ? filterBlotter(
            buildBlotter(
              open.status === 'ready' ? open.data : [],
              closed.status === 'ready' ? closed.data : [],
              fills.status === 'ready' ? fills.data : [],
              [],
              childOf,
            ),
            { market: 'all', side: 'all', source: 'all', parent: selected },
          )
        : [],
    [selected, open, closed, fills, childOf],
  );

  async function run() {
    if (!action) return;
    const { parent, action: kind } = action;
    await writer.run({ kind: 'algo', id: `${kind}:${parent.id}`, symbol: parent.symbol, call: () => room.algoAction(kind, parent.id) });
    setAction(null);
    refreshParents();
  }

  return (
    <div className="flex flex-col gap-3">
      <WriteNotice writer={writer} onCheck={() => refreshParents()} done={exec.t('Done, the list shows the new state')} />
      <section aria-label={t('Algo orders')}>
        <AlgoList
          load={parents}
          empty={ids.length === 0}
          listing={listing}
          selectedId={selected}
          onSelect={setSelected}
          onAction={(parent, kind) => setAction({ parent, action: kind })}
          locked={writer.busy || writer.note.state !== 'none'}
        />
      </section>
      {selectedRow ? <AlgoDetail row={selectedRow} onClone={() => undefined} /> : null}
      {selected ? (
        <BlotterTable rows={children} label={t('Child orders of {id}', { id: selected })} emptyText={t('No child orders')} showOrderId />
      ) : ids.length > 0 ? (
        <p className="m-0 text-sm text-fg-2">{t('Pick a schedule')}</p>
      ) : null}
      <ConfirmDialog
        open={action !== null}
        title={action ? exec.t(`Confirm ${action.action}`) : ''}
        description={action ? exec.t(`Confirm ${action.action} body`) : ''}
        rows={
          action
            ? [
                { label: exec.t('Schedule id'), value: action.parent.id, mono: true },
                { label: exec.t('Market'), value: action.parent.symbol },
              ]
            : []
        }
        confirmLabel={action ? exec.t(`Do ${action.action}`) : ''}
        tone={action?.action === 'cancel' ? 'secondary' : 'primary'}
        busy={writer.busy}
        onConfirm={() => void run()}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}

/** Sample levels for the DOM preview. Labelled as sample and TEST everywhere they show; never a price from any book. */
const SAMPLE_LEVELS: ReadonlyArray<{ id: string; side: 'ask' | 'bid'; price: string; size: string }> = [
  { id: 'a3', side: 'ask', price: '100.30', size: '1.5' },
  { id: 'a2', side: 'ask', price: '100.20', size: '0.8' },
  { id: 'a1', side: 'ask', price: '100.10', size: '2.0' },
  { id: 'b1', side: 'bid', price: '100.00', size: '1.2' },
  { id: 'b2', side: 'bid', price: '99.90', size: '0.6' },
  { id: 'b3', side: 'bid', price: '99.80', size: '3.1' },
];

function DomTab() {
  const { t } = terminalCopy.useCopy();
  const columns: TableColumn<(typeof SAMPLE_LEVELS)[number]>[] = [
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'ask' ? t('Ask') : t('Bid')) },
    { id: 'price', header: t('Price'), numeric: true, value: (r) => r.price },
    { id: 'size', header: t('Size'), numeric: true, value: (r) => r.size },
    { id: 'tag', header: '', cell: () => <Badge variant="outline">{t('Sample level')}</Badge> },
  ];
  return (
    <section aria-label={t('Depth of market')} className="flex flex-col gap-3">
      <div role="note" className="flex flex-col gap-1 rounded-md border border-line bg-panel p-3">
        <p className="m-0 font-medium">{t('DOM preview title')}</p>
        <p className="m-0 text-sm">{t('DOM preview engine')}</p>
        <p className="m-0 text-sm text-fg-2">{t('DOM preview reason')}</p>
        <a className="text-link text-sm" href="/trade/spot/BTC-USDT">
          {t('DOM live link')}
        </a>
      </div>
      <div className="flex items-center gap-2">
        <p className="m-0 text-sm font-medium">{t('Preview · sample data')}</p>
        <Badge tone="warn">{t('TEST')}</Badge>
      </div>
      <Table label={t('Preview · sample data')} density="dense" columns={columns} rows={SAMPLE_LEVELS} getRowId={(r) => r.id} />
    </section>
  );
}

export default function Screen({ search }: ScreenProps) {
  const { t } = terminalCopy.useCopy();
  const { userId } = useSession();
  const requested = new URLSearchParams(search).get('tab');
  const initial: TabId = TABS.find((id) => id === requested) ?? 'orders';
  const { ids, list } = useAlgoIds(userId);
  const parents = useParents(ids);
  const parentRows = parents.status === 'ready' ? parents.data : [];

  return (
    <RoomFrame mode="Execution" title={t('Terminal')} description={t('Terminal description')}>
      {!userId ? (
        <EmptyState
          variant="refused"
          title={t('Sign in title')}
          reason={t('Sign in reason')}
          action={{ label: t('Sign in'), href: signInHref(), variant: 'primary' }}
        />
      ) : (
        <Tabs defaultValue={initial}>
          <TabsList divider aria-label={t('Terminal tabs')} className="overflow-x-auto">
            <TabsTab value="orders">{t('Orders')}</TabsTab>
            <TabsTab value="history">{t('History')}</TabsTab>
            <TabsTab value="positions">{t('Positions')}</TabsTab>
            <TabsTab value="algo">{t('Algo orders')}</TabsTab>
            <TabsTab value="dom">{t('DOM')}</TabsTab>
          </TabsList>
          <div className="pt-4">
            <TabsPanel value="orders">
              <OrdersTab parents={parentRows} />
            </TabsPanel>
            <TabsPanel value="history">
              <HistoryTab parents={parentRows} />
            </TabsPanel>
            <TabsPanel value="positions">
              <PositionsTab />
            </TabsPanel>
            <TabsPanel value="algo">
              <AlgoTab ids={ids} parents={parents} listing={list} />
            </TabsPanel>
            <TabsPanel value="dom">
              <DomTab />
            </TabsPanel>
          </div>
        </Tabs>
      )}
    </RoomFrame>
  );
}
