import { Children, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
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
    <section className="pfo-nobiz" aria-labelledby="pfo-nobiz-title">
      <h2 id="pfo-nobiz-title">{t('noBusinessTitle')}</h2>
      <p>{t('noBusinessBody')}</p>
      <Button variant="primary" nativeButton={false} role="link" render={<a href={ONBOARDING_HREF} />}>
        {t('noBusinessStart')}
      </Button>
      {children}
    </section>
  );
}

/**
 * The page's header action, switched off with its reason beside it. Every header action is a create or manage
 * button, and none of them can work without a business. The label is kept so the person sees what they will get.
 */
export function DisabledAction({ action }: { action: ReactNode }) {
  const { t } = chromeCopy.useCopy();
  const reasonId = useId();
  if (!isValidElement(action)) return null;
  const label = Children.toArray((action as ReactElement<{ children?: ReactNode }>).props.children);
  return (
    <div className="pfo-action-off">
      <Button variant="secondary" disabled aria-describedby={reasonId}>
        {label}
      </Button>
      <small id={reasonId}>{t('noBusinessActionOff')}</small>
    </div>
  );
}
