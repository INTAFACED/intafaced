/**
 * `./s2s-http.js` for `post-recipe-door.pg.test.ts` run against the Rust door (`vitest.config.mts`, project
 * `post-recipe-pg`): everything as it is, except `registerS2sHttp`, which mounts nothing of the TypeScript door. The
 * test's app instead hands each `/trpc/<door>` call to the Rust binary serving the same book (`rust-db.ts`), its body's
 * exact bytes, and answers what the binary answered.
 *
 * Who called is what the test's own signature proves, checked with the verifier and secret the test passes in
 * (`verifyServiceRequest`, as the TypeScript door checks it); the call is signed again for the binary with that
 * service's conformance key (`signerFor`). A call the test's signature does not prove goes on unsigned, so the binary
 * refuses it as unauthenticated.
 */
import type { FastifyInstance } from 'fastify';
import { inboundRawBodyOf, retainRawBody, verifyServiceRequest } from '../../../../packages/contracts/src/index.ts';
import { currentRustBook } from './rust-db.ts';
import { signerFor } from './rust-door.ts';

export * from '../../../../services/svc-ledger/src/s2s-http.ts';

interface Options {
  readonly bodyBind?: 'require' | 'optional';
  readonly s2s?: { readonly verifier?: unknown; readonly mode?: 'dual' | 'keypair' };
}

export function registerS2sHttp(app: FastifyInstance, _ledger: unknown, secret: string, options: Options = {}): void {
  retainRawBody(app as never);
  app.post('/trpc/:door', async (req, reply) => {
    const { door } = req.params as { door: string };
    const auth = verifyServiceRequest(
      req as never,
      {
        verifier: options.s2s?.verifier,
        mode: options.s2s?.mode,
        legacySecret: secret,
        bodyBindMode: options.bodyBind,
      } as never,
    );
    const raw = inboundRawBodyOf(req as never);
    const payload = raw.retained && raw.bytes ? Buffer.from(raw.bytes).toString('utf8') : '';
    const keyed = auth.scheme === 'keypair';
    const target = new URL(`${keyed ? currentRustBook().keyed : currentRustBook().plain}/trpc/${door}`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.service) {
      Object.assign(headers, signerFor(auth.service, keyed)(payload, { method: 'POST', url: target, contentType: 'application/json' }));
    }
    const answered = await fetch(target, { method: 'POST', headers, body: payload });
    return reply
      .code(answered.status)
      .header('content-type', 'application/json')
      .send(await answered.text());
  });
}
