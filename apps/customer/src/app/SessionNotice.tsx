import { useState } from 'react';
import { useSession } from '../features/session/session';
import { shellCopy } from './shell-copy';

/** Says why the server ended the session, when it said so. Gone as soon as someone signs in again. */
export function SessionNotice() {
  const { t } = shellCopy.useCopy();
  const { notice, session } = useSession();
  if (session?.subAccountId) return <SubaccountBar />;
  if (notice === 'subaccount_ended' && session)
    return (
      <p className="tb-note" role="alert">
        {t('This tab is back on your main account: the sub-account could not be confirmed again. Use it again from Account.')}
      </p>
    );
  if (!notice || session || notice === 'subaccount_ended') return null;
  return (
    <p className="tb-note" role="status">
      {notice === 'reused'
        ? t('You were signed out because your sign-in was used elsewhere.')
        : t('This account is frozen, so you were signed out. Contact support to find out why.')}
    </p>
  );
}

/** While this tab acts as a sub-account (I-account-lifecycle-04): which one, and the way back to the main account. */
function SubaccountBar() {
  const { t } = shellCopy.useCopy();
  const { session, leaveSubAccount } = useSession();
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
      <button type="button" className="text-link" disabled={state === 'busy'} onClick={() => void leave()}>
        {t('Switch back to the main account')}
      </button>
      {state === 'failed' && <p role="alert">{t('The main account could not be reached. Try again.')}</p>}
    </section>
  );
}
