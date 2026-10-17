import { useEffect } from 'react';
import { Button, EmptyState } from '@intafaced/ui';
import { navigate } from '../../../../app/location';
import { LayoutFrame } from '../home-layout/Frame';
import { chromeCopy } from './copy';

/** A `/pay/...` address the portal does not know. It sits inside the frame, with the way back to Overview. */
export function PortalNotFound() {
  const { t } = chromeCopy.useCopy();
  return (
    <LayoutFrame here="/pay/merchant" title={t('notFoundTitle')}>
      <EmptyState
        title={t('notFoundTitle')}
        action={
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/merchant" />}>
            {t('notFoundAction')}
          </Button>
        }
      >
        {t('notFoundBody')}
      </EmptyState>
    </LayoutFrame>
  );
}

/** An old address that now lives elsewhere: replace the history entry so Back does not bounce. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, true);
  }, [to]);
  return null;
}
