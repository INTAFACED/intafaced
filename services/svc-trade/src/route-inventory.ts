import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, type Scope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { EdgeTrust } from './edge-trust.js';

/**
 * Who may call an `/api/v1` route, declared where the route is registered (`config.inventory`):
 * - `public`: answers without a credential.
 * - `private`: needs a signed principal; the handler refuses without one.
 * - `internal`: service to service only; the handler refuses anything without a service signature.
 * `scopes` is every scope an API key must hold to call a public or private route: the edge asks a key for `trade:read`
 * on a read and `trade:write` on any other method, and a route may need more (an admin read).
 */
export type RouteDeclaration =
  { readonly access: 'public' | 'private'; readonly scopes: readonly Scope[] } | { readonly access: 'internal' };

export type InventoryRoute = { method: string; path: string } & RouteDeclaration;

declare module 'fastify' {
  interface FastifyContextConfig {
    inventory?: RouteDeclaration;
  }
}

/** Registration options: `app.get(path, publicRead, handler)`. */
export const publicRead = { config: { inventory: { access: 'public', scopes: ['trade:read'] } } } as const;
export const publicWrite = { config: { inventory: { access: 'public', scopes: ['trade:write'] } } } as const;
export const privateRead = { config: { inventory: { access: 'private', scopes: ['trade:read'] } } } as const;
export const privateWrite = { config: { inventory: { access: 'private', scopes: ['trade:write'] } } } as const;
export const internalRoute = { config: { inventory: { access: 'internal' } } } as const;
export const privateWith = (...scopes: Scope[]) => ({ config: { inventory: { access: 'private' as const, scopes } } });

/** The inventory's own route. */
export const ROUTE_INVENTORY_PATH = '/api/v1/routes';

/** Boot refusal: an `/api/v1` route registered without a declaration. */
export const TRADE_ROUTE_UNDECLARED = 'trade.route_undeclared';
/** Boot refusal: a declaration whose scopes leave out the one the edge asks a key for on that method. */
export const TRADE_ROUTE_SCOPE_MISMATCH = 'trade.route_scope_mismatch';

const isApiV1 = (url: string) => url === '/api/v1' || url.startsWith('/api/v1/');

/** The scope the edge asks an API key for on `/api/v1` (`requiredScopeFor` in svc-edge): read on GET, write otherwise. */
export const methodScope = (method: string): Scope => (method === 'GET' ? 'trade:read' : 'trade:write');

export interface RouteInventoryDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
}

/**
 * Records every `/api/v1` route as it is mounted, with the access and scopes its registration declares, and serves the
 * list at `GET /api/v1/routes`. Install it before any route is registered: a route mounted without a declaration, or
 * with scopes that leave out its method's key scope, stops the boot.
 *
 * The declared scopes are also held here for API keys: a key principal without one of them is refused before the
 * handler runs, with the edge's own refusal. A key reaching svc-trade through the edge already has its method scope,
 * so this changes nothing on that path; it keeps the published scope true for every route. Sessions are not touched.
 */
export function installRouteInventory(app: FastifyInstance, deps: RouteInventoryDeps): () => readonly InventoryRoute[] {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });
  const routes: InventoryRoute[] = [];

  const keyScopeGate = (scopes: readonly Scope[]) =>
    async function keyScope(req: FastifyRequest, reply: FastifyReply) {
      const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
      const principal = edgeContext(edgeReq).principal;
      if (!principal?.kid) return;
      const missing = scopes.find((scope) => !hasScope(principal.scopes, scope));
      if (missing === undefined) return;
      return reply.code(403).send({
        code: 'PermissionDenied',
        message: `Scope "${missing}" is required`,
        intafacedCode: 'scope.denied',
        docs: '/developers/permissions',
      });
    };

  app.addHook('onRoute', (options) => {
    if (!isApiV1(options.url)) return;
    const methods = (Array.isArray(options.method) ? options.method : [options.method]).filter((method) => method !== 'HEAD');
    if (methods.length === 0) return;
    const declared = options.config?.inventory;
    if (!declared) throw new Error(`${TRADE_ROUTE_UNDECLARED}: ${methods.join(',')} ${options.url} declares no access`);
    for (const method of methods) {
      if (declared.access !== 'internal' && !declared.scopes.includes(methodScope(method))) {
        throw new Error(`${TRADE_ROUTE_SCOPE_MISMATCH}: ${method} ${options.url} must declare ${methodScope(method)}`);
      }
      routes.push({ method, path: options.url, ...declared });
    }
    if (declared.access === 'internal') return;
    const gate = keyScopeGate(declared.scopes);
    const existing = options.onRequest;
    options.onRequest = existing === undefined ? [gate] : [gate, ...(Array.isArray(existing) ? existing : [existing])];
  });

  app.get(ROUTE_INVENTORY_PATH, publicRead, async (_req, reply) => reply.code(200).send({ routes }));

  return () => routes;
}
