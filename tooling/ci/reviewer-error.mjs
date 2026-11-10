/**
 * Why a reviewer call failed, in the log (U4, INTAFACED/project-state#1574). The CI review and the proof reader send the
 * reviewer CLI's output to an answer file that nothing printed, so when every call exited 1 from about 04:39 UTC on
 * 10 Nov no run could say why: a limit, a refused key or a bad flag all looked the same. On a failed call this prints
 * the exit code and the answer's own error fields (`subtype`, `is_error`, `api_error_status`, the `result` text, at most
 * 300 characters, and only when it reads as an error: other text could be the model's answer, which may repeat the
 * prompt's private step words), from a `--output-format json` file or the `result` line of a `stream-json` one. It reads only the
 * answer file and the CLI's stderr beside it (`<answer file>.stderr`, which the workflow writes and never prints raw),
 * never the environment; of stderr it prints only the first line that reads as an error, and it masks anything shaped
 * like a reviewer key (`sk-ant-…`), so no secret reaches the log.
 *
 * It also tells an outage from a verdict (classify; project-state OWNER 289 point 11: "A judge that stops shows as
 * 'judge down', with the one action it needs, never as red PRs. No PR merges without its judge."): `down` when the call
 * failed for a reason that is not the change (a refused, invalid, expired or used-up key, or a usage limit, when the API
 * sent a status or the CLI's stderr says so; a rate limit or an overload; a network error or timeout), else `error`: an
 * empty answer is `down` only when stderr names a network, key or limit failure, so a CLI crash on the change's own input
 * stays red. (Failure it prevents: from about 04:39 UTC on 10 Nov
 * every review failed on the account's weekly limit, so every open PR showed a red check that woke a builder who could
 * do nothing.) A down call prints a warning, not an error, since its job ends without a verdict and without failing.
 *
 *   node tooling/ci/reviewer-error.mjs <answer file> <exit code>            the one log line
 *   node tooling/ci/reviewer-error.mjs <answer file> <exit code> --outputs  the line, and kind, action, line and sign_in
 *                                                                           appended to $GITHUB_OUTPUT
 *   node tooling/ci/reviewer-error.mjs <answer file> <exit code> --kind     only `down` or `error`
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX = 300;
const KEY = /sk-ant-[A-Za-z0-9_-]+/g;

/** The answer object a failed call left: the one JSON object, or a stream's last `result` line; null when none. */
export function answerOf(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    const one = JSON.parse(t);
    if (one && typeof one === 'object' && !Array.isArray(one)) return one;
  } catch {
    /* a stream: one object per line */
  }
  let last = null;
  for (const line of t.split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'result') last = o;
    } catch {
      /* not a JSON line */
    }
  }
  return last;
}

// The result text is printed only when it reads as the CLI's or the API's own error. Any other text could be the
// model's answer, and the prompt holds private step words that a public log must never repeat.
const ERROR_TEXT =
  /api error|limit|rate|overloaded|auth|credential|token|log ?in|invalid|expired|unauthori[sz]ed|forbidden|quota|credit|model|permission|network|timed? ?out|connect/i;
const errorText = (a) => (a.api_error_status != null || ERROR_TEXT.test(a.result)) && a.result.length <= MAX;

const clean = (s) => String(s).replace(KEY, 'sk-ant-***').replace(/\s+/g, ' ').trim().slice(0, MAX);

/** The first line of the CLI's stderr that reads as an error (ERROR_TEXT, or an outage's words), at most MAX characters; '' when none. */
export const errLineOf = (err) =>
  String(err ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && [ERROR_TEXT, AUTH, USED_UP, BUSY, NETWORK].some((re) => re.test(l)))
    ?.slice(0, MAX) ?? '';

/** One line for the log. */
export function explain(text, code, err = '') {
  const a = answerOf(text);
  const e = errLineOf(err);
  const tail = e ? `; stderr: ${clean(e)}` : '';
  const head = `the reviewer CLI exited ${code}`;
  if (!a) {
    const raw = clean(text ?? '');
    return (raw ? `${head}; its output, not JSON: ${raw}` : `${head} and wrote no answer`) + tail;
  }
  const parts = ['subtype', 'is_error', 'api_error_status']
    .filter((k) => a[k] !== undefined && a[k] !== null)
    .map((k) => `${k}=${clean(JSON.stringify(a[k]))}`);
  if (typeof a.result === 'string' && a.result)
    parts.push(errorText(a) ? `result: ${clean(a.result)}` : `result: ${a.result.length} characters, not printed`);
  return (parts.length ? `${head}; ${parts.join('; ')}` : `${head}; the answer carries no error fields`) + tail;
}

// What reads as an outage, never as the change. Matched only against the API's or the CLI's own error (errorText,
// below), never against what the model answered, so a review that quotes these words is not read as one.
const AUTH = /invalid (api |bearer )?key|authenticat|unauthori[sz]ed|oauth|expired|revoked|log ?in|credential|forbidden/i;
const USED_UP = /credit balance|quota|usage limit|(weekly|monthly|daily|session) limit|hit your .{0,20}limit|out of (extra )?usage/i;
const OVERLOAD = /overloaded|internal server error|service unavailable|bad gateway|gateway time/i;
// A limit's words count only from the API's status or stderr (classify): never from a result the model could shape.
const BUSY = new RegExp(`${OVERLOAD.source}|rate.?limit|too many requests`, 'i');
const NETWORK =
  /network|ECONN\w*|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|timeout|connection (error|refused|reset|closed)|fetch failed/i;
const DOWN_STATUS = { 401: 'key', 403: 'key', 408: 'busy', 429: 'limit', 500: 'busy', 502: 'busy', 503: 'busy', 504: 'busy', 529: 'busy' };

