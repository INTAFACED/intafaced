import type { ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui';
import type { Resource } from '../../../../shared/resource';
import { Gate, PortalLoading } from '../components';
import { portalCopy } from '../copy';
import type { MemberRole, MerchantRecord } from '../schemas';

/**
 * The payment and settlement reads answer only the account owner for now, so every other role would meet a refusal.
 * They are told so up front. A role we could not read is let through: the service decides.
 */
export function OwnerOnly({ role, children }: { role: MemberRole | null; children: ReactNode }) {
  const { t } = portalCopy.useCopy();
  if (role === null || role === 'owner') return <>{children}</>;
  return <EmptyState title={t('ownerOnlyTitle')}>{t('ownerOnlyBody')}</EmptyState>;
}

export type AccountProps = {
  merchant: Resource<MerchantRecord | null>;
  reload: () => void;
  team: Resource<{ merchantId: string; userId: string; role: MemberRole }>;
};

/** A person with no account at all is sent to set one up, not shown an error. */
export function NoMerchant() {
  const { t } = portalCopy.useCopy();
  return (
    <EmptyState
      title={t('noMerchantTitle')}
      action={
        <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/onboarding" />}>
          {t('startSetup')}
        </Button>
      }
    >
      {t('noMerchantBody')}
    </EmptyState>
  );
}

/**
 * Which account a page reads. The owner's record names it; a team member has no record of their own, so their team
 * membership does. Neither is a merchant id the browser chose: both come from the signed session on the server.
 */
export function WithAccount({
  merchant,
  reload,
  team,
  children,
}: AccountProps & { children: (account: { merchantId: string; role: MemberRole | null; record: MerchantRecord | null }) => ReactNode }) {
  return (
    <Gate resource={merchant} retry={reload} rows={4}>
      {(record) => {
        if (record) return <>{children({ merchantId: record.id, role: team.status === 'ready' ? team.data.role : null, record })}</>;
        if (team.status === 'loading') return <PortalLoading rows={4} />;
        if (team.status === 'ready') return <>{children({ merchantId: team.data.merchantId, role: team.data.role, record: null })}</>;
        return <NoMerchant />;
      }}
    </Gate>
  );
}
