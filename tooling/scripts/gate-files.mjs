/**
 * GATE FILES: the files that decide what may merge (CI scans and their allowlists, workflows, the secret-scan config,
 * agent rule files, the gate tools). A pull request that changes one needs the CI review's PASS on its exact head:
 * review-marker.mjs reviewReason reads this list, and the CI merge seal (a required check) refuses the merge without that
 * PASS. The PR's title plays no part.
 *
 * Until 15 Nov 2026 a separate Gate-file guard workflow also failed a gate-file PR whose title did not start with `ci:`
 * or `gate:` (after #4402 widened the dependency-audit allowlist inside a migration fix). The CI review of every
 * gate-file head, required by the seal whatever the title says, came later and makes the change impossible to miss, so
 * the title check added a run on every title edit and a red fixed only by retitling, and went.
 */

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
  ['.node-version', 'the Node version every CI job runs'],
  ['tooling/scripts/main-auto-revert.mjs', 'the auto-revert of a red main'],
  ['tooling/scripts/main-auto-revert.test.mjs', 'the auto-revert tests'],
  ['tooling/scripts/gate-files.mjs', 'this list, which decides what needs the CI review'],
  ['tooling/scripts/gate-files.test.mjs', 'this list tests'],
  ['tooling/scripts/gate-gh.mjs', 'the gh wrapper the gate tools share'],
  ['tooling/scripts/github-refusal.mjs', 'how the gate tools recognise a 403 or 429 and stop'],
  ['tooling/scripts/gate-tools.test.mjs', 'the gate tools test entry'],
  ['tooling/scripts/journey-freeze-guard.mjs', 'the journey harness guard: no journey leaks the platform posting freeze'],
  ['apps/customer/tests/real-app/journey.mjs', "every journey's test, wrapped by the posting-freeze guard"],
  ['tooling/scripts/tooling-tests.mjs', 'which tooling tests the Doctrine gates run'],
  ['docs/runbooks/journey-baseline.json', "the steps the Real-app journeys run on main may fail, which decide that run's verdict"],
  ['docs/roadmap/journeys.json', 'the journey steps the journeys run, its verdict and the money rule read'],
  ['.oxlintrc.json', "the lint rules the lint ratchet judges every pull request by (it reads main's copy)"],
  ['tooling/lint/**', 'the garden lint plugin and the ratchet start dates the lint ratchet reads from main'],
  ['tooling/coverage-law-index.json', "the private law's structure, which decides coverage-check's chapter spans and blank-line refusals"],
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
