#!/usr/bin/env node
/**
 * Which TLA+ models a change is checked against (.github/workflows/model-check.yml, #8645).
 *
 * The models are found, never listed: every tracked `*.tla` file must sit in `services/<service>/model/` beside an
 * executable `check.sh`, or the plan fails naming it. A change is checked when it touches a service that has a model,
 * a file under `services/` that a model's COVERS.md names (the OneHold model covers svc-matching's book), the workflow
 * or this script. A checked change runs every model in the repo, not only the touched one.
 *
 *   node tooling/ci/model-check.mjs plan < changed-paths.txt   one path per line; prints the plan as JSON
 *   node tooling/ci/model-check.mjs plan --all                 every model, whatever changed
 *
 * With GITHUB_OUTPUT set, it also writes `run` (true or false) and `models` (a JSON list for the job matrix).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF = ['.github/workflows/model-check.yml', 'tooling/ci/model-check.mjs'];
const MODEL_FILE = /^(services\/[^/]+)\/model\/([^/]+)\.tla$/;
const NAMED_PATH = /services\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;

/** The repo's tracked files, relative to root. */
export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/**
 * Every model in the tracked files: { name, service, dir, check }, one per `model/` folder (a folder's several `.tla`
 * files are one model, run by its one check.sh). `errors` names each `.tla` that no check.sh would run.
 */
export function findModels(root, files = trackedFiles(root)) {
  const tracked = new Set(files);
  const byDir = new Map();
  const errors = [];
  for (const f of files.filter((p) => p.endsWith('.tla')).sort()) {
    const m = f.match(MODEL_FILE);
    if (!m) {
      errors.push(`${f} is a model outside services/<service>/model/, so no run checks it`);
      continue;
    }
    const dir = `${m[1]}/model`;
    const check = `${dir}/check.sh`;
    if (!tracked.has(check)) {
      errors.push(`${f} has no ${check} to run it`);
      continue;
    }
    if (!(statSync(join(root, check)).mode & 0o111)) {
      errors.push(`${check} is not executable`);
      continue;
    }
    if (!byDir.has(dir)) byDir.set(dir, { name: m[2], service: m[1], dir, check });
    else byDir.get(dir).name += `+${m[2]}`;
  }
  return { models: [...byDir.values()], errors };
}

/** The tracked paths under `services/` that a model's COVERS.md names, outside the model's own service. */
export function namedPaths(root, model, tracked) {
  let text = '';
  try {
    text = readFileSync(join(root, model.dir, 'COVERS.md'), 'utf8');
  } catch {
    return [];
  }
  const out = new Set();
  for (const p of text.match(NAMED_PATH) ?? []) {
    const path = p.replace(/[.]+$/, '');
    if (!path.startsWith(`${model.service}/`) && tracked.has(path)) out.add(path);
  }
  return [...out].sort();
}

/** Why each changed path calls for the model check; empty when none does. */
export function hits(changed, models, named) {
  const out = [];
  for (const path of changed) {
    if (SELF.includes(path)) out.push(`${path}: the check itself`);
    for (const m of models) {
      if (path.startsWith(`${m.service}/`)) out.push(`${path}: ${m.service} has the ${m.name} model`);
      if (named.get(m.dir)?.includes(path)) out.push(`${path}: ${m.dir}/COVERS.md names it`);
    }
  }
  return out;
}

/** The plan: { run, models, reasons, errors }. `all` runs every model whatever changed. */
export function plan(root, changed, { all = false, files } = {}) {
  const list = files ?? trackedFiles(root);
  const tracked = new Set(list);
  const { models, errors } = findModels(root, list);
  const named = new Map(models.map((m) => [m.dir, namedPaths(root, m, tracked)]));
  const reasons = all ? ['every model was asked for'] : hits(changed, models, named);
  return { run: errors.length === 0 && reasons.length > 0 && models.length > 0, models, reasons, errors };
}

function main(argv) {
  if (argv[0] !== 'plan') {
    console.error('usage: node tooling/ci/model-check.mjs plan [--all] < changed-paths.txt');
    return 2;
  }
  const all = argv.includes('--all');
  const changed = all
    ? []
    : readFileSync(0, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
  const p = plan(process.cwd(), changed, { all });
  for (const e of p.errors) console.log(`::error::${e}`);
  console.log(`${p.models.length} model(s): ${p.models.map((m) => `${m.name} (${m.dir})`).join(', ') || 'none'}`);
  if (!all) console.log(`${changed.length} changed path(s)`);
  if (p.reasons.length) for (const r of p.reasons.slice(0, 20)) console.log(`checked because ${r}`);
  else console.log('no changed path touches a modelled service: nothing to check');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${p.run}\nmodels=${JSON.stringify(p.models)}\n`);
  if (p.errors.length) return 1;
  if (!p.models.length) {
    console.log('::error::no model found: the plan would check nothing');
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
