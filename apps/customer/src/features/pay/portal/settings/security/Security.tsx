// volt-room: /pay/settings/security
// volt-room: portal:settings-security
import { useMerchantAccess, readyAccess } from '../../access/MerchantAccess';
import { IdentitySessions } from '../../../../account';
import { reason as notLive } from '../../chrome/copy';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { Chip, NotLive, Section } from '../../volt/parts';
import { SettingsRoom } from '../../volt/SettingsRoom';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';

/**
 * `/pay/settings/security`: where this account is signed in, and how it is protected. Sign-in protection for the
 * person (passkeys, two-step codes) lives on their Account page and is linked, not copied.
 */
export function Security() {
  const value = useMerchantAccess();
  const ready = readyAccess(value);
  const { t } = accountCopy.useCopy();
  return (
    <SettingsRoom
      sectionsLabel={t('secSectionsLabel')}
      sections={[
        { id: 'security-protection', label: t('secProtectionTitle') },
        { id: 'security-sessions', label: t('secSessionsTitle') },
        { id: 'security-keys', label: t('secKeysTitle') },
        { id: 'security-policy', label: t('secPolicyTitle') },
      ]}
      explain={<p>{t('secExplain')}</p>}
    >
      {() => (
        <SecurityView role={ready?.role ?? null} interactive={ready?.sessionInteractive ?? null} kybStatus={ready?.kybStatus ?? null} />
      )}
    </SettingsRoom>
  );
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
    <>
      <Section id="security-protection" title={t('secProtectionTitle')} description={t('secProtectionBody')}>
        <KeyValue
          label={t('secProtectionTitle')}
          rows={[
            {
              label: t('secThisSession'),
              value: interactive === null ? t('secUnknown') : interactive ? t('secVerified') : t('secNotVerified'),
            },
            { label: t('secYourRole'), value: role ? p(`role_${role}` as 'role_owner') : t('secUnknown') },
            { label: t('secBusinessVerified'), value: kybStatus === null ? t('secUnknown') : <Chip kind="kyb" value={kybStatus} /> },
          ]}
        />
        {interactive === false && <p className="lt-hint">{t('secNeedsVerified')}</p>}
        <p>
          <a className="lt-link" href="/settings/security">
            {t('secManageSignIn')}
          </a>
        </p>
      </Section>

      <Section id="security-sessions" title={t('secSessionsTitle')} description={t('secSessionsBody')}>
        <IdentitySessions />
      </Section>

      <Section id="security-keys" title={t('secKeysTitle')} description={t('secKeysBody')}>
        <p>
          <a className="lt-link" href="/pay/developer/keys">
            {t('secKeysLink')}
          </a>
        </p>
      </Section>

      <Section id="security-policy" title={t('secPolicyTitle')}>
        <NotLive reason={notLive('reasonSecurity')} needs="team sign-in policy" title={t('secPolicyHead')}>
          {t('secPolicyBody')}
        </NotLive>
      </Section>
    </>
  );
}
