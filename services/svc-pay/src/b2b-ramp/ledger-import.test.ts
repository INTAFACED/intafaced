import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Only money.ts in the B2B ramp may use ledger-client (for its amount parsing): with ledger-client, at its root and at
 * every subpath, refusing to load, and money.ts stood in for, every other module in this folder still loads. The
 * folder's files are listed by name, so a module added later is held too. That nothing here posts is
 * ledger-isolation.test.ts.
 */
const { refuse } = vi.hoisted(() => ({
  refuse: (): never => {
    throw new Error('a B2B ramp module other than money.ts loaded @intafaced/ledger-client');
  },
}));
vi.mock('@intafaced/ledger-client', refuse);
vi.mock('@intafaced/ledger-client/money', refuse);
vi.mock('@intafaced/ledger-client/recipes', refuse);
vi.mock('@intafaced/ledger-client/testing', refuse);
vi.mock('@intafaced/ledger-client/testing/ledger-door', refuse);
vi.mock('@intafaced/ledger-client/testing/saga', refuse);
vi.mock('@intafaced/ledger-client/history-page', refuse);
vi.mock('@intafaced/ledger-client/post-recipe', refuse);
vi.mock('@intafaced/ledger-client/operator-reverse', refuse);
vi.mock('@intafaced/ledger-client/gate', refuse);
// The one outside module the router loads at import that itself reaches ledger-client (through merchant controls):
// stood in, so this file judges the folder's own imports, as the fence is drawn. The router calls it only when built.
vi.mock('../namespaces/founder-procedure.js', () => ({
  founderProcedure: (): never => {
    throw new Error('stand-in: the router is loaded here, not built');
  },
}));
vi.mock('./money.js', () => ({
  parsePositiveAmount: () => ({ scaled: 0n, canonical: '0' }),
  sameAmount: () => false,
  parseAsset: (asset: string) => asset,
}));

const here = dirname(fileURLToPath(import.meta.url));
const modules = readdirSync(here)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'money.ts')
  .sort();

describe('only money.ts in the B2B ramp touches ledger-client', () => {
  it('the refusal is in force: money.ts itself does not load without ledger-client', async () => {
    await expect(vi.importActual('./money.js')).rejects.toThrow(/error when mocking a module/);
  });

  it('every other module in the folder loads with ledger-client refused', async () => {
    expect(modules).toEqual(['access.ts', 'config.ts', 'errors.ts', 'index.ts', 'router.ts', 'socket.ts']);
    const failed: string[] = [];
    for (const name of modules) {
      vi.resetModules();
      await import(/* @vite-ignore */ `./${name.replace(/\.ts$/, '.js')}`).catch(() => failed.push(name));
    }
    expect(failed).toEqual([]);
  });
});
