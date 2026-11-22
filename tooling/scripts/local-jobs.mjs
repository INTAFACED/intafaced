// How many jobs one local check may run at once, from the one setting a shared machine sets: INTAFACED_LOCAL_JOBS.
//
// Unset (CI, one person's machine), every tool keeps its own default and runs as fast as the machine allows. Set, it
// bounds every vitest run, which otherwise sizes itself to the whole machine, so builders sharing one box don't each take
// all of it (project-state#3420: three memory fills on 20 Nov): its maxWorkers, through the shared TEST_BUDGET that
// every package spreads, and the Customer app's config. (It bounded the pre-push typecheck and rust:check too until
// 22 Nov, when both moved to CI only.)
// turbo.json passes it through to the tasks turbo starts.
const LOCAL_JOBS = 'INTAFACED_LOCAL_JOBS';

/** The bound, a whole number of at least 1, or null when unset. Anything else throws, naming the setting. */
export function localJobs(env = process.env) {
  const raw = env[LOCAL_JOBS];
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9]\d*$/u.test(raw))
    throw new Error(`${LOCAL_JOBS} must be a whole number of at least 1, or unset; it is ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** vitest's part of the bound: `{ maxWorkers }` when set, else nothing (vitest's own default). */
export function localWorkers(env = process.env) {
  const jobs = localJobs(env);
  return jobs === null ? {} : { maxWorkers: jobs };
}
