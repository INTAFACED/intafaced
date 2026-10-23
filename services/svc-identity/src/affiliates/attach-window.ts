/**
 * The late-attach window (CM-referral-01, ENGINE RF-2; J-campaigns-05 #4 and #5).
 *
 * A signed-in person may attach a referrer through a link only while their account is younger than the owner setting
 * `IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS`, measured on the server from the account's creation time. A blank window
 * refuses every link attach (`referral.attach_window_unset`) and writes nothing; a closed one refuses with
 * `referral.attach_window_closed`. A referrer named at sign-up completion is not subject to the window (RF-1).
 *
 * Not here: the spec's second condition, "no commission-bearing fee event for the account". Fee events reach identity
 * only for an account that already has a referrer (the accrue door), so identity cannot see one for an account without
 * one; it needs the fee producers' event first.
 */

import { ReferralError } from './referral-tree.js';

/** Upper bound a published window may take (one year). A larger value is a typo, not a setting. */
export const ATTACH_WINDOW_MAX_SECONDS = 31_536_000;

/** The owner setting, parsed. Blank stays undefined (refuses at use); a malformed value stops the service at start. */
export function parseAttachWindowSeconds(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > ATTACH_WINDOW_MAX_SECONDS) {
    throw new Error(`IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS must be whole seconds from 1 to ${ATTACH_WINDOW_MAX_SECONDS}`);
  }
  return Number(value);
}

export type AttachWindowStatus =
  | { readonly state: 'unset'; readonly accountCreatedAt: Date }
  | { readonly state: 'open' | 'closed'; readonly accountCreatedAt: Date; readonly windowSeconds: number; readonly closesAt: Date };

export function attachWindowStatus(accountCreatedAt: Date, windowSeconds: number | undefined, now: Date): AttachWindowStatus {
  if (windowSeconds === undefined) return { state: 'unset', accountCreatedAt };
  const closesAt = new Date(accountCreatedAt.getTime() + windowSeconds * 1000);
  return { state: now.getTime() < closesAt.getTime() ? 'open' : 'closed', accountCreatedAt, windowSeconds, closesAt };
}

/** Refuses unless the window is published and still open for this account. */
export function assertAttachWindowOpen(accountCreatedAt: Date, windowSeconds: number | undefined, now: Date): void {
  const status = attachWindowStatus(accountCreatedAt, windowSeconds, now);
  if (status.state === 'unset') {
    throw new ReferralError(
      'The referral attach window is not set by the owner [referral.attach_window_unset]',
      'referral.attach_window_unset',
    );
  }
  if (status.state === 'closed') {
    throw new ReferralError(
      `The referral attach window closed at ${status.closesAt.toISOString()} [referral.attach_window_closed]`,
      'referral.attach_window_closed',
    );
  }
}
