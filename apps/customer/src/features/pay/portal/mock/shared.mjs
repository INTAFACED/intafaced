// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { buildWorld } from './world.mjs';
import { DAY, MERCHANT_ID, TEAM, USER_ID, hex, iso, startOfDay } from './ids.mjs';

export { DAY, MERCHANT_ID, TEAM, USER_ID, hex, iso, startOfDay };
/** What a part's handler answers for a procedure it does not own, so the next part is asked. */
export const NOT_MINE = Symbol('not-mine');

export const refuse = (route, status, code, message = code) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { message, data: { cause: { code } } } }) });
export const ok = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

export function page(items, input) {
  const start = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('utf8')) : 0;
  const limit = input.limit ?? 25;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: slice, nextCursor: next };
}

/** What every package's mock shares: the scenario, the clock, and the one `state` object the tests read. */
export function mockContext(scenario, now, options = {}) {
  const ctx = {
    scenario,
    now,
    /** 'off' leaves merchant.myAccess unmounted. Otherwise it answers for that person; owner is the default. */
    myAccess: options.myAccess ?? 'owner',
    role: options.role ?? 'owner',
    /** 'off' answers an email invite as switched off on this system; 'limited' as too many sent recently. */
    emailInvites: options.emailInvites ?? 'on',
    state: {},
    activity: scenario === 'active' || scenario === 'halted',
    halted: scenario === 'halted',
  };
  // One world for the whole stand-in: every page's figures are worked out from it (see world.mjs).
  ctx.world = buildWorld(ctx);
  ctx.state.world = ctx.world;
  return ctx;
}
