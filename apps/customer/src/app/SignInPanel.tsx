import type { ReactNode } from 'react';
import { Button, EmptyState } from '../shared/ui';
import { safeReturnTo } from './navigation';
import { useReturnLocation, currentReturnLocation } from './location';
import { appCopy } from './app-copy';

/** The sign-in link that brings the visitor back to `returnTo`, or to the address they were on. */
export function RoomSignIn({ children, returnTo }: { children: ReactNode; returnTo?: string }) {
  const current = useReturnLocation();
  return (
    <a
      className="button button--primary"
      href={`/login?redirect=${encodeURIComponent(safeReturnTo(returnTo ?? current))}`}
      onClick={(event) => {
        // Native hashchange is queued; capture again at link activation.
        event.currentTarget.href = `/login?redirect=${encodeURIComponent(safeReturnTo(returnTo ?? currentReturnLocation()))}`;
      }}
    >
      {children}
    </a>
  );
}

/** The one sign-in panel a signed-out visitor sees wherever a room, or a part of a public room, needs an account. */
export function SignInPanel({ children, returnTo }: { children?: ReactNode; returnTo?: string }) {
  const { t } = appCopy.useCopy();
  return (
    <EmptyState title={t('Sign in to continue')} action={<RoomSignIn returnTo={returnTo}>{t('Sign in')}</RoomSignIn>}>
      {children ?? t('Your account context is needed before this room can show private information.')}
    </EmptyState>
  );
}

/** The boot refresh did not answer: the cookie is untouched, so offer Retry instead of pretending the person is signed out. */
export function SessionRetryPanel({ retry }: { retry: () => void }) {
  const { t } = appCopy.useCopy();
  return (
    <EmptyState title={t('We could not check your sign-in')} action={<Button onClick={retry}>{t('Retry')}</Button>}>
      {t('The account service did not answer. Your sign-in is not lost; try again.')}
    </EmptyState>
  );
}
