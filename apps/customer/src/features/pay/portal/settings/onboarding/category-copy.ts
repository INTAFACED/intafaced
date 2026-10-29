import { defineCopy } from '../../../../../shared/i18n';

/**
 * Words only the business category section uses (the Compliance page): the categories INTAFACED takes, what each class
 * allows, and the business's own choice. Plain English: what happened, why, what to do next.
 */
const en = {
  title: 'Business category',
  body: 'What your business sells decides which payments it can take. Choose the category that fits it best.',
  noRule: 'No rule set',
  noRuleBody:
    'INTAFACED has published no business categories, so no business can choose one or go live. There is nothing for you to do here.',
  chooseLabel: 'Your business category',
  choosePlaceholder: 'Choose a category',
  choose: 'Save category',
  choosing: 'Saving…',
  chosen: 'Your category was saved.',
  yours: 'Your category',
  notChosen: 'You haven’t chosen a category yet. Your business can’t go live until you do.',
  chosenOn: 'Chosen',
  locked: 'Your business is verified, so the category can’t be changed here. Ask INTAFACED support to change it.',
  ownerOnly: 'Only the account owner can choose the business category.',
  classLabel: 'Class',
  ruleLabel: 'What it means',
  reserveLabel: 'Reserve',
  reserveValue: '{percent}% of payments, held for {days} days',
  reserveUnset: 'Not set. A business in this category can’t go live without it.',
  documentsLabel: 'Extra documents you’ll send',
  noDocuments: 'None',
  class_standard: 'Standard',
  class_permissionless: 'Crypto only',
  class_restricted: 'High risk',
  class_prohibited: 'Not taken',
  rule_standard: 'Card, crypto and bank transfer payments. No extra documents.',
  rule_permissionless: 'Crypto payments only. No extra documents.',
  rule_restricted: 'No card payments (crypto and bank transfer only), extra documents and a reserve.',
  rule_prohibited: 'INTAFACED doesn’t take this kind of business: every payment and checkout is refused.',
  allCategories: 'Every category',

  // ---- plain words for refusals
  rUnset: 'INTAFACED has published no business categories, so none can be chosen.',
  rChanged: 'INTAFACED changed the categories while you were choosing. Look again and choose.',
  rNotFound: 'That category no longer exists. Look again and choose.',
  rLocked: 'Your business is verified, so the category can’t be changed here. Ask INTAFACED support to change it.',
  rProhibited: 'INTAFACED doesn’t take payments for this kind of business.',
  rReserveUnset: 'This category has no reserve set, so payments can’t be taken.',
  rRailRefused: 'Your business category doesn’t take this way to pay.',
} as const;

export const categoryCopy = defineCopy('pay.portal.settings.category', en);
/** The wording as written, for the copy lint. */
export const categoryMessages: Record<string, string> = en;
