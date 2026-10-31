#!/usr/bin/env node
/**
 * GATE-FILE GUARD: a PR that changes the rules of merging must say so in its title.
 *
 * THE RULE (the same text goes into the PR comment):
 *
 *   A pull request fails this check if it changes a GATE FILE, unless its TITLE states that it is a gate change.
 *   Gate files are the files that decide what may merge: tooling/ci/** (every scan, plus the dependency-audit allowlist
 *   KNOWN in dependency-audit.mjs, the secret-scan allowlists in secret-scan.mjs, and the money-skip inventory in
 *   money-skip-inventory.mjs), .github/workflows/**, .gitleaks.toml, and the auto-revert / guard scripts
 *   themselves. A title states it when it:
 *     - starts with `ci:` or `gate:`      (a scope is fine: `ci(deps): ...`)
 *     - starts with `chore(ci)`           (any type works when the scope is ci or gate: `fix(ci): ...`, `test(gate): ...`)
 *     - contains `[gate-change]`          (anywhere, any case)
 *
 * WHY THIS EXISTS
 *
 * #4402 widened the dependency-audit allowlist inside a migration fix. The title said "fix the migration", the diff
 * quietly loosened a gate, and a reviewer reading the title had no reason to look. The rule changes nothing about WHO may
 * change a gate; it makes the change impossible to miss, in the title, and on the PR page.
 *
 * WHAT IT DOES NOT DO (read this before trusting it)
 *
 * It is a declaration check, not an access control. An agent can still write `ci:` on a PR that loosens a gate; the
 * point is that it now has to say so out loud, and the title is what a reviewer or the weekly audit reads. The workflow
 * (.github/workflows/gate-file-guard.yml) runs the copy of this script from the PR's BASE commit, so a PR cannot
 * weaken the rule inside the PR it is judged on.
 *
 * KNOWN LIMIT: a PR can still edit or delete the workflow file gate-file-guard.yml itself, and GitHub runs the PR's copy of
 * a workflow. That edit is a gate change, so the rule flags it in every other place that applies it. The backstop is
 * the independent review of the exact head, which the CI merge seal requires for every workflow and gate-file change,
 * and the full test run a gate-file PR always gets.
 *
 * There is no author exemption: anyone with write access can push to a bot's branch, so the author proves nothing. Dependabot's
 * commit-message prefixes in .github/dependabot.yml are `ci`/`ci(deps)`, so its PRs declare themselves like anyone's.
 *
 * Usage:
 *   node tooling/scripts/gate-file-guard.mjs --pr 4402 --title "fix(db): ..." [--repo owner/name] [--comment]
 *   node tooling/scripts/gate-file-guard.mjs --title "..." --files-file changed.txt      (offline)
 * Exit 0 = pass, 1 = undeclared gate change, 2 = usage or lookup error, 3 = GitHub refused (stop, no retry).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GitHubRefusalError, makeGh } from './gate-gh.mjs';

export const MARKER = '<!-- gate-file-guard -->';
export const DEFAULT_REPO = 'Phantom-X-007/intafaced';

/** [glob, why]. `**` crosses directories, `*` does not. */
export const GATE_PATHS = [
  ['tooling/ci/**', 'every CI scan, including the dependency-audit allowlist, the secret-scan allowlists and the money-skip inventory'],
  ['.github/workflows/**', 'the workflows that run the checks'],
  ['.github/dependabot.yml', 'what Dependabot may change, and under which PR title'],
  ['.github/CODEOWNERS', 'who must review what'],
  ['CODEOWNERS', 'who must review what'],
  ['docs/CODEOWNERS', 'who must review what'],
  ['.gitleaks.toml', 'the secret-scan (gitleaks) allowlist'],
  ['.gitleaksignore', 'the secret-scan (gitleaks) ignore list'],
  ['AGENTS.md', 'the rules every agent loads, including the merge rule'],
  ['CLAUDE.md', 'the rules every agent loads'],
  ['**/CLAUDE.md', 'the short rules a service, app or package loads for its own directory'],
  ['**/AGENTS.md', 'the nearest AGENTS.md to an edited file is the one agents follow there'],
  ['**/SKILL.md', 'agent skills, wherever they live'],
  ['tooling/agent-protocol/**', 'the agent protocol every agent loads'],
  ['.agents/**', 'agent skills and rules'],
  ['docs/agents/**', 'the build, review and brief guides AGENTS.md tells every agent to read'],
  ['.cursor/rules/**', 'agent rules'],
  ['.claude/**', 'the permissions, startup hook and subagents every agent session in this repo loads'],
  ['turbo.json', 'which tasks CI runs and how they depend on each other'],
  ['.prettierignore', 'which files the format check skips'],
  ['package.json', 'the root scripts CI and verify run'],
  ['tooling/scripts/main-auto-revert.mjs', 'the auto-revert of a red main'],
  ['tooling/scripts/main-auto-revert.test.mjs', 'the auto-revert tests'],
  ['tooling/scripts/gate-file-guard.mjs', 'this guard'],
  ['tooling/scripts/gate-file-guard.test.mjs', 'this guard tests'],
  ['tooling/scripts/gate-gh.mjs', 'the gh wrapper the gate tools share'],
  ['tooling/scripts/github-refusal.mjs', 'how the gate tools recognise a 403 or 429 and stop'],
  ['tooling/scripts/gate-tools.test.mjs', 'the gate tools test entry'],
  ['tooling/scripts/journey-freeze-guard.mjs', 'the journey harness guard: no journey leaks the platform posting freeze'],
  ['apps/customer/tests/real-app/journey.mjs', "every journey's test, wrapped by the posting-freeze guard"],
  ['tooling/scripts/tooling-tests.mjs', 'which tooling tests the Doctrine gates run'],
];

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const COMPILED = GATE_PATHS.map(([glob, why]) => ({ glob, why, re: globToRegExp(glob) }));

