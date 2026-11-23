import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES, protocolPlaneOnlyModules } from './modules.js';

/**
 * THE CUSTODY BOUNDARY IS ONLY ENFORCED WHERE THE SCANNER LOOKS.
 *
 * `tooling/ci/custody-scan.mjs` is what makes Doctrine §16.10 ("provably
 * non-custodial or it doesn't merge") true rather than aspirational. It walks
 * the Protocol Plane services and fails the build if any of them imports the
 * ledger's write surface.
 *
 * ── What this test used to guard, and why it changed ────────────────────────
 *
 * That list was once a HARDCODED ARRAY whose own comment claimed it "Mirrors
 * packages/config/src/modules.ts", with nothing checking that it did. A mirror
 * nobody checks is a mirror that drifts, and the drift was silent in the worst
 * direction: add a Protocol Plane service to `modules.ts`, forget the array,
 * and the new service is simply never scanned. It does not fail — it reports
 * clean, because a service the scanner never opens cannot produce a violation.
 *
 * The array is now gone. The scanner DERIVES the list from `modules.ts`, so
 * that drift is structurally impossible rather than merely tested for.
 *
 * ── What is still worth asserting ───────────────────────────────────────────
 *
 * The derivation is a REGEX OVER TYPESCRIPT SOURCE, because the scanner is a
 * `.mjs` script that runs before anything is built and cannot import a `.ts`
 * module. That is a real constraint, not a shortcut — but it means the parse
 * can silently disagree with the types it is parsing. Reformat a module entry,
 * add a field between `service:` and `planes:`, switch a quote style, and the
 * regex quietly matches fewer entries than exist.
 *
 * The failure mode is identical to the old one: fewer services walked, still a
 * green tick. So the guard moves rather than disappears — this asserts the
 * derivation AGREES WITH THE TYPED REGISTRY, and that the hardcoded array has
 * not come back.
 */
