import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import {
  createEdgeContext,
  EdgeTrustError,
  type EdgeContextOptions,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { JobSource } from './job-source.js';
import type { MiningHealthHonesty } from './health-honesty.js';
import { createMiningRouter, type MiningRouter } from './router.js';
import { MiningReadStore } from './reads.js';
import { handleSubmitSharePost } from './submit-share.js';

export type MiningHttpDeps = {
  readonly health: () => MiningHealthHonesty;
  readonly sql: Sql | null;
  readonly internalSecret: string | undefined;
  /** Per-service keys (S2S v3) for the share-ingest door. Unset keeps the shared secret alone. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly edgeSecret: string | undefined;
  /** Optional edge public key and limits (`edgeTrustFromProcessEnv`): verify the edge's public-key signature as well. */
  readonly edgeTrust?: Pick<EdgeContextOptions, 'edgePublicKey' | 'principalLimits'>;
  readonly ledger: Pick<LedgerClient, 'getTxByKey'> | null;
  readonly jobSource?: JobSource | null;
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function rawBodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function trpcProcedurePath(url: string): string | null {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  if (path !== '/trpc' && !path.startsWith('/trpc/')) return null;
  return path.slice('/trpc/'.length);
}

export function createMiningRequestHandler(deps: MiningHttpDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const secret = deps.edgeSecret?.trim() ?? '';
  let edge: ReturnType<typeof createEdgeContext> | null = null;
  let router: MiningRouter | null = null;
  if (secret.length >= 32) {
    try {
      edge = createEdgeContext({
        secret,
        ...deps.edgeTrust,
        serviceName: 'svc-mining-pool',
        ...(deps.internalSecret && deps.internalSecret.trim().length >= 32 ? { internalSecret: deps.internalSecret.trim() } : {}),
      });
      router = createMiningRouter(new MiningReadStore(deps.sql, deps.ledger));
    } catch (err) {
      if (!(err instanceof EdgeTrustError)) throw err;
      edge = null;
      router = null;
    }
  }

  return async (request, response) => {
    const url = request.url ?? '';
    const pathOnly = url.split('?')[0] ?? url;
    if (pathOnly === '/health' || pathOnly === '/ready') {
      json(response, 200, deps.health());
      return;
    }
    if (request.method === 'POST' && pathOnly === '/submitShare') {
      const rawBody = await rawBodyOf(request);
      const result = await handleSubmitSharePost({
        headers: request.headers,
        rawBody,
        secret: deps.internalSecret,
        ...(deps.s2s ? { s2s: { ...deps.s2s, method: request.method, url: request.url } } : {}),
        sql: deps.sql,
        jobSource: deps.jobSource ?? null,
      });
      json(response, result.status, result.body);
      return;
    }
    const procedure = trpcProcedurePath(url);
    if (procedure !== null) {
      if (!edge || !router) {
        json(response, 401, { error: 'mining.edge_unconfigured' });
        return;
      }
      await nodeHTTPRequestHandler({
        req: request,
        res: response,
        path: procedure,
        router,
        createContext: ({ req }) =>
          edge!({
            headers: req.headers,
            id: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : '',
          }),
      });
      return;
    }
    json(response, 404, { error: 'mining.route_unavailable' });
  };
}
