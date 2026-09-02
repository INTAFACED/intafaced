/**
 * SVC-TRADE BOOTS ON THE CONFIGURATION THIS REPOSITORY ACTUALLY SHIPS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `pnpm platform:up` from a clean clone crash-looped svc-trade:
 *
 *     ProfitSourceConfigError: TRADE_FUTURES_PROFIT_SOURCE is not set…
 *         at profitSourceFromConfig (…/futures/profit-source.js:145:15)
 *         at file:///app/services/svc-trade/dist/index.js:116:22
 *
 * Three files each did something defensible and the combination was an outage.
 * `env.ts` defaulted the variable to `''`; `.env.example` shipped it commented
 * out because naming the account is an owner decision; compose passed
 * `${TRADE_FUTURES_PROFIT_SOURCE:-}` for the same reason; and `index.ts` threw
 * on the empty value at module scope, before `app.listen`. Down with it went
 * spot orders, ticker, orderbook, balances, fees, positions and the websocket
 * feeds — over a pot that only matters when someone closes a winning perp.
 *
 * The reason it survived review is that nothing in the repo compared those files
 * to each other. `compose-secret-parity` deliberately covers SECRET-shaped names
 * only, and its own header says so. `e2658db` — svc-ledger crash-looping on a
 * missing `JWT_ACCESS_SECRET` — is the same shape two days earlier, and that one
 * at least a secrets gate could see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT CHECKS, AND WHAT IT CANNOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It rebuilds the environment a clean-clone `pnpm platform:up` gives THIS
 * container — `.env.example` as the env file, the compose anchors, the
 * `svc-trade` block — and then asks the two questions that would have exited
 * the process: does every variable the env schema REQUIRES actually arrive, and
 * does the futures profit-source wiring survive the value it is handed.
 *
 * The first half is `compose-secret-parity`'s technique with its one deliberate
 * limitation removed. That gate covers SECRET-shaped names only and says so in
 * its own header — a required `DATABASE_URL` absent from compose crash-loops
 * identically and is invisible to it. Here the name filter is dropped: every
 * required variable is checked, for this one service. Requirements are read out
 * of the zod SOURCE rather than by importing it, because `env.ts` calls
 * `loadEnv(process.env)` at module scope and importing it would answer a
 * question about this machine instead of about the shipped config.
 *
 * It cannot claim the process reaches `listen`: it opens no socket, no database
 * and no bus. That statement is proven by running the container, and this file
 * is the cheap guard that keeps it true between those runs. It reads the real
 * files rather than a fixture, so it goes red when somebody edits
 * `.env.example` or the compose block — which is exactly when the question is
 * being re-asked.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { optionalProfitSourceFromConfig, profitSourceFromConfig } from './futures/profit-source.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Uncommented `KEY=VALUE` lines. What `docker compose` reads out of an env file. */
function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * `${VAR}`, `${VAR:-default}`, `${VAR:?message}` against the env file.
 *
 * `:?` is compose REFUSING to start when the value is absent, which is a
 * different and perfectly good failure — loud, at `up`, naming the variable. It
 * resolves to the env-file value here and the test below asserts one exists.
 */
function interpolate(raw: string, envFile: Map<string, string>): string {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}/g, (_all, name: string, op: string, tail: string) => {
    const supplied = envFile.get(name);
    if (supplied !== undefined && supplied !== '') return supplied;
    return op === '-' ? tail : '';
  });
}

/** Strip one layer of YAML quoting from a scalar. */
const unquote = (v: string) => v.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');

/**
 * The environment one compose service ends up with: its own `environment:`
 * keys plus every `x-…: &anchor` block it merges with `<<:`.
 *
 * Regex, not a YAML parser — the repo has no YAML dependency and
 * `compose-secret-parity.mjs` reads the same file the same way. The failure
 * direction is a MISSED key, which shows up as a red test asking for a value
 * that is in fact supplied, never as a green tick over a real gap.
 */
function composeEnvironmentFor(service: string, compose: string, envFile: Map<string, string>): Map<string, string> {
  const lines = compose.split(/\r?\n/);

  const anchors = new Map<string, Map<string, string>>();
  {
    let current: Map<string, string> | null = null;
    for (const line of lines) {
      const decl = /^x-[\w-]+:\s*&([\w-]+)\s*$/.exec(line);
      if (decl) {
        current = new Map();
        anchors.set(decl[1]!, current);
        continue;
      }
      if (/^\S/.test(line)) current = null;
      if (!current) continue;
      const kv = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (kv) current.set(kv[1]!, interpolate(unquote(kv[2]!.trim()), envFile));
    }
  }

  const out = new Map<string, string>();
  let inService = false;
  let inEnv = false;
  for (const line of lines) {
    const svcDecl = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (svcDecl) {
      inService = svcDecl[1] === service;
      inEnv = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}\S/.test(line)) inEnv = /^ {4}environment:/.test(line);
    if (!inEnv) continue;

    const merge = /^\s*<<:\s*(?:\[([^\]]+)\]|\*([\w-]+))/.exec(line);
    if (merge) {
      const names = merge[1] ? merge[1].split(',') : [merge[2]!];
      for (const raw of names) {
        for (const [k, v] of anchors.get(raw.trim().replace(/^\*/, '')) ?? []) out.set(k, v);
      }
      continue;
    }
    const kv = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) out.set(kv[1]!, interpolate(unquote(kv[2]!.trim()), envFile));
  }
  return out;
}

