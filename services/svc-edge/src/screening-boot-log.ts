import type { ScreeningStatus } from '@intafaced/config';

/** The two logger levels the boot line uses; Fastify's `app.log` satisfies it. */
export interface ScreeningBootLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * The screening control's boot line: whether it is configured, in which state,
 * with how many regions, and whether a source was supplied.
 *
 * KEY NAMES, PRESENCE AND COUNTS ONLY. The region list and the source are the
 * values of the `INTAFACED_SANCTIONS_REGIONS` and
 * `INTAFACED_SANCTIONS_LIST_SOURCE` secrets. Edge's log is printed into public
 * CI job logs (the journeys workflow's stack-log step, the local stack's exit
 * tail), and GitHub masks a secret only when it prints verbatim, so a re-joined
 * list prints unmasked. `screening.summary` is value-free for the same reason.
 *
 * `configured` alone does not identify the state: a reviewed-and-deliberately-
 * empty list is `configured: true` with a count of zero, which reads exactly
 * like a short list. `declaration` and `moneyGrade` are state names, never
 * configuration content.
 */
export function logScreeningAtBoot(log: ScreeningBootLogger, appEnv: string, screening: ScreeningStatus): void {
  log[screening.configured ? 'info' : 'warn'](
    {
      appEnv,
      configured: screening.configured,
      declaration: screening.declaration,
      moneyGrade: screening.moneyGrade,
      blocked: screening.blockedRegions.length,
      sourceSet: screening.sourceSet,
    },
    screening.summary,
  );
}
