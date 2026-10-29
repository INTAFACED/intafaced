import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import type { CopiedPosition, CopySkip, RoomApi } from './api';
import { roomCopy } from './copy';
import type { Follow } from './FollowDetail';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';

const POSITION_STATE: Record<CopiedPosition['status'], string> = {
  buying: 'Buying',
  open: 'Open',
  closing: 'Closing',
  closed: 'Closed',
};

/** While a copied buy or a close is still on its way, the list is read again this often, at most this many times. */
const SETTLING_REREAD_MS = 2_000;
const SETTLING_REREADS = 30;
const isZero = (amount: string) => /^0*(\.0*)?$/.test(amount);

/** The follow's copied positions, each with a close of the whole position or of a part (CB-copy-09/10). */
export function CopiedPositions({ follow, api, guard }: { follow: Follow; api: RoomApi; guard: WriteGuard }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.copiedPositions(follow.followId, signal), `copied:${follow.followId}`);
  const [closing, setClosing] = useState<CopiedPosition | null>(null);
  const [part, setPart] = useState<CopiedPosition | null>(null);
  const [amount, setAmount] = useState('');
  const [tooMuch, setTooMuch] = useState(false);
  // A re-read keeps the last list on screen instead of blanking it while it loads.
  const last = useRef<CopiedPosition[] | null>(null);
  if (resource.status === 'ready') last.current = resource.data.positions;
  const rows = last.current;
  const settling = resource.status === 'ready' && resource.data.positions.some((p) => p.status === 'buying' || p.status === 'closing');
  // A close whose outcome stays unknown stops the re-reads after a while; its Close sends the same order again.
  const rereads = useRef(0);
  useEffect(() => {
    if (!settling) {
      rereads.current = 0;
      return;
    }
    if (rereads.current >= SETTLING_REREADS) return;
    const timer = window.setTimeout(() => {
      rereads.current += 1;
      reload();
    }, SETTLING_REREAD_MS);
    return () => window.clearTimeout(timer);
  }, [settling, resource, reload]);

  const close = (position: CopiedPosition, qty?: string) => {
    setClosing(null);
    setPart(null);
    setTooMuch(false);
    rereads.current = 0;
    void guard
      .run(
        { kind: 'copy', id: `${follow.followId}:${position.positionId}`, symbol: position.market, operation: qty ? 'close-part' : 'close' },
        () => api.closePosition(follow.followId, position.positionId, qty),
        () => undefined,
      )
      .then(() => reload());
  };
  // The service's own check: more than is open is refused by its code and nothing is closed.
  const { failure, setFailure } = guard;
  useEffect(() => {
    if (failure?.code !== 'trade.copy_close_qty_exceeds') return;
    setTooMuch(true);
    setFailure(null);
  }, [failure, setFailure]);

  const columns: TableColumn<CopiedPosition>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.market, pin: 'start' },
    { id: 'bought', header: t('Amount'), value: (r) => r.bought, numeric: true, cell: (r) => displayAmount(r.bought) },
    { id: 'open', header: t('Open'), value: (r) => r.open, numeric: true, cell: (r) => displayAmount(r.open) },
    { id: 'status', header: t('State'), value: (r) => t(POSITION_STATE[r.status] as 'Open') },
    { id: 'share', header: t('Leader profit share'), value: () => t('Not set by the platform') },
    {
      id: 'actions',
      header: t('Action'),
      value: () => '',
      width: 200,
      cell: (r) => {
        const busy = guard.busy || guard.locked;
        // A close still settling can be sent again: the service resends that same order, never a second sell.
        const closeOff = busy || (isZero(r.open) && r.status !== 'closing');
        const partOff = busy || isZero(r.open);
        return (
          <span className="cb-action-row">
            <Button variant="secondary" size={32} disabled={closeOff} onClick={() => setClosing(r)}>
              {t('Close')}
            </Button>
            <Button
              variant="secondary"
              size={32}
              disabled={partOff}
              onClick={() => {
                setAmount('');
                setPart(r);
              }}
            >
              {t('Close part')}
            </Button>
          </span>
        );
      },
    },
  ];
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  return (
    <>
      {tooMuch ? <InfoNote tone="warn">{t('That is more than is open.')}</InfoNote> : null}
      <Table
        label={t('Copied positions')}
        columns={columns}
        rows={rows ?? []}
        getRowId={(r) => r.positionId}
        status={rows === null ? 'loading' : 'ready'}
        minWidth={760}
        emptyState={
          <EmptyState size="inline" title={t('No copied positions')} reason={t('A position appears here when a copied buy fills.')} />
        }
      />
      <InfoNote>{t('A close sells at the market price, within your slippage limit. Prices can move and fees apply.')}</InfoNote>
      <AlertDialog open={closing !== null} onOpenChange={(open) => !open && setClosing(null)}>
        <AlertDialogContent>
          {closing ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('Close this position?')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {isZero(closing.open)
                    ? t('The close of {amount} in {market} is still settling. Closing again sends that same order, never a second one.', {
                        amount: displayAmount(closing.closing),
                        market: closing.market,
                      })
                    : t('Sells the {amount} still open in {market} at the market price. The follow carries on.', {
                        amount: displayAmount(closing.open),
                        market: closing.market,
                      })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="secondary" />}>{t('Not now')}</AlertDialogClose>
                <Button onClick={() => close(closing)}>{t('Close')}</Button>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={part !== null} onOpenChange={(open) => !open && setPart(null)}>
        <DialogContent showCloseButton={false}>
          {part ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (amount.trim()) close(part, amount.trim());
              }}
            >
              <DialogHeader>
                <DialogTitle>{t('Close part of this position')}</DialogTitle>
                <DialogDescription>
                  {t('{amount} is open in {market}. The part you close is sold at the market price.', {
                    amount: displayAmount(part.open),
                    market: part.market,
                  })}
                </DialogDescription>
              </DialogHeader>
              <Field label={t('Amount')} required>
                <Input kind="decimal" value={amount} onValueChange={setAmount} precision={18} autoComplete="off" />
              </Field>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setPart(null)}>
                  {t('Not now')}
                </Button>
                <Button type="submit" disabled={!amount.trim()}>
                  {t('Close')}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

