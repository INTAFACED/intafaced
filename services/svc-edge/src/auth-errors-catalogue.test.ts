import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CATALOGUE, AUTH_ERRORS_PATH, type AuthErrorEntry } from '@intafaced/contracts/auth-errors';
import * as refusals from './api-key-refusal.js';
import { apiKeyRefusalBody, type ApiKeyRefusal } from './api-key-refusal.js';
import { envMismatchBody, scopeRefuseBody } from './gateway-plane.js';
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
    const scope = scopeRefuseBody('trade', 'trade:write');
    const environment = envMismatchBody('trade');
    for (const body of [scope, environment]) {
      const entry = AUTH_ERROR_CATALOGUE.find((e) => e.intafacedCode === body.intafacedCode);
      expect(entry, String(body.intafacedCode)).toMatchObject({ code: body.code, status: 403, answeredBy: 'edge' });
    }
  });

  it('lists the edge’s 503 when identity cannot be asked', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/\.code\(503\)[\s\S]{0,120}code: 'edge\.authority_unavailable'/);
    expect(AUTH_ERROR_CATALOGUE.find((e) => e.code === 'edge.authority_unavailable')).toMatchObject({ status: 503, answeredBy: 'edge' });
  });

  it('holds no edge entry the edge does not send', () => {
    const sent = new Set([
      ...keyRefusals.map(shape),
      shape({ code: 'PermissionDenied', status: 403, intafacedCode: 'scope.denied' }),
      shape({ code: 'PermissionDenied', status: 403, intafacedCode: 'env.mismatch' }),
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
