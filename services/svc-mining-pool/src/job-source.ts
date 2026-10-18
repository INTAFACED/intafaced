/**
 * Lookup of a stratum job by id.
 *
 * No production adapter is built. A real upstream node is a partner rail the
 * lead has to provide. Tests pass an in-memory source. A missing source is
 * `mining.job_source_unconfigured`, not `job_not_found`.
 */
export interface MiningJob {
  readonly id: string;
}

export interface JobSource {
  findJob(jobId: string): MiningJob | null;
}

export function memoryJobSource(ids: readonly string[]): JobSource {
  const known = new Set(ids);
  return {
    findJob(jobId: string) {
      if (!known.has(jobId)) return null;
      return { id: jobId };
    },
  };
}

export type JobLookup =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly reason: 'mining.job_source_unconfigured' | 'job_not_found' };

export function resolveJob(source: JobSource | null, jobId: string): JobLookup {
  if (source === null) return { ok: false, reason: 'mining.job_source_unconfigured' };
  const job = source.findJob(jobId);
  if (!job || job.id !== jobId) return { ok: false, reason: 'job_not_found' };
  return { ok: true, jobId: job.id };
}
