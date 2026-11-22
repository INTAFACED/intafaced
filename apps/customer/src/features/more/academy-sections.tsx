import { Segmented } from '@intafaced/ui/lit';
import { SectionTabs, Tabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../app/location';
import { t as copyText } from './copy';
import { academyTabHref, academyTabs, type AcademyTab } from './academy-lms';

const LABELS = {
  Learning: 'academy.learning',
  Certificates: 'academy.certificates',
  Rooms: 'academy.rooms',
  Videos: 'academy.videos',
  Programmes: 'academy.programmes',
} as const;

/**
 * The Academy's sections as links, each at its own address, with the one this room belongs to marked as current; `null`
 * for a page of its own outside them (/academy/progress), where none is current.
 */
export function AcademySections({ current }: { current: AcademyTab | null }) {
  return (
    <Tabs
      label={copyText('academy.academy.sections')}
      current={current === null ? '' : academyTabHref(current)}
      items={academyTabs.map(([name]) => ({ label: copyText(LABELS[name]), href: academyTabHref(name) }))}
    />
  );
}

/**
 * The sections as the hub's row of pressed buttons, each opening its own address (a press pushes history, so Back returns
 * to the previous section). The section this room belongs to is pressed; pressing it again stays put on its own address
 * (`away` false), and opens the section's address from a page inside it (a programme's page).
 */
export function AcademySectionTabs({ current, away = false, onLeave }: { current: AcademyTab; away?: boolean; onLeave?: () => void }) {
  return (
    <SectionTabs<AcademyTab>
      label={copyText('academy.academy.sections')}
      value={current}
      items={academyTabs.map(([name]) => ({ value: name, label: copyText(LABELS[name]) }))}
      onChange={(next) => {
        onLeave?.();
        // The open section is already this address: a second push would make Back seem to do nothing.
        if (next !== current || away) navigate(academyTabHref(next));
      }}
    />
  );
}

/**
 * The same sections as pressed buttons, the way the hub draws them: the lesson reader keeps that strip, since a reader's
 * address belongs to Learning and journey J-academy-01 #6 reads Learning as the pressed one. A press opens that section.
 */
export function AcademySectionSwitch({ current, onLeave }: { current: AcademyTab; onLeave?: () => void }) {
  return (
    <Segmented
      label={copyText('academy.academy.sections')}
      value={current}
      options={academyTabs.map(([name]) => ({ value: name, label: copyText(LABELS[name]) }))}
      onChange={(next) => {
        onLeave?.();
        navigate(academyTabHref(next));
      }}
    />
  );
}