const SKIP_WORDS: Record<string, string> = {
  paused: 'You had paused this follow',
  stopped: 'You had stopped this follow',
  lead_stopped: 'The leader was stopped by the platform',
  risk_control: 'One of your risk controls held it back',
  insufficient_funds: 'Your balance did not cover it',
  max_copy_total: 'It would have gone past your limits',
  copy_slippage_exceeded: 'The price moved past your slippage limit',
  position_closed: 'Nothing you copied was left open to close',
  refused: 'The copy was refused',
};
/** The words for a skip reason id; an id this screen does not know reads as a plain refusal, never as the id. */
export const skipWords = (reason: string) => SKIP_WORDS[reason] ?? 'The copy was refused';

/** Leader trades this follow did not copy, newest first, each with its reason in words (CB-copy-11). */
export function SkippedCopies({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.skipLog(follow.followId, signal), `skips:${follow.followId}`);
  const columns: TableColumn<CopySkip>[] = [
    { id: 'at', header: t('When'), value: (r) => new Date(r.at).toLocaleString(), width: 200, pin: 'start' },
    { id: 'reason', header: t('Why it was not copied'), value: (r) => t(skipWords(r.reason) as 'Open') },
  ];
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  return (
    <Table
      label={t('Skipped copies')}
      columns={columns}
      rows={resource.status === 'ready' ? resource.data.items : []}
      getRowId={(r) => r.leaderFillId}
      status={resource.status === 'loading' ? 'loading' : 'ready'}
      minWidth={560}
      emptyState={<EmptyState size="inline" title={t('Nothing skipped')} reason={t('Every leader trade so far was copied.')} />}
    />
  );
}
