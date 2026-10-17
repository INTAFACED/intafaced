// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
export const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
export const DAY = 86_400_000;
export const iso = (ms) => new Date(ms).toISOString();
/** A real-shaped UUID: prefix, then a counter. Fixture ids use this so the client's id checks pass. */
export const hex = (prefix, n) => `${prefix}${String(n).padStart(6, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
