import { DEX_HEALTH, type DexHealth } from '@intafaced/contracts/dex-procedures';
import { INDEXER_STATUS } from '@intafaced/contracts/indexer-procedures';
import { trpcRecordReply, trpcRecordRequest } from '@intafaced/contracts/procedure-trpc';
import type { BlockerSource, IndexerStatus } from '@intafaced/contracts';
import { indexerStatusSchema } from '@intafaced/contracts/protocol-blockers';

/**
 * Where `protocol.blockers` learns what the indexer and the DEX say about themselves.
 *
 * Both are read through their public tRPC procedures by their records (`indexer.status`, `dex.health`), never their tables. Neither read
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

/** The call to send, and how its reply is read: `null` when it is not the published shape. */
interface PeerCall<T> {
  readonly url: (base: string) => string;
  readonly reply: (body: unknown) => T | null;
}

/**
 * The indexer's status read by its record, then cut to the facts `protocol.blockers` publishes (`indexerStatusSchema`):
 * the probe's RPC address and the rest stay in svc-indexer's answer and never reach a blockers reader.
 */
const INDEXER_STATUS_CALL: PeerCall<IndexerStatus> = {
  url: (base) => trpcRecordRequest(INDEXER_STATUS, base, undefined).url,
  reply: (body) => {
    const status = trpcRecordReply(INDEXER_STATUS, body);
    return status === null ? null : indexerStatusSchema.parse(status);
  },
};

/** svc-dex's health read by its record. */
const DEX_HEALTH_CALL: PeerCall<DexHealth> = {
  url: (base) => trpcRecordRequest(DEX_HEALTH, base, undefined).url,
  reply: (body) => trpcRecordReply(DEX_HEALTH, body),
};

async function read<T>(config: PeerConfig, call: PeerCall<T>, region: string | undefined): Promise<BlockerSource<T>> {
  const timeoutMs = config.timeoutMs;
  if (!config.url || timeoutMs === undefined) return NOT_CONNECTED;
  const doFetch = config.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(call.url(config.url), {
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
  const data = call.reply(body);
  return data !== null
    ? { status: 'ok', data }
    : { status: 'down', reason: 'malformed', message: 'The service answered with something unreadable.' };
}

export function createPeers(config: { indexer: PeerConfig; dex: PeerConfig }): Peers {
  return {
    indexer: (region) => read(config.indexer, INDEXER_STATUS_CALL, region),
    dex: (region) => read(config.dex, DEX_HEALTH_CALL, region),
  };
}

/** No peers wired: both read as not connected. */
export const noPeers: Peers = {
  indexer: async () => NOT_CONNECTED,
  dex: async () => NOT_CONNECTED,
};
