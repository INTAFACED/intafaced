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
