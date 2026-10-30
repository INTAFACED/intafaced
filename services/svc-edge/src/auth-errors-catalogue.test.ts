import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CATALOGUE, AUTH_ERRORS_PATH, type AuthErrorEntry } from '@intafaced/contracts/auth-errors';
import * as refusals from './api-key-refusal.js';
import { apiKeyRefusalBody, type ApiKeyRefusal } from './api-key-refusal.js';
import type { Principal } from '@intafaced/auth';
import { createQuotaStore, decideGateway, parseSandboxHosts } from './gateway-plane.js';
import { AUTH_ERRORS_DOCS } from './reply-envelope.js';

// The published catalogue (/developers/errors/auth) is the list a bot branches on. These tests hold the edge to it in
// both directions: every refusal the edge sends to a key holder is an entry with the same status and codes, and every
// entry the edge answers is a refusal it sends.

const isRefusal = (value: unknown): value is ApiKeyRefusal =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ApiKeyRefusal).code === 'string' &&
  typeof (value as ApiKeyRefusal).status === 'number' &&
  typeof (value as ApiKeyRefusal).intafacedCode === 'string';

const keyRefusals = Object.values(refusals).filter(isRefusal);
const shape = (e: Pick<AuthErrorEntry, 'code' | 'status' | 'intafacedCode'>) => `${e.status} ${e.code} ${e.intafacedCode}`;

const key = (overrides: Partial<Principal>): Principal => ({
  sub: 'u',
  userId: 'u',
  scopes: ['trade:read'],
  tier: 'none',
  mfa: false,
  sid: 's',
  expiresAt: new Date(Date.now() + 60_000),
  kid: 'key-1',
  key_env: 'live',
  ...overrides,
});
/** What the gateway answers a key on the trade door, as sent: status, code and intafacedCode. */
const gatewayRefusal = (principal: Principal, method: string, host?: string) => {
  const decided = decideGateway({
    pathname: '/api/v1/orders',
    method,
    principal,
    quota: createQuotaStore(),
    now: 0,
    max: 10,
    windowMs: 60_000,
    host,
    sandboxHosts: parseSandboxHosts('sandbox.example'),
  });
  expect(decided.allow).toBe(false);
  const { status, body } = decided as Extract<typeof decided, { allow: false }>;
  return { status, code: String(body.code), intafacedCode: String(body.intafacedCode) } as Pick<
    AuthErrorEntry,
    'code' | 'status' | 'intafacedCode'
  >;
};
// A key without trade:write placing an order, and a live key at the sandbox host.
const scopeRefusal = () => gatewayRefusal(key({ scopes: ['trade:read'] }), 'POST', 'api.example');
const environmentRefusal = () => gatewayRefusal(key({ scopes: ['trade:read', 'trade:write'] }), 'GET', 'sandbox.example');
const SEND_503 = /\.code\(503\)[\s\S]{0,120}?\.send\((\{[^}]*\})\)/g;

describe('the authentication and permission catalogue', () => {
  it('lists every key and signature refusal the edge sends, with its status and codes, anchored by its code', () => {
    expect(keyRefusals.length).toBe(10);
    for (const refusal of keyRefusals) {
      const entries = AUTH_ERROR_CATALOGUE.filter((e) => e.code === refusal.code);
      expect(entries.map(shape), refusal.code).toEqual([shape(refusal)]);
      expect(entries[0]!.answeredBy).toBe('edge');
      expect(apiKeyRefusalBody(refusal).docs).toBe(`${AUTH_ERRORS_PATH}#${entries[0]!.anchor}`);
    }
  });

  it('lists the scope and environment refusals in the trade door’s dialect', () => {
    for (const [cause, sent] of [
      ['scope', scopeRefusal()],
      ['environment', environmentRefusal()],
    ] as const) {
      const entry = AUTH_ERROR_CATALOGUE.find((e) => e.cause === cause);
      expect(entry && shape(entry), cause).toBe(shape(sent));
      expect(entry!.answeredBy).toBe('edge');
    }
  });

  it('lists the edge’s 503 when identity cannot be asked', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const sent = [...index.matchAll(SEND_503)].map((m) => m[1]!).find((body) => body.includes('edge.authority_unavailable')) ?? '';
    expect(sent).toContain("code: 'edge.authority_unavailable'");
    expect(sent).not.toContain('intafacedCode');
    expect(AUTH_ERROR_CATALOGUE.find((e) => e.code === 'edge.authority_unavailable')).toMatchObject({ status: 503, answeredBy: 'edge' });
  });

  it('holds no edge entry the edge does not send', () => {
    const sent = new Set([
      ...keyRefusals.map(shape),
      shape(scopeRefusal()),
      shape(environmentRefusal()),
      shape({ code: 'edge.authority_unavailable', status: 503, intafacedCode: null }),
    ]);
    const listed = AUTH_ERROR_CATALOGUE.filter((e) => e.answeredBy === 'edge').map(shape);
    expect([...listed].sort()).toEqual([...sent].sort());
  });

  it('gives each entry its own anchor and cause, and links to the page the catalogue is published on', () => {
    expect(AUTH_ERRORS_DOCS).toBe(AUTH_ERRORS_PATH);
    expect(new Set(AUTH_ERROR_CATALOGUE.map((e) => e.anchor)).size).toBe(AUTH_ERROR_CATALOGUE.length);
    expect(new Set(AUTH_ERROR_CATALOGUE.map((e) => e.cause)).size).toBe(AUTH_ERROR_CATALOGUE.length);
  });
});
