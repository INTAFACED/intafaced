export type StratumRequest = { id: string | number | null; method: string; params: unknown[] };
export type Share = { minerId: string; worker: string; jobId: string; nonce: string; shareHash: string; target: string };
export type ShareResult =
  { accepted: true } | { accepted: false; reason: 'malformed' | 'job_not_found' | 'invalid_nonce' | 'low_difficulty' };

export function parseRequest(input: string): StratumRequest {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('stratum_malformed');
  }
  if (!value || typeof value !== 'object') throw new Error('stratum_malformed');
  const v = value as Record<string, unknown>;
  if ((typeof v.id !== 'string' && typeof v.id !== 'number' && v.id !== null) || typeof v.method !== 'string' || !Array.isArray(v.params)) {
    throw new Error('stratum_malformed');
  }
  return { id: v.id, method: v.method, params: v.params };
}

/**
 * No stratum job store exists in this service. A share is job_not_found until
 * a real job is supplied by one. Caller shareHash and target are not the difficulty check.
 */
export function acceptShare(share: Share): ShareResult {
  if (!share.minerId || !share.worker || !share.jobId) return { accepted: false, reason: 'job_not_found' };
  if (!/^[0-9a-f]+$/i.test(share.nonce)) return { accepted: false, reason: 'invalid_nonce' };
  return { accepted: false, reason: 'job_not_found' };
}
