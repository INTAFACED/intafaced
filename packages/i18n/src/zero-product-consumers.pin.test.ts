import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Honesty pin for infra.i18n.
 *
 * §9 wants every surface keyed. That is not "the catalog exists". Allowlisted
 * consumers are the surfaces that actually resolve keys:
 *
 *   · `svc-notify` — out-of-app channel copy (not a product screen)
 *   · `svc-pay` — payer-visible hosted checkout copy (not a product SPA)
 *   · `svc-ws` — close/error reason keys on the socket path (not a keyed UI)
 *   · `apps/admin` — operator console status / kill-switch / banner copy
 *   · `apps/customer` — the React customer app, which keys its screens through
 *     the catalog (`src/shared/i18n.tsx`, `copy.ts`, `locale.ts`; #4490)
 *   · `svc-p2p` — offer/instrument refuse copy (wire codes, not a keyed UI)
 *   · `svc-bank` — ramp/card wire refusals (dotted key when catalog misses)
 *   · `svc-market` — listing / vendor / commerce refuse copy
 *   · `svc-academy` — curriculum / cert / lobby refuse copy
 *   · `svc-identity` — auth / KYC / rank refuse copy
 *   · `svc-token` — stake / mint / distribute refuse copy
 *   · `svc-ledger` — posting / freeze / recipe refuse copy
 *   · `svc-matching` — operator/public refuse copy on the HTTP inject door
 *   · `svc-edge` — public/proxy refuse copy on the internet door
 *   · `svc-support` — public/ops refuse + KB door copy
 *   · `svc-indexer` — public/read-model refuse + halt door copy (this slice)
 *
 * Other product apps and services must not depend on the package until they
 * key screens in the same PR. Do not loosen the scan to stay green. Do not
 * treat this allowlist as infra.i18n done — 100+ languages is still catalogs,
 * not this slice.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const I18N = '@intafaced/i18n';
const IMPORT_RE = /['"]@intafaced\/i18n(?:\/[^'"]*)?['"]/;

/** Product UI + product services. Allowlisted dirs already resolve catalog keys. */
const PRODUCT_ROOTS = ['apps', 'services'] as const;
const ALLOWED_APP_DIRS = new Set(['admin', 'customer']);
const ALLOWED_SERVICE_DIRS = new Set([
  'svc-notify',
  'svc-pay',
  'svc-ws',
  'svc-p2p',
  'svc-bank',
  'svc-market',
  'svc-academy',
  'svc-identity',
  'svc-token',
  'svc-ledger',
  'svc-matching',
  'svc-edge',
  'svc-support',
  'svc-indexer',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git']);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|json)$/;

function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function walkFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
}

function productWorkspaces(): { name: string; dir: string }[] {
  const rows: { name: string; dir: string }[] = [];
  for (const root of PRODUCT_ROOTS) {
    const parent = join(REPO_ROOT, root);
    for (const name of listDirs(parent)) {
      if (root === 'apps' && ALLOWED_APP_DIRS.has(name)) continue;
      if (root === 'services' && ALLOWED_SERVICE_DIRS.has(name)) continue;
      const dir = join(parent, name);
      try {
        if (statSync(join(dir, 'package.json')).isFile()) rows.push({ name: `${root}/${name}`, dir });
      } catch {
        /* not a workspace */
      }
    }
  }
  return rows;
}

const WORKSPACES = productWorkspaces();

describe('@intafaced/i18n — zero product consumers until surfaces key it', () => {
  it('finds product workspaces (otherwise this pin is vacuous)', () => {
    expect(WORKSPACES.length).toBeGreaterThan(4);
    expect(WORKSPACES.some((w) => w.name.startsWith('services/'))).toBe(true);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-notify')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-pay')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-ws')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-p2p')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-market')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-academy')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-identity')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-token')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-ledger')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-matching')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-edge')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-support')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-indexer')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'apps/admin')).toBe(false);
    expect(WORKSPACES.some((w) => w.name === 'services/svc-bank')).toBe(false);
    expect(statSync(join(REPO_ROOT, 'apps', 'admin', 'package.json')).isFile()).toBe(true);
  });

  it('has no product package.json depending on the package', () => {
    const hits: string[] = [];
    for (const ws of WORKSPACES) {
      const pkg = JSON.parse(readFileSync(join(ws.dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.dependencies?.[I18N] || pkg.devDependencies?.[I18N]) hits.push(ws.name);
    }
    expect(hits, hits.join(', ')).toEqual([]);
  });

  it('has no product source importing the package', () => {
    const hits: string[] = [];
    for (const ws of WORKSPACES) {
      const files: string[] = [];
      walkFiles(ws.dir, files);
      for (const file of files) {
        if (file.endsWith(`${join('')}package.json`.replace(join(''), 'package.json')) && file.endsWith('package.json')) {
          continue;
        }
        const text = readFileSync(file, 'utf8');
        if (IMPORT_RE.test(text)) hits.push(file.slice(REPO_ROOT.length));
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
