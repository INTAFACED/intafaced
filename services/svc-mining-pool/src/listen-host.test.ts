import { describe, expect, it } from 'vitest';
import { listenHost } from './listen-host.js';

describe('listenHost', () => {
  it('binds the address HTTP_HOST names', () => {
    expect(listenHost({ HTTP_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(listenHost({ HTTP_HOST: ' 127.0.0.1 ' })).toBe('127.0.0.1');
  });

  it('keeps 0.0.0.0 when HTTP_HOST is unset or blank', () => {
    expect(listenHost({})).toBe('0.0.0.0');
    expect(listenHost({ HTTP_HOST: '  ' })).toBe('0.0.0.0');
  });
});
