import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiKeyRotateOutput } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { Button, Failure } from '../../shared/ui';
import { useSession } from '../session/session';
import { ShownOnce } from './ApiKeyCreate';
import { approveRotationRequest, readRotationRequest, type RotationRequestRead } from './developer-keys-api';

const copy = defineCopy('api-key-rotation-request', {
  title: 'Rotation request',
  body: 'This key asked to be rotated on {at}. Only you, signed in here, can approve it; the key itself cannot.',
  overlap: 'The old key keeps working for {seconds} seconds after you approve.',
  noOverlap: 'The old key stops working as soon as you approve.',
  approve: 'Approve the rotation',
  sending: 'Approving…',
  endsAt: 'The old key stops working at {at}.',
  replayed: 'This key was already rotated. Its replacement was shown once when it was made and is in your list.',
});

/**
 * A key's own rotation request on its detail page (DV-keys-04, J-developer-07 #3). The key asked through the API; the
 * owner approves here with a passkey, and the one replacement is shown once. A spent request is not shown again.
 */
export function RotationRequest({ keyId }: { keyId: string }) {
  const { t, requestedLocale } = copy.useCopy();
  const { api } = useSession();
  const [read, setRead] = useState<RotationRequestRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [made, setMade] = useState<ApiKeyRotateOutput | null>(null);
  const sending = useRef(false);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );

  useEffect(() => {
    const abort = new AbortController();
    void readRotationRequest(api, keyId, abort.signal).then((answer) => {
      if (abort.signal.aborted) return;
      if (answer.ok) setRead(answer.data);
      else setFailure(answer);
    });
    return () => abort.abort();
  }, [api, keyId]);

  async function approve(requestId: string) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await approveRotationRequest(api, requestId);
      if (answer.ok) {
        setMade(answer.data);
        setRead({ request: null });
      } else setFailure(answer);
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

  if (made) {
    return made.key !== null ? (
      <>
        <ShownOnce made={{ ...made, key: made.key }} onDone={() => setMade(null)} />
        {ends}
      </>
    ) : (
      <>
        <p role="status">{t('replayed')}</p>
        {ends}
      </>
    );
  }
  const request = read?.request;
  if (!request) return failure ? <Failure result={failure} /> : null;
  return (
    <section aria-labelledby="api-keys__rotation-request" className="security__card">
      <h2 id="api-keys__rotation-request">{t('title')}</h2>
      <p>{t('body', { at: `${when.format(new Date(request.createdAt))} UTC` })}</p>
      <p>{request.overlapSeconds > 0 ? t('overlap', { seconds: request.overlapSeconds }) : t('noOverlap')}</p>
      {failure && <Failure result={failure} />}
      <Button onClick={() => void approve(request.requestId)} disabled={busy}>
        {busy ? t('sending') : t('approve')}
      </Button>
    </section>
  );
}
