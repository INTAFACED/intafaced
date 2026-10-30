import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAccess, KYC_TIERS, MODULES, regionsWithEntries, UNSET_SCREENING_LIST } from '@intafaced/config';

/**
 * §22 AND §16.10, ASSERTED FROM INSIDE THE SERVICE.
 *
 * `custody-scan` checks the custody boundary from outside, over the whole repo.
 * This file checks it from in here, for two reasons: a repo-wide scanner can be
 * loosened in one place and quietly stop covering this service, and a scanner
 * cannot assert what `checkAccess` actually returns for this module.
 *
 * ── One dependency that needs its justification in the open ────────────────
 *
 * This service DOES depend on `@intafaced/ledger-client`, which svc-protocol
 * deliberately does not. It imports exactly one thing from it: the `/money`
 * subpath — `parseAmount`, `formatAmount`, `Amount`. That module is pure
 * arithmetic over scaled bigints with no I/O, no client and no recipe, and it
 * is the canonical answer to non-negotiable #3 ("never store money in a
 * `number`"). `packages/market-data` imports it for the same reason and ships
 * to the browser.
 *
 * The alternative was a second decimal parser living in this service, which is
 * how two implementations of money end up disagreeing in the last decimal
 * place. The tests below draw the line where it belongs: the money subpath is
 * allowed, the root export and the recipes are not, and that is checked here
 * per-file rather than left to the reviewer's memory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = sourceFiles(join(serviceRoot, 'src')).map((path) => ({ path, body: readFileSync(path, 'utf8') }));
/** Everything except this file, which necessarily quotes the patterns it bans. */
const shipped = files.filter((f) => !f.path.endsWith('sovereignty.test.ts'));

describe('svc-indexer · §22 — permissionless by architecture', () => {
  it('is registered non-custodial, on the protocol plane only', () => {
    expect(MODULES.indexer).toMatchObject({ service: 'svc-indexer', custodial: false, planes: ['protocol'] });
  });

  it('returns allowed.permissionless for every region and every tier', () => {
    const regions = [...regionsWithEntries(), 'DE', 'XX', 'JP', 'NG'];
    for (const region of regions) {
      for (const kycTier of KYC_TIERS) {
        const decision = checkAccess({
          module: 'indexer',
          plane: 'protocol',
          region,
          kycTier,
          regionFailClosed: false,
          screeningFailClosed: false,
        });
        expect(decision.code, `${region}/${kycTier}`).toBe('allowed.permissionless');
        expect(decision.allowed).toBe(true);
      }
    }
  });

  it('does not operate on the fiat plane at all', () => {
    expect(
      checkAccess({ module: 'indexer', plane: 'fiat', region: 'DE', kycTier: 'full', regionFailClosed: false, screeningFailClosed: false })
        .code,
    ).toBe('denied.plane_unsupported');
  });

  it('structural permissionlessness does not clear an unconfigured request', () => {
    const query = { module: 'indexer', plane: 'protocol', region: 'XX', kycTier: 'none', screening: UNSET_SCREENING_LIST } as const;
    const structural = checkAccess({ ...query, regionFailClosed: false, screeningFailClosed: false });
    expect(structural.allowed).toBe(true);
    expect(structural.code).toBe('allowed.permissionless');
    expect(structural.regionResolved).toBe(false);
    expect(structural.screening).toMatchObject({ listConfigured: false, declaration: 'unset', moneyGrade: 'unconfigured' });

    const request = checkAccess({ ...query, regionFailClosed: true, screeningFailClosed: true });
    expect(request.allowed).toBe(false);
    expect(request.code).toBe('denied.screening_unconfigured');
    expect(request.regionResolved).toBe(false);
    expect(request.screening).toMatchObject({ listConfigured: false, declaration: 'unset', moneyGrade: 'unconfigured' });
  });

  /**
   * The control. If `checkAccess` were returning `allowed.permissionless` for
   * everything, the assertions above would pass and mean nothing.
   */
  it('still gates a custodial module — the assertions above are not vacuous', () => {
    expect(
      checkAccess({ module: 'bank', plane: 'fiat', region: 'DE', kycTier: 'none', regionFailClosed: false, screeningFailClosed: false })
        .code,
    ).toBe('denied.kyc_required');
  });
});

