#!/usr/bin/env node
/**
 * Optional, owner-only GitHub configuration. Agents do not run this tool.
 * Review the current settings and intended changes before running it.
 *
 *   node tooling/scripts/setup-github.mjs
 *
 * Writes repository settings; it can replace an owner's later configuration.
 * Requires `gh auth login` with admin rights on the repository.
 */
import { execFileSync } from 'node:child_process';
import { throwOnGitHubRefusal } from './github-refusal.mjs';

/** Status contexts required on main before a PR can merge. */
const REQUIRED_CHECKS = ['Gitleaks', 'Dependency audit', 'Doctrine gates'];

function gh(args, { allowFail = false, input } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', ...(input ? { input } : {}) }).trim();
  } catch (err) {
    throwOnGitHubRefusal(err);
    if (allowFail) return null;
    console.error(`\n✖ gh ${args.join(' ')}\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    process.exit(1);
  }
}

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
console.log(`\nConfiguring ${repo}\n`);

// ── Branch protection on main ───────────────────────────────────────────────
//
// Targets the current merge policy, zero human approvals, no up-to-date
// requirement, and no direct pushes — for everyone, admins included.
const protection = {
  required_status_checks: { strict: false, contexts: REQUIRED_CHECKS },
  enforce_admins: true,
  required_pull_request_reviews: {
    required_approving_review_count: 0,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true,
};

console.log('· branch protection on main');
const result = gh(
  ['api', '--method', 'PUT', `/repos/${repo}/branches/main/protection`, '--input', '-', '-H', 'Accept: application/vnd.github+json'],
  { allowFail: true, input: JSON.stringify(protection) },
);

if (result === null) {
  // Branch protection needs a paid plan on private repos in some tiers.
  console.log('  ⚠ could not set branch protection automatically.');
  console.log('    Private repos need GitHub Pro/Team for protected branches.');
  console.log('    Set it by hand: Settings → Branches → Add rule → main');
  console.log('      · Require a pull request before merging (0 approvals)');
  console.log('      · Require status checks to pass — ' + REQUIRED_CHECKS.join(', '));
  console.log('      · Do not allow bypassing the above settings');
} else {
  console.log('  ✓ 0 approvals · Gitleaks + Dependency audit + Doctrine gates · no up-to-date requirement · admins included');
}

// ── Merge behaviour ─────────────────────────────────────────────────────────
//
// Squash only, so main reads as one commit per change rather than a transcript
// of someone's afternoon. Merged branches are kept (never auto-deleted) and auto-merge stays off:
// agents merge by hand after the gate.
console.log('· merge settings');
gh([
  'api',
  '--method',
  'PATCH',
  `/repos/${repo}`,
  '-f',
  'allow_squash_merge=true',
  '-F',
  'allow_merge_commit=false',
  '-F',
  'allow_rebase_merge=false',
  '-F',
  'delete_branch_on_merge=false',
  '-F',
  'allow_auto_merge=false',
  '-f',
  'squash_merge_commit_title=PR_TITLE',
  '-f',
  'squash_merge_commit_message=PR_BODY',
]);
console.log('  ✓ squash-only · merged branches kept · auto-merge off');

// ── Labels ──────────────────────────────────────────────────────────────────
const labels = [
  ['money-path', 'B60205', 'Touches the ledger, orders, or payments — review every line'],
  ['doctrine', '5319E7', 'Changes the rules themselves'],
  ['blocked-main', 'D93F0B', 'Informational main failures; fix affected regressions without freezing unrelated work'],
  ['core', '0E8A16', 'Phase 1 — identity, ledger, token'],
  ['protocol-plane', '1D76DB', 'Non-custodial side — custody-scan applies'],
];

console.log('· labels');
for (const [name, color, description] of labels) {
  gh(
    ['api', '--method', 'POST', `/repos/${repo}/labels`, '-f', `name=${name}`, '-f', `color=${color}`, '-f', `description=${description}`],
    {
      allowFail: true,
    },
  );
}
console.log(`  ✓ ${labels.map(([n]) => n).join(', ')}`);

console.log(`
✓ Done.

  Next:
    gh repo edit ${repo} --add-collaborator <their-github-handle>
    Update .github/CODEOWNERS with real handles

  Then send them CONTRIBUTING.md. The worktree rule (§2) is the one that matters.
`);
