import { PaySection } from '../../../components';
import { useMerchantAccess, readyAccess } from '../../access/MerchantAccess';
import { Chip } from '../../components';
import { IdentitySessions } from '../../../../account/IdentitySessions';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';
import { Blocker } from '../account/ui';

/**
 * `/pay/settings/security`: where this account is signed in, and how it is protected. Sign-in protection for the
 * person (passkeys, two-step codes) lives on their Account page and is linked, not copied.
 */
export function Security() {
  const value = useMerchantAccess();
  const ready = readyAccess(value);
  return <SecurityView role={ready?.role ?? null} interactive={ready?.sessionInteractive ?? null} kybStatus={ready?.kybStatus ?? null} />;
}

/** `kybStatus` is the business check as the service reports it; null when it could not be read. */
export function SecurityView({
  role,
  interactive,
  kybStatus,
}: {
  role: string | null;
  interactive: boolean | null;
  kybStatus: 'none' | 'pending' | 'approved' | 'rejected' | null;
}) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  return (
    <div className="stack">
      <PaySection title={t('secProtectionTitle')} description={t('secProtectionBody')}>
        <dl data-testid="pp-facts" className="pp-facts">
          <div>
            <dt>{t('secThisSession')}</dt>
            <dd>{interactive === null ? t('secUnknown') : interactive ? t('secVerified') : t('secNotVerified')}</dd>
          </div>
          <div>
            <dt>{t('secYourRole')}</dt>
            <dd>{role ? p(`role_${role}` as 'role_owner') : t('secUnknown')}</dd>
          </div>
          <div>
            <dt>{t('secBusinessVerified')}</dt>
            <dd>{kybStatus === null ? t('secUnknown') : <Chip kind="kyb" value={kybStatus} />}</dd>
          </div>
        </dl>
        {interactive === false && <p className="pp-callout">{t('secNeedsVerified')}</p>}
        <p>
          <a className="text-link" href="/settings/security">
            {t('secManageSignIn')}
          </a>
        </p>
      </PaySection>

      <PaySection title={t('secSessionsTitle')} description={t('secSessionsBody')}>
        <IdentitySessions />
      </PaySection>

      <PaySection title={t('secKeysTitle')} description={t('secKeysBody')}>
        <p>
          <a className="text-link" href="/pay/developer/keys">
            {t('secKeysLink')}
          </a>
        </p>
      </PaySection>

      <PaySection title={t('secPolicyTitle')}>
        <Blocker reason={notLive('reasonSecurity')} needs="team sign-in policy" title={t('secPolicyHead')}>
          {t('secPolicyBody')}
        </Blocker>
      </PaySection>
    </div>
  );
}
