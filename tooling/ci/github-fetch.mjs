/**
 * The one way a tooling/ci script calls the GitHub API (project-state#3160).
 *
 * `githubFetch(url, init)` has fetch's shape and returns a real Response. With a token (GH_TOKEN or GITHUB_TOKEN set, as
 * every CI job does, or a token in the caller's authorization header) it is plain fetch with the caller's headers. On a
 * person's machine, with none, it reads through the logged-in `gh` CLI (`gh api -i`), which signs in itself: nobody puts
 * a token on a command line to run a script by hand. Method, accept and body pass through; the empty authorization
 * header (`Bearer undefined`, a caller's `githubToken()` with no token) is dropped.
 */
import { execFile } from 'node:child_process';
import { BUDGET_TITLE, isBudgetResponse, resetWait, waitLine } from './api-budget.mjs';

const API = 'https://api.github.com/';

/** True when this process holds a token of its own (CI); false when calls go through `gh`. */
export const hasToken = () => Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

/** The token for a fetch in CI, or undefined on a person's machine (githubFetch then uses `gh`). */
export const githubToken = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;

/** The token in a request's authorization header, or null when it names none. */
function tokenOf(headers = {}) {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const t = /^(?:Bearer|token)\s+(\S+)$/i.exec(String(auth ?? ''))?.[1];
  return t && t !== 'undefined' && t !== 'null' ? t : null;
}

/**
 * One call. When GitHub answers that the hourly budget is spent and the step allows a wait (api-budget.mjs resetWait,
 * API_BUDGET_WAIT_MIN), it waits for the reset and asks once more; that answer is returned as it is, so a caller still
 * fails closed on a budget that stays spent or a reset too far off.
 */
export async function githubFetch(url, init = {}, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const res = await fetchOnce(url, init);
  if (!isBudgetResponse(res)) return res;
  const reset = res.headers.get('x-ratelimit-reset');
  const ms = resetWait(reset, { now: now() });
  if (ms === null) return res;
  console.log(`::notice title=${BUDGET_TITLE}::${waitLine(ms, reset)}`);
  await sleep(ms);
  return fetchOnce(url, init);
}

async function fetchOnce(url, init) {
  if (hasToken() || tokenOf(init.headers)) return fetch(url, init);
  const href = String(url);
  if (!href.startsWith(API)) throw new Error(`githubFetch: ${href} is not a GitHub API address`);
  const method = (init.method ?? 'GET').toUpperCase();
  const args = ['api', '-i', '-X', method, href.slice(API.length)];
  for (const [k, v] of Object.entries(init.headers ?? {})) if (k.toLowerCase() !== 'authorization') args.push('-H', `${k}: ${v}`);
  if (init.body != null) args.push('--input', '-');
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile('gh', args, { encoding: 'buffer', maxBuffer: 1 << 30 }, (err, out) => {
      // gh exits non-zero on an HTTP error but still prints the response; only a missing response is a failure here.
      if (err && !out?.length) reject(new Error(`githubFetch: could not run gh (${err.message.split('\n')[0]})`));
      else resolve(out);
    });
    if (init.body != null) child.stdin.end(String(init.body));
    else child.stdin.end();
  });
  return parseIncluded(stdout);
}

/** `gh api -i` output (status line, headers, a blank line, the body) as a Response. Exported for its test. */
export function parseIncluded(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  const [end, gap] = crlf >= 0 && (lf < 0 || crlf < lf) ? [crlf, 4] : [lf, 2];
  const head = (end >= 0 ? buf.subarray(0, end) : buf).toString('utf8').split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head[0] ?? '')?.[1]);
  if (!status) throw new Error(`githubFetch: gh printed no HTTP status (${(head[0] ?? '').slice(0, 80)})`);
  const headers = new Headers();
  for (const line of head.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const body = end >= 0 ? buf.subarray(end + gap) : Buffer.alloc(0);
  return new Response([204, 304].includes(status) ? null : body, { status, headers });
}
