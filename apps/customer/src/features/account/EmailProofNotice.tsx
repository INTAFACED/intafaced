import { useEffect, useState } from 'react';
import { useSession } from '../session/session';
import { fetchMe } from '../../data/identity';
import { emailProofNoticeCopy } from './email-proof-notice-copy';

/**
 * The trade-room gate notice (RC-identity-01, J-identity-01 step 8). svc-trade refuses a new custodial order while the
 * email is unproved; this says so before the person tries, and links to Account, where the confirmation link is sent.
 * Shows only when the service says the address is unproved: signed out, unknown or proved shows nothing.
 */
export function EmailProofNotice() {
  const { t } = emailProofNoticeCopy.useCopy();
  const { api, userId } = useSession();
  const [unproved, setUnproved] = useState(false);

  useEffect(() => {
    setUnproved(false);
    if (!userId) return;
    const controller = new AbortController();
    void fetchMe(api, controller.signal).then((me) => {
      if (controller.signal.aborted || me.kind !== 'ok' || me.userId !== userId) return;
      setUnproved(me.emailVerified === false);
    });
    return () => controller.abort();
  }, [api, userId]);

  if (!unproved) return null;
  return (
    <section className="notice email-proof-notice" aria-labelledby="email-proof-notice-title">
      <h2 id="email-proof-notice-title">{t('title')}</h2>
      <p>{t('body')}</p>
      <a href="/uc/account">{t('action')}</a>
    </section>
  );
}
