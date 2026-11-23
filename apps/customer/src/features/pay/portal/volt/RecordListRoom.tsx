import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { RecordListTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { Need } from '../access/capabilities';
import { portalCopy } from '../copy';
import { refusalText, refusalTitle } from '../refusal';
import type { Account } from './SettingsRoom';
import { usePortalHeading } from './heading';

/** What a record-list page draws for the business: its regions, each a slot of the record-list template. */
export type RecordListSlots = {
  /** The list's filters and search. */
  filters?: ReactNode;
  /** The export control. */
  export?: ReactNode;
  /** Totals for the filtered records, when the page has them. */
  summary?: ReactNode;
  /** The records: the table, with its own loading, empty and failed states. */
  list?: ReactNode;
  /** One record's own page (a `/pay/<page>/:id` route): drawn alone, in place of the list. */
  detail?: ReactNode;
  /** Column chooser, saved filters, bulk actions. */
  tools?: ReactNode;
};

/**
 * A merchant portal page on the record-list template: a list of records with its filters and export, or one record's
 * own page. The title row is the frame's heading for this page (its title, purpose and one action), the same way
 * `SettingsRoom` draws it; the business it reads comes from the resolved access, and until that is known the template
 * draws its own loading, refusal and "no business" states. `children` draws the page's regions for the account; a
 * page that returns `detail` and no `list` is a record's own page.
 */
export function RecordListRoom({
  need,
  state,
  children,
}: {
  /** What the person's role must allow to see the page (`Requires` in `../access/MerchantAccess`). */
  need?: Need;
  /** The page's own state once the business is known; ready by default. */
  state?: RoomState;
  children: (account: Account) => RecordListSlots;
}) {
  const heading = usePortalHeading();
  const { t } = portalCopy.useCopy();
  const { access, merchant, reload, can } = useMerchantAccess();
  let roomState: RoomState = state ?? { kind: 'ready' };
  let slots: RecordListSlots = {};
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
    <RecordListTemplate
      title={heading.title}
      description={heading.purpose}
      state={roomState}
      roomAction={action}
      mode="pro"
      filters={slots.filters}
      export={slots.export}
      summary={slots.summary}
      list={slots.list}
      detail={slots.detail}
      detailOnly={slots.list === undefined && slots.detail !== undefined}
      tools={slots.tools}
    />
  );
}
