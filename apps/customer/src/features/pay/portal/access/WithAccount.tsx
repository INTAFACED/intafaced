import type { ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui';
import { PortalFailure, PortalLoading } from '../components';
import { portalCopy } from '../copy';
import type { MemberRole, MerchantRecord } from '../schemas';
import { useMerchantAccess } from './MerchantAccess';

/** A person with no business at all is sent to set one up, not shown an error. */
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
 * Which business a page reads. It comes from the resolved access (never a merchant id the browser chose), and the
 * owner's own record is passed along when there is one.
 */
export function WithAccount({
  children,
}: {
  children: (account: { merchantId: string; role: MemberRole; record: MerchantRecord | null }) => ReactNode;
}) {
  const { access, merchant } = useMerchantAccess();
  if (access.status === 'loading') return <PortalLoading rows={4} />;
  if (access.status === 'failed') return <PortalFailure result={access.failure} />;
  if (access.status === 'none') return <NoMerchant />;
  // The owner's record is handed over only when it is the business this access resolved to.
  const record = merchant.status === 'ready' && merchant.data?.id === access.merchantId ? merchant.data : null;
  return <>{children({ merchantId: access.merchantId, role: access.role, record })}</>;
}
