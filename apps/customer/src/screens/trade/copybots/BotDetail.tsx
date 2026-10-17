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
import type { z } from 'zod';
import type { algoProgressSchema, algoSchema } from '../../../features/trade/tool-api';
import { dec } from '../../../data/decimal';
import { displayAmount } from '../../../shared/money';
import type { RoomApi } from './api';
import { roomCopy } from './copy';
import type { Failure, WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

export type Algo = z.infer<typeof algoSchema>;
export type Progress = z.infer<typeof algoProgressSchema>;
export type BotAction = 'pause' | 'resume' | 'cancel';

export const BOT_TONE: Record<string, BadgeTone> = {
  active: 'lime',
  paused: 'warn',
  halted: 'error',
  cancelled: 'neutral',
  completed: 'neutral',
};
export const BOT_WORD: Record<string, string> = {
  active: 'Running',
  paused: 'Paused',
  halted: 'Halted',
  cancelled: 'Stopped',
  completed: 'Finished',
};

/** Percent of the total that has actually filled (from child fills only), with two places; null when unknown. */
export function percentFilled(filled: string, total: string): string | null {
  const f = dec(filled);
  const t = dec(total);
  if (f === null || t === null || t <= 0n) return null;
  const bp = (f * 10_000n) / t;
  const whole = bp / 100n;
  const frac = (bp % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

export function haltWords(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.startsWith('trade.')) return roomRefusal({ ok: false, reason: 'error', message: '', code: reason }).title;
  if (reason === 'cancel_incomplete')
    return roomRefusal({ ok: false, reason: 'error', message: '', code: 'trade.algo_cancel_incomplete' }).title;
  return 'It halted so you can check it';
}

const ACTIONS: Record<BotAction, { label: string; title: string; effect: string; allowed: (status: string) => boolean; why: string }> = {
  pause: {
    label: 'Pause',
    title: 'Pause this bot?',
    effect: 'No new slices are placed while it is paused. Slices already placed stay as they are.',
    allowed: (s) => s === 'active',
    why: 'Only a running bot can be paused',
  },
  resume: {
    label: 'Resume',
    title: 'Resume this bot?',
    effect: 'Slices start again. The run is not shortened to catch up.',
    allowed: (s) => s === 'paused',
    why: 'Only a paused bot can be resumed',
  },
  cancel: {
    label: 'Stop remaining slices',
    title: 'Stop this bot?',
    effect:
      'The slices not yet placed are cancelled and any open slice order is cancelled. Slices already filled stay filled. This cannot be undone.',
    allowed: (s) => s === 'active' || s === 'paused' || s === 'halted',
    why: 'This bot has already ended',
  },
};

export function BotDetail({
  algo,
  progress,
  failure,
  onClose,
  api,
  guard,
  onChanged,
}: {
  algo: Algo | null;
  progress: Progress | null;
  failure: Failure | null;
  onClose: () => void;
  api: RoomApi;
  guard: WriteGuard;
  onChanged: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const [asking, setAsking] = useState<BotAction | null>(null);
  const send = (action: BotAction) => {
    if (!algo) return;
    setAsking(null);
    void guard.run({ kind: 'algo', id: algo.id, symbol: algo.symbol, operation: action }, () => api.algoAction(action, algo.id), onChanged);
  };
  const halted = algo ? haltWords(progress?.haltReason ?? algo.haltReason) : null;
  const order: BotAction[] = ['pause', 'resume', 'cancel'];
  return (
    <Dialog open={algo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="cb-dialog">
        {algo ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {algo.kind.toUpperCase()} · {algo.symbol} · {algo.side === 'buy' ? t('Buy') : t('Sell')}
              </DialogTitle>
              <DialogDescription>
                <Badge tone={BOT_TONE[algo.status] ?? 'neutral'}>{t((BOT_WORD[algo.status] ?? 'Unknown state') as 'Running')}</Badge>{' '}
                <span className="cb-mono">{algo.id}</span>
              </DialogDescription>
            </DialogHeader>
            {halted ? <InfoNote tone="warn">{t(halted as 'It halted so you can check it')}</InfoNote> : null}
            {failure ? <RefusalNote failure={failure} /> : null}
            <h3 className="cb-h3">{t('Progress')}</h3>
            <div className="cb-progress">
              <progress
                max={100}
                value={percentFilled(progress?.filledQty ?? '0', algo.totalQty)?.replace('%', '') ?? '0'}
                aria-label={t('Filled so far')}
              />
              <span>{percentFilled(progress?.filledQty ?? '', algo.totalQty) ?? '—'}</span>
            </div>
            <KeyValue
              items={[
                {
                  label: t('Filled so far'),
                  value: progress ? `${displayAmount(progress.filledQty)} of ${displayAmount(algo.totalQty)}` : null,
                  hint: t('Counted from the filled slice orders only'),
                },
                { label: t('Slices placed'), value: `${progress?.childrenEmitted ?? algo.childrenEmitted} of ${algo.slicesPlanned}` },
                { label: t('Slices missed'), value: String(progress?.missesRecorded ?? algo.missesRecorded) },
                { label: t('Next slice number'), value: String((progress?.nextSliceIndex ?? algo.nextSliceIndex) + 1) },
                { label: t('Expected to finish'), value: new Date(algo.projectedEndsAt).toLocaleString() },
                { label: t('Started'), value: new Date(algo.createdAt).toLocaleString() },
              ]}
            />
            <h3 className="cb-h3">{t('Risk limits')}</h3>
            <KeyValue
              items={[
                { label: t('Total to trade'), value: displayAmount(algo.totalQty) },
                {
                  label: t('Price limit'),
                  value: algo.limitPrice === null ? t('None, slices trade at the market') : displayAmount(algo.limitPrice),
                },
                { label: t('Gap between slices'), value: `${Math.round(algo.sliceIntervalMs / 1000)} s` },
                { label: t('Loss limit'), value: t('Not applicable: this bot only splits one order') },
              ]}
            />
            <h3 className="cb-h3">{t('Result')}</h3>
            <KeyValue
              items={[
                { label: t('Average price'), value: null, hint: t('The service does not report it yet') },
                { label: t('Cost versus the start price'), value: null, hint: t('The service does not report it yet') },
              ]}
            />
            <EmptyState
              size="inline"
              variant="unavailable"
              title={t('Slice orders aren’t listed here yet')}
              reason={t('The service does not link a bot to its slice orders yet. Open the spot desk to see them in Order history.')}
              action={{ label: t('Open order history'), href: '/money/activity?tab=orders', variant: 'secondary' }}
            />
            <div className="cb-action-row">
              {order.map((action) => (
                <Button
                  key={action}
                  variant="secondary"
                  size={32}
                  disabled={!ACTIONS[action].allowed(algo.status) || guard.busy || guard.locked}
                  onClick={() => setAsking(action)}
                >
                  {t(ACTIONS[action].label as 'Pause')}
                </Button>
              ))}
              <Button variant="ghost" size={32} onClick={onChanged}>
                {t('Refresh')}
              </Button>
            </div>
            <ul className="cb-why">
              {order
                .filter((action) => !ACTIONS[action].allowed(algo.status))
                .map((action) => (
                  <li key={action}>
                    {t(ACTIONS[action].label as 'Pause')}: {t(ACTIONS[action].why as 'Only a running bot can be paused')}
                  </li>
                ))}
            </ul>
            {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
            <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
              <AlertDialogContent>
                {asking ? (
                  <>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t(ACTIONS[asking].title as 'Pause this bot?')}</AlertDialogTitle>
                      <AlertDialogDescription>{t(ACTIONS[asking].effect as 'Pause')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="secondary" />}>{t('Not now')}</AlertDialogClose>
                      <Button onClick={() => send(asking)}>{t(ACTIONS[asking].label as 'Pause')}</Button>
                    </AlertDialogFooter>
                  </>
                ) : null}
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
