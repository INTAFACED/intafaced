/**
 * Why a reviewer call failed, in the log (U4, INTAFACED/project-state#1574). The CI review and the proof reader send the
 * reviewer CLI's output to an answer file that nothing printed, so when every call exited 1 from about 04:39 UTC on
 * 10 Nov no run could say why: a limit, a refused key or a bad flag all looked the same. On a failed call this prints
 * the exit code and the answer's own error fields (`subtype`, `is_error`, `api_error_status`, the `result` text, at most
 * 300 characters, and only when it reads as an error: other text could be the model's answer, which may repeat the
 * prompt's private step words), from a `--output-format json` file or the `result` line of a `stream-json` one. It reads only the
 * answer file, never the environment, and masks anything shaped like an Anthropic key, so no secret reaches the log.
 *
 *   node tooling/ci/reviewer-error.mjs <answer file> <exit code>
 */
import { existsSync, readFileSync } from 'node:fs';
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

/** One line for the log. */
export function explain(text, code) {
  const a = answerOf(text);
  const head = `the reviewer CLI exited ${code}`;
  if (!a) {
    const raw = clean(text ?? '');
    return raw ? `${head}; its output, not JSON: ${raw}` : `${head} and wrote no answer`;
  }
  const parts = ['subtype', 'is_error', 'api_error_status']
    .filter((k) => a[k] !== undefined && a[k] !== null)
    .map((k) => `${k}=${clean(JSON.stringify(a[k]))}`);
  if (typeof a.result === 'string' && a.result)
    parts.push(errorText(a) ? `result: ${clean(a.result)}` : `result: ${a.result.length} characters, not printed`);
  return parts.length ? `${head}; ${parts.join('; ')}` : `${head}; the answer carries no error fields`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, code = '?'] = process.argv.slice(2);
  const text = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  console.log(`::error::${explain(text, code)}`);
}
