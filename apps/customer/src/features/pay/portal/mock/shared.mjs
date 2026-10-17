// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
export const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
/** What a part's handler answers for a procedure it does not own, so the next part is asked. */
export const NOT_MINE = Symbol('not-mine');
export const DAY = 86_400_000;
export const iso = (ms) => new Date(ms).toISOString();

export const refuse = (route, status, code, message = code) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { message, data: { cause: { code } } } }) });
export const ok = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

/** A real-shaped UUID: prefix, then a counter. Fixture ids use this so the client's id checks pass. */
export const hex = (prefix, n) => `${prefix}${String(n).padStart(6, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function page(items, input) {
  const start = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('utf8')) : 0;
  const limit = input.limit ?? 25;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: slice, nextCursor: next };
}

/** What every package's mock shares: the scenario, the clock, and the one `state` object the tests read. */
export function mockContext(scenario, now, options = {}) {
  return {
    scenario,
    now,
    /** 'off' leaves merchant.myAccess unmounted, as on main today. Otherwise it answers for that person. */
    myAccess: options.myAccess ?? 'off',
    role: options.role ?? 'owner',
    state: {},
    activity: scenario === 'active' || scenario === 'halted',
    halted: scenario === 'halted',
  };
}
