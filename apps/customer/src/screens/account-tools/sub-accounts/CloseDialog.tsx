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
  useToast,
} from '@intafaced/ui';
import { useSession } from '../../../features/session/session';
import { subAccountsCopy } from './copy';
import { closeSubAccount, type SubAccountRow } from './model';

export function CloseDialog({ target, onClose, onClosed }: { target: SubAccountRow | null; onClose: () => void; onClosed: () => void }) {
  const { t } = subAccountsCopy.useCopy();
  const { api } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'failed' | 'unsure' | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setProblem(null);
    setBusy(false);
  }, [target?.id]);

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await closeSubAccount(api, target.id);
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      toast.add({ title: result.data.revoked ? t('closed toast') : t('already closed toast') });
      onClosed();
      onClose();
      return;
    }
    setProblem(result.reason === 'uncertain' ? 'unsure' : 'failed');
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('close title')}</AlertDialogTitle>
          <AlertDialogDescription>{target ? t('close body', { name: target.label }) : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        {problem ? (
          <p className="tools-note tools-note--bad" role="alert">
            {problem === 'unsure' ? t('close unsure') : t('close failed')}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" disabled={busy} />}>{t('cancel')}</AlertDialogClose>
          <Button variant="sell" loading={busy} disabled={busy} onClick={() => void confirm()}>
            {busy ? t('closing') : t('close submit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
