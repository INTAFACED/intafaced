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
 * Nothing here retries or waits; the check still fails closed, and only its words change.
 *
 * Its tests: tooling/ci/api-budget.test.mjs.
 */

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
