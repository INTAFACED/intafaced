import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { appCopy } from '../../app/app-copy';
import { currentReturnLocation, useReturnLocation } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { EmptyNote } from './volt-parts';

/**
 * The sign-in panel (`app/SignInPanel.tsx`) in a More room on the kit: the same words, the same link back to `returnTo`,
 * drawn from the kit's classes. When the boot refresh could not answer, the retry note, never a false "signed out".
 */
export function SignInNote({ children, returnTo }: { children?: ReactNode; returnTo?: string }) {
  const { t } = appCopy.useCopy();
  const current = useReturnLocation();
  return (
    <EmptyNote
      title={t('Sign in to continue')}
      action={
        <a
          className="lt-button lt-button-primary"
          href={`/login?redirect=${encodeURIComponent(safeReturnTo(returnTo ?? current))}`}
          onClick={(event) => {
            // Native hashchange is queued; capture again at link activation.
            event.currentTarget.href = `/login?redirect=${encodeURIComponent(safeReturnTo(returnTo ?? currentReturnLocation()))}`;
          }}
        >
          {t('Sign in')}
        </a>
      }
    >
      {children ?? t('Your account context is needed before this room can show private information.')}
    </EmptyNote>
  );
}

/** The boot refresh did not answer: the cookie is untouched, so Retry instead of pretending the person is signed out. */
export function SessionRetryNote({ retry }: { retry: () => void }) {
  const { t } = appCopy.useCopy();
  return (
    <EmptyNote
      title={t('We could not check your sign-in')}
      action={
        <Button tone="primary" onClick={retry}>
          {t('Retry')}
        </Button>
      }
    >
      {t('The account service did not answer. Your sign-in is not lost; try again.')}
    </EmptyNote>
  );
}