/**
 * Own `environment:` keys on one service (not merged anchors), in file order.
 * A Set of these names is smaller than the list when YAML repeats a key —
 * compose last-wins, which would hide a second CONVERT/ALGO line.
 */
function composeServiceOwnEnvKeys(service: string, compose: string): string[] {
  const keys: string[] = [];
  let inService = false;
  let inEnv = false;
  for (const line of compose.split(/\r?\n/)) {
    const svcDecl = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (svcDecl) {
      inService = svcDecl[1] === service;
      inEnv = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}\S/.test(line)) inEnv = /^ {4}environment:/.test(line);
    if (!inEnv) continue;
    const kv = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (kv) keys.push(kv[1]!);
  }
  return keys;
}

/**
 * Zod chains wrap. Prettier turns a long one into
 *
 *     JWT_ACCESS_SECRET: z
 *       .string()
 *       .min(32),
 *
 * and a line-bounded regex sees `z` and stops — so the `.optional()`, or worse
 * its absence, is invisible. Re-joining continuation lines first removes the
 * whole class; `compose-secret-parity.mjs` learned that the hard way.
 */
const joinChains = (source: string) => source.replace(/\n\s*\./g, '.');

/**
 * One declaration, from `z.` to the end of its (re-joined) line.
 *
 * NOT `[^,\n]*`, which is what `compose-secret-parity.mjs` uses and gets away
 * with only because its name filter hides the bug. Stopping at the first comma
 * truncates any chain with a comma inside a call —
 *
 *     INTERNAL_SERVICE_BODY_BIND: z.enum(['accept-both', 'require']).default('accept-both'),
 *     TRADE_SPOT_ENABLED: z.union([z.boolean(), z.string()]).default(true)…
 *
 * — cutting off the `.default(…)` and reporting both as REQUIRED. Six of
 * svc-trade's own flags land in that shape. Prettier puts one declaration per
 * line after re-joining, so the line is the honest boundary.
 */
const DECLARATION = /([A-Z][A-Z0-9_]*)\s*:\s*(z\.[^\n]*)/g;

