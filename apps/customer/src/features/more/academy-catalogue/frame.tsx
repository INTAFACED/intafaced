import type { ReactNode } from 'react';
import { t as copyText } from '../copy';
import type { AcademyTab } from '../academy-lms';
import { AcademySectionTabs } from '../academy-sections';

/**
 * The Academy's catalogue rooms on the kit's catalogue template (intafaced issue 9566): the Academy's title, its five
 * sections as one row of pressed buttons, each at its own address, then the room. A room spreads these into its
 * CatalogueTemplate.
 */
export function academyCatalogue({
  current,
  away,
  onLeave,
}: {
  current: AcademyTab;
  /** A page inside the section (a programme's page): pressing the section opens the section's own address. */
  away?: boolean;
  onLeave?: () => void;
}) {
  return {
    title: copyText('moreroutes.academy'),
    description: copyText('moreroutes.learn.practise.and.join.hosted.sessions'),
    state: { kind: 'ready' as const },
    filters: <AcademySectionTabs current={current} away={away} onLeave={onLeave} />,
  };
}

/** Signed out the room is the visitor's Academy, so it keeps that marker. */
export function AcademyVisitor({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return <div data-academy-visitor={signedIn ? undefined : 'true'}>{children}</div>;
}
