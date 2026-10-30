#!/usr/bin/env node
/**
 * `compose-env`: the env file a fresh `docker compose --profile tester up` needs (J-home-ia-11 #1), from the same source
 * `pnpm local:stack` runs on, never a second copy of it.
 *
 *   node tooling/scripts/local-test-compose-env.mjs [--out .env.tester.local]
 *   docker compose --env-file .env.example --env-file .env.tester.local -f docker-compose.yml -f docker-compose.apps.yml \
 *     --profile tester up seed
 *
 * .env.example leaves deployment values blank on purpose, and compose refuses a blank `${VAR:?}`. For every compose service
 * the local stack also runs (svc-<name> and local-stack-services/<name>.mjs), each variable compose would leave blank gets
 * the value that service runs with on the stack: its LOCAL TEST settings, this stack's generated keys (STATE/secrets.json,
 * created on first use) and the screening fixture when STATE/screening.local.json holds one. A variable two services fill
 * differently refuses by name. The AI gateway's two values only let compose parse its `ai` profile, which never starts
 * here. The file is written mode 600 and is git-ignored (`.env.*.local`): it holds keys and is never committed.
 * LOCAL TEST only; nothing here is an owner decision.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.apps.yml'];

/** Values compose needs only to parse a profile the tester never starts (`ai`): not a key and no config. */
export const PARSE_ONLY = {
  LITELLM_MASTER_KEY: 'placeholder-not-a-key-tester-profile',
  LITELLM_CONFIG_PATH: '/dev/null',
};

/** The variable an un-interpolated compose value names when it is only that variable with no non-blank default. */
export function blankableVariable(raw) {
  const m = /^\$\{([A-Z][A-Z0-9_]*)(?:(:?\?)[^}]*|:?-)?\}$/.exec(String(raw ?? ''));
  return m ? m[1] : null;
}

/** `KEY=` lines with no value in an env file, as a set. */
export function blankKeys(text) {
  const blank = new Set();
  const set = new Set();
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[2].trim() === '') blank.add(m[1]);
    else set.add(m[1]);
  }
  return { blank, set };
}