/** No `.optional()` and no `.default(…)`. Those two are the whole distinction. */
const isRequiredChain = (chain: string) => !/\.optional\s*\(/.test(chain) && !/\.default\s*\(/.test(chain);

/**
 * Which variables svc-trade cannot start without.
 *
 * The shared slices in `packages/config` plus this service's own inline
 * declarations — and an inline declaration may RELAX a slice, so a non-required
 * one REMOVES the requirement rather than adding to it.
 *
 * Regex rather than a TypeScript parse, deliberately and for the same reason
 * the compose side is: the failure direction is a MISSED requirement, which
 * cannot invent a green tick over a real gap.
 */
function requiredEnvVars(): Set<string> {
  const configSrc = joinChains(read('packages/config/src/env.ts'));
  const slices = new Map<string, Set<string>>();
  for (const m of configSrc.matchAll(/export const (\w+EnvSchema)\s*=\s*z\.object\(\{([\s\S]*?)\n\}\)/g)) {
    const found = new Set<string>();
    for (const d of m[2]!.matchAll(DECLARATION)) {
      if (isRequiredChain(d[2]!)) found.add(d[1]!);
    }
    slices.set(m[1]!, found);
  }
  // `serviceEnvSchema` is a composition of other slices; expand it the same way.
  const composed = /export const serviceEnvSchema\s*=([\s\S]*?);/.exec(configSrc);
  if (composed) {
    const union = new Set<string>();
    for (const slice of composed[1]!.matchAll(/(\w+EnvSchema)/g)) for (const v of slices.get(slice[1]!) ?? []) union.add(v);
    slices.set('serviceEnvSchema', union);
  }

  const src = joinChains(read('services/svc-trade/src/env.ts'));
  const need = new Set<string>();
  for (const m of src.matchAll(/(\w+EnvSchema)/g)) for (const v of slices.get(m[1]!) ?? []) need.add(v);
  for (const m of src.matchAll(DECLARATION)) {
    if (isRequiredChain(m[2]!)) need.add(m[1]!);
    else need.delete(m[1]!);
  }
  return need;
}

const envExample = parseEnvFile(read('.env.example'));
const shipped = composeEnvironmentFor('svc-trade', read('docker-compose.apps.yml'), envExample);
const requiredVars = requiredEnvVars();

describe('svc-trade boots on shipped configuration', () => {
  /** Guard on the parser itself: an empty map would make everything below vacuous. */
  it('reads a real svc-trade compose environment', () => {
    expect(shipped.get('SERVICE_NAME')).toBe('svc-trade');
    expect(shipped.get('LEDGER_URL')).toBe('http://svc-ledger:4001');
    expect(shipped.size).toBeGreaterThan(10);
  });

  /**
   * Guard on the requirement parser: an empty or wrong set would make the next
   * test vacuous.
   *
   * The expected answer is known independently. Importing `env.ts` with an
   * empty environment produces exactly:
   *
   *     Invalid environment for process:
   *       - DATABASE_URL: Required
   *       - EDGE_PRINCIPAL_SECRET: Required
   *       - INTERNAL_SERVICE_SECRET: Required
   *
   * so three is the real number and these are the three. `>=` rather than `===`
   * because a genuinely new required variable should make the NEXT test decide
   * whether compose supplies it, not fail here on a count.
   */
  it('derives a real requirement list from the zod source', () => {
    expect(requiredVars.size).toBeGreaterThanOrEqual(3);
    // Known members, so a regex that has quietly stopped matching is caught.
    expect([...requiredVars]).toEqual(expect.arrayContaining(['DATABASE_URL', 'EDGE_PRINCIPAL_SECRET', 'INTERNAL_SERVICE_SECRET']));
    // And a known NON-member. `TRADE_FUTURES_PROFIT_SOURCE` has `.default('')`,
    // which is exactly why no schema-shaped check could ever have caught the
    // defect this file is named for — the throw was downstream of zod. The next
    // test is not the one that catches it; the profit-source ones below are.
    expect(requiredVars.has('TRADE_FUTURES_PROFIT_SOURCE')).toBe(false);
  });

  it('every variable the schema REQUIRES actually arrives — secret-shaped or not', () => {
    const missing = [...requiredVars].filter((key) => {
      const value = shipped.get(key);
      return value === undefined || value === '';
    });
    expect(missing).toEqual([]);
  });

  /**
   * THE REGRESSION. This is the exact expression `index.ts` evaluates at module
   * scope, fed the exact string a clean clone produces. It threw, and the
   * container exited before `app.listen`.
   *
   * Reverting `optionalProfitSourceFromConfig` back to `profitSourceFromConfig`
   * in `index.ts` does not fail this test on its own — so the test asserts the
   * PROPERTY that made the revert fatal, one line down.
   */
  it('the futures profit source wiring does not throw on the shipped value', () => {
    const shippedValue = shipped.get('TRADE_FUTURES_PROFIT_SOURCE');
    expect(shippedValue).toBe('house:fees:trade:available');
    expect(() => optionalProfitSourceFromConfig(shippedValue)).not.toThrow();
    const source = optionalProfitSourceFromConfig(shippedValue);
    expect(source).not.toBeNull();
    expect(source?.configured).toBe('house:fees:trade:available');
  });

  /**
   * …and this is that property: the strict constructor STILL refuses an empty
   * value, so the only thing standing between the shipped config and a
   * crash-loop is `index.ts` calling the optional one. Kept as a pair so the
   * reason the optional variant exists cannot quietly evaporate.
   */
  it('the strict constructor still refuses an unnamed account — the ADR rule is intact', () => {
    expect(() => profitSourceFromConfig('')).toThrow(/TRADE_FUTURES_PROFIT_SOURCE is not set/);
  });

  it('index.ts builds the profit source with the optional constructor', () => {
    const index = read('services/svc-trade/src/index.ts');
    expect(index).toMatch(/optionalProfitSourceFromConfig\(env\.TRADE_FUTURES_PROFIT_SOURCE\)/);
    // The strict one at module scope is the defect, by name.
    expect(index).not.toMatch(/[^l]profitSourceFromConfig\(env\.TRADE_FUTURES_PROFIT_SOURCE\)/);
  });

  /**
   * D26-P0-02 / PKT-B5: owner published the recipe account in `.env.example`.
   * Compose still has no default — a host that blanks .env keeps profit refused.
   */
  it('.env.example publishes the owner-named profit source (PKT-B5)', () => {
    expect(envExample.get('TRADE_FUTURES_PROFIT_SOURCE')).toBe('house:fees:trade:available');
  });

  /**
   * And compose must not grow a default either. `${VAR:-house:fees:trade:available}`
   * would make `platform:up` work by silently making the owner's decision, which
   * is the one repair the ADR forbids.
   */
  it('compose passes the profit source through with no default value', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_PROFIT_SOURCE:\s*\$\{TRADE_FUTURES_PROFIT_SOURCE:-\}/);
  });

  it('ships D26-P0-02 fee-share law while D26-P0-15 geo stays closed', async () => {
    const { parseCopyFeeShareLawJson } = await import('./copy/fee-share-law.js');
    const raw = shipped.get('TRADE_COPY_FEE_SHARE_LAW') ?? '';
    const law = parseCopyFeeShareLawJson(raw);
    expect(law.published).toBe(true);
    if (law.published) {
      expect(law.leaderShareBps).toBe(1000);
      expect(law.earningsCapPerFollower).toBe('1000.00');
      expect(law.decayRoundTrips).toBe(50);
      expect(law.decayShareBps).toBe(5000);
    }
    const geoRaw = shipped.get('TRADE_COPY_JURISDICTION_LAW') ?? '';
    const { parseCopyJurisdictionLawJson } = await import('./copy/fee-share-law.js');
    const geo = parseCopyJurisdictionLawJson(geoRaw);
    expect(geo).toEqual({ published: false });
  });

  it('ships PTX-M21 fee schedule unpublished (blank is refuse, never invent bps)', async () => {
    const { parseFeeScheduleJson } = await import('./spot/fee-schedule.js');
    const raw = shipped.get('TRADE_FEE_SCHEDULE') ?? '';
    expect(parseFeeScheduleJson(raw)).toEqual({ published: false });
  });

  /**
   * The two fleet-wide secrets use `${VAR:?…}`, so compose refuses to start
   * without them and `.env.example` has to carry values. That is the OTHER
   * correct answer to a missing variable — loud, at `up`, naming the variable —
   * and it only works if the example file actually supplies them.
   */
  it('the secrets compose refuses to start without are present in .env.example', () => {
    for (const key of ['EDGE_PRINCIPAL_SECRET', 'INTERNAL_SERVICE_SECRET']) {
      expect(envExample.get(key), `${key} missing from .env.example`).toBeTruthy();
      expect(shipped.get(key)).toBeTruthy();
    }
  });
});

