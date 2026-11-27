/**
 * How many GitHub API calls this process made, printed once when it exits (project-state#3718).
 *
 * Why: every job in this repository spends one shared hourly API budget (the workflow token's 15,000 calls), and on
 * 22 Nov it ran out three times. A job's own before/after read of the budget can't say who spent it, since the other
 * jobs running beside it spend from the same budget meanwhile. So each GitHub reader in tooling/ci calls countCall once
 * per request, and the step's log ends with one line on stderr naming the script and its own count:
 *
 *   GitHub API calls by tooling/ci/journey-seal.mjs --recheck: 17 (budget remaining 9120 at the last answer)
 *
 * A line per step, summed by script across an hour's job logs, is the table that names the top spender.
 * `gh api rate_limit` costs nothing and is never counted. Its tests: tooling/ci/api-count.test.mjs.
 */

const state = { calls: 0, remaining: null, armed: false };

/** The line this process prints at exit, or null when it made no call. Pure; exported for its test. */
export function countLine({ calls, remaining }, argv = process.argv) {
  if (!calls) return null;
  const script = String(argv[1] ?? 'node').replace(/^.*?(?=tooling\/)/, '');
  // The mode words (`--recheck`, `judge`, `down "CI review"`), never a path or a long value.
  const args = argv
    .slice(2)
    .filter((a) => a.length <= 40 && !a.includes('/'))
    .slice(0, 4)
    .join(' ');
  const left = remaining === null ? '' : ` (budget remaining ${remaining} at the last answer)`;
  return `GitHub API calls by ${script}${args ? ` ${args}` : ''}: ${calls}${left}`;
}

/**
 * One GitHub API request made. `res`, when there is one, is the Response; its x-ratelimit-remaining is kept. The first
 * call arms the one exit line.
 */
export function countCall(res) {
  state.calls++;
  const left = res?.headers?.get?.('x-ratelimit-remaining');
  if (left != null && left !== '') state.remaining = Number(left);
  if (state.armed) return;
  state.armed = true;
  process.on('exit', () => {
    const line = countLine(state);
    // stderr, never stdout: a step that captures a script's stdout as data (journey-touch.mjs --json in
    // real-app-journeys.yml) reads it unchanged; the job log shows both.
    if (line) process.stderr.write(`${line}\n`);
  });
}

/** This process's count so far (for tests). */
export const counted = () => ({ ...state });

/**
 * What a GitHub read that got no answer says: the path it asked (no query, which can carry a branch name) and the network's
 * own reason, which `fetch` hides under `cause` and prints only as "fetch failed" (intafaced #10910's CI review, twice).
 */
export function fetchFailure(path, e) {
  const cause = e?.cause;
  const why = [cause?.code, cause?.message ?? (e?.name === 'TimeoutError' ? 'no answer in 60 s' : null)].filter(Boolean).join(' ');
  return `${e?.message ?? 'fetch failed'} on GET ${String(path).split('?')[0]}${why ? `: ${why}` : ''}`;
}
