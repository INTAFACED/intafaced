// The logic behind apps/customer/tests/real-app/clauses-v1.mjs: `clause()` and `expectRefusal()`, version 1.
//
// Frozen once a journey uses it: a proof read judges a step together with the helpers its test calls, so editing this
// file would change what every read of a step that uses it judged. Make a change in a new version (journey-clauses-v2.mjs
// and clauses-v2.mjs) and leave this one as it is. journey-clauses-v1.test.mjs pins both files' contents.
// No Playwright here, so `node --test` can run it.

/** A typed refusal code: `<area>.<reason>`, as the services send it (`academy.access_code_invalid`). */
export const TYPED_CODE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_]+)+$/;

/** Where a typed code sits in a refusal's body: tRPC's error cause first, then the plain shapes. */
export const CODE_PATHS = [
  ['error', 'data', 'cause', 'code'],
  ['error', 'cause', 'code'],
  ['error', 'data', 'code'],
  ['error', 'code'],
  ['cause', 'code'],
  ['code'],
];

/** A clause's title in the report: the words it proves, from the step's own words. */
export function clauseTitle(words) {
  if (typeof words !== 'string' || !words.trim()) throw new TypeError("clause: name the clause, in the step's own words");
  return `clause: ${words.trim()}`;
}

/** Every typed code the body carries, with where it was found. */
export function typedCodes(body) {
  const found = [];
  for (const path of CODE_PATHS) {
    let at = body;
    for (const key of path) at = at != null && typeof at === 'object' ? at[key] : undefined;
    if (typeof at === 'string' && TYPED_CODE.test(at)) found.push({ path: path.join('.'), code: at });
  }
  return found;
}

/** A Playwright APIResponse, a fetch Response, or `{ status, body }` already read: as `{ status, body }`. */
export async function readResponse(res) {
  if (res == null || typeof res !== 'object') throw new TypeError('expectRefusal: pass the response, or a function that sends the request');
  if (typeof res.status === 'function') return { status: res.status(), body: await res.json().catch(() => null) };
  if (typeof res.json === 'function' && typeof res.status === 'number')
    return { status: res.status, body: await res.json().catch(() => null) };
  return { status: res.status, body: res.body };
}

/** What the caller must name: the exact status and the exact typed code. Refuses a loose expectation. */
export function checkExpectation({ status, code } = {}) {
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new TypeError(`expectRefusal: name the exact refusal status (400 to 599), not ${status}`);
  if (typeof code !== 'string' || !TYPED_CODE.test(code))
    throw new TypeError(`expectRefusal: name the exact typed code (<area>.<reason>), not ${code}`);
}

/** Why `got` is not the refusal expected, one line each; empty when it is. */
export function refusalProblems(got, { status, code }) {
  const problems = [];
  if (got.status !== status) problems.push(`status ${got.status}, expected ${status}`);
  const codes = typedCodes(got.body);
  if (codes.length === 0) problems.push(`no typed code in the body: ${JSON.stringify(got.body)?.slice(0, 300)}`);
  else if (!codes.some((c) => c.code === code))
    problems.push(`code ${codes.map((c) => `${c.code} (at ${c.path})`).join(', ')}, expected ${code}`);
  return problems;
}
