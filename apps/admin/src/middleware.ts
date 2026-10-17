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
import { contentSecurityPolicy, createNonce, hstsHeaderValue } from '@/lib/security-headers.mjs';

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

/** The module gate. `forwarded` are the request headers that carry the CSP nonce on to the page render. */
function gate(request: NextRequest, forwarded: Headers) {
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
    return NextResponse.next({ request: { headers: forwarded } });
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
  return NextResponse.next({ request: { headers: forwarded } });
}

/**
 * Every response this middleware produces (pass-through, redirect or 404) carries the page Content-Security-Policy. The
 * nonce is also put on the forwarded REQUEST, as `x-nonce` and as the CSP itself: Next reads the nonce from the request's
 * policy and stamps it on its own inline bootstrap and chunk scripts, which is what lets `script-src` drop 'unsafe-inline'.
 * Strict-Transport-Security is set here too, from the RUNTIME environment (`hstsHeaderValue(process.env)`), not from `headers()`
 * in `next.config.mjs`: that is baked into the build, so one image could only ever carry one HSTS stage. The value is already
 * validated at boot (`instrumentation.ts`), so this only formats it and cannot throw. It is sent whatever the scheme or port: TLS
 * ends in front of this process and browsers ignore the header over plain http. The matcher skips `/_next/` and files with an
 * extension, so those responses no longer carry it; any page or API response records the policy for the host.
 * The other security headers do not vary per request and come from `headers()` in `next.config.mjs`.
 */
export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const policy = contentSecurityPolicy(nonce);
  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('content-security-policy', policy);
  const response = gate(request, forwarded);
  response.headers.set('content-security-policy', policy);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('strict-transport-security', hstsHeaderValue(process.env));
  return response;
}

export const config = {
  matcher: ['/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
