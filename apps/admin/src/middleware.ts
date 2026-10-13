import { NextResponse, type NextRequest } from 'next/server';
import { configuredModules, firstEnabledHref, isModuleEnabled, isUndecodablePath, moduleForApi, moduleForPage } from '@/lib/modules';

/**
 * ADMIN_MODULES gate (see `lib/modules.ts`). A disabled module's API routes get
 * a 404; its pages redirect to the first enabled module (or 404 if none). Paths
 * are matched after percent-decoding, and an undecodable path is a 404. Each
 * gated page also re-checks on the server (`lib/module-page-guard.ts`). With
 * ADMIN_MODULES unset nothing here changes behaviour.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The gate matches the decoded path (see `lib/modules.ts`). A path it cannot decode could be anything once Next decodes it, so
  // with a gate configured it is refused outright.
  if (configuredModules() !== null && isUndecodablePath(pathname)) {
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const id = moduleForApi(pathname);
    if (id && !isModuleEnabled(id)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return NextResponse.next();
  }

  const id = moduleForPage(pathname);
  if (id && !isModuleEnabled(id)) {
    const target = firstEnabledHref();
    if (target) {
      const url = request.nextUrl.clone();
      url.pathname = target;
      url.search = '';
      return NextResponse.redirect(url);
    }
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
