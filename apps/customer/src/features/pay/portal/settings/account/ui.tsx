import type { ReactNode } from 'react';
import { Empty, LinkButton, NotLive } from '../../volt/parts';
import { accountCopy } from './copy';

/**
 * A part of a page that cannot work yet, for a reason outside the page. `reason` names what it is waiting for
 * (take it from `reason()` in `chrome/copy.ts`, or word one in `account/copy.ts`); it is required so no card can say
 * "not yet" without saying why. `needs` is the service read it waits for: never shown, listed on the review board.
 * It is never a fake row and never shows a made-up number.
 */
export function Blocker({ reason, title, needs, children }: { reason: string; title?: string; needs?: string; children?: ReactNode }) {
  return (
    <NotLive reason={reason} title={title} needs={needs}>
      {children}
    </NotLive>
  );
}

/** Setup belongs to the account owner. A team member who opens it is told so, instead of being led into steps they cannot finish. */
export function OwnerSetsUp() {
  const { t } = accountCopy.useCopy();
  return <Empty title={t('ownerSetsUpTitle')}>{t('ownerSetsUpBody')}</Empty>;
}

/**
 * A person with no business whose session cannot open one: it carries no `pay:onboard`, which needs two-step sign-in,
 * so the service refuses even the read of their own (absent) record. Setup's first step for them is turning it on.
 */
export function TwoStepFirst() {
  const { t } = accountCopy.useCopy();
  return (
    <Empty
      title={t('twoStepFirstTitle')}
      action={
        <LinkButton href="/settings/security" tone="primary">
          {t('twoStepFirstAction')}
        </LinkButton>
      }
    >
      {t('twoStepFirstBody')}
    </Empty>
  );
}
