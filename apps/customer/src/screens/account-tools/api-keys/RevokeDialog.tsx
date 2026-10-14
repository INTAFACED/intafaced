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
import { apiKeysCopy } from './copy';
import { revokeKey, type ApiKeyRow } from './model';

/** Confirms, then revokes. The key's name is repeated so the wrong row is easy to catch. */
export function RevokeDialog({ target, onClose, onRevoked }: { target: ApiKeyRow | null; onClose: () => void; onRevoked: () => void }) {
  const { t } = apiKeysCopy.useCopy();
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
    const result = await revokeKey(api, target.id);
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      toast.add({ title: result.data.revoked ? t('revoked toast') : t('already revoked toast') });
      onRevoked();
      onClose();
      return;
    }
    setProblem(result.reason === 'uncertain' ? 'unsure' : 'failed');
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('revoke title')}</AlertDialogTitle>
          <AlertDialogDescription>{target ? t('revoke body', { name: target.name }) : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        {problem ? (
          <p className="tools-note tools-note--bad" role="alert">
            {problem === 'unsure' ? t('revoke unsure') : t('revoke failed')}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" disabled={busy} />}>{t('cancel')}</AlertDialogClose>
          <Button variant="sell" loading={busy} disabled={busy} onClick={() => void confirm()}>
            {busy ? t('revoking') : t('revoke submit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
