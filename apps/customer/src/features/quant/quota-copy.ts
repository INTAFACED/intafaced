import { defineCopy } from '../../shared/i18n';

// The Usage panel and quota refusals (AL-limits-01, J-algo-dev-03 #7, #9). Profile names and counts enter through parameters.
const en = {
  title: 'Usage',
  intro: 'What this account holds against its quota profile. Every limit is set by INTAFACED; a limit not set refuses.',
  profile: 'Quota profile: {profile}',
  noProfile: 'No quota profile is set for this account, so new strategies and runs are refused.',
  resource: 'Resource',
  used: 'Used',
  limit: 'Limit',
  notSet: 'Not set',
  strategies: 'Saved strategies',
  versions_per_strategy: 'Versions of one strategy (the most of any one)',
  concurrent_runs: 'Runs in progress',
  paper_runs: 'Paper runs',
  stored_runs: 'Stored runs',
  log_lines: 'Stored log lines',
  storage_bytes: 'Stored source and results (bytes)',
  collaborators_per_strategy: 'Collaborators on one strategy',
  notifications_per_day: 'Notifications today',
  exceeded: '{resource}: {used} used of {limit} allowed by quota profile {profile}. Nothing was created.',
  exceededNeeds: '{resource}: {used} used of {limit} allowed by quota profile {profile}, and this needs {needs} more. Nothing was created.',
  limitUnset: '{resource}: the limit in quota profile {profile} is not set, so nothing was created.',
  profileUnset: 'This account has no quota profile and none is set by default, so nothing was created.',
} as const;

export const quotaCopy = defineCopy('quant.quota', en);
