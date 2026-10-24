import { defineCopy } from '../../../../../shared/i18n';

/**
 * Words only the business application uses (setup step 2: the legal entity, company details, people, documents and
 * questions). Plain English: what happened, why, what to do next. The names of documents, roles and questions are the
 * ones INTAFACED publishes for each type, so they are not written here.
 */
const en = {
  appTitle: 'Business application',
  appBody:
    'Tell INTAFACED what kind of business this is, who is behind it, and send the documents asked for. Each part is saved as you go, so you can leave and come back.',
  noTypesTitle: 'No business types are open for verification',
  noTypesReason: 'No business types are published',
  noTypesBody:
    'INTAFACED publishes which kinds of business can verify here and what each one must send. None are published, so an application can’t be started.',
  fEntityType: 'Legal entity type',
  hEntityType: 'How the business is set up in law. Each type is asked for different documents and people.',
  fCountry: 'Country the business is registered in',
  hCountry: 'Only the countries this type can verify in are listed.',
  start: 'Start the application',
  startBody: 'Your application is saved as a draft. Nothing is sent to INTAFACED until you send it for review.',

  type_private_company: 'Private company',
  type_listed_company: 'Listed company',
  type_financial_institution: 'Financial institution',
  type_fund: 'Fund',
  type_trust: 'Trust',
  type_non_profit: 'Non-profit organisation',
  type_government_owned: 'Government-owned body',
  type_family_office: 'Family office',
  type_partnership: 'Partnership',
  type_sole_proprietorship: 'Sole trader',

  statusLabel: 'Application',
  statusPending: 'Pending',
  statusReady: 'Ready to send',
  statusSubmitted: 'Sent for review',
  statusApproved: 'Approved',
  statusRejected: 'Turned down',
  neededTitle: 'Still needed',
  neededNone: 'Nothing. Every part is done.',
  dueBy: 'Due by',
  dueNone: 'No due date is set for applications.',
  submittedOn: 'Sent on',

  changeTitle: 'Change the legal entity type',
  changeBody:
    'Changing the type clears your answers and asks again for what the new type needs. Documents you sent for this application stop counting.',
  changeButton: 'Change type',
  changeSame: 'Pick a different type or country first.',
  changed: 'Type changed. Fill in each part again for the new type.',
  restart: 'Start again',
  restartBody: 'Clears every answer and document in this application. The record of what you saved stays.',

  section_company_details: 'Company details',
  section_people: 'People behind the business',
  section_owners: 'Owners',
  section_documents: 'Documents',
  section_questionnaires: 'Questions',
  sectionDone: 'Done',
  sectionDraft: 'Saved, not finished',
  sectionEmpty: 'Not started',
  save: 'Save',
  saved: 'Saved.',
  savedDone: 'Saved. This part is done.',
  saveFixFirst: 'Fill in every box marked * to finish this part. You can save what you have now.',

  fLegalName: 'Registered legal name',
  fRegistrationNumber: 'Registration number',
  hRegistrationNumber: 'As shown on the registration certificate. Leave it empty if the business has none.',
  fIncorporationDate: 'Date registered',
  fRegisteredAddress: 'Registered address',
  fTaxId: 'Tax number',
  hTaxId: 'Leave it empty if the business has none.',

  peopleBody: 'Add each person in the roles listed. Every role needs at least one person.',
  peopleRolesNeeded: 'Roles still without a person: {roles}',
  fRole: 'Role',
  fPersonName: 'Full legal name',
  fBirthDate: 'Date of birth',
  fNationality: 'Nationality (2-letter country code)',
  fOwnership: 'Share of the business owned (%)',
  hOwnership: 'Leave it empty for someone who owns no part of it.',
  addPerson: 'Add a person',
  removePerson: 'Remove',
  personN: 'Person {n}',
  peopleFull: 'This application holds as many people as it can.',

  questionsBody: 'Answer each question INTAFACED asks for this type of business.',

  docsBody: 'Send each document listed. Each one stays Pending until INTAFACED reviews it.',
  docsVendorTitle: 'Documents are checked by a person',
  docsVendorReason: 'The automatic document check isn’t connected',
  docsVendor:
    'The automatic document check isn’t connected, so no document is checked by machine and none counts as passed until it is reviewed.',
  docsRulesTitle: 'Document uploads aren’t open',
  docsRulesReason: 'No upload rules are published',
  docsRulesBody: 'INTAFACED publishes the largest file and the kinds of file it accepts. None are published, so nothing can be sent.',
  docsLimits: 'Files up to {size}. Accepted: {types}.',
  docName: 'Document',
  docState: 'Status',
  docFile: 'File',
  docState_missing: 'Needed',
  docState_provided: 'Pending',
  docState_accepted: 'Verified',
  docState_rejected: 'Invalid',
  docReason: 'Reason: {reason}',
  docSent: '{size}, sent',
  chooseFile: 'Choose a file for {name}',
  upload: 'Send',
  uploading: 'Sending…',
  uploaded: '{name} sent.',
  tooLarge: 'This file is {size}. The limit is {limit}. Choose a smaller file.',
  wrongType: 'This kind of file isn’t accepted. Accepted: {types}.',
  emptyFile: 'This file is empty. Choose another.',
  docsConfirm: 'Confirm documents',
  docsConfirmNeeded: 'Send every document listed first. An invalid one needs a new file.',

  submit: 'Send application for review',
  submitBody: 'INTAFACED reviews your application. You can’t change it once it is sent. Live payments stay off until it is approved.',
  submitNeeded: 'Finish every part listed under Still needed first.',
  submittedNote: 'INTAFACED is reviewing your application. You don’t need to do anything.',
  resendNote:
    'INTAFACED marked a document Invalid. Send a new file for it under Documents; the rest of your application stays with INTAFACED.',
  approvedNote: 'INTAFACED approved this application. Your business is verified.',
  rejectedNote: 'INTAFACED turned this application down. Start a new one below and send what was asked for.',
  againTitle: 'Start a new application',
  otherApproved: 'Your business is verified with its verification reference, so no application is needed.',
  otherPending: 'Your verification reference is being reviewed, so no application is needed while it is.',

  // ---- plain words for refusals
  rTypeUnset: 'That business type isn’t open for verification. Pick another.',
  rCountry: 'That business type can’t verify in this country. Pick another country.',
  rExists: 'An application is already open for another type. Change its type instead.',
  rVersion: 'This part changed in another window. Reload the page and make your change again.',
  rSubmitted: 'The application is already sent, so it can’t be changed.',
  rIncomplete: 'Some parts aren’t finished. Finish each part listed under Still needed.',
  rDocsMissing: 'Some documents are still needed. Send each one listed, and replace any marked Invalid.',
  rRulesUnset: 'Document uploads aren’t open. Nothing was sent.',
  rStoreUnset: 'Documents can’t be stored safely right now, so nothing was sent.',
  rTooLarge: 'The file is over the size limit. Choose a smaller file.',
  rType: 'This kind of file isn’t accepted.',
  rDocUnknown: 'This document isn’t asked for this business type.',
  rDocEmpty: 'The file is empty. Choose another.',
  rSameFile: 'This is the file that was marked Invalid. Send a different file.',
  rNotFound: 'This application can’t be found. Reload the page.',
  rChanged: 'The application changed while the file was being sent, so it wasn’t kept. Send it again if it is still asked for.',
  rKybInvalid: 'Your business is already verified or under review, so a new application can’t start.',
} as const;

export const applicationCopy = defineCopy('pay.portal.settings.application', en);
/** The wording as written, for the copy lint. */
export const applicationMessages: Record<string, string> = en;

/** Names INTAFACED publishes as short keys (`certificate_of_incorporation`), shown as words ("Certificate of incorporation"). */
export function keyWords(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
