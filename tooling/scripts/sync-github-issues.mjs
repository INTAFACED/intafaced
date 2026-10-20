#!/usr/bin/env node
/**
 * Push the tracker into GitHub as milestones + issues.
 *
 *   node tooling/scripts/sync-github-issues.mjs [--dry-run]
 *
 * Why both a file AND issues:
 *   · `tooling/tracker/features.mjs` is the whole picture, validated against the code.
 *   · GitHub issues are for the subset you can start TODAY — somewhere to
 *     discuss, assign, and hang a PR off.
 *
 * Only `ready` features get issues. Creating one per blocked feature would
 * produce a backlog of 60+ things nobody can act on, which is exactly the noise
 * CONTRIBUTING §4 says to avoid.
 *
 * Idempotent: it matches on the `[id]` marker in the title, so re-running
 * updates rather than duplicating.
 */
import { execFileSync } from 'node:child_process';
import { throwOnGitHubRefusal } from './github-refusal.mjs';
import { FEATURES, PHASE_NAMES } from '../tracker/features.mjs';

const dryRun = process.argv.includes('--dry-run');
const REPO = 'Phantom-X-007/intafaced';

function gh(args, { allowFail = false, input } = {}) {
  if (dryRun && (args.includes('--method') || args[0] === 'issue')) {
    console.log(`  [dry-run] gh ${args.slice(0, 4).join(' ')}…`);
    return '{}';
  }
  try {
    return execFileSync('gh', args, { encoding: 'utf8', ...(input ? { input } : {}) }).trim();
  } catch (err) {
    throwOnGitHubRefusal(err);
    if (allowFail) return null;
    console.error(`\n✖ gh ${args.join(' ')}\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    process.exitCode = 1;
    return null;
  }
}

const byId = new Map(FEATURES.map((f) => [f.id, f]));
const isReady = (f) => f.status === 'ready' && f.dependsOn.every((d) => byId.get(d)?.status === 'done');

// ── Milestones, one per phase ───────────────────────────────────────────────

console.log('\n· milestones');
const existingMilestones = JSON.parse(gh(['api', `/repos/${REPO}/milestones?state=all&per_page=100`]) || '[]');
const milestoneByTitle = new Map(existingMilestones.map((m) => [m.title, m.number]));

const phasesInPlay = [...new Set(FEATURES.map((f) => f.phase))];
for (const phase of phasesInPlay) {
  const title = `Phase ${phase} — ${PHASE_NAMES[phase]}`;
  if (milestoneByTitle.has(title)) {
    console.log(`  · ${title} (exists)`);
    continue;
  }

  const total = FEATURES.filter((f) => f.phase === phase && f.status !== 'socket').length;
  const created = gh(
    [
      'api',
      '--method',
      'POST',
      `/repos/${REPO}/milestones`,
      '-f',
      `title=${title}`,
      '-f',
      `description=${total} shippable features. See tooling/tracker/features.mjs.`,
    ],
    { allowFail: true },
  );

  if (created) {
    milestoneByTitle.set(title, JSON.parse(created).number);
    console.log(`  ✓ ${title}`);
  }
}

// ── Issues, only for what is claimable ──────────────────────────────────────

console.log('\n· issues for ready features');
const existingIssues = JSON.parse(gh(['api', `/repos/${REPO}/issues?state=all&per_page=100`]) || '[]');
const issueByFeature = new Map();
for (const issue of existingIssues) {
  const match = /\[([a-z0-9.\-]+)\]$/.exec(issue.title);
  if (match) issueByFeature.set(match[1], issue.number);
}

const ready = FEATURES.filter(isReady);
let created = 0;

for (const feature of ready) {
  const title = `${feature.title} [${feature.id}]`;

  if (issueByFeature.has(feature.id)) {
    console.log(`  · ${feature.id} (issue #${issueByFeature.get(feature.id)})`);
    continue;
  }

  const body = [
    `**Module:** \`${feature.module}\` · **Phase:** ${feature.phase} · **Plane:** ${feature.plane}`,
    '',
    feature.note ? `> ${feature.note}\n` : '',
    '## Claiming this',
    '',
    'Say so in Telegram, then:',
    '',
    '```bash',
    `pnpm wt feat/${feature.id.replace(/\./g, '-')}`,
    '```',
    '',
    `In your first PR, set \`owner\` and \`status: 'wip'\` for \`${feature.id}\` in \`tooling/tracker/features.mjs\` and run \`pnpm tracker\`. That is what stops two people starting the same thing.`,
    '',
    '## Before you start',
    '',
    '- `INTAFACED_DEFINITIVE_BUILD.md` — the spec, including the doctrines (§0) that settle ambiguity',
    '- `tooling/agent-protocol/AGENT_PROTOCOL.md` — the hard prohibitions',
    '- `CONTRIBUTING.md` §2 — **work in a worktree, never the main checkout**',
    '',
    '## Done when',
    '',
    `- [ ] \`pnpm gate\` passes for the module`,
    '- [ ] Money paths (if any) have invariant tests and their failure branches covered',
    '- [ ] Migrations have a `.down.sql` reversal',
    `- [ ] \`${feature.id}\` marked \`done\` in the registry, with \`requires\` listing what it created`,
    '',
    '_Generated from `tooling/tracker/features.mjs`. Edit the registry, not this issue._',
  ].join('\n');

  const args = [
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    title,
    '--body',
    body,
    '--milestone',
    `Phase ${feature.phase} — ${PHASE_NAMES[feature.phase]}`,
  ];

  if (feature.module === 'ledger' || feature.module === 'token' || feature.module === 'pay') {
    args.push('--label', 'money-path');
  }
  if (feature.plane === 'P') args.push('--label', 'protocol-plane');
  if (feature.phase === '1') args.push('--label', 'core');

  const result = gh(args, { allowFail: true });
  if (result) {
    created++;
    console.log(`  ✓ ${feature.id}`);
  }
}

console.log(`\n✓ ${phasesInPlay.length} milestone(s), ${created} issue(s) created, ${ready.length} feature(s) ready\n`);
if (dryRun) console.log('  (dry run — nothing was written)\n');
