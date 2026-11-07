import { defineCopy } from '../../../shared/i18n';

// English source only (UI-SPEC §4.4); other languages fall back to English. Curly quotes on purpose.
// The saved desk layouts in the Layouts menu (C-workspace-02, J-charts-desk-07 #3 to #5). Each refusal says the real
// reason in one sentence; the service code is never shown.
const messages = {
  'My layouts': 'My layouts',
  'No layouts': 'No layouts kept by this account. Save the desk to keep it on every device.',
  'Layouts loading': 'Loading your layouts…',
  'Layouts failed': 'Couldn’t load your layouts.',
  'Try again': 'Try again',
  'Layouts signed out': 'Sign in to keep layouts on every device.',
  'Save layout': 'Save layout',
  'Layout name': 'Layout name',
  Save: 'Save',
  Cancel: 'Cancel',
  'Replace title': 'Replace “{name}”?',
  'Replace body': 'A layout called “{name}” is kept already. Replace it with the desk as it is now?',
  Replace: 'Replace',
  'In use': 'In use',
  'Layout facts': '{symbol} · {interval}',
  Open: 'Open',
  'Open name': 'Open {name}',
  Copy: 'Copy',
  'Copy name': 'Copy {name}',
  Export: 'Export',
  'Export name': 'Export {name}',
  Delete: 'Delete',
  'Delete name': 'Delete {name}',
  'Recently deleted': 'Recently deleted',
  'Nothing deleted': 'No deleted layouts to restore.',
  Restore: 'Restore',
  'Restore name': 'Restore {name}',
  Saving: 'Saving to “{name}”…',
  Saved: 'Saved to “{name}”.',
  'Name needed': 'Give the layout a name.',
  'Name too long': 'A layout name is 40 characters at most.',
  'identity.desk_layout_cap_exceeded': 'This account keeps as many layouts as it can. Delete one to save another.',
  'identity.desk_layout_cap_unset': 'Saving more layouts isn’t open on this account right now.',
  'identity.desk_layout_restore_full': 'The recently deleted list is full. Restore one, or wait for the oldest to go.',
  'identity.desk_layout_restore_unset': 'Deleting and restoring layouts isn’t open on this account right now.',
  'identity.desk_layout_restore_expired': 'That layout was deleted too long ago to restore.',
  'reply.unknown': 'We couldn’t tell whether that was kept. Your layouts were read again; check the list.',
  'Write failed': 'Couldn’t change your layouts. Try again.',
} as const;

export const layoutsCopy = defineCopy('trade.desk.layouts', messages);

/** The words for a refused write: its own sentence when the code is one the menu knows, else the general one. */
export function refusalKey(code: string): keyof typeof messages {
  return code in messages ? (code as keyof typeof messages) : 'Write failed';
}