/**
 * FUTURES ORDERABILITY IS OFF IN THE CONFIGURATION THIS REPOSITORY SHIPS.
 *
 * Its own describe block because the question is the mirror of the one above. The
 * rest of this file asks "does everything the service NEEDS actually arrive"; this
 * asks "does something it must NOT have arrive anyway". Both are answered from the
 * same rebuilt clean-clone environment, and this is the only place a
 * `TRADE_FUTURES_ENABLED=true` slipped into compose or `.env.example` would be
 * caught — `futures/orderable-path.test.ts` proves the BEHAVIOUR on both settings
 * and cannot see which one is shipped.
 */
describe('the shipped configuration does not turn futures on', () => {
  it('hands the container futures OFF on a clean clone', () => {
    // Present, so an operator can see the switch exists without reading env.ts…
    expect(shipped.has('TRADE_FUTURES_ENABLED')).toBe(true);
    // …and off, which is the whole point of the change that introduced it.
    expect(shipped.get('TRADE_FUTURES_ENABLED')).toBe('false');
  });

  /**
   * The zod default, asserted from the SOURCE.
   *
   * Weaker than a behavioural test, and chosen anyway for the reason this file's
   * header gives about the requirement list: `env.ts` calls `loadEnv(process.env)`
   * at module scope, so importing it answers a question about this machine rather
   * than about the shipped schema. `.default(true)` here, with the compose line
   * deleted, would turn futures on for every deployment that never mentions the
   * variable — precisely the accident the flag exists to prevent.
   */
  it('declares the env default as false, so a deployment that never mentions it gets nothing', () => {
    const src = joinChains(read('services/svc-trade/src/env.ts'));
    const decl = /TRADE_FUTURES_ENABLED:\s*(z\.[^\n]*)/.exec(src);
    expect(decl, 'TRADE_FUTURES_ENABLED is not declared in svc-trade/src/env.ts').not.toBeNull();
    expect(decl![1]).toContain('.default(false)');
    expect(decl![1]).not.toContain('.default(true)');
  });

  it('leaves TRADE_FUTURES_ENABLED commented out in .env.example, and documents it', () => {
    // `parseEnvFile` only sees live lines, so this is "no uncommented assignment".
    expect(envExample.has('TRADE_FUTURES_ENABLED')).toBe(false);
    expect(read('.env.example')).toMatch(/TRADE_FUTURES_ENABLED/);
  });

  /**
   * Compose's own default must be the restrictive one. `${VAR:-true}` would ship
   * futures ON to every clean clone while every other file in the change still read
   * as though it were off — the same shape as the profit-source defect this file is
   * named for, where three individually defensible files combined into an outage.
   */
  it('compose defaults the flag to false rather than passing it through blank or on', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_ENABLED:\s*\$\{TRADE_FUTURES_ENABLED:-false\}/);
  });

  /**
   * The service-level default, which is a THIRD place the answer lives and the one
   * a revert probe found unguarded: with `TradeServiceOptions.futuresEnabled`
   * flipped to `?? true`, every test in the change still passed, because every one
   * of them passes the option explicitly. Read from source for the same reason as
   * the zod default — the behavioural half is in `futures/orderable-path.test.ts`,
   * which now constructs a service without the option and asserts the refusal.
   */
  it('defaults TradeServiceOptions.futuresEnabled to false in the constructor', () => {
    const src = read('services/svc-trade/src/spot/trade-service.ts');
    expect(src).toMatch(/this\.futuresEnabled\s*=\s*options\.futuresEnabled\s*\?\?\s*false;/);
  });

  it('passes the env flag into the service rather than leaving it at the default', () => {
    expect(read('services/svc-trade/src/index.ts')).toMatch(/futuresEnabled:\s*env\.TRADE_FUTURES_ENABLED/);
  });
});

