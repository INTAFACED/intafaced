import { useMemo, useRef, useState } from 'react';
import { API_KEY_ROTATE_REFUSALS, type ApiKeyRotateOutput } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { Button, Dialog, Failure, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { ShownOnce } from './ApiKeyCreate';
import { rotateDeveloperKey } from './developer-keys-api';

const copy = defineCopy('api-key-rotate', {
  open: 'Rotate',
  title: 'Rotate this key',
  body: 'Makes a new key with the same name, permissions, IP list and end date. The old key keeps working for the overlap, so a running program can move to the new key without stopping, then it stops.',
  overlap: 'Overlap (seconds)',
  overlapHint: '0 stops the old key at once.',
  overlapInvalid: 'Enter a whole number of seconds, 0 or more.',
  confirm: 'Create with a passkey',
  sending: 'Rotating…',
  endsAt: 'The old key stops working at {at}.',
  replayed: 'This key was already rotated. Its replacement was shown once when it was made and is in your list.',
  'refused.auth.step_up_required': 'Confirm it is you with your passkey first. Nothing was changed.',
  'refused.auth.step_up_expired': 'Your confirmation expired. Confirm with your passkey again. Nothing was changed.',
  'refused.auth.mfa_invalid': 'That confirmation did not work. Nothing was changed.',
  'refused.auth.webauthn_invalid': 'The passkey did not confirm. Nothing was changed.',
  'refused.identity.delegated_refused': 'Only you, signed in on a device, can rotate a key here. Nothing was changed.',
  'refused.identity.key_not_found': 'No key with this id on your account. Nothing was changed.',
  'refused.identity.key_not_live': 'This key is revoked or has ended; make a new key instead. Nothing was changed.',
  'refused.identity.key_rotate_overlap_unset':
    'The longest overlap is not set, so a rotation with an overlap is refused. Rotate with an overlap of 0. Nothing was changed.',
  'refused.identity.key_rotate_overlap_too_long': 'That overlap is longer than the longest allowed. Nothing was changed.',
  'refused.identity.key_signing_unset': 'Keys that place orders sign every request, and signing is not set up. Nothing was changed.',
});

type Refused = (typeof API_KEY_ROTATE_REFUSALS)[number];
const REFUSED = new Set<string>(API_KEY_ROTATE_REFUSALS);

/**
 * Rotate on the key detail (DV-keys-04, J-developer-07 #1 #2). The new key and its signing secret are shown once, with the
 * instant the old key stops. A lost reply leaves the dialog open: sending again answers with the replacement already made.
 */
export function RotateKey({ keyId, onRotated }: { keyId: string; onRotated: () => void }) {
  const { t, requestedLocale } = copy.useCopy();
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overlap, setOverlap] = useState('60');
  const [invalid, setInvalid] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [made, setMade] = useState<ApiKeyRotateOutput | null>(null);
  const sending = useRef(false);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );

  async function rotate() {
    if (sending.current) return;
    const seconds = Number(overlap.trim());
    setInvalid(false);
    if (!/^\d+$/.test(overlap.trim()) || !Number.isSafeInteger(seconds)) return setInvalid(true);
    sending.current = true;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    try {
      const answer = await rotateDeveloperKey(api, keyId, seconds);
      if (answer.ok) {
        setOpen(false);
        setMade(answer.data);
        onRotated();
        return;
      }
      if (answer.code && REFUSED.has(answer.code)) setRefused(answer.code as Refused);
      else setFailure(answer);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const ends = made ? (
    <p data-testid="api-keys__overlap-ends">
      {t('endsAt', { at: `${when.format(new Date(made.replaced.endsAt))} UTC` })} <time dateTime={made.replaced.endsAt} />
    </p>
  ) : null;

  return (
    <>
      {made && made.key !== null && (
        <>
          <ShownOnce made={{ ...made, key: made.key }} onDone={() => setMade(null)} />
          {ends}
        </>
      )}
      {made && made.key === null && (
        <>
          <p role="status">{t('replayed')}</p>
          {ends}
        </>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          setMade(null);
          setOpen(true);
        }}
      >
        {t('open')}
      </Button>
      {open && (
        <Dialog title={t('title')} onClose={() => !busy && setOpen(false)}>
          <p>{t('body')}</p>
          <Field
            label={t('overlap')}
            hint={t('overlapHint')}
            name="overlap"
            inputMode="numeric"
            value={overlap}
            error={invalid ? t('overlapInvalid') : undefined}
            onChange={(event) => setOverlap(event.currentTarget.value)}
          />
          {refused && (
            <p className="error-text" role="alert">
              {t(`refused.${refused}`)}
            </p>
          )}
          {failure && <Failure result={failure} />}
          <div className="api-keys__actions">
            <Button onClick={() => void rotate()} disabled={busy}>
              {busy ? t('sending') : t('confirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
