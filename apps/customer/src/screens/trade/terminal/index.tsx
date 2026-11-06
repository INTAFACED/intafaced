/**
 * Terminal room (/trade/terminal, CB-order-controls-05, ORD-005): orders, history, positions, algo orders, depth and one
 * order tree in one view, on our own books. Every row is read from the services: the order book's open and closed orders
 * and fills, the copy follows' positions, the algo schedules and the RFQ board. The DOM tab is a labelled preview.
 */
import { useMemo } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { EmptyState, Tabs, TabsList, TabsPanel, TabsTab, useSession, type Loadable } from '../rooms/ui';
import { RoomFrame } from '../rooms/RoomFrame';
import { useRoomApi } from '../rooms/read';
import { useClosedOrders, useFills, useOpenOrders, useRefreshPrivate } from '../desk/data';
import { useAlgoIds, useParents, type ParentRead } from '../execution/data';
import { buildBlotter, childParents } from '../execution/blotter';
import { BlotterTable, useCancelFlow } from '../execution/OrdersView';
import { Gate, signInHref } from '../execution/parts';
import { useRfqBoard } from '../otc/data';
import { AlgoOrdersTab } from './AlgoOrdersTab';
import { DomTab } from './DomTab';
import { OrderTree } from './OrderTree';
import { PositionsTab } from './PositionsTab';
import { buildTree } from './tree';
import { terminalCopy } from './copy';
import '../copybots/copybots.css';

/** The schedules, or an empty list once the service's list answered with none (the parent reads never start then). */
function useSchedules(userId: string | null): Loadable<ParentRead[]> {
  const { ids, list } = useAlgoIds(userId);
  const parents = useParents(ids);
  if (ids.length > 0) return parents;
  if (list.status === 'ready') return { status: 'ready', data: [], asOf: list.asOf };
  return list.status === 'loading' || list.status === 'empty' ? { status: 'loading' } : list;
}

function TerminalTabs({ userId }: { userId: string }) {
  const { t } = terminalCopy.useCopy();
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const fills = useFills(false);
  const refresh = useRefreshPrivate();
  const cancel = useCancelFlow(refresh);
  const schedules = useSchedules(userId);
  const rfq = useRfqBoard(useRoomApi());

  const parents = schedules.status === 'ready' ? schedules.data : [];
  const childOf = useMemo(() => childParents(parents.flatMap((p) => (p.ok ? [{ id: p.id, children: p.parent.children }] : []))), [parents]);
  const openRows = useMemo(() => buildBlotter(open.status === 'ready' ? open.data : [], [], [], [], childOf), [open, childOf]);
  const historyRows = useMemo(
    () => buildBlotter([], closed.status === 'ready' ? closed.data : [], fills.status === 'ready' ? fills.data : [], [], childOf),
    [closed, fills, childOf],
  );
  const allOrders = useMemo(
    () => [...(open.status === 'ready' ? open.data : []), ...(closed.status === 'ready' ? closed.data : [])],
    [open, closed],
  );
  const tree = useMemo(
    () =>
      buildTree({
        open: open.status === 'ready' ? open.data : [],
        closed: closed.status === 'ready' ? closed.data : [],
        parents,
        rfq: rfq.status === 'ready' ? rfq.data : null,
      }),
    [open, closed, parents, rfq],
  );
  // The tree waits for the order book and the schedules; the RFQ branch shows what the board answered.
  const treeLoad: Loadable<null> =
    open.status !== 'ready' ? (open as Loadable<null>) : schedules.status !== 'ready' ? (schedules as Loadable<null>) : { status: 'ready', data: null, asOf: open.asOf };

  return (
    <Tabs defaultValue="orders">
      <TabsList divider aria-label={t('Terminal tabs')} className="overflow-x-auto">
        <TabsTab value="orders">{t('Orders')}</TabsTab>
        <TabsTab value="history">{t('History')}</TabsTab>
        <TabsTab value="positions">{t('Positions')}</TabsTab>
        <TabsTab value="algo">{t('Algo orders')}</TabsTab>
        <TabsTab value="dom">{t('DOM')}</TabsTab>
        <TabsTab value="tree">{t('Order tree')}</TabsTab>
      </TabsList>
      <div className="pt-4">
        <TabsPanel value="orders">
          <div className="flex flex-col gap-2">
            {cancel.notice}
            <Gate load={open}>
              {() => (
                <BlotterTable
                  rows={openRows}
                  label={t('Open orders')}
                  emptyText={t('No open orders')}
                  onCancel={cancel.ask}
                  cancelLocked={cancel.locked}
                  showOrderId
                />
              )}
            </Gate>
            {cancel.dialog}
          </div>
        </TabsPanel>
        <TabsPanel value="history">
          <div className="flex flex-col gap-2">
            <Gate load={closed}>
              {() => <BlotterTable rows={historyRows} label={t('Order history')} emptyText={t('No order history')} showOrderId />}
            </Gate>
            <p className="m-0 text-sm text-fg-2">{t('History cut')}</p>
          </div>
        </TabsPanel>
        <TabsPanel value="positions">
          <PositionsTab />
        </TabsPanel>
        <TabsPanel value="algo">
          <AlgoOrdersTab parents={schedules} orders={allOrders} />
        </TabsPanel>
        <TabsPanel value="dom">
          <DomTab />
        </TabsPanel>
        <TabsPanel value="tree">
          <Gate load={treeLoad}>{() => <OrderTree branches={tree} rfqUnread={rfq.status === 'refused' || rfq.status === 'error'} />}</Gate>
        </TabsPanel>
      </div>
    </Tabs>
  );
}

export default function Screen(_props: ScreenProps) {
  const { t } = terminalCopy.useCopy();
  const { userId } = useSession();
  return (
    <RoomFrame mode={null} title={t('Terminal')} description={t('Terminal description')}>
      {!userId ? (
        <EmptyState
          variant="refused"
          title={t('Sign in title')}
          reason={t('Sign in reason')}
          action={{ label: t('Sign in'), href: signInHref(), variant: 'primary' }}
        />
      ) : (
        <TerminalTabs userId={userId} />
      )}
    </RoomFrame>
  );
}
