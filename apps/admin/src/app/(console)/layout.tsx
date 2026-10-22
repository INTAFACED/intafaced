import type { ReactNode } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { Nav } from '@/components/nav';
import { FounderSessionBar } from '@/components/founder-session-bar';
import { SkipLink } from '@/components/skip-link';
import { requireFounderPage } from '@/lib/founder-page';
import { enabledModuleIds } from '@/lib/modules';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { session } = await requireFounderPage();
  const modules = enabledModuleIds();
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
        <CommandPalette modules={modules} />
        <FounderSessionBar csrf={session.csrf} userId={session.userId} expiresAt={session.expiresAt} />
      </header>
      <main className="adm-main">{children}</main>
    </div>
  );
}
