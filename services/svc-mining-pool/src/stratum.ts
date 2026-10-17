import { resolveJob, type JobSource } from './job-source.js';

export type StratumRequest = { id: string | number | null; method: string; params: unknown[] };
export type Share = { minerId: string; worker: string; jobId: string; nonce: string; shareHash: string; target: string };

export type ShareRefuseReason = 'malformed' | 'job_not_found' | 'invalid_nonce' | 'low_difficulty' | 'mining.job_source_unconfigured';
export type ShareResult = { accepted: true } | { accepted: false; reason: ShareRefuseReason };

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
 * A share is accepted only when `source` knows the job id.
 * No source is `mining.job_source_unconfigured`. A source that does not know
 * the id is `job_not_found`. Nothing here credits a payout.
 * Caller shareHash and target are not the difficulty check.
 */
export function acceptShare(share: Share, source: JobSource | null = null): ShareResult {
  if (source === null) return { accepted: false, reason: 'mining.job_source_unconfigured' };
  if (!share.minerId || !share.worker || !share.jobId) return { accepted: false, reason: 'job_not_found' };
  if (!/^[0-9a-f]+$/i.test(share.nonce)) return { accepted: false, reason: 'invalid_nonce' };
  const job = resolveJob(source, share.jobId);
  if (!job.ok) return { accepted: false, reason: job.reason };
  return { accepted: true };
}
