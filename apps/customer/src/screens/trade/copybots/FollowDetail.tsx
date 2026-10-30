import { useState } from 'react';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  KeyValue,
  Table,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type BadgeTone,
  type TableColumn,
} from '@intafaced/ui';
import { CopiedPositions, SkippedCopies } from './FollowCopies';
import { displayAmount } from '../../../shared/money';
import type { z } from 'zod';
import type { copyFollowSchema } from '../../../features/trade/tool-api';
import { useResource } from '../../../shared/resource';
import type { CopyPosition, RoomApi } from './api';
import { roomCopy } from './copy';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';

export type Follow = z.infer<typeof copyFollowSchema>;
export type FollowAction = 'pause' | 'resume' | 'stop' | 'detach' | 'flatten';
type CopiesTab = 'orders' | 'positions' | 'skipped';

/** The asset the follow's limits are counted in: the shared quote asset of its markets, or '' when they differ. */
export function quoteAsset(follow: Follow): string {
  const quotes = new Set(follow.permittedMarkets.map((m) => m.split('/')[1] ?? ''));
  return quotes.size === 1 ? [...quotes][0]! : '';
}
const withAsset = (amount: string, asset: string) => (asset ? `${displayAmount(amount)} ${asset}` : displayAmount(amount));

export const STATE_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'lime',
  PAUSED: 'warn',
  STOPPING: 'warn',
  CLOSE_ONLY: 'warn',
  STOPPED: 'neutral',
  DETACHED: 'neutral',
};
export function stateWord(state: string): string {
  const word: Record<string, string> = {
    ACTIVE: 'Active',
    PAUSED: 'Paused',
    STOPPING: 'Stopping',
    // Stopped with close-only: no new trades, the leader's closes still close what was copied (CB-copy-09).
    CLOSE_ONLY: 'Stopping',
    STOPPED: 'Stopped',
    DETACHED: 'Left',
  };
  return word[state.toUpperCase()] ?? 'Unknown state';
}
export const isCloseOnly = (follow: Follow) => follow.relationshipState.toUpperCase() === 'CLOSE_ONLY';

/** Which actions the follow's state allows, and the reason for the ones it does not (kept on screen, never hidden). */
export function allowedActions(follow: Follow): Record<FollowAction, string | null> {
  const state = follow.relationshipState.toUpperCase();
  const live = state === 'ACTIVE';
  const paused = state === 'PAUSED';
  const done = state === 'DETACHED';
  return {
    pause: live ? null : 'Only an active follow can be paused',
    resume: paused ? null : 'Only a paused follow can be resumed',
    stop: live || paused ? null : 'This follow has already stopped',
    detach: done ? 'You have already left this leader' : null,
    flatten: done ? 'You have already left this leader' : null,
  };
}

const ACTION_COPY: Record<FollowAction, { button: string; title: string; effect: string }> = {
  pause: {
    button: 'Pause',
    title: 'Pause this follow?',
    effect: 'New trades stop being copied right away. Positions already open stay as they are. You can resume any time.',
  },
  resume: { button: 'Resume', title: 'Resume this follow?', effect: 'New trades will be copied again, within the limits you set.' },
  stop: {
    button: 'Stop',
    title: 'Stop this follow?',
    effect:
      'New trades stop being copied. While automatic copying is on, when the leader closes a trade you copied, your copy is closed too. Nothing else is sold for you, and you can leave the leader at any time.',
  },
  detach: {
    button: 'Leave leader',
    title: 'Leave this leader?',
    effect: 'The follow ends. Positions already open become yours to manage. Nothing is sold for you.',
  },
  flatten: {
    button: 'Close copied positions',
    title: 'Close copied positions and leave?',
    effect: 'Your copied positions are closed at the market price, then the follow ends. Prices can move and fees apply.',
  },
};

