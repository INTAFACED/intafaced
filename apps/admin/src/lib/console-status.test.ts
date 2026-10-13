import { describe, expect, it } from 'vitest';
import { consoleLooksFullyGreen, describeUnconfigured, haltBlockedReason, readConsoleStatus } from './console-status';
const read = (env: Record<string, string | undefined> = {}) => readConsoleStatus({ NODE_ENV: 'test', ...env });
const TOKEN = 'isolated-operator-secret',
  TREASURY = 'isolated-treasury-secret',
  PROXY = 'isolated-proxy-secret';
const fields = ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN', 'ADMIN_BFF_SHARED_SECRET'] as const;
const values = ['http://isolated-edge:4000', TOKEN, TREASURY, PROXY];
describe('transport configuration never creates a module capability or personal authority', () => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))('keeps transport matrix%s separate from action availability', (mask) => {
    const env = Object.fromEntries(fields.map((key, i) => [key, mask & (1 << i) ? values[i] : undefined]));
    const state = read(env);
    expect(state.module.configured).toBe(Boolean(mask & 1 && mask & 2));
    expect(state.treasury.configured).toBe(Boolean(mask & 1 && mask & 4));
    expect(state.bffGated).toBe(Boolean(mask & 8));
    expect(state.fullyConfigured).toBe(state.module.configured && state.treasury.configured);
    expect(state.moduleActionAvailable).toBe(false);
    expect(consoleLooksFullyGreen(state)).toBe(false);
    expect(state).not.toHaveProperty('canHaltAnything');
    const json = JSON.stringify(state);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(TREASURY);
    expect(json).not.toContain(PROXY);
  });
  it('whitespace stays missing and names are deduplicated', () => {
    const state = read({ EDGE_URL: ' ', ADMIN_OPERATOR_TOKEN: ' ', ADMIN_TREASURY_TOKEN: ' ', ADMIN_BFF_SHARED_SECRET: ' ' });
    expect(state.module.missing).toEqual(['EDGE_URL', 'ADMIN_OPERATOR_TOKEN']);
    expect(state.missing).toEqual(['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN']);
    expect(state.edgeUrl).toBeNull();
    expect(state.bffGated).toBe(false);
  });
  it('a configured address is retained only in the server status, without token values', () => {
    const state = read({ EDGE_URL: 'http://isolated-edge:4000/', ADMIN_OPERATOR_TOKEN: TOKEN });
    expect(state.edgeUrl).toBe('http://isolated-edge:4000');
    expect(state.treasury.missing).toEqual(['ADMIN_TREASURY_TOKEN']);
  });
  it('missing messages describe transport, not a promise to halt after setting a token', () => {
    const state = read({ EDGE_URL: 'http://isolated-edge:4000' });
    const module = describeUnconfigured(state.module),
      treasury = describeUnconfigured(state.treasury);
    expect(module).toContain('read module state');
    expect(module).toContain('ADMIN_OPERATOR_TOKEN');
    expect(module).not.toContain('EDGE_URL');
    expect(module).not.toContain('halt a module');
    expect(treasury).toContain('ledger freeze and unfreeze procedures');
    expect(treasury).toContain('ADMIN_TREASURY_TOKEN');
    expect(treasury).not.toContain('stop ALL');
  });
  it('null transport block reason is not an action availability result', () => {
    const state = read({ EDGE_URL: 'http://isolated-edge:4000', ADMIN_OPERATOR_TOKEN: TOKEN });
    expect(haltBlockedReason(state.module)).toBeNull();
    expect(state.moduleActionAvailable).toBe(false);
    expect(haltBlockedReason(state.treasury)).toContain('ADMIN_TREASURY_TOKEN');
  });
});
