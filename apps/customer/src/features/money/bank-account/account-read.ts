import type { z } from 'zod';
import { useSession } from '../../session';
import { defineCopy } from '../../../shared/i18n';
import { useResource } from '../../../shared/resource';

/**
 * Words for the bank account room (BK-acct-05, BK-acct-06; J-bank-17): onboarding, the partner's information requests
 * and periodic reviews, closing and reopening the account, and a data-rights request. Every step, requirement, deadline,
 * cap and window comes from the bank; none is written here.
 */
export const bankAccountCopy = defineCopy('bank-account', {
  title: 'Your bank account',
  description: 'Onboarding, requests and reviews from the bank partner, closing the account and your data.',
  sectionsLabel: 'Bank account sections',
  explain:
    'Every step, requirement, deadline, cap and window here is the bank partner’s own, read as it stands now. An answer goes to the partner as it is sent; closing restricts the account until the partner pays out what it holds, and a data request is recorded with the partner’s reference.',
  bannerTitle: 'Finish your bank onboarding',
  bannerBody:
    '{partner} needs something from you: {steps} onboarding steps, {requests} information requests and {reviews} reviews are open.',
  bannerOpen: 'Open onboarding',
  onboardingTitle: 'Onboarding',
  onboardingLead: 'The steps and requirements of {partner}, which holds your bank account, with our own.',
  stepDone: 'Done',
  stepOpen: 'Open',
  stepDoneWithCase: 'Done with your INTAFACED verification, which {partner} accepts',
  identityCaseAccepted: 'Your INTAFACED verification (level {tier}) is offered to {partner}, and it accepts it.',
  identityCaseRefused: '{partner} does not accept your INTAFACED verification, so it asks for its own check.',
  verify: 'Verify your identity',
  partnerRequirements: 'Requirements of {partner}',
  ownerRequirements: 'Our requirements',
  ownerRequirementsUnset: 'Our requirements are not published ({code}).',
  onboardingComplete: 'Onboarding is done.',
  requestsTitle: 'Information requests',
  requestsLead: 'What {partner} asks you for. Answer each one with one file before its deadline.',
  requestsNone: 'No information requests.',
  due: 'Deadline: {date}',
  statusOpen: 'Waiting for your answer',
  statusUnderReview: 'Under review since {date}',
  file: 'File',
  uploadCap: 'One {types} file, up to {size} bytes.',
  uploadUnset: 'The size cap for an answer is not published ({code}), so nothing can be sent yet.',
  answer: 'Send answer',
  sent: 'Sent: {name}, {size} bytes',
  reviewsTitle: 'Periodic reviews',
  reviewsLead: '{partner} checks your account details from time to time.',
  reviewsNone: 'No reviews.',
  reviewDue: 'Due: {date}',
  reviewMissed: 'If you miss it: {effect}',
  reviewAccurate: 'My account details are still accurate',
  reviewNote: 'Anything that changed',
  reviewAnswer: 'Answer review',
  reviewAnswered: 'Answered on {date}',
  closureTitle: 'Close your bank account',
  closureLead:
    'Closing asks {partner} to pay out what the account holds to the destination you name. While it is closing, no money moves in or out.',
  closureOpen: 'Your account is open.',
  destinationName: 'Name on the destination account',
  destinationRef: 'Destination account number (IBAN)',
  close: 'Close account',
  closurePending: 'Closing: restricted while {partner} pays out your balance to {name}, {ref}. No money moves in or out until then.',
  closureBalance: 'To be paid out: {amount} {asset}',
  closureClosed: 'Closed on {date}.',
  closurePaidOut: 'Paid out by {partner} on {date}.',
  reopenUntil: 'You can reopen it until {date}.',
  reopenUnset: 'How long a closed account can be reopened is not published ({code}).',
  reopen: 'Reopen account',
  reopened: 'Reopened on {date}.',
  dataTitle: 'Your data',
  dataLead: 'Ask {partner} for a copy of the data it holds about your bank account.',
  dataKind: 'What you ask for',
  dataAccess: 'A copy of my data',
  dataPortability: 'My data in a portable file',
  dataRequest: 'Send request',
  dataNone: 'No data requests yet.',
  dataRecord: '{kind}: received on {date}, reference {ref}',
  signIn: 'Sign in to read your bank account.',
  unread: 'This could not be read from the bank: {message}',
  refused: '{message}',
});

export type Failure = { code: string; message: string };
export type Read<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed'; failure: Failure };

/** One bank read, re-read whenever `version` changes. */
export function useAccountRead<T>(procedure: string, schema: z.ZodType<T>, version: number): Read<T> {
  const { api, userId, profiles } = useSession();
  // Every bank call carries the profile in view (J-bank-01 #7); a business profile is refused, as it has no bank account here.
  const profile = profiles.active;
  const { resource } = useResource<T>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: bankAccountCopy.t('signIn') };
    return api.query('bank', `bankAccount.${procedure}`, { profile }, schema, { signal });
  }, `${userId}:${profile}:bankAccount.${procedure}:${version}`);
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'ready') return { state: 'ready', data: resource.data };
  return { state: 'failed', failure: { code: resource.failure.code ?? '', message: resource.failure.message } };
}

export const day = (at: string | null) => (at ? at.slice(0, 10) : '');

/** Reads a chosen file as base64, without the data-URL prefix. */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}