export const SIGN_IN_ACTION = 'sign-in or key renewal: a new CLAUDE_CODE_OAUTH_TOKEN in the ci-review environment';
export const RETRY_ACTION = 'none, retried on the next push';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The reset time a limit answer states (`resets Nov 14, 10am (UTC)`), in Bali time (WITA, UTC+8) with the answer's own
 * words after it; the words alone when they name no UTC time this can read; null when it states none.
 */
export function resetOf(result, now = new Date()) {
  const m = /resets?\s+(?:at\s+)?([^·|\n]{1,40}?)\s*(?:\((UTC)\)|$|[.·|])/i.exec(String(result ?? ''));
  if (!m) return null;
  const said = m[1].trim().replace(/[,.]$/, '');
  const t = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(said);
  if (!m[2] || !t) return said;
  const hour = (Number(t[3]) % 12) + (t[5].toLowerCase() === 'pm' ? 12 : 0);
  const month = t[1] ? MONTHS.indexOf(t[1].toLowerCase()) : now.getUTCMonth();
  if (month < 0) return said;
  const day = t[2] ? Number(t[2]) : now.getUTCDate();
  let at = Date.UTC(now.getUTCFullYear(), month, day, hour, Number(t[4] ?? 0));
  if (at < now.getTime() - 2 * 86_400_000) at = Date.UTC(now.getUTCFullYear() + 1, month, day, hour, Number(t[4] ?? 0));
  const bali = new Date(at + 8 * 3_600_000);
  const hm = `${String(bali.getUTCHours()).padStart(2, '0')}:${String(bali.getUTCMinutes()).padStart(2, '0')}`;
  const mon = MONTHS[bali.getUTCMonth()];
  return `${mon[0].toUpperCase()}${mon.slice(1)} ${bali.getUTCDate()}, ${hm} Bali time (${said} UTC)`;
}

/**
 * Whether a failed call is an outage (`down`) or not (`error`), with the one action an outage needs: a sign-in or key
 * renewal for a refused or used-up key (`signIn`), the wait for a reset the answer states, else nothing (the next push
 * asks again). `error` keeps today's red: a malformed answer, a bad flag or anything else may be the change's own.
 */
export function classify(text, code, now = new Date(), err = '') {
  const down = (cause, action, signIn = false) => ({ kind: 'down', cause, action, signIn });
  // The CLI's own stderr: what the model answers never goes there, so its words are evidence a PR's text can't plant.
  const e = errLineOf(err);
  const fromErr = () => {
    if (USED_UP.test(e)) {
      const reset = resetOf(e, now);
      return reset ? down('a usage limit', `wait for the reset at ${reset}`) : down('a used-up key', SIGN_IN_ACTION, true);
    }
    if (AUTH.test(e)) return down('a refused key', SIGN_IN_ACTION, true);
    if (BUSY.test(e)) return down('a limit or an overload', RETRY_ACTION);
    if (NETWORK.test(e)) return down('a network error', RETRY_ACTION);
    return null;
  };
  const a = answerOf(text);
  if (!a) {
    const raw = String(text ?? '').trim();
    // No answer is an outage only when stderr says which: a crash on the change's own input stays red.
    if (!raw) return fromErr() ?? { kind: 'error', cause: 'no answer, and nothing on stderr that names an outage' };
    if (NETWORK.test(raw.slice(0, MAX))) return down('a network error', RETRY_ACTION);
    return fromErr() ?? { kind: 'error', cause: 'output that is not an answer' };
  }
  const result = typeof a.result === 'string' ? a.result : '';
  const sent = a.api_error_status != null;
  const status = DOWN_STATUS[Number(a.api_error_status)];
  // Only the API's or the CLI's own error text is read: a status the API sent, or a short error result. A used-up or
  // refused key, or a usage limit, also needs the API's status (or stderr, below): a short error result alone could be
  // shaped by the model, and those classes must never be read from the change's own text.
  const own = sent || (a.is_error === true && !/^error_max/.test(String(a.subtype ?? '')) && errorText(a));
  const words = own ? result : '';
  const reset = sent ? resetOf(result, now) : null;
  if (sent && (USED_UP.test(words) || (status === 'limit' && reset)))
    return reset ? down('a usage limit', `wait for the reset at ${reset}`) : down('a used-up key', SIGN_IN_ACTION, true);
  if (status === 'key' || (sent && !status && AUTH.test(words))) return down('a refused key', SIGN_IN_ACTION, true);
  if (status === 'limit' || status === 'busy') return down('a limit or an overload', RETRY_ACTION);
  // A well-formed answer that isn't an error is the review's own: stderr never turns it into an outage.
  const errDown = a.is_error === true ? fromErr() : null;
  if (errDown) return errDown;
  if (OVERLOAD.test(words)) return down('a limit or an overload', RETRY_ACTION);
  if (NETWORK.test(words)) return down('a network error', RETRY_ACTION);
  return { kind: 'error', cause: 'an answer that is not an outage' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, code = '?', flag] = process.argv.slice(2);
  const read = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : '');
  const text = read(file);
  const err = file ? read(`${file}.stderr`) : '';
  const c = classify(text, code, new Date(), err);
  if (flag === '--kind') console.log(c.kind);
  else {
    const line = explain(text, code, err);
    console.log(c.kind === 'down' ? `::warning::judge down (${c.cause}): ${line}. One action: ${c.action}` : `::error::${line}`);
    if (flag === '--outputs' && process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `kind=${c.kind}\naction=${c.action ?? ''}\nline=${line}\nsign_in=${c.signIn === true}\n`);
  }
}
