/**
 * WHEN THERE IS NO CHAIN, SAY SO — with a code, not a stack trace.
 *
 * There is no EVM RPC in this environment (SOCKET §13 `socket.evm-rpc`).
 * Blank `PROTOCOL_RPC_URL` refuses boot; an operator-set URL with nothing
 * listening is classified here, not invented as live.
 * Every read in `client.ts` therefore fails today. The question this file
 * answers is not *whether* it fails — it is *how*.
 *
 * Before this file, a chain read failed as a raw viem `HttpRequestError` and
 * `router.ts` mapped anything it did not recognise to
 * `INTERNAL_SERVER_ERROR: 'Protocol request failed'`. A caller could not tell
 * "the chain is not there" from "svc-protocol has a bug", and a 500 invites a
 * retry that can never succeed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ContractFunctionZeroDataError`. viem raises it when a `view` call is made to
 * an address holding no code: the EVM returns `0x`, and there is nothing to
 * decode. It is not a transport failure and it is not a revert — it means **the
 * contract you asked about does not exist**.
 *
 * That error must never be flattened into an empty answer. `sessionStatus`
 * returns `{ exists: false, live: false, spentWei: null, revoked: null }` when
 * the chain reports no session, and that shape is indistinguishable from "we
 * asked an address with no code on it". One means "the owner granted nothing";
 * the other means "we do not know". A UI that renders the second as the first
 * tells a user their agent holds no permissions when the truth is that nobody
 * has looked. `protocol.contract_not_deployed` is that distinction, made
 * typed.
 *
 * Classification is by error name and by the `cause` chain rather than by
 * `instanceof` against viem's exported classes: viem re-wraps errors as it
 * bubbles them through the transport, so the concrete class at the top is a
 * version detail, while the names and the libuv `code` on the root cause are
 * stable and directly testable.
 */

/** Why a chain-dependent path could not answer. Never "something went wrong". */
export type ChainRefusalCode =
  /** Addresses are still the zero-address defaults — nothing is deployed. */
  | 'protocol.chain_not_configured'
  /** The RPC endpoint did not answer: refused, timed out, or unresolvable. */
  | 'protocol.chain_unreachable'
  /** The RPC answered, but the address holds no code. */
  | 'protocol.contract_not_deployed'
  /** The RPC answered for a different chain than the one we derive addresses for. */
  | 'protocol.chain_id_mismatch';

/**
 * Customer copy for a public response. One sentence, no endpoint, no spec id.
 * `chainStatus.reason` and errors classified from the RPC client use these strings.
 */
export const CHAIN_PUBLIC_TEXT: Record<ChainRefusalCode, string> = {
  'protocol.chain_not_configured': 'The chain is not configured.',
  'protocol.chain_unreachable': 'The chain connection is not available right now.',
  'protocol.contract_not_deployed':
    'The address holds no contract code on this chain, so there is nothing to read. This is not an empty result — the contract is absent.',
  'protocol.chain_id_mismatch': 'The chain connection is not the one this service expects.',
};

export class ChainUnavailableError extends Error {
  readonly code: ChainRefusalCode;
  /**
   * Operator diagnostic. The endpoint is scheme+host only.
   * Never copy this onto a public response.
   */
  readonly operatorDetail: string;
  /**
   * Set only for `protocol.chain_id_mismatch`. Chain ids are public facts.
   * Null for every other refusal.
   */
  readonly expectedChainId: number | null;
  readonly actualChainId: number | null;

  constructor(
    code: ChainRefusalCode,
    message: string,
    cause?: unknown,
    operatorDetail?: string,
    chainIds?: { readonly expectedChainId: number; readonly actualChainId: number },
  ) {
    // `cause` goes through the standard Error option rather than a redeclared
    // field: `useDefineForClassFields` is on at ES2022, so a parameter property
    // named `cause` would define over the one Error already installs.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChainUnavailableError';
    this.code = code;
    this.operatorDetail = operatorDetail ?? message;
    this.expectedChainId = chainIds?.expectedChainId ?? null;
    this.actualChainId = chainIds?.actualChainId ?? null;
  }
}

