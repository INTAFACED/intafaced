import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

  /**
   * Runs the real scanner over a scratch tree that holds the real `modules.ts`
   * and, for EVERY registered module, a service file that calls `ledger.post(`.
   * The services the scanner flags are exactly the ones its derivation walks,
   * so this proves what the regex parses out of the registry by what the gate
   * does, not by a copy of the regex.
   */
  function servicesDerivedFromSource(): string[] {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'custody-scan-')));
    try {
      mkdirSync(join(root, 'packages/config/src'), { recursive: true });
      copyFileSync(modulesPath, join(root, 'packages/config/src/modules.ts'));
      for (const mod of Object.values(MODULES)) {
        mkdirSync(join(root, 'services', mod.service, 'src'), { recursive: true });
        writeFileSync(join(root, 'services', mod.service, 'src/planted.ts'), 'ledger.post(entry);\n');
      }
      const run = spawnSync(process.execPath, [scanPath], { cwd: root, encoding: 'utf8' });
      expect(run.status, 'every planted ledger write must fail the scan').toBe(1);
      const flagged = /\[ledger-write-on-protocol-plane\] services\/([^/]+)\/src\/planted\.ts/g;
      return [...new Set([...run.stderr.matchAll(flagged)].map((m) => m[1]!))].sort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('the hardcoded array has not come back', () => {
    const source = readFileSync(scanPath, 'utf8');

    expect(
      /const PROTOCOL_PLANE_SERVICES\s*=\s*\[/.test(source),
      'custody-scan.mjs declares a literal service array again — the drift this derivation removed is back',
    ).toBe(false);
    expect(source, 'custody-scan.mjs no longer derives its list from the registry').toContain('deriveProtocolPlaneServices');
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
    const source = readFileSync(scanPath, 'utf8');

    expect(source).toContain('found no Protocol Plane module');
    expect(source, 'the empty-derivation branch must exit, not warn').toMatch(
      /found no Protocol Plane module[\s\S]{0,600}process\.exit\(1\)/,
    );
  });

  /**
   * The vendored Java exchange and wallet tree was deleted on 2026-10-19.
   * custody-scan must keep refusing it, so the plaintext-key wallet code and
   * its second money book cannot return without a reviewed change to the gate.
   */
  it('fails if the deleted vendor/ tree returns', () => {
    const source = readFileSync(scanPath, 'utf8');

    expect(source, 'vendored-tree check id missing').toContain('vendored-tree-returned');
    expect(source, 'must not shell out to the deleted Java successor scan').not.toContain('vendor-java-money-scan.mjs');
    expect(source, 'Protocol Plane import check (check 1) must stay').toContain('ledger-write-on-protocol-plane');
    expect(source, 'a present vendor/ tree must be a violation').toMatch(/if \(existsSync\(VENDOR\)\) \{[\s\S]{0,200}violations\.push/);
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
