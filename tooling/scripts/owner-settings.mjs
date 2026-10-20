#!/usr/bin/env node
/**
 * OWNER SETTINGS. One list of every value that is blank on purpose until the owner publishes it.
 *
 *   node tooling/scripts/owner-settings.mjs            write docs/OWNER-SETTINGS.md
 *   node tooling/scripts/owner-settings.mjs --check    exit 1 if docs/OWNER-SETTINGS.md is stale
 *   node tooling/scripts/owner-settings.mjs --json     print the same list as JSON
 *   node tooling/scripts/owner-settings.mjs --profile  print the TEST profile as shell exports (dev/test rigs only)
 *
 * Why: a blank price, limit, fee, timeout or provider setting refuses with a typed `<area>.<name>_unset`
 * code (AGENTS.md, product law). That is right, but the codes were spread over the code and no list showed
 * which setting makes a slice or journey refuse. This reads the code and builds the list.
 *
 * Sources (a text scan, nothing is run):
 *   1. `services/<name>/src/env.ts`: a setting is an owner setting when its own comment says "NO DEFAULT",
 *      "Never invent" or names an `*_unset` code. Its env name, comment and codes come from that block.
 *   2. Every other `'<area>.<name>_unset'` string in services, packages and apps: listed as a code with no env
 *      setting of its own. A code with `limit`, `window` or `page` in it is a page size the caller sends, not an
 *      owner value; the rest are owner values read from somewhere other than env.ts.
 *   3. `tooling/profiles/test-owner-values.json`: the labelled TEST values a test rig may load.
 *
 * The TEST profile is for the CX-8 rig and the local test stack only. Every value in it is labelled TEST in the
 * profile file, never a product default, and the loader refuses unless APP_ENV is dev or test. Real values are
 * set once by the owners before launch.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = join(ROOT, 'docs', 'OWNER-SETTINGS.md');
const PROFILE = join(ROOT, 'tooling', 'profiles', 'test-owner-values.json');

const CODE = /['"`]([a-z][a-z0-9_-]*\.[a-z0-9_.-]*_unset)['"`]/g;
const CODE_IN_TEXT = /\b([a-z][a-z0-9_-]*\.[a-z0-9_.-]*_unset)\b/g;
const OWNER_MARK = /NO DEFAULT|Never invent|_unset/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build']);

/** Which customer room a code's area blocks. Areas not listed show as the area name. */
const ROOM = {
  trade: 'Trade desk',
  matching: 'Trade desk',
  pay: 'Pay',
  bank: 'Money',
  identity: 'Account and verification',
  p2p: 'P2P',
  token: 'Token',
  academy: 'Academy',
  agents: 'Navigator',
  notify: 'Notifications',
  market: 'Markets',
  execution: 'Trade tools',
  quant: 'Trade tools',
  support: 'Support',
  tax: 'Tax',
  blueprint: 'Blueprint',
  mining: 'Mining',
  dex: 'DEX',
  protocol: 'Protocol',
  ops: 'Operations',
  edge: 'Edge',
  ledger: 'Ledger',
  ws: 'Live data',
};

