import { defineCopy } from '../../shared/i18n';

// English source only. The Lab lists only what the owner has published; nothing is shown in its place.
export const labCopy = defineCopy('public-lab', {
  title: 'Lab',
  lead: 'Short entries the owner chooses to point at: rooms of the app that are not in the main navigation.',
  noneTitle: 'No Lab entry is published',
  noneBody: 'What the Lab holds is the owner’s decision, and it has not been made. No entry is shown, and none is made up.',
  publishAction: 'Publishing Lab entries',
  detailTitle: 'This Lab entry is not published',
  detailBody: 'No Lab entry with this reference exists.',
  back: 'Back to the Lab',
  elsewhereTitle: 'Looking for something else?',
  elsewhereBody: 'Every room of the app is listed on the home page. Questions go to the help centre.',
  home: 'See what is inside',
  help: 'Open the help centre',
});
