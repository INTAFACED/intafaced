import { MiningError } from './errors.js';
import { CONNECTION_URL_MAX, WORKER_PATTERN_MAX, publishedHost, publishedPort, publishedText } from './env.js';

/** Host or port unpublished or unusable. No port is filled in. */
export const CONNECTION_UNSET = 'mining.connection_unset';

export type PoolConnection = {
  readonly host: string;
  readonly port: string;
  readonly secureUrl: string | null;
  readonly accountId: string;
  readonly workerNamePattern: string | null;
};

export type ProbeTarget = { readonly host: string; readonly port: number };

function targetOf(env: NodeJS.ProcessEnv): ProbeTarget | null {
  const host = publishedHost(env.MINING_POOL_HOST);
  const port = publishedPort(env.MINING_POOL_PORT);
  if (host === null || host === 'invalid' || port === null || port === 'invalid') return null;
  return { host, port: Number(port) };
}

/** Host and port the probe may dial. Null when either is unpublished. Never a caller-supplied address. */
export function readProbeTarget(env: NodeJS.ProcessEnv = process.env): ProbeTarget {
  const target = targetOf(env);
  if (!target) throw new MiningError('Pool connection is not published', CONNECTION_UNSET);
  return target;
}

/**
 * Connection lines for the signed account. The account id is the argument, which
 * the router takes from the principal, never from the body or from an env value.
 * A blank secure URL or worker pattern is omitted. A blank host or port refuses.
 */
export function readPoolConnection(env: NodeJS.ProcessEnv, accountId: string): PoolConnection {
  const target = targetOf(env);
  const secureUrl = publishedText(env.MINING_POOL_SECURE_URL, CONNECTION_URL_MAX, false);
  const workerNamePattern = publishedText(env.MINING_WORKER_NAME_PATTERN, WORKER_PATTERN_MAX, false);
  const id = accountId.trim();
  if (!target || secureUrl === 'invalid' || workerNamePattern === 'invalid' || id.length === 0 || id.length > 200) {
    throw new MiningError('Pool connection is not published', CONNECTION_UNSET);
  }
  return {
    host: target.host,
    port: String(target.port),
    secureUrl,
    accountId: id,
    workerNamePattern,
  };
}
