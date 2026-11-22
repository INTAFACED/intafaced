import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { MonitorTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { Need } from '../access/capabilities';
import { portalCopy } from '../copy';
import { refusalText, refusalTitle } from '../refusal';
import type { Account } from './SettingsRoom';
import { usePortalHeading } from './heading';

/** What a monitor page draws for the business: its regions, each a slot of the monitor template. */
export type MonitorSlots = {
  /** Two to four key figures with their period. */
  figures?: readonly ReactNode[];
  /** The page's controls (the period, the grouping). */
  actions?: ReactNode;
  /** The main chart. */
  chart?: ReactNode;
  /** The status panels and tables. */
  panels?: ReactNode;
  /** What the figures mean, in plain words. */
  explain?: ReactNode;
  related?: ReactNode;
};

/**
 * A merchant portal page on the monitor template: figures, a chart and the panels behind them. The title row is the
 * frame's heading for this page (its title, purpose and one action), the same way `SettingsRoom` draws it; the business
 * it reads comes from the resolved access, and until that is known the template draws its own loading, refusal and
 * "no business" states. `children` draws the page's regions for the account.
 */
export function MonitorRoom({ need, state, children }: { need?: Need; state?: RoomState; children: (account: Account) => MonitorSlots }) {
  const heading = usePortalHeading();
  const { t } = portalCopy.useCopy();
  const { access, merchant, reload, can } = useMerchantAccess();
  let roomState: RoomState = state ?? { kind: 'ready' };
  let slots: MonitorSlots = {};
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
    slots = children({ merchantId: access.merchantId, role: access.role, record });
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
    <MonitorTemplate
      title={heading.title}
      description={heading.purpose}
      state={roomState}
      roomAction={action}
      mode="pro"
      figures={slots.figures ?? []}
      actions={slots.actions}
      chart={slots.chart}
      panels={slots.panels}
      explain={slots.explain}
      related={slots.related}
    />
  );
}
