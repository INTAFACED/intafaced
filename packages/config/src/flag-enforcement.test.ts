import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLAG_REGISTRY,
  NOT_ENFORCED,
  WAITLIST_REFERRAL_FLAGS,
  assertEnabled,
  enforcedFlags,
  enforcementOf,
  FlagDisabledError,
  isEnabled,
  isEnforced,
  unenforcedFlags,
} from './flags.js';

/**
 * DOES THE REGISTRY'S ENFORCEMENT CLAIM SURVIVE CONTACT WITH THE SERVICES?
 *
 * ── The finding this suite exists to keep fixed ─────────────────────────────
 *
 * `FLAG_REGISTRY` was read by exactly two things: its own unit test, and
 * `apps/admin`. The console rendered `isEnabled()` as the state of the
 * capability. At the default `LAUNCH_DROP=0` that meant an operator saw
 * `protocol.amm`, `academy.inviteLobbies` and `edge.gateway` reported OFF while
 * every one of those paths served traffic.
 *
 * A comment saying "these flags do not gate" would decay in a week. These
 * assertions read the services' own source and re-derive the answer, so the
 * registry cannot claim a gate that is not there, and cannot go on claiming
 * "not enforced" after someone wires one up.
 *
 * ── When one of these goes red ──────────────────────────────────────────────
 *
 * The fix is never to loosen the assertion. It is to update the `enforcement`
 * field on the flag so the registry matches what the code now does — which is
 * the whole point: the console reads that field, so correcting it is what makes
 * the console tell the truth again.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SERVICES_DIR = join(REPO_ROOT, 'services');

function serviceSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };

  for (const service of readdirSync(SERVICES_DIR)) {
    const src = join(SERVICES_DIR, service, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      /* a service without src is not this suite's business */
    }
  }
  return out;
}

/** Guard: if the walk finds nothing, every assertion below passes vacuously. */
const SERVICE_FILES = serviceSourceFiles();

describe('the enforcement field is answered for every flag', () => {
  it('finds the services to read (otherwise this whole suite is vacuous)', () => {
    expect(SERVICE_FILES.length).toBeGreaterThan(100);
  });

  it('leaves no flag undeclared', () => {
    for (const flag of FLAG_REGISTRY) {
      expect(flag.enforcement, `${flag.key} has no enforcement declaration`).toBeDefined();
      expect(['none', 'service-env', 'operator-api', 'request-path']).toContain(flag.enforcement.kind);
    }
  });

  it('has at least one of each, so neither branch of the console is dead code', () => {
    expect(unenforcedFlags().length).toBeGreaterThan(0);
    expect(enforcedFlags().length).toBeGreaterThan(0);
  });
});

/**
 * Where a service reads its boot-time env: `src/env.ts` for a Node service, and for the one Java
 * service (svc-fix, no env.ts) the `"NAME"` string constants in its main sources.
 */
function bootEnvSource(service: string): string {
  const envTs = join(SERVICES_DIR, service, 'src', 'env.ts');
  try {
    return readFileSync(envTs, 'utf8');
  } catch {
    const javaRoot = join(SERVICES_DIR, service, 'src', 'main', 'java');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.java')) files.push(full);
      }
    };
    walk(javaRoot);
    // Only string constants count: a comment naming the variable is not a switch.
    return files.flatMap((f) => readFileSync(f, 'utf8').match(/"[A-Z][A-Z0-9_]*"/g) ?? []).join('\n');
  }
}

describe('a declared gate exists in the service that is said to hold it', () => {
  /**
   * The half that catches a lie in the flattering direction: the registry
   * claiming `notify.fanout` is enforced after someone deletes
   * `NOTIFY_FANOUT_ENABLED`. Reading the service's own `env.ts` is the closest
   * a unit test gets to asking the running process.
   */
  it.each(enforcedFlags().map((f) => [f.key, f.enforcement] as const))('%s', (key, enforcement) => {
    if (enforcement.kind === 'none') throw new Error('unreachable — enforcedFlags() excludes none');

    if (enforcement.kind === 'request-path') {
      const service = join(SERVICES_DIR, enforcement.service, 'src', 'waitlist', 'waitlist-service.ts');
      const source = readFileSync(service, 'utf8');
      expect(source, `${key} claims assertEnabled on ${enforcement.service}`).toContain(`assertEnabled('${key}'`);
      const envFile = readFileSync(join(SERVICES_DIR, enforcement.service, 'src', 'env.ts'), 'utf8');
      expect(envFile, `${key} pin ${enforcement.envVar}`).toContain(enforcement.envVar);
      const router = readFileSync(join(SERVICES_DIR, enforcement.service, 'src', 'router.ts'), 'utf8');
      expect(router, `${key} surface ${enforcement.surface}`).toContain(enforcement.surface);
      return;
    }

    const source = bootEnvSource(enforcement.service);

    expect(source, `${key} claims ${enforcement.envVar} on ${enforcement.service}, and that file does not declare it`).toContain(
      enforcement.envVar,
    );
  });
});

