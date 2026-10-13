import { NextResponse, type NextRequest } from 'next/server';
import { firstEnabledHref, isModuleEnabled, moduleForApi, moduleForPage } from '@/lib/modules';

/**
 * ADMIN_MODULES gate (see `lib/modules.ts`). A disabled module's API routes get
 * a 404; its pages redirect to the first enabled module (or 404 if none). With
 * ADMIN_MODULES unset nothing here changes behaviour.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
