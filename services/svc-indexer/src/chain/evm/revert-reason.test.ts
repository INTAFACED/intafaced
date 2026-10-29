import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { isTraceRefused, revertReasonFromData, traceReason } from './revert-reason.js';

const abi = parseAbi([
  'error Error(string message)',
  'error Panic(uint256 code)',
  'error InsufficientOut()',
  'error SomethingElse(uint256 x)',
]);

describe('revertReasonFromData', () => {
  it('reads empty revert data as no reason returned', () => {
    expect(revertReasonFromData('0x')).toBeNull();
    expect(revertReasonFromData(null)).toBeNull();
    expect(revertReasonFromData(undefined)).toBeNull();
  });

  it('names a protocol contract custom error', () => {
    expect(revertReasonFromData(encodeErrorResult({ abi, errorName: 'InsufficientOut' }))).toBe('InsufficientOut');
  });

  it('gives an Error(string) message and a Panic code', () => {
    expect(revertReasonFromData(encodeErrorResult({ abi, errorName: 'Error', args: ['too little'] }))).toBe('too little');
    expect(revertReasonFromData(encodeErrorResult({ abi, errorName: 'Panic', args: [0x11n] }))).toBe('Panic(0x11)');
  });

  it('shows an unknown custom error by selector, never as no reason', () => {
    const data = encodeErrorResult({ abi, errorName: 'SomethingElse', args: [1n] });
    expect(revertReasonFromData(data)).toBe(`Custom error ${data.slice(0, 10)}`);
    expect(revertReasonFromData('0xdead')).toBe('Unrecognised revert data 0xdead');
  });

  it('refuses malformed hex as no data rather than inventing a name', () => {
    expect(revertReasonFromData('0xzz')).toBeNull();
  });
});

describe('isTraceRefused', () => {
  it('takes any JSON-RPC error answer, anywhere in the cause chain, as the node refusing to trace', () => {
    expect(isTraceRefused({ name: 'X', cause: { code: -32601 } })).toBe(true);
    expect(isTraceRefused({ name: 'RpcRequestError', code: -32000, message: 'historical state unavailable' })).toBe(true);
    expect(isTraceRefused({ name: 'InvalidParamsRpcError', code: -32602 })).toBe(true);
    expect(isTraceRefused({ name: 'HttpRequestError', status: 403 })).toBe(true);
  });

  it('does not take a failure in transit or a busy node as a refusal', () => {
    expect(isTraceRefused({ name: 'HttpRequestError', cause: { code: 'ECONNREFUSED' } })).toBe(false);
    expect(isTraceRefused({ name: 'HttpRequestError', status: 429 })).toBe(false);
    expect(isTraceRefused({ name: 'HttpRequestError', status: 503 })).toBe(false);
    expect(isTraceRefused({ name: 'TimeoutError' })).toBe(false);
  });
});

describe('traceReason', () => {
  it('takes the top call output and nothing else', () => {
    expect(traceReason({ output: '0xbe664d40', calls: [{ output: '0xff' }] })).toBe('InsufficientOut');
    expect(traceReason(null)).toBeNull();
  });

  it('names the tracer error when the call failed without revert data, but not a plain revert', () => {
    expect(traceReason({ error: 'out of gas' })).toBe('out of gas');
    expect(traceReason({ error: 'execution reverted', output: '0x' })).toBeNull();
  });
});
