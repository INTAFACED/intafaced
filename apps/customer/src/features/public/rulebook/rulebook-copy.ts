import { defineCopy } from '../../../shared/i18n';

// English source only. Every rule on the page is the owner's published text; nothing is filled in when none is.
export const rulebookCopy = defineCopy('public-rulebook', {
  title: 'Trading rulebook',
  lead: 'The rules this venue trades by: who may take part, how orders match and cancel, how trades settle, liquidation, fees and market data. Each version is fixed once published; a change is a new version.',
  version: 'Version',
  effective: 'In force since',
  published: 'Published',
  onThisPage: 'Sections',
  upcomingTitle: 'Published, not in force',
  upcomingLine: 'Version {version} takes effect on {at}.',
  historyTitle: 'Version history',
  historyEmpty: 'No version has been published.',
  statusCurrent: 'In force',
  statusUpcoming: 'Takes effect on {at}',
  statusSuperseded: 'Replaced',
  changed: 'Changed: {sections}',
  changedAll: 'First version: every section',
  supersedes: 'Replaces {version}',
  unpublishedTitle: 'No trading rulebook is published',
  unpublishedBody: 'The venue has not published its rules, so none are shown here. No text is made up in their place.',
  unreachableTitle: 'The rulebook did not load',
  unreachableBody: 'The service that publishes the rulebook did not answer. Nothing is shown rather than an old or made-up copy.',
  retry: 'Try again',
});
