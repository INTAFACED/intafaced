#!/usr/bin/env node
/**
 * COMPOSE SECRET PARITY — every secret a service refuses to boot without is
 * actually supplied to that service's container.
 *
 * WHY THIS EXISTS, and it is a short story with two identical halves.
 *
 * `svc-ledger` merges `authEnvSchema`, so `JWT_ACCESS_SECRET` is required with
 * no default. Its block in `docker-compose.apps.yml` never set it. The service
 * crash-looped on `JWT_ACCESS_SECRET: Required` (#431).
 *
 * The interesting part is not the missing line. It is WHY nobody noticed for so
 * long: **a running container keeps the environment it started with.** The
 * fleet was healthy, `docker ps` was green, and the defect was latent until an
 * unrelated `up` recreated the container. A secret that is missing but not yet
 * fatal is invisible until the next deploy — which is to say, it surfaces at the
 * worst possible moment, during a change, while somebody is looking at something
 * else.
 *
 * That is not a bug you fix once. It is a bug you make impossible. Writing this
 * check found the second one immediately: `svc-academy` merges
 * `internalServiceEnvSchema` and its compose block supplied only the edge
 * secret. Same defect, same latency, not yet triggered.
 *
 * It then found it a THIRD time. That gap was fixed by #442, and reverted 26
 * minutes later by an unrelated merge; this gate caught the revert on a rebase
 * a day afterwards, when nothing else had. See FIXED_IN_OPEN_PR below — that
 * sequence is the argument for this file existing.
 *
 * It matters most during a ROTATION. Rotating a shared secret means editing
 * every consumer; getting three of four is the same failure with a worse blast
 * radius, and the fourth service will not tell you until it restarts. See
 * docs/SECRET-ROTATION-READINESS-2026-08-03.md for the blast-radius map this
 * check mechanises.
 *
 * WHAT IT DOES NOT DO, stated so the green line is not read as more than it is:
 *
 *   · It never reads a secret's VALUE, and never asserts one is set — `${VAR:?…}`
 *     already makes compose refuse to start for that. It asserts only that the
 *     WIRING exists: schema requires it, compose passes it.
 *   · It covers SECRET-SHAPED names only (see `SECRET_VAR`). A required
 *     `DATABASE_URL` absent from compose crash-loops identically and is invisible
 *     here. The name of this file is `compose-SECRET-parity` for that reason.
 *   · Both sides are read with regexes, not with a TS parser and a YAML parser.
 *     The requirement side fails toward MISSING a requirement (a false negative);
 *     the compose side fails toward seeing FEWER supplied variables (a false
 *     alarm). Neither direction can invent a green tick out of a real gap, and
 *     the zero-comparison guard at the bottom refuses the degenerate case where
 *     a parse stops matching entirely.
 *   · `env_file:` is not read. Nothing in this compose file uses it today; a
 *     service that started to would show up as a false alarm, not a false pass.
 *
 * Exit 0 = every required secret is wired. Exit 1 = a service would crash-loop
 * on its next container recreate, is in no compose block at all, or a parse
 * stopped matching and nothing was actually compared.
 *
 *   node tooling/ci/compose-secret-parity.mjs
 *   node tooling/ci/compose-secret-parity.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPOSE = 'docker-compose.apps.yml';

/**
 * Secret-shaped env var names. Deliberately the same shape the scan uses — and
 * on 2026-08-07 that meant deliberately the same blind spot.
 *
 * `KEY` was only recognised behind a qualifier (`PRIVATE_KEY`, `API_KEY`), so
 * `PAY_CRYPTO_HOT_WALLET_KEY` — which signs every payout — was not secret-shaped
 * to this check either, and its compose/env parity went unverified. `MNEMONIC`
 * and `SEED` were absent for the same reason. A trailing deployment qualifier
 * also hid the word: `STRIPE_SECRET_KEY_LIVE`.
 *
 * Widening here is safe in a way it is not in `secret-scan`: this check compares
 * a compose block against a required zod field, so a false positive is "you
 * declared a var and did not wire it", not "you committed a secret". The one
 * exception is the business-key family, which is why `IDEMPOTENCY_KEY` and its
 * relatives are excluded — those genuinely are not secrets and would be noise.
 */
