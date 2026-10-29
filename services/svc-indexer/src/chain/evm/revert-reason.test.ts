import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { isTraceUnsupported, revertReasonFromData, traceOutput } from './revert-reason.js';

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

describe('isTraceUnsupported', () => {
  it('matches method-not-found anywhere in the cause chain', () => {
    expect(isTraceUnsupported({ name: 'X', cause: { code: -32601 } })).toBe(true);
    expect(isTraceUnsupported({ name: 'MethodNotSupportedRpcError' })).toBe(true);
  });

  it('does not treat a transport failure as a node that will not trace', () => {
    expect(isTraceUnsupported({ name: 'HttpRequestError', cause: { code: 'ECONNREFUSED' } })).toBe(false);
  });
});

describe('traceOutput', () => {
  it('takes the top call output and nothing else', () => {
    expect(traceOutput({ output: '0x1234', calls: [{ output: '0xff' }] })).toBe('0x1234');
    expect(traceOutput({ error: 'execution reverted' })).toBeNull();
    expect(traceOutput(null)).toBeNull();
  });
});
