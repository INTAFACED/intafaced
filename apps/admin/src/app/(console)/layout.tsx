import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { FounderSessionBar } from '@/components/founder-session-bar';
import { requireFounderPage } from '@/lib/founder-page';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { session } = await requireFounderPage();
  return (
    <div className="adm-shell">
      <header className="adm-topbar">
        <a className="adm-brand" href="/crm">
          <img src="/intafaced-logo.svg" alt="INTAFACED" width="164" height="30" />
          <small>Founder console</small>
        </a>
        <Nav />
        <span className="adm-topbar__spacer" />
        <FounderSessionBar csrf={session.csrf} userId={session.userId} expiresAt={session.expiresAt} />
      </header>
      <main className="adm-main">{children}</main>
    </div>
  );
}
