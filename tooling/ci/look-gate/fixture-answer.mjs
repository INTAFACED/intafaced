/**
 * How the look gate answers a Customer room's service calls for the TEST account in
 * apps/customer/tests/real-app/look-fixtures.mjs. Kept apart from look-gate.mjs so a script can import it without
 * starting the gate.
 */
import * as world from '../../../apps/customer/tests/real-app/look-fixtures.mjs';
import { trpc as result } from '../../../apps/customer/src/screens/money/money.fixtures.mjs';

/** A fixture run with Date.now() at `now`, the page's frozen time, so a shot never depends on when the gate ran. */
function atFrozen(now, fn, arg) {
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn(arg);
  } finally {
    Date.now = real;
  }
}

/**
 * What the TEST account (look-fixtures.mjs) answers for one service call: `{ status, json }`, or null when it has no
 * fixture for it (the gate then refuses it). `signedIn` false leaves `auth.refresh` unanswered, so the room is signed out.
 */
export function fixtureAnswer(href, method, body, { signedIn, now }) {
  try {
    return answer(href, method, body, signedIn, now);
  } catch {
    // A malformed escape or input is a call the account has no fixture for: refused, never left hanging.
    return null;
  }
}

function answer(href, method, body, signedIn, now) {
  const { pathname, searchParams } = new URL(href);
  const trpc = pathname.match(/^\/api\/([a-z0-9-]+)\/trpc\/(.+)$/);
  if (trpc) {
    const [, module, procedure] = trpc.map(decodeURIComponent);
    if (procedure === 'auth.refresh') return module === 'identity' && signedIn ? { status: 200, json: result(world.session(now)) } : null;
    const key = procedure === 'workItems.list' ? procedure : `${module}:${procedure}`;
    const fn = Object.hasOwn(world.TRPC, key) ? world.TRPC[key] : null;
    if (!fn) return null;
    const input = method === 'GET' ? JSON.parse(searchParams.get('input') ?? 'null') : JSON.parse(body || 'null');
    return { status: 200, json: result(atFrozen(now, fn, input ?? undefined)) };
  }
  const rest = pathname.match(/^\/api\/v1\/(.+)$/);
  // Only reads: an order placed or cancelled has no fixture, so it is refused.
  if (!rest || method !== 'GET') return null;
  const path = rest[1];
  if (path.startsWith('ohlcv/')) return { status: 200, json: atFrozen(now, world.REST['ohlcv/*'], decodeURIComponent(path.slice(6))) };
  const fn = Object.hasOwn(world.REST, path) ? world.REST[path] : null;
  return fn ? { status: 200, json: atFrozen(now, fn) } : null;
}