/** The journeys in `apps/customer/tests/journeys` a code area can stop. */
const JOURNEY = {
  trade: 'trade-*',
  matching: 'trade-*',
  pay: 'trade-funding (withdraw)',
  bank: 'trade-wallet, trade-funding',
  identity: 'trade-onboarding',
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.(test|spec|journey|pw)\./.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Plain words for the first sentence of a comment block. */
function firstSentence(text) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*\/?\*+\/?\s?/, '').trim())
    .filter((l) => l !== '');
  const body = [];
  for (const l of lines) {
    if (/^NO DEFAULT/.test(l)) break;
    body.push(l);
    if (/[.:]$/.test(l)) break;
  }
  return body.join(' ').replace(/\s+/g, ' ').replace(/`/g, '').trim();
}

/** Owner settings in one env.ts: the env name, what it is, and the refusal codes its comment names. */
export function scanEnvFile(src, service) {
  const found = [];
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*\n\s*([A-Z][A-Z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(src))) {
    const [, comment, name] = m;
    if (!OWNER_MARK.test(comment)) continue;
    const codes = [...new Set([...comment.matchAll(CODE_IN_TEXT)].map((c) => c[1]))].sort();
    if (codes.length === 0 && /(_URL|_URI|_SECRET|_KEY|_TOKEN|_DSN|_PASSWORD|_HOST|_PORT)$/.test(name)) continue; // wiring, not an owner value
    found.push({ service, env: name, what: firstSentence(comment), codes });
  }
  return found;
}

/** Every `_unset` code string in non-test source: code -> sorted files. */
export function scanCodes(files) {
  const byCode = new Map();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(CODE)) {
      const set = byCode.get(m[1]) ?? new Set();
      set.add(relative(ROOT, f));
      byCode.set(m[1], set);
    }
  }
  return byCode;
}

const isPageSize = (code) => /(^|[._])(limit|window|page|cursor)([._]|$)/.test(code.replace(/_unset$/, ''));

export function loadProfile() {
  if (!existsSync(PROFILE)) return { label: '', values: {} };
  return JSON.parse(readFileSync(PROFILE, 'utf8'));
}

export function build() {
  const settings = [];
  for (const d of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    const envFile = join(ROOT, 'services', d.name, 'src', 'env.ts');
    if (d.isDirectory() && existsSync(envFile)) settings.push(...scanEnvFile(readFileSync(envFile, 'utf8'), d.name));
  }
  settings.sort((a, b) => (a.service + a.env).localeCompare(b.service + b.env));

  const files = ['services', 'packages', 'apps'].flatMap((d) => walk(join(ROOT, d)));
  const codeFiles = scanCodes(files);
  const covered = new Set(settings.flatMap((s) => s.codes));
  const loose = [...codeFiles.keys()]
    .filter((c) => !covered.has(c))
    .sort()
    .map((code) => ({ code, area: code.split('.')[0], pageSize: isPageSize(code), files: [...codeFiles.get(code)].sort() }));

  const profile = loadProfile();
  for (const s of settings) s.testValue = s.env in profile.values ? profile.values[s.env].value : null;
  return { settings, loose, profile, totalCodes: codeFiles.size };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const roomOf = (code) => ROOM[code.split('.')[0]] ?? code.split('.')[0];
const journeyOf = (code) => JOURNEY[code.split('.')[0]] ?? 'none yet';

export function renderRaw({ settings, loose, profile, totalCodes }) {
  const owner = loose.filter((l) => !l.pageSize);
  const pages = loose.filter((l) => l.pageSize);
  const out = [];
  out.push('# Owner settings');
  out.push('');
  out.push(
    '<!-- Generated by `node tooling/scripts/owner-settings.mjs`. Edit the code or `tooling/profiles/test-owner-values.json`, then rerun. -->',
  );
  out.push('');
  out.push(
    'Every value below is blank on purpose until the owners publish it. A blank one refuses with a typed `_unset` code and the room shows the refusal (AGENTS.md, product law). Nothing here is a product default. This file does not hold real values; it names what is missing.',
  );
  out.push('');
  out.push(
    `${settings.length} env settings, ${owner.length} owner values read elsewhere, ${pages.length} page sizes the caller sends. ${totalCodes} distinct \`_unset\` codes in all.`,
  );
  out.push('');
  out.push('## TEST profile');
  out.push('');
  out.push(
    `\`tooling/profiles/test-owner-values.json\` holds ${Object.keys(profile.values).length} values labelled **TEST**. A rig (CX-8, the local test stack) loads them so a fund, trade and withdraw journey runs. \`node tooling/scripts/owner-settings.mjs --profile\` prints them as exports and refuses unless \`APP_ENV\` is \`dev\` or \`test\`. They are never a product default and never reach a real environment.`,
  );
  out.push('');
  out.push('## Env settings');
  out.push('');
  out.push('| Service | Env name | What it is | Refusal code | Room | Journey it can stop | TEST value |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of settings) {
    const code = s.codes.length ? s.codes.map((c) => `\`${c}\``).join(', ') : '(none named)';
    const area = (s.codes[0] ?? `${s.service.replace(/^svc-/, '')}.x`).split('.')[0];
    const test = s.testValue === null ? 'none' : `\`${cell(s.testValue)}\` (TEST)`;
    out.push(
      `| ${s.service} | \`${s.env}\` | ${cell(s.what || '(no description)')} | ${code} | ${ROOM[area] ?? area} | ${JOURNEY[area] ?? 'none yet'} | ${test} |`,
    );
  }
  out.push('');
  out.push('## Owner values with no env setting of their own');
  out.push('');
  out.push('Read from a database row, a published record or a caller input. The first file is where the refusal is raised.');
  out.push('');
  out.push('| Refusal code | Room | Journey it can stop | Raised in |');
  out.push('| --- | --- | --- | --- |');
  for (const l of owner) out.push(`| \`${l.code}\` | ${roomOf(l.code)} | ${journeyOf(l.code)} | \`${l.files[0]}\` |`);
  out.push('');
  out.push('## Page sizes the caller sends');
  out.push('');
  out.push(
    'A list call refuses with one of these when the caller omits its page size or window. These are not owner values; the screen sends the size. They are listed so they are not mistaken for blocked slices.',
  );
  out.push('');
  out.push(pages.map((p) => `\`${p.code}\``).join(', '));
  out.push('');
  return out.join('\n');
}

/** The TEST values for one service, as env entries. Refuses outside dev and test, so a real environment cannot load them. */
export function profileEnvFor(service, appEnv = process.env.APP_ENV, profile = loadProfile()) {
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new Error(`The TEST owner profile loads only when APP_ENV is dev or test (APP_ENV=${appEnv ?? 'unset'}).`);
  }
  return Object.fromEntries(
    Object.entries(profile.values)
      .filter(([, v]) => v.service === service)
      .map(([k, v]) => [k, v.value]),
  );
}

/** The file text, in the repo's prettier format so the format check never disagrees with the freshness check. */
export async function render(data) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(OUTPUT)) ?? {};
  return prettier.format(renderRaw(data), { ...config, parser: 'markdown' });
}

/** Shell exports for the TEST profile. Refuses outside dev and test. */
export function profileExports(profile, appEnv = process.env.APP_ENV) {
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new Error(`The TEST owner profile loads only when APP_ENV is dev or test (APP_ENV=${appEnv ?? 'unset'}).`);
  }
  return Object.entries(profile.values)
    .map(([name, v]) => `export ${name}=${JSON.stringify(v.value)} # ${profile.label}`)
    .join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}

async function main() {
  const arg = process.argv[2];
  const data = build();
  if (arg === '--json') console.log(JSON.stringify(data, null, 2));
  else if (arg === '--profile') {
    try {
      console.log(profileExports(data.profile));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else if (arg === '--check') {
    const same = existsSync(OUTPUT) && readFileSync(OUTPUT, 'utf8') === (await render(data));
    if (!same) {
      console.error('docs/OWNER-SETTINGS.md is stale: run `node tooling/scripts/owner-settings.mjs`.');
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, await render(data));
    console.log(`wrote ${relative(ROOT, OUTPUT)}: ${data.settings.length} env settings, ${data.loose.length} other codes`);
  }
}
