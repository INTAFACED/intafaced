import { describe, expect, it } from 'vitest';
import { explorerLiveWrite } from './explorer-guard.js';

const tagged = { 'x-api-explorer': '1' };
const live = { kid: 'k1', key_env: 'live' };
const sandbox = { kid: 'k2', key_env: 'sandbox' };

describe('explorerLiveWrite (J-developer-15 #7, DV-console-01)', () => {
  it("refuses the explorer's write with a live key", () => {
    expect(explorerLiveWrite('POST', tagged, live)).toBe(true);
    expect(explorerLiveWrite('delete', tagged, live)).toBe(true);
    // A key with no environment recorded is a live key.
    expect(explorerLiveWrite('PUT', tagged, { kid: 'k3' })).toBe(true);
  });
  it("lets the explorer's reads through with a live key", () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(explorerLiveWrite(method, tagged, live)).toBe(false);
  });
  it("lets the explorer's write through with a sandbox key", () => {
    expect(explorerLiveWrite('POST', tagged, sandbox)).toBe(false);
  });
  it('leaves an untagged request and a request with no key alone', () => {
    expect(explorerLiveWrite('POST', {}, live)).toBe(false);
    expect(explorerLiveWrite('POST', tagged, null)).toBe(false);
    expect(explorerLiveWrite('POST', tagged, { key_env: 'live' })).toBe(false);
  });
});
