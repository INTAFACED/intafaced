/**
 * Where the founder lands after signing in again. Only ever a path inside this console's own /crm pages: anything with
 * a host, a scheme, a backslash, a control character or a path outside /crm is refused, so the sign-in page can never be
 * made to send someone to another site.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER = 'https://console.invalid';

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isEnquiryId = isUuid;

/** The path and query to return to ("/crm?enquiry=..."), or null when `raw` is not a safe /crm path. The fragment is dropped. */
export function safeCrmPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER) return null;
  // Compared after the URL parser has resolved dot segments, so "/crm/../login" is "/login" and is refused.
  if (url.pathname !== '/crm' && !url.pathname.startsWith('/crm/')) return null;
  if (/%2f|%5c/i.test(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

/** "/crm?enquiry=<id>" for a valid enquiry id, else "/crm". */
export const enquiryPath = (enquiryId: string | null | undefined): string =>
  isEnquiryId(enquiryId) ? `/crm?enquiry=${enquiryId}` : '/crm';

/** The sign-in page, told where to send the founder back to. */
export const signInHref = (enquiryId?: string | null): string => `/login?next=${encodeURIComponent(enquiryPath(enquiryId))}`;

/** The enquiry id in a page's query string ("?enquiry=<id>"), or null. */
export function enquiryIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('enquiry');
  return isEnquiryId(value) ? value : null;
}

/**
 * The page to open after a successful sign-in: the sign-in page's own "next" value if it is a safe /crm path, otherwise the
 * enquiry whose unsaved edits this browser tab kept, otherwise the CRM home.
 */
export function signInReturnTarget(search: string, keptEnquiryId: string | null): string {
  const requested = safeCrmPath(new URLSearchParams(search).get('next'));
  // A bare "/crm" names no particular enquiry, so it does not override the one whose edits were kept.
  return requested && requested !== '/crm' ? requested : enquiryPath(keptEnquiryId);
}
