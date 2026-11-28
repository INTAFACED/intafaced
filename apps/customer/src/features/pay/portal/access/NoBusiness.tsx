import { Children, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { FirstState } from '@intafaced/ui/lit/templates';
import { Store } from 'lucide-react';
import { chromeCopy } from '../chrome/copy';

/** Where a person with no business account goes to make one. */
export const ONBOARDING_HREF = '/pay/onboarding';

/**
 * What every business page shows to a signed-in person who has no business account: one calm state and one way
 * forward. It replaces the page, so there is no refusal sentence and nothing to press that cannot work. `children`
 * is for the rare thing a person without a business can still do there (answer an invitation).
 */
export function NoBusiness({ children }: { children?: ReactNode }) {
  const { t } = chromeCopy.useCopy();
  return (
    <section className="pfo-nobiz">
      <FirstState
        level={2}
        icon={<Store size={24} />}
        title={t('noBusinessTitle')}
        body={t('noBusinessBody')}
        points={[t('noBusinessPointLinks'), t('noBusinessPointPayments'), t('noBusinessPointTeam')]}
      >
        <Button variant="primary" nativeButton={false} role="link" render={<a href={ONBOARDING_HREF} />}>
          {t('noBusinessStart')}
        </Button>
        {children}
      </FirstState>
    </section>
  );
}

/**
 * The page's header action, switched off with its reason beside it (no business by default, or the `reason` given). Every header action is a create or manage
 * button, and none of them can work without a business. The label is kept so the person sees what they will get.
 */
export function DisabledAction({ action, reason }: { action: ReactNode; reason?: string }) {
  const { t } = chromeCopy.useCopy();
  const reasonId = useId();
  if (!isValidElement(action)) return null;
  const label = Children.toArray((action as ReactElement<{ children?: ReactNode }>).props.children);
  return (
    <div className="pfo-action-off">
      <Button variant="secondary" disabled aria-describedby={reasonId}>
        {label}
      </Button>
      <small id={reasonId}>{reason ?? t('noBusinessActionOff')}</small>
    </div>
  );
}
