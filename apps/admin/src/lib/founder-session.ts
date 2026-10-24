import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { accountOperatorEntitlementSchema } from '@intafaced/contracts';

export const ADMIN_COOKIE = '__Host-intafaced-admin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A waiting new-device sign-in's id and the secret only the browser that signed in holds (identity's own bounds). */
export const DEVICE_FLOW_ID = UUID;
export const DEVICE_FLOW_SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

export interface FounderSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  issuedAt: string;
  csrf: string;
}

export interface AdminSessionConfig {
  origin: string;
  edgeUrl: string;
  key: Buffer;
}

/** A sign-in identity holds until this browser is approved (identity's new-device check, I-signin-sessions-07). */
export interface DeviceAuthorisation {
  flowId: string;
  secret: string;
  expiresAt: string;
  mailed: boolean;
}

export class AdminSessionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    /** The service's own typed code (for example `ops.crm.storage_unconfigured`), kept so a desk can say what really happened. */
    public readonly upstream?: string,
    /** Only on `auth.device_authorisation_required`: the waiting sign-in, which only this browser's request receives. */
    public readonly deviceAuthorisation?: DeviceAuthorisation,
  ) {
    super(code);
  }
}

/**
 * The waiting sign-in identity attached to an `auth.device_authorisation_required` refusal, or undefined. Each field is
 * checked for its exact shape, so nothing else in a service's error body can reach the browser this way.
 */
export function deviceAuthorisationOf(body: unknown): DeviceAuthorisation | undefined {
  if (upstreamCodeOf(body) !== 'auth.device_authorisation_required') return undefined;
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : {};
  const json = error.json && typeof error.json === 'object' ? (error.json as Record<string, unknown>) : error;
  const data = json.data && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : {};
  const d =
    data.deviceAuthorisation && typeof data.deviceAuthorisation === 'object' ? (data.deviceAuthorisation as Record<string, unknown>) : null;
  if (
    !d ||
    typeof d.flowId !== 'string' ||
    !DEVICE_FLOW_ID.test(d.flowId) ||
    typeof d.secret !== 'string' ||
    !DEVICE_FLOW_SECRET.test(d.secret) ||
    typeof d.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(d.expiresAt)) ||
    typeof d.mailed !== 'boolean'
  )
    return undefined;
  return { flowId: d.flowId, secret: d.secret, expiresAt: d.expiresAt, mailed: d.mailed };
}

/**
 * This browser's device key for identity's new-device check: the one its cookie holds, else a fresh random one. Identity
 * trusts a browser by this key, so the console sends it on every sign-in and keeps it in its own host-only cookie
 * (`Set-Cookie` value returned with it, renewed on each use). It is never shown to the page.
 */
