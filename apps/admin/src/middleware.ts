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
/** ADMIN_ORIGIN (the configured public origin, also used for the session's origin check), else the request's own. */
function publicOrigin(request: NextRequest): string {
  try {
    return new URL(process.env.ADMIN_ORIGIN ?? '').origin;
  } catch {
    return request.nextUrl.origin;
  }
}

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
      // Next requires an absolute Location here. Build it on the console's public origin: behind the
      // edge or the preview proxy, request.nextUrl carries Next's own internal host and port instead.
      const location = new URL(target, publicOrigin(request));
      return NextResponse.redirect(location, { status: 307, headers: { 'cache-control': 'no-store' } });
    }
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
