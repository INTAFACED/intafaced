import { NextResponse, type NextRequest } from 'next/server';
import {
  configuredModules,
  firstEnabledHref,
  isModuleEnabled,
  isUndecodablePath,
  moduleForApi,
  moduleForPage,
  normalise,
} from '@/lib/modules';

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

  // Branch on the decoded path, so `/%61pi/accounts` is treated as the API route Next will serve.
  const routed = normalise(pathname) ?? pathname;
  if (routed === '/api' || routed.startsWith('/api/')) {
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
      // A relative Location resolves against the address the founder used. Behind the edge or
      // the preview proxy, request.nextUrl carries Next's own internal host and port instead.
      return new NextResponse(null, { status: 307, headers: { location: target, 'cache-control': 'no-store' } });
    }
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
