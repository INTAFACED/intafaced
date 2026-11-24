// What GitHub said when it refused a request (403 or 429), for the stop line a script prints and the issue it opens.
// A refusal is still a stop, never retried (AGENTS.md); this only keeps GitHub's own reason, so a person can tell a
// secondary rate limit from a missing permission. Twice the stop line read only "GitHub 403 on GET …" (#8197, #8202).

/** " (GitHub: <message>; rate limit remaining N, resets <ISO>; retry-after Ns; request <id>)", or "" with nothing to say. */
export function refusalDetail(headers, text) {
  const parts = [];
  let message = '';
  try {
    message = JSON.parse(text)?.message ?? '';
  } catch {
    message = text ?? '';
  }
  message = String(message).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (message) parts.push(`GitHub: ${message}`);
  const h = (k) => headers?.get?.(k) ?? null;
  const remaining = h('x-ratelimit-remaining');
  const reset = Number(h('x-ratelimit-reset'));
  if (remaining !== null) {
    parts.push(
      `rate limit remaining ${remaining}${Number.isFinite(reset) && reset > 0 ? `, resets ${new Date(reset * 1000).toISOString()}` : ''}`,
    );
  }
  if (h('retry-after') !== null) parts.push(`retry-after ${h('retry-after')}s`);
  if (h('x-github-request-id') !== null) parts.push(`request ${h('x-github-request-id')}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/**
 * When a refusal is only the spent hourly budget (x-ratelimit-remaining 0 with a reset time), the reset as an ISO time;
 * otherwise null. A spent budget is a wait for its reset, not a refusal to read: the stop still holds (never retried in
 * the same run), but a later run after the reset tries again from scratch, so it needs no issue. A secondary limit or a
 * missing permission keeps remaining above 0 (or no header) and stays a refusal. Three issues in eight days were one
 * spent budget that came back by itself (#8197, #8202, #9093; #9093 named it: "rate limit remaining 0").
 */
export function budgetSpentUntil(status, headers) {
  if (status !== 403 && status !== 429) return null;
  const h = (k) => headers?.get?.(k) ?? null;
  const reset = Number(h('x-ratelimit-reset'));
  if (h('x-ratelimit-remaining') !== '0' || !Number.isFinite(reset) || reset <= 0) return null;
  return new Date(reset * 1000).toISOString();
}
