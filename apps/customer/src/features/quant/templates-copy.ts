import { defineCopy } from '../../shared/i18n';

// Starter templates in Studio (J-algo-dev-01 #2) and their read-only source (J-algo-dev-03 #4). Names, versions and notes enter through parameters.
const en = {
  title: 'Starter templates',
  intro:
    'A template fills in the shape of a strategy. Every number stays blank for you to set, and a template makes no claim about returns.',
  none: 'No template is published.',
  noneBody: 'Templates are published by the INTAFACED team. You can build the rules yourself on the left.',
  name: 'Template',
  about: 'What it does',
  versionHeading: 'Version',
  note: 'Release note',
  actions: 'Actions',
  version: 'Version {version}',
  use: 'Use {name}',
  using: 'Reading the template',
  used: '{name} version {version} is in the form as a new draft. Fill in every number before you save.',
  showMore: 'Show more templates',
  viewSource: 'View the source of {name}',
  sourceTitle: 'Source of {name}',
  versionPick: 'Version to read',
  readOnly:
    'Read only: a template is never edited here. Every number is a named blank you fill in after Use, and Use takes the newest version, version {version}.',
  closeSource: 'Close the source',
} as const;

export const templatesCopy = defineCopy('quant.templates', en);
