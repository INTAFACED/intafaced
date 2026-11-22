import { Tabs } from '@intafaced/ui/lit/templates';
import { t as copyText } from './copy';
import { academyTabHref, academyTabs, type AcademyTab } from './academy-lms';

const LABELS = {
  Learning: 'academy.learning',
  Certificates: 'academy.certificates',
  Rooms: 'academy.rooms',
  Videos: 'academy.videos',
  Programmes: 'academy.programmes',
} as const;

/** The Academy's sections as links, each at its own address, with the one this room belongs to marked as current. */
export function AcademySections({ current }: { current: AcademyTab }) {
  return (
    <Tabs
      label={copyText('academy.academy.sections')}
      current={academyTabHref(current)}
      items={academyTabs.map(([name]) => ({ label: copyText(LABELS[name]), href: academyTabHref(name) }))}
    />
  );
}
