/**
 * Server-side module gate for the operator console.
 *
 * `ADMIN_MODULES` is a comma list of module ids. UNSET (or blank) leaves every
 * module on, so teams that use the full console see no change. SET (launch uses
 * `ADMIN_MODULES=crm`) turns on only the listed modules; every other module's
 * nav link, page route and API routes are refused. Unknown ids are ignored, so
 * a typo fails closed (fewer modules), never open.
 *
 * Enforced in `src/middleware.ts` and again inside each module's API route
 * (`moduleDisabledResponse`). Hiding the nav link is only the cosmetic part.
 *
 * Session/login (`/login`, `/api/session*`) belongs to no module and is always
 * reachable: founders must be able to sign in whatever is enabled.
 *
 * This file must stay free of Node-only and Next-only imports: it runs in the
 * Edge middleware, in server components and in tests.
 */

export const MODULE_IDS = [
  'crm',
  'accounts',
  'killswitches',
  'launch',
  'jurisdiction',
  'ledger',
  'tools',
  'merchants',
  'support',
  'notify',
  'bank-ops',
  'pay-ops',
  'p2p-ops',
  'academy-ops',
  'more-ops',
  'protocol-ops',
  'tradeops',
  'identity-ops',
  'custody-ops',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Nav order, page href and label. `/` is the kill-switch board. */
export const MODULE_ROUTES: readonly { readonly id: ModuleId; readonly href: string; readonly label: string }[] = [
  { id: 'crm', href: '/crm', label: 'CRM' },
  { id: 'accounts', href: '/accounts', label: 'Account controls' },
  { id: 'killswitches', href: '/', label: 'Kill-switches' },
  { id: 'launch', href: '/launch', label: 'Launch sequence' },
  { id: 'jurisdiction', href: '/jurisdiction', label: 'Jurisdiction' },
  { id: 'ledger', href: '/ledger', label: 'Ledger ops' },
  { id: 'tools', href: '/tools', label: 'Operator tools' },
  { id: 'merchants', href: '/merchants', label: 'Merchants' },
  { id: 'support', href: '/support', label: 'Support queue' },
  { id: 'notify', href: '/notify', label: 'Notify health' },
  { id: 'bank-ops', href: '/bank-ops', label: 'Bank ops' },
  { id: 'pay-ops', href: '/pay-ops', label: 'Personal Pay ops' },
  { id: 'p2p-ops', href: '/p2p-ops', label: 'P2P ops' },
  { id: 'academy-ops', href: '/academy-ops', label: 'Academy ops' },
  { id: 'more-ops', href: '/more-ops', label: 'More modules' },
  { id: 'protocol-ops', href: '/protocol-ops', label: 'Protocol ops' },
  { id: 'tradeops', href: '/trade-ops', label: 'Trade desk' },
  { id: 'identity-ops', href: '/identity-ops', label: 'Identity' },
  { id: 'custody-ops', href: '/custody-ops', label: 'Custody approvals' },
];

/**
 * API route prefix per module. `/api/session*` is deliberately absent (always
 * on). `/api/analytics/*` has no console page; it is an operator read path, so
 * it belongs to `tools`.
 */
const API_PREFIXES: readonly (readonly [string, ModuleId])[] = [
  ['/api/crm', 'crm'],
  ['/api/accounts', 'accounts'],
  ['/api/kill-switch', 'killswitches'],
  ['/api/service-records', 'killswitches'],
  ['/api/ledger-freeze', 'ledger'],
  ['/api/ledger-lookup', 'ledger'],
  ['/api/ledger-reconciliation', 'ledger'],
  ['/api/pay-halts', 'ledger'],
  ['/api/restore', 'ledger'],
  ['/api/compliance', 'jurisdiction'],
  ['/api/support', 'support'],
  ['/api/notify-health', 'notify'],
  ['/api/notify-status', 'notify'],
  ['/api/notify-incidents', 'notify'],
  ['/api/notify-subscribers', 'notify'],
  ['/api/bank-ops', 'bank-ops'],
  ['/api/pay-ops', 'pay-ops'],
  ['/api/p2p-ops', 'p2p-ops'],
  ['/api/academy-ops', 'academy-ops'],
  ['/api/academy-courses', 'academy-ops'],
  ['/api/academy-lessons', 'academy-ops'],
  ['/api/academy-assignments', 'academy-ops'],
  ['/api/academy-quizzes', 'academy-ops'],
  ['/api/academy-release', 'academy-ops'],
  ['/api/academy-item-rules', 'academy-ops'],
  ['/api/academy-gradebook', 'academy-ops'],
  ['/api/academy-media', 'academy-ops'],
  ['/api/academy-hub', 'academy-ops'],
  ['/api/academy-course-links', 'academy-ops'],
  ['/api/more-ops', 'more-ops'],
  ['/api/protocol-ops', 'protocol-ops'],
  ['/api/operator-tools', 'tools'],
  ['/api/analytics', 'tools'],
  ['/api/merchants', 'merchants'],
  ['/api/trade-ops', 'tradeops'],
  ['/api/identity-ops', 'identity-ops'],
  ['/api/custody-ops', 'custody-ops'],
];

type Env = Record<string, string | undefined>;

/** Enabled module ids. `null` means "no gate configured": everything is on. */
export function configuredModules(env: Env = process.env): ReadonlySet<ModuleId> | null {
  const raw = env.ADMIN_MODULES;
  if (raw === undefined || raw.trim() === '') return null;
  const wanted = new Set(
    raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return new Set(MODULE_IDS.filter((id) => wanted.has(id)));
}

export function isModuleEnabled(id: ModuleId, env: Env = process.env): boolean {
  const enabled = configuredModules(env);
  return enabled === null || enabled.has(id);
}

export function enabledModuleIds(env: Env = process.env): readonly ModuleId[] {
  return MODULE_IDS.filter((id) => isModuleEnabled(id, env));
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Next matches routes on the DECODED path (`/%74ools` serves `/tools`), but `request.nextUrl.pathname` stays encoded. So the gate
 * decodes before it matches. It decodes repeatedly (a double-encoded `/%2574ools` becomes `/tools` too; refusing more than the
 * router would serve is safe) and then resolves `.`/`..` and doubled slashes. Returns null when the path cannot be decoded or is
 * still changing after 5 rounds: callers treat that as "refuse", never as "no module".
 */
function decodedPath(pathname: string): string | null {
  let path = pathname;
  for (let round = 0; round < 5; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (next === path) {
      const kept: string[] = [];
      for (const part of path.split(/[\\/]+/)) {
        if (part === '' || part === '.') continue;
        if (part === '..') kept.pop();
        else kept.push(part);
      }
      return `/${kept.join('/')}`;
    }
    path = next;
  }
  return null;
}

/** The path as Next will route it: fully decoded, dot segments resolved, no trailing slash; null when undecodable. */
export function normalise(pathname: string): string | null {
  const path = decodedPath(pathname);
  if (path === null) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * True when the path has a malformed `%` sequence (or nests encodings too deeply to trust). With a gate configured the middleware
 * answers these with a 404 rather than guess which module they might reach.
 */
export function isUndecodablePath(pathname: string): boolean {
  return decodedPath(pathname) === null;
}

/** Module that owns a page path, or null (login, 404s, route probes). Check `isUndecodablePath` first. */
export function moduleForPage(pathname: string): ModuleId | null {
  const path = normalise(pathname);
  if (path === null) return null;
  if (path === '/') return 'killswitches';
  if (
    [
      'approvals',
      'kyb',
      'screening',
      'fraud',
      'disputes',
      'payments',
      'settlements',
      'payouts',
      'conversion',
      'treasury',
      'pricing',
      'limits',
      'halts',
      'webhooks',
      'audit',
      'b2b-ramp',
      'simulator',
      'analytics',
      'system',
    ].some((prefix) => under(path, `/${prefix}`))
  )
    return 'merchants';
  if (under(path, '/compliance')) return 'jurisdiction';
  if (under(path, '/restore')) return 'ledger';
  // The approval policy of governed changes is identity's (OPS-change-control-01 CR-1).
  if (under(path, '/changes')) return 'identity-ops';
  // The module health board sits with the module board (kill switches): both are the whole-platform view.
  if (under(path, '/health')) return 'killswitches';
  for (const route of MODULE_ROUTES) {
    if (route.href !== '/' && under(path, route.href)) return route.id;
  }
  return null;
}

/** Module that owns an API path, or null (session/login APIs, unknown paths). Check `isUndecodablePath` first. */
export function moduleForApi(pathname: string): ModuleId | null {
  const path = normalise(pathname);
  if (path === null) return null;
  for (const [prefix, id] of API_PREFIXES) {
    if (under(path, prefix)) return id;
  }
  return null;
}

/** First enabled module's page, for redirecting away from a disabled page. */
export function firstEnabledHref(env: Env = process.env): string | null {
  return MODULE_ROUTES.find((route) => isModuleEnabled(route.id, env))?.href ?? null;
}

/** 404 for a disabled module's API route, or null to continue. Call first. */
export function moduleDisabledResponse(id: ModuleId, env: Env = process.env): Response | null {
  if (isModuleEnabled(id, env)) return null;
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

/** A navigation bar with one link in it points nowhere new, so the console hides it until a second module is enabled. */
export const navNeeded = (enabledRouteCount: number): boolean => enabledRouteCount > 1;
