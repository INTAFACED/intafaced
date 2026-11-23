import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { OverviewTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { Need } from '../access/capabilities';
import { portalCopy } from '../copy';
import { refusalText, refusalTitle } from '../refusal';
import type { Account } from './SettingsRoom';
import { usePortalHeading } from './heading';

/** The title row and state of a portal page on the overview template, worked out before its own reads start. */
export type OverviewFrame = { title: string; description: string; roomAction?: ReactNode; state: RoomState };

/**
 * Which business an overview page reads, and its title row: the frame's heading for this page (its title, purpose and one
 * action), and until the business is known the template's own loading, refusal and "no business" states (as
 * `SettingsRoom` does for the settings template). `account` is null until the page may draw its own reads.
 */
export function useOverviewGate(need?: Need): { frame: OverviewFrame; account: Account | null } {
  const heading = usePortalHeading();
  const { t } = portalCopy.useCopy();
  const { access, merchant, reload, can } = useMerchantAccess();
  let state: RoomState = { kind: 'ready' };
  let account: Account | null = null;
  let retry: (() => void) | undefined;
  if (access.status === 'loading') state = { kind: 'loading' };
  else if (access.status === 'failed') {
    state = {
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
    state = {
      kind: 'empty',
      title: t('noMerchantTitle'),
      body: t('noMerchantBody'),
      action: { label: t('startSetup'), href: '/pay/onboarding' },
    };
  else if (need && !can(need))
    state = { kind: 'empty', title: t('noRoleTitle'), body: need === 'owner' ? t('ownerOnlyBody') : t('noRoleBody') };
  else {
    // The owner's record is handed over only when it is the business this access resolved to.
    const record = merchant.status === 'ready' && merchant.data?.id === access.merchantId ? merchant.data : null;
    account = { merchantId: access.merchantId, role: access.role, record };
  }
  const roomAction = retry ? (
    <Button tone="secondary" onClick={retry}>
      {t('tryAgain')}
    </Button>
  ) : heading.action ? (
    // The portal's own test id for a page's heading action, which the merchant journeys find it by.
    <div data-testid="plo-heading">{heading.action}</div>
  ) : undefined;
  return { frame: { title: heading.title, description: heading.purpose, roomAction, state }, account };
}

/** A merchant portal page on the overview template: the gate's title row and state, and the page's own slots. */
export function OverviewRoom({
  frame,
  hero,
  actions,
  needsYou,
  sections,
  watching,
}: {
  frame: OverviewFrame;
  hero: ReactNode;
  actions?: ReactNode;
  needsYou?: ReactNode;
  sections?: ReactNode;
  watching?: ReactNode;
}) {
  return (
    <OverviewTemplate
      title={frame.title}
      description={frame.description}
      roomAction={frame.roomAction}
      state={frame.state}
      hero={hero}
      actions={actions}
      needsYou={needsYou}
      sections={sections}
      watching={watching}
    />
  );
}
