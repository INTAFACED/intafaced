import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { SettingsTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { Need } from '../access/capabilities';
import { portalCopy } from '../copy';
import { refusalText, refusalTitle } from '../refusal';
import type { MemberRole, MerchantRecord } from '../schemas';
import { usePortalHeading } from './heading';

export type Account = { merchantId: string; role: MemberRole; record: MerchantRecord | null };

/** One section of the page's index: where it links, and its words. */
export type SectionLink = { id: string; label: string };

/**
 * A merchant portal page on the settings template. The title row is the frame's heading for this page (its title, purpose
 * and one action, switched off with its reason when the person may not use it); the business it reads comes from the
 * resolved access, as `WithAccount` gives it, and until that is known the template draws its own loading, refusal and
 * "no business" states. `children` draws the page's sections for the account.
 */
export function SettingsRoom({
  sections,
  sectionsLabel,
  index,
  explain,
  state,
  need,
  children,
}: {
  /** What the person's role must allow to see the page (`Requires` in `../access/MerchantAccess`). */
  need?: Need;
  /** The page's own parts, each a link to its section. */
  sections?: readonly SectionLink[];
  /** The index's name (its landmark label). */
  sectionsLabel?: string;
  /** An index of its own in place of the section links: the row that moves between a group's pages. */
  index?: ReactNode;
  /** What these settings mean and what changing them does now, in plain words. */
  explain?: ReactNode;
  /** The page's own state once the business is known; ready by default. */
  state?: RoomState;
  children: (account: Account) => ReactNode;
}) {
  const heading = usePortalHeading();
  const { t } = portalCopy.useCopy();
  const { access, merchant, reload, can } = useMerchantAccess();
  let roomState: RoomState = state ?? { kind: 'ready' };
  let body: ReactNode = null;
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
    body = children({ merchantId: access.merchantId, role: access.role, record });
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
    <SettingsTemplate
      title={heading.title}
      description={heading.purpose}
      state={roomState}
      roomAction={action}
      index={
        index ??
        (sections && sections.length > 0 ? (
          <nav aria-label={sectionsLabel ?? heading.title}>
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <a className="lt-link" href={`#${s.id}`}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : undefined)
      }
      sections={body}
      explain={explain}
    />
  );
}
