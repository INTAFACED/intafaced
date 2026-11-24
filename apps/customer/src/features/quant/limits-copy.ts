import { defineCopy } from '../../shared/i18n';

// The developer limits page and the sandbox's refusals by plan limit (J-algo-dev-12, AL-limits-02). Values, names and
// the plan enter through parameters.
const en = {
  title: 'Limits',
  description: 'Every limit your runs meet, with its value as the sandbox applies it.',
  sandboxTitle: 'Sandbox limits for each run',
  sandboxIntro: 'Set by your plan. A run that reaches one ends with its log up to that point; with one not set, no run starts.',
  plan: 'Plan: {profile}',
  planUnset: 'No plan applies to this account, so no run starts.',
  limit: 'Limit',
  value: 'Value',
  notSet: 'not set',
  wall_clock_ms: 'Time per run',
  memory_bytes: 'Memory per run',
  output_bytes: 'Log output per run',
  maxOps: 'Steps per run (every plan)',
  maxSource: 'Code length (every plan)',
  seconds: '{n} seconds',
  oneSecond: '1 second',
  bytes: '{n} bytes',
  kb: '{n} KB',
  mb: '{n} MB',
  characters: '{n} characters',
  asOf: 'Read {at}.',
  openLimits: 'See your limits',
  refusedUnset: 'Nothing ran: the {limit} limit of your plan is not set, so no run starts.',
  refusedHit: 'The run ended: it reached the {limit} limit of your plan.',
} as const;

export const limitsCopy = defineCopy('quant.limits', en);
