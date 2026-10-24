import { z } from 'zod';
import { Button } from '../../shared/ui';
import { sessionSchema } from '../session/session';
import { recoveryCodeCopy } from './recovery-code-copy';

/**
 * A sign-in answer (I-signin-sessions-12): the session, plus `recoveryCodesLeft` only when the second step spent a
 * recovery code. The count is the account's own, read under the same lock that spent the code.
 */
export const signInAnswerSchema = sessionSchema.extend({ recoveryCodesLeft: z.number().int().min(0).optional() });

/**
 * After a sign-in that spent a recovery code (J-identity-05 #1): the person is told the code is gone and how many are
 * left, and chooses where to go next. With none left, Security is where the authenticator app is replaced.
 */
export function RecoveryCodeUsed({ left, onContinue, onSecurity }: { left: number; onContinue: () => void; onSecurity: () => void }) {
  const { t, languageFor } = recoveryCodeCopy.useCopy();
  return (
    <section className="public-auth-recovery-used stack" role="status" aria-labelledby="recovery-used-title">
      <h2 id="recovery-used-title" lang={languageFor('title')}>
        {t('title')}
      </h2>
      <p lang={languageFor('spent')}>{t('spent')}</p>
      <p lang={languageFor('left')}>
        <strong>{t('left', { count: left })}</strong>
      </p>
      {left === 0 && <p lang={languageFor('none')}>{t('none')}</p>}
      <Button variant={left === 0 ? 'secondary' : undefined} onClick={onContinue}>
        {t('continue')}
      </Button>
      <Button variant={left === 0 ? undefined : 'secondary'} onClick={onSecurity}>
        {t('security')}
      </Button>
    </section>
  );
}