/** Which of `files` are gate files? Returns [{ file, glob, why }]. */
export function gateFilesTouched(files) {
  const hits = [];
  for (const file of files) {
    const m = COMPILED.find((p) => p.re.test(file));
    if (m) hits.push({ file, glob: m.glob, why: m.why });
  }
  return hits;
}

/** Does the PR title state that it is a gate change? */
export function titleStatesGateChange(title) {
  const t = String(title ?? '').trim();
  return /^(ci|gate)(\([^)]*\))?!?:/i.test(t) || /^[a-z]+\((ci|gate)\)!?:/i.test(t) || /\[gate-change\]/i.test(t);
}

/** @returns {{ ok: boolean, gateFiles: Array<{file:string,glob:string,why:string}>, declared: boolean }} */
export function evaluateGateFileRule(title, files) {
  const gateFiles = gateFilesTouched(files);
  const declared = titleStatesGateChange(title);
  return { ok: gateFiles.length === 0 || declared, gateFiles, declared };
}

export const RULE_TEXT =
  'A PR that changes a gate file (CI scans and their allowlists, workflows, the secret-scan config, the gate tools) ' +
  'must say so in its title: start it with `ci:`, `gate:` or `chore(ci):`, or include `[gate-change]`.';

export function renderComment(result) {
  const lines = result.gateFiles.slice(0, 30).map((g) => `- \`${g.file}\` (${g.why})`);
  const more = result.gateFiles.length > 30 ? `\n- ... and ${result.gateFiles.length - 30} more` : '';
  if (result.ok && result.gateFiles.length) {
    return `${MARKER}\n**Gate-file guard: OK, declared.** This PR changes gate files and its title says so.\n\n${lines.join('\n')}${more}\n`;
  }
  if (result.ok) return `${MARKER}\n**Gate-file guard: OK.** No gate files changed.\n`;
  return (
    `${MARKER}\n**Gate-file guard: FAIL.** This PR changes gate files, the files that decide what may merge, ` +
    `but its title does not say so.\n\n${lines.join('\n')}${more}\n\n` +
    `**Rule:** ${RULE_TEXT}\n\nFix: edit the PR title (this check re-runs on edit). If the change to a gate is not intended, remove it from the PR.\n`
  );
}

/** Create, update or leave alone the guard's own comment (found by its marker, so other comments are never touched). */
export function upsertComment(gh, repo, pr, body, { onlyIfExisting = false } = {}) {
  const comments = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`]).stdout).flat();
  const mine = comments.filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKER)).at(-1);
  if (mine) {
    if (mine.body.trim() !== body.trim()) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '-f', `body=${body}`]);
    return 'updated';
  }
  if (onlyIfExisting) return 'none';
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`]);
  return 'created';
}

export function listPrFiles(gh, repo, pr) {
  const out = gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename']).stdout;
  return out.split('\n').filter(Boolean);
}

function parseArgs(argv) {
  const o = { repo: DEFAULT_REPO, comment: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') o.pr = argv[++i];
    else if (a === '--title') o.title = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--files-file') o.filesFile = argv[++i];
    else if (a === '--comment') o.comment = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.title === undefined) throw new Error('--title is required');
  if (!o.filesFile && !/^\d+$/.test(o.pr ?? '')) throw new Error('--pr <number> (or --files-file) is required');
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`gate-file-guard: ${e.message}`);
    return 2;
  }
  try {
    const gh = makeGh();
    const files = o.filesFile ? readFileSync(o.filesFile, 'utf8').split('\n').filter(Boolean) : listPrFiles(gh, o.repo, o.pr);
    const result = evaluateGateFileRule(o.title, files);
    const body = renderComment(result);
    console.log(body.replace(MARKER, '').trim());
    if (o.comment && o.pr) {
      try {
        // Fork PRs get a read-only token: a failed comment must not hide the verdict.
        upsertComment(gh, o.repo, o.pr, body, { onlyIfExisting: result.ok });
      } catch (e) {
        // No retry, whatever the cause (a 403 here is the read-only fork token, not a reason to loop).
        console.error(`gate-file-guard: could not post the comment (${e.message}); the verdict stands.`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error(`gate-file-guard: ${e.message}`);
    return e instanceof GitHubRefusalError ? 3 : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
