import type { AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { Button } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { frozenByYouCopy } from './frozen-by-you-copy';

/**
 * After a sign-in to an account its owner froze (J-identity-11 #3, I-account-lifecycle-09): the freeze is named as the
 * person's own, from identity's account status, with when it started and how they lift it, never as a generic error.
 * Security holds the lift itself; Continue goes where the sign-in was headed.
 */
export function FrozenByYou({
  freeze,
  onContinue,
  onSecurity,
}: {
  freeze: AccountRestriction;
  onContinue: () => void;
  onSecurity: () => void;
}) {
  const { t, languageFor } = frozenByYouCopy.useCopy();
  const { timeZone } = usePreferences();
  const lift = freeze.lift.by === 'owner_after_wait' ? freeze.lift.availableAt : null;
  const liftKey = lift === null ? 'liftUnset' : Date.parse(lift) > Date.now() ? 'liftAt' : 'liftNow';
  return (
    <section
      data-testid="frozen-by-you"
      data-state="frozen_self"
      className="public-auth-recovery-used stack"
      role="status"
      aria-labelledby="frozen-by-you-title"
    >
      <h1 id="frozen-by-you-title" lang={languageFor('title')}>
        {t('title')}
      </h1>
      {freeze.since && (
        <p data-testid="frozen-by-you__since" lang={languageFor('since')}>
          {t('since', { date: stamp(freeze.since, timeZone) })}
        </p>
      )}
      <p lang={languageFor('body')}>{t('body')}</p>
      <p data-testid="frozen-by-you__lift" data-lift={liftKey} lang={languageFor(liftKey)}>
        {liftKey === 'liftAt' ? t('liftAt', { date: stamp(lift!, timeZone) }) : t(liftKey)}
      </p>
      <Button onClick={onSecurity}>{t('security')}</Button>
      <Button variant="secondary" onClick={onContinue}>
        {t('continue')}
      </Button>
    </section>
  );
}