export function FollowActions({ follow, api, guard, onDone }: { follow: Follow; api: RoomApi; guard: WriteGuard; onDone: () => void }) {
  const { t } = roomCopy.useCopy();
  const [asking, setAsking] = useState<FollowAction | null>(null);
  const allowed = allowedActions(follow);
  const order: FollowAction[] = ['pause', 'resume', 'stop', 'detach', 'flatten'];
  const send = (action: FollowAction) => {
    setAsking(null);
    void guard.run(
      { kind: 'copy', id: follow.followId, symbol: follow.permittedMarkets.join(','), operation: action },
      () =>
        action === 'flatten'
          ? api.flatten(follow.followId)
          : action === 'stop'
            ? api.stop(follow.followId)
            : api.followAction(action, follow.followId),
      onDone,
    );
  };
  return (
    <div className="cb-actions">
      <div className="cb-action-row">
        {order.map((action) => (
          <Button
            key={action}
            variant={action === 'flatten' ? 'secondary' : 'secondary'}
            size={32}
            disabled={allowed[action] !== null || guard.busy || guard.locked}
            onClick={() => setAsking(action)}
          >
            {t(ACTION_COPY[action].button as 'Pause')}
          </Button>
        ))}
      </div>
      <ul className="cb-why">
        {order
          .filter((action) => allowed[action] !== null)
          .map((action) => (
            <li key={action}>
              {t(ACTION_COPY[action].button as 'Pause')}: {t(allowed[action]! as 'Only an active follow can be paused')}
            </li>
          ))}
      </ul>
      {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          {asking ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t(ACTION_COPY[asking].title as 'Pause this follow?')}</AlertDialogTitle>
                <AlertDialogDescription>{t(ACTION_COPY[asking].effect as 'Pause')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="secondary" />}>{t('Not now')}</AlertDialogClose>
                <Button onClick={() => send(asking)}>{t(ACTION_COPY[asking].button as 'Pause')}</Button>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Whether this follow can have automatic copying turned on or off, and the reason when it cannot. */
export function copyingSwitch(follow: Follow): { on: boolean; blocked: string | null } {
  const on = follow.sessionKeyGranted && !follow.sessionKeyRevoked;
  const state = follow.relationshipState.toUpperCase();
  if (on) return { on, blocked: null };
  return { on, blocked: state === 'ACTIVE' || state === 'PAUSED' ? null : 'This follow has already stopped' };
}

function CopyingSwitch({ follow, api, guard, onDone }: { follow: Follow; api: RoomApi; guard: WriteGuard; onDone: () => void }) {
  const { t } = roomCopy.useCopy();
  const { on, blocked } = copyingSwitch(follow);
  const send = () =>
    void guard.run(
      { kind: 'copy', id: follow.followId, symbol: follow.permittedMarkets.join(','), operation: on ? 'copying-off' : 'copying-on' },
      () => (on ? api.stopCopying(follow.followId) : api.grantCopying(follow.followId)),
      onDone,
    );
  return (
    <div className="cb-actions">
      <p>
        {on && isCloseOnly(follow)
          ? t('Only the leader’s closes are copied for you. Turning automatic copying off stops those too.')
          : on
            ? t('Each new trade the leader makes is copied for you, within your limits.')
            : t('Trades are not copied for you until you turn on automatic copying.')}
      </p>
      <div className="cb-action-row">
        <Button variant="secondary" size={32} disabled={blocked !== null || guard.busy || guard.locked} onClick={send}>
          {on ? t('Turn off automatic copying') : t('Turn on automatic copying')}
        </Button>
      </div>
      {blocked ? <p className="cb-why">{t(blocked as 'This follow has already stopped')}</p> : null}
    </div>
  );
}

const sideWord = (side: CopyPosition['side']) => (side === 'buy' ? 'Buy' : 'Sell');
const ORDER_STATE: Record<string, string> = {
  pending: 'Sending',
  open: 'Open',
  filled: 'Filled',
  cancelled: 'Cancelled',
  rejected: 'Refused',
  expired: 'Expired',
  recovery_required: 'Being checked',
  hold_unknown: 'Being checked',
};

function CopiedOrders({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.followPositions(follow.followId, signal), `positions:${follow.followId}`);
  const columns: TableColumn<CopyPosition>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.market, pin: 'start' },
    { id: 'side', header: t('Side'), value: (r) => t(sideWord(r.side) as 'Buy') },
    { id: 'qty', header: t('Amount'), value: (r) => r.qty, numeric: true, cell: (r) => displayAmount(r.qty) },
    { id: 'filled', header: t('Filled'), value: (r) => r.filledQty, numeric: true, cell: (r) => displayAmount(r.filledQty) },
    { id: 'price', header: t('Price'), value: (r) => r.price, numeric: true, cell: (r) => displayAmount(r.price) },
    { id: 'status', header: t('State'), value: (r) => t((ORDER_STATE[r.status] ?? 'Unknown state') as 'Open') },
    { id: 'placed', header: t('Placed'), value: (r) => new Date(r.placedAt).toLocaleString(), width: 200 },
  ];
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  return (
    <Table
      label={t('Copied orders')}
      columns={columns}
      rows={resource.status === 'ready' ? resource.data.positions : []}
      getRowId={(r) => r.orderId}
      status={resource.status === 'loading' ? 'loading' : 'ready'}
      minWidth={760}
      emptyState={
        <EmptyState
          size="inline"
          title={t('No copied orders')}
          reason={t('A copy appears here when the leader trades and automatic copying is on.')}
        />
      }
    />
  );
}

export function FollowDetail({
  follow,
  onClose,
  api,
  guard,
  onChanged,
}: {
  follow: Follow | null;
  onClose: () => void;
  api: RoomApi;
  guard: WriteGuard;
  onChanged: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const [tab, setTab] = useState<CopiesTab>('orders');
  return (
    <Dialog open={follow !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="cb-dialog">
        {follow ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Follow of {leader}', { leader: follow.leaderRef ?? follow.leaderId ?? '' })}</DialogTitle>
              <DialogDescription>
                <Badge tone={STATE_TONE[follow.relationshipState.toUpperCase()] ?? 'neutral'}>
                  {t(stateWord(follow.relationshipState) as 'Active')}
                </Badge>{' '}
                {follow.newIntentFenced ? t('New trades are not being copied') : t('New trades are being copied')}
              </DialogDescription>
            </DialogHeader>
            {isCloseOnly(follow) ? (
              <InfoNote tone="warn">
                {copyingSwitch(follow).on
                  ? t('Close-only: the leader’s closes still close your copied positions.')
                  : t('Close-only: turn on automatic copying for the leader’s closes to close your copied positions.')}
              </InfoNote>
            ) : null}
            <h3 className="cb-h3">{t('Your limits')}</h3>
            <KeyValue
              items={[
                { label: t('Markets'), value: follow.permittedMarkets.join(', ') },
                { label: t('Most per order'), value: withAsset(follow.maxNotionalPerOrder, quoteAsset(follow)) },
                { label: t('Most in total'), value: withAsset(follow.maxAggregateExposure, quoteAsset(follow)) },
                {
                  label: t('Fixed amount per copied order'),
                  value: follow.fixedOrderSize ? withAsset(follow.fixedOrderSize, quoteAsset(follow)) : t('Not set'),
                },
                {
                  label: t('Reserved for this copy'),
                  value: !follow.reserve
                    ? t('Not set')
                    : follow.reserve.released
                      ? t('Released')
                      : withAsset(follow.reserve.amount, follow.reserve.asset),
                },
                {
                  label: t('Stop at a loss of'),
                  value: follow.maxLoss === null ? t('Not set') : withAsset(follow.maxLoss, quoteAsset(follow)),
                },
                { label: t('Used now'), value: withAsset(follow.currentExposure, quoteAsset(follow)) },
                { label: t('Left to use'), value: withAsset(follow.remainingExposure, quoteAsset(follow)) },
                { label: t('Permission ends'), value: new Date(follow.expiresAt).toLocaleString() },
                { label: t('Country'), value: follow.region },
                {
                  label: t('Copy permission'),
                  value: follow.sessionKeyRevoked ? t('Withdrawn') : follow.sessionKeyGranted ? t('Granted') : t('Not granted'),
                },
              ]}
            />
            <h3 className="cb-h3">{t('Result so far')}</h3>
            <KeyValue
              items={[
                { label: t('Profit or loss'), value: null, hint: t('The service does not report it') },
                { label: t('Fees paid'), value: null, hint: t('The service does not report it') },
                { label: t('Leader profit share'), value: null, hint: t('Not set by the platform') },
              ]}
            />
            <Tabs value={tab} onValueChange={(next) => setTab(next as CopiesTab)}>
              <TabsList divider aria-label={t('What was copied')}>
                <TabsTab value="orders">{t('Copied orders')}</TabsTab>
                <TabsTab value="positions">{t('Positions')}</TabsTab>
                <TabsTab value="skipped">{t('Skipped')}</TabsTab>
              </TabsList>
              <TabsPanel value="orders">{tab === 'orders' ? <CopiedOrders follow={follow} api={api} /> : null}</TabsPanel>
              <TabsPanel value="positions">
                {tab === 'positions' ? <CopiedPositions follow={follow} api={api} guard={guard} /> : null}
              </TabsPanel>
              <TabsPanel value="skipped">{tab === 'skipped' ? <SkippedCopies follow={follow} api={api} /> : null}</TabsPanel>
            </Tabs>
            <h3 className="cb-h3">{t('Automatic copying')}</h3>
            <CopyingSwitch follow={follow} api={api} guard={guard} onDone={onChanged} />
            <h3 className="cb-h3">{t('Change this follow')}</h3>
            <FollowActions follow={follow} api={api} guard={guard} onDone={onChanged} />
            <InfoNote>
              {t(
                'A position you copied is sold only when you close it, when you choose Close copied positions, or after a stop when the leader closes that trade.',
              )}
            </InfoNote>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
