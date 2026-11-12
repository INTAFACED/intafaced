import { defineCopy } from '../../shared/i18n';

// The plan tiers on Strategies (RC-algo-dev-05, J-algo-dev-03 #8). Names, values and counts enter through parameters.
const en = {
  title: 'Plan tiers',
  intro:
    'What each published tier changes: how fresh the data a run reads is, its execution priority and its limits. A tier is a name, not a price.',
  empty: 'No plan tier is published yet, so there is no other plan to choose.',
  changes: 'What it changes',
  freshness: 'Data freshness',
  freshnessValue: '{seconds} seconds behind the exchange',
  freshnessLive: 'As the exchange publishes it',
  priority: 'Execution priority class',
  priorityValue: 'Class {value} (a higher class starts first)',
  notSet: 'not set',
  yours: '{profile} (your plan)',
  choose: 'Choose {profile}',
  choiceTitle: '{profile} against your plan, {current}',
  choiceNoPlan: '{profile} against no plan: the default plan is not set',
  choiceRow: '{what}: {from} now, {to} on this tier',
  choiceSame: 'Nothing changes: this tier holds the same values as your plan.',
  choiceIsYours: 'This is your plan.',
  move: 'Moving to a tier is not open on this page: an operator assigns the plan. Runs do not read the freshness or priority class yet, so every run starts in arrival order.',
} as const;

export const tierCopy = defineCopy('quant.tiers', en);
