/**
 * The TEST age door (packages/service-kit test-age.ts): makes one of a service's own TEST records older, as if it had
 * been made earlier, so a step sees its expiry or window pass without waiting the time out. No clock moves: every
 * service keeps the real time, and only that record's own times move back together.
 */
let stack;
const stackCtx = () =>
  (stack ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} })));

/** Ages `subject` `id` on `service` by `ms`, through its signed door; anything but a 200 fails the step with the answer. */
export async function ageRecord(service, subject, id, ms) {
  const ctx = await stackCtx();
  const raw = JSON.stringify({ subject, id, ms });
  const res = await fetch(`${ctx.url(service)}/internal/test/age`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  if (res.status !== 200)
    throw new Error(`${service} TEST age door refused ${subject} ${id}: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/** Ages `subject` `id` until `deadline` (an ISO time) is a second behind it, as a wait past that deadline would have. */
export function agePast(service, subject, id, deadline) {
  return ageRecord(service, subject, id, Math.max(1, Date.parse(deadline) - Date.now() + 1_000));
}