const WHOLE_VALUE = /^\s+[A-Z][A-Z0-9_]*:\s*["']?(\$\{[A-Z][A-Z0-9_]*(?::?\?[^}]*|:?-)?\})["']?\s*$/;

/**
 * The variables to read back through markers: each one some service's environment names as its whole value with no
 * non-blank default, that .env.example leaves blank or unset and that no other compose field uses (a port or a path
 * cannot hold a marker). Returns a map from variable to how compose names it (`${X:?}` or `${X:-}`).
 */
export function markedVariables(composeText, example) {
  const { set } = blankKeys(example);
  const whole = new Map();
  const elsewhere = new Set();
  for (const line of composeText.split('\n')) {
    const m = WHOLE_VALUE.exec(line);
    if (m) {
      const variable = blankableVariable(m[1]);
      if (!whole.has(variable) || /:?\?/.test(m[1])) whole.set(variable, /:?\?/.test(m[1]) ? `\${${variable}:?}` : `\${${variable}:-}`);
      continue;
    }
    for (const r of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) elsewhere.add(r[1]);
  }
  for (const variable of [...whole.keys()])
    if (set.has(variable) || elsewhere.has(variable) || variable in PARSE_ONLY) whole.delete(variable);
  return whole;
}

export const marker = (variable) => `__compose_env_${variable}__`;

/** An env file that sets every marked variable to its marker, plus PARSE_ONLY, for one interpolated compose read. */
export function markerEnvFile(marked) {
  return Object.entries({ ...Object.fromEntries([...marked.keys()].map((v) => [v, marker(v)])), ...PARSE_ONLY })
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

/** Interpolated services with each marker turned back into the compose reference it came from. */
export function unmark(services, marked) {
  const back = new Map([...marked].map(([variable, raw]) => [marker(variable), raw]));
  return Object.fromEntries(
    Object.entries(services).map(([name, svc]) => [
      name,
      { ...svc, environment: Object.fromEntries(Object.entries(svc.environment ?? {}).map(([k, v]) => [k, back.get(v) ?? v])) },
    ]),
  );
}

/** `root` and every service it depends on, transitively: what `docker compose up <root>` starts. */
export function startedBy(services, root) {
  const seen = new Set([root]);
  const todo = [root];
  while (todo.length) {
    const deps = services[todo.pop()]?.depends_on ?? {};
    for (const dep of Array.isArray(deps) ? deps : Object.keys(deps)) if (!seen.has(dep)) (seen.add(dep), todo.push(dep));
  }
  return seen;
}

/**
 * The values to write: `services` is compose's service map with each blankable value as its compose reference (unmark), `stackEnvs` maps a stack name (`edge`) to that
 * service's stack env, `example` is .env.example's text, `started` the services `up seed` starts (null: all). Returns
 * { values, conflicts, unfilled }.
 */
export function composeEnvValues({ services, stackEnvs, example, started = null }) {
  const { set } = blankKeys(example);
  const values = {};
  const from = {};
  const conflicts = [];
  const unfilled = new Set();
  for (const [name, svc] of Object.entries(services)) {
    if (started && !started.has(name)) continue;
    const stack = stackEnvs[name.replace(/^svc-/, '')];
    for (const [key, raw] of Object.entries(svc.environment ?? {})) {
      const variable = blankableVariable(raw);
      if (!variable || set.has(variable) || variable in PARSE_ONLY) continue;
      const value = stack?.[key];
      if (value === undefined || value === '') {
        if (/:?\?/.test(String(raw))) unfilled.add(variable);
        continue;
      }
      if (variable in values && values[variable] !== String(value)) {
        conflicts.push(`${variable}: ${from[variable]} and ${name} run with different values`);
        continue;
      }
      values[variable] = String(value);
      from[variable] ??= name;
    }
  }
  for (const variable of Object.keys(values)) unfilled.delete(variable);
  return { values: { ...values, ...PARSE_ONLY }, conflicts, unfilled: [...unfilled].sort() };
}

/**
 * One value as compose's env-file parser reads it back unchanged: bare when plain, single-quoted (literal) when it has
 * spaces or quotes but no single quote, otherwise double-quoted with `\\`, `"` escaped and `$` doubled (no interpolation).
 */
export function envFileValue(value) {
  if (!/[\s#"'$`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$')}"`;
}

export function renderEnvFile(values) {
  const lines = [
    '# LOCAL TEST values for the tester profile only; never a live value. Generated by',
    "# tooling/scripts/local-test-compose-env.mjs from what `pnpm local:stack` runs with; holds this stack's generated keys,",
    '# so it is git-ignored and never committed. Run the generator again rather than editing it.',
    '',
  ];
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (/[\n\r]/.test(value)) throw new Error(`${key} has a line break, which an env file cannot hold`);
    lines.push(`${key}=${envFileValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const at = argv.indexOf('--out');
  const out = path.resolve(ROOT, at >= 0 ? (argv[at + 1] ?? '') : '.env.tester.local');
  if (!process.env.LOCAL_STACK_STATE) throw new Error('LOCAL_STACK_STATE must name the state folder the tester profile mounts');
  const { loadOrCreateSecrets, localTestServiceEnvs } = await import('./local-test-stack.mjs');
  // An interpolated read: older compose cannot parse a volume spec without interpolation, so each variable to fill is
  // set to a marker and read back from where the marker lands.
  const composeText = COMPOSE_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const marked = markedVariables(composeText, example);
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-env-'));
  const markerFile = path.join(markers, 'markers.env');
  fs.writeFileSync(markerFile, markerEnvFile(marked), { mode: 0o600 });
  const config = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '--env-file',
      markerFile,
      ...COMPOSE_FILES.flatMap((f) => ['-f', f]),
      '--profile',
      'tester',
      'config',
      '--format',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  fs.rmSync(markers, { recursive: true, force: true });
  if (config.status !== 0) throw new Error(`docker compose config failed:\n${config.stderr}`);
  const services = unmark(JSON.parse(config.stdout).services, marked);
  const stackEnvs = Object.fromEntries(localTestServiceEnvs(loadOrCreateSecrets()).map((s) => [s.name, s.env]));
  const started = startedBy(services, 'seed');
  const { values, conflicts, unfilled } = composeEnvValues({ services, stackEnvs, example, started });
  if (conflicts.length)
    throw new Error(`refusing: compose shares a variable the stack sets differently per service:\n  ${conflicts.join('\n  ')}`);
  if (unfilled.length) throw new Error(`refusing: compose requires values the stack does not run with: ${unfilled.join(', ')}`);
  fs.writeFileSync(out, renderEnvFile(values), { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(
    `compose-env: ${Object.keys(values).length} LOCAL TEST values written to ${path.relative(ROOT, out)} (git-ignored, mode 600)`,
  );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
