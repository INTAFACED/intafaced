import type { ReactNode } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { ConsoleModeBanner } from '@/components/console-mode-banner';
import { ConsoleSearch } from '@/components/console-search';
import { Nav } from '@/components/nav';
import { FounderSessionBar } from '@/components/founder-session-bar';
import { SkipLink } from '@/components/skip-link';
import { loadConsoleMode } from '@/lib/console-mode/server';
import { requireFounderPage } from '@/lib/founder-page';
import { enabledModuleIds } from '@/lib/modules';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const founder = await requireFounderPage();
  const { session } = founder;
  const modules = enabledModuleIds();
  const consoleMode = await loadConsoleMode(founder);
  return (
    <div className="adm-shell">
      {/* First in the page, so it is the first Tab stop. */}
      <SkipLink />
      <header className="adm-topbar">
        <a className="adm-brand" href="/crm">
          <img src="/intafaced-logo.svg" alt="INTAFACED" width="164" height="30" />
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
        {children}
      </main>
    </div>
  );
}
