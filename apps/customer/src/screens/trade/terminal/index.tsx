// volt-room: /trade/terminal
/**
 * Terminal (/trade/terminal, J-copy-bots-otc-30, CB-order-controls-05): one MetaTrader-style view of the person's own
 * open orders, ended orders and fills, copied positions with their close, and algo orders with their child orders, plus a
 * DOM tab that is a labelled preview (the engine it needs is not connected). Every row is read from the service; each
 * part is the room that already owns it (the Execution blotter and algo list, the Copy room's copied positions).
 */
import { useMemo, useState } from 'react';
import { Tag } from '@intafaced/ui/lit';
import { DeskTemplate, TabPanel, Tabs, Table, TestTag, type Column, type RoomState } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../../app/screen-types';
import { TradeSubNav } from '../TradeSubNav';
import { useSession } from '../rooms/ui';
import { useRoomApi } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
import type { AlgoParent } from '../rooms/api';
import { useClosedOrders, useFills, useOpenOrders, useRefreshPrivate } from '../desk/data';
import { buildBlotter, childParents, filterBlotter } from '../execution/blotter';
import { BlotterTable, useCancelFlow } from '../execution/OrdersView';
import { AlgoDetail, AlgoList, type AlgoAction } from '../execution/AlgoList';
import { execCopy } from '../execution/copy';
import { useAlgoIds, useParents, useRefreshParents, type ParentRead } from '../execution/data';
import { ConfirmDialog, Empty, Gate, Why, WriteNotice, signInHref } from '../execution/parts';
import { useApi } from '../../../features/session/session';
import { createRoomApi } from '../copybots/api';
import { CopiedPositions } from '../copybots/FollowCopies';
import { useWriteGuard } from '../copybots/guard';
import { useLive } from '../copybots/live';
import { RefusalNote } from '../copybots/parts';
import { terminalCopy } from './copy';
import { FirstState } from '@intafaced/ui/lit/templates';
import { CandlestickChart } from 'lucide-react';

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
    <div className="lt-body">
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
      {open.status === 'ready' && rows.length === 0 ? (
        // Nothing open yet: what the terminal gathers and the one place to start.
        <FirstState
          icon={<CandlestickChart size={24} />}
          title={t('First title')}
          body={t('First body')}
          points={[t('First point orders'), t('First point history'), t('First point algo')]}
          action={{ label: t('First action'), href: '/trade/spot/BTC-USDT' }}
        />
      ) : null}
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
    <div className="lt-body">
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
  if (follows.data.length === 0) return <Empty title={t('No follows')} body={t('No follows reason')} />;
  return (
    <div className="lt-body">
      {guard.pending?.kind === 'copy' ? (
        <Why>
          {t('Check in Copy')}{' '}
          <a className="lt-link" href="/trade/copy?tab=follows">
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
          <h3>{t('Copied from {leader}', { leader: follow.leaderRef ?? follow.leaderId ?? follow.followId })}</h3>
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
    <div className="lt-body">
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
        <p className="lt-hint">{t('Pick a schedule')}</p>
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
  const columns: Column<(typeof SAMPLE_LEVELS)[number]>[] = [
    { key: 'side', label: t('Side'), cell: (r) => (r.side === 'ask' ? t('Ask') : t('Bid')) },
    { key: 'price', label: t('Price'), align: 'end', cell: (r) => r.price },
    { key: 'size', label: t('Size'), align: 'end', cell: (r) => r.size },
    { key: 'tag', label: '', cell: () => <Tag tone="neutral">{t('Sample level')}</Tag> },
  ];
  return (
    <section aria-label={t('Depth of market')} className="lt-body">
      <div role="note" className="lt-empty">
        <p className="lt-empty-title">{t('DOM preview title')}</p>
        <p>{t('DOM preview engine')}</p>
        <p className="lt-empty-body">{t('DOM preview reason')}</p>
        <a className="lt-link" href="/trade/spot/BTC-USDT">
          {t('DOM live link')}
        </a>
      </div>
      <div className="lt-toolbar">
        <p>{t('Preview · sample data')}</p>
        <TestTag />
      </div>
      <Table caption={t('Preview · sample data')} mode="pro" columns={columns} rows={SAMPLE_LEVELS} rowKey={(r) => r.id} />
    </section>
  );
}

export default function Screen({ search }: ScreenProps) {
  const { t } = terminalCopy.useCopy();
  const { userId } = useSession();
  const requested = new URLSearchParams(search).get('tab');
  const initial: TabId = TABS.find((id) => id === requested) ?? 'orders';
  const [tab, setTab] = useState<TabId>(initial);
  const { ids, list } = useAlgoIds(userId);
  const parents = useParents(ids);
  const parentRows = parents.status === 'ready' ? parents.data : [];
  const state: RoomState = userId
    ? { kind: 'ready' }
    : {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('Sign in title'),
          body: t('Sign in reason'),
          action: { label: t('Sign in'), href: signInHref() },
        },
      };

  return (
    <DeskTemplate
      mode="pro"
      title={t('Terminal')}
      section={<TradeSubNav />}
      description={t('Terminal description')}
      state={state}
      instrument={undefined}
      chart={undefined}
      ticket={undefined}
      orders={
        <div className="lt-body">
          <Tabs
            id="terminal"
            label={t('Terminal tabs')}
            value={tab}
            onChange={(next) => setTab(next as TabId)}
            items={[
              { value: 'orders', label: t('Orders') },
              { value: 'history', label: t('History') },
              { value: 'positions', label: t('Positions') },
              { value: 'algo', label: t('Algo orders') },
              { value: 'dom', label: t('DOM') },
            ]}
          />
          <TabPanel id="terminal" value="orders" current={tab}>
            <OrdersTab parents={parentRows} />
          </TabPanel>
          <TabPanel id="terminal" value="history" current={tab}>
            <HistoryTab parents={parentRows} />
          </TabPanel>
          <TabPanel id="terminal" value="positions" current={tab}>
            <PositionsTab />
          </TabPanel>
          <TabPanel id="terminal" value="algo" current={tab}>
            <AlgoTab ids={ids} parents={parents} listing={list} />
          </TabPanel>
          <TabPanel id="terminal" value="dom" current={tab}>
            <DomTab />
          </TabPanel>
        </div>
      }
    />
  );
}
