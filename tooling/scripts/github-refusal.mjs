/** Return true only for an explicit HTTP 403 or 429 refusal from gh. */
export function isGitHubRefusal(error) {
  const status = error?.statusCode ?? error?.httpStatus ?? error?.response?.status;
  if (status === 403 || status === 429) return true;
  // execFileSync's message includes command arguments, which can mention HTTP statuses.
  const stderr = error?.stderr?.toString().trim();
  const text = stderr || [error?.stdout, error?.message].filter(Boolean).join('\n');
  return /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:403|429)\b|\b403\s+Forbidden\b|\b429\s+Too Many Requests\b/i.test(text);
}

/** Do not let a best-effort caller turn a GitHub refusal into an empty result. */
export function throwOnGitHubRefusal(error) {
  if (!isGitHubRefusal(error)) return;
  const text = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n').trim();
  const status = error?.statusCode ?? error?.httpStatus ?? error?.response?.status;
  throw new Error(`GitHub refused the request${status ? ` (HTTP ${status})` : ''}; stop GitHub activity. ${text}`, { cause: error });
}
