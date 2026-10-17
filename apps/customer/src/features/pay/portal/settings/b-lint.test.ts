import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyticsMessages } from './analytics/copy';
import { developersMessages } from './developers/copy';
import { reportsMessages } from './reports/copy';

/** The same word rules as `portal/copy-lint.test.ts`, applied to the three catalogs that file does not list. */
const catalogs = { developers: developersMessages, reports: reportsMessages, analytics: analyticsMessages };
const banned: Array<[string, RegExp]> = [
  ['a work-package code', /\bW\d+[a-z]?\d?\b/],
  ['"backend"', /\bback-?end\b/i],
  ['"stub"', /\bstubs?\b/i],
  ['"cursor"', /\bcursors?\b/i],
  ['"server"', /\bservers?\b/i],
  ['"contract"', /\bcontracts?\b/i],
  ['"loaded"', /\bloaded\b/i],
  ['"procedure"', /\bprocedures?\b/i],
  ['"projection"', /\bprojections?\b/i],
  ['"fixture"', /\bfixtures?\b/i],
  ['"arrives"', /\barrives?\b/i],
  ['"coming soon"', /coming soon/i],
  ['a snake_case word', /\b[a-z]+(?:_[a-z0-9]+)+\b/],
  ['a service code', /\bpay\.[a-z_]+/],
];
const root = fileURLToPath(new URL('.', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const own = ['developers', 'reports', 'analytics'].flatMap((d) => files(join(root, d))).filter((f) => !/\.test\./.test(f));

describe('copy for the developers, reports and analytics pages', () => {
  const entries = Object.entries(catalogs).flatMap(([ns, messages]) =>
    Object.entries(messages).map(([key, text]) => [`${ns}.${key}`, text] as const),
  );
  it('has words', () => expect(entries.length).toBeGreaterThan(300));
  it('uses no engineer words', () => {
    const offenders: string[] = [];
    for (const [id, text] of entries) {
      const words = text.replace(/\{[A-Za-z]+\}/g, '');
      for (const [name, pattern] of banned) if (pattern.test(words)) offenders.push(`${id} has ${name}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });
  it('has no key that nothing refers to', () => {
    const text = own.map((f) => readFileSync(f, 'utf8')).join('\n');
    const prefixes = [...text.matchAll(/`([A-Za-z0-9_]+)\$\{/g)].map((m) => m[1]!);
    const used = (key: string) => new RegExp(`['"\`]${key}['"\`]`).test(text) || prefixes.some((p) => key.startsWith(p));
    const dead = Object.entries(catalogs).flatMap(([ns, m]) =>
      Object.keys(m)
        .filter((k) => !used(k))
        .map((k) => `${ns}.${k}`),
    );
    expect(dead).toEqual([]);
  });
});

describe('what these pages may call', () => {
  const clients = ['developers/client.ts', 'reports/client.ts', 'analytics/client.ts']
    .map((f) => readFileSync(join(root, f), 'utf8'))
    .join('\n');
  it('names only merchant-scoped and own-key procedures', () => {
    const names = [
      ...clients.matchAll(
        /'((?:merchantOps|merchantAnalytics|merchantMetrics|apiKeys|setApiKeyRequestSigning|rotateSigningSecret|bindApiKeyIpAllowlist|unbindApiKeyIpAllowlist)[A-Za-z.]*)'/g,
      ),
    ].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(20);
    for (const name of names)
      expect(name).toMatch(
        /^(merchantOps\.(webhooks\.|exports\.|team\.list)|merchantAnalytics\.(volume|fees)|merchantMetrics\.series|apiKeys\.(list|create|revoke)|setApiKeyRequestSigning|rotateSigningSecret|bindApiKeyIpAllowlist|unbindApiKeyIpAllowlist)/,
      );
    expect(clients).not.toMatch(/admin:|operator|killswitch/i);
    expect(clients).not.toMatch(new RegExp(['founder', 'Admin'].join(''), 'i'));
  });
  it('never mints a live key from the portal', () => {
    expect(readFileSync(join(root, 'developers/client.ts'), 'utf8')).toMatch(/mode: 'sandbox'/);
    expect(readFileSync(join(root, 'developers/client.ts'), 'utf8')).not.toMatch(/mode: 'live'/);
  });
});

describe('secrets', () => {
  it('are never written to storage, the address or the console', () => {
    const text = own.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/);
  });
});