const SECRET_VAR =
  /(?:^|_)(?:SECRET|PASSWORD|TOKEN|CREDENTIAL|MNEMONIC|SEED|SEED_PHRASE|KEY|PRIVATE_KEY|API_KEY|ACCESS_KEY)S?(?:_(?:LIVE|TEST|PROD|PRODUCTION|STAGING|DEV|SANDBOX|V\d+|\d+))*$/;

/** Names that end in KEY and are identities, not credentials. Mirrors NOT_ACTUALLY_SECRET in secret-scan.mjs. */
const BUSINESS_KEY =
  /(?:^|_)(?:IDEMPOTENCY|BUSINESS|DEDUPE|CACHE|ROUTING|PARTITION|SORT|PRIMARY|FOREIGN|UNIQUE|INDEX|OBJECT|STORAGE|BUCKET|RECORD|MAP|LOOKUP|PUBLIC)_KEYS?$/;

const isSecretVar = (key) => SECRET_VAR.test(key) && !BUSINESS_KEY.test(key);

/**
 * `KEY: z.…` field declarations. ONE definition, because there were two copies
 * of this regex and fixing only one left the other reporting the same false
 * alarm — which is what a duplicated rule buys you.
 *
 * The chain runs to END OF LINE, not to the first comma. `[^,\n]*` looks right
 * and is not: a comma inside the chain's own arguments ends the capture early.
 * Real example, and it produced a false ALARM the moment `KEY` became a
 * secret-shaped name here:
 *
 *     PAY_CRYPTO_HOT_WALLET_KEY: z
 *       .string()
 *       .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x + 64 hex chars')
 *       .optional(),
 *
 * `joinChains` folds that onto one line, then the capture stopped at the comma
 * inside `.regex(…)`, so `.optional()` was never in the captured chain and a
 * clearly optional secret was reported as a required one compose failed to
 * supply. That inverts this file's stated contract: the requirement side is
 * supposed to fail toward MISSING a requirement, never toward inventing one.
 *
 * `joinChains` has already put each declaration on its own line, so the line IS
 * the chain. Over-capturing could only swallow a following field and read its
 * `.optional()`, which errs back toward the documented direction.
 */
const ZOD_FIELD = /([A-Z][A-Z0-9_]*)\s*:\s*(z\.[^\n]*)/;

/**
 * A zod field that is REQUIRED — no `.optional()` and no `.default(…)`. Those
 * two are the whole distinction this check turns on: an optional secret that is
 * absent degrades a feature, a required one stops the process.
 *
 * Call this only on a chain from `fieldSource`. The test is still a substring
 * test; comments, strings, templates, and regex bodies are already gone, so a
 * note or example that spells those tokens is not a call.
 */
