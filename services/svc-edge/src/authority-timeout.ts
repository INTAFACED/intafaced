/**
 * Which cap applies to the per-request identity authority read.
 *
 * Strict (`EDGE_AUTHORITY_STRICT_TIMEOUT_MS`, default 3000 ms) for every write and for every module
 * that moves money or touches security: trade, pay, bank, p2p, token, market, agents, dex,
 * protocol, identity, core-ops, execution, mining-pool. Anything else unlisted is strict too.
 * Only GET/HEAD to the read-only modules below may use the higher
 * `EDGE_AUTHORITY_READ_TIMEOUT_MS` (default 8000 ms). Either way, if identity cannot answer
 * in time the request gets 503 `edge.authority_unavailable` and nothing runs.
 */
const READ_TOLERANT_MODULES: ReadonlySet<string> = new Set(['academy', 'blueprint', 'indexer', 'quant', 'support', 'tax', 'notify']);

export function authorityTimeoutFor(
  method: string,
  module: string,
  env: { EDGE_AUTHORITY_STRICT_TIMEOUT_MS: number; EDGE_AUTHORITY_READ_TIMEOUT_MS: number },
): number {
  const read = method === 'GET' || method === 'HEAD';
  return read && READ_TOLERANT_MODULES.has(module) ? env.EDGE_AUTHORITY_READ_TIMEOUT_MS : env.EDGE_AUTHORITY_STRICT_TIMEOUT_MS;
}
