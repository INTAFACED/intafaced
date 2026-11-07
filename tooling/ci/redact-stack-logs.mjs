#!/usr/bin/env node
/**
 * Copies a journey shard's stack logs for its artifact, with nothing secret in them (#7463). A shard's service logs
 * are what shows why a service was slow or down, but an artifact isn't masked the way a job log is, and Edge logs the
 * sanctions screening declaration at boot, which comes from the repository's secrets.
 *
 * For each `<from>/*.log`:
 *   1. every line that mentions sanctions is replaced by a notice;
 *   2. every remaining occurrence of a secret value is replaced by `***`. The values are those of the environment
 *      variables in SECRET_ENV, and every string of 8 or more characters in the stack's own `secrets.json` (its
 *      generated TEST keys and passwords), as written and as JSON escapes them;
 *   3. a file in which any of those values can still be found is left out, by name (fails closed).
 *
 * Usage: node tooling/ci/redact-stack-logs.mjs <logs dir> <out dir> [--secrets <secrets.json>]
 * A missing logs dir copies nothing and exits 0: a shard whose stack never started has no logs.
 * (Failure it prevents: on run 42379971970, shard 34, identity stayed down after a restart and no service log was kept,
 * so the cause couldn't be read; #7463.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The job's secret environment variables (real-app-journeys.yml, the shard job's `env`). */
export const SECRET_ENV = ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE'];
export const DROPPED = '[line removed for the artifact: it names the sanctions screening settings]';
/** The shortest generated value masked from secrets.json; shorter strings there are names and flags, not secrets. */
const MIN_GENERATED = 8;

/** Every string in a JSON value, at any depth. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** The values to mask: the secret environment variables' (any length but empty) and the stack's generated ones. */
export function secretValues({ env = process.env, secretsJson = null } = {}) {
  const values = SECRET_ENV.map((k) => env[k]).filter((v) => typeof v === 'string' && v.trim() !== '');
  if (secretsJson) values.push(...strings(secretsJson).filter((v) => v.length >= MIN_GENERATED));
  // Each value as written and as JSON escapes it, longest first, so a value inside another is masked inside it too.
  const forms = new Set();
  for (const v of values) for (const f of [v, JSON.stringify(v).slice(1, -1)]) if (f) forms.add(f);
  return [...forms].sort((a, b) => b.length - a.length);
}

/** One log's text for the artifact: sanctions lines dropped, secret values masked. */
export function redact(text, values) {
  let out = String(text)
    .split('\n')
    .map((line) => (/sanction/i.test(line) ? DROPPED : line))
    .join('\n');
  for (const v of values) out = out.split(v).join('***');
  return out;
}

/** True when a secret value can still be found in the text. */
export const leaks = (text, values) => values.some((v) => text.includes(v));

/** Redacts every `*.log` in `from` into `to`; returns what it kept and what it left out. `clean` is `redact` (a test
 *  passes a broken one, to see the leak check leave the file out). */
export function redactDir(from, to, values, clean = redact) {
  const kept = [];
  const left = [];
  if (!fs.existsSync(from)) return { kept, left, missing: true };
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs
    .readdirSync(from)
    .filter((n) => n.endsWith('.log'))
    .sort()) {
    const text = clean(fs.readFileSync(path.join(from, name), 'utf8'), values);
    if (leaks(text, values)) {
      left.push(name);
      continue;
    }
    fs.writeFileSync(path.join(to, name), text);
    kept.push(name);
  }
  return { kept, left, missing: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [from, to, ...rest] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node tooling/ci/redact-stack-logs.mjs <logs dir> <out dir> [--secrets <secrets.json>]');
    process.exit(2);
  }
  const at = rest.indexOf('--secrets');
  const secretsFile = at >= 0 ? rest[at + 1] : null;
  let secretsJson = null;
  if (secretsFile && fs.existsSync(secretsFile)) secretsJson = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  const { kept, left, missing } = redactDir(from, to, secretValues({ secretsJson }));
  if (missing) console.log(`redact-stack-logs: no logs at ${from}; nothing kept`);
  else console.log(`redact-stack-logs: kept ${kept.length} log(s) in ${to}`);
  for (const name of left) console.log(`::warning::redact-stack-logs: ${name} left out: a secret value could still be found in it`);
}
