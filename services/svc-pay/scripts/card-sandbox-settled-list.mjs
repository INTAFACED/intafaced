/**
 * Settled means this payment id is in the settled payment.list.
 * Status captured is not settled. No network.
 */
export function paymentIsSettled(listed, paymentId) {
  if (!Array.isArray(listed)) return false;
  return listed.some((entry) => entry != null && entry.id === paymentId);
}
