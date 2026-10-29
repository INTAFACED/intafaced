import { useEffect, useState } from 'react';
import type { AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { Button } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { accountStatusCopy } from '../account/account-status-copy';
import { selfFreezeCopy } from '../account/self-freeze-copy';
import { frozenByYouCopy } from './frozen-by-you-copy';

/**
 * After a sign-in to an account its owner froze (J-identity-11 #3, I-account-lifecycle-09): the freeze is named as the
 * person's own, from identity's account status, with when it started, what it stops and how they lift it, never as a
 * generic error. Security holds the lift itself; Continue goes where the sign-in was headed.
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
  const freezeCopy = selfFreezeCopy.useCopy();
  const status = accountStatusCopy.useCopy();
  const { timeZone } = usePreferences();
  const lift = freeze.lift.by === 'owner_after_wait' ? freeze.lift.availableAt : null;
  const liftAt = lift === null ? NaN : Date.parse(lift);
  const [now, setNow] = useState(() => Date.now());
  // The page turns to "reactivate now" when the wait ends while it is open.
  useEffect(() => {
    if (!(liftAt > now)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(liftAt - now + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [liftAt, now]);
  // An owner wait identity could not state reads as unset, never as open.
  const liftKey = Number.isNaN(liftAt) ? 'liftUnset' : liftAt > now ? 'liftAt' : 'liftNow';
  return (
    <section
      data-testid="frozen-by-you"
      data-state="frozen_self"
      className="public-auth-recovery-used stack"
      role="status"
      aria-labelledby="frozen-by-you-title"
    >
      <h1 id="frozen-by-you-title" lang={freezeCopy.languageFor('frozenTitle')}>
        {freezeCopy.t('frozenTitle')}
      </h1>
      {freeze.since && (
        <p data-testid="frozen-by-you__since" lang={languageFor('since')}>
          {t('since', { date: stamp(freeze.since, timeZone) })}
        </p>
      )}
      <p lang={languageFor('body')}>{t('body')}</p>
      {freeze.blocks.length > 0 ? (
        <>
          <p lang={languageFor('stops')}>{t('stops')}</p>
          <ul data-testid="frozen-by-you__stops">
            {freeze.blocks.map((action) => (
              <li key={action} data-action={action} lang={status.languageFor(`action_${action}`)}>
                {status.t(`action_${action}`)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p lang={languageFor('stopsNothing')}>{t('stopsNothing')}</p>
      )}
      <p
        data-testid="frozen-by-you__lift"
        data-lift={liftKey}
        lang={liftKey === 'liftUnset' ? freezeCopy.languageFor('liftWaitUnset') : languageFor(liftKey)}
      >
        {liftKey === 'liftAt'
          ? t('liftAt', { date: stamp(lift!, timeZone) })
          : liftKey === 'liftNow'
            ? t('liftNow')
            : freezeCopy.t('liftWaitUnset')}
      </p>
      <Button onClick={onSecurity}>{t('security')}</Button>
      <Button variant="secondary" onClick={onContinue}>
        {t('continue')}
      </Button>
    </section>
  );
}