export const ADMIN_DEVICE_COOKIE = '__Host-intafaced-admin-device';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 86_400;
export function adminDeviceKey(cookieHeader: string | null): { key: string; cookie: string } {
  const values = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_DEVICE_COOKIE}=`))
    .map((part) => part.slice(ADMIN_DEVICE_COOKIE.length + 1));
  const held = values.length === 1 && /^[A-Za-z0-9_-]{32,128}$/.test(values[0]!) ? values[0]! : null;
  const key = held ?? randomBytes(32).toString('base64url');
  return {
    key,
    cookie: `${ADMIN_DEVICE_COOKIE}=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`,
  };
}

const UPSTREAM_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const EMBEDDED_CODE = /\b(ops\.crm\.[a-z][a-z0-9_]*)\b/;
/**
 * The typed code a service put in a tRPC or REST error body, or null. Only a dotted lower-case code is kept, so free text
 * from a service can never travel to the browser through this field.
 */
export function upstreamCodeOf(body: unknown): string | null {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : {};
  const json = error.json && typeof error.json === 'object' ? (error.json as Record<string, unknown>) : error;
  const data = json.data && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : {};
  for (const candidate of [root.intafacedCode, json.intafacedCode, data.appCode, root.code, json.message, root.message]) {
    if (typeof candidate !== 'string' || candidate.length > 120) continue;
    if (UPSTREAM_CODE.test(candidate)) return candidate;
    const embedded = EMBEDDED_CODE.exec(candidate)?.[1];
    if (embedded) return embedded;
  }
  return null;
}

export function adminSessionConfig(env: Record<string, string | undefined> = process.env): AdminSessionConfig {
  try {
    const origin = new URL(env.ADMIN_ORIGIN ?? '');
    const edge = new URL(env.EDGE_URL ?? '');
    const secret = env.ADMIN_SESSION_SECRET ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error();
    const key = Buffer.from(secret, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== secret) throw new Error();
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    const local = ['localhost', '127.0.0.1'].includes(origin.hostname) && ['dev', 'test'].includes(env.APP_ENV ?? '');
    if (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) throw new Error();
    if (!['http:', 'https:'].includes(edge.protocol) || edge.username || edge.password || edge.search || edge.hash) throw new Error();
    return { origin: origin.origin, edgeUrl: edge.href.replace(/\/$/, ''), key };
  } catch {
    throw new AdminSessionError('admin.session_unconfigured', 503);
  }
}

function validSession(value: unknown, now: Date): value is FounderSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'accessToken,csrf,expiresAt,issuedAt,refreshToken,userId') return false;
  if (typeof row.userId !== 'string' || !UUID.test(row.userId)) return false;
  if (typeof row.accessToken !== 'string' || row.accessToken.length < 1 || row.accessToken.length > 2600) return false;
  if (typeof row.refreshToken !== 'string' || row.refreshToken.length < 1 || row.refreshToken.length > 256) return false;
  if (typeof row.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.csrf)) return false;
  if (typeof row.expiresAt !== 'string' || typeof row.issuedAt !== 'string') return false;
  const issued = Date.parse(row.issuedAt);
  const expires = Date.parse(row.expiresAt);
  return (
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    issued <= now.getTime() &&
    expires > now.getTime() &&
    expires > issued &&
    expires - issued <= MAX_SESSION_MS
  );
}

export function sealFounderSession(session: FounderSession, config: AdminSessionConfig, now: Date = new Date()): string {
  if (!validSession(session, now)) throw new AdminSessionError('admin.session_invalid', 401);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(`${ADMIN_COOKIE}\n${config.origin}\nv1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  const encoded = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  if (encoded.length > 3800) throw new AdminSessionError('admin.session_too_large', 502);
  return encoded;
}

