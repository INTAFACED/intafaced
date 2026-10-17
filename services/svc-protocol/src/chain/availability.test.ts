import { describe, expect, it } from 'vitest';
import { ChainUnavailableError, classifyChainError, isZeroAddress, ZERO_ADDRESS } from './availability.js';

/**
 * The classifier, tested against the error shapes viem actually throws.
 *
 * These fixtures are hand-built rather than produced by making real failing
 * calls: the point under test is the classification, and a test that needed a
 * live RPC to prove "we behave correctly without a live RPC" could never run in
 * the environment it describes.
 *
 * The shapes are taken from viem's own error classes — `name` on the wrapper and
 * a libuv `code` on the root `cause` — which is exactly why the classifier reads
 * those two fields instead of using `instanceof`.
 */

/** How viem surfaces a refused connection: BaseError wrapper, libuv cause. */
function connectionRefused(): Error {
  const root = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8545'), { code: 'ECONNREFUSED' });
  const transport = Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', cause: root });
  return Object.assign(new Error('Details: connect ECONNREFUSED'), { name: 'CallExecutionError', cause: transport });
}

/** How viem surfaces a `view` call to an address with no code. */
function zeroData(): Error {
  const zero = Object.assign(new Error('The contract function "getSession" returned no data ("0x").'), {
    name: 'ContractFunctionZeroDataError',
  });
  return Object.assign(new Error('The contract function "getSession" reverted.'), {
    name: 'ContractFunctionExecutionError',
    cause: zero,
  });
}

describe('classifying a failed chain read', () => {
  it('calls a refused connection unreachable, and names the endpoint only in the operator detail', () => {
    const err = classifyChainError(connectionRefused(), 'sessionOf', 'http://localhost:8545');
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect(err.code).toBe('protocol.chain_unreachable');
    expect(err.message).toBe('The chain connection is not available right now.');
    expect(err.message).not.toContain('localhost');
    expect(err.message).not.toContain('SOCKET');
    expect(err.operatorDetail).toContain('http://localhost:8545');
    expect(err.operatorDetail).toContain('sessionOf');
  });

  it.each(['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'])('treats %s on the cause chain as unreachable', (code) => {
    const root = Object.assign(new Error('socket'), { code });
    const wrapped = Object.assign(new Error('outer'), { cause: root });
    expect(classifyChainError(wrapped, 'isDeployed', 'http://rpc').code).toBe('protocol.chain_unreachable');
  });

  it('recognises a viem timeout by name even with no libuv cause', () => {
    const err = Object.assign(new Error('The request took too long'), { name: 'TimeoutError' });
    expect(classifyChainError(err, 'ownerOf', 'http://rpc').code).toBe('protocol.chain_unreachable');
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * `returned no data ("0x")` means the contract is absent. If this were
   * classified as `chain_unreachable` — or worse, swallowed into an empty result
   * — `sessionStatus` would report "no session" about an account nobody has
   * looked at.
   */
  it('calls a zero-data view result an absent contract, not a transport failure', () => {
    const err = classifyChainError(zeroData(), 'sessionOf', 'http://rpc');
    expect(err.code).toBe('protocol.contract_not_deployed');
    expect(err.message).toContain('not an empty result');
  });

  it('prefers absence over transport when both appear in one chain', () => {
    // A transport-shaped wrapper around a zero-data cause must not be reported
    // as "the chain is down": the chain answered, and its answer was "no code".
    const nested = Object.assign(new Error('HTTP request failed.'), {
      name: 'HttpRequestError',
      cause: zeroData(),
    });
    expect(classifyChainError(nested, 'sessionOf', 'http://rpc').code).toBe('protocol.contract_not_deployed');
  });

  it('classifies an unrecognised error as unreachable rather than inventing success', () => {
    const err = classifyChainError(new Error('something odd'), 'poolReserves', 'http://rpc.example');
    expect(err.code).toBe('protocol.chain_unreachable');
    expect(err.message).not.toContain('something odd');
    expect(err.operatorDetail).toContain('something odd');
    expect(err.operatorDetail).toContain('http://rpc.example');
  });

  it('passes an already-typed refusal through unchanged', () => {
    const original = new ChainUnavailableError('protocol.chain_not_configured', 'nope');
    expect(classifyChainError(original, 'x', 'http://rpc')).toBe(original);
  });

  it('survives a cyclic cause chain instead of hanging', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' };
    const b = { message: 'b', cause: a };
    a.cause = b;
    expect(classifyChainError(a, 'sessionOf', 'http://rpc').code).toBe('protocol.chain_unreachable');
  });

  it('keeps a redacted cause so a logged error cannot carry the endpoint secret', () => {
    const root = connectionRefused();
    const rpc = 'http://user:fk_test_secret_key@rpc.example/v1/fk_test_secret_key?apikey=fk_test_query_key';
    const err = classifyChainError(root, 'sessionOf', rpc);
    expect(err.cause).not.toBe(root);
    expect((err.cause as Error).message).not.toContain('fk_test_secret_key');
    expect((err.cause as Error).message).not.toContain('fk_test_query_key');
    expect(err.operatorDetail).toContain('http://rpc.example');
    expect(err.operatorDetail).not.toContain('fk_test_secret_key');
    expect(err.operatorDetail).not.toContain('fk_test_query_key');
    expect(err.message).not.toContain('SOCKET');
  });
});

describe('the zero address is treated as "not deployed", not as an address', () => {
  it('matches regardless of case', () => {
    expect(isZeroAddress(ZERO_ADDRESS)).toBe(true);
    expect(isZeroAddress('0x0000000000000000000000000000000000000000'.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('does not match a real address', () => {
    expect(isZeroAddress('0x1111111111111111111111111111111111111111')).toBe(false);
  });
});