describe('the shipped configuration does not turn futures jobs on', () => {
  it('hands the container jobs OFF on a clean clone', () => {
    expect(shipped.has('TRADE_FUTURES_JOBS_ENABLED')).toBe(true);
    expect(shipped.get('TRADE_FUTURES_JOBS_ENABLED')).toBe('false');
  });

  it('declares the env default as false, so a deployment that never mentions it gets nothing', () => {
    const src = joinChains(read('services/svc-trade/src/env.ts'));
    const decl = /TRADE_FUTURES_JOBS_ENABLED:\s*(z\.[^\n]*)/.exec(src);
    expect(decl, 'TRADE_FUTURES_JOBS_ENABLED is not declared in svc-trade/src/env.ts').not.toBeNull();
    expect(decl![1]).toContain('.default(false)');
    expect(decl![1]).not.toContain('.default(true)');
  });

  it('leaves TRADE_FUTURES_JOBS_ENABLED commented out in .env.example, and documents it', () => {
    expect(envExample.has('TRADE_FUTURES_JOBS_ENABLED')).toBe(false);
    expect(read('.env.example')).toMatch(/TRADE_FUTURES_JOBS_ENABLED/);
  });

  it('compose defaults the flag to false rather than passing it through blank or on', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_JOBS_ENABLED:\s*\$\{TRADE_FUTURES_JOBS_ENABLED:-false\}/);
  });

  it('passes the env flag into startFuturesJobs rather than leaving jobs implied on', () => {
    expect(read('services/svc-trade/src/index.ts')).toMatch(/enabled:\s*env\.TRADE_FUTURES_JOBS_ENABLED/);
  });
});

describe('the shipped configuration does not turn the venue mark stream on', () => {
  it('hands the container the stream OFF on a clean clone', () => {
    expect(shipped.has('TRADE_VENUE_MARK_STREAM')).toBe(true);
    expect(shipped.get('TRADE_VENUE_MARK_STREAM')).toBe('false');
  });

  it('declares the env default as false, so a deployment that never mentions it gets nothing', () => {
    const src = joinChains(read('services/svc-trade/src/env.ts'));
    const decl = /TRADE_VENUE_MARK_STREAM:\s*(z\.[^\n]*)/.exec(src);
    expect(decl, 'TRADE_VENUE_MARK_STREAM is not declared in svc-trade/src/env.ts').not.toBeNull();
    expect(decl![1]).toContain('.default(false)');
    expect(decl![1]).not.toContain('.default(true)');
  });

  it('leaves TRADE_VENUE_MARK_STREAM commented out in .env.example, and documents it', () => {
    expect(envExample.has('TRADE_VENUE_MARK_STREAM')).toBe(false);
    expect(read('.env.example')).toMatch(/TRADE_VENUE_MARK_STREAM/);
  });

  it('compose defaults the flag to false rather than passing it through blank or on', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_VENUE_MARK_STREAM:\s*\$\{TRADE_VENUE_MARK_STREAM:-false\}/);
  });

  it('passes the env flag into /health venueLatency rather than implying a live stream', () => {
    expect(read('services/svc-trade/src/index.ts')).toMatch(/streamEnabled:\s*env\.TRADE_VENUE_MARK_STREAM/);
  });
});

