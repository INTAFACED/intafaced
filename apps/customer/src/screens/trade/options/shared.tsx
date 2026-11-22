import type { ReactNode } from 'react';
import { RefusalBox } from '@intafaced/ui/lit/templates';
import { roomWords } from '../rooms/refusals';
import { optionsCopy } from './copy';
import { Refusal } from './notices';

/** Where a signed-out person is sent to carry on with this room. */
export function loginHref(): string {
  return `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

/** A refused read: the sign-in prompt when the person is signed out, otherwise the typed refusal in plain words. */
export function RefusedRegion({ code, onRetry }: { code: string; onRetry?: () => void }): ReactNode {
  const { t } = optionsCopy.useCopy();
  if (code === 'auth.required')
    return (
      <RefusalBox
        refusal={{
          variant: 'refused',
          title: t('Sign in to see this'),
          body: t('Sign in reason'),
          action: { label: t('Sign in'), href: loginHref() },
        }}
      />
    );
  return <Refusal words={roomWords({ code })} onRetry={onRetry} />;
}
