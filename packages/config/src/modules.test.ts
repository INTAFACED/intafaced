import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
   * Re-runs the scanner's derivation regex against the real `modules.ts`.
   *
   * That regex is taken from the `const entry` assignment inside
   * `deriveProtocolPlaneServices` in custody-scan.mjs. The scanner does not
   * export it, and this test does not keep a second copy. A copy would stay
   * green when the scanner matches fewer protocol-plane services. If the
   * assignment cannot be read, this throws.
   */
  function entryRegexFromScanner(scanSource: string): RegExp {
    const unreadable = 'cannot read the entry regex assignment in deriveProtocolPlaneServices';
    const start = scanSource.indexOf('function deriveProtocolPlaneServices');
    if (start < 0) throw new Error(unreadable);
    const nextFn = scanSource.indexOf('\nfunction ', start + 1);
    const body = scanSource.slice(start, nextFn === -1 ? scanSource.length : nextFn);
    const marker = 'const entry =';
    const at = body.indexOf(marker);
    if (at < 0) throw new Error(unreadable);
    let i = at + marker.length;
    while (body[i] === ' ' || body[i] === '\t' || body[i] === '\n') i += 1;
    if (body[i] !== '/') throw new Error(unreadable);
    i += 1;
    let pattern = '';
    let inClass = false;
    let closed = false;
    while (i < body.length) {
      const ch = body[i];
      if (ch === undefined || ch === '\n') throw new Error(unreadable);
      if (ch === '\\') {
        const next = body[i + 1];
        if (next === undefined || next === '\n') throw new Error(unreadable);
        pattern += ch + next;
        i += 2;
        continue;
      }
      if (ch === '/' && !inClass) {
        closed = true;
        i += 1;
        break;
      }
      if (ch === '[' && !inClass) inClass = true;
      else if (ch === ']' && inClass) inClass = false;
      pattern += ch;
      i += 1;
    }
    if (!closed || pattern.length === 0) throw new Error(unreadable);
    let flags = '';
    while (i < body.length) {
      const flag = body[i];
      if (flag === undefined || !'gimsuy'.includes(flag)) break;
      flags += flag;
      i += 1;
    }
    try {
      return new RegExp(pattern, flags);
    } catch {
      throw new Error(unreadable);
    }
  }

  function servicesDerivedFromSource(): string[] {
    const source = readFileSync(modulesPath, 'utf8');
    const entry = entryRegexFromScanner(readFileSync(scanPath, 'utf8'));
    const derived: string[] = [];
    for (const match of source.matchAll(entry)) {
      const planes = [...match[2]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      if (planes.length === 1 && planes[0] === 'protocol' && match[3] === 'false') derived.push(match[1]!);
    }
    return derived.sort();
  }

  it('the hardcoded array has not come back', () => {
    const source = readFileSync(scanPath, 'utf8');

    expect(
      /const PROTOCOL_PLANE_SERVICES\s*=\s*\[/.test(source),
      'custody-scan.mjs declares a literal service array again — the drift this derivation removed is back',
    ).toBe(false);
    expect(source, 'custody-scan.mjs no longer derives its list from the registry').toContain('deriveProtocolPlaneServices');
  });

  it('parses exactly the services modules.ts declares protocol-only', () => {
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
   * D26-P2-08 — custody-scan must open the Java runtime risk surface, not only
   * Protocol Plane TS/Sol. The dual-book ratchet stays in vendor-java-money-scan;
   * this asserts the named gate still walks Java (money-plane src/main + jars).
   */
  it('walks the vendor Java runtime risk surface (D26-P2-08)', () => {
    const source = readFileSync(scanPath, 'utf8');

    expect(source, 'D26-P2-08 check id missing').toContain('java-runtime-risk-surface');
    expect(source, 'runtime risk module list missing').toContain('RUNTIME_RISK_MODULES');
    expect(source, 'must fail closed on empty Java walk').toContain('scanned 0 Java files on the runtime risk surface');
    expect(source, 'must open committed classpath jars').toContain('java-runtime-jar');
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
