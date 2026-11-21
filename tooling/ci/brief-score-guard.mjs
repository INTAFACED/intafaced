#!/usr/bin/env node
/**
 * A pull request that changes a judge's brief shows what the change does to its score (project-state#2972). The CI
 * review's REVIEW.md and the proof reader's READ.md have real cases beside them (brief-cases.mjs); a change to either
 * brief needs, in the body at the start of a line and outside code, the totals brief-cases printed for the brief
 * before the change and after it:
 *
 *   Brief-score: review old bad 2 of 12, controls 9 of 9
 *   Brief-score: review new bad 3 of 12, controls 9 of 9
 *
 * It checks that the lines are there and well formed, and that old and new count the same cases; it cannot check that
 * the numbers came from a real run. CI runs the default branch's copy from the `gates` job of ci.yml, so a pull request
 * cannot loosen the rule it is judged by. The body is read from the API when GH_TOKEN, REPO and PR_NUMBER are set (so
 * re-running the job reads an edited body), else from PR_BODY.
 *
 *   node tooling/ci/brief-score-guard.mjs [--base-ref origin/main]
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffBase } from './ci-affected.mjs';
import { linesOutsideCode } from './journey-seal.mjs';

export const BRIEF_PATHS = { review: 'tooling/ci/ci-review/REVIEW.md', read: 'tooling/ci/test-judge/READ.md' };
export const SCORE_LINE = /^Brief-score: (review|read) (old|new) bad (\d+(?:\.\d+)?) of (\d+), controls (\d+) of (\d+)$/;

/** The verdict for the files a pull request changes and its body: { ok, lines }. */
export function judge(changed, body) {
  const touched = Object.entries(BRIEF_PATHS).filter(([, p]) => changed.includes(p));
  if (!touched.length) return { ok: true, lines: [] };
  const got = new Map();
  for (const line of linesOutsideCode(body ?? '')) {
    const m = SCORE_LINE.exec(line.trimEnd());
    if (m) got.set(`${m[1]} ${m[2]}`, { badOf: Number(m[4]), controlsOf: Number(m[6]) });
  }
  const lines = [];
  for (const [judgeName, path] of touched) {
    const old = got.get(`${judgeName} old`);
    const now = got.get(`${judgeName} new`);
    if (!old || !now)
      lines.push(
        `${path} changed, but the body has no ${!old && !now ? 'old or new' : old ? 'new' : 'old'} score for it. Score both briefs (node tooling/ci/brief-cases.mjs ${judgeName} --brief <the brief on main> --label old, then --label new on yours) and copy the two Brief-score lines it prints into the body, at the start of a line and outside code, then re-run the Doctrine gates job.`,
      );
    else if (old.badOf !== now.badOf || old.controlsOf !== now.controlsOf)
      lines.push(
        `${path}: the old and new scores count different cases (bad of ${old.badOf} and ${now.badOf}, controls of ${old.controlsOf} and ${now.controlsOf}); score both briefs on the same cases.`,
      );
  }
  return { ok: lines.length === 0, lines };
}

async function bodyFromEnv() {
  const { GH_TOKEN, REPO, PR_NUMBER, PR_BODY } = process.env;
  if (!(GH_TOKEN && REPO && PR_NUMBER)) return PR_BODY ?? '';
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'brief-score-guard' },
  });
  // A refusal stops here; the guard fails closed rather than judge a body it could not read.
  if (!res.ok) throw new Error(`reading pull request ${PR_NUMBER}'s body: ${res.status} ${await res.text()}`);
  return (await res.json()).body ?? '';
}

async function main(argv) {
  const at = argv.indexOf('--base-ref');
  const ref = at === -1 ? 'origin/main' : argv[at + 1];
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const base = diffBase(git, ref);
  const changed = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  const touches = Object.values(BRIEF_PATHS).some((p) => changed.includes(p));
  const v = judge(changed, touches ? await bodyFromEnv() : '');
  for (const l of v.lines) console.error(`brief-score-guard: ${l}`);
  if (v.ok) console.log(`brief-score-guard: ok (${touches ? 'a brief changed and its scores are in the body' : 'no brief changed'})`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`brief-score-guard: ${e.message}`);
      process.exit(1);
    },
  );
}
