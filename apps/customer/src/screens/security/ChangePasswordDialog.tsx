import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Note,
  refusalCopy,
  TextField,
  useSession,
} from './deps';
import { securityScreenCopy } from './copy';
import { changePassword, outcomeOf, passwordProblem, type Outcome } from './change-password';

/**
 * Change password. One call to the service, which checks the current password, the rules, and (for an account with a second step)
 * that this sign-in passed it. A lost answer is shown as unknown and never sent again by this dialog.
 */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = securityScreenCopy.useCopy();
  const { api, userId } = useSession();
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [touched, setTouched] = useState(false);
  const live = useRef(true);
  const sent = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // A fresh dialog starts empty; the passwords never outlive it.
  useEffect(() => {
    if (open) return;
    setCurrent('');
    setNext('');
    setAgain('');
    setOutcome(null);
    setTouched(false);
    sent.current = false;
  }, [open]);

  const problem = passwordProblem(next);
  const mismatch = again.length > 0 && again !== next;
  const nextError = touched && next.length > 0 && problem ? t(problem === 'short' ? 'Too short' : 'Too long') : null;
  const done = outcome?.kind === 'changed';
  const unknown = outcome?.kind === 'unknown';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (busy || done || unknown || sent.current || !userId || !api.canWrite()) return;
    if (!current || problem || next !== again) return;
    sent.current = true;
    setBusy(true);
    setOutcome(null);
    const answer = await changePassword(api, { currentPassword: current, newPassword: next });
    if (!live.current) return;
    const result = outcomeOf(answer);
    setBusy(false);
    setOutcome(result);
    // Only a plain refusal may be tried again; a changed or unknown result is final for this dialog.
    if (result.kind !== 'changed' && result.kind !== 'unknown') sent.current = false;
    setCurrent('');
    if (result.kind === 'changed' || result.kind === 'unknown') {
      setNext('');
      setAgain('');
    }
  }

  const failure = outcome && !done ? words(outcome, t) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent closeLabel={t('Close')}>
        <form className="sk-dialog" onSubmit={(event) => void submit(event)} autoComplete="off">
          <DialogHeader>
            <DialogTitle>{t('Change password')}</DialogTitle>
            <DialogDescription>{t('Change password body')}</DialogDescription>
          </DialogHeader>
          {done ? (
            <Note tone="good" role="status">
              <p>{t('Password changed')}</p>
            </Note>
          ) : (
            <>
              <TextField
                label={t('Current password')}
                type="password"
                name="current-password"
                autoComplete="current-password"
                required
                disabled={busy || unknown}
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                error={outcome?.kind === 'wrongCurrent' ? t('Wrong current') : null}
              />
              <TextField
                label={t('New password')}
                type="password"
                name="new-password"
                autoComplete="new-password"
                required
                disabled={busy || unknown}
                value={next}
                hint={t('Password hint')}
                error={nextError}
                onBlur={() => setTouched(true)}
                onChange={(event) => setNext(event.target.value)}
              />
              <TextField
                label={t('Repeat new password')}
                type="password"
                name="repeat-password"
                autoComplete="new-password"
                required
                disabled={busy || unknown}
                value={again}
                error={mismatch ? t('Does not match') : null}
                onChange={(event) => setAgain(event.target.value)}
              />
            </>
          )}
          {failure && outcome?.kind !== 'wrongCurrent' ? (
            <Note tone={unknown ? 'warn' : 'error'} role="alert">
              <p>{failure}</p>
              {unknown ? (
                <p>
                  <a className="sk-link" href="/support">
                    {t('Contact support')}
                  </a>
                </p>
              ) : null}
            </Note>
          ) : null}
          <DialogFooter>
            {done || unknown ? (
              <Button type="button" variant="primary" size={40} onClick={onClose}>
                {t('Close')}
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" size={40} disabled={busy} onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" variant="primary" size={40} loading={busy} disabled={!current || !next || !again || mismatch}>
                  {t('Save password')}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function words(outcome: Outcome, t: ReturnType<typeof securityScreenCopy.useCopy>['t']): string | null {
  switch (outcome.kind) {
    case 'wrongCurrent':
      return t('Wrong current');
    case 'policy':
      return t('Policy refused');
    case 'same':
      return t('Same password');
    case 'secondStep':
      return t('Second step needed');
    case 'locked':
      return t('Too many tries');
    case 'signedOut':
      return t('Signed out');
    case 'unknown':
      return t('Change unknown');
    case 'other': {
      const copy = outcome.code ? refusalCopy(outcome.code) : null;
      return copy ? `${copy.title}. ${copy.body}` : t('Change failed');
    }
    default:
      return null;
  }
}