describe('svc-indexer · §16.10 — the custody boundary, from inside', () => {
  it('never calls ledger.post', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/\bledger\s*\.\s*post\s*\(/);
    }
  });

  it('imports no ledger write recipe and no writable LedgerClient', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/from\s+['"]@intafaced\/ledger-client\/recipes['"]/);
      expect(body, path).not.toMatch(/import[^;]*\bLedgerClient\b[^;]*from\s+['"]@intafaced\/ledger-client['"]/s);
      expect(body, path).not.toMatch(/\brecipes\s*\./);
    }
  });

  /**
   * The ledger-client dependency is allowed at exactly one entry point.
   *
   * The root export re-exports `recipes`, `LedgerClient` and every account
   * helper. `/money` re-exports arithmetic. Importing the root would put the
   * whole write surface one autocomplete away, and `custody-scan` only catches
   * it once someone has already named a recipe.
   */
  it('reaches ledger-client only through the money subpath', () => {
    for (const { path, body } of shipped) {
      for (const match of body.matchAll(/from\s+['"](@intafaced\/ledger-client[^'"]*)['"]/g)) {
        expect(match[1], `${path} imports ${match[1]}`).toBe('@intafaced/ledger-client/money');
      }
    }
  });

  it('declares no ledger URL and no signing key in its environment', () => {
    const env = readFileSync(join(serviceRoot, 'src', 'env.ts'), 'utf8');
    // Comments legitimately mention what is absent, so match declarations only.
    const declared = [...env.matchAll(/^\s{4}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    for (const name of declared) {
      expect(name, `${name} is declared in env.ts`).not.toMatch(/PRIVATE_KEY|MNEMONIC|SEED|LEDGER_URL|SIGNER/);
    }
  });

  it('creates no wallet client and derives no account from a key', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/createWalletClient|privateKeyToAccount|mnemonicToAccount/);
    }
  });

  /**
   * PublicClient-only is the production write-surface ban. Live tests may talk
   * to anvil through script helpers; production `src/` (non-test) must never
   * name a chain-write verb that would move a user's funds.
   */
  it('never sends a chain transaction from non-test source', () => {
    const production = shipped.filter((f) => !f.path.endsWith('.test.ts'));
    expect(production.length, 'expected production sources').toBeGreaterThan(5);
    for (const { path, body } of production) {
      expect(body, path).not.toMatch(/\b(sendTransaction|writeContract|sendRawTransaction|deployContract)\b/);
    }
  });

  it('EVM adapter constructs a PublicClient and never a WalletClient', () => {
    const source = readFileSync(join(serviceRoot, 'src', 'chain', 'evm', 'source.ts'), 'utf8');
    expect(source).toMatch(/createPublicClient/);
    expect(source).not.toMatch(/createWalletClient/);
    // Comments may name WalletClient when explaining the ban — the import surface is the load-bearing check.
    expect(source).not.toMatch(/from\s+['"]viem['"][^;]*WalletClient|import\s+type\s*\{[^}]*WalletClient/);
  });

  it('tsconfig ships only src/** so scripts/ keys cannot enter dist', () => {
    const tsconfig = JSON.parse(readFileSync(join(serviceRoot, 'tsconfig.json'), 'utf8')) as {
      include?: string[];
    };
    expect(tsconfig.include).toEqual(['src/**/*']);
  });

  /**
   * A read model has no business writing anywhere but its own schema (§2).
   * Every table this service touches is declared in its own migration.
   */
  it('writes to no schema but its own', () => {
    const own = new Set([
      'blocks',
      'book_levels',
      'explorer_block_facts',
      'explorer_tx_logs',
      'explorer_tokens',
      'explorer_transfers',
      'explorer_tx_seen',
      'explorer_txs',
      'fills',
      'positions',
    ]);
    const store = readFileSync(join(serviceRoot, 'src', 'projection', 'postgres-store.ts'), 'utf8');
    // `UPDATE x SET` rather than bare `UPDATE`, so `ON CONFLICT … DO UPDATE SET`
    // is not read as a write to a table called "set".
    const writes = [...store.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_]+)/gi)].concat([
      ...store.matchAll(/\bUPDATE\s+([a-z_]+)\s+SET\b/gi),
    ]);

    expect(writes.length, 'found no writes at all — this check would pass vacuously').toBeGreaterThan(3);
    for (const match of writes) {
      expect(own.has(match[1]!.toLowerCase()), `writes to ${match[1]}`).toBe(true);
    }
  });
});
