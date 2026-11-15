import { useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { Button, Dialog, Failure } from '../../shared/ui';
import { useSession } from '../session/session';

const copy = defineCopy('api-keys-revoke-all', {
  open: 'Revoke all keys',
  title: 'Revoke all your API keys',
  body: 'Every live key on this account stops working at once, and every program using one is refused. This cannot be undone: make new keys afterwards.',
  confirm: 'Revoke all',
  sending: 'Revoking…',
  cancel: 'Cancel',
  done: 'Every live key is revoked.',
});

// hand-declared-ok: svc-identity's revokeAllApiKeys output (api-key-revoke-all-router.ts) has no contracts schema.
const revokeAllSchema = z.object({ userId: z.string(), revoked: z.number().int() });

/**
 * Revoke every live key of the signed-in person (DV-keys-04, J-developer-07 #5), from the key list. The service revokes
 * only the caller's own keys: it takes the person from the session and refuses any other account.
 */
export function RevokeAllKeys({ liveKeys, onDone }: { liveKeys: number; onDone: () => void }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [done, setDone] = useState(false);
  const sending = useRef(false);

  async function revokeAll() {
    if (sending.current || !userId) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'revokeAllApiKeys', { userId }, revokeAllSchema);
      if (answer.ok) {
        setOpen(false);
        setDone(true);
        onDone();
        return;
      }
      setFailure(answer);
      // An unknown outcome may have landed: read the list again rather than guess.
      if (answer.reason === 'uncertain') onDone();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {done && <p role="status">{t('done')}</p>}
      {liveKeys > 0 && (
        <Button
          variant="secondary"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          {t('open')}
        </Button>
      )}
      {open && (
        <Dialog title={t('title')} onClose={() => !busy && setOpen(false)}>
          <p>{t('body')}</p>
          {failure && <Failure result={failure} />}
          <div className="api-keys__actions">
            <Button onClick={() => void revokeAll()} disabled={busy}>
              {busy ? t('sending') : t('confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t('cancel')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
