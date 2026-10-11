import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAccess, MODULES, KYC_TIERS, regionsWithEntries, SCREENING_FAIL_CLOSED_ENV, UNSET_SCREENING_LIST } from '@intafaced/config';
import { SCOPES } from '@intafaced/auth';

/**
 * THE SOVEREIGNTY LAW (§22), verified from this side.
 *
 * §22 is enforced in `packages/config`, and `packages/config` has its own tests.
 * This file exists anyway, because the law is only worth anything if the module
 * it protects agrees: a change to `MODULES.protocol` that quietly made this
 * service custodial would pass every test in `packages/config` and break the
 * promise made to every user on this plane.
 *
 * So this asserts the same law from the service that lives under it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');

const REGIONS = ['*', 'GB', 'US', 'DE', 'NG', 'IN', 'BR', 'JP', 'AE', 'ZA', 'ZZ', 'gb', 'us', ...regionsWithEntries()];

// Structural custody/plane queries isolate §22 from deployment screening and
// region policy. Ordinary requests keep the defaults; the control below proves
// that an unconfigured request still refuses.
describe('§22 — zero KYC on the Protocol Plane, by architecture', () => {
  it.each(REGIONS)('allows an unverified user from %s, permissionlessly', (region) => {
    const decision = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      kycTier: 'none',
      region,
      regionFailClosed: false,
      screeningFailClosed: false,
    });

    expect(decision.allowed).toBe(true);
    // Not merely "allowed" — allowed for the RIGHT reason. `allowed` with a
    // code of `allowed` would mean the user happened to satisfy a tier, which
    // is a different and much weaker promise.
    expect(decision.code).toBe('allowed.permissionless');
    expect(decision.requiredTier).toBeUndefined();
  });

  it.each([...KYC_TIERS])('is indifferent to verification tier "%s"', (tier) => {
    const decision = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      kycTier: tier,
      region: 'GB',
      regionFailClosed: false,
      screeningFailClosed: false,
    });
    expect(decision.code).toBe('allowed.permissionless');
  });

  it('gives the same answer for a region nobody has ever configured', () => {
    const decision = checkAccess({
      module: 'protocol',
      plane: 'protocol',
      kycTier: 'none',
      region: 'QQ',
      regionFailClosed: false,
      screeningFailClosed: false,
    });
    expect(decision.code).toBe('allowed.permissionless');
  });

  it('is permissionless BECAUSE the module is non-custodial, not by exception', () => {
    // The causal chain §22 actually specifies: custody false → no tier. If this
    // ever inverts, the rest of the file is decoration.
    expect(MODULES.protocol.custodial).toBe(false);
    expect(MODULES.protocol.planes).toEqual(['protocol']);
    expect(MODULES.protocol.service).toBe('svc-protocol');
  });

  it('refuses to serve this module on the fiat plane at all', () => {
    const decision = checkAccess({
      module: 'protocol',
      plane: 'fiat',
      kycTier: 'full',
      region: 'GB',
      regionFailClosed: false,
      screeningFailClosed: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied.plane_unsupported');
  });

  it('still gates a custodial module, so the permissionless branch is not universal', () => {
    // A control. If this passed too, `checkAccess` would be allowing everything
    // and the test above would prove nothing.
    const decision = checkAccess({
      module: 'bank',
      plane: 'fiat',
      kycTier: 'none',
      region: 'GB',
      regionFailClosed: false,
      screeningFailClosed: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied.kyc_required');
  });

  it('isolates the structural probe without clearing an ordinary unconfigured request', () => {
    const previous = process.env[SCREENING_FAIL_CLOSED_ENV];
    delete process.env[SCREENING_FAIL_CLOSED_ENV];
    try {
      const query = { module: 'protocol', plane: 'protocol', region: 'XX', kycTier: 'none', screening: UNSET_SCREENING_LIST } as const;
      const structural = checkAccess({ ...query, regionFailClosed: false, screeningFailClosed: false });
      expect(structural.code).toBe('allowed.permissionless');
      expect(structural.regionResolved).toBe(false);
      expect(structural.screening).toMatchObject({
        declaration: 'unset',
        listConfigured: false,
        moneyGrade: 'unconfigured',
        readsAsScreenedClean: false,
      });
      const request = checkAccess(query);
      expect(request.allowed).toBe(false);
      expect(request.code).toBe('denied.screening_unconfigured');
      expect(request.regionResolved).toBe(false);
      expect(request.screening).toEqual(structural.screening);
    } finally {
      if (previous === undefined) delete process.env[SCREENING_FAIL_CLOSED_ENV];
      else process.env[SCREENING_FAIL_CLOSED_ENV] = previous;
    }
  });
});

describe('§16.10 — the custody boundary, asserted from inside the service', () => {
  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.turbo', 'coverage'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) yield* walk(full);
      else yield full;
    }
  }

  const tsFiles = [...walk(join(serviceRoot, 'src'))].filter((f) => f.endsWith('.ts'));
  /** Shipped code. Tests may hold a throwaway key; the service may not. */
  const shippedFiles = tsFiles.filter((f) => !f.endsWith('.test.ts'));
  const solFiles = [...walk(join(serviceRoot, 'contracts'))].filter((f) => f.endsWith('.sol'));

  it('declares no dependency on the ledger client', () => {
    const pkg = JSON.parse(readFileSync(join(serviceRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@intafaced/ledger-client');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@intafaced/ledger-client');
  });

  it('imports no ledger write surface anywhere in src', () => {
    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} imports the ledger client`).not.toMatch(/from\s+['"]@intafaced\/ledger-client/);
      expect(content, `${file} calls ledger.post`).not.toMatch(/\bledger\s*\.\s*post\s*\(/);
    }
  });

  it('declares no signing key in its environment', () => {
    const envSource = readFileSync(join(serviceRoot, 'src', 'env.ts'), 'utf8');
    // A signing key here would mean the platform could originate a transaction
    // on a user's account. Matched as a zod field DECLARATION rather than as a
    // substring, so the comment in env.ts explaining the absence does not read
    // as the thing it is explaining.
    expect(envSource).not.toMatch(/^\s*\w*(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SIGNER_KEY|SECRET_KEY)\w*\s*:/m);
  });

  it('creates no viem wallet client in shipped code — reads only', () => {
    for (const file of shippedFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} creates a wallet client`).not.toMatch(/createWalletClient|privateKeyToAccount/);
    }
  });

  it('ships no contract that can be destroyed', () => {
    for (const file of solFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bselfdestruct\s*\(/i);
    }
  });

  it('ships no contract with an owner- or admin-callable path to move user funds', () => {
    // The same two heuristics tooling/ci/custody-scan.mjs applies, run here so
    // a violation fails the service's own suite and not only the repo gate.
    const ownerPath = /function\s+\w*(withdraw|sweep|drain|rescue|emergencyWithdraw)\w*\s*\([^)]*\)[^{]*\bonlyOwner\b/i;
    const adminPath = /function\s+\w*(withdraw|sweep|drain|rescue)\w*\s*\([^)]*\)[^{]*\bonlyAdmin\b/i;
    for (const file of solFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(ownerPath);
      expect(content, file).not.toMatch(adminPath);
    }
  });

  it('exposes no write scope for this plane — a user token can authorise nothing here', () => {
    expect(SCOPES).toContain('protocol:read');
    expect(SCOPES).not.toContain('protocol:write');
  });

  it('has no upgrade path in the account contract', () => {
    const account = readFileSync(join(serviceRoot, 'contracts', 'SmartAccount.sol'), 'utf8');
    // An upgradeable account is a custodial account with extra steps: whoever
    // holds the upgrade key holds the funds.
    expect(account).not.toMatch(/\bfunction\s+upgradeTo\b/);
    expect(account).not.toMatch(/\bdelegatecall\b/);
    expect(account).toContain('address public immutable entryPoint');
  });
});
