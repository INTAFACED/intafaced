import { useState } from 'react';
import { useSession } from '../features/session/session';
import { shellCopy } from './shell-copy';

/**
 * Says why the server ended the session, when it said so, and which sub-account a tab acts as. A signed-out notice is
 * gone as soon as someone signs in again.
 */
export function SessionNotice() {
  const { t } = shellCopy.useCopy();
  const { notice, session } = useSession();
  if (session?.subAccountId) return <SubaccountBar />;
  if (session) {
    // Signed in on the main account: only the sub-account notice applies (the tab went back to main on its own).
    return notice === 'subaccount_ended' ? (
      <p className="tb-note" role="alert">
        {t('This tab is back on your main account: the sub-account could not be confirmed again. Use it again from Account.')}
      </p>
    ) : null;
  }
  if (notice === 'reused')
    return (
      <p className="tb-note" role="status">
        {t('You were signed out because your sign-in was used elsewhere.')}
      </p>
    );
  if (notice === 'idle')
    return (
      <p className="tb-note" role="status">
        {t('You were signed out because this sign-in was not used for longer than your idle sign-out time.')}
      </p>
    );
  if (notice === 'frozen')
    return (
      <p className="tb-note" role="status">
        {t('This account is frozen, so you were signed out. Contact support to find out why.')}
      </p>
    );
  return null;
}

/** While this tab acts as a sub-account (I-account-lifecycle-04): which one, and the way back to the main account. */
function SubaccountBar() {
  const { t } = shellCopy.useCopy();
  const { session, subAccountWaiting, leaveSubAccount } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  async function leave() {
    setState('busy');
    const outcome = await leaveSubAccount();
    setState(outcome.kind === 'session' || outcome.kind === 'signed_out' ? 'idle' : 'failed');
  }
  return (
    <section className="tb-note" role="region" aria-label={t('Sub-account in use')}>
      <p>
        {t('You are using sub-account {label} in this tab.', { label: session?.subAccountLabel || session?.subAccountId || '' })}{' '}
        <span lang="zxx">{session?.subAccountId}</span>
      </p>
      {subAccountWaiting && (
        <p role="status">
          {t('Confirming the sub-account again. Actions are refused until it answers; nothing runs as your main account.')}
        </p>
      )}
      <button type="button" className="text-link" disabled={state === 'busy'} onClick={() => void leave()}>
        {t('Switch back to the main account')}
      </button>
      {state === 'failed' && <p role="alert">{t('The main account could not be reached. Try again.')}</p>}
    </section>
  );
}