describe('the shipped configuration does not invent a venue mark map', () => {
  it('hands the container empty venue id and empty symbol map on a clean clone', () => {
    expect(shipped.get('TRADE_VENUE_MARK_VENUE')).toBe('');
    expect(shipped.get('TRADE_VENUE_MARK_SYMBOLS')).toBe('');
  });

  it('compose pins both keys empty rather than omitting them (host env cannot leak a map)', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_VENUE_MARK_VENUE:\s*\$\{TRADE_VENUE_MARK_VENUE:-\}/);
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_VENUE_MARK_SYMBOLS:\s*\$\{TRADE_VENUE_MARK_SYMBOLS:-\}/);
  });
});

describe('the shipped configuration does not invent a funding market list', () => {
  it('declares TRADE_FUTURES_FUNDING_MARKET_IDS default empty', () => {
    const src = joinChains(read('services/svc-trade/src/env.ts'));
    expect(src).toMatch(/TRADE_FUTURES_FUNDING_MARKET_IDS:\s*z\.string\(\)\.default\(''\)/);
  });

  it('leaves TRADE_FUTURES_FUNDING_MARKET_IDS commented in .env.example', () => {
    expect(envExample.has('TRADE_FUTURES_FUNDING_MARKET_IDS')).toBe(false);
    expect(read('.env.example')).toMatch(/TRADE_FUTURES_FUNDING_MARKET_IDS/);
  });

  it('compose pins TRADE_FUTURES_FUNDING_MARKET_IDS empty rather than omitting it', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_FUNDING_MARKET_IDS:\s*\$\{TRADE_FUTURES_FUNDING_MARKET_IDS:-\}/);
    expect(shipped.get('TRADE_FUTURES_FUNDING_MARKET_IDS')).toBe('');
  });

  it('lists TRADE_FUTURES_FUNDING_MARKET_IDS once among unique svc-trade compose keys', () => {
    const keys = composeServiceOwnEnvKeys('svc-trade', read('docker-compose.apps.yml'));
    expect(keys.length).toBe(new Set(keys).size);
    expect(keys.filter((k) => k === 'TRADE_FUTURES_FUNDING_MARKET_IDS')).toHaveLength(1);
  });
});

describe('the shipped configuration does not inject an 8h funding interval', () => {
  it('compose pins TRADE_FUTURES_FUNDING_INTERVAL_MS empty rather than 8h', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS:\s*\$\{TRADE_FUTURES_FUNDING_INTERVAL_MS:-\}/);
    expect(read('docker-compose.apps.yml')).not.toMatch(/28_?800_?000|28800000/);
    expect(shipped.get('TRADE_FUTURES_FUNDING_INTERVAL_MS')).toBe('');
  });
});

describe('the shipped configuration passes the futures liquidation-scan interval', () => {
  it('compose pins TRADE_FUTURES_LIQ_INTERVAL_MS to 15s matching env.ts', () => {
    expect(read('docker-compose.apps.yml')).toMatch(/TRADE_FUTURES_LIQ_INTERVAL_MS:\s*\$\{TRADE_FUTURES_LIQ_INTERVAL_MS:-15000\}/);
    expect(shipped.get('TRADE_FUTURES_LIQ_INTERVAL_MS')).toBe('15000');
  });
});

/**
 * MM seed + algo jobs only reach the container if compose names them.
 * env.ts already defines the flags; without this block a host `.env` is
 * invisible to `platform:up`. Pin fails if a name disappears from svc-trade.
 */
function envTsTradeKeys(pattern: RegExp): string[] {
  const src = joinChains(read('services/svc-trade/src/env.ts'));
  // Comments in env.ts repeat flag names; unique so the pin is names, not hits.
  return [...new Set([...src.matchAll(pattern)].map((m) => m[1]!))];
}

