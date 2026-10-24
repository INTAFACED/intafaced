import { defineCopy } from '../../../../shared/i18n';

/** Words for how the hosted checkout looks (J-merchant-04 step 1). Plain English: what happened, why, what to do next. */
const en = {
  title: 'How your checkout looks',
  purpose: 'Your logo and brand colour on the page your customers pay on, for every payment link.',
  isDefault:
    'You are using the default look: no logo, and the checkout’s standard blue in light and dark mode. Saving keeps the colour below in both.',
  savedOn: 'Last saved:',
  color: 'Brand colour *',
  colorHint: 'A # and six digits or letters a to f, like #1a5fd0. Buttons and links use it, in light and dark mode.',
  colorPicker: 'Pick a brand colour',
  colorInvalid: 'Write the colour as # and six digits or letters a to f, like #1a5fd0.',
  logo: 'Logo',
  logoRule: '{types}, up to {max}.',
  logoRulesUnset: 'Logos are off: no size limit is published for them, so a logo would be refused. You can still save a colour.',
  logoTooLarge: 'This logo is {size}. A logo can be up to {max}, as {types}.',
  logoWrongType: 'This file is not a logo we can show. A logo can be {types}, up to {max}.',
  logoNew: 'New logo picked. Save to use it.',
  logoSaved: 'Your saved logo.',
  logoNone: 'No logo.',
  logoRemove: 'Remove logo',
  logoAlt: 'Your logo',
  previewTitle: 'Preview',
  previewLabel: 'Checkout preview',
  previewEyebrow: 'Payment request',
  previewItem: 'TEST item',
  previewAmount: 'TEST 25 USDC',
  previewButton: 'Continue',
  previewNote: 'An example with TEST figures. Your customers see your real product and amount.',
  save: 'Save look',
  saving: 'Saving…',
  saved: 'Saved. Your payment links now show this look.',
  noWrite: 'Only the owner or an admin can change how the checkout looks.',
  unverified: 'You can change the look once your business is verified.',
  rRulesUnset: 'Logos are off: no size limit is published for them. Save without a logo, or try again later.',
  rTooLarge: 'This logo is over the size limit. Pick a smaller file.',
  rType: 'This file is not a PNG, JPEG or WebP image. Pick another file.',
  rUnreadable: 'This file could not be read. Pick it again.',
  rStale: 'Someone changed the look while you were editing. The page now shows the latest one; make your change again.',
  rInteractive: 'Sign in again with your authenticator code to change the look.',
} as const;

export const lookCopy = defineCopy('pay.portal.checkoutLook', en);
/** The wording as written, for the copy lint. */
export const lookMessages: Record<string, string> = en;
