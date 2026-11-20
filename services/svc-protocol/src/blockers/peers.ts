import type { ZodType } from 'zod';
import { indexerStatusSchema, unwrapTrpcData, type BlockerSource, type IndexerStatus } from '@intafaced/contracts';
import { DEX_HEALTH, type DexHealth } from '@intafaced/contracts/dex-procedures';
import { trpcRecordReply } from '@intafaced/contracts/procedure-trpc';

/**
 * Where `protocol.blockers` learns what the indexer and the DEX say about themselves.
 *
 * Both are read through their public tRPC procedures (`indexer.status`, `dex.health` by its record), never their tables. Neither read
 * carries a credential, and the caller's region is forwarded so a screened region stays screened at the peer.
 *
 * A peer with no URL or no timeout is "not connected in this environment" (the gateway's own word for it). Nothing here
 * invents a URL or a timeout, and a peer that fails to answer is reported as such: an unknown source blocks like a no.
 */
export interface PeerConfig {
  readonly url: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

export interface Peers {
  indexer(region: string | undefined): Promise<BlockerSource<IndexerStatus>>;
  dex(region: string | undefined): Promise<BlockerSource<DexHealth>>;
}

const NOT_CONNECTED = {
  status: 'down',
  reason: 'not_connected',
  message: 'This service is not connected in this environment.',
  code: 'edge.upstream_unwired',
} as const;

const unreachable = (message: string): BlockerSource<never> => ({ status: 'down', reason: 'unreachable', message });

/** A reply's parser: the data, or `null` when it is not the published shape. */
type Reply<T> = (body: unknown) => T | null;
const bySchema =
  <T>(schema: ZodType<T>): Reply<T> =>
  (body) => {
    const parsed = schema.safeParse(unwrapTrpcData(body));
    return parsed.success ? parsed.data : null;
  };

async function read<T>(config: PeerConfig, procedure: string, reply: Reply<T>, region: string | undefined): Promise<BlockerSource<T>> {
  const timeoutMs = config.timeoutMs;
  if (!config.url || timeoutMs === undefined) return NOT_CONNECTED;
  const doFetch = config.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${config.url.replace(/\/+$/, '')}/trpc/${procedure}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { accept: 'application/json', ...(region ? { 'x-intafaced-region': region } : {}) },
    });
  } catch {
    return unreachable('The service could not be reached.');
  }
  if (!response.ok) return { status: 'down', reason: `http_${response.status}`, message: 'The service refused to answer.' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'down', reason: 'malformed', message: 'The service answered with something unreadable.' };
  }
  const data = reply(body);
  return data !== null
    ? { status: 'ok', data }
    : { status: 'down', reason: 'malformed', message: 'The service answered with something unreadable.' };
}

export function createPeers(config: { indexer: PeerConfig; dex: PeerConfig }): Peers {
  return {
    indexer: (region) => read(config.indexer, 'status', bySchema(indexerStatusSchema), region),
    dex: (region) => read(config.dex, DEX_HEALTH.path, (body) => trpcRecordReply(DEX_HEALTH, body), region),
  };
}

/** No peers wired: both read as not connected. */
export const noPeers: Peers = {
  indexer: async () => NOT_CONNECTED,
  dex: async () => NOT_CONNECTED,
};
