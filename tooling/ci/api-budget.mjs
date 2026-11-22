/**
 * API BUDGET: GitHub's "the hourly budget is spent" told apart from every other refusal, so a check stopped by it reads
 * as "judge down", never as a red that is the change's own (project-state AGENTS.md, "How work flows" 7; row d25 and
 * lane 8 of project-state #2288, Nino 13 Nov: "all as recommended, go").
 *
 * Why: from 00:20 UTC on 13 Nov the repository's workflow token spent its 15,000 calls before each hour ended. The seal
 * printed "Named journey steps unreadable: GET /repos/INTAFACED/intafaced/pulls/8203: HTTP 403" (run 43358114181) and the
 * Gate-file guard only "exit code 3" (run 43358106834), so a builder could not tell a spent budget from its own red, and
 * why-red.mjs called both RED: fix what the lines name. Nothing in the change was wrong; a re-run after the reset passed.
 *
 * A primary limit says so: GitHub answers 403 or 429 with `x-ratelimit-remaining: 0` (REST), or `gh` prints "API rate
 * limit exceeded". A secondary limit, a missing permission or any other 403 is NOT this: it stays a refusal as before.
 * The check still fails closed, and only its words change, except in a step that allows a wait (resetWait).
 *
 * The wait: a step that sets API_BUDGET_WAIT_MIN (the merge seal's job, merge-seal.yml) waits for a reset at most that
 * many minutes away and asks once more, through github-fetch.mjs and journey-verdict.mjs's `gh` reads. The answer after
 * the wait is used as it is, so a budget still spent, or a reset further off, fails closed with the same words as before.
 * Why: run 44981346475's third attempt (#9601, 22 Nov 2026 04:11 UTC) failed on the budget 11 minutes before its reset,
 * and an agent had to re-run it.
 *
 * Its tests: tooling/ci/api-budget.test.mjs.
 */
import { execFileSync } from 'node:child_process';

/** The words every check uses for it, so why-red.mjs finds them in an annotation. */
export const BUDGET_MARK = "judge down: GitHub's hourly API budget is spent";
/** The annotation title a check stopped by it uses. */
export const BUDGET_TITLE = 'judge down: GitHub API budget';

const hhmm = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString().slice(11, 16) : null);

/** The sentence for a spent budget, with the reset when known. */
export function budgetLine(resetSec) {
  const at = hhmm(Number(resetSec));
  return `${BUDGET_MARK}${at ? ` until ${at} UTC` : ''}: nothing to fix in this change; re-run the failed jobs once after the reset, don't push for it`;
}

/** A fetch answer that is GitHub's primary rate limit: 403 or 429 with no calls remaining. */
export function isBudgetResponse(res) {
  if (!res || (res.status !== 403 && res.status !== 429)) return false;
  return String(res.headers?.get?.('x-ratelimit-remaining') ?? '') === '0';
}

/** `gh`'s (or any) text that names the primary rate limit, never a secondary limit. */
export function isBudgetText(text) {
  const s = String(text ?? '');
  return /API rate limit (?:already )?exceeded/i.test(s) && !/secondary rate limit/i.test(s);
}

/** The error message for a failed GET: as before, plus the budget sentence when that is why. */
export function httpMessage(path, res, detail = '') {
  const base = `GET ${path}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`;
  return isBudgetResponse(res) ? `${base}; ${budgetLine(res.headers.get('x-ratelimit-reset'))}` : base;
}

/** An annotation title: BUDGET_TITLE when the message says the budget was spent, else the caller's own. */
export const titleFor = (message, fallback) => (String(message ?? '').includes(BUDGET_MARK) ? BUDGET_TITLE : fallback);

/** The variable a step sets to wait for a spent budget's reset: the most minutes away it may be. Unset: no wait. */
export const WAIT_ENV = 'API_BUDGET_WAIT_MIN';
/** Past the reset GitHub names, so the next ask lands in the new hour. */
export const RESET_SLACK_MS = 5_000;

/** Milliseconds to wait for the reset at `resetSec` (epoch seconds), or null: no wait allowed here, no reset named, or it
 *  is more than `maxMin` minutes away. A reset already past waits only the slack. */
export function resetWait(resetSec, { now = Date.now(), maxMin = Number(process.env[WAIT_ENV]) } = {}) {
  const reset = Number(resetSec) * 1000;
  if (!(maxMin > 0) || !Number.isFinite(reset) || reset <= 0) return null;
  const left = Math.max(0, reset - now);
  return left <= maxMin * 60_000 ? left + RESET_SLACK_MS : null;
}

/** The line a step prints when it waits. */
export const waitLine = (ms, resetSec) => {
  const at = hhmm(Number(resetSec));
  return `${BUDGET_MARK}${at ? ` until ${at} UTC` : ''}: waiting ${Math.ceil(ms / 1000)}s for the reset, then asking once more`;
};

/** The core budget's reset (epoch seconds) as `gh` reads it: `gh api rate_limit` spends no call of the budget. */
export const ghReset = () =>
  Number(
    JSON.parse(execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))?.resources?.core?.reset,
  );

/** For a `gh` call that failed with `stderr`: { ms, reset } when its words name the spent budget and the wait is allowed
 *  (resetWait), else null. */
export function ghResetWait(stderr, { readReset = ghReset, ...opts } = {}) {
  if (!isBudgetText(stderr)) return null;
  let reset;
  try {
    reset = readReset();
  } catch {
    return null;
  }
  const ms = resetWait(reset, opts);
  return ms === null ? null : { ms, reset };
}