const isRequired = (chain) => !/\.optional\s*\(/.test(chain) && !/\.default\s*\(/.test(chain);

/**
 * Pull `KEY: z.string()…` declarations out of a chunk of TypeScript, keeping
 * only the secret-shaped, required ones.
 *
 * A regex rather than a TS parse, and the trade is stated: the failure mode is a
 * MISSED requirement, never a false alarm.
 *
 * `joinChains` exists because the first draft DID miss one. Prettier wraps long
 * zod chains onto their own lines:
 *
 *     PAY_CRYPTO_HOT_WALLET_KEY: z
 *       .string()
 *       .regex(…)
 *       .optional(),
 *
 * and a line-bounded regex sees `z` and stops, so the `.optional()` — or worse,
 * its absence — is invisible. Re-joining continuation lines first costs one
 * replace and removes the whole class.
 */
const joinChains = (source) => source.replace(/\n\s*\./g, '.');

const REGEX_AFTER = /(?:^|[^A-Za-z0-9_$])(?:return|case|throw|typeof|void|in|of|await|yield|delete)$/;

function regexLikely(out) {
  let j = out.length - 1;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\t' || out[j] === '\n' || out[j] === '\r')) j--;
  if (j < 0) return true;
  // `>` is `=> /re/`. `)` is `if (v) /re/`. Both are regex literals, not division.
  if ('([{=,:;!&|?~^>)'.includes(out[j])) return true;
  return REGEX_AFTER.test(out.slice(Math.max(0, j - 8), j + 1));
}

/**
 * Drop comments and the insides of strings, templates, and regex literals.
 * Newlines stay so a declaration is still one line after `joinChains`.
 * Quotes stay so `.default('')` is still a default. Regex bodies become `/ /`
 * so a second pass cannot read the empty body as a line comment.
 *
 * A comment or example is not a zod call. Leaving it in the chain made
 * `isRequired` false and the service pass `need.delete` a secret the merged
 * slice required.
 */
function maskCode(source, start, end, stop) {
  let out = '';
  let i = start;
  let brace = 0;
  while (i < end) {
    const c = source[i];
    const next = i + 1 < end ? source[i + 1] : '';
    if (stop === '}' && c === '}' && brace === 0) return { out, i };
    if (c === '/' && next === '/') {
      i += 2;
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < end && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      if (i < end) i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += q;
      i++;
      while (i < end) {
        if (source[i] === '\\') {
          i += Math.min(2, end - i);
          continue;
        }
        if (source[i] === '\n') {
          out += '\n';
          i++;
          continue;
        }
        if (source[i] === q) {
          out += q;
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      out += '`';
      i++;
      while (i < end) {
        if (source[i] === '\\') {
          i += Math.min(2, end - i);
          continue;
        }
        if (source[i] === '`') {
          out += '`';
          i++;
          break;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          out += '${';
          const inner = maskCode(source, i + 2, end, '}');
          out += inner.out;
          i = inner.i;
          if (i < end && source[i] === '}') {
            out += '}';
            i++;
          }
          continue;
        }
        if (source[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (c === '/' && regexLikely(out)) {
      out += '/ ';
      i++;
      let inClass = false;
      while (i < end) {
        if (source[i] === '\\') {
          i += Math.min(2, end - i);
          continue;
        }
        if (source[i] === '\n') break;
        if (!inClass && source[i] === '/') {
          out += '/';
          i++;
          break;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      continue;
    }
    if (c === '{') brace++;
    else if (c === '}') brace = Math.max(0, brace - 1);
    out += c;
    i++;
  }
  return { out, i };
}

const fieldSource = (source) => joinChains(maskCode(source, 0, source.length, null).out);

function requiredSecretsIn(source) {
  const found = new Set();
  const re = new RegExp(ZOD_FIELD.source, 'g');
  const src = fieldSource(source);
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, key, chain] = m;
    if (!isSecretVar(key)) continue;
    if (!isRequired(chain)) continue;
    found.add(key);
  }
  return found;
}

function slicesFromConfig(configSrc) {
  const src = fieldSource(configSrc);
  const slices = new Map();
  for (const m of src.matchAll(/export const (\w+EnvSchema)\s*=\s*z\.object\(\{([\s\S]*?)\n\}\)/g)) {
    slices.set(m[1], requiredSecretsIn(m[2]));
  }
  // `serviceEnvSchema` is a composition of other slices; expand it the same way.
  const composed = /export const serviceEnvSchema\s*=([\s\S]*?);/.exec(src);
  if (composed) {
    const union = new Set();
    for (const s of composed[1].matchAll(/(\w+EnvSchema)/g)) for (const v of slices.get(s[1]) ?? []) union.add(v);
    slices.set('serviceEnvSchema', union);
  }
  return slices;
}

/**
 * Secrets this service source requires, after merged slices.
 * An inline non-required declaration removes a slice requirement (svc-ws
 * redeclares JWT_ACCESS_SECRET as `.optional()`).
 */
function requiredSecretsForService(serviceSrc, slices) {
  const src = fieldSource(serviceSrc);
  const need = new Set();
  for (const m of src.matchAll(/(\w+EnvSchema)/g)) for (const v of slices.get(m[1]) ?? []) need.add(v);
  const inlineRe = new RegExp(ZOD_FIELD.source, 'g');
  let m;
  while ((m = inlineRe.exec(src)) !== null) {
    const [, key, chain] = m;
    if (!isSecretVar(key)) continue;
    if (isRequired(chain)) need.add(key);
    else need.delete(key);
  }
  return need;
}

function selfTest() {
  const fails = [];
  const assert = (cond, message) => {
    if (!cond) fails.push(message);
  };
  const configSrc = [
    'export const authEnvSchema = z.object({',
    '  JWT_ACCESS_SECRET: z.string().min(32),',
    '  EDGE_PRINCIPAL_SECRET: z.string().min(32),',
    '});',
  ].join('\n');
  const needOf = (serviceSrc) => requiredSecretsForService(serviceSrc, slicesFromConfig(configSrc));

  {
    const need = needOf(
      [
        "import { authEnvSchema } from '@intafaced/config';",
        'export const envSchema = authEnvSchema;',
        '// example JWT_ACCESS_SECRET: z.string().optional(),',
        "/* example EDGE_PRINCIPAL_SECRET: z.string().default(''), */",
      ].join('\n'),
    );
    assert(need.has('JWT_ACCESS_SECRET'), 'line-comment example dropped JWT_ACCESS_SECRET');
    assert(need.has('EDGE_PRINCIPAL_SECRET'), 'block-comment example dropped EDGE_PRINCIPAL_SECRET');
  }

  {
    const need = needOf(
      [
        "import { authEnvSchema } from '@intafaced/config';",
        'export const envSchema = authEnvSchema;',
        'const line = "JWT_ACCESS_SECRET: z.string().optional()";',
        "const block = `EDGE_PRINCIPAL_SECRET: z.string().default('')`;",
      ].join('\n'),
    );
    assert(need.has('JWT_ACCESS_SECRET'), 'string example dropped JWT_ACCESS_SECRET');
    assert(need.has('EDGE_PRINCIPAL_SECRET'), 'template example dropped EDGE_PRINCIPAL_SECRET');
  }

  {
    const need = needOf(
      [
        'export const envSchema = z.object({',
        '  JWT_ACCESS_SECRET: z.string().min(32), // not .optional() or .default(',
        '  EDGE_PRINCIPAL_SECRET: z.string().min(32), /* .optional() */',
        '});',
      ].join('\n'),
    );
    assert(need.has('JWT_ACCESS_SECRET'), 'same-line comment marked JWT_ACCESS_SECRET optional');
    assert(need.has('EDGE_PRINCIPAL_SECRET'), 'block comment marked EDGE_PRINCIPAL_SECRET optional');
  }

  {
    const need = needOf(
      [
        'export const envSchema = z.object({',
        "  JWT_ACCESS_SECRET: z.string().min(32).describe('do not use .optional() or .default('),",
        '});',
      ].join('\n'),
    );
    assert(need.has('JWT_ACCESS_SECRET'), 'describe() example marked JWT_ACCESS_SECRET optional');
  }

  {
    const kept = needOf(
      [
        'export const envSchema = z.object({',
        '  PAY_CRYPTO_HOT_WALLET_KEY: z.string().regex(/.optional(|.default(/).min(64),',
        '});',
      ].join('\n'),
    );
    assert(kept.has('PAY_CRYPTO_HOT_WALLET_KEY'), 'regex body marked PAY_CRYPTO_HOT_WALLET_KEY optional');

    const arrow = needOf(
      [
        'export const envSchema = z.object({',
        '  PAY_CRYPTO_HOT_WALLET_KEY: z.string().refine((v) => /.optional(|.default(/.test(v)),',
        '});',
      ].join('\n'),
    );
    assert(arrow.has('PAY_CRYPTO_HOT_WALLET_KEY'), 'arrow regex example marked PAY_CRYPTO_HOT_WALLET_KEY optional');

    const call = needOf(
      [
        'export const envSchema = z.object({',
        '  JWT_ACCESS_SECRET: z.string().refine((v) => { if (v) /.optional(|.default(/; return true; }),',
        '});',
      ].join('\n'),
    );
    assert(call.has('JWT_ACCESS_SECRET'), 'call regex example marked JWT_ACCESS_SECRET optional');

    const dropped = needOf(
      [
        "import { authEnvSchema } from '@intafaced/config';",
        'export const envSchema = authEnvSchema.merge(z.object({',
        '  PAY_CRYPTO_HOT_WALLET_KEY: z',
        '    .string()',
        "    .regex(/^0x[0-9a-fA-F]{64}$/, 'shape only')",
        '    .optional(),',
        '}));',
      ].join('\n'),
    );
    assert(!dropped.has('PAY_CRYPTO_HOT_WALLET_KEY'), 'multiline .optional() after .regex() stayed required');
  }

  {
    const need = needOf(
      [
        "import { authEnvSchema } from '@intafaced/config';",
        'export const envSchema = authEnvSchema.merge(z.object({',
        '  JWT_ACCESS_SECRET: z.string().min(32).optional(),',
        "  EDGE_PRINCIPAL_SECRET: z.string().default(''),",
        '}));',
      ].join('\n'),
    );
    assert(!need.has('JWT_ACCESS_SECRET'), 'real .optional() did not relax JWT_ACCESS_SECRET');
    assert(!need.has('EDGE_PRINCIPAL_SECRET'), 'real .default() did not relax EDGE_PRINCIPAL_SECRET');
  }

  {
    const need = needOf(
      [
        "import { authEnvSchema } from '@intafaced/config';",
        'export const envSchema = authEnvSchema.merge(z.object({',
        '  JWT_ACCESS_SECRET: z.string()',
        '    .min(32)',
        '    .optional(),',
        '}));',
      ].join('\n'),
    );
    assert(!need.has('JWT_ACCESS_SECRET'), 'wrapped .optional() stayed required');
  }

  {
    const commentedSlice = [
      'export const authEnvSchema = z.object({',
      '  JWT_ACCESS_SECRET: z.string().min(32), // example .optional()',
      '});',
    ].join('\n');
    const sliceNeed = requiredSecretsForService('export const envSchema = authEnvSchema;', slicesFromConfig(commentedSlice));
    assert(sliceNeed.has('JWT_ACCESS_SECRET'), 'slice comment dropped JWT_ACCESS_SECRET');
  }

  if (fails.length) {
    console.error(`compose-secret-parity --self-test FAIL: ${fails.length}`);
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('compose-secret-parity --self-test OK (15 checks)');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

// ── 1 · what each shared slice in packages/config requires ───────────────────
// Derived, not hardcoded: a new secret added to an existing slice is picked up
// without anyone remembering to update this file.
const configSrc = readFileSync(join(ROOT, 'packages/config/src/env.ts'), 'utf8');
const slices = slicesFromConfig(configSrc);

// ── 2 · what each service requires ───────────────────────────────────────────
const serviceEnvFiles = execFileSync('git', ['ls-files', 'services/*/src/env.ts'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const required = new Map();
for (const rel of serviceEnvFiles) {
  const name = rel.split('/')[1];
  required.set(name, requiredSecretsForService(readFileSync(join(ROOT, rel), 'utf8'), slices));
}

// ── 3 · what compose supplies ────────────────────────────────────────────────
const composePath = join(ROOT, COMPOSE);
if (!existsSync(composePath)) {
  console.error(`✖ compose-secret-parity — ${COMPOSE} not found`);
  process.exit(1);
}
const composeLines = readFileSync(composePath, 'utf8').split(/\r?\n/);

/** Top-level `x-…: &anchor` blocks and the variable names they carry. */
const anchorVars = new Map();
{
  let anchor = null;
  for (const line of composeLines) {
    const decl = /^x-[\w-]+:\s*&([\w-]+)\s*$/.exec(line);
    if (decl) {
      anchor = decl[1];
      anchorVars.set(anchor, new Set());
      continue;
    }
    if (/^\S/.test(line)) anchor = null; // left the block
    if (!anchor) continue;
    const kv = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (kv) anchorVars.get(anchor).add(kv[1]);
  }
}

/** Per compose service: the vars inside its `environment:` block only. */
const supplied = new Map();
{
  let svc = null;
  let inEnv = false;
  for (const line of composeLines) {
    const svcDecl = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (svcDecl) {
      svc = svcDecl[1];
      inEnv = false;
      supplied.set(svc, new Set());
      continue;
    }
    if (!svc) continue;
    if (/^ {4}\S/.test(line)) inEnv = /^ {4}environment:/.test(line);
    if (!inEnv) continue;

    // `<<: [*a, *b]` or `<<: *a` — only counted inside environment:
    const merge = /^\s*<<:\s*(?:\[([^\]]+)\]|\*([\w-]+))/.exec(line);
    if (merge) {
      const names = merge[1] ? merge[1].split(',') : [merge[2]];
      for (const raw of names) for (const v of anchorVars.get(raw.trim().replace(/^\*/, '')) ?? []) supplied.get(svc).add(v);
      continue;
    }
    const kv = /^ {6}([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (kv) supplied.get(svc).add(kv[1]);
  }
}

/**
 * ── FIXED IN AN OPEN PR ─────────────────────────────────────────────────────
 *
 * A gap whose fix is already committed on another branch. Reported loudly, does
 * not fail the build, and — like `KNOWN_DISCLOSED` in `secret-scan.mjs` — an
 * entry that no longer describes a real gap is itself a FAILURE. That is what
 * retires it: the day the referenced PR merges, this build goes red until
 * someone deletes the entry.
 *
 * This exists so a new gate can land without either duplicating another agent's
 * work or blocking on it. Writing this check found svc-academy independently;
 * `gh pr list` then found #442, which had already fixed it, verified better than
 * I could here — by running the shipped image with the secret withheld and
 * probing `createRoom` through svc-edge for a 403-on-perk rather than a
 * fail-closed 401. Making the same one-line edit on this branch would have
 * produced a merge conflict on a file that PR already touches, and claim-check
 * warns about exactly that.
 */
// Empty, and the story of how it emptied is the best evidence this gate is
// worth having.
//
// The one entry it ever held was svc-academy missing INTERNAL_SERVICE_SECRET,
// deferred to PR #442. #442 merged at 16:39 on 2026-08-03 and added the
// `*internal-secret` merge. The entry went stale, this gate FAILED on it, and
// the entry was deleted — the anti-rot rule working exactly as designed.
//
// Then, on the rebase, it failed AGAIN — and this time not on a stale excuse
// but on a live gap. #447 ("the console had two freeze paths") had branched
// before #442 landed, and its merge at 17:05 silently reverted that line: 26
// minutes of fix, undone by a PR about the admin console that never mentioned
// academy. Nothing caught it, because the failure mode is a container that is
// never created — no crash loop, no logs, nothing to notice. The line is
// restored in the same commit as this comment.
//
// That is the difference between a gate that proves and a gate that asserts. A
// human had already verified #442 by running the image; the fix still went away
// silently 26 minutes later. Only something that re-derives both sides on every
// run could have said so.
const FIXED_IN_OPEN_PR = [];
const excusedKey = (svc, missing) => `${svc}:${[...missing].sort().join(',')}`;
const EXCUSED = new Map(FIXED_IN_OPEN_PR.map((e) => [excusedKey(e.svc, e.missing), e]));

// ── 4 · compare ──────────────────────────────────────────────────────────────
const gaps = [];
const excused = [];
const notDeployed = [];
const seenExcuses = new Set();
for (const [svc, need] of required) {
  if (!supplied.has(svc)) {
    if (need.size > 0) notDeployed.push({ svc, need: [...need].sort() });
    continue;
  }
  const missing = [...need].filter((v) => !supplied.get(svc).has(v)).sort();
  if (missing.length === 0) continue;
  const k = excusedKey(svc, missing);
  const excuse = EXCUSED.get(k);
  if (excuse) {
    seenExcuses.add(k);
    excused.push({ svc, missing, ref: excuse.ref });
  } else {
    gaps.push({ svc, missing });
  }
}

const staleExcuses = FIXED_IN_OPEN_PR.filter((e) => !seenExcuses.has(excusedKey(e.svc, e.missing)));

if (excused.length > 0) {
  console.log(`\n⚠ ${excused.length} parity gap(s) already fixed on another branch — reported, not failing\n`);
  for (const e of excused) console.log(`  ${e.svc} — ${e.missing.join(', ')} → ${e.ref}`);
  console.log('');
}

if (staleExcuses.length > 0) {
  console.error(`\n✖ COMPOSE SECRET PARITY FAILED — ${staleExcuses.length} stale FIXED_IN_OPEN_PR entr(ies)\n`);
  for (const e of staleExcuses) {
    console.error(`  ${e.svc} — ${e.missing.join(', ')} (${e.ref})`);
    console.error('      no such gap exists any more. If that PR merged, delete this entry.\n');
  }
  process.exit(1);
}

/**
 * ── THE OTHER HALF OF THE SAME SILENCE ──────────────────────────────────────
 *
 * A service whose env.ts demands secrets and which has NO block in compose at
 * all is not "wired differently" — it is not deployed, and #442 is what that
 * looks like: `EnvError` at import, no container, therefore no restart loop and
 * no logs for anyone to read.
 *
 * This started life as a count on the green line. That was an assertion, not a
 * check: it made the condition visible to whoever happened to read the summary
 * and blocked nothing. Measured on the commit this became a failure, the count
 * is zero — all 17 services carrying required secrets have a compose block — so
 * hardening it costs nothing today and refuses the eighteenth that does not.
 *
 * If a service is deliberately not in this file (run only in CI, or deployed by
 * something else), the honest fix is to say so where someone will read it, not
 * to let the fleet definition and the service list disagree in silence.
 */
if (notDeployed.length > 0) {
  console.error(`\n✖ COMPOSE SECRET PARITY FAILED — ${notDeployed.length} service(s) require secrets and are in no ${COMPOSE} block\n`);
  for (const { svc, need } of notDeployed) {
    console.error(`  ${svc} — requires ${need.join(', ')} and has no compose service of that name`);
    console.error('      it is not misconfigured, it is not deployed: no container, no logs, no restart loop.\n');
  }
  console.error(`  Give it a block in ${COMPOSE}, or rename the mismatched one — a service list and a`);
  console.error('  fleet definition that disagree is exactly the silence #442 hid in.\n');
  process.exit(1);
}

if (gaps.length > 0) {
  console.error(`\n✖ COMPOSE SECRET PARITY FAILED — ${gaps.length} service(s) would crash-loop on their next container recreate\n`);
  for (const { svc, missing } of gaps) {
    console.error(`  ${svc} — declares but is never given: ${missing.join(', ')}`);
    for (const v of missing) {
      if (v === 'EDGE_PRINCIPAL_SECRET') console.error('      add `*edge-secret` to its `environment:` merge list');
      else if (v === 'INTERNAL_SERVICE_SECRET') console.error('      add `*internal-secret` to its `environment:` merge list');
      else console.error(`      add \`${v}: \${${v}:?missing — copy .env.example to .env}\` to its environment block`);
    }
    console.error('');
  }
  console.error('  A running container keeps the environment it started with, so this does NOT');
  console.error('  show up as a failure today — it shows up during the next deploy, or the next');
  console.error('  secret rotation, which is when nobody is looking for it. That is how #431');
  console.error(`  hid. Blast-radius map: docs/SECRET-ROTATION-READINESS-2026-08-03.md\n`);
  process.exit(1);
}

const checked = [...required.values()].reduce((n, s) => n + s.size, 0);

/**
 * A scan that walked nothing is a failure, not a pass — the house rule, and the
 * one this file would otherwise be most vulnerable to. Both halves are parsed
 * with regexes: if the per-service `env.ts` files stop matching, or the compose
 * file is reformatted past the indentation these patterns expect, the outcome
 * is zero requirements compared against zero suppliers and a green tick over
 * nothing. Refuse it here instead.
 */
if (required.size === 0 || supplied.size === 0 || checked === 0) {
  console.error('\n✖ COMPOSE SECRET PARITY FAILED — NOTHING WAS COMPARED.');
  console.error(`  ${required.size} service env schema(s), ${checked} required secret binding(s), ${supplied.size} compose service(s).`);
  console.error('  A zero on any of those means a parse stopped matching, not that the fleet is clean.');
  console.error(`  Check requiredSecretsIn() against the per-service env.ts, and the environment: parse against ${COMPOSE}.\n`);
  process.exit(1);
}

console.log(`✓ compose-secret-parity — ${checked} required secret binding(s) across ${supplied.size} compose service(s) wired`);
