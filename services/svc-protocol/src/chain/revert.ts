/**
 * Was this error the EVM saying "execution reverted", or something else wearing its name?
 *
 * viem wraps a bare `-32603 Internal error`, a timeout and any HTTP 5xx body that merely contains the words
 * "execution reverted" in `ExecutionRevertedError` / `ContractFunctionRevertedError`. A flaky node must never read as a
 * token that demands an approval reset, so a class name alone is not evidence. A revert is: a JSON-RPC error with code 3
 * (the node's own "execution reverted" code), or a revert-named error whose text says revert and that has no internal-error
 * code and no transport failure anywhere in its cause chain.
 */
const REVERT_NAMES = new Set(['ContractFunctionRevertedError', 'ExecutionRevertedError']);
const TRANSPORT_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'WebSocketRequestError', 'RpcRequestError']);

function chainOf(err: unknown): Array<Record<string, unknown>> {
  const links: Array<Record<string, unknown>> = [];
  for (let link: unknown = err, depth = 0; link && typeof link === 'object' && depth < 10; depth += 1) {
    links.push(link as Record<string, unknown>);
    link = (link as { cause?: unknown }).cause;
  }
  return links;
}

export function isExecutionRevert(err: unknown): boolean {
  const links = chainOf(err);
  if (links.some((link) => link.code === 3)) return true;
  if (links.some((link) => link.code === -32603)) return false;
  if (links.some((link) => TRANSPORT_NAMES.has(String(link.name)) && link.code !== 3)) return false;
  if (links.some((link) => typeof link.status === 'number' && link.status >= 500)) return false;
  return links.some(
    (link) =>
      REVERT_NAMES.has(String(link.name)) &&
      /revert/i.test(`${String(link.details ?? '')} ${String(link.shortMessage ?? '')} ${String(link.message ?? '')}`),
  );
}
