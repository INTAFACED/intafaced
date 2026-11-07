import { defineCopy } from '../../shared/i18n';

// The plan's usage view and its refusals (AL-limits-01, J-algo-dev-03 #6, #7 and #9). Counts, limits and names enter
// through parameters.
const en = {
  title: 'Usage and plan limits',
  intro: 'What this account holds, counted from what is stored, against the limits of its plan.',
  plan: 'Plan: {profile}',
  planAssigned: 'set for this account',
  planOf: 'from your plan, {plan}',
  planUnset: 'No quota profile applies to this account: its plan has none set, so a new strategy or run is refused.',
  resource: 'Resource',
  used: 'Used',
  limit: 'Limit',
  notSet: 'not set',
  usedOf: '{used} of {limit}',
  usedOfUnset: '{used} of not set',
  asOf: 'Counted at {at} UTC.',
  strategies: 'Saved strategies',
  versions: 'Versions on one strategy (the most)',
  concurrent_runs: 'Concurrent runs',
  paper_runs: 'Paper runs',
  runs: 'Stored runs',
  log_lines: 'Stored log lines',
  storage: 'Source and result storage (bytes)',
  collaborators: 'Collaborators per strategy',
  notifications: 'Notifications per day',
  refusedTitle: 'Refused by your plan',
  exceeded: 'Your plan allows {limit} {resource}: {used} used of {limit} allowed. Nothing was added.',
  unset: "Your plan's limit for {resource} is not set, so nothing of that kind can be added. Nothing was added.",
  profileUnset: 'No quota profile applies to this account: its plan has none set. Nothing was added.',
  refusedUsage: 'See the usage view on Strategies.',
} as const;

export const usageCopy = defineCopy('quant.usage', en);
