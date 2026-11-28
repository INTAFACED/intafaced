import { createEdgeContext } from '@intafaced/contracts/edge';
import { createSupportHttpApp } from '../http-app.js';
import { createSupportRouter } from '../router.js';
import { SupportService } from '../support-service.js';
import { createTicketKbLoopObserver } from '../ticket-kb-loop-observation.js';

/** Test-only: the Fastify app `index.ts` listens on (`createSupportHttpApp`), over an in-memory desk. */
export async function mountedSupportApp(identitySecret: string | undefined) {
  const loop = createTicketKbLoopObserver();
  const app = await createSupportHttpApp({
    router: createSupportRouter(new SupportService(), loop),
    edgeContext: createEdgeContext({ secret: 'a-support-mounted-app-fixture-edge-secret', serviceName: 'svc-support' }),
    serviceName: 'svc-support',
    identitySecret,
    loop,
  });
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  return { app, loop, get };
}
