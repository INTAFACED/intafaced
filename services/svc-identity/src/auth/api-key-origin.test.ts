import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiKeyOriginAllowed } from './api-key-origin.js';

const here = dirname(fileURLToPath(import.meta.url));
const authSrc = readFileSync(join(here, 'auth-service.ts'), 'utf8');
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');

describe('apiKeyOriginAllowed', () => {
  it('allows any origin when the whitelist is empty (server bots)', () => {
    expect(apiKeyOriginAllowed([], undefined)).toBe(true);
    expect(apiKeyOriginAllowed([], 'https://evil.example')).toBe(true);
  });

  it('refuses missing origin when the whitelist is set', () => {
    expect(apiKeyOriginAllowed(['app.example.com'], undefined)).toBe(false);
    expect(apiKeyOriginAllowed(['app.example.com'], null)).toBe(false);
    expect(apiKeyOriginAllowed(['app.example.com'], '')).toBe(false);
  });

  it('matches hostnames and full origins; rejects foreign hosts', () => {
    const list = ['app.example.com', 'https://partner.example'];
    expect(apiKeyOriginAllowed(list, 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://app.example.com/dashboard')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://partner.example')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://evil.example')).toBe(false);
    expect(apiKeyOriginAllowed(list, 'https://not-app.example.com')).toBe(false);
  });

  it('allows a subdomain of a listed registrable host', () => {
    expect(apiKeyOriginAllowed(['example.com'], 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(['example.com'], 'https://example.com')).toBe(true);
  });
});

describe('origin allowlist mint/bind is mounted (not helper-only)', () => {
  it('mergeRouters includes createApiKeyOriginRouter so bind/mint are live doors', () => {
    expect(indexSrc).toMatch(/createApiKeyOriginRouter\(sql, auth, auth\)/);
    expect(indexSrc).toMatch(/from ['"]\.\/api-key-origin-router\.js['"]/);
  });
});

describe('API key mode of record — default live, never sandbox unless minted', () => {
  it('createApiKey defaults omitted mode to live and prefixes via generateApiKey(mode)', () => {
    expect(authSrc).toMatch(/const mode = input\.mode === ['"]sandbox['"] \? ['"]sandbox['"] : ['"]live['"]/);
    expect(authSrc).toMatch(/generateApiKey\(mode\)/);
  });

  it('exchangeApiKey mints keyEnv from verified.mode — default live cannot become sandbox', () => {
    expect(authSrc).toMatch(/keyEnv:\s*verified\.mode/);
    expect(authSrc).not.toMatch(/keyEnv:\s*['"]sandbox['"]/);
  });
});
