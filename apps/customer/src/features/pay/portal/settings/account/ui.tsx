import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState } from '../../../ui-kit';
import { accountCopy } from './copy';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import './account.css';

/**
 * A part of a page that cannot work yet, for a reason outside the page. `reason` names what it is waiting for
 * (take it from `reason()` in `chrome/copy.ts`, or word one in `account/copy.ts`); it is required so no card can say
 * "not yet" without saying why. `needs` is the service read it waits for: never shown, listed on the review board.
 * It is never a fake row and never shows a made-up number.
 */
export function Blocker({ reason, title, needs, children }: { reason: string; title?: string; needs?: string; children?: ReactNode }) {
  return (
    <NotLiveCard reason={reason} title={title} needs={needs}>
      {children}
    </NotLiveCard>
  );
}

/** Setup belongs to the account owner. A team member who opens it is told so, instead of being led into steps they cannot finish. */
export function OwnerSetsUp() {
  const { t } = accountCopy.useCopy();
  return <EmptyState title={t('ownerSetsUpTitle')}>{t('ownerSetsUpBody')}</EmptyState>;
}

/**
 * A person with no business whose session cannot open one: it carries no `pay:onboard`, which needs two-step sign-in,
 * so the service refuses even the read of their own (absent) record. Setup's first step for them is turning it on.
 */
export function TwoStepFirst() {
  const { t } = accountCopy.useCopy();
  return (
    <EmptyState
      title={t('twoStepFirstTitle')}
      action={
        <Button variant="primary" nativeButton={false} role="link" render={<a href="/settings/security" />}>
          {t('twoStepFirstAction')}
        </Button>
      }
    >
      {t('twoStepFirstBody')}
    </EmptyState>
  );
}
