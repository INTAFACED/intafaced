import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { devAccount, PUBLIC_ANVIL_DEV_MNEMONIC, suiteAccount, suiteId, suiteSenderIndex } from '../../scripts/dev-chain.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE ON THE BUG THAT COST FOUR AGENTS A DAY EACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two on-chain suites sending from one account race that account's nonce.
 * `pnpm verify` runs packages in parallel and vitest runs files in parallel
 * inside them, so the loser fails with `nonce too low` — in a DIFFERENT file
 * each run, with nothing wrong in its own diff. Four separate agents saw a red
 * suite they had not touched and went looking for a bug that was not there.
 *
 * `scripts/dev-chain.ts` now derives each suite's sender from the suite's own
 * path, so collisions cannot be introduced by forgetting what somebody else
 * picked. This file is the check that the derivation actually holds for the
 * suites that exist, and that nobody quietly goes back to picking indices.
 *
 * It needs no chain. That is deliberate: a guard that only runs when anvil is
 * up would be absent on exactly the laptop that most needs it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const serviceRoot = join(srcRoot, '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.turbo', 'coverage'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** This file is excluded: it names the patterns it forbids, so it matches itself. */
const selfPath = fileURLToPath(import.meta.url);
const testFiles = [...walk(srcRoot)].filter((f) => f.endsWith('.test.ts') && f !== selfPath);

const label = (f: string) => relative(serviceRoot, f).replace(/\\/g, '/');

/** Suites that take a sender: the ones that call `devSuiteClients(import.meta.url)`. */
const onChainSuites = testFiles.filter((f) => /devSuiteClients\(\s*import\.meta\.url/.test(readFileSync(f, 'utf8')));

/** anvil's ten pre-funded accounts — `deploy-dev.ts` territory, off limits to suites. */
const PREFUNDED = new Set(
  Array.from({ length: 10 }, (_, i) => mnemonicToAccount(PUBLIC_ANVIL_DEV_MNEMONIC, { addressIndex: i }).address.toLowerCase()),
);

describe('every on-chain suite sends from an account no other suite sends from', () => {
  it('found the on-chain suites at all', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, which is the failure mode of scans like this one.
    expect(onChainSuites.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every suite a distinct sender', () => {
    const byAddress = new Map<string, string[]>();
    for (const file of onChainSuites) {
      const address = suiteAccount(pathToFileURL(file).href).address.toLowerCase();
      byAddress.set(address, [...(byAddress.get(address) ?? []), label(file)]);
    }

    const collisions = [...byAddress.entries()].filter(([, files]) => files.length > 1);
    expect(collisions.map(([address, files]) => `${address} ← ${files.join(' + ')}`)).toEqual([]);
    expect(byAddress.size).toBe(onChainSuites.length);
    // BIP-32 derivation for every on-chain suite is CPU-bound; under CI load it runs past vitest's 5 s default.
  }, 30_000);

  it('never lands a suite on one of anvil\u2019s ten pre-funded accounts', () => {
    // Those are `deploy-dev.ts`'s, and docker-compose.apps.yml names the CREATE
    // addresses that account's nonce produces. A suite sending from one of them
    // would move those addresses and the compose defaults would go stale.
    for (const file of onChainSuites) {
      const address = suiteAccount(pathToFileURL(file).href).address.toLowerCase();
      expect(PREFUNDED.has(address), `${label(file)} derived a pre-funded account`).toBe(false);
    }
    expect(PREFUNDED.has(devAccount(0).address.toLowerCase())).toBe(true);
  }, 30_000);

  it('leaves no suite picking an anvil index by hand', () => {
    // The thing that actually drifted. `devChainClients(url, id, N)` is for
    // `scripts/deploy-dev.ts`, which owns index 0 on purpose; a test file
    // calling it is a suite choosing a sender out of a comment again.
    const offenders = testFiles.filter((f) => /\bdevChainClients\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map(label)).toEqual([]);
  });
});

describe('the derivation itself', () => {
  it('keys off the path from services/ down, so a worktree and CI agree', () => {
    const a = 'file:///home/runner/work/intafaced/intafaced/services/svc-protocol/src/amm/pool-factory-onchain.test.ts';
    const b = 'file:///C:/Users/dev/plug-x-inta-worktrees/fix-x/services/svc-protocol/src/amm/pool-factory-onchain.test.ts';
    expect(suiteId(a)).toBe('services/svc-protocol/src/amm/pool-factory-onchain.test.ts');
    expect(suiteId(b)).toBe(suiteId(a));
    expect(suiteSenderIndex(b)).toBe(suiteSenderIndex(a));
  });

  it('separates the two files that used to share index 3', () => {
    const base = 'file:///repo/services/svc-protocol/src';
    expect(suiteSenderIndex(`${base}/launch/token-factory-onchain.test.ts`)).not.toBe(
      suiteSenderIndex(`${base}/amm/pool-factory-onchain.test.ts`),
    );
  });

  it('stays inside the BIP-32 non-hardened range', () => {
    for (const file of onChainSuites) {
      const index = suiteSenderIndex(pathToFileURL(file).href);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(2 ** 31);
    }
  });
});