/** scheme + host (host includes a non-default port). Drops userinfo, path, query, and hash. */
export function redactRpcUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.host || (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
      return 'redacted-endpoint';
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'redacted-endpoint';
  }
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)]+/gi;

/** Replace every URL in `text` with scheme+host. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[.,;]+$/, '');
    return redactRpcUrl(trimmed) + match.slice(trimmed.length);
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Path, query, and userinfo fragments long enough to be a provider key. */
function secretFragments(rpcUrl: string): string[] {
  try {
    const url = new URL(rpcUrl);
    const parts: string[] = [];
    const add = (value: string, min: number) => {
      if (value.length >= min) parts.push(value);
    };
    if (url.username) add(safeDecode(url.username), 6);
    if (url.password) add(safeDecode(url.password), 8);
    for (const seg of url.pathname.split('/')) add(safeDecode(seg), 8);
    if (url.search.length > 1) add(url.search, 8);
    for (const [key, value] of url.searchParams) {
      add(key, 6);
      add(safeDecode(value), 8);
    }
    if (url.hash.length > 1) add(safeDecode(url.hash.slice(1)), 8);
    return parts.sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

/**
 * Remove endpoint secrets from a log line.
 * Whole URLs collapse to scheme+host; leftover key material from `rpcUrl` is cut.
 */
export function redactSecrets(text: string, rpcUrl?: string): string {
  let out = rpcUrl ? text.split(rpcUrl).join(redactRpcUrl(rpcUrl)) : text;
  out = redactUrlsInText(out);
  if (!rpcUrl) return out;
  for (const frag of secretFragments(rpcUrl)) {
    out = out.split(frag).join('[redacted]');
  }
  return out;
}

export function formatChainRefusalLog(code: string, detail: string): string {
  return `svc-protocol chain refusal code=${code} detail=${detail}`;
}

function redactedCause(err: unknown, rpcUrl: string): Error {
  const wrapped = new Error(redactSecrets(messageOf(err) || 'unknown error', rpcUrl));
  wrapped.name = nameOf(err) || 'Error';
  return wrapped;
}

/** Build a refusal, log the redacted diagnostic, and keep the public message free of the endpoint. */
export function chainRefusal(code: ChainRefusalCode, rpcUrl: string, cause: unknown, detail: string): ChainUnavailableError {
  const safeDetail = redactSecrets(detail, rpcUrl);
  const err = new ChainUnavailableError(
    code,
    CHAIN_PUBLIC_TEXT[code],
    cause === undefined ? undefined : redactedCause(cause, rpcUrl),
    safeDetail,
  );
  console.error(formatChainRefusalLog(code, safeDetail));
  return err;
}

/**
 * Public mismatch text. Both chain ids, no endpoint.
 * `CHAIN_PUBLIC_TEXT['protocol.chain_id_mismatch']` stays the fallback for a
 * message that ever grew a URL or a spec id.
 */
export function chainIdMismatchText(expectedChainId: number, actualChainId: number): string {
  return (
    `The chain connection answered as chain ${actualChainId}, but this service derives addresses for chain ${expectedChainId}. ` +
    `Refusing: an address predicted for the wrong chain is an address a user could fund and never reach.`
  );
}

/** Customer-facing sentence. A message that carries a URL or a spec id is replaced with fixed copy. */
export function publicRefusalText(err: ChainUnavailableError): string {
  if (/:\/\/|\bSOCKET\b/.test(err.message)) return CHAIN_PUBLIC_TEXT[err.code];
  return err.message;
}

/** Mismatch refusal. The public message names both chain ids; the log line keeps scheme+host only. */
export function chainIdMismatchRefusal(rpcUrl: string, expectedChainId: number, actualChainId: number): ChainUnavailableError {
  const endpoint = redactRpcUrl(rpcUrl);
  const detail =
    `The endpoint ${endpoint} answered as chain ${actualChainId}, but this service derives addresses for chain ` +
    `${expectedChainId}. Refusing: an address predicted for the wrong chain is an address a user could fund and never reach.`;
  const safeDetail = redactSecrets(detail, rpcUrl);
  const err = new ChainUnavailableError(
    'protocol.chain_id_mismatch',
    chainIdMismatchText(expectedChainId, actualChainId),
    undefined,
    safeDetail,
    { expectedChainId, actualChainId },
  );
  console.error(formatChainRefusalLog('protocol.chain_id_mismatch', safeDetail));
  return err;
}

/** libuv / undici codes that all mean "the endpoint is not there". */
const TRANSPORT_CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** viem error names that mean the transport never got an answer. */
const TRANSPORT_ERROR_NAMES = new Set([
  'HttpRequestError',
  'TimeoutError',
  'SocketClosedError',
  'RpcRequestError',
  'InternalRpcError',
  'ResourceUnavailableRpcError',
  'ConnectionFailedError',
]);

/** viem error names that mean "there is no code at that address". */
const ABSENT_CONTRACT_ERROR_NAMES = new Set(['ContractFunctionZeroDataError']);

/** Walk `cause` to the bottom. viem nests three or four deep. */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = err;
  // Bounded: a cycle in a cause chain would otherwise hang the request.
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function nameOf(value: unknown): string {
  return typeof (value as { name?: unknown })?.name === 'string' ? (value as { name: string }).name : '';
}

function codeOf(value: unknown): string {
  return typeof (value as { code?: unknown })?.code === 'string' ? (value as { code: string }).code : '';
}

function messageOf(value: unknown): string {
  return typeof (value as { message?: unknown })?.message === 'string' ? (value as { message: string }).message : '';
}

/**
 * Turn whatever viem threw into a typed refusal.
 *
 * The public message is fixed customer copy. `what` and the endpoint stay in
 * the operator detail, and the endpoint is scheme+host only.
 */
export function classifyChainError(err: unknown, what: string, rpcUrl: string): ChainUnavailableError {
  if (err instanceof ChainUnavailableError) return err;

  const chain = causeChain(err);
  const endpoint = redactRpcUrl(rpcUrl);
  const underlying = redactSecrets(messageOf(err) || 'unknown error', rpcUrl);

  // Absence first. It is the most specific signal and the one that must never
  // be mistaken for an empty result.
  for (const link of chain) {
    if (ABSENT_CONTRACT_ERROR_NAMES.has(nameOf(link)) || /returned no data \("0x"\)/.test(messageOf(link))) {
      return chainRefusal(
        'protocol.contract_not_deployed',
        rpcUrl,
        err,
        `${what}: the address holds no contract code on this chain, so there is nothing to read. ` +
          `This is not an empty result — the contract is absent. endpoint=${endpoint}`,
      );
    }
  }

  for (const link of chain) {
    if (TRANSPORT_CAUSE_CODES.has(codeOf(link)) || TRANSPORT_ERROR_NAMES.has(nameOf(link))) {
      return chainRefusal(
        'protocol.chain_unreachable',
        rpcUrl,
        err,
        `${what}: no answer from the EVM RPC at ${endpoint}. No chain state was read, so no result is being reported. underlying=${underlying}`,
      );
    }
  }

  return chainRefusal(
    'protocol.chain_unreachable',
    rpcUrl,
    err,
    `${what}: the EVM RPC at ${endpoint} did not return a usable answer (${underlying}). ` +
      `Refusing rather than reporting a result that was never read.`,
  );
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The zero-address defaults in `env.ts` are deliberate: an unset factory is a
 * loud zero rather than a plausible-looking address. Deriving a CREATE2 address
 * from `factory = 0x0` yields a real, checksummed, entirely fictional address —
 * the single worst output this service could give a user, because they can fund
 * it. `router.ts` refuses on this check before any arithmetic runs.
 */
export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

/** Refusal codes that mean the chain itself could not be read: then nothing honest can be listed. */
const CHAIN_DOWN = new Set(['protocol.chain_unreachable', 'protocol.chain_id_mismatch', 'protocol.chain_not_configured']);

/** True when `reason` is a refusal saying the chain itself is down (unreachable, wrong chain id, not configured). */
export const chainDown = (reason: unknown): boolean =>
  typeof reason === 'object' && reason !== null && CHAIN_DOWN.has(String((reason as { code?: unknown }).code));
