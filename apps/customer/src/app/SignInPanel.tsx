import type { ReactNode } from 'react';
import { EmptyState } from '../shared/ui';
import { safeReturnTo } from './navigation';
import { useReturnLocation, currentReturnLocation } from './location';
import { appCopy } from './app-copy';

/** The sign-in link that brings the visitor back to the address they were on. */
export function RoomSignIn({ children }: { children: ReactNode }) {
  const current = useReturnLocation();
  return (
    <a
      className="button button--primary"
      href={`/login?redirect=${encodeURIComponent(safeReturnTo(current))}`}
      onClick={(event) => {
        // Native hashchange is queued; capture again at link activation.
        event.currentTarget.href = `/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`;
      }}
    >
      {children}
    </a>
  );
}

/** The one sign-in panel a signed-out visitor sees wherever a room, or a part of a public room, needs an account. */
export function SignInPanel({ children }: { children?: ReactNode }) {
  const { t } = appCopy.useCopy();
  return (
    <EmptyState title={t('Sign in to continue')} action={<RoomSignIn>{t('Sign in')}</RoomSignIn>}>
      {children ?? t('Your account context is needed before this room can show private information.')}
    </EmptyState>
  );
}
