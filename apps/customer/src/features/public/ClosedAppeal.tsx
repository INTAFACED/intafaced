import { useRef, useState } from 'react';
import { appealSchema } from '@intafaced/contracts/identity-appeals';
import { useSession } from '../session/session';
import { Button } from '../../shared/ui';
import { publicAuthCopy } from './public-auth-copy';

type Proof = { identifier: string; password: string };

/**
 * J-identity-14 #3: after sign-in names a closed account, the person may ask to appeal the closure. Identity proves the
 * account with the sign-in name and password exactly as sign-in did (`accountAppeal.submitSignedOut`) and refuses a
 * closed account with `identity.appeal_not_allowed`, which this says as "Appeal not allowed". `take` hands over the
 * details of the sign-in that was just refused, once, and forgets them, so the password is never kept after this send.
 * Nothing here signs in or reopens anything.
 */
export function ClosedAppeal({ take }: { take: () => Proof | null }) {
  const { t, languageFor } = publicAuthCopy.useCopy();
  const { api } = useSession();
  const [answer, setAnswer] = useState<'sending' | 'not_allowed' | 'sent' | 'failed' | null>(null);
  // One key per appeal: a retry after a lost answer is the same appeal.
  const requestKey = useRef<string>(crypto.randomUUID());

  async function send() {
    if (answer === 'sending') return;
    const proof = take();
    if (!proof) return setAnswer('failed');
    setAnswer('sending');
    const sent = await api.mutate(
      'identity',
      'accountAppeal.submitSignedOut',
      { ...proof, text: t('appealClosedText'), clientRequestId: requestKey.current },
      appealSchema,
    );
    setAnswer(sent.ok ? 'sent' : sent.code === 'identity.appeal_not_allowed' ? 'not_allowed' : 'failed');
  }

  const words =
    answer === 'not_allowed'
      ? 'appealClosedNotAllowed'
      : answer === 'sent'
        ? 'appealClosedSent'
        : answer === 'failed'
          ? 'appealClosedFailed'
          : null;
  return (
    <>
      {answer === null || answer === 'sending' ? (
        <Button variant="secondary" disabled={answer === 'sending'} onClick={() => void send()} lang={languageFor('stateAppealClosed')}>
          {answer === 'sending' ? t('appealClosedSending') : t('stateAppealClosed')}
        </Button>
      ) : null}
      {words && (
        <p data-testid="closed-appeal__answer" data-answer={answer} lang={languageFor(words)}>
          {t(words)}
        </p>
      )}
    </>
  );
}
