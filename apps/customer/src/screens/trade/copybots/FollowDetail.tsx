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
  type BadgeTone,
} from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import type { z } from 'zod';
import type { copyFollowSchema } from '../../../features/trade/tool-api';
import type { RoomApi } from './api';
import { roomCopy } from './copy';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';

export type Follow = z.infer<typeof copyFollowSchema>;
export type FollowAction = 'pause' | 'resume' | 'stop' | 'detach' | 'flatten';

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
  STOPPED: 'neutral',
  DETACHED: 'neutral',
};
export function stateWord(state: string): string {
  const word: Record<string, string> = { ACTIVE: 'Active', PAUSED: 'Paused', STOPPING: 'Stopping', STOPPED: 'Stopped', DETACHED: 'Left' };
  return word[state.toUpperCase()] ?? 'Unknown state';
}

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
    effect: 'New trades stop being copied and the permission is withdrawn. Positions already open stay yours. Nothing is sold for you.',
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
      () => (action === 'flatten' ? api.flatten(follow.followId) : api.followAction(action, follow.followId)),
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
              ]}
            />
            <h3 className="cb-h3">{t('Copied orders')}</h3>
            <EmptyState
              size="inline"
              variant="unavailable"
              title={t('No order history')}
              reason={t('The list of orders copied for you is not available from the service. Check Order history on the spot desk.')}
              action={{ label: t('Open order history'), href: '/money/activity?tab=orders', variant: 'secondary' }}
            />
            <h3 className="cb-h3">{t('Change this follow')}</h3>
            <FollowActions follow={follow} api={api} guard={guard} onDone={onChanged} />
            <InfoNote>{t('Positions already open are never sold unless you choose Close copied positions.')}</InfoNote>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
