import '../../shared/public-pages.css';
import { developersRoute } from './developers-model';
import { ChangelogPage, UpcomingPage } from './ChangelogPages';
import { StatusPage } from './StatusPage';
import { AppsRoom } from './apps/AppsRoom';
import { DevelopersHome } from './DevelopersHome';
import { HostsRoom } from './HostsRoom';
import { ErrorsAuthRoom } from './ErrorsAuthRoom';
import { SandboxRoutes } from './sandbox/SandboxRoutes';
import { SectionPage, UnknownSection } from './SectionRoom';

/** /developers and the pages under it: the portal home, the base-address table and one page per section. Public: no sign-in needed. */
export function DevelopersRoutes({ path }: { path: string }) {
  if (/^\/developers\/sandbox(\/|$)/.test(path.split(/[?#]/)[0]!)) return <SandboxRoutes path={path} />;
  const route = developersRoute(path);
  if (route.kind === 'hosts') return <HostsRoom />;
  if (route.kind === 'status') return <StatusPage />;
  if (route.kind === 'changelog') return <ChangelogPage />;
  if (route.kind === 'upcoming') return <UpcomingPage />;
  if (route.kind === 'apps') return <AppsRoom />;
  if (route.kind === 'errors-auth') return <ErrorsAuthRoom />;
  if (route.kind === 'section') return <SectionPage id={route.id} />;
  if (route.kind === 'unknown' && path.split(/[?#]/)[0]!.replace(/\/+$/, '') !== '/developers') return <UnknownSection />;
  return <DevelopersHome />;
}