describe('the shipped configuration passes MM seed and algo job flags into svc-trade', () => {
  const mmSeedKeys = envTsTradeKeys(/\b(TRADE_MM_SEED_[A-Z0-9_]+)\s*:/g);
  const algoKeys = envTsTradeKeys(/\b(TRADE_ALGO_ENABLED|TRADE_ALGO_JOBS_ENABLED|TRADE_ALGO_JOBS_INTERVAL_MS)\s*:/g);
  const convertKeys = envTsTradeKeys(/\b(TRADE_CONVERT_ENABLED|TRADE_CONVERT_SPREAD_BPS)\s*:/g);

  it('env.ts still declares the MM seed and algo job names this pin tracks', () => {
    expect(mmSeedKeys.length).toBeGreaterThanOrEqual(10);
    expect(algoKeys.sort()).toEqual(['TRADE_ALGO_ENABLED', 'TRADE_ALGO_JOBS_ENABLED', 'TRADE_ALGO_JOBS_INTERVAL_MS'].sort());
    expect(convertKeys.sort()).toEqual(['TRADE_CONVERT_ENABLED', 'TRADE_CONVERT_SPREAD_BPS'].sort());
  });

  it('compose svc-trade block names every TRADE_MM_SEED_* and TRADE_ALGO_* job flag from env.ts', () => {
    for (const name of [...mmSeedKeys, ...algoKeys, ...convertKeys]) {
      expect(shipped.has(name), `${name} missing from svc-trade compose environment`).toBe(true);
    }
  });

  it('lists each svc-trade compose environment key once', () => {
    const keys = composeServiceOwnEnvKeys('svc-trade', read('docker-compose.apps.yml'));
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('hands the container seed OFF and empty markets/mids on a clean clone', () => {
    expect(shipped.get('TRADE_MM_SEED_ENABLED')).toBe('false');
    expect(shipped.get('TRADE_MM_SEED_MID_FROM_VENUE')).toBe('false');
    expect(shipped.get('TRADE_MM_SEED_MARKETS')).toBe('');
    expect(shipped.get('TRADE_MM_SEED_MIDS')).toBe('');
  });

  it('compose defaults seed enable flags to false, never ${VAR:-true}', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_MM_SEED_ENABLED:\s*\$\{TRADE_MM_SEED_ENABLED:-false\}/);
    expect(compose).toMatch(/TRADE_MM_SEED_MID_FROM_VENUE:\s*\$\{TRADE_MM_SEED_MID_FROM_VENUE:-false\}/);
    expect(compose).not.toMatch(/TRADE_MM_SEED_ENABLED:\s*\$\{TRADE_MM_SEED_ENABLED:-true\}/);
    expect(compose).not.toMatch(/TRADE_MM_SEED_MID_FROM_VENUE:\s*\$\{TRADE_MM_SEED_MID_FROM_VENUE:-true\}/);
  });

  it('hands the container algo jobs OFF on a clean clone', () => {
    expect(shipped.get('TRADE_ALGO_JOBS_ENABLED')).toBe('false');
  });

  it('compose defaults TRADE_ALGO_JOBS_ENABLED to false, never ${VAR:-true}', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_ALGO_JOBS_ENABLED:\s*\$\{TRADE_ALGO_JOBS_ENABLED:-false\}/);
    expect(compose).not.toMatch(/TRADE_ALGO_JOBS_ENABLED:\s*\$\{TRADE_ALGO_JOBS_ENABLED:-true\}/);
  });

  it('hands the container convert ON and empty spread on a clean clone', () => {
    expect(shipped.get('TRADE_CONVERT_ENABLED')).toBe('true');
    expect(shipped.get('TRADE_CONVERT_SPREAD_BPS')).toBe('');
  });

  it('compose defaults convert kill ON and spread empty (never invent 10)', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_CONVERT_ENABLED:\s*\$\{TRADE_CONVERT_ENABLED:-true\}/);
    expect(compose).toMatch(/TRADE_CONVERT_SPREAD_BPS:\s*\$\{TRADE_CONVERT_SPREAD_BPS:-\}/);
    expect(compose).not.toContain('TRADE_CONVERT_SPREAD_BPS: ${TRADE_CONVERT_SPREAD_BPS:-' + '10}');
  });
});

describe('the shipped configuration passes OTC desk flags into svc-trade', () => {
  const otcKeys = envTsTradeKeys(/\b(TRADE_OTC_DESK_LAW|TRADE_OTC_MIDS|TRADE_OTC_MID_FROM_VENUE|TRADE_OTC_VENUE_SYMBOLS)\s*:/g);

  it('env.ts still declares the OTC names this pin tracks', () => {
    expect(otcKeys.sort()).toEqual(['TRADE_OTC_DESK_LAW', 'TRADE_OTC_MIDS', 'TRADE_OTC_MID_FROM_VENUE', 'TRADE_OTC_VENUE_SYMBOLS'].sort());
  });

  it('compose svc-trade block names every TRADE_OTC_* flag from env.ts', () => {
    for (const name of otcKeys) {
      expect(shipped.has(name), `${name} missing from svc-trade compose environment`).toBe(true);
    }
  });

  it('lists each svc-trade compose environment key once', () => {
    const keys = composeServiceOwnEnvKeys('svc-trade', read('docker-compose.apps.yml'));
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('hands the container empty law, empty mids, venue OFF, empty symbols on a clean clone', () => {
    expect(shipped.get('TRADE_OTC_DESK_LAW')).toBe('');
    expect(shipped.get('TRADE_OTC_MIDS')).toBe('');
    expect(shipped.get('TRADE_OTC_MID_FROM_VENUE')).toBe('false');
    expect(shipped.get('TRADE_OTC_VENUE_SYMBOLS')).toBe('');
  });

  it('compose pins empty law/mids/symbols and venue default false (never invent JSON or mids)', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_OTC_DESK_LAW:\s*\$\{TRADE_OTC_DESK_LAW:-\}/);
    expect(compose).toMatch(/TRADE_OTC_MIDS:\s*\$\{TRADE_OTC_MIDS:-\}/);
    expect(compose).toMatch(/TRADE_OTC_MID_FROM_VENUE:\s*\$\{TRADE_OTC_MID_FROM_VENUE:-false\}/);
    expect(compose).toMatch(/TRADE_OTC_VENUE_SYMBOLS:\s*\$\{TRADE_OTC_VENUE_SYMBOLS:-\}/);
    expect(compose).not.toMatch(/TRADE_OTC_MID_FROM_VENUE:\s*\$\{TRADE_OTC_MID_FROM_VENUE:-true\}/);
  });
});

