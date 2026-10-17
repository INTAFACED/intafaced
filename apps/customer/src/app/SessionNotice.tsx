import { useSession } from '../features/session/session';
import { shellCopy } from './shell-copy';

/** Says why the server ended the session, when it said so. Gone as soon as someone signs in again. */
export function SessionNotice() {
  const { t } = shellCopy.useCopy();
  const { notice, session } = useSession();
  if (!notice || session) return null;
  return (
    <p className="tb-note" role="status">
      {notice === 'reused'
        ? t('You were signed out because your sign-in was used elsewhere.')
        : t('This account is frozen, so you were signed out. Contact support to find out why.')}
    </p>
  );
}
