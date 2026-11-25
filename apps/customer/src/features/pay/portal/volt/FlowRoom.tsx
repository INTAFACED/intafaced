import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate, type FlowProps, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { Need } from '../access/capabilities';
import { portalCopy } from '../copy';
import { refusalText, refusalTitle } from '../refusal';
import type { Account } from './SettingsRoom';
import { usePortalHeading } from './heading';

/**
 * A merchant portal page on the flow template: a single task, review and receipt. The title row is the frame's heading
 * for this page (its title, purpose and one action), the same way `RecordListRoom` and `SettingsRoom` draw it; the
 * business it reads comes from the resolved access, and until that is known the template draws its own loading, refusal
 * and "no business" states. `children` draws the page's step for the account.
 */
export function FlowRoom({
  need,
  state,
  steps,
  summary,
  actions,
  help,
  children,
}: {
  /** What the person's role must allow to see the page (`Requires` in `../access/MerchantAccess`). */
  need?: Need;
  /** The page's own state once the business is known; ready by default. */
  state?: RoomState;
  steps?: FlowProps['steps'];
  summary?: ReactNode;
  actions?: ReactNode;
  help?: ReactNode;
  children: (account: Account) => ReactNode;
}) {
  const heading = usePortalHeading();
  const { t } = portalCopy.useCopy();
  const { access, merchant, reload, can } = useMerchantAccess();
  let roomState: RoomState = state ?? { kind: 'ready' };
  let step: ReactNode = null;
  let retry: (() => void) | undefined;
  if (access.status === 'loading') roomState = { kind: 'loading' };
  else if (access.status === 'failed') {
    roomState = {
      kind: 'refused',
      refusal: {
        variant: access.failure.reason === 'uncertain' || access.failure.reason === 'unreachable' ? 'unreachable' : 'refused',
        title: refusalTitle(access.failure),
        body: refusalText(access.failure),
        reference: access.failure.requestId,
      },
    };
    if (access.failure.reason !== 'forbidden' && access.failure.reason !== 'uncertain') retry = reload;
  } else if (access.status === 'none')
    roomState = {
      kind: 'empty',
      title: t('noMerchantTitle'),
      body: t('noMerchantBody'),
      action: { label: t('startSetup'), href: '/pay/onboarding' },
    };
  else if (need && !can(need))
    roomState = { kind: 'empty', title: t('noRoleTitle'), body: need === 'owner' ? t('ownerOnlyBody') : t('noRoleBody') };
  else {
    // The owner's record is handed over only when it is the business this access resolved to.
    const record = merchant.status === 'ready' && merchant.data?.id === access.merchantId ? merchant.data : null;
    step = children({ merchantId: access.merchantId, role: access.role, record });
  }
  const action = retry ? (
    <Button tone="secondary" onClick={retry}>
      {t('tryAgain')}
    </Button>
  ) : heading.action ? (
    // The portal's own test id for a page's heading action, which the merchant journeys find it by.
    <div data-testid="plo-heading">{heading.action}</div>
  ) : undefined;
  return (
    <FlowTemplate
      title={heading.title}
      description={heading.purpose}
      state={roomState}
      roomAction={action}
      mode="pro"
      steps={steps}
      step={step}
      summary={summary}
      actions={actions}
      help={help}
    />
  );
}