describe('no flag is enforced through this registry', () => {
  /**
   * THE ASSERTION THAT MAKES `NOT_ENFORCED` A PROVEN CLAIM RATHER THAN A
   * PROMISE.
   *
   * Enforcement can only reach a request path two ways: the service resolves
   * the flag (imports a resolver from this package), or the service reads its
   * own env var. The per-flag test above covers the second. This covers the
   * first, for all of them at once — and it is currently zero, which is why a
   * flag with no declared env mirror is enforced by nothing at all.
   *
   * If this goes red, someone has wired a real gate. Good. Update that flag's
   * `enforcement` to a shape that describes it, and widen this test to allow
   * the file that does it — do not delete the check, or the next `NOT_ENFORCED`
   * becomes unfalsifiable again.
   */
  const RESOLVERS = ['isEnabled', 'resolveAll', 'explainAll', 'FLAG_REGISTRY', 'flagsForModule', 'flagDef', 'assertEnabled'];

  it('no services/*/src file imports a flag resolver from @intafaced/config except named request-path gates', { timeout: 20_000 }, () => {
    const offenders: string[] = [];
    const allowedAssertEnabled = new Set(['waitlist-service.ts']);

    for (const file of SERVICE_FILES) {
      const source = readFileSync(file, 'utf8');
      // Only the import statements — `engine.ts` has a local `get isEnabled()`
      // getter of its own, and a naive substring search would flag it.
      for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@intafaced\/config[^']*'/g)) {
        const named = (match[1] ?? '').split(',').map(
          (s) =>
            s
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '',
        );
        const found = named.filter((n) => RESOLVERS.includes(n));
        const allowed =
          found.every((n) => n === 'assertEnabled') && allowedAssertEnabled.has(file.replace(/\\/g, '/').split('/').pop() ?? '');
        if (found.length > 0 && !allowed) offenders.push(`${file.slice(REPO_ROOT.length)} imports ${found.join(', ')}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no service env schema reads LAUNCH_DROP, so a mirror can never follow the drop clock', () => {
    const offenders = SERVICE_FILES.filter((f) => f.endsWith('env.ts')).filter((f) => readFileSync(f, 'utf8').includes('LAUNCH_DROP'));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('enforcement lookups fail closed', () => {
  /**
   * `isEnabled` refuses to over-promise that a capability is ON. This refuses
   * to over-promise that one is OFF. An unknown key must never resolve to
   * "something is gating this" — the console would render a switch for a
   * control that does not exist, which is the original bug wearing a new hat.
   */
  it('treats an unknown key as ungated rather than assuming a gate', () => {
    expect(enforcementOf('not.a.flag')).toEqual(NOT_ENFORCED);
    expect(isEnforced('not.a.flag')).toBe(false);
  });

  it('never reports a flag as enforced merely because its name resembles one', () => {
    expect(isEnforced('trade.spotify')).toBe(false);
    expect(isEnforced('')).toBe(false);
  });

  it('still refuses to resolve an unknown flag at all', () => {
    // The other direction, restated here so the pair is visible in one place:
    // an undeclared flag is not silently "on".
    expect(() => isEnabled('not.a.flag', { drop: 'V' })).toThrow();
  });

  it('leaves a phase-gated flag off at every drop, including the last one', () => {
    for (const drop of ['0', 'I', 'II', 'III', 'IV', 'V'] as const) {
      expect(isEnabled('protocol.amm', { drop })).toBe(false);
    }
  });
});

describe('why the edge does not gate on these flags', () => {
  /**
   * THE EVIDENCE FOR THE DECISION, RE-DERIVED RATHER THAN ASSERTED.
   *
   * The edge is the obvious chokepoint — it owns the route table and already
   * 404s unknown prefixes, so gating there would be one place instead of
   * sixteen. It is also the wrong answer, and this is why.
   *
   * `LAUNCH_DROP` defaults to `'0'`. At drop 0 the registry has waitlist and
   * referral on (`core-ops`), and `/api/ops` now routes that module — those two
   * stay live. Every other routed module's flags resolve off. An edge that
   * refused a request whose module had no live flag would still refuse identity
   * and trade. `edge.gateway` itself is drop I, so the gateway would refuse
   * before it got as far as asking about anything else.
   *
   * That is the case the brief called out: a flag that silently 404s a live
   * capability at drop 0 is worse than today. The module kill-switch already
   * gives the edge a real, live, audited control at module granularity
   * (`services/svc-edge/src/kill-switch.ts`); the launch flags are the rollout
   * plan on top of it, and the console now says so.
   *
   * Read off `routes.ts` rather than hardcoded, so raising `LAUNCH_DROP`'s
   * default or moving a flag's drop turns this red and forces the argument to be
   * made again with the new numbers.
   */
  const ROUTES = readFileSync(join(SERVICES_DIR, 'svc-edge', 'src', 'routes.ts'), 'utf8');

  const ROUTED_MODULES = [...new Set([...ROUTES.matchAll(/\bmodule:\s*'([a-z0-9-]+)'/g)].map((m) => m[1] as string))];

  const DEFAULT_DROP = '0' as const;

  it('reads the route table (otherwise the assertions below are vacuous)', () => {
    expect(ROUTED_MODULES.length).toBeGreaterThan(5);
    expect(ROUTED_MODULES).toContain('identity');
    expect(ROUTED_MODULES).toContain('trade');
  });

  it.each(ROUTED_MODULES)('every %s flag is off at the default drop, so a flag-gating edge would refuse it', (module) => {
    const flags = FLAG_REGISTRY.filter((f) => f.module === module);
    expect(flags.length, `${module} is routed but has no flag at all`).toBeGreaterThan(0);

    const live = flags.filter((f) => isEnabled(f.key, { drop: DEFAULT_DROP })).map((f) => f.key);
    // waitlist/referral are drop-0 and live on module `core-ops`. `/api/ops`
    // routes that module; they must stay on at the default drop.
    const allowedOn = module === 'core-ops' ? ['waitlist.enabled', 'referral.queue'] : module === 'mining-pool' ? ['mining.testnet'] : [];
    expect(live, `${module} would still serve if the edge gated on flags`).toEqual(allowedOn);
  });

  it('would refuse the gateway itself before refusing anything else', () => {
    // `edge.gateway` is drop I. An edge that consulted it at the default drop
    // would answer nothing at all — including the health and kill-switch paths
    // an operator needs precisely when the platform is wrong.
    expect(isEnabled('edge.gateway', { drop: DEFAULT_DROP })).toBe(false);
  });
});

describe('the specific capabilities the audit found flagged off and serving', () => {
  /**
   * Named individually rather than swept into a loop, because these four are
   * the evidence. If any of them acquires a real gate, this test says so and
   * the registry entry has to change with it.
   */
  const CURRENT_DROP = '0' as const;

  it('reports protocol.amm as off at drop 0 and as gating nothing', () => {
    expect(isEnabled('protocol.amm', { drop: CURRENT_DROP })).toBe(false);
    expect(enforcementOf('protocol.amm').kind).toBe('none');
  });

  it('reports academy.inviteLobbies as off at drop 0 and as gating nothing', () => {
    expect(isEnabled('academy.inviteLobbies', { drop: CURRENT_DROP })).toBe(false);
    expect(enforcementOf('academy.inviteLobbies').kind).toBe('none');
  });

  it('reports edge.gateway as off at drop 0 while the gateway proxies everything', () => {
    expect(isEnabled('edge.gateway', { drop: CURRENT_DROP })).toBe(false);
    expect(enforcementOf('edge.gateway').kind).toBe('none');
  });

  it('shows notify.fanout and indexer.ingest gated by an env var that ignores the drop clock', () => {
    // Both DO refuse — but from a boot-time variable defaulting to on, so the
    // registry saying "off at drop 0" and the service fanning out are both true
    // at once. That is the drift, and naming the variable is what lets an
    // operator resolve it.
    expect(isEnabled('notify.fanout', { drop: CURRENT_DROP })).toBe(false);
    expect(enforcementOf('notify.fanout')).toEqual({ kind: 'service-env', service: 'svc-notify', envVar: 'NOTIFY_FANOUT_ENABLED' });

    expect(isEnabled('indexer.ingest', { drop: CURRENT_DROP })).toBe(false);
    expect(enforcementOf('indexer.ingest')).toEqual({ kind: 'service-env', service: 'svc-indexer', envVar: 'INDEXER_INGEST_ENABLED' });
  });
});

/**
 * Pin: waitlist / referral stay refuse-closed when the switch is OFF.
 * `isEnabled === false` is not enough — `assertEnabled` must throw
 * `FlagDisabledError`. Do not treat OFF as ready.
 */
describe('waitlist / referral stay refuse-closed when OFF', () => {
  it.each(WAITLIST_REFERRAL_FLAGS)('%s: assertEnabled throws FlagDisabledError when overridden off', (key) => {
    expect(isEnabled(key, { drop: '0', overrides: { [key]: false } })).toBe(false);
    expect(() => assertEnabled(key, { drop: '0', overrides: { [key]: false } })).toThrow(FlagDisabledError);
    expect(() => assertEnabled(key, { drop: 'V', overrides: { [key]: false } })).toThrow(FlagDisabledError);
  });

  it('waitlist.enabled: env pin off is FlagDisabledError, not silent serve', () => {
    const ctx = { drop: '0' as const, env: { INTAFACED_FLAG_WAITLIST_ENABLED: 'off' } };
    expect(isEnabled('waitlist.enabled', ctx)).toBe(false);
    try {
      assertEnabled('waitlist.enabled', ctx);
      expect.unreachable('must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagDisabledError);
      const e = err as FlagDisabledError;
      expect(e.code).toBe('flag.waitlist.enabled.disabled');
      expect(e.key).toBe('waitlist.enabled');
    }
  });

  it('referral.queue: env pin off is FlagDisabledError, not silent serve', () => {
    const ctx = { drop: '0' as const, env: { INTAFACED_FLAG_REFERRAL_QUEUE: 'off' } };
    expect(isEnabled('referral.queue', ctx)).toBe(false);
    expect(() => assertEnabled('referral.queue', ctx)).toThrow(FlagDisabledError);
  });
});