describe('custody-scan derives its service list from the registry, faithfully', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scanPath = resolve(here, '../../../tooling/ci/custody-scan.mjs');
  const modulesPath = resolve(here, './modules.ts');

  /** What the scratch tree's `modules.ts` is: the real one, the real one with an entry appended, an empty file, or none. */
  type Registry = { kind: 'real' } | { kind: 'real-plus'; extra: string } | { kind: 'empty' } | { kind: 'missing' };

  /** A ledger write planted in one service of the scratch tree. */
  const plantWrite = (root: string, service: string) => {
    mkdirSync(join(root, 'services', service, 'src'), { recursive: true });
    writeFileSync(join(root, 'services', service, 'src/planted.ts'), 'ledger.post(entry);\n');
  };
  /** One planted ledger write per registered module, so the services the scanner flags are exactly the ones it walks. */
  const plantEveryModule = (root: string) => {
    for (const mod of Object.values(MODULES)) plantWrite(root, mod.service);
  };

  /**
   * Runs the real scanner over a scratch tree: a `modules.ts` as `registry` says
   * (the real one is copied in, to be run against, never read here), then
   * whatever `plant` adds. Returns its exit status, its stderr, and each
   * violation it reported as `{ check, file }`.
   */
  function runScan(registry: Registry = { kind: 'real' }, plant: (root: string) => void = () => {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'custody-scan-')));
    try {
      mkdirSync(join(root, 'packages/config/src'), { recursive: true });
      const target = join(root, 'packages/config/src/modules.ts');
      if (registry.kind === 'real' || registry.kind === 'real-plus') copyFileSync(modulesPath, target);
      if (registry.kind === 'real-plus') appendFileSync(target, registry.extra);
      if (registry.kind === 'empty') writeFileSync(target, '');
      plant(root);
      const run = spawnSync(process.execPath, [scanPath], { cwd: root, encoding: 'utf8' });
      const reported = [...run.stderr.matchAll(/^ {2}\[([a-z-]+)\] (\S+)$/gm)].map((m) => ({ check: m[1]!, file: m[2]! }));
      return { status: run.status, stderr: run.stderr, reported };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /**
   * The services the scanner flags when every registered module writes to the
   * ledger: what its derivation walks, proven by what the gate does, not by a
   * copy of its regex.
   */
  function servicesDerivedFromSource(): string[] {
    const run = runScan({ kind: 'real' }, plantEveryModule);
    expect(run.status, 'every planted ledger write must fail the scan').toBe(1);
    const flagged = run.reported
      .filter((v) => v.check === 'ledger-write-on-protocol-plane')
      .map((v) => /^services\/([^/]+)\/src\/planted\.ts$/.exec(v.file)?.[1])
      .filter((s): s is string => s !== undefined);
    return [...new Set(flagged)].sort();
  }

  /**
   * A hardcoded list does not grow when the registry does. So one more module is
   * appended to the real registry with a ledger write planted in it: protocol-only
   * and non-custodial, the scan must flag it with no other edit; custodial, or on
   * a second plane, it must not be walked.
   */
  it('walks a protocol-only module added to the registry with no other edit (no hardcoded list)', () => {
    const flaggedWith = (planes: string, custodial: boolean) => {
      const extra = `\nexport const PLANTED = { planted: { id: 'planted', service: 'svc-planted', planes: [${planes}], phase: '1', custodial: ${custodial} } };\n`;
      const run = runScan({ kind: 'real-plus', extra }, (root) => plantWrite(root, 'svc-planted'));
      return run.reported.some((v) => v.check === 'ledger-write-on-protocol-plane' && v.file === 'services/svc-planted/src/planted.ts');
    };

    expect(flaggedWith("'protocol'", false), 'a new Protocol Plane module in modules.ts is not scanned: a hardcoded list is back').toBe(
      true,
    );
    expect(flaggedWith("'protocol'", true), 'a custodial module must not be walked by the Protocol Plane check').toBe(false);
    expect(flaggedWith("'fiat', 'protocol'", false), 'a two-plane module must not be walked by the Protocol Plane check').toBe(false);
  });

  it('walks exactly the services modules.ts declares protocol-only', () => {
    const declared = protocolPlaneOnlyModules()
      .map((m) => m.service)
      .sort();

    expect(servicesDerivedFromSource()).toEqual(declared);
  });

  it('never derives a custodial service, and never skips a non-custodial one', () => {
    const derived = new Set(servicesDerivedFromSource());

    for (const mod of Object.values(MODULES)) {
      const protocolOnly = mod.planes.length === 1 && mod.planes[0] === 'protocol';
      // svc-bridge is the deliberate exception the scanner's own header names:
      // it debits the ledger and credits the chain, and is custodial by design
      // (§17.3). It is on both planes, so `protocolOnly` is already false.
      if (protocolOnly) {
        expect(mod.custodial, `${mod.service} is protocol-plane-only and must not be custodial`).toBe(false);
        expect(derived.has(mod.service), `${mod.service} is a Protocol Plane service the derivation misses`).toBe(true);
      } else {
        expect(derived.has(mod.service), `${mod.service} is not protocol-plane-only but the derivation claims it is`).toBe(false);
      }
    }
  });

  /**
   * The scanner exits 1 rather than printing a green tick over an empty walk.
   * That guard is the whole reason a parse failure is survivable: a regex that
   * silently matches nothing would otherwise be indistinguishable from a
   * codebase with no Protocol Plane services in it.
   */
  it('fails closed when the derivation finds nothing', () => {
    const empty = runScan({ kind: 'empty' }, plantEveryModule);
    expect(empty.status, 'a registry with no Protocol Plane module must fail the scan, not pass it').toBe(1);
    expect(empty.stderr).toContain('found no Protocol Plane module');
    expect(empty.stderr).not.toContain('custody-scan clean');

    const missing = runScan({ kind: 'missing' }, plantEveryModule);
    expect(missing.status, 'a missing registry must fail the scan, not pass it').toBe(1);
    expect(missing.stderr).toContain('cannot read the module registry');
  });

  /**
   * The vendored Java exchange and wallet tree was deleted on 2026-10-19.
   * custody-scan must keep refusing it, so the plaintext-key wallet code and
   * its second money book cannot return without a reviewed change to the gate.
   */
  it('fails if the deleted vendor/ tree returns', () => {
    // The scratch tree holds no custodial-layer inventory, so check 4 always reports that; nothing else may speak.
    const inventoryOnly = [{ check: 'custody-layer-inventory', file: 'tooling/ci/custody-layer-inventory.json' }];
    const clean = runScan();
    expect(clean.reported, 'with no vendor/ tree and no planted write, nothing but the missing inventory is reported').toEqual(
      inventoryOnly,
    );

    const vendored = runScan({ kind: 'real' }, (root) => {
      mkdirSync(join(root, 'vendor/exchange'), { recursive: true });
      writeFileSync(join(root, 'vendor/exchange/Wallet.java'), 'class Wallet {}\n');
    });
    expect(vendored.status, 'a present vendor/ tree must fail the scan').toBe(1);
    expect(vendored.reported, 'a present vendor/ tree must be a violation').toEqual([
      { check: 'vendored-tree-returned', file: 'vendor/' },
      ...inventoryOnly,
    ]);

    // Check 1 stays beside it: a ledger write on the Protocol Plane is still refused.
    const service = protocolPlaneOnlyModules()[0]!.service;
    const write = runScan({ kind: 'real' }, (root) => plantWrite(root, service));
    expect(write.reported, 'Protocol Plane import check (check 1) must stay').toContainEqual({
      check: 'ledger-write-on-protocol-plane',
      file: `services/${service}/src/planted.ts`,
    });
  });
});

/**
 * §17.5 — svc-dex is the Protocol Plane's front door, so its plane and custody
 * flags are load-bearing rather than descriptive. `checkAccess` reads exactly
 * these two fields to decide whether to short-circuit to
 * `allowed.permissionless`; flip either and every `dex` procedure silently
 * acquires a KYC tier gate it was designed never to have.
 */
describe('svc-dex sits on the Protocol Plane', () => {
  it('is protocol-plane-only and non-custodial', () => {
    expect(MODULES.dex.planes).toEqual(['protocol']);
    expect(MODULES.dex.custodial).toBe(false);
    expect(MODULES.dex.service).toBe('svc-dex');
  });

  it('is therefore in the set custody-scan must cover', () => {
    expect(protocolPlaneOnlyModules().map((m) => m.service)).toContain('svc-dex');
  });
});
