/**
 * Small rules behind the public information pages. Pure, so each one has a test.
 */

/**
 * The partner enquiry form lives on the invitation site (its own app, served from its own host at `/partner`). This app does not
 * know that host unless the deployment sets `VITE_JOIN_URL`. Only an https address (or http on localhost, for development) counts.
 */
export function partnerEnquiryHref(configured: string | undefined): string | null {
  const value = (configured ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${url.origin}/partner`;
  } catch {
    return null;
  }
}

/** Rooms a person can take part in today that are not a "campaign" service: each is a real room with a real action. */
export const PARTICIPATION_ROOMS = [
  { path: '/uc/promotion', note: 'participationInvite' },
  { path: '/academy', note: 'participationAcademy' },
  { path: '/token', note: 'participationToken' },
  { path: '/blueprint', note: 'participationBlueprint' },
] as const;
export type ParticipationNote = (typeof PARTICIPATION_ROOMS)[number]['note'];
