// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
export const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
export const DAY = 86_400_000;
export const iso = (ms) => new Date(ms).toISOString();
/** A real-shaped UUID: prefix, then a counter. Fixture ids use this so the client's id checks pass. */
export const hex = (prefix, n) => {
  const id = `${prefix}${String(n).padStart(6, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // A wrong-length prefix makes an id the client's strict uuid parse refuses; fail loudly here instead of blanking a page.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    throw new Error(`stand-in minted an invalid uuid: ${id}`);
  return id;
};
/** The people on the team, named once: the Team page, the notifications and the activity feed all read these. */
export const TEAM = {
  finance: { userId: 'TEST-user-finance', memberId: 'a1111111-1111-4111-8111-111111111111', label: 'TEST Accounts' },
  developer: { userId: 'TEST-user-dev', memberId: 'a2222222-2222-4222-8222-222222222222', label: 'TEST Dev' },
  invited: { userId: 'TEST-user-pending', memberId: 'a3333333-3333-4333-8333-333333333333', label: 'TEST Viewer invite' },
};
/** Midnight UTC of the day `ms` falls in. "Days are UTC days" on the pages, so every day window starts here. */
export const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;
