import type { ReactNode } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { AnnouncementBanner } from '@/components/announcement-banner';
import { ConsoleModeBanner } from '@/components/console-mode-banner';
import { ConsoleSearch } from '@/components/console-search';
import { Nav } from '@/components/nav';
import { FounderSessionBar } from '@/components/founder-session-bar';
import { SkipLink } from '@/components/skip-link';
import { loadActiveAnnouncement } from '@/lib/console-announcements/server';
import { loadConsoleMode } from '@/lib/console-mode/server';
import { effectiveOf, loadPreferences } from '@/lib/console-preferences/server';
import { requireFounderPage } from '@/lib/founder-page';
import { enabledModuleIds } from '@/lib/modules';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const founder = await requireFounderPage();
  const { session } = founder;
  const modules = enabledModuleIds();
  // Three bounded reads, side by side: the mode and the announcement for the banners, the preferences for the home link.
  const [consoleMode, announcement, preferences] = await Promise.all([
    loadConsoleMode(founder),
    loadActiveAnnouncement(founder),
    loadPreferences(founder),
  ]);
  const prefs = effectiveOf(preferences);
  return (
    <div className="adm-shell" data-theme={prefs.theme.value}>
      {/* First in the page, so it is the first Tab stop. */}
      <SkipLink />
      <header className="adm-topbar">
        <a className="adm-brand" href={prefs.homePage.value} data-testid="console-home-link">
          {/* The console bar: the kit's top-bar lockup, 24 px tall (public/brand, from packages/ui/brand). */}
          <span className="adm-lockup" role="img" aria-label="INTAFACED" />
          <small>Founder console</small>
        </a>
        <Nav modules={modules} />
        <span className="adm-topbar__spacer" />
        <ConsoleSearch />
        <CommandPalette modules={modules} />
        <FounderSessionBar csrf={session.csrf} userId={session.userId} expiresAt={session.expiresAt} />
      </header>
      <main className="adm-main">
        <ConsoleModeBanner view={consoleMode.view} />
        <AnnouncementBanner view={announcement} timeZone={prefs.timeZone.value} />
        {children}
      </main>
    </div>
  );
}