export function openFounderSession(cookieHeader: string | null, config: AdminSessionConfig, now: Date = new Date()): FounderSession {
  try {
    const values = (cookieHeader ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${ADMIN_COOKIE}=`));
    if (values.length !== 1) throw new Error();
    const encoded = values[0]!.slice(ADMIN_COOKIE.length + 1);
    if (encoded.length > 3800 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', config.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(`${ADMIN_COOKIE}\n${config.origin}\nv1`));
    const payload: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!validSession(payload, now)) throw new Error();
    return payload;
  } catch {
    throw new AdminSessionError('admin.session_required', 401);
  }
}

export function assertAdminOrigin(request: Request, config: AdminSessionConfig, mutation: boolean): void {
  const expected = new URL(config.origin);
  const requestUrl = new URL(request.url);
  const host = request.headers.get('host');
  const forwardedProtocol = request.headers.get('x-forwarded-proto');
  const expectedProtocol = expected.protocol.slice(0, -1);
  // Next may use its internal listener in request.url. Only a trusted ingress
  // that preserves Host and overwrites this single-value header may supply TLS.
  const invalidProtocol = forwardedProtocol !== null && forwardedProtocol !== expectedProtocol;
  let authorityMatches = requestUrl.origin === config.origin;
  if (host !== null) {
    const protocol = forwardedProtocol ?? requestUrl.protocol.slice(0, -1);
    authorityMatches = host.toLowerCase() === expected.host && protocol === expectedProtocol;
  }
  if (!authorityMatches || invalidProtocol || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AdminSessionError('admin.session_origin', 403);
  }
  if (mutation && request.headers.get('origin') !== config.origin) throw new AdminSessionError('admin.session_origin', 403);
}

export function assertAdminCsrf(request: Request, session: FounderSession): void {
  const actual = Buffer.from(request.headers.get('x-intafaced-csrf') ?? '');
  const expected = Buffer.from(session.csrf);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdminSessionError('admin.session_csrf', 403);
}

/** End-user Bearer transport only: never substitute a configured operator token. */
export async function founderEdgeCall(
  config: AdminSessionConfig,
  module: 'identity' | 'ops' | 'trade' | 'pay',
  procedure: string,
  method: 'GET' | 'POST',
  input: unknown,
  accessToken?: string,
  /**
   * Sign-in calls only: the founder's own browser `user-agent`, so identity labels the device it trusts by that browser
   * and not by this server, and `signIn` keeps a waiting new-device sign-in on the refusal for that browser alone.
   */
  signIn?: { userAgent: string | null },
): Promise<unknown> {
  const query = method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}` : '';
  let response: Response;
  let body: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AdminSessionError('admin.upstream_unavailable', 503));
      controller.abort();
    }, 5000);
  });
  try {
    const result = await Promise.race([
      (async () => {
        const upstream = await fetch(`${config.edgeUrl}/api/${module}/trpc/${procedure}${query}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            ...(signIn?.userAgent ? { 'user-agent': signIn.userAgent.slice(0, 512) } : {}),
          },
          ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        return { response: upstream, body: (await upstream.json().catch(() => null)) as unknown };
      })(),
      deadline,
    ]);
    response = result.response;
    body = result.body;
  } catch {
    throw new AdminSessionError('admin.upstream_unavailable', 503);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!response.ok)
    throw new AdminSessionError(
      response.status === 401 || response.status === 403 ? 'admin.authority_refused' : 'admin.upstream_refused',
      response.status >= 400 && response.status < 600 ? response.status : 502,
      upstreamCodeOf(body) ?? undefined,
      signIn ? deviceAuthorisationOf(body) : undefined,
    );
  if (!body || typeof body !== 'object' || !('result' in body)) throw new AdminSessionError('admin.upstream_invalid', 502);
  const result = (body as { result?: { data?: unknown } }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('data' in result))
    throw new AdminSessionError('admin.upstream_invalid', 502);
  const data = result.data;
  return data && typeof data === 'object' && 'json' in data ? (data as { json: unknown }).json : data;
}

export async function assertCurrentFounder(session: FounderSession, config: AdminSessionConfig): Promise<void> {
  const raw = await founderEdgeCall(config, 'identity', 'accountControls.operatorStatus', 'GET', {}, session.accessToken);
  const status = accountOperatorEntitlementSchema.safeParse(raw);
  if (!status.success) throw new AdminSessionError('admin.upstream_invalid', 502);
  if (status.data.status === 'unconfigured') throw new AdminSessionError('admin.founders_unconfigured', 503);
  if (status.data.status !== 'enabled' || status.data.userId !== session.userId) throw new AdminSessionError('admin.founder_required', 403);
}

export async function authorizeAdminRequest(request: Request): Promise<{ session: FounderSession; config: AdminSessionConfig }> {
  const config = adminSessionConfig();
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  assertAdminOrigin(request, config, mutation);
  const session = openFounderSession(request.headers.get('cookie'), config);
  if (mutation) assertAdminCsrf(request, session);
  await assertCurrentFounder(session, config);
  return { session, config };
}

export function adminSessionErrorResponse(error: unknown): Response {
  const known = error instanceof AdminSessionError ? error : new AdminSessionError('admin.request_failed', 500);
  return Response.json(
    {
      code: known.code,
      ...(known.upstream ? { upstream: known.upstream } : {}),
      ...(known.deviceAuthorisation ? { deviceAuthorisation: known.deviceAuthorisation } : {}),
    },
    { status: known.status, headers: { 'cache-control': 'no-store' } },
  );
}

export function founderCookie(value: string, maxAge: number): string {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

export function newFounderSession(value: unknown, now: Date = new Date()): FounderSession {
  if (!value || typeof value !== 'object') throw new AdminSessionError('admin.upstream_invalid', 502);
  const row = value as Record<string, unknown>;
  const session = {
    userId: row.userId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    issuedAt: now.toISOString(),
    csrf: randomBytes(32).toString('base64url'),
  };
  if (!validSession(session, now)) throw new AdminSessionError('admin.upstream_invalid', 502);
  return session;
}

/**
 * Turns identity's session reply into the console's signed-in answer: only a current founder keeps it (anyone else's
 * session is logged out again), sealed in the host-only cookie, with this browser's device cookie renewed beside it.
 */
export async function founderSignedIn(raw: unknown, config: AdminSessionConfig, deviceCookie: string): Promise<Response> {
  const session = newFounderSession(raw);
  try {
    await assertCurrentFounder(session, config);
  } catch (error) {
    await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken }).catch(() => undefined);
    throw error;
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', founderCookie(sealFounderSession(session, config), (Date.parse(session.expiresAt) - Date.now()) / 1000));
  headers.append('set-cookie', deviceCookie);
  return Response.json({ userId: session.userId, expiresAt: session.expiresAt, csrf: session.csrf }, { headers });
}
