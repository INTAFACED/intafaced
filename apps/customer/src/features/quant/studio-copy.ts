import { defineCopy } from '../../shared/i18n';

// Studio saving and the strategy library (J-algo-dev-01 #4). Versions and names enter through parameters.
const en = {
  save: 'Save to library',
  saving: 'Saving',
  releaseNote: 'Release note for this version (optional)',
  releaseNoteHint: 'Say what changed. It is kept with the version and shown in its history.',
  savedAs: 'Saved as version {version}.',
  changedSince: 'Changed since version {version}. Save to keep these rules as the next version.',
  notSaved: 'Unsaved. Saving keeps the rules in your library on this account.',
  incomplete: 'Fill in a name, the starting cash, every block or signal rule input, and the three risk limits to save.',
  newStrategy: 'Start a new strategy',
  libraryTitle: 'Your strategy library',
  libraryNone: 'No strategy is saved yet.',
  libraryNoneBody: 'Save the rules on the left and they appear here.',
  showMore: 'Show more strategies',
  replaceWarning: 'The rules in the form are not saved. Press again to replace them.',
  open: 'Open {name}',
  opened: 'Open in the form',
  version: 'Version {version}',
  name: 'Name',
  versionHeading: 'Version',
  actions: 'Actions',
} as const;

export const studioCopy = defineCopy('quant.studio', en);
