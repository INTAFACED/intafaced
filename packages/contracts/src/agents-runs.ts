/**
 * A SESSION'S BACKGROUND RUNS (AG-sessions-04, AG-control-01; J-agents-06): what svc-agents `run.background.*` answer.
 * Browser-safe: zod only. A run goes on without the page, one metered engine call per step; costs are decimal strings,
 * never a `number`.
 */

import { z } from 'zod';

export const SESSION_RUN_STATES = ['queued', 'running', 'paused', 'completed', 'stopped', 'failed'] as const;
export type SessionRunState = (typeof SESSION_RUN_STATES)[number];
/** The out-of-app channel the person asks to be told on when the run finishes; `inapp` is the inbox row alone. */
export const RUN_NOTICES = ['inapp', 'email', 'sms', 'push'] as const;
export type RunNotice = (typeof RUN_NOTICES)[number];
export const STEP_STATES = ['in_flight', 'done', 'done_after_stop', 'refused'] as const;

export const sessionRunStepSchema = z.object({
  n: z.number().int(),
  state: z.enum(STEP_STATES),
  /** The engine's reply once the step's call returned; null while in flight or refused. */
  reply: z.string().nullable(),
  /** The step's metered cost as a decimal string, once its call returned. */
  cost: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const stopResultSchema = z.object({
  stoppedAt: z.string(),
  /** What the session's open windows settled for, in total, as a decimal string. */
  billed: z.string(),
  assetId: z.string(),
  settlements: z.array(z.object({ windowId: z.string(), amount: z.string(), chargeKey: z.string(), settled: z.boolean() })),
  /** `agents.window_unpaid` when a window could not be paid: it stays sealed and unpaid, and the session open. */
  unpaid: z.string().nullable(),
});
export type StopResult = z.infer<typeof stopResultSchema>;

export const sessionRunSchema = z.object({
  runId: z.string().guid(),
  sessionId: z.string().guid(),
  agentId: z.string(),
  task: z.string(),
  ask: z.string(),
  followUps: z.array(z.string()),
  notice: z.enum(RUN_NOTICES),
  state: z.enum(SESSION_RUN_STATES),
  stepsTotal: z.number().int(),
  /** The typed code the run failed on. */
  failureCode: z.string().nullable(),
  resumedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The last stored reply: the run's result once it completed. */
  reply: z.string().nullable(),
  steps: z.array(sessionRunStepSchema),
  stop: stopResultSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionRun = z.infer<typeof sessionRunSchema>;

/** `run.background.stop`: the run, and whether this was a second press answered with the first stop's result. */
export const sessionRunStopSchema = z.object({ run: sessionRunSchema, repeated: z.boolean() });
