import { defineCopy } from '../../../shared/i18n';

// The futures ticket's pre-trade checklist (J-derivatives-34 #4 #5). English source only.
export const checklistCopy = defineCopy('trade.futures.venue.checklist', {
  'Checklist settings': 'Checklist settings',
  'Checklist title': 'Pre-trade checklist',
  'Checklist how':
    'Up to three things to tick before an opening order goes. Closes, reduce-only orders, stops and cancels never wait for it.',
  'Checklist item': 'Checklist item {n}',
  'Checklist on': 'Checklist on',
  'Save checklist': 'Save checklist',
  'Saved on': 'Saved. Opening orders wait at Confirm until every item is ticked. Kept on this device.',
  'Saved off': 'Saved. The checklist is off. Kept on this device.',
  'No items': 'Write at least one item to turn the checklist on.',
  'Not kept': 'This browser would not keep the checklist, so nothing was saved.',
  'Tick before': 'Before you open it',
  'Checklist waits': 'Confirm waits: tick “{item}” first. Nothing was sent.',
});