describe('the shipped configuration passes options settlement-asset-law into svc-trade', () => {
  const optionsAssetLawKeys = envTsTradeKeys(/\b(TRADE_OPTIONS_SETTLEMENT_ASSET_LAW)\s*:/g);

  it('env.ts still declares the options asset-law name this pin tracks', () => {
    expect(optionsAssetLawKeys).toEqual(['TRADE_OPTIONS_SETTLEMENT_ASSET_LAW']);
  });

  it('compose svc-trade block names TRADE_OPTIONS_SETTLEMENT_ASSET_LAW', () => {
    for (const name of optionsAssetLawKeys) {
      expect(shipped.has(name), `${name} missing from svc-trade compose environment`).toBe(true);
    }
  });

  it('lists each svc-trade compose environment key once', () => {
    const keys = composeServiceOwnEnvKeys('svc-trade', read('docker-compose.apps.yml'));
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('hands the container empty settlement-asset-law on a clean clone', () => {
    expect(shipped.get('TRADE_OPTIONS_SETTLEMENT_ASSET_LAW')).toBe('');
  });

  it('compose pins empty asset-law (never invents live set / settlement asset / matrix)', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:\s*\$\{TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:-\}/);
  });
});

/**
 * Market IOC hold cap only reaches the container if compose names it.
 * Empty on a clean clone — never invent 200.
 */
describe('the shipped configuration passes TRADE_MARKET_SLIPPAGE_CAP_BPS into svc-trade', () => {
  const slippageKeys = envTsTradeKeys(/\b(TRADE_MARKET_SLIPPAGE_CAP_BPS)\s*:/g);

  it('env.ts still declares the slippage cap this pin tracks', () => {
    expect(slippageKeys).toEqual(['TRADE_MARKET_SLIPPAGE_CAP_BPS']);
  });

  it('declares no invented 200 default', () => {
    const src = joinChains(read('services/svc-trade/src/env.ts'));
    const decl = /TRADE_MARKET_SLIPPAGE_CAP_BPS:\s*(z\.[^\n]*)/.exec(src);
    expect(decl, 'TRADE_MARKET_SLIPPAGE_CAP_BPS is not declared in svc-trade/src/env.ts').not.toBeNull();
    expect(decl![1]).not.toContain('.default(' + '200)');
    expect(src).toMatch(/TRADE_CONVERT_SPREAD_BPS:[\s\S]*?\.default\(''\)/);
    expect(src).not.toMatch(new RegExp('TRADE_CONVERT_SPREAD_BPS:[\\s\\S]{0,200}\\.default\\(' + '10\\)'));
  });

  it('compose svc-trade block names TRADE_MARKET_SLIPPAGE_CAP_BPS once', () => {
    const keys = composeServiceOwnEnvKeys('svc-trade', read('docker-compose.apps.yml'));
    expect(keys.filter((k) => k === 'TRADE_MARKET_SLIPPAGE_CAP_BPS')).toHaveLength(1);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('hands the container empty cap on a clean clone', () => {
    expect(shipped.get('TRADE_MARKET_SLIPPAGE_CAP_BPS')).toBe('');
  });

  it('compose pins empty cap (host can publish; never invent 200)', () => {
    const compose = read('docker-compose.apps.yml');
    expect(compose).toMatch(/TRADE_MARKET_SLIPPAGE_CAP_BPS:\s*\$\{TRADE_MARKET_SLIPPAGE_CAP_BPS:-\}/);
    expect(compose).not.toContain('TRADE_MARKET_SLIPPAGE_CAP_BPS: ${TRADE_MARKET_SLIPPAGE_CAP_BPS:-' + '200}');
  });
});
