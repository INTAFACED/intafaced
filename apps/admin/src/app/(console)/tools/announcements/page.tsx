import { AnnouncementsDesk } from '@/components/announcements-desk';
import { loadAnnouncements } from '@/lib/console-announcements/server';
import { effectiveOf, loadPreferences } from '@/lib/console-preferences/server';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { isoToZonedInput } from '@/lib/time-zone';

/** Announcements (`/tools/announcements`, OPS-admin-access-08). The window is typed in the founder's own time zone. */
export const dynamic = 'force-dynamic';

const MINUTE = 60_000;

export default async function AnnouncementsPage() {
  requireModulePage('tools');
  const founder = await requireFounderPage();
  const [view, preferences] = await Promise.all([loadAnnouncements(founder), loadPreferences(founder)]);
  const timeZone = effectiveOf(preferences).timeZone.value;
  // The form starts at this minute, for an hour; the server picks it so the first paint and the browser agree.
  const start = Math.floor(Date.now() / MINUTE) * MINUTE;
  return (
    <AnnouncementsDesk
      initial={view}
      me={founder.session.userId}
      timeZone={timeZone}
      defaultStart={isoToZonedInput(new Date(start).toISOString(), timeZone)}
      defaultEnd={isoToZonedInput(new Date(start + 60 * MINUTE).toISOString(), timeZone)}
    />
  );
}
