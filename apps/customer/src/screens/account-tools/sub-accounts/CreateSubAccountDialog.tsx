import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useToast } from '@intafaced/ui';
import { useSession } from '../../../features/session/session';
import { subAccountsCopy } from './copy';
import { classifyCreateFailure, createSubAccount, labelError, LABEL_MAX, purposeError, PURPOSE_MAX, type CreateFailureKind } from './model';

export function CreateSubAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = subAccountsCopy.useCopy();
  const { api } = useSession();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CreateFailureKind | null>(null);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const labelProblem = labelError(label);
  const purposeProblem = purposeError(purpose);

  function change(next: boolean) {
    if (!next) {
      setLabel('');
      setPurpose('');
      setTouched(false);
      setFailure(null);
      setBusy(false);
    }
    onOpenChange(next);
  }

  async function submit() {
    setTouched(true);
    if (labelProblem || purposeProblem || working.current) return;
    working.current = true;
    setBusy(true);
    setFailure(null);
    const result = await createSubAccount(api, { label, purpose });
    working.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      toast.add({ title: t('created toast') });
      onCreated();
      change(false);
      return;
    }
    setFailure(classifyCreateFailure(result));
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="tools-dialog max-w-lg" closeLabel={t('cancel')}>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('create title')}</DialogTitle>
            <DialogDescription>{t('create body')}</DialogDescription>
          </DialogHeader>
          <div className="tools-field">
            <label htmlFor="sub-name" className="tools-label">
              {t('name label')}
            </label>
            <input
              id="sub-name"
              className="tools-input"
              value={label}
              maxLength={LABEL_MAX + 20}
              autoComplete="off"
              aria-invalid={touched && labelProblem !== null}
              aria-describedby="sub-name-hint"
              onChange={(event) => setLabel(event.target.value)}
            />
            <p id="sub-name-hint" className={touched && labelProblem ? 'tools-hint tools-hint--bad' : 'tools-hint'}>
              {touched && labelProblem === 'empty' ? t('name empty') : touched && labelProblem === 'long' ? t('name long') : ' '}
            </p>
          </div>
          <div className="tools-field">
            <label htmlFor="sub-purpose" className="tools-label">
              {t('purpose label')}
            </label>
            <input
              id="sub-purpose"
              className="tools-input"
              value={purpose}
              maxLength={PURPOSE_MAX + 20}
              autoComplete="off"
              aria-invalid={purposeProblem !== null}
              aria-describedby="sub-purpose-hint"
              onChange={(event) => setPurpose(event.target.value)}
            />
            <p id="sub-purpose-hint" className={purposeProblem ? 'tools-hint tools-hint--bad' : 'tools-hint'}>
              {purposeProblem ? t('purpose long') : t('purpose hint')}
            </p>
          </div>
          <Failure kind={failure} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => change(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              {busy ? t('creating') : t('create submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Failure({ kind }: { kind: CreateFailureKind | null }) {
  const { t } = subAccountsCopy.useCopy();
  if (!kind) return null;
  if (kind === 'uncertain')
    return (
      <div className="tools-callout tools-callout--warn" role="alert">
        <p className="tools-callout__title">{t('uncertain title')}</p>
        <p>{t('uncertain body')}</p>
      </div>
    );
  if (kind === 'signed-out')
    return (
      <div className="tools-callout" role="alert">
        <p>{t('signed out')}</p>
        <a className="text-link" href="/login">
          {t('sign in')}
        </a>
      </div>
    );
  return (
    <p className="tools-note tools-note--bad" role="alert">
      {kind === 'not-open' ? t('not open') : kind === 'limit' ? t('limit') : kind === 'on-hold' ? t('on hold') : t('other failed')}
    </p>
  );
}
